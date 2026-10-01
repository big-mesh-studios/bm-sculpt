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
 * With `h = origin + scale · fbm(x/F, z/F, octaves)` and the usual fBm — amplitude halved
 * and frequency doubled per octave — each octave contributes the *same* gradient, because
 * `0.5^i · 2^i = 1`. So a single axis obeys
 *
 *     |∂h/∂x| ≤ octaves · G · scale / F
 *
 * where `G` bounds `|∂noise/∂u|`. Bounding the two axes separately and combining gives
 *
 *     |∇h| ≤ √2 · octaves · G · scale / F   and so   lipschitz = 1 / sqrt(1 + 2A²)
 *
 * with `A = octaves · G · scale / F`. `G` is `NOISE_GRADIENT_BOUND` below, and it is
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

import type { Bounds } from "../constants";
import type { BaseField, SurfaceExtent } from "./field";

/**
 * World units per noise cell, horizontally.
 *
 * The vertical character of a landscape is the `scale` in `TerrainParams`; this is the
 * horizontal one, and the message block has no field for it, so it lives here. Sized against
 * the chunk: `BLOCK_WORLD` is 320, so this puts roughly two and a half features across a
 * chunk and about six across the default streaming window — rolling hills rather than
 * mountains, which is the right register for something a sculptor is carving into.
 */
export const TERRAIN_FEATURE = 768;

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

  const heightAt = (x: number, z: number): number =>
    origin +
    scale * noise.fbm(x / TERRAIN_FEATURE, z / TERRAIN_FEATURE, octaves);

  const reach = FBM_AMPLITUDE_BOUND * Math.abs(scale);
  const lowest = origin - reach;
  const highest = origin + reach;

  // `A` is the per-axis bound on the height's gradient; see the file header for where each
  // factor comes from. The √2 combines two axes bounded separately, and the `1` under the
  // square root is the vertical term of the distance function's own gradient.
  const perAxis =
    octaves * NOISE_GRADIENT_BOUND * (Math.abs(scale) / TERRAIN_FEATURE);
  const lipschitz = 1 / Math.sqrt(1 + 2 * perAxis * perAxis);

  const distance = (x: number, y: number, z: number): number =>
    y - heightAt(x, z);

  return Object.assign(distance, {
    lipschitz,
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
