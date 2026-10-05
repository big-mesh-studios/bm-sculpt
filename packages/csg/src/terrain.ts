/**
 * A seeded height field: the infinite world the operations are carved out of.
 *
 * The model is `fold(operations, p, terrain(p))` (ADR 0004), and this file supplies the
 * `terrain` for a world that has one. It is a `BaseField` and nothing else touches it —
 * adding a landscape is this module plus a `ModelMessage` that says so, and no change to
 * the CSG arithmetic, the mesher or the picker. That is the property the whole of ADR 0002
 * is buying, and it is worth knowing that it is being bought: the terrain is not a special
 * case anywhere, it is a function.
 *
 * ## A height field is not a distance function
 *
 * The surface at `(x, z)` is at `height(x, z)`, so the obvious field is
 *
 *     distance(x, y, z) = y - height(x, z)
 *
 * which is negative below the surface and positive above, and is *exactly* the vertical
 * distance. It is not the distance to the surface. Its gradient is `(-∂h/∂x, 1, -∂h/∂z)`,
 * whose magnitude is `sqrt(1 + |∇h|²)`, so on a slope it **over-reports**: it claims a
 * surface further away than it is, and by a factor that grows with the slope.
 *
 * For a mesher that is harmless — it reads signs and interpolates, and never steps. For the
 * sphere-tracing picker it is fatal, because the picker steps by what it is told and a step
 * that is too long steps *through* the surface and off the far side. So every distance is
 * scaled by `lipschitz` below, which is the reciprocal of that gradient bound, and
 * `FieldOptions.lipschitz` is the property that carries it. This is the first consumer of
 * that option and the reason it exists.
 *
 * ## The bound, and why it is loose on purpose
 *
 * The surface is a base fBm plus a ridged term confined by a mask:
 *
 *     h = origin + scale · ( base + R · ridge · mask )
 *     base  = fbm(x/F,  z/F,  octaves)
 *     ridge = max(0, 1 - |fbm(x/Fm, z/Fm, octaves)|)   in [0, 1]
 *     mask  = clamp01(0.5 + 0.5 · fbm(x/Fk, z/Fk, maskOctaves))  in [0, 1]
 *
 * With the usual fBm — amplitude halved and frequency doubled per octave — each octave
 * contributes the *same* gradient, because `0.5^i · 2^i = 1`. A single axis is therefore
 * bounded by the sum of the parts' gradients:
 *
 *     d(base)/dx  ≤ octaves · G / F
 *     d(ridge)/dx ≤ octaves · G / Fm
 *     d(mask)/dx  ≤ maskOctaves · G / Fk
 *     |∂h/∂x|     ≤ scale · ( d(base) + R · (d(ridge)·mask + ridge·d(mask)) )
 *                 ≤ scale · ( octaves·G/F + R · (octaves·G/Fm + maskOctaves·G/Fk) )
 *
 * where `G` bounds `|∂noise/∂u|` and the products are bounded because `ridge` and `mask`
 * are in `[0, 1]`. Bounding the two axes separately and combining gives
 *
 *     |∇h| ≤ √2 · A   and so   lipschitz = 1 / sqrt(1 + 2A²)
 *
 * with `A` the per-axis bound above. `G` is `NOISE_GRADIENT_BOUND` below, and it is
 * deliberately pessimistic: it is the worst case of a corner gradient difference times the
 * peak of the quintic's derivative, and the two corner gradients are chosen by independent
 * hashes, so nothing rules that combination out. Being wrong in the pessimistic direction
 * costs the picker a few more steps. Being wrong the other way costs it the surface.
 *
 * A consequence worth stating plainly, because it looks alarming and is not: with default
 * parameters `lipschitz` lands near 0.2, so the picker takes roughly five times as many
 * steps as it would over operations alone. It still converges — the step shrinks
 * geometrically near a surface, so a ray crossing a thousand units of air costs on the
 * order of forty steps — and `maxSteps` is 512.
 *
 * ## Why the surface extent is global rather than sampled
 *
 * `couldHoldSurface` is the mesher's first gate, and it is answered here in constant time
 * from the extremes of the height range. The tempting refinement is to sample the noise
 * across the box and tighten the answer, and it is not worth doing: the margin such a bound
 * needs is `L · spacing`, and with `L` near 9 and a 320-unit chunk that margin exceeds the
 * chunk. It would cost samples and change nothing. The global range is the answer that is
 * both cheap and actually tight enough to skip air and deep rock.
 */

import type { Bounds } from "@big-mesh-studios/core";
import type { BaseField, SurfaceExtent } from "./field";

