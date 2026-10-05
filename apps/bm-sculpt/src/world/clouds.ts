/**
 * Clouds: a raymarched **spherical shell** of volumetrics wrapped around the planet.
 *
 * ## Why this is a march and not a textured plane
 *
 * The version this replaces was a hundred-thousand-unit plane at a fixed altitude
 * carrying a tileable 2D noise texture, thresholded. It read correctly, and it tiled
 * every three thousand world units — which is the point at which the eye finds the
 * period and the sky stops being weather. Removing the repetition meant removing the
 * plane: a cloud needs a third dimension to have a silhouette, and a silhouette is
 * what makes it a cloud rather than fog with holes in it.
 *
 * ## The shell, and why the layer stopped being a slab
 *
 * A slab between two horizontal planes is a sky for a *flat* world. On a planet the
 * layer has to be two concentric spheres — `seaRadius + CLOUD_BOTTOM` and
 * `seaRadius + CLOUD_TOP` — or the "clouds" stand off the ground on one side and sink
 * into it on the other, and the far side of the planet has none at all. The march is
 * unchanged in spirit; only the entry and exit are solved against two spheres instead
 * of two planes, and the density field is addressed by **direction from the planet's
 * centre and altitude** instead of by world `x`/`z` and `y`.
 *
 * ## The geometry, and why the ordering is the occlusion scheme
 *
 * A large sphere centred on the camera, back faces only, no depth write, added to the
 * scene **last**. That ordering is the whole of it and it costs nothing: terrain is
 * drawn before it with depth writes on, so wherever a mountain is in front the
 * carrier's fragments are depth-rejected and the cloud is simply not there. A depth
 * texture would be the other way to do it and rmsl has none.
 *
 * The carrier is centred on the eye *exactly*, with no snapping, and that is not a
 * detail. The ray direction is `normalize(positionWorld - cameraPosition)`, so with
 * the carrier dead-centre that difference is identical for every pixel however the
 * camera moves and the sky cannot swim as the player walks. The cloud *content* is
 * addressed on the planet and so stays planted over the ground, which was the one
 * thing the old plane got right and the reason to keep. The carrier sphere is only a
 * carrier: it is not where the clouds are, and its radius has no meaning beyond
 * sitting inside the camera's far plane.
 *
 * ## The march
 *
 * Forward, front to back, with the four things that make a volumetric cloud affordable
 * rather than a shader that costs four milliseconds:
 *
 * - **Two tiers of step**, decided from the base shape alone, which is an upper bound
 *   on the density at every point and so can only ever skip empty space. Guerrilla's
 *   original steps *backwards* on finding density so it cannot miss a thin cloud; a
 *   linear forward loop has nowhere to step back to, so the empty step is kept under
 *   two dense ones and the dither below covers the remainder.
 * - **Analytic integration.** Approximating transmittance as constant over a step makes
 *   brightness depend on how finely the volume was sampled, which is what forces small
 *   steps. Integrating it exactly — density constant, transmittance exponential —
 *   removes the coupling, and it is what buys the long empty steps. From
 *   *Optimisations for Real-Time Volumetric Cloudscapes*.
 * - **A dither on the first sample**, which turns the banding a fixed step cuts through
 *   a volume into noise. Nothing here accumulates temporally, so it is interleaved
 *   gradient noise rather than blue: designed to be invisible in a still frame, which
 *   is the only kind of invisible that matters for a screenshot.
 * - **Early exit** below one per cent transmittance, since most of a sky is behind
 *   something opaque.
 *
 * ## What is left out, and what it costs
 *
 * Beyond `FAR_FIELD` the sample uses the base shape alone: no detail channels, no
 * erosion, no march toward the light. That is visible as a loss of texture at the far
 * edge of the layer, where the aerial perspective is doing most of the work anyway.
 * The alternative — every sample paying for the detail, as production does — is
 * affordable at two milliseconds on a console and is not affordable here.
 *
 * The march toward the light is five steps at geometrically growing distances rather
 * than the precomputed light volume production uses, because building that volume is
 * a bake of its own and this module already has a two-and-a-half-second bake in it.
 */

import type { Node, UniformNode, Var } from "@random-mesh/rmsl";
import {
  Break,
  If,
  Loop,
  exp,
  float,
  fragCoord,
  interleavedGradientNoise,
  max,
  min,
  saturate,
  select,
  sqrt,
  vec2,
  vec3,
  vec4,
} from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  DataTexture,
  Mesh,
  NodeMaterial,
  Scene,
  Side,
  SphereGeometry,
} from "@random-mesh/rmsl/scene";

import type { Vec3 } from "@big-mesh-studios/core";
import { DEFAULT_PLANET, reachOf } from "@big-mesh-studios/csg";
import { DEFAULT_PLANET_RADIUS } from "../render/atmosphere";
import { equirectUV } from "../render/globe";
import { SkyLight } from "../render/sky-light";
import { bakeCloudField, type CloudField } from "./cloud-field";
import { shapeTexture, weatherTexture } from "./cloud-textures";
import type { DayNightState } from "./day-night";

/**
 * How far above the tallest terrain the cloud layer's floor sits.
 *
 * **Derived, not written down**, for the same reason the globe's crossfade is: a hardcoded
 * altitude is a number that means something only until the mountains change. These were 700 and
 * 1400 against a reach of 288, which put the floor two thousand units above the peaks — and
 * tripling the ranges put the peaks *through* the cloud base, so every summit came out of a
 * cloud deck. `reachOf` is the landscape's own reach and it moves when the landscape does.
 */
const CLOUD_CLEARANCE = 120;

/** The bottom of the cloud layer, as an altitude above the sea. */
export const CLOUD_BOTTOM = reachOf(DEFAULT_PLANET) + CLOUD_CLEARANCE;

/** The top of the cloud layer, as an altitude above the sea. Seven hundred above its floor. */
export const CLOUD_TOP = CLOUD_BOTTOM + 700;

