/**
 * Bundling a place's TypeScript into one string the interpreter can run.
 *
 * ## Why a bundler at all
 *
 * QuickJS here has no module loader, and there is no filesystem inside it — ADR 0015's whole
 * isolation argument rests on there being none. So a place's files arrive as text, and
 * something has to turn a set of files that `import` each other into a single scope.
 *
 * **The output must be byte-for-byte identical on every peer.** This is not tidiness. Under
 * the authority model the operation list is *recomputed* on each peer rather than received
 * (ADR 0016), so if two peers bundled the same source into different text they would get the
 * same operations from different programs — and there would be no way to tell afterwards,
 * because the fold looks exactly the same either way. Three things make it reproducible:
 *
 * 1. **Module ids are assigned in `Object.keys(files).sort()` order.** `Object.keys` order is
 *    insertion order, so two peers given the same files in a different order would assign
 *    different ids to the same file. Sorting removes the dependency on arrival order.
 * 2. **The compiler options are pinned here** and never inherited from a tsconfig, so a place
 *    compiles the same way on every machine and every version of this repository.
 * 3. **Nothing is read from the host environment** — no clock, no random, no path — so the
 *    output is a function of its inputs alone.
 *
 * ## What a place may import
 *
 * Two specifiers, and a third that is reserved:
 *
 * - `"voxelscape"` — the guest library in `guest/place-api.ts`, compiled here rather than
 *   shipped as a string, so it is type-checked by this repository's own `tsc` and cannot
 *   drift from the declaration a place author reads.
 * - `./name` — another of the place's own files.
 *
 * **Everything else is refused, and the refusal names the file and the specifier.** That
 * includes anything containing `://`, anything starting with `/`, anything with `..`, and
 * any name with a directory in it. A place's scripts are a flat namespace on purpose: the
 * on-disk form is a zip whose entries are named, validation is simpler with one rule, and a
 * place cannot shadow the guest library with a file of its own.
 *
 * Nothing may import the host. `RESERVED_HOST_MODULE` exists so that asking for it fails with
 * "not available" rather than resolving to something it should not have.
 */

import ts from "typescript";

import GUEST_SOURCE from "./guest/place-api.ts?raw";
import { GUEST_MODULE, RESERVED_HOST_MODULE } from "./bridge";
import { MAX_SCRIPT_SOURCE } from "./limits";

/** A place's files: its path in the archive to its source text. */
export type PlaceFiles = Readonly<Record<string, string>>;

/**
 * The compiler options a place is compiled with, pinned.
 *
 * **`verbatimModuleSyntax` is the load-bearing one, and it was found the hard way.** A
 * bundler needs every `import` to survive into the output as a `require`, because it is the
 * bundler — not the type checker — that decides what exists. TypeScript's default is to
 * *elide* an import nothing appears to use, which meant the first version of this bundler
 * silently dropped an import of a file that did not exist: a place could write
 * `import { door } from "./door"` and never learn, because nothing referenced `door` and the
 * import evaporated before the bundler saw it.
 *
 * With `verbatimModuleSyntax`, an ordinary import is preserved exactly as written and an
 * `import type` is still erased. That second half is what makes it safe for the guest library,
 * whose single import is a type: it disappears, and the library ends up requiring nothing —
 * which `bundle.test.ts` asserts, because a surviving `require` there would fail inside the
 * interpreter with an error about a module a place author never wrote.
 *
 * `target` is ES2019 rather than something newer because the interpreter is QuickJS and not a
 * browser: a syntax this repository's own `tsc` accepts might not run there.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2019,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  removeComments: true,
};

/** The id given to the guest library, which is not a file. */
const GUEST_ID = "voxelscape";

/** Why a place could not be bundled. Every refusal names the file and says what. */
export class BundleError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "BundleError";
  }
}

/**
 * A `require` whose argument is not a string literal.
 *
 * Refused rather than left alone: a script calling `require` at runtime is asking for
 * something, and inside the interpreter there is nothing it could mean. Letting it through
 * would surface as `require is not a function` from a scope nobody wrote.
 */
