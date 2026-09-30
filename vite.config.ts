import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

// A relative base, because the built site is served from a subdirectory on
// GitHub Pages and from a subdirectory on any other static host, and a request
// for `/assets/...` against a page at `/bm-sculpt/` is a 404 that no amount of
// correctness elsewhere will fix.
export default defineConfig({
  base: "./",

  plugins: [
    // `ssr: false` says this application has no server rendering to do. It is
    // the default for a Vite app, but stating it keeps a prerender entry from
    // being added later without the rest of the build following.
    //
    // `include` narrows the plugin to the extensions that can hold JSX. A `.ts`
    // file cannot, and the plugin otherwise loads the Solid compiler — a native
    // binary, with a WebAssembly fallback where there is no binary for the
    // platform — on its first transform of *any* file. That is a 30-megabyte
    // dependency to start a test run that touches no JSX, and on a platform with
    // neither a binary nor a working WebAssembly host it fails the whole suite
    // rather than one file.
    solid({ ssr: false, include: /\.[jt]sx$/ }),
  ],

  server: {
    // A browser resolves `localhost` to `::1` first, and Vite binds `::1`
    // only when asked. Naming the IPv4 address avoids the connection-refused
    // that a first run otherwise spends its time on.
    host: "127.0.0.1",
  },

  // Every worker in this application is a module worker. The mesher workers
  // will import their message handlers as ES modules and, later, a language
  // service worker will code-split its own compiler load, neither of which the
  // iife default can hold.
  worker: {
    format: "es",
  },

  test: {
    // Node by default. A test that needs a DOM asks for one with a
    // `// @vitest-environment jsdom` comment at the top of its own file, so
    // the cost is paid only by the tests that need it.
    environment: "node",
  },
});