/** The layer's thickness, which the volume's vertical axis is stretched across. */
export const CLOUD_THICKNESS = CLOUD_TOP - CLOUD_BOTTOM;

/**
 * How far the carrier sphere reaches, in world units.
 *
 * Forty thousand, so the whole sphere sits inside the camera's four-hundred-thousand far
 * plane. Nothing about the number matters beyond that: it is a carrier for a ray
 * direction, not a place clouds are.
 */
const CLOUD_EXTENT = 40000;

/**
 * World units of the planet's surface one repeat of the shape volume covers.
 *
 * The shape volume is addressed by the **direction from the planet's centre**, scaled by
 * `seaRadius / CLOUD_FEATURE` — so its features are this many world units across on the
 * surface, and the field repeats that many times around the equator. The weather map, by
 * contrast, is wrapped around the planet **exactly once**. The ratio being neither an integer
 * nor a simple fraction is the same point it always was: two fields whose periods cannot be
 * locked together are weather, and one field at one scale is wallpaper.
 *
 * **This scales with the radius, and it should not, and the reason is the feature's *angle*.**
 *
 * A direction is a direction on a sphere, so a feature this size subtends `CLOUD_FEATURE /
 * seaRadius` radians **to the player standing under it, at every elevation and every
 * distance** — the one thing about a cloud's size that a ground player reads first. Which
 * makes the angular size and the wrap count the same number: `wraps = 2π / angular`. There is
 * no version of this constant that gives big clouds overhead *and* few repeats, and pretending
 * otherwise is how a planet ends up with one cloud in it.
 *
 * `0.12 · R` is chosen from the ground, upwards. At a twelfth of the radius a feature is
 * 6.9° of arc, so roughly **thirteen** clouds lie between the horizon and the zenith — a sky
 * with weather in it you can point at — and the volume repeats **52.4** times around the
 * equator, which is four times the anti-repetition floor and never near a whole number.
 *
 * The predecessor was `0.6 · R`, put there by 0041's rule that the planet's body scales with
 * its radius. That rule is right for the body and wrong here: the cloud feature is not a
 * feature of the *body*. It is a distance at which weather is recognisable, and the eye
 * standing on the ground is the instrument that measures it. At 0.6 it was 34° of arc, which
 * put **two and a half** clouds in the entire visible hemisphere and one in the whole sky
 * above thirty degrees — technically weather, and not something a person would call weather.
 *
 * The scaling is not `seaRadius²`. Features tile a surface: `N · L² = 4π · seaRadius²`, so
 * holding N fixed makes L proportional to `seaRadius` and holding the *area* fixed is what
 * the square would do. On the second planet `R²` would make one feature twenty radians
 * across — six and a half skies — so that the entire planet was a single cloud.
 */
export const CLOUD_FEATURE = DEFAULT_PLANET_RADIUS * 0.12;

/** How far the march goes at most, and therefore where the layer fades out. */
const MAX_DISTANCE = 17000;

/**
 * How many steps the march takes before it gives up.
 *
 * Exported because it is one of two honest levers on this shader's cost, and
 * `clouds.test.ts` builds a per-pixel fetch budget out of it. rmsl has no
 * `renderer.info` and this project has no render-scale plumbing, so a texture-read count
 * computed from these two numbers is the only measure of what the layer costs that can
 * be taken on the host.
 */
export const MAX_STEPS = 128;

/** How far a step through cloud is. */
const DENSE_STEP = 70;

/**
 * How far a step through empty space is.
 *
 * Under two dense ones, deliberately. A cloud thinner than the empty step can be
 * stepped over entirely, which shows as a hole in the layer that wanders as the
 * player walks; at a ratio of 1.7 that needs a cloud under seventy units thick, and
 * with the layer seven hundred thick there are always several.
 */
const EMPTY_STEP = 120;

/** Below this fraction of transmittance there is nothing left worth integrating. */
const MIN_TRANSMITTANCE = 0.01;

/** How far past this the sample skips its detail and its march toward the light. */
const FAR_FIELD = 7000;

/** How much a unit of density dims light passing through it. */
const EXTINCTION = 1.15;

/** How much of the sun's own light a unit of density absorbs on the way in. */
const ABSORPTION = 0.42;

/**
 * How far the weather map's curl displaces the shape volume's lookup, in units of the
 * shape volume's own tile.
 *
 * **A tenth of a tile, and it follows the tile rather than the world**, so it needs no
 * retuning when `CLOUD_FEATURE` does: a tenth of whatever a cloud is across. The number it
 * works out to is 1,632 units at the current feature size, and the reason it is stated in
 * tiles at all is that the same tenth was 240 units on the flat planet and 8,160 on the
 * first spherical one — three very different displacements from one unchanged constant, and
 * the reason this comment used to be wrong without anyone noticing. The warp is a *curl*,
 * which matters more than its size: a curl field has no divergence, so it displaces the
 * noise without ever gathering or thinning it. A warp built from two independent noise
 * samples does both, and the places where it gathers read as the noise piling into hard
 * veins.
 *
 * It is applied in the volume's two **horizontal** slots — see `warpOffset`, and the reason
 * there: `y` is the altitude now, and warping it shears the billows off their own bases.
 */
const WARP_STRENGTH = 0.1;

/** How fast the layer drifts, in world units per second. */
const DRIFT = 6;

/**
 * Where in a cloud's height the layer is thickest, before the streak field moves it.
 *
 * High, so most of the layer is cloud and the gradient shapes its edges rather than
 * its mass. A layer whose thickest point is low is a stratus deck: flat, grey and
 * featureless, which is one cloud type and not the default.
 */
const CORE_HEIGHT = 0.62;

/** The lowest coverage a sample may have before it is treated as empty air. */
const MIN_PROFILE = 0.05;

