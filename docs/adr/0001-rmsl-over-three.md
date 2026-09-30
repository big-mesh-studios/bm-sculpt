# 0001 — Render with rmsl, not three.js

## Context

The application this replaces renders with three.js, using a full-screen quad and
a `ShaderMaterial` whose GLSL is assembled at run time from a string the worker
produces, plus `OrbitControls` and `TransformControls` from `three/examples`.

`@random-mesh/rmsl` offers a scene graph and a node-graph shader DSL shaped like
three.js. It is not a fork of it, which is the part that needs deciding rather
than assuming. Its scene module exports 91 names; three.js exports over a
thousand. Absent are `ShaderMaterial`, `Raycaster`, `Ray`, `Box3`, `Sphere`,
`Data3DTexture`, `OrbitControls`, `TransformControls`, `Fog`, shadow maps,
`setPixelRatio` and every geometry generator except six primitives.

What is present, and matters: `WebGLRenderTarget`, `readPixelsAsync`, a compact
unpacked vertex-format system with `snorm16x2` and `unorm8x4`, and a `Builder`
that declares uniforms, samplers, attributes and varyings as nodes and compiles
to GLSL ES 3.00, WGSL, or JavaScript.

The reference implementation, `big-mesh-studios`, already uses it for two
applications of similar scale.

## Decision

Use rmsl for the scene graph and the shader DSL. Keep no three.js dependency.

## Consequences

**Every gap is filled by porting an answer that already exists**, in
`big-mesh-studios`:

| Missing                              | Replacement                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `ShaderMaterial` and its GLSL string | A `NodeMaterial` subclass. No raw GLSL anywhere, so every shader problem is solved in the node DSL.                         |
| `Raycaster`                          | A CPU Amanatides–Woo DDA over the field. Cheaper here, since the field is analytic and there are no triangles to intersect. |
| `Box3`, `Sphere`                     | Plain `{min,max}` objects, as the existing code already uses for edit bounds.                                               |
| `Data3DTexture`                      | `new DataTexture(data, w, h, depth, …)` bound through `b.sampler(name, "sampler3D", …)`.                                    |
| `OrbitControls`                      | `src/controls/orbit-camera.ts`.                                                                                             |
| `TransformControls`                  | **Not yet built.** The highest-risk item in the project; see below.                                                         |
| `setPixelRatio`                      | Write `canvas.width` and `canvas.height` from a `ResizeObserver`.                                                           |
| `Fog`                                | A renderer-scoped uniform and a hand-written falloff, as `TriangleMaterial` does.                                           |

**`Scene.background` is inert.** The renderer clears from the colour given to
`setClearColor` and reads nothing else. Setting the scene's field does nothing.

**There is no single-channel float texture format.** `RedFormat` does not exist
and `R8` cannot be expressed, so a 3D texture costs four bytes a texel rather
than one, and `RedIntegerFormat` — the one single-channel format that does exist
— reads as whole numbers. This costs the project nothing, because the field is
computed (0002) and never uploaded. It is recorded because it would matter the
moment a field _were_ uploaded.

**`select` compiles to a ternary, not a branch.** Fine on any driver that
matters, but not a guarantee about emitted code, so anything depending on
branchlessness has to be measured rather than assumed.

**The transform gizmo is the real cost.** Parity requires move, rotate and scale
for primitive placement, and there is no `TransformControls` to port. Two
minimal bespoke widgets exist in `big-mesh-studios` to work from, and a numeric
transform panel is the fallback if it slips.

## Alternatives

**Stay on three.js.** Rejected: the ray-marched renderer is what this project
exists to replace, and every chunked-mesh equivalent of the three.js feature set
used here would have to be written from scratch anyway.

**Use three.js for the scene graph and rmsl only for shaders.** Rejected: the two
libraries would each define `Vector3`, `Matrix4`, `Color` and `BufferGeometry`
separately, and every value crossing the boundary becomes a conversion. rmsl's
`rmsl-three` adapter exists for exactly this and is pinned to `three ^0.170`
with rmsl 1.1.1 — stale against both.

**Defer the renderer decision.** Rejected: the mesher's output format is chosen
against the renderer's vertex formats, so deciding later means redoing it.
