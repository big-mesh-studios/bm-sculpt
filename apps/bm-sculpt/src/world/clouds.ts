/**
 * Clouds: a raymarched slab of volumetrics between two horizons and one box of
 * geometry.
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
 * ## The geometry, and why the ordering is the occlusion scheme
 *
 * A large box centred on the camera, back faces only, no depth write, added to the
 * scene **last**. That ordering is the whole of it and it costs nothing: terrain is
 * drawn before it with depth writes on, so wherever a mountain is in front the box's
 * fragments are depth-rejected and the cloud is simply not there. A depth texture
 * would be the other way to do it and rmsl has none.
 *
 * The box is centred on the eye *exactly*, with no snapping, and that is not a
 * detail. The ray direction is `normalize(positionWorld - cameraPosition)`, so with
 * the box dead-centre that difference is identical for every pixel however the camera
 * moves and the sky cannot swim as the player walks. The cloud *content* is addressed
 * in world space and so stays planted over the ground, which was the one thing the
 * old plane got right and the reason to keep.
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
  fract,
  fragCoord,
  interleavedGradientNoise,
  max,
  min,
  saturate,
  select,
  vec2,
  vec3,
  vec4,
} from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  BoxGeometry,
  DataTexture,
  Mesh,
  NodeMaterial,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";

import type { Vec3 } from "@big-mesh-studios/core";
import { SkyLight } from "../render/sky-light";
import { bakeCloudField, type CloudField } from "./cloud-field";
import { shapeTexture, weatherTexture } from "./cloud-textures";
import type { DayNightState } from "./day-night";

/** The bottom of the cloud layer, in world units. */
export const CLOUD_BOTTOM = 700;

/** The top of the cloud layer. */
export const CLOUD_TOP = 1400;

/** The layer's thickness, which the volume's vertical axis is stretched across. */
export const CLOUD_THICKNESS = CLOUD_TOP - CLOUD_BOTTOM;

/**
 * How far the layer reaches before it is snapped, as a half-extent.
 *
 * Forty thousand, so the box's furthest corner sits at 69 282 — inside the camera's
 * hundred-thousand far plane, which a sixty-four-thousand half-extent would not be.
 * Nothing about the number matters beyond that: the box is a carrier for a ray
 * direction, not a region clouds can be in.
 */
const CLOUD_EXTENT = 40000;

/**
 * World units one repeat of the shape volume covers.
 *
 * Twenty-four hundred, against the weather map's forty-eight thousand. The twenty to
 * one ratio is the point, and it is the single most important number in this file: two
 * fields whose periods do not divide into each other cannot be locked onto together,
 * because the eye is never given the ratio. One field at one scale is a texture; two
 * fields at incommensurate scales are weather.
 */
export const CLOUD_FEATURE = 2400;

/** World units one repeat of the weather map covers. See `CLOUD_FEATURE`. */
export const WEATHER_FEATURE = 48000;

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
 * A tenth of a tile is two hundred and forty world units — enough to carry a billow a
 * quarter of the volume's width off its lattice, and no more. The warp is a *curl*,
 * which matters more than its size: a curl field has no divergence, so it displaces
 * the noise without ever gathering or thinning it. A warp built from two independent
 * noise samples does both, and the places where it gathers read as the noise piling
 * into hard veins.
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
  readonly time: UniformNode<"float">;
  readonly coverage: UniformNode<"float">;
  readonly density: UniformNode<"float">;
  /** The volume's address, as a scale and an offset: `world * scale + offset`. */
  readonly volumeScale: Node<"vec3">;
  readonly volumeOffset: Node<"vec3">;
}

/** The weather map at a world position, scrolled by the wind. */
const weatherAt = (f: Field, world: Node<"vec3">): Node<"vec4"> => {
  // Every scalar-times-node here goes through `mul`. Writing `DRIFT * scale` instead
  // is JavaScript multiplication of a number by an object, which is `NaN`, and the
  // NaN propagates into the shader silently: this file emitted `uTime * NaN.0` for
  // its entire drift and a `NaN` light step, and the only symptom was a sky that
  // did not move and a dither that had quietly vanished from the emitted source.
  const scale = float(1 / WEATHER_FEATURE);
  const drift = f.time.mul(float(DRIFT)).mul(scale);
  return f.weather.texture(
    world.xz.mul(scale).add(vec2(drift, drift.mul(0.41))),
  );
};