/**
 * The steps the march toward the light takes.
 *
 * The other half of the same budget, and by far the more expensive half: five volume
 * fetches per marched step against two per step of the march itself, so doubling this
 * costs more than doubling `MAX_STEPS`. Exported for the same reason.
 */
export const LIGHT_STEPS = 5;

/** How far the first step toward the light is, in world units. */
const LIGHT_STEP = 60;

/**
 * How much of the sky colour the far edge of the layer takes on, per thousand units.
 *
 * Aerial perspective, and the reason the layer has a horizon at all: without it the
 * clouds run to the edge of the frame at full contrast. It is the same colour the
 * terrain's fog takes, from the same place, but the clouds are nearly all of the far
 * field and so have to carry their own.
 */
const AERIAL_PERSPECTIVE = 0.00012;

/** Henyey-Greenstein's forward lobe, the backward lobe, and how much of the second. */
const PHASE_FORWARD = 0.76;
const PHASE_BACKWARD = -0.28;
const PHASE_MIX = 0.3;

/** How dark the edge of a cloud reads against its lit interior. */
const POWDER = 2.6;

/** The erosion's softness, matching `cloud-field.ts`'s default. */
const EROSION_SOFTNESS = 0.4;

/**
 * The Henyey-Greenstein phase function: how a droplet of water throws light.
 *
 * Cloud droplets scatter hard forwards, which is the entire reason a cloud seen
 * against the sun has a bright rim and a cloud seen against blue sky does not.
 */
const henyeyGreenstein = (
  cosTheta: Node<"float">,
  g: number,
): Node<"float"> => {
  const g2 = g * g;
  const denominator = float(1 + g2)
    .sub(float(2 * g).mul(cosTheta))
    .max(float(1e-4));
  return float(1 + g2).div(denominator.pow(float(1.5)).mul(float(4 * Math.PI)));
};

/**
 * The erosion of `cloud-field.ts`, as nodes.
 *
 * Written out rather than shared, because the bake is host-side and this is not, and
 * the two have to agree or the sky will not look like the field it was baked from.
 * See that function for why the clamp at the end is what makes this subtractive, and
 * why the detail is *not* negated.
 */
const erosionNode = (
  base: Node<"float">,
  detail: Node<"float">,
): Node<"float"> => {
  const h = EROSION_SOFTNESS;
  const shifted = detail.mul(1 - h).add(h);
  const floor = float(1).sub(base);
  return min(saturate(shifted.sub(floor).div(float(h))), base);
};

/**
 * Everything the density and lighting helpers need to read.
 *
 * The six sky bindings are shared with every other lit material through `SkyLight`, so
 * the cloud layer takes the same `DayNightState` the terrain and the water do and there
 * is one shape of "what the sky is doing" in the whole application. Only the three that
 * are the cloud layer's own are here.
 */
interface Field {
  readonly shape: UniformNode<"sampler3D">;
  readonly weather: UniformNode<"sampler2D">;
  readonly sky: SkyLight;
  readonly coverage: UniformNode<"float">;
  readonly density: UniformNode<"float">;
  /** The sea radius, so a point's height above the ground and its direction can be told apart. */
  readonly seaRadius: UniformNode<"float">;
  /** How far the whole field has turned about the planet's axis, in radians. */
  readonly driftAngle: UniformNode<"float">;
  /** World radius of the shape volume's sphere: `seaRadius / CLOUD_FEATURE`. */
  readonly shapeScale: Node<"float">;
}

/** The drift rotation's cosine and sine, computed once a frame and carried about as a pair. */
interface Turn {
  readonly cos: Node<"float">;
  readonly sin: Node<"float">;
}

/**
 * Turns a direction about the planet's axis by the drift.
 *
 * The field is fixed and the *lookup* turns, exactly as the starfield does, so the clouds
 * circle the planet rather than sliding across a map. Rotating the direction rather than
 * offsetting a texture coordinate is what keeps the motion continuous across the
 * antimeridian: an equirectangular `u` offset would jump a whole tile there, and no amount
 * of wrapping hides a discontinuity in the address of a field that does not wrap with it.
 */
const spun = (turn: Turn, v: Node<"vec3">): Node<"vec3"> =>
  vec3(
    v.x.mul(turn.cos).sub(v.z.mul(turn.sin)),
    v.y,
    v.x.mul(turn.sin).add(v.z.mul(turn.cos)),
  );

/**
 * The weather map at a direction, wrapped once around the planet.
 *
 * The map is equirectangular and the sphere is not, so the poles pinch — the same pinch
 * the globe's own albedo has, and acceptable for a coverage field this low-frequency. The
 * direction arrives already spun, so the drift is the caller's business.
 */
const weatherAt = (f: Field, direction: Node<"vec3">): Node<"vec4"> =>
  f.weather.texture(equirectUV(direction));

/**
 * Where a sample falls in the shape volume, before the warp: **direction, plus altitude.**
 *
 * The direction half is `normalize(world) · seaRadius / CLOUD_FEATURE`, which is what makes
 * the layer a sphere rather than a plane: its features are a fixed size on the surface however
 * far the sample is from the centre, and because it is a three-dimensional field sampled on
 * a direction it has no seam and no pole.
 *
 * **The altitude half is not optional, and leaving it out is the whole of one bug.** A
 * direction is scale-invariant, so two samples 700 units apart *vertically* — the exact
 * distance from the ground to the underside of the layer — differ in direction by about five
 * thousandths of a radian. The address moved **half a texel** of a sixty-texel volume, and a
 * ray marching toward the sun moved four tenths of one. Every sample of a ray therefore read
 * the *same* base shape and the *same* three detail channels, and what vertical structure was
 * left came from the one-dimensional `heightGradient` alone. The sky was a silhouette
 * extruded through seven hundred units, softly capped and softly floored: smooth, and with no
 * billow in it. Adding `height` to the volume's `y` puts the layer's own normalised altitude
 * back in the address, which is what the flat world's `(worldY − CLOUD_BOTTOM) /
 * CLOUD_THICKNESS` was, and the ray sweeps **sixty texels** again — the whole volume, once,
 * going up through the layer.
 *
 * Both halves are read at every sample of the march *and* of the march toward the light. The
 * light march especially: a shadow ray climbs a thousand units or more, and addressing it by
 * direction alone would draw shadows that do not follow the density casting them.
 */
