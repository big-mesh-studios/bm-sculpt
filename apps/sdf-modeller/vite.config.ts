import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

/**
 * A relative base, for the same reason as the other application: the built site is
 * served from a subdirectory on GitHub Pages and on any other static host, and a request
 * for `/assets/...` against a page at `/sdf-modeller/` is a 404 that no amount of
 * correctness elsewhere will fix.
 */
export default defineConfig({
  base: "./",

  plugins: [
    solid({
      ssr: false,
      // `include` narrows the plugin to the extensions that can hold JSX. Without it the
      // Solid compiler — a native binary with a WebAssembly fallback where there is no
      // binary for the platform — loads on the first transform of *any* file, which is a
      // thirty-megabyte dependency to start a test run that touches no JSX.
      include: /\.[jt]sx$/,
    }),
  ],

  server: {
    // A browser resolves `localhost` to `::1` first and Vite binds `::1` only when asked,
    // so naming the IPv4 address avoids the connection-refused a first run otherwise
    // spends its time on.
    host: "127.0.0.1",
  },

  optimizeDeps: {
    // **Only this application's own entry is scanned.** In a workspace the default
    // crawler walks the source of every app in the repository and fails on the
    // dependencies of any of them that are not installed here.
    entries: ["index.html"],
    include: ["@solidjs/signals"],
  },

  test: {
    // Node by default; a test that needs a DOM asks for one with a
    // `// @vitest-environment jsdom` comment at the top of its own file.
    environment: "node",
  },
});