/**
 * Where a world position falls in the shape volume, before the warp.
 *
 * The volume is cubic and the layer is not: the vertical axis is stretched across the
 * layer's thickness while the horizontal is stretched across `CLOUD_FEATURE`. Sixty
 * texels over seven hundred units vertically and over twenty-four hundred horizontally,
 * so the noise is sampled about three and a half times finer vertically — which is
 * what makes a billow tall rather than spherical, and it costs nothing.
 *
 * The drift is folded into the lookup rather than applied as an offset afterwards so
 * that the wrapped coordinate is wrapped, not the continuous one.
 */
const rawCoords = (f: Field, world: Node<"vec3">): Node<"vec3"> =>
  world.mul(f.volumeScale).add(f.volumeOffset);

/**
 * The volume's drift, in tile units, recomputed by the caller each frame.
 *
 * Its own uniform rather than arithmetic on `uTime`, because the address has to be
 * the same number everywhere it appears and rmsl emits an expression once per use:
 * folding it in would have put the same `fract(uTime * 6.0 * ...)` eight times in one
 * iteration. The value is set from `update`, alongside the time.
 */
const driftAt = (time: number): { x: number; z: number } => ({
  x: (time * DRIFT) / CLOUD_FEATURE,
  z: (time * DRIFT * 0.37) / CLOUD_FEATURE,
});

/**
 * The displacement the weather map's warp asks for, as a tile-space offset.
 *
 * Computed once per sample and then reused by the march toward the light, which is
 * what keeps the light's geometry aligned with the density's without paying for a
 * weather lookup at every light step. The error is that the warp does not vary along
 * the light ray; over sixty-odd units of a twenty-four-hundred-unit tile it is
 * invisible.
 */
