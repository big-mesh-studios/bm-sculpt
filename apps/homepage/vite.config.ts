/**
 * The page is compiled for the server and written out as one file.
 *
 * ## Why there is no `base` here, when both of the applications set one
 *
 * **Because the links on this page are relative, and a relative link needs no base to be
 * right.** Both applications are built with `base: "./"` so that the same `dist` is correct
 * served from `/bm-sculpt/`, from any other subdirectory, and from a static server at the
 * root of a checkout — and this page is written to the same rule rather than to a
 * different one. `./bm-sculpt/` resolves correctly in all three of those places and needs
 * nothing configured to say so.
 *
 * **So there is no environment variable to get wrong, and no build that has to be told
 * where it is going to live.** The sibling repository's front page hardcodes
 * `base: "/big-mesh-studios/"` and reads `import.meta.env.BASE_URL` to build its addresses;
 * that is correct there and would be one more thing to keep in step here for no gain.
 *
 * ## Why `generate: "ssr"` rather than the default
 *
 * **Because this page is rendered on the server and never in a browser.** `ssr: true` stops
 * the plugin emitting the browser runtime at all, and `hydratable: false` leaves out the
 * comment markers and keys that only a browser picking the page back up would read. Nothing
 * is ever sent to a browser to run here — see `scripts/prerender.ts`.
 *
 * Note that this is the Babel-based line of the plugin, `3.0.0-next.5`, which is what this
 * repository pins: the native-compiler line cannot run on Termux (ADR 0024's note on the
 * catalog). Both expose `ssr`, `generate` and `hydratable`, so this configuration does not
 * depend on which line is installed.
 */
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    solid({ ssr: true, solid: { generate: "ssr", hydratable: false } }),
  ],
});
