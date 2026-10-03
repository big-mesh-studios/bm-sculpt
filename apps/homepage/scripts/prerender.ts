import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Writes the front page as one file.
 *
 * ## Why this page is a file rather than an application
 *
 * **Because it holds no state and answers no events.** There is nothing to hydrate and
 * nothing for a bundle to do, so a client-rendered application here would ship a script
 * whose only work was to produce markup that was already known at build time — and would
 * produce *no* markup at all until it had downloaded and run, which for the one page whose
 * entire job is to be a set of links is the wrong failure mode. A reader on a bad
 * connection, or with a script blocker, would get a blank page instead of two links.
 *
 * This way the stylesheet travels inside the document, the whole page is one request, and
 * the links are in the first byte the browser reads.
 *
 * ## Why the stylesheet is inlined rather than linked
 *
 * **Because a second request for a second file is the entire cost being argued about.** The
 * page has no other request; inlining the stylesheet keeps it at one, which also means it
 * cannot arrive half-styled.
 *
 * ## Why the script is separate from Vite rather than a Vite plugin
 *
 * **Because Vite has nothing to contribute to assembling a document.** It compiles the
 * Solid; it does not know what the `<head>` should contain. Writing thirty lines of template
 * here is clearer than a plugin that exists only to run them, and it keeps the one hard
 * requirement — that the output contains no script — in a place where it can be enforced.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The compiled page, loaded by address.
 *
 * **By file URL rather than by name**, because `.ssr` is written by the build that runs
 * immediately before this script and is not a TypeScript module Node can import.
 */
const bundle = pathToFileURL(join(root, ".ssr/entry-server.js")).href;
const { render } = (await import(bundle)) as { render: () => string };

const styles = await readFile(join(root, "src/styles.css"), "utf8");
const body = render();

/**
 * The document shell, with its two placeholders filled in.
 *
 * **A shell on disk rather than a template string here**, so that the page's `<head>` — and
 * in particular the viewport meta tag `packages/ui`'s test reads every application page
 * from — is a file that can be read, opened and edited as HTML. See `index.html`.
 */
const shell = await readFile(join(root, "index.html"), "utf8");

/**
 * The build fails if the page has grown a script tag.
 *
 * **Because "this page ships no JavaScript" is the entire reason it is prerendered**, and a
 * reason is worth nothing unless something checks it. A stray client-side effect, or an
 * `islands` configuration added later without thinking, would quietly add a script and
 * quietly undo the reason — with nothing in the build to notice. Better a loud failure on a
 * merge than a front page that has quietly become an application.
 */
if (/<script/i.test(body)) {
  throw new Error(
    "the front page rendered a <script>; it is meant to be one file with nothing to run",
  );
}

/**
 * Fills in the shell's two placeholders.
 *
 * **`<id:styles />` and `<id:body />`, matched as whole tags including the closing slash.**
 * A string search for `<id:body` alone would also match the opening tag of a longer element
 * and would leave its closing tag in the document; and replacing by `replace` rather than
 * `replaceAll` means a second occurrence is left behind rather than silently duplicated —
 * both of which produce HTML that still renders and is quietly wrong.
 */
const document = shell
  .replace(/<id:styles\s*\/>/, `<style>\n${styles.trimEnd()}\n    </style>`)
  .replace(/<id:body\s*\/>/, body);

for (const marker of ["<id:styles />", "<id:body />"]) {
  if (document.includes(marker)) {
    throw new Error(
      `index.html still contains ${marker}; the prerender did not fill it`,
    );
  }
}

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist/index.html"), document);

/**
 * A count rather than nothing.
 *
 * **Because "did it write anything" is the question a build script can answer about itself
 * cheaply**, and a front page that silently prerendered to an empty document would otherwise
 * look exactly like one that worked.
 */
console.log(`wrote dist/index.html (${document.length} bytes, no script)`);
