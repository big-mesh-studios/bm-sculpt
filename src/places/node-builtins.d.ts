/**
 * The Node built-ins the place interpreter's loader reaches for.
 *
 * Declared here rather than by installing `@types/node`, because this is a
 * browser application and `tsconfig.json` asks for `vite/client` alone. Adding
 * Node to that list would put `process`, `Buffer` and `require` in scope for
 * *every* module under `src/`, which is a much larger thing to hand a renderer
 * than the handful of names one loader needs.
 *
 * Each declaration below is as small as the use it covers. They are not a
 * general Node environment and are not meant to grow into one: if a future
 * change finds itself wanting something from here that is not declared, that is
 * the moment to reconsider this file rather than to widen it.
 *
 * The declarations exist because `src/places/interpreter.ts` has to load the
 * interpreter's WebAssembly two different ways, and only one of them is a
 * browser. See `loadModule` there for why.
 */

/** The one Node global this project reads, to tell Node from a browser. */
declare const process: { readonly versions?: { readonly node?: string } };

declare module "node:module" {
  /**
   * `createRequire`, narrowed to the single call made on it. The real signature
   * takes a list of paths and returns a general `NodeRequire`; declaring that
   * faithfully would mean declaring a great deal of Node.
   */
  export const createRequire: (from: string) => {
    resolve: (id: string) => string;
  };
}

declare module "node:path" {
  /** `dirname` and `join`, narrowed to string arguments and string results. */
  export const dirname: (path: string) => string;
  export const join: (...parts: string[]) => string;
}

declare module "node:url" {
  /** `pathToFileURL`, for turning a filesystem path into something importable. */
  export const pathToFileURL: (path: string) => { href: string };
}