const NON_LITERAL_REQUIRE = /\brequire\(\s*(?!["'])([^)]*)\)/g;

/** A `require` with a string literal argument, which is every import after transpiling. */
const LITERAL_REQUIRE = /\brequire\(\s*(["'])([^"']*)\1\s*\)/g;

/**
 * Transpiles one file, and reports a syntax error rather than emitting something broken.
 *
 * `transpileModule` does not type-check — it cannot, with one file and no information — so
 * the diagnostics it returns are syntactic. Those matter: a place with a syntax error will
 * not run, and the message here is the only chance to say where.
 */
const transpile = (file: string, source: string): string => {
  if (source.length > MAX_SCRIPT_SOURCE) {
    throw new BundleError(
      file,
      `is ${source.length} characters, over the ${MAX_SCRIPT_SOURCE} character limit`,
    );
  }

  const result = ts.transpileModule(source, {
    compilerOptions: COMPILER_OPTIONS,
    fileName: `${file}.ts`,
    reportDiagnostics: true,
  });

  const broken = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (broken.length > 0) {
    const first = broken[0];
    const where =
      first.file === undefined || first.start === undefined
        ? ""
        : ` at line ${first.file.getLineAndCharacterOfPosition(first.start).line + 1}`;
    throw new BundleError(
      file,
      `does not parse: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}${where}`,
    );
  }

  return result.outputText;
};

/**
 * Resolves a specifier against the flat set of a place's files.
 *
 * Returns the file's name, or `GUEST_ID` for the guest library, or throws.
 */
const resolve = (
  from: string,
  specifier: string,
  files: PlaceFiles,
): string => {
  if (specifier === GUEST_MODULE) return GUEST_ID;
  if (specifier === RESERVED_HOST_MODULE) {
    throw new BundleError(
      from,
      `imports "${RESERVED_HOST_MODULE}", which is not available to a place`,
    );
  }
  if (specifier.includes("://")) {
    throw new BundleError(
      from,
      `imports "${specifier}" — a place may not reach outside itself`,
    );
  }
  if (specifier.startsWith("/")) {
    throw new BundleError(
      from,
      `imports "${specifier}" — an absolute path is not inside a place`,
    );
  }
  if (specifier.includes("..")) {
    throw new BundleError(
      from,
      `imports "${specifier}" — a place's files are a flat namespace`,
    );
  }

  // `./door` and `door` both mean `door` in a flat namespace, and `.ts` and `.js` both mean
  // the source: a place's files are named in an archive, and the extension is the host's
  // business rather than the script's.
  const bare = specifier.replace(/^\.\//, "").replace(/\.(ts|js)$/, "");
  if (bare === "") {
    throw new BundleError(from, `imports "${specifier}", which names nothing`);
  }
  if (bare.includes("/")) {
    throw new BundleError(
      from,
      `imports "${specifier}" — a place's files are a flat namespace, so a name has no directory`,
    );
  }

  for (const candidate of [`${bare}.ts`, `${bare}.js`]) {
    if (candidate in files) return candidate;
  }
  throw new BundleError(
    from,
    `imports "${specifier}", which is not one of this place's files`,
  );
};

/**
 * Replaces every `require("…")` with `require("<id>")`, and reports what was found.
 *
 * **Resolution happens here, at bundle time, rather than at run time.** A transpiled file
 * carries `require("./door")` in its body, and the interpreter has no table to map that
 * specifier to a module — so the string is rewritten to the id before the text ever leaves
 * this function. Doing it here also means the rewrite is a scan for the same pattern that
 * validated it, so there is no second list of imports that could disagree.
 */
const rewriteRequires = (
  file: string,
  js: string,
  files: PlaceFiles,
  ids: ReadonlyMap<string, string>,
): { readonly js: string; readonly imports: readonly string[] } => {
  if (NON_LITERAL_REQUIRE.test(js)) {
    NON_LITERAL_REQUIRE.lastIndex = 0;
    throw new BundleError(
      file,
      "calls require with something that is not a string; a place's imports may only " +
        `come from its own files, or "${GUEST_MODULE}"`,
    );
  }
  NON_LITERAL_REQUIRE.lastIndex = 0;

  /** File names, gathered as the text is rewritten — the two cannot come apart. */
  const imports: string[] = [];

  const rewritten = js.replace(
    LITERAL_REQUIRE,
    (_whole, _quote: string, specifier: string) => {
      const target = resolve(file, specifier, files);
      imports.push(target);
      return `require(${JSON.stringify(idOf(ids, target))})`;
    },
  );

  return { js: rewritten, imports };
};

/**
 * The id of a module, given the file it came from.
 *
 * The guest library's id is its own name rather than a number, deliberately: it is not one of
 * the place's files, and an id from the place's own numbering would be indistinguishable from
 * a file called `voxelscape` — which a place is not allowed to have.
 */
const idOf = (ids: ReadonlyMap<string, string>, name: string): string => {
  if (name === GUEST_ID) return GUEST_ID;
  const id = ids.get(name);
  if (id === undefined) throw new BundleError(name, "could not be given an id");
  return id;
};

/**
 * Bundles a place into one string the interpreter can evaluate as a function body.
 *
 * @param files the place's scripts, by name
 * @param entry the file to run; it need not be named `main`
 * @returns `(function (engine) { … })` — the shape ADR 0015 established, so the interpreter
 *          does not care whether what it is given came from this bundler or was written by hand
 *
 * **Throws rather than emitting something that will not run.** A place that fails to bundle
 * fails here, with a message naming the file and the import, and never reaches the
 * interpreter — where the alternative is an error about a line number in a scope nobody wrote.
 */
export const bundlePlace = (files: PlaceFiles, entry: string): string => {
  if (!(entry in files)) {
    throw new BundleError(entry, "is not one of this place's files");
  }
  if (Object.keys(files).length === 0) {
    throw new BundleError(entry, "has no files");
  }

  // Sorted, and the whole of reproducibility: an id must not depend on the order the files
  // happened to arrive in, or two peers would give the same file different ids.
  const names = Object.keys(files).sort();
  const ids = new Map<string, string>();
  names.forEach((name, index) => ids.set(name, String(index)));

  /** Compiled output, keyed by file name (and by `GUEST_ID` for the library). */
  const compiled = new Map<string, string>();

  compiled.set(
    GUEST_ID,
    transpile(GUEST_ID, GUEST_SOURCE).replace(
      // The library has no imports — `bundle.test.ts` asserts it — but a stray one would
      // otherwise become a `require` of an id nothing has.
      LITERAL_REQUIRE,
      `require(${JSON.stringify(GUEST_ID)})`,
    ),
  );

  /**
   * Compiles one file, and everything it reaches.
   *
   * Iterative rather than recursive because a place can import itself — transitively or
   * directly — and a list of pending *names* handles that without a stack-depth question.
   * The `compiled` check is what stops the second visit.
   *
   * The import names come back from `rewriteRequires` rather than being read out of the
   * rewritten text, because by then a specifier has already become an id and there is no
   * name left in the string to look up.
   */
  const pending: string[] = [entry];
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (compiled.has(name)) continue;

    const { js, imports } = rewriteRequires(
      name,
      transpile(name, files[name]),
      files,
      ids,
    );
    compiled.set(name, js);
    for (const target of imports) {
      // The library is already in the table, compiled once and shared.
      if (target !== GUEST_ID) pending.push(target);
    }
  }

  return render(compiled, ids, idOf(ids, entry));
};

/**
 * Renders the bundle.
 *
 * **Three parts and a last line.** The module table; a `require` that caches a module
 * *before* calling its factory, which is what makes a cycle terminate rather than recurse
 * forever; and `__require(entry)` as the final line, so a module's top-level side effects run
 * when the interpreter evaluates the bundle — which is where `onTick` is called.
 *
 * **A place has a `require` in scope, and that is correct.** The transpiled code calls it by
 * that name, so the factory's second parameter is `require` and a place's own `require` is
 * this resolver. It is not an escape and the reason is worth stating precisely: every literal
 * `require` in the source was resolved by `rewriteRequires` before this function ran, so the
 * only arguments left in the text are module ids **this function chose**. A place cannot hand
 * the runtime resolver anything it picked, which is a stronger answer than "the resolver
 * refuses bad ids" — it never gets the chance.
 *
 * The `__modules[id] === undefined` branch is therefore unreachable from a place's own code
 * and exists for the module table being wrong rather than for a place being clever. It stays,
 * because an unreachable-by-design check that reads as a possibility is worse than one that
 * says so in a comment.
 *
 * The entry's exports are deliberately discarded. A bundle is a *program*, not a library: the
 * only way in is the `engine` parameter and the only way out is an effect or a handler, so
 * there is nothing an entry could export that a host would want.
 */
const render = (
  compiled: ReadonlyMap<string, string>,
  ids: ReadonlyMap<string, string>,
  entryId: string,
): string => {
  const table: string[] = [];
  for (const [name, js] of compiled) {
    table.push(
      [
        `${JSON.stringify(idOf(ids, name))}: function (module, exports, require) {`,
        js,
        "},",
      ].join("\n"),
    );
  }

  return [
    `const __modules = {`,
    ...table,
    "};",
    "const __cache = {};",
    "const __require = (id) => {",
    "  if (id in __cache) return __cache[id].exports;",
    "  const factory = __modules[id];",
    '  if (factory === undefined) throw new Error("place asked for module " + id);',
    "  const module = { exports: {} };",
    // Cached before the factory runs, so a cycle stops here rather than recursing.
    "  __cache[id] = module;",
    "  factory(module, module.exports, __require);",
    "  return module.exports;",
    "};",
    `__require(${JSON.stringify(entryId)});`,
  ].join("\n");
};

/**
 * Wraps a bundle as the interpreter evaluates it: the body of a function whose one
 * parameter is `engine`.
 *
 * Exported separately so the interpreter can wrap anything — including source a person
 * typed — the same way, and so there is one place that knows the shape rather than the shape
 * being written out at each call.
 */
export const asPlaceSource = (bundle: string): string =>
  `(function (engine) {\n${bundle}\n});`;

/**
 * The guest library's compiled source, for a host that wants to offer it without bundling a
 * place. Exported so the interpreter can be tested against the library alone.
 */
export const guestLibrarySource = (): string =>
  transpile(GUEST_ID, GUEST_SOURCE);