/**
 * World units per noise cell, horizontally, for the rolling base.
 *
 * The vertical character of a landscape is the `scale` in `TerrainParams`; this is the
 * horizontal one, and the message block has no field for it, so it lives here. Sized against
 * the chunk: `BLOCK_WORLD` is 320, so this puts roughly two and a half features across a
 * chunk and about six across the default streaming window.
 */
export const TERRAIN_FEATURE = 768;

/**
 * World units per ridge noise cell, horizontally.
 *
 * Larger than `TERRAIN_FEATURE`, so a mountain is a bigger feature than a hill. Ridged
 * noise — `1 - |fbm|` — turns the smooth fBm's extrema into sharp crests, which is what
 * makes a slope read as a mountain rather than as a dune.
 */
export const MOUNTAIN_FEATURE = 1600;

/**
 * World units per mask noise cell. The mask decides *where* mountains stand, so it is the
 * coarsest of the three: a range several features wide, with plains between.
 */
export const MOUNTAIN_MASK_FEATURE = 2600;

/** Octaves in the mask. Two is enough for a smooth continent-scale decision. */
export const MOUNTAIN_MASK_OCTAVES = 2;

/**
 * How far a range stands above the plain, in units of the base noise's own range.
 *
 * The base contributes `scale * base` with `base` in `[-1, 1]`; a range contributes
 * `RIDGE_STRENGTH * scale * ridge * range` with `ridge` and `range` both in `[-1, 1]`. The
 * height range therefore grows by `RIDGE_STRENGTH * scale`, which `reach` accounts for.
 *
 * **Six, so a range is three times what the plain's own relief is deep** — and this was two,
 * which put a mountain up out of a hill rather than a mountain range above a landscape.
 *
 * **The term is signed, and that is the part that makes the sea exist at all.** It used to be
 * `ridge * mask` with `mask` in `[0, 1]`, which is non-negative everywhere: the landscape was
 * lifted on average and never lowered, so its mean sat *above* the sea level and a sea at zero
 * barely met the ground. Measured on a default planet: one direction in four thousand was
 * underwater. `range * (2 * mask - 1)` is the same mask with its mean taken out, so a range
 * rises where the mask says one stands and the ground falls away where it does not — which is
 * also the plain the ranges stand amongst, and is what puts real coastline on the planet.
 */
export const RIDGE_STRENGTH = 6;

/**
 * Keeps a value inside `[-1, 1]`, which is what the signed range mask's bound needs.
 *
 * **Clamped rather than scaled**, so `landscapeShape`'s `RIDGE_STRENGTH · ridge · range` is
 * bounded by `RIDGE_STRENGTH` and the `reach` below is a real bound rather than an estimate.
 * `FBM_AMPLITUDE_BOUND` is deliberately generous — being too small would let
 * `couldHoldSurface` skip a chunk that has surface in it — so the two halves of that bound are
 * not the same number and need not be.
 */
const clamp11 = (value: number): number =>
  value < -1 ? -1 : value > 1 ? 1 : value;

/**
 * The three noise terms every landscape in this project is built from, in one place.
 *
 * ## Why they are together
 *
 * `terrain.ts` and `planet.ts` are the same landscape read through two parameterisations — a
 * height field and a sphere — and they were written out twice. The duplication was harmless
 * until it was not: this is the third change to the composition, and it would have been the
 * third change to write in two places.
 *
 * ## The shape, and what each term is for
 *
 *     shape = base + RIDGE_STRENGTH · ridge · range
 *
 * - **`base`** — rolling fBm at `TERRAIN_FEATURE`, the landscape's own relief, in `[-1, 1]`.
 * - **`ridge`** — `max(0, 1 − |fbm|)` at `MOUNTAIN_FEATURE`, which peaks where the noise crosses
 *   zero. Ridged, so a mountain reads as a crest rather than a dune.
 * - **`range`** — the mask at `MOUNTAIN_MASK_FEATURE`, **re-centred to `[-1, 1]`**. Positive where
 *   a range stands and negative where it does not, so the term has no mean: that is what lets a
 *   sea at the landscape's zero cut the world rather than miss it, and what leaves flat ground
 *   between the ranges rather than only where the mask is exactly half.
 *
 * ## The mean is the whole claim
 *
 * **The mask was `0.5 + 0.5 · fbm` in `[0, 1]` and read as "how much mountain goes here"**, which
 * is a good way to write it and a bad way to build a coastline from: a non-negative term has a
 * positive mean, so the whole surface sat above the sea and a sea at the landscape's zero
 * barely met the ground. Measured on the default planet: one direction in four thousand was
 * underwater, which is a puddle in the noise's troughs rather than an ocean. Subtracting the
 * `0.5` costs nothing, and it is what puts real coastline on the planet.
 *
 * @param fbm the caller's own noise, addressed by **feature size** rather than by coordinates,
 *   because a height field divides world coordinates by the feature and a sphere scales a
 *   direction by it — the same three features, read two ways.
 */
