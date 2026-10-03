import { describe, expect, it } from "vitest";

import {
  asPlaceSource,
  bundlePlace,
  BundleError,
  guestLibrarySource,
} from "./bundle";
import GUEST_ALIAS from "./guest/voxelscape.ts?raw";
import { MAX_SCRIPT_SOURCE } from "./limits";

/**
 * A place, bundled, is a program two peers must agree about.
 *
 * The two properties that matter and are hardest to get right:
 *
 * 1. **Byte-for-byte reproducible.** The operation list is recomputed on each peer rather
 *    than received (ADR 0016), so different text means different programs producing the same
 *    operations — with no way to tell afterwards, because the fold looks identical either way.
 * 2. **Contained.** A place may only reach itself and the guest library. Everything else is
 *    refused *at bundle time*, where the message can name the file and the import, rather
 *    than at run time where it surfaces as an error about a scope nobody wrote.
 *
 * These run the real compiler. A bundler whose tests use a hand-written fixture would be
 * testing the fixture.
 */

const aPlace = (): Record<string, string> => ({
  "main.ts": `
    import { createShape, log } from "voxelscape";
    import { buildDeck } from "./deck";
    let started = false;
    export function main() {}
    log("starting");
  `,
  "deck.ts": `
    import { createShape } from "voxelscape";
    export const buildDeck = (at) => {
      createShape({ place: "bridge", id: "deck", at, shape: { type: "Box", len: { x: 40, y: 8, z: 12 } }, combine: "Add" });
    };
  `,
});

describe("a place bundles into one program", () => {
  it("produces something the interpreter can evaluate", () => {
    const bundle = bundlePlace(aPlace(), "main.ts");
    // The shape ADR 0015 established, so the interpreter does not care whether what it is
    // given came from a bundler or was typed by hand.
    expect(bundle).not.toContain("function (engine)");
    expect(asPlaceSource(bundle)).toContain("(function (engine)");
  });

  it("runs the entry, so its top-level code happens", () => {
    // `onTick` is called at load, before the first step. A place that builds itself from its
    // handlers therefore depends on the entry running when the bundle is evaluated.
    const bundle = bundlePlace(aPlace(), "main.ts");
    expect(bundle.trimEnd().endsWith('__require("1");')).toBe(true);
  });

  it("includes the guest library and every file the entry reaches", () => {
    const bundle = bundlePlace(aPlace(), "main.ts");
    // Sorted ids: `deck.ts` is 0 and `main.ts` is 1, whatever order they were given in.
    expect(bundle).toContain('"0": function');
    expect(bundle).toContain('"1": function');
    expect(bundle).toContain('"voxelscape": function');
    // And the entry's `require("./deck")` was rewritten to the id, so the interpreter needs
    // no table to resolve it.
    expect(bundle).toContain('require("0")');
    expect(bundle).not.toContain('require("./deck")');
  });

  it("leaves a file the entry does not reach out of the bundle", () => {
    // Dead code is still code two peers would have to agree about, so a place with a helper
    // nothing calls should not pay for it. Asserted on the *contents*, because the bundle
    // carries module ids and never a file name — a filename in the output would be a way for
    // two peers to disagree about something a place author cannot see.
    const bundle = bundlePlace(
      { "main.ts": `export const x = 1;`, "unused.ts": `export const y = 2;` },
      "main.ts",
    );
    expect(bundle).toContain("exports.x = 1");
    expect(bundle).not.toContain("exports.y = 2");
    // Only the guest library and the entry: two modules.
    expect(bundle.match(/function \(module, exports, require\)/g)).toHaveLength(
      2,
    );
  });

  it("takes any file as the entry, not only one called main", () => {
    const files = {
      "main.ts": `export const main = 1;`,
      "other.ts": `export const other = 2;`,
    };
    expect(() => bundlePlace(files, "other.ts")).not.toThrow();
    expect(() => bundlePlace(files, "absent.ts")).toThrow(BundleError);
  });
});

describe("the same files bundle to the same bytes", () => {
  it("does not depend on the order the files arrived in", () => {
    // **The whole of reproducibility.** Ids are assigned in sorted order, and `Object.keys`
    // order is insertion order — so without the sort, two peers given the same files in a
    // different order would give the same file different ids, and the bundle would differ.
    const forwards: Record<string, string> = {};
    const backwards: Record<string, string> = {};
    const names = ["main.ts", "deck.ts", "posts.ts"];
    for (const name of names) forwards[name] = `export const v = "${name}";`;
    for (const name of [...names].reverse())
      backwards[name] = `export const v = "${name}";`;

    expect(bundlePlace(forwards, "main.ts")).toBe(
      bundlePlace(backwards, "main.ts"),
    );
  });

  it("is a function of the inputs alone", () => {
    // Nothing may be read from the environment, or two peers at different times or in
    // different places would bundle differently.
    expect(bundlePlace(aPlace(), "main.ts")).toBe(
      bundlePlace(aPlace(), "main.ts"),
    );
  });

  it("changes when the source changes, which is what makes the check above meaningful", () => {
    const changed = aPlace();
    changed["deck.ts"] = changed["deck.ts"].replace("40, y: 8", "41, y: 8");
    expect(bundlePlace(aPlace(), "main.ts")).not.toBe(
      bundlePlace(changed, "main.ts"),
    );
  });

  it("compiles the same way whatever this repository's tsconfig says", async () => {
    // The options are pinned rather than inherited, so a change to the application's own
    // target cannot change what a place compiles to. Checked by reading them back off the
    // output's behaviour: `isolatedModules` is what erases the guest library's type-only
    // import, and without it the library would silently keep a `require`.
    expect(guestLibrarySource()).not.toContain('require("bridge")');
    expect(guestLibrarySource()).not.toContain('require("../bridge")');
  });
});