const shapeAt = (
  f: Field,
  direction: Node<"vec3">,
  height: Node<"float">,
): Node<"vec3"> =>
  direction.mul(f.shapeScale).add(vec3(float(0), height, float(0)));

/**
 * A sample's altitude as the volume's vertical address: zero at the underside, one at the top.
 *
 * The same expression as the profile's `height`, and deliberately the *same expression* — one
 * line of arithmetic, read out of the shader by the test that holds the address, rather than two
 * spellings of a number that have to agree. It goes negative below the layer and past one above
 * it, which is fine: the volume wraps on every axis.
 */
const heightAt = (f: Field, world: Node<"vec3">): Node<"float"> =>
  world
    .length()
    .sub(f.seaRadius)
    .sub(float(CLOUD_BOTTOM))
    .div(float(CLOUD_THICKNESS));

/**
 * The drift angle, recomputed by the caller each frame.
 *
 * Its own uniform rather than arithmetic on `uTime`, because the rotation has to be the
 * same number at every place it appears and rmsl emits an expression once per use. The
 * angular speed is the linear `DRIFT` over the planet's radius, so the surface clouds move
 * at `DRIFT` world units a second whatever the planet's size — which is the property a
 * player reads as wind.
 */
export const driftAngleAt = (time: number, seaRadius: number): number =>
  (time * DRIFT) / Math.max(seaRadius, 1);

/** The near span of a ray through the cloud shell, as distances from the eye. */
export interface CloudSpan {
  /** Where the march should begin, and where it should not go past. */
  readonly enter: number;
  readonly exit: number;
}

/**
 * The near span of a ray through the two shells — the host mirror of the shader's entry and
 * exit, for the tests.
 *
 * **The near span, not both.** A ray that crosses the inner sphere meets the shell twice: in
 * front of the planet and behind it. Only the front one is worth marching, because the far
 * one is hidden by the globe and the globe writes no depth for it to hide behind; the span
 * therefore stops at the inner sphere's near root.
 *
 * Three cases, and all three are tested:
 *
 * - **From below the layer**, looking up: the span starts where the ray leaves the inner
 *   sphere and ends at the outer.
 * - **From between the shells**: it starts at the eye.
 * - **From above**, looking down: it starts at the outer shell and stops at the inner.
 *
 * And one that is not a span at all: **from below the layer, looking down**, the only shell
 * on the ray is the far side, under the planet, so the span is empty. Without that case a
 * ground player's downward rays would march the underside of the far hemisphere.
 */
export const cloudSpan = (
  eye: Vec3,
  ray: Vec3,
  seaRadius: number,
  maxDistance: number = MAX_DISTANCE,
): CloudSpan => {
  const inner = seaRadius + CLOUD_BOTTOM;
  const outer = seaRadius + CLOUD_TOP;
  const b = eye.x * ray.x + eye.y * ray.y + eye.z * ray.z;
  const eyeSquared = eye.x ** 2 + eye.y ** 2 + eye.z ** 2;

  const outerRoot = Math.sqrt(Math.max(b * b - (eyeSquared - outer ** 2), 0));
  const outerNear = -b - outerRoot;
  const outerFar = -b + outerRoot;

  const innerDisc = Math.max(b * b - (eyeSquared - inner ** 2), 0);
  const innerRoot = Math.sqrt(innerDisc);
  const innerNear = -b - innerRoot;
  const innerFar = -b + innerRoot;
  const crossesInner = innerDisc > 0;
  const eyeInsideInner = eyeSquared < inner ** 2;

  let enter = Math.max(0, outerNear);
  if (crossesInner && enter >= innerNear && enter <= innerFar) enter = innerFar;
  let exit = Math.min(outerFar, maxDistance);
  if (crossesInner && innerNear > enter && innerNear < exit) exit = innerNear;
  // Looking down from under the layer: everything on this ray is the planet, not cloud.
  if (eyeInsideInner && b < 0) exit = enter;
  return { enter, exit };
};

/**
 * The displacement the weather map's warp asks for, as a tile-space offset.
 *
 * Computed once per sample and then reused by the march toward the light, which is
 * what keeps the light's geometry aligned with the density's without paying for a
 * weather lookup at every light step. The error is that the warp does not vary along
 * the light ray; over sixty-odd units of a `CLOUD_FEATURE` tile it is invisible.
 */
const warpOf = (weather: Node<"vec4">): Node<"vec2"> =>
  // rmsl's swizzles stop at xy, xz, xw, yz, yw and zw — there is no gb, so the
  // two channels are taken separately and paired by hand.
  vec2(weather.g, weather.b).sub(vec2(0.5, 0.5)).mul(float(WARP_STRENGTH));

/**
 * The warp, placed in the volume's two **horizontal** slots.
 *
 * It used to go in `x` and `y`, which was the right pair for a volume whose `y` was a
 * different axis from altitude. It is not any more: `y` carries the altitude, so a tenth of
 * a tile of warp in it would slide the cloud up and down by up to seventy units of height
 * depending on where in the weather field the sample happened to be — the billows shearing
 * off their own bases. `x` and `z` carry the direction's two horizontal components, so the
 * warp displaces along the surface and leaves the height alone.
 */
const warpOffset = (warp: Node<"vec2">): Node<"vec3"> =>
  vec3(warp.x, float(0), warp.y);

/** The base shape: the cheap test, and what the march toward the light samples. */
const baseAt = (f: Field, coords: Node<"vec3">): Node<"float"> =>
  f.shape.texture(coords).r;