export const landscapeShape = (
  fbm: (feature: number, octaves?: number) => number,
): number => {
  const base = fbm(TERRAIN_FEATURE);
  const ridge = Math.max(0, 1 - Math.abs(fbm(MOUNTAIN_FEATURE)));
  const range = clamp11(fbm(MOUNTAIN_MASK_FEATURE, MOUNTAIN_MASK_OCTAVES));
  return base + RIDGE_STRENGTH * ridge * range;
};

/**
 * A bound on `|∂noise/∂u|` for the interpolation below.
 *
 * Derived rather than measured, because a measured maximum is not a bound. A corner
 * gradient is `±x ± z` with `x, z` reduced into a lattice cell, so it is bounded by 2, two
 * independent corners therefore differ by at most 4, and the quintic's derivative peaks at
 * `30/16 = 1.875`. Multiplying gives 7.5, and the interpolated derivative is a convex
 * combination of the corner derivatives, so it cannot exceed it.
 */
export const NOISE_GRADIENT_BOUND = 7.5;

/**
 * A bound on the amplitude of the normalised fBm below.
 *
 * The normalisation divides by the sum of amplitudes, so the result is a weighted average
 * of octave values; each octave value is bounded by the corner gradient bound of 2, so the
 * average is too. Used for the height range, where being too small would let
 * `couldHoldSurface` skip a chunk that has surface in it — the one failure this whole
 * module cannot be allowed to make.
 */
export const FBM_AMPLITUDE_BOUND = 2;

/** The parameters a terrain is built from, and the four a `ModelMessage` carries. */
export interface TerrainParams {
  /** The world y a height of zero sits at. */
  readonly origin: number;
  /** World units per unit of noise output — the vertical scale of the landscape. */
  readonly scale: number;
  readonly octaves: number;
  readonly seed: number;
}

/**
 * A height field, as the CSG sees it and as the mesher asks it questions.
 *
 * Callable because `BaseField` is a function type and the field's arithmetic is written
 * against that; the extra members are the questions only terrain can answer.
 */
export interface TerrainField extends BaseField, SurfaceExtent {
  /** The factor every reported distance is scaled by. See the file header. */
  readonly lipschitz: number;
  /** Where this landscape's water settles: `origin`, the altitude its height of zero sits at. */
  readonly seaLevel: number;
  /** The surface height at a column, in world units. */
  heightAt(x: number, z: number): number;
  /** The lowest the surface can be anywhere in the world. */
  readonly lowest: number;
  /** The highest the surface can be anywhere in the world. */
  readonly highest: number;
}

/** Landscape parameters chosen to sit the starter model in rolling ground rather than on a plain. */
export const DEFAULT_TERRAIN: TerrainParams = {
  origin: -70,
  scale: 96,
  octaves: 4,
  seed: 20260901,
};

/**
 * Seeded 2D gradient noise over a 256-entry permutation table.
 *
 * The classic construction, and the one the sibling project uses for its terrain, so a
 * landscape here looks like a landscape there. One thing is deliberately *not* carried
 * over: the table is shuffled with a 32-bit LCG through `Math.imul`, where the obvious
 * `n * 1103515245` overflows the mantissa at these magnitudes and quietly loses bits. It is
 * still deterministic either way, so the difference is invisible until two runs disagree.
 */
export class PerlinNoise2D {
  /** Doubled, so an index of `255 + 255` is in range without a modulo. */
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) table[i] = i;

    // `>>> 0` to keep the multiply in 32-bit unsigned, `Math.imul` to keep it exact, and
    // `& 0x7fffffff` to leave a non-negative state. All three are needed: skip the first
    // and the sign of the state depends on the seed's sign, which is a difference nobody
    // would notice until a negative seed produced a different world.
    let n = seed | 0;
    for (let i = 255; i > 0; i--) {
      n = (Math.imul(n, 1103515245) + 12345) & 0x7fffffff;
      const j = n % (i + 1);
      const swap = table[i];
      table[i] = table[j];
      table[j] = swap;
    }

    for (let i = 0; i < 512; i++) this.perm[i] = table[i & 255];
  }

  /** The quintic smootherstep: zero first *and* second derivative at each lattice point. */
  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private static lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
  }

  /** One of four diagonal gradients, chosen by two bits of the hash. */
  private grad(hash: number, x: number, z: number): number {
    const h = hash & 3;
    const u = h < 2 ? x : z;
    const v = h < 2 ? z : x;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  }

  /** Noise at a point, in roughly [-1, 1]. */
  noise(x: number, z: number): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = PerlinNoise2D.fade(xf);
    const v = PerlinNoise2D.fade(zf);

    // Masked, so a point far from the origin hashes the same lattice corner as the
    // equivalent point near it. Without it the landscape is only defined within ±256 cells
    // and the world visibly repeats or tears past that.
    const X = xi & 255;
    const Z = zi & 255;
    const A = this.perm[X] + Z;
    const B = this.perm[X + 1] + Z;

    return PerlinNoise2D.lerp(
      PerlinNoise2D.lerp(
        this.grad(this.perm[A], xf, zf),
        this.grad(this.perm[B], xf - 1, zf),
        u,
      ),
      PerlinNoise2D.lerp(
        this.grad(this.perm[A + 1], xf, zf - 1),
        this.grad(this.perm[B + 1], xf - 1, zf - 1),
        u,
      ),
      v,
    );
  }

  /**
   * Summed octaves, amplitude halved and frequency doubled, normalised to the sum.
   *
   * Normalised rather than merely summed so the output range does not depend on the octave
   * count, which is what lets `FBM_AMPLITUDE_BOUND` be a constant.
   */
  fbm(x: number, z: number, octaves: number): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise(x * frequency, z * frequency);
      total += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return total === 0 ? 0 : value / total;
  }
}