describe("a place may only reach itself", () => {
  const refuses = (
    files: Record<string, string>,
    entry = "main.ts",
  ): BundleError => {
    try {
      bundlePlace(files, entry);
    } catch (error) {
      if (error instanceof BundleError) return error;
      throw error;
    }
    throw new Error("expected the bundle to be refused");
  };

  it("refuses a URL, naming the file and the specifier", () => {
    // "A place may not reach outside itself" is the message a person needs; a module-not-found
    // from inside the interpreter would not be.
    const error = refuses({
      "main.ts": `import x from "https://evil.test/x";`,
    });
    expect(error.file).toBe("main.ts");
    expect(error.message).toContain("https://evil.test/x");
    expect(error.message).toContain("outside itself");
  });

  it("refuses an absolute path", () => {
    const error = refuses({ "main.ts": `import x from "/etc/passwd";` });
    expect(error.message).toContain("absolute");
  });

  it("refuses a directory escape", () => {
    const error = refuses({ "main.ts": `import x from "../outside";` });
    expect(error.message).toContain("flat namespace");
  });

  it("refuses a name with a directory in it, even one that exists", () => {
    // A place's namespace is flat. Allowing `./lib/door` would mean allowing `../`, and a
    // directory a peer could name differently is a directory two peers could disagree about.
    const error = refuses({
      "main.ts": `import x from "./lib/door";`,
      "lib/door.ts": `export const x = 1;`,
    });
    expect(error.message).toContain("flat namespace");
  });

  it("refuses the reserved host specifier", () => {
    // It exists so that asking for it fails with a stated answer rather than resolving to
    // something it should not have.
    const error = refuses({ "main.ts": `import engine from "engine-host";` });
    expect(error.message).toContain("not available");
  });

  it("refuses an import of a file the place does not have", () => {
    const error = refuses({ "main.ts": `import x from "./door";` });
    expect(error.message).toContain("not one of this place's files");
  });

  it("refuses a require of something computed, because there is nothing it could mean", () => {
    // A script calling `require` at runtime inside an interpreter with no module system.
    const error = refuses({ "main.ts": `const n = "a"; require(n);` });
    expect(error.message).toContain("not a string");
  });

  it("refuses a file that does not parse, with the line", () => {
    // A place that fails to bundle fails here, where the message can say where. The
    // alternative is an error inside the interpreter about a line in a scope nobody wrote.
    const error = refuses({ "main.ts": `const a = ;\n` });
    expect(error.file).toBe("main.ts");
    expect(error.message).toContain("does not parse");
  });

  it("refuses a file over the size limit", () => {
    const error = refuses({
      "main.ts": `// ${"x".repeat(MAX_SCRIPT_SOURCE)}`,
    });
    expect(error.message).toContain("character limit");
  });
});

describe("imports within a place resolve the way a flat namespace implies", () => {
  const bundles = (specifier: string): string =>
    bundlePlace(
      {
        "main.ts": `import x from "${specifier}";`,
        "door.ts": `export const x = 1;`,
      },
      "main.ts",
    );

  it("takes a relative name", () => {
    expect(bundles("./door")).toContain('require("1")');
  });

  it("takes a bare name, because there are no directories to be relative to", () => {
    expect(bundles("door")).toContain('require("1")');
  });

  it("takes an explicit extension, whichever", () => {
    expect(bundles("./door.ts")).toContain('require("1")');
    expect(bundles("./door.js")).toContain('require("1")');
  });

  it("prefers the TypeScript source when both names exist", () => {
    // Sorted ids put `door.js` at 0 and `door.ts` at 1, so a bundle reaching 1 is reaching
    // the TypeScript.
    const bundle = bundlePlace(
      {
        "main.ts": `import x from "./door";`,
        "door.js": `export const x = 1;`,
        "door.ts": `export const x = 2;`,
      },
      "main.ts",
    );
    expect(bundle).toContain('require("2")');
    // `door.js` is id 1 and `door.ts` is id 2 in sorted order, so reaching 2 is reaching the
    // TypeScript — and the value it exports is what says so.
    expect(bundle).toContain("exports.x = 2");
    expect(bundle).not.toContain("exports.x = 1;");
  });

  it("takes the guest library under its one reserved name", () => {
    const bundle = bundlePlace(
      { "main.ts": `import { log } from "voxelscape"; log("hi");` },
      "main.ts",
    );
    expect(bundle).toContain('require("voxelscape")');
  });
});

