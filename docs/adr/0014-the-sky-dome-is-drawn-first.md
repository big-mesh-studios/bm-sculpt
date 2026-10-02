# 0014 — The sky dome is drawn first, and neither tests nor writes depth

## Context

The reference project has no sky. `big-mesh-studios`'s `apps/voxelscape` paints the
clear colour and lets the terrain's fog dissolve into it, and that reads correctly at
noon. Its night is a flat near-black rectangle, which a player reads as a broken
renderer rather than as midnight, and there is no sunset in it at all: no gradient, no
disc, no stars, and nothing between the pale horizon and the deep zenith.

So there is something to draw, and the question is what shape. A skybox image is out on
one technical ground and one aesthetic one. Technically, **no renderer in rmsl builds a
mip chain**, so every texture in this application minifies unfiltered and a 1024-wide
image on a hemisphere minifies to a shimmering mess at the horizon and a moiré at the
poles; aesthetically, a photograph is a photograph of one place at one time of day, and
this sky changes over twenty minutes.

A dome is then the obvious remaining answer, and it brings a question with it: what does
it do about the rest of the scene? rmsl has **no `renderOrder` key and no
`frustumCulled`** — draw order is `scene.children` traversal order, and that is the only
ordering the renderer has.

## Decision

**The sky is a sphere of 40 000 units, centred on the eye every frame, drawn with its
back faces, added to the scene before anything else, and it has `depthTest` and
`depthWrite` both off.**

Four separate things, and each is a decision:

- **Drawn first**, because there is no other ordering available. `createSky` is called
  at the top of the shared-scene block in `app.tsx`, before the session that owns the
  terrain's meshes and before the water and the clouds, and the comment there says why.
- **Neither tests nor writes depth.** It is drawn first and fills the frame; everything
  after it lands on top. A dome that tested depth would have to be sorted against forty
  thousand units of cloud and a terrain window for no gain, since nothing is ever behind
  the sky.
- **Back faces, because the camera is inside it.** The alternative — `FrontSide` with the
  sphere at the far plane — is what makes a skybox a skybox, and it puts the geometry at
  the one distance where depth precision is worst.
- **Centred on the eye, unsnapped.** The dome's fragment stage never samples by world
  position: the gradient, the stars and the two discs are all functions of
  `normalize(positionWorld - cameraPosition)`. So the geometry carries no information
  beyond "which way am I looking", and it can follow the camera without quantising —
  a snapped carrier moves the sky by up to a grid step every time the player crosses
  one, which is a horizon that swims as you walk.

## Consequences

**Nothing has to know the sky exists.** Terrain, water and clouds each land on top of a
full frame without a depth buffer, a render order or a mention of it. That is the
property the whole arrangement buys, and it holds in the one direction a test can reach:
`sky.test.ts` asserts that `createSky` appends exactly one child and that `dispose`
takes that child away again without disturbing what was already in the scene.

**The scene's order is load-bearing, which makes it fragile.** A dome added after the
terrain draws over it, and the symptom is a sky that hides a mountain — the one fault
in this application that would be reported as "the renderer is broken". The defence is
commentary at both ends: `createSky`'s doc comment says _add it first_, and `app.tsx`
says the same where it is called. A `renderOrder` key would move this from a convention
to a guarantee; there is not one.

**There is one extra full-frame draw.** The dome is drawn, and then almost all of it is
drawn over. On a scene that fills the frame with clouds and terrain that is a whole
frame of overdraw for a gradient, and it is not avoidable without a depth pre-pass or a
skybox, neither of which this renderer has.

**The stars rotate about the vertical rather than about a celestial pole.** This is the
one deliberate simplification in the sky, and it is commented as one in `sky.ts`: stars
rise in the east and set in the west here, where a real sky wheels about the pole at
the observer's latitude. Over a twenty-minute cycle nobody reads the difference, and the
alternative is a rotation axis the star lattice cannot represent — the grid is a 3D
lattice of cells and a tilted axis would have to be a second coordinate frame in the
middle of a hash.

**The dome's radius and the cloud layer's are the same number on purpose.** Both are
40 000, so the two agree about where the world stops. Neither figure means anything on
its own — both are carriers, and both only have to be inside the camera's hundred-
thousand far plane — but a sky whose dome and whose clouds ended at different distances
would be a horizon with a seam across it.

**The horizon colour is written to three places per frame.** The dome's gradient, the
clear colour and the fog all want the sky at the horizon, and they are the same
`Color`/`Vec3` from one `DayNightState` in `app.tsx`. This is the other end of ADR 0013:
fog is what the horizon looks like when it is full of air, so the fog's colour, the
clear colour and the water's reflection cannot be allowed to drift.

## Alternatives

**Clear colour only, as voxelscape does.** Rejected: it is one number for the whole sky,
so there is no gradient at noon, no sunset, and no stars ever. It is the cheapest version
and it is the version that made the reference's night look like a crash.

**A skybox texture on the inside of a cube.** Rejected on the mip chain: rmsl has no
mipmaps, so a minified skybox shimmers, and there is no way to build one. Even given
mipmaps, a photograph fixes one time of day and one place, and this sky has neither.

**A full-screen triangle with the ray direction reconstructed from the inverse
view-projection.** Rejected as not worth it: it would replace a 48×24 sphere with two
triangles and an inverse matrix, and the sphere's only other cost is that its corners
have to stay inside the far plane. It is the better shape if the dome ever needs to be
something other than a carrier.

**`FrontSide` with the sphere at the far plane, so the sky writes depth.** Rejected: it
would put the sky at the worst possible place in the depth range, and every other
material would then have to be tested against a depth value that changes with every
pixel of the sky's own gradient.

**Drawing the sky last, with `depthTest` on and `depthWrite` off.** This is the
conventional arrangement in an engine with a depth pre-pass, and it is cheaper in
overdraw: the sky only fills the pixels nothing else covered. Rejected because it needs
the depth of the scene to already exist, which means two passes — and there is no render
target here to hold the first one. In a scene where the sky is drawn first, the dome's
depth test is off and the _terrain's_ z-reject is what hides the clouds.

**A dome per scene, rebuilt when the day changes.** Rejected: the dome is a material
reading a `DayNightState` on every draw, so the day costs a uniform write rather than a
geometry rebuild. A scene that had to own two skies would have to choose which one to
show, and the answer would be the frame's.