/**
 * Builds a terrain from its parameters.
 *
 * Pure and deterministic in the parameters alone — no module-level cache, unlike the
 * sibling project's — because here a field is built once per worker per model and held for
 * the life of that model, so there is nothing to amortise and a shared cache would only be
 * a way for two models to share a permutation table by accident.
 */
export const terrainField = (params: TerrainParams): TerrainField => {
  const noise = new PerlinNoise2D(params.seed);
  // At least one octave: zero would make `fbm` return zero, a flat world at `origin`, which
  // is a legitimate landscape but is more likely a mistake in a caller.
  const octaves = Math.max(1, Math.floor(params.octaves));
  const scale = params.scale;
  const origin = params.origin;

  const heightAt = (x: number, z: number): number => {
    // **The three terms, from `landscapeShape`** — the same function a planet builds its
    // radius from, so a height field and a sphere are the same landscape rather than two
    // landscapes that agree by coincidence. The addressing differs: a height field divides
    // world coordinates by the feature, where a sphere scales a direction by it.
    const shape = landscapeShape((feature, featureOctaves = octaves) =>
      noise.fbm(x / feature, z / feature, featureOctaves),
    );
    return origin + scale * shape;
  };

  // The base is in `[-R, +R]` and the range term in `[-RIDGE_STRENGTH, +RIDGE_STRENGTH]`,
  // because it is signed — see `landscapeShape` and `RIDGE_STRENGTH`. The reach is the larger
  // magnitude, used symmetrically because the gate only needs a band that contains the surface.
  const reach = (FBM_AMPLITUDE_BOUND + RIDGE_STRENGTH) * Math.abs(scale);
  const lowest = origin - reach;
  const highest = origin + reach;

  // `A` is the per-axis bound on the height's gradient; see the file header for where each
  // factor comes from. The √2 combines two axes bounded separately, and the `1` under the
  // square root is the vertical term of the distance function's own gradient.
  const gradientPerAxis =
    octaves * NOISE_GRADIENT_BOUND * (1 / TERRAIN_FEATURE) +
    RIDGE_STRENGTH *
      (octaves * NOISE_GRADIENT_BOUND * (1 / MOUNTAIN_FEATURE) +
        MOUNTAIN_MASK_OCTAVES *
          NOISE_GRADIENT_BOUND *
          (1 / MOUNTAIN_MASK_FEATURE));
  const perAxis = Math.abs(scale) * gradientPerAxis;
  const lipschitz = 1 / Math.sqrt(1 + 2 * perAxis * perAxis);

  const distance = (x: number, y: number, z: number): number =>
    y - heightAt(x, z);

  return Object.assign(distance, {
    lipschitz,
    /**
     * `origin`, because on a height field a sea is an altitude and the altitude a height of zero
     * sits at is the one a sea covers where the base noise is negative. See
     * `BuiltBaseField.seaLevel`.
     */
    seaLevel: origin,
    heightAt,
    lowest,
    highest,
    /**
     * A box entirely above the highest possible surface is all air; one entirely below the
     * lowest is all solid. Both hold no sign change, and both are answered from two
     * comparisons — no noise evaluated at all, which is the entire point of the gate.
     *
     * The comparisons are strict, so a box whose face lands exactly on the extreme is
     * *not* ruled out: that face is the surface, and skipping it would drop a surface on
     * the seam with nothing to re-mesh it.
     */
    couldHoldSurface: (bounds: Bounds): boolean =>
      bounds.min.y <= highest && bounds.max.y >= lowest,
  });
};