/**
 * The layer's height gradient: nothing at the very bottom, a body in the middle,
 * rounded off at the top.
 *
 * The streak field moves the top, and that is what separates thin high cloud from
 * thick low cloud at this resolution — there is no second weather channel for it.
 */
const heightGradient = (
  height: Node<"float">,
  streak: Node<"float">,
): Node<"float"> => {
  const core = streak.mul(0.3).add(CORE_HEIGHT - 0.15);
  const rising = saturate(height.div(float(0.09)));
  const falling = saturate(height.sub(core.sub(float(0.34))).div(float(0.34)));
  return rising.mul(float(1).sub(falling));
};

/**
 * The coverage-thresholded shape, before erosion.
 *
 * Nubis's dimensional profile. The base shape is thresholded by how much cloud the
 * weather map says belongs here, so coverage masks the shape rather than being
 * multiplied into it afterwards — which is what makes a thin edge thin rather than
 * merely eroded.
 *
 * Takes the already-sampled base rather than reading it again, because a texture
 * fetch the compiler cannot see it has already made is a fetch it will make.
 */
const shapeUnderCoverage = (
  f: Field,
  base: Node<"float">,
  height: Node<"float">,
  weather: Node<"vec4">,
): Node<"float"> => {
  const profile = weather.r
    .mul(f.coverage)
    .mul(heightGradient(height, weather.a));
  return saturate(
    base.sub(float(1).sub(profile.min(float(1)))).div(profile.max(float(0.02))),
  );
};

/**
 * The volume at a point, and the two readings taken from it.
 *
 * Base shape and detail are the red channel and the rest of the same fetch, so this
 * is one texture read rather than four. Left as two expressions rmsl emits two reads
 * for the pair — it builds a graph and cannot see that the two are the same sample,
 * which is worth remembering anywhere a node is used more than once.
 */
const sampleVolume = (
  f: Field,
  coords: Node<"vec3">,
  base: Var<"float">,
  detail: Var<"float">,
): void => {
  const sampled = f.shape.texture(coords).toVar();
  base.assign(sampled.r);
  // Weighted toward the coarsest channel so the finest contributes an edge without
  // becoming the edge.
  detail.assign(
    sampled.g.mul(0.55).add(sampled.b.mul(0.3)).add(sampled.a.mul(0.15)),
  );
};

/**
 * The optical depth from a sample toward a light, by marching the base shape.
 *
 * Five steps at geometrically growing distances rather than a fixed small one, and
 * each step weighted by its own length — which is what makes this a *depth* rather
 * than an average. The near field is where self-shadowing actually shows and where
 * the steps are fine; the far field is already attenuated and can be coarse.
 */
const lightDepthAt = (
  f: Field,
  turn: Turn,
  origin: Node<"vec3">,
  direction: Node<"vec3">,
  offset: Node<"vec3">,
  accumulator: Var<"float">,
  stepTo: Var<"float">,
): void => {
  // One approximation, cheap and invisible at this scale: the warp is a constant offset
  // rather than a fresh weather lookup per step, so it does not vary along the light ray —
  // over a few hundred units of a `CLOUD_FEATURE` tile that is a fraction of a cell. The
  // warp is passed in already placed, so the five steps do not each rebuild it.
  //
  // **The direction *and* the altitude are both re-derived at every step, and the altitude is
  // the half that is easy to leave out.** `along` is a real point on the sphere, so it has its
  // own direction and its own height above the sea, and both belong in the address for the
  // shadow to be a shadow *of this density*. A light march addressed by direction alone climbs
  // a thousand units and stays on the same texel, which is precisely the flat-grey, unshaded
  // look this whole change exists to remove. It costs one `length` per light step, inside the
  // near field only, where the march is already the expensive half of the shader.
  Loop(LIGHT_STEPS, () => {
    const along = origin.add(direction.mul(stepTo)).toVar();
    const here = spun(turn, along.normalize()).toVar();
    accumulator.addAssign(
      baseAt(f, shapeAt(f, here, heightAt(f, along)).add(offset)).mul(stepTo),
    );
    stepTo.mulAssign(1.9);
  });
};

/** Three octaves of progressively dimmer, less absorbed light. Wrenninge's trick. */
const multiScatter = (opticalDepth: Node<"float">): Node<"float"> => {
  const total = float(0).toVar();
  const amplitude = float(1).toVar();
  const falloff = float(1).toVar();
  const transmittance = exp(opticalDepth.negate()).mul(0.5).add(0.5);
  Loop(3, () => {
    total.addAssign(amplitude.mul(transmittance.pow(falloff)));
    amplitude.mulAssign(0.5);
    falloff.mulAssign(0.5);
  });
  return total;
};

/**
 * A raymarched cloud layer.
 *
 * Exported because the only thing that can be checked about a shader without a
 * graphics device is whether it compiles — see `clouds.test.ts`.
 */
export class CloudMaterial extends NodeMaterial {
  /**
   * The day this is lit by, shared with every other lit material.
   *
   * The whole day's state rather than six fields, which is what the caller has and
   * which the sky, the terrain, the water and this all take.
   */
  readonly sky = new SkyLight();

  /** Clock seconds, which the layer drifts on. */
  time = 0;

  /**
   * How far the whole field has turned about the planet's axis, in radians.
   *
   * Written by `update` rather than derived from `uTime` in the shader, because the
   * rotation has to be the same value at every place it appears and rmsl emits an
   * expression once per use. The angle is `driftAngleAt`, so the surface clouds move at a
   * fixed world speed whatever the planet's size.
   */
  driftAngle = 0;

  /** How much of the sky is cloud, 0 to 1. The one knob worth having. */
  coverage = 0.52;

  /** How opaque a cloud is where it has fully formed. */
  density = 1;

  private field!: Field;