const warpOf = (weather: Node<"vec4">): Node<"vec2"> =>
  // rmsl's swizzles stop at xy, xz, xw, yz, yw and zw — there is no gb, so the
  // two channels are taken separately and paired by hand.
  vec2(weather.g, weather.b).sub(vec2(0.5, 0.5)).mul(float(WARP_STRENGTH));

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
  origin: Node<"vec3">,
  direction: Node<"vec3">,
  warp: Node<"vec2">,
  accumulator: Var<"float">,
  stepTo: Var<"float">,
): void => {
  // Two approximations, both cheap and both invisible at this scale.
  //
  // The warp is a constant offset rather than a fresh weather lookup per step, so it
  // does not vary along the light ray — over a few hundred units of a
  // twenty-four-hundred-unit tile that is a fraction of a cell. And the volume's
  // offset is hoisted out, because rmsl emits an expression once per use and the
  // offset carries a `fract` of a uniform, which five steps would otherwise repeat
  // ten times.
  // Spelled out rather than `vec3(warp, 0)`: rmsl emits that correctly but its
  // `vec3` signature does not admit a `Node<"vec2">` in the first slot, even though
  // three.js's TSL does. See the note in the handover.
  const offset = f.volumeOffset.add(vec3(warp.x, warp.y, 0)).toVar();
  Loop(LIGHT_STEPS, () => {
    const along = origin.add(direction.mul(stepTo));
    accumulator.addAssign(
      baseAt(f, along.mul(f.volumeScale).add(offset)).mul(stepTo),
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
   * How far the layer has drifted, in tile units.
   *
   * Written by `update` rather than derived from `uTime` in the shader, because the
   * volume's address has to be the same value at every place it appears and rmsl
   * emits an expression once per use — see `Field.volumeOffset`.
   */
  drift = { x: 0, z: 0 };

  /** How much of the sky is cloud, 0 to 1. The one knob worth having. */
  coverage = 0.52;

  /** How opaque a cloud is where it has fully formed. */
  density = 1;

  private field!: Field;

  constructor(
    private readonly shapeSource: DataTexture,
    private readonly weatherSource: DataTexture,
  ) {
    super();
    this.transparent = true;
    // Back faces only: the camera is inside the box, so what it sees of every wall
    // is that wall's far side, and drawing both sides would rasterise every pixel
    // twice for an identical result.
    this.side = Side.BackSide;
    // No depth write, so the layer occludes nothing drawn after it and the sky
    // behind stays visible wherever there is no cloud.
    this.depthWrite = false;
  }

  protected override setup(b: Builder): void {
    // `this.field` is built here and read in `buildFragmentBody`. Declaring in `setup`
    // is a promise rather than an assignment that could be reordered: the body is built
    // after the setup, and every uniform's value thunk is read per draw, so assigning
    // the day's state after the material is built still takes effect.
    this.sky.declare(b);
    this.field = {
      shape: b.sampler("uShape", "sampler3D", () => this.shapeSource),
      weather: b.sampler("uWeather", () => this.weatherSource),
      sky: this.sky,
      time: b.materialUniform("uTime", "float", () => this.time),
      coverage: b.materialUniform("uCoverage", "float", () => this.coverage),
      density: b.materialUniform("uDensity", "float", () => this.density),
      volumeScale: vec3(
        float(1 / CLOUD_FEATURE),
        float(1 / CLOUD_THICKNESS),
        float(1 / CLOUD_FEATURE),
      ),
      // **The vertical offset is `CLOUD_BOTTOM / CLOUD_THICKNESS` and not
      // `CLOUD_BOTTOM`**, and the difference is the whole sky.
      //
      // The volume's third axis is the layer's *thickness*, so the address of a world
      // altitude is `(y - CLOUD_BOTTOM) / CLOUD_THICKNESS` — which, composed as a scale
      // and an offset, is `1 / CLOUD_THICKNESS` and `-CLOUD_BOTTOM / CLOUD_THICKNESS`.
      // Subtracting the altitude instead puts every sample of the layer at about −699,
      // and the dimensional profile (`heightGradient`) multiplies the coverage by
      // `saturate(height / 0.09)` — so the coverage was multiplied by **zero** at every
      // height in the layer and the density threshold could never be met.
      //
      // The symptom was a sky with no clouds in it at all, at every hour, with the layer
      // built, its shader compiling, its field well-formed and every other test in this
      // file green. `clouds.test.ts` now asserts the address's own arithmetic.
      volumeOffset: vec3(
        fract(b.materialUniform("uDriftX", "float", () => this.drift.x)),
        float(-CLOUD_BOTTOM / CLOUD_THICKNESS),
        fract(b.materialUniform("uDriftZ", "float", () => this.drift.z)),
      ),
    };
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const f = this.field;
    const eye = b.cameraPosition;
    // The box is centred on the eye, so this is the view ray and not an
    // approximation of it. Held in a variable because it is read by every one of the
    // hundred and twenty-eight iterations and rmsl does not know it is the same
    // expression each time.
    const ray = b.positionWorld.sub(eye).normalize().toVar();

    // ---- where the ray enters and leaves the slab ----
    // Solved against the two horizontal planes rather than against a box, because
    // the slab is the only part of the volume with any density in it. A ray with no
    // vertical component has no solution; the division goes to infinity and
    // `MAX_DISTANCE` cuts it out, which is the same answer as handling it.
    const near = min(
      float(CLOUD_BOTTOM).sub(eye.y).div(ray.y),
      float(CLOUD_TOP).sub(eye.y).div(ray.y),
    );
    const far = max(
      float(CLOUD_BOTTOM).sub(eye.y).div(ray.y),
      float(CLOUD_TOP).sub(eye.y).div(ray.y),
    );
    const enter = near.max(float(0)).toVar();
    const exit = min(far, float(MAX_DISTANCE)).max(enter).toVar();

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

      world.assign(eye.add(ray.mul(distance)));
      weather.assign(weatherAt(f, world));
      warp.assign(warpOf(weather));
      coords.assign(rawCoords(f, world).add(vec3(warp.x, warp.y, 0)));

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
        shaped.assign(shapeUnderCoverage(f, shape, coords.y, weather));
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
            lightDepthAt(f, world, litDirection, warp, lightDepth, lightStep);
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
          // which way is up inside a cloud.
          const upward = saturate(coords.y.div(float(0.8)));

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
   * cloud fragment reads neither. Two varyings a full-screen box does not use is not
   * a cost anyone would notice, but the box covers most of the frame, so it is a cost
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
   * Drifts the layer, keeps the box centred on the eye, and takes the day.
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
 */
export const createClouds = (
  scene: Scene,
  seed = 20260901,
  field: CloudField = bakeCloudField(seed),
): Clouds => {
  const geometry = new BoxGeometry(
    CLOUD_EXTENT * 2,
    CLOUD_EXTENT * 2,
    CLOUD_EXTENT * 2,
  );
  const material = new CloudMaterial(
    shapeTexture(field.shape),
    weatherTexture(field.weather),
  );
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  return {
    material,
    update(camera, state) {
      material.time = state.elapsed;
      material.drift = driftAt(state.elapsed);
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
