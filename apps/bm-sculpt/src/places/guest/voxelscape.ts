/**
 * `voxelscape`, as a place's source imports it.
 *
 * ## Why this file exists, and why it is an alias rather than a declaration
 *
 * A place writes `import { createShape } from "voxelscape"`, and `voxelscape` is not a
 * package — it is `place-api.ts` in this directory. A project points at it with a `paths`
 * entry, and **`tsconfig.json` here does exactly that** so the demos under `src/places/demo/`
 * are type-checked like everything else.
 *
 * The first version of this was a `.d.ts` containing `declare module "voxelscape" { export *
 * from "./place-api"; }`, which reads like the right thing and is not: a `.d.ts` reached
 * through `paths` is resolved *as a module*, and a `declare module` inside a resolved module is
 * an augmentation of a module that has to exist somewhere else. Every demo failed with "no
 * exported member 'createShape'" — the file was found and everything in it was invisible.
 *
 * A one-line re-export has no such problem, and it is more honest about what this is: **the
 * guest library, under the name a place uses.** Not a copy of its types that could drift, not
 * a description of it, and not a declaration that says what the code does — the code.
 *
 * ## For a place author
 *
 * ```json
 * {
 *   "compilerOptions": {
 *     "paths": { "voxelscape": ["../../src/places/guest/voxelscape.ts"] }
 *   }
 * }
 * ```
 *
 * Point it at `place-api.ts` directly if you would rather.
 */

export * from "./place-api";