  constructor(
    private readonly shapeSource: DataTexture,
    private readonly weatherSource: DataTexture,
    /** The planet's sea radius, which fixes the two shells and the field's scale on them. */
    readonly seaRadius: number = DEFAULT_PLANET_RADIUS,
  ) {
    super();
    this.transparent = true;
    // Back faces only: the camera is inside the carrier, so what it sees of every wall is
    // that wall's far side, and drawing both sides would rasterise every pixel twice for an
    // identical result.
    this.side = Side.BackSide;
    // No depth write, so the layer occludes nothing drawn after it and the sky behind stays
    // visible wherever there is no cloud.
    this.depthWrite = false;
  }

  protected override setup(b: Builder): void {
    // `this.field` is built here and read in `buildFragmentBody`. Declaring in `setup` is a
    // promise rather than an assignment that could be reordered: the body is built after the
    // setup, and every uniform's value thunk is read per draw, so assigning the day's state
    // after the material is built still takes effect.
    this.sky.declare(b);
    const seaRadius = b.materialUniform(
      "uSeaRadius",
      "float",
      () => this.seaRadius,
    );
    this.field = {
      shape: b.sampler("uShape", "sampler3D", () => this.shapeSource),
      weather: b.sampler("uWeather", () => this.weatherSource),
      sky: this.sky,
      coverage: b.materialUniform("uCoverage", "float", () => this.coverage),
      density: b.materialUniform("uDensity", "float", () => this.density),
      seaRadius,
      driftAngle: b.materialUniform(
        "uDriftAngle",
        "float",
        () => this.driftAngle,
      ),
      // **The shell's two radii and the shape's scale all come from the sea radius**, so a
      // world with another planet moves its clouds with it. `shapeScale` is the radius of the
      // direction sphere inside the shape volume: one tile of the volume per `CLOUD_FEATURE`
      // of surface.
      shapeScale: seaRadius.mul(float(1 / CLOUD_FEATURE)),
    };
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const f = this.field;
    const eye = b.cameraPosition;
    // The carrier is centred on the eye, so this is the view ray and not an
    // approximation of it. Held in a variable because it is read by every one of the
    // hundred and twenty-eight iterations and rmsl does not know it is the same
    // expression each time.
    const ray = b.positionWorld.sub(eye).normalize().toVar();

    // The drift, as the pair of trigonometry every address needs. Computed once and carried
    // into the light march, which spins the same direction on every step.
    const turn: Turn = {
      cos: f.driftAngle.cos().toVar(),
      sin: f.driftAngle.sin().toVar(),
    };

    // ---- where the ray enters and leaves the shell ----
    // Solved against the two concentric spheres, not two planes. The density lives only
    // between them, so the near span is what is worth marching; the far span behind the
    // planet is dropped rather than marched and hidden by the globe, which writes no depth
    // for it to hide behind. The quadratic is the half-`b` form: for a unit `ray`, the roots
    // of `|eye + t·ray| = R` are `-b ± √(b² − c)` with `b = eye·ray` and `c = eye·eye − R²`,
    // and the discriminant is clamped so a miss yields a zero root rather than a `NaN` that
    // would survive every comparison downstream.
    const innerRadius = f.seaRadius.add(float(CLOUD_BOTTOM));
    const outerRadius = f.seaRadius.add(float(CLOUD_TOP));
    const bq = eye.dot(ray);
    const eyeSquared = eye.dot(eye);

    const outerDisc = max(
      bq.mul(bq).sub(eyeSquared.sub(outerRadius.mul(outerRadius))),
      float(0),
    );
    const outerRoot = sqrt(outerDisc);
    const outerNear = bq.negate().sub(outerRoot).toVar();
    const outerFar = bq.negate().add(outerRoot).toVar();

    const innerDisc = max(
      bq.mul(bq).sub(eyeSquared.sub(innerRadius.mul(innerRadius))),
      float(0),
    );
    const innerRoot = sqrt(innerDisc);
    const innerNear = bq.negate().sub(innerRoot).toVar();
    const innerFar = bq.negate().add(innerRoot).toVar();
    const crossesInner = innerDisc.greaterThan(float(0)).toVar();

    // The near span. It starts at the outer shell's near root, or at the eye when the eye is
    // already inside it. If that point is *under* the cloud layer the span begins where the
    // ray leaves the inner sphere; otherwise it ends where the ray meets the inner sphere —
    // the near side of the planet — which is what keeps the far-side clouds from being
    // marched through the globe.
    const enter = outerNear.max(float(0)).toVar();
    enter.assign(
      select(
        crossesInner
          .and(enter.greaterThanEqual(innerNear))
          .and(enter.lessThanEqual(innerFar)),
        innerFar,
        enter,
      ),
    );
    const exit = min(outerFar, float(MAX_DISTANCE)).toVar();
    exit.assign(
      select(
        crossesInner
          .and(innerNear.greaterThan(enter))
          .and(innerNear.lessThan(exit)),
        innerNear,
        exit,
      ),
    );
    // From under the layer, looking down: the only shell on the ray is the far side of the
    // planet, under the ground, so the span is emptied rather than marched. `b < 0` is the
    // ray turning inward; the ground player's upward and grazing rays are untouched.
    exit.assign(
      select(
        eyeSquared
          .lessThan(innerRadius.mul(innerRadius))
          .and(bq.lessThan(float(0))),
        enter,
        exit,
      ),
    );

    // ---- every mutable value, declared before any loop ----
    // rmsl hoists a `toVar` out of a loop body, so a value introduced inside one
    // carries the previous iteration's contents into the next; and a `mulAssign` on
    // anything that is not a variable emits the literal `1.0 = 0.5;`, which is not
    // GLSL. So each of these is declared once, here, and assigned where it is used.
    //
    // The per-sample ones are declared here for a second reason. rmsl builds a graph
    // and a texture fetch is an ordinary expression, so `texture(uShape, ...)` used
    // twice emits two fetches — the compiler cannot see that they were the same one.
    // Left to its own devices this shader issued eight fetches per iteration where
    // four will do. Every intermediate that costs a fetch is a variable for that
    // reason and not for tidiness.
    const scatter = vec3(0, 0, 0).toVar();
    const transmittance = float(1).toVar();
    const distance = float(0).toVar();
    const stepLength = float(EMPTY_STEP).toVar();
    const density = float(0).toVar();
    const lightDepth = float(0).toVar();
    const lightStep = float(LIGHT_STEP).toVar();

    const world = vec3(0, 0, 0).toVar();
    const weather = vec4(0, 0, 0, 1).toVar();
    const coords = vec3(0, 0, 0).toVar();
    const height = float(0).toVar();
    const warp = vec2(0, 0).toVar();
    const shape = float(0).toVar();
    const shaped = float(0).toVar();
    const detail = float(0).toVar();
    const lit = vec3(0, 0, 0).toVar();

    // Where the first sample goes. Interleaved gradient noise rather than blue,
    // because nothing here accumulates over frames: blue noise is better at hiding
    // under temporal averaging, and this is the only kind of averaging there is.
    const jitter = interleavedGradientNoise(fragCoord()).toVar();

    const sun = f.sky.sunDirection.normalize().toVar();

    // Whichever light is up. Both directions normalised once: the march reads them
    // five times, and the phase reads the sun twice.
    const moon = f.sky.moonDirection.normalize().toVar();
    const litDirection = select(sun.y.greaterThan(float(0)), sun, moon);

    // Where the march starts: the slab's entry, pushed forward by up to one step of
    // dither. Both halves matter.
    //
    // Starting at the eye instead of at the entry point spends up to a sixth of the
    // step budget walking through the empty air under the layer — the height gradient
    // is zero down there so nothing is drawn, but the budget is gone by the time the
    // ray arrives — and it costs the far end of the layer its last steps.
    //
    // The dither is what stops the fixed step cutting visible shells through the
    // volume, where rays cross the same density boundary together. Without it the
    // banding is the first thing anyone sees, and no amount of step tuning fixes it.
    distance.assign(enter.add(jitter.mul(float(EMPTY_STEP))));

    // The phase function depends only on the view ray and the sun, neither of which
    // changes along the ray, so it is built once rather than per sample.
    const phase = henyeyGreenstein(ray.dot(sun), PHASE_FORWARD)
      .mul(1 - PHASE_MIX)
      .add(henyeyGreenstein(ray.dot(sun), PHASE_BACKWARD).mul(PHASE_MIX))
      .mul(2);

    Loop(MAX_STEPS, () => {
      If(
        select(
          distance.greaterThan(exit),
          true,
          transmittance.lessThan(float(MIN_TRANSMITTANCE)),
        ),
        () => {
          Break();
        },
      );

      // The sample's direction from the planet's centre, spun by the drift, is what the
      // weather map is addressed by, and — scaled — what the shape volume is. Its altitude
      // fraction is the volume's *vertical* axis as well as the profile's, so the two are
      // read once, from the same expression, and go to the two places that want them.
      //
      // Order matters: `height` is read before `coords`, which is its only consumer that is
      // a texture fetch, and rmsl builds an expression graph rather than a sequence, so
      // reading the var before assigning it is the same read as reading it after — but the
      // assignment being written first is what makes that true by inspection.
      world.assign(eye.add(ray.mul(distance)));
      const here = spun(turn, world.normalize()).toVar();
      weather.assign(weatherAt(f, here));
      warp.assign(warpOf(weather));
      height.assign(heightAt(f, world));
      coords.assign(shapeAt(f, here, height).add(warpOffset(warp)));

      // The cheap test, off the base shape alone. The coverage threshold and the
      // erosion can both only remove density, so this is an upper bound on what is
      // here and the longer empty step below is sound.
      // One read for the base shape and the detail together, then the cheap test off
      // the base alone. The coverage threshold and the erosion can both only remove
      // density, so the base is an upper bound on what is here, and the longer empty
      // step below is sound because of it.
      sampleVolume(f, coords, shape, detail);
      stepLength.assign(
        select(
          shape.greaterThan(float(MIN_PROFILE)),
          float(DENSE_STEP),
          float(EMPTY_STEP),
        ),
      );

      If(shape.greaterThan(float(MIN_PROFILE)), () => {
        shaped.assign(shapeUnderCoverage(f, shape, height, weather));
        density.assign(
          erosionNode(shaped, detail).mul(f.density).pow(float(0.42)),
        );

        If(density.greaterThan(float(0.002)), () => {
          // Reset every iteration and before the branch below. A `toVar` declared
          // outside the loop keeps whatever it last held, and the far field skips
          // the march entirely — so without this it would carry the previous
          // sample's shadowing along the ray and smear it.
          lightDepth.assign(float(0));

          If(distance.lessThan(float(FAR_FIELD)), () => {
            // One march, for whichever light is up. Marching both costs ten fetches
            // where five will do, and it is not ten for two shadows: the sun's march
            // runs below the horizon at night and accumulates nothing, so the moon
            // would inherit an empty result and go flat. Which light is brightest
            // changes with the hour, and the march follows it.
            //
            // The dither walks the first step forward or back so the march does not
            // begin at the same depth on every pixel, which is what would otherwise
            // put a visible shell on a soft shadow.
            lightStep.assign(float(LIGHT_STEP).mul(jitter.mul(0.8).add(0.6)));
            lightDepthAt(
              f,
              turn,
              world,
              litDirection,
              warpOffset(warp),
              lightDepth,
              lightStep,
            );
          });

          // Multiple scattering: three octaves of successively dimmer and less
          // absorbed light. A cloud is not a shadow caster — light that misses the
          // first droplet and bounces around inside is most of why a cloud reads as
          // white rather than as grey.
          const energy = multiScatter(lightDepth.mul(float(ABSORPTION)));

          // The powder effect. Light arriving at the outside of a clump has not been
          // scattered yet, so an edge reads darker than the lit core behind it.
          // Without it a cloud is a cut-out with a gradient painted on it.
          const powder = float(1).sub(exp(density.mul(float(-POWDER))));

          // Sky light is brighter above than below, which is most of what tells you
          // which way is up inside a cloud. The altitude fraction, not a volume coordinate:
          // the shape volume is a function of direction and its `y` means nothing vertical.
          const upward = saturate(height.div(float(0.8)));

          lit.assign(
            f.sky.sunLight
              .mul(energy)
              .add(f.sky.moonLight.mul(float(0.4)))
              .mul(powder)
              .mul(phase)
              .mul(1.35)
              .add(f.sky.ambient.mul(upward.mul(0.6).add(0.4))),
          );

          // Aerial perspective. The layer is nearly all of the far field, so it has
          // to carry its own; this is the same colour the terrain's fog takes, from
          // the same place.
          const fade = float(1).sub(
            exp(distance.mul(float(-AERIAL_PERSPECTIVE))),
          );

          // Analytic integration of this step. Treating the density as constant
          // across it and integrating the transmittance exactly is what makes the
          // result independent of how finely the march was sampled, and it is what
          // lets the empty step be longer than the dense one without the two looking
          // like different materials.
          //
          // **The segment is the step's fraction of the remaining opacity, and nothing
          // is divided out of it.** It used to be divided by `absorbed` — this step's
          // optical depth — which is only correct when what multiplies it is a
          // *scattering coefficient* in units of one per length. It is not: `lit` is a
          // colour, so the division made a white cloud accumulate 1/80th of itself.
          //
          // The size of that mistake is the whole reason it went unnoticed: a step's
          // optical depth is `density · EXTINCTION · stepLength`, which for a dense step
          // of seventy units is **eighty**, so every cloud in the sky was being drawn at
          // about one per cent of its own brightness. The silhouettes were perfect, the
          // alpha was perfect, and the colour was black.
          //
          // There is a proof that this form is the right one, and it is worth having
          // because it is checkable: summing `segment` over the march telescopes to
          // exactly `1 - transmittance`, so `scatter / covered` is a *weighted mean of the
          // step colours* — bounded by the brightest colour in the palette. Divide by
          // `absorbed` and that bound is gone.
          const absorbed = density.mul(float(EXTINCTION)).mul(stepLength);
          const stepTransmittance = exp(absorbed.negate());
          const segment = transmittance.sub(
            transmittance.mul(stepTransmittance),
          );

          scatter.addAssign(lit.mix(f.sky.skyColour, fade).mul(segment));
          transmittance.mulAssign(stepTransmittance);
        });
      });

      distance.addAssign(stepLength);
    });

    // What rmsl's blending needs. Front-to-back accumulation produces
    // `scatter + transmittance * background`, and rmsl blends with
    // `src.rgb * src.a + dst * (1 - src.a)` — so the accumulated scatter is already
    // premultiplied and has to be divided back out, or it is multiplied by the
    // transmittance a second time and every cloud comes out twice as dark as it
    // should be. rmsl has `unpremultiplyAlpha`; spelling the division out says what
    // is happening.
    const covered = float(1).sub(transmittance);
    return vec4(scatter.div(covered.max(float(1e-4))), covered);
  }

