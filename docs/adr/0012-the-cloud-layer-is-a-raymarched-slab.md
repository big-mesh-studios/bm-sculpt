# 0012 — The cloud layer is a raymarched slab, and its geometry is a carrier

## Context

The world needed weather. Everything about it was already decided by what the
renderer is: rmsl is a node-graph library (ADR 0001) with a scene graph, a material
system and no `ShaderMaterial`, no render target and no depth texture — so there is
no escape hatch to a hand-written GLSL pass, and no way to composite the sky the way
a skybox is composited.

The reference project, `big-mesh-studios`'s `apps/voxelscape`, has weather too, and
it is particles: instanced quads with a shader that moves them. That works over a
terrain because the camera is near the ground and the clouds are close. It does not
work for what this scene wants, which is a player standing under a layer whose
underside is visible, which means the cloud has to have an interior.

The two serious options are a raymarch through a volume and a stack of camera-facing
slices. The second is the older technique and it is cheaper, and it is what a
half-resolution buffer full of stacked quads would give. rmsl has neither the buffer
nor any of the machinery a multi-pass sky needs.

## Decision

**The layer is a single box mesh, centred on the camera every frame and drawn with
its back faces; its fragment stage marches a slab between two altitudes and samples
two baked fields.**

The parts of that which are decisions rather than descriptions:

- **The box is a carrier, not a place.** Nothing is sampled by world position —
  everything is a function of `normalize(positionWorld - cameraPosition)` — so the
  box's geometry carries no information beyond "which way am I looking". It follows
  the camera, and it follows it _unsnapped_: a carrier whose position was quantised to
  a grid would move the sky by up to a grid step every time the player crossed one,
  which is visible as the horizon swimming.
- **The march starts at the slab, not at the eye.** The entry distance is the ray's
  intersection with the layer's underside, dithered, clamped into `[0, exit]`, and the
  loop runs to the exit. Starting at the camera spends up to a sixth of the step
  budget walking through empty air under the layer.
- **Transmittance is integrated analytically, not approximated per step.** The
  contribution of a step is `(T - T·exp(-σ·d)) / σ·d`, so a cloud's brightness does
  not depend on how finely it was sampled. This is what buys the long empty step: a
  step through air can be 120 units where a step through cloud is 70, because neither
  can miss a cloud the other would have found.
- **Two fields, at incommensurate periods.** A shape volume at 2400 units and a
  weather map at 48 000, twenty to one. One field at one scale is a texture; two
  fields whose periods do not divide into each other cannot be locked onto together,
  because the eye is never given the ratio.
- **Both fields are baked on the CPU, once, in a worker** (`cloud-bake-worker.ts`).
  The bake is pure arithmetic over `Uint8Array`s — no DOM, no renderer — which is the
  only reason it could be moved off the main thread, and moving it is what stopped
  two and a half seconds of frozen page at every load.

## Consequences

**There is no half-resolution buffer and no depth texture, so the ordering _is_ the
occlusion scheme.** This is the cost worth stating first, because every other cost
here follows from it. A sky is normally drawn into an off-screen buffer at half
resolution, blurred, and composited against the depth buffer — which is what lets a
raymarched sky cost a quarter as much as the frame it is drawn into, and what lets a
mountain in front of a cloud occlude it. rmsl offers neither a render target nor a
depth texture to sample, so there is nothing to draw into and nothing to compare
against. What is left is draw order: the sky is added to the scene first, fills the
frame, and everything drawn after it lands on top. A cloud in front of a mountain is
therefore not drawn at all, which is correct, and a mountain in front of a cloud is
drawn over it, which is also correct — but only because the terrain happens to be
drawn before the clouds, which is a fact about `scene.children` order and about
nothing else.

**The far field drops its detail, deliberately and visibly.** Past 7000 units a
sample skips the march toward the light entirely — five fetches to the two of the
march itself — and takes the aerial-perspective colour instead. So a cloud at the
horizon is not lit the same way as one overhead, and the difference is the price of a
layer that draws at all. It is also why the march's reach and its detail distance are
two separate numbers rather than one: the reach is where the sky fades to nothing, and
the detail distance is where it stops paying for its own light.

**The step budget is a hard ceiling and the shader is written around it.** `MAX_STEPS`
is 128 and `LIGHT_STEPS` is 5, which is 896 texture fetches per pixel in the worst
case a ray can reach — a ray that finds dense cloud on every step and never leaves the
near field. `clouds.test.ts` computes that figure from the emitted GLSL and holds it
to 1024, because this is the only per-pixel cost this stack can measure: rmsl has no
`renderer.info`, the application has no render-scale plumbing, and no GPU timer is
reachable from a test. **If the layer turns out to be too expensive, the honest levers
are device pixel ratio and those two constants** — in that order, because lowering
them trades the sky's own quality for the sky's cost, while DPR trades the whole
frame's.

**A ramp of geometry would not have been cheaper here.** It looks cheaper — the
farther slices are bigger and can be sampled less often — and it is not: it needs a
render target to accumulate into, because the slices are drawn front-to-back over one
another and something has to hold the partial result. With the accumulation done in
the shader instead, the march is one pass with no intermediate buffer, and the only
thing given up is the ability to shade the volume at half resolution.

**The box has to stay inside the camera's far plane.** A carrier of `CLOUD_EXTENT`
(40 000) puts its furthest corner at 69 282 against a far plane of 100 000. Doubling
the extent to give the march more room would clip the corners and put holes in the sky,
which is a very strange-looking bug to diagnose from a shader.

**The layer has a horizon because of aerial perspective, not because it ends.** The
march reaches 17 000 units and the cloud takes on more of the sky's own colour with
distance at 1.2 per ten thousand. Without that term the clouds would run to the edge
of the frame at full contrast and the sky would have no depth in it at all.

**A carrier that is added late is a carrier that is drawn last.** Because draw order
is scene traversal order, `createSky` and `createClouds` are both called before the
water and the terrain are added, and a comment in `app.tsx` says so. There is no
`renderOrder` to set and nothing to fall back on.

## Alternatives

**A stack of camera-facing slices.** Rejected: it needs somewhere to accumulate,
which rmsl does not have, and the accumulation in a shader brings back the single
march with none of the slice's savings. The technique earns its keep in an engine
with render targets; this is not one.

**Raymarching on the terrain's own material** — clouds as a property of the distance
field, so a ray leaves the surface and accumulates until it hits something. Rejected:
it would make every chunk's shader pay for every pixel of sky above it, including the
chunks that are entirely underground, and it would make the sky's cost proportional to
the number of chunks rather than to the frame.

**Particulate clouds, as voxelscape has them.** Rejected: correct for a camera at
ground level looking at clouds on the horizon, and wrong for a camera under the layer.
A billow has an interior and a shadowed core; a quad does not.

**Sampling the weather map only, with the shape coming from analytic noise in the
shader.** Rejected: procedural noise per pixel per step is the one cost in this stack
that cannot be bounded by a texture-read count, because there is no read to count.
Horizon's own cloud shader pays for it by evaluating several octaves of 3D value noise
at every sample, which is a shader whose cost is measured in ALU and not in fetches —
and therefore not measurable here at all.

**Baking the field on the main thread, as this did first.** Rejected on measurement,
not on principle: 2.4 s of frozen page at every load, on a phone. The bake is pure
arithmetic and was always going to be movable; the reason it was not moved sooner is
that nothing forced it until the frame was visibly stalling.
