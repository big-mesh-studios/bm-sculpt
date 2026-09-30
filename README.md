# bm-sculpt

Chunked surface-nets sculpting, in the browser.

A sculptor whose field is an operation list rather than a stored volume, meshed
per chunk in web workers, drawn with a node-graph renderer, and built to stay
responsive on hardware several years old.

This repository is at **phase 0** of a planned rebuild: the toolchain, the
rendering layer and the three risks that were meant to be settled before any of
the mesher is written. What is on screen is a spike scene, not the application.

## What exists

|              |                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Renderer** | [`@random-mesh/rmsl`](https://www.npmjs.com/package/@random-mesh/rmsl) 1.14.0 — a scene graph and a node-graph shader DSL. Not a three.js fork; see [ADR 0001](docs/adr/0001-rmsl-over-three.md). |
| **UI**       | Solid **2.0.0-rc.13**, `solid-js` + `@solidjs/web` + `@solidjs/signals`, coordinated at one version.                                                                                              |
| **Build**    | Vite 8, `vite-plugin-solid@3.0.0-next.27`, TypeScript in `strict` with `noUnusedLocals` and `noUnusedParameters`.                                                                                 |
| **Style**    | One Prettier config, no linter. Type safety is `tsc --noEmit`.                                                                                                                                    |
| **Layout**   | One package. `pnpm-workspace.yaml` exists for the `catalog:` it holds, which every version more than one place needs is written into once.                                                        |

## Phase 0 spikes

Three questions were meant to be settled before the mesher is written, because a
wrong answer to any of them would force the mesher's output format to change.
All three are answered, and each is answered twice: once as a unit test that
compiles and inspects the shader on the host, and once visibly on screen.

**Does a packed vertex layout reach the GPU?** The layout is the one the mesher
will target — `float32x3` position, `snorm16x2` octahedral normal, `unorm8x4`
colour, twenty bytes. `vertexFormatOf` infers the format from the array type,
component count and `normalized` flag, and
[`spike-geometry.test.ts`](src/render/spike-geometry.test.ts) asserts the
inference and that `VERTEX_BYTES` matches what those formats actually occupy.
Signed 16-bit pairs beat unsigned 8-bit quads for the normal at the same four
bytes — roughly a hundredth of a degree of error rather than four tenths.

**Does a 3D sampler bind?** There is no `Data3DTexture`; a volume is a
`DataTexture` with a depth, bound through `b.sampler(name, "sampler3D", …)`.
[`spike-material.test.ts`](src/render/spike-material.test.ts) compiles the
material on the host and asserts `sampler3D` appears in the emitted GLSL and in
the program's binding list — the text being the only place the difference between
a `sampler3D` and a `sampler2D` on the same bytes is visible.

**What precision does this device have?** `highp` is mandatory in the vertex stage
and optional in the fragment stage, and an unsupported qualifier is dropped
_silently_ — the shader still compiles and the only symptom is banded lighting.
[`precision.ts`](src/render/precision.ts) measures it with
`getShaderPrecisionFormat` and the spike page reports the answer.

**Is a raw GLSL escape hatch available?** No, and that is worth knowing before
reaching for one: there is no `ShaderMaterial` in this library. Every shader must
be a node graph. `compileGLSL` is how to see what one became.

## Running it

```sh
pnpm install
pnpm dev
```

```sh
pnpm check-types   # tsc --noEmit
pnpm test          # vitest
pnpm build         # vite build
pnpm format        # prettier --write
```

### Known limitation on Android/Termux

**The Solid JSX transform cannot run on Termux**, so `pnpm dev` and `pnpm build`
will fail here and the spike scene has not been seen in a browser on this
machine. This is the environment, not the project:

- The Solid compiler is a native module. There is no prebuilt binary for Android
  — Termux uses Bionic, and the published `linux-arm64-gnu` package will not load
  — so it falls back to `@solidjs/compiler-wasm32-wasi`.
- Node's WebAssembly host is blocked by the Termux sandbox, failing with
  `UVWASI_EACCES, uvwasi_init` before any code runs.

Because a `.ts` file cannot contain JSX, the Vite plugin is scoped to `.tsx` and
`.jsx` (`include: /\.[jt]sx$/`), which is correct regardless and means the unit
tests — all of which are JSX-free — run without a graphics device, a browser, or
the compiler. Everything except the two entry files is exercised by `pnpm test`
and `pnpm check-types` on this machine. On any desktop or CI runner the
transform works normally.

## Plans

The architecture decisions, each with its costs and its rejected alternatives,
are in [`docs/adr/`](docs/adr/README.md):

|                                                      |                                                    |
| ---------------------------------------------------- | -------------------------------------------------- |
| [0001](docs/adr/0001-rmsl-over-three.md)             | Render with rmsl, not three.js                     |
| [0002](docs/adr/0002-computed-field-never-stored.md) | The field is computed, never stored                |
| [0003](docs/adr/0003-surface-nets.md)                | Surface Nets per chunk, not marching cubes         |
| [0004](docs/adr/0004-csg-per-chunk.md)               | Each chunk evaluates the operations at its own LOD |
| [0005](docs/adr/0005-streaming-shape.md)             | Slot-indexed arrays and a coordinate map           |

Phases 1 to 8, in order, are in the project plan. Phases 0 to 5 are the sculpting
application and are independently shippable; 6 to 8 are an infinite streaming
world, and because the field is never stored they add no changes to the CSG or the
mesher — only a `baseField` binding and a camera.