  /**
   * Position and world position only.
   *
   * The default vertex body also computes and passes the normal and the uv, and the
   * cloud fragment reads neither. Two varyings a full-screen carrier does not use is not
   * a cost anyone would notice, but the carrier covers most of the frame, so it is a cost
   * on most of the frame for nothing.
   */
  protected override buildVertexBody(b: Builder): Node<"vec4"> {
    const world = b.modelMatrix.mul(vec4(b.position, float(1)));
    b.positionWorld.assign(world.xyz);
    return b.projectionMatrix.mul(b.viewMatrix.mul(world));
  }
}

export interface Clouds {
  /**
   * Drifts the layer, keeps the carrier centred on the eye, and takes the day.
   *
   * No separate elapsed argument: the day's state already carries the clock, and two
   * sources of time for one layer is one more thing to keep in step.
   */
  update(camera: Vec3, state: DayNightState): void;
  /** The material, so a caller can push coverage and density at it. */
  readonly material: CloudMaterial;
  dispose(): void;
}

/**
 * Builds the layer, baking its field first.
 *
 * The bake is synchronous because that is the simpler shape, and it is the one this
 * keeps for now: two and a half seconds at startup, behind whatever the application
 * puts on screen while it happens. Moving it to a worker needs no change here —
 * `bakeCloudField` is already free of the DOM and of the renderer — only a caller
 * that can wait for a promise.
 *
 * `seaRadius` places the two shells and the field's scale on them, so the caller has to
 * know which planet it is building weather for.
 */
export const createClouds = (
  scene: Scene,
  seed = 20260901,
  field: CloudField = bakeCloudField(seed),
  seaRadius = DEFAULT_PLANET_RADIUS,
): Clouds => {
  const geometry = new SphereGeometry(CLOUD_EXTENT, 44, Math.floor(44 / 2));
  const material = new CloudMaterial(
    shapeTexture(field.shape),
    weatherTexture(field.weather),
    seaRadius,
  );
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  return {
    material,
    update(camera, state) {
      material.time = state.elapsed;
      material.driftAngle = driftAngleAt(state.elapsed, seaRadius);
      material.sky.lighting = state;
      // Dead-centre on the eye and deliberately unsnapped: the ray direction is read
      // off the difference between this and `cameraPosition`, so snapping here
      // would move the sky by up to a grid step every time the player crossed one.
      // See the note at the top of this file.
      mesh.position.set(camera.x, camera.y, camera.z);
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
    },
  };
};