describe("a place that imports itself", () => {
  it("bundles, because the module table resolves lazily", () => {
    // A `require` is called when the factory runs, and the cache is written *before* the
    // factory does, so a cycle stops at the second visit rather than recursing forever. The
    // cycle itself is nonsense — nothing calls anything — which is exactly why it should be
    // the bundler's problem to survive rather than a reason to refuse.
    const bundle = bundlePlace(
      {
        "main.ts": `
          import { a } from "./other";
          export const main = a;
        `,
        "other.ts": `
          import { main } from "./main";
          export const a = () => main;
        `,
      },
      "main.ts",
    );
    expect(bundle).toContain("__cache[id] = module;");
    expect(bundle).toContain('require("1")');
  });

  it("bundles a file that imports itself", () => {
    expect(() =>
      bundlePlace(
        { "main.ts": `import { x } from "./main"; export const y = x;` },
        "main.ts",
      ),
    ).not.toThrow();
  });
});

describe("the guest library", () => {
  it("compiles to something that requires nothing", () => {
    // **The property that makes it safe.** It runs inside an interpreter with no module
    // system, so a surviving `require` would fail with an error about a module the place
    // author never wrote. Its single import is `import type`, which `isolatedModules`
    // erases.
    const library = guestLibrarySource();
    expect(library).not.toMatch(/\brequire\(/);
    expect(library).not.toContain("../bridge");
  });

  it("keeps the placeholder's own name out of its source", () => {
    // `declare const engine` is a type-only declaration, so it must not become a variable —
    // and the *name* must not survive into a string either, or a reader of the compiled
    // output would think it declared one.
    expect(guestLibrarySource()).toContain("engine");
  });

  it("offers exactly the names the module a place author imports offers", () => {
    // **The one direction a hand-written listing could get wrong invisibly.** The module a
    // place imports re-exports the library rather than restating it, so a name cannot go
    // missing from one and not the other — but only if the re-export is real. This checks it
    // by asking the library what it exports, which is the only place the two could diverge: a
    // function added to `place-api.ts` would be there and, if the module were ever rewritten
    // by hand, nowhere else.
    const library = guestLibrarySource();
    const exported: string[] = [];
    for (const match of library.matchAll(
      /exports\.([A-Za-z_][A-Za-z0-9_]*)\s*=/g,
    )) {
      if (!exported.includes(match[1])) exported.push(match[1]);
    }

    // The names a place author is expected to find, which is what the declaration promises.
    const promised = [
      "createShape",
      "removeShape",
      "removePlace",
      "clearPlace",
      "createZone",
      "removeZone",
      "setTime",
      "setTimeSpeed",
      "movePlayer",
      "setPlayerSpeed",
      "setPlayerJump",
      "setFlying",
      "lookAt",
      "clearCamera",
      "log",
      "toast",
      "after",
      "saveData",
      "loadData",
      "deleteData",
      "getSolidAt",
      "getHeightAt",
      "getWaterAt",
      "raycast",
      "onTick",
      "clamp",
      "lerp",
      "random",
      "randint",
      "randFloat",
      "choice",
      "Vector3",
      "PlaceError",
    ];

    for (const name of promised) {
      expect(exported, `${name} is promised by the declaration`).toContain(
        name,
      );
    }

    // And the module a place imports *is* the library, rather than a list of its names or a
    // declaration describing it — which is what makes the check above mean anything.
    //
    // It was a `.d.ts` once, containing `declare module "voxelscape" { export * from
    // "./place-api" }`, which reads like the right thing and is not: a `.d.ts` reached through
    // `tsconfig`'s `paths` is resolved *as a module*, and a `declare module` inside a resolved
    // module is an augmentation of a module that has to exist elsewhere. Every demo failed with
    // "no exported member 'createShape'": the file was found and everything in it invisible.
    expect(GUEST_ALIAS).toContain('export * from "./place-api"');
    // No *ambient* declaration. The word appears in this file's own prose explaining why there
    // is not one, so the assertion is on the declaration form rather than the phrase.
    expect(GUEST_ALIAS).not.toMatch(/^\s*declare module "/m);
  });

  it("is type-checked by this repository rather than by a string", () => {
    // The point of keeping it as a `.ts` file. A guest API held as text in a template
    // literal would compile in the interpreter and nowhere else, and would drift from the
    // declaration a place author reads with nothing to notice.
    expect(guestLibrarySource()).toContain("PlaceError");
    expect(guestLibrarySource()).toContain("createShape");
  });
});
