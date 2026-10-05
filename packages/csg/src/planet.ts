/**
 * A planet: the same landscape, folded onto a sphere.
 *
 * The field is
 *
 *     f(p) = |p| - (R + scale·g(n̂))
 *
 * with `n̂ = p / |p|` and `g` the 3D fBm from `perlin3.ts`. It is a drop-in for `terrainField`:
 * it satisfies `BaseField` by being a function of position and `SurfaceExtent` by answering
 * `couldHoldSurface`, and **nothing else in the engine knows which one it has.** That is the
 * property ADR 0004 has been buying since the landscape was a plane, and this is the first change
 * that spends it — the CSG fold, the operation BVH, the mesher, the picker and the worker
 * boundary are all untouched.
 *
 * ## The property that makes this easier than it looks
 *
 * **`n̂` does not change along a ray from the planet's centre.** So `f` restricted to any such ray
 * is `r - (R + scale·g)`: a perfect radial height field, one per direction, with no slope term
 * in the radial direction at all. Three things follow, and they are what the rest of this file is
 * built on.
 *
 * **The surface is a star-shaped radial graph**, so a ray from inside the planet meets it exactly
 * once on the way out, and sphere-tracing it is well behaved.
 *
 * **`∂f/∂r = 1` exactly.** The gradient is `n̂ - (scale/r)·P·∇g`, where `P = I - n̂n̂ᵀ` projects out
 * the radial component, so `n̂·∇f = 1` and the tangential correction is perpendicular to it:
 *
 *     |∇f|² = 1 + (scale/r)² · |P ∇g|²
 *
 * **And `r` cancels out of the Lipschitz bound**, because `S` is chosen to make one noise cell
 * `TERRAIN_FEATURE` world units across at the nominal radius. `(scale/r)·S = scale/TERRAIN_FEATURE`,
 * so the bound keeps the height field's own shape with `3` where it had `2` — three noise axes
 * rather than two — and nothing else changes.
 *
 * ## What is different from the height field, and why it is not worse
 *
 * - **The noise is three-dimensional.** Not for accuracy: for continuity. `perlin3.ts`'s header
 *   has the measurements.
 * - **The surface extent is a band of radii, not a range of heights.** `lowestRadius` and
 *   `highestRadius` replace `lowest` and `highest`, and `couldHoldSurface` answers from the exact
 *   minimum and maximum radius over a box — a distance-to-AABB and eight corners, which is the
 *   same cost class as the height field's two comparisons.
 * - **The bound is about as loose as the height field's.** `planet.test.ts` measures both.
 *
 * ## The planet is centred on the origin, deliberately
 *
 * **Because the chunk lattice is.** `chunkCellOf` is a per-axis floor around the world origin, and
 * a lattice re-centred on the planet would have to be rebuilt to put a planet anywhere else. The
 * alternative — a `centre` parameter — is one more thing that can disagree with the lattice, and
 * the win from being able to put a planet off-origin is not worth it until something asks for one.
 * See ADR 0036.
 */

import type { Bounds, Vec3 } from "@big-mesh-studios/core";
import type { BaseField, SurfaceExtent } from "./field";
import {
  landscapeShape,
  MOUNTAIN_FEATURE,
  MOUNTAIN_MASK_FEATURE,
  MOUNTAIN_MASK_OCTAVES,
  RIDGE_STRENGTH,
  TERRAIN_FEATURE,
} from "./terrain";
import {
  FBM_AMPLITUDE_BOUND_3D,
  NOISE_GRADIENT_BOUND_3D,
  PerlinNoise3D,
} from "./perlin3";

/**
 * How far this planet's surface reaches either side of its sea level, in world units.
 *
 * **The same number `planetField` derives, without building the field**, because the things
 * that have to sit above the landscape's relief are altitudes rather than fields: where the
 * globe starts fading in, and where the cloud layer's floor is. A caller that had to build a
 * 256-entry permutation table to learn how tall the mountains are would be doing arithmetic to
 * get a number the arithmetic already had.
 *
 * Exported rather than left inside `planetField` because this is the third thing in the
 * application to need it and the first two hardcoded it — and hardcoding it is how a mountain
 * range ends up standing inside the cloud layer.
 */
export const reachOf = (params: PlanetParams): number =>
  (FBM_AMPLITUDE_BOUND_3D + RIDGE_STRENGTH) * Math.abs(params.scale);

/** The parameters a planet is built from, and the four a `ModelMessage` carries. */
export interface PlanetParams {
  /**
   * The distance from the origin to mean sea level.
   *
   * **This is the one number that sets the game's scale.** At 136,000 the planet is 272,000 units
   * across, the circumference is about 854,513, and a player walking at 60 units a second takes
   * about four hours to go all the way round — which is the number that decides whether a planet
   * feels like a place or like a texture.
   *
   * It is also what sets the horizon: `√(2·R·h)`, so at the player's six-unit eye height the ground
   * is visible for about 1,280 units before it curves away. The previous 4,000-unit radius gave a
   * 219-unit horizon, less than one terrain feature, which is why it was raised.
   *
   * It is also the precision budget. `float32` resolves about `R / 16.7 million`, so a surface at
   * 136,000 leaves about eight thousandths of a unit, and float32 is not a thing anyone has to think
   * about; at six million — Earth's radius in these units — the same arithmetic leaves a third of a
   * unit, and everything has to move to double-precision world state.
   */
  readonly radius: number;
  /** World units per unit of noise output — the vertical scale of the landscape. */
  readonly scale: number;
  readonly octaves: number;
  readonly seed: number;
}

/**
 * The radius this project's planet uses, and the numbers around it.
 *
 * **`scale` and `octaves` are `terrainField`'s, unchanged**, so a planet's mountains are the same
 * mountains at the same size. Only the radius is new, and only because there had never been one.
 * `seed` is the landscape's own, for the same reason the world looks the world.
 */
export const DEFAULT_PLANET: PlanetParams = {
  radius: 136000,
  scale: 96,
  octaves: 4,
  seed: 20260901,
};

/** A planet, as the CSG sees it and as the mesher asks it questions. */
export interface PlanetField extends BaseField, SurfaceExtent {
  /** The factor every reported distance is scaled by. See the file header. */
  readonly lipschitz: number;
  /** Where this planet's water settles: `radius`, which is its mean sea level. */
  readonly seaLevel: number;
  /** The surface's radius in a direction, in world units. */
  radiusAt(direction: Vec3): number;
  /** The radius of the surface's highest point anywhere. */
  readonly highestRadius: number;
  /** The radius of the surface's lowest point anywhere. */
  readonly lowestRadius: number;
}

/**
 * The smallest and largest distance from `centre` to an axis-aligned box.
 *
 * **Exported because `planet.test.ts` needs it and nothing else should.** The minimum is the
 * distance from the point to the box — zero when the point is inside it — and the maximum is the
 * largest of the eight corners, which is exact for a box because the radius is convex.
 */
export const radiusRangeOf = (bounds: Bounds): readonly [number, number] => {
  let min = 0;
  for (const axis of ["x", "y", "z"] as const) {
    const lo = bounds.min[axis];
    const hi = bounds.max[axis];
    // The origin is the only point that matters, so this is a distance from a point to a slab.
    if (lo > 0) min += lo * lo;
    else if (hi < 0) min += hi * hi;
  }
  min = Math.sqrt(min);

  let max = 0;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? bounds.max.x : bounds.min.x;
    const y = corner & 2 ? bounds.max.y : bounds.min.y;
    const z = corner & 4 ? bounds.max.z : bounds.min.z;
    max = Math.max(max, Math.sqrt(x * x + y * y + z * z));
  }
  return [min, max];
};

/**
 * Builds a planet from its parameters.
 *
 * Pure and deterministic in the parameters alone, for the same reason `terrainField` is: a field is
 * built once per worker per model and held for that model's life, so there is nothing to amortise
 * and a shared cache would only be a way for two models to share a permutation table by accident.
 */
export const planetField = (params: PlanetParams): PlanetField => {
  const noise = new PerlinNoise3D(params.seed);
  // At least one octave: zero would make `fbm` return zero, a featureless ball at `radius`, which
  // is a legitimate planet but is more likely a mistake in a caller.
  const octaves = Math.max(1, Math.floor(params.octaves));
  const scale = params.scale;
  const radius = params.radius;
  // One noise cell is `TERRAIN_FEATURE` world units across at the nominal radius, which is what
  // makes the Lipschitz bound's `r` cancel. See the file header.
  const S = radius / TERRAIN_FEATURE;

  /**
   * One fBm octave set over the direction, for a feature `feature` world units across.
   *
   * `S` is the argument scale that makes a feature `TERRAIN_FEATURE` units across at the nominal
   * radius, so dividing it by the ratio of the two feature sizes gives the scale for this one.
   */
  const fbmAt = (n: Vec3, feature: number, count = octaves): number => {
    const k = S * (TERRAIN_FEATURE / feature);
    return noise.fbm(n.x * k, n.y * k, n.z * k, count);
  };

  /**
   * The landscape's shape in a direction, in roughly `[-7, 7]`.
   *
   * **`landscapeShape`, called with a planet's own addressing** — the same three features and the
   * same three terms a height field uses, on 3D noise rather than 2D. Reusing them is why a
   * planet's mountains are this project's mountains; the alternative, a separate planetary noise
   * tuned to look right on its own, would have produced a world nothing else in the repository
   * recognised.
   */
  const shapeAt = (n: Vec3): number =>
    landscapeShape((feature, featureOctaves = octaves) =>
      fbmAt(n, feature, featureOctaves),
    );

  const radiusAt = (direction: Vec3): number =>
    radius + scale * shapeAt(direction);

  // The base is in `[-1, +1]` and the signed range term in `[-RIDGE_STRENGTH, +RIDGE_STRENGTH]` —
  // see `landscapeShape`. The reach is the larger magnitude, used symmetrically because the gate
  // only needs a band that contains the surface. `terrain.ts` derives the same shape with
  // `FBM_AMPLITUDE_BOUND` of 2; the 3D gradient set reaches 1 along an axis, so the base's is 1.
  const reach = reachOf(params);
  const lowestRadius = radius - reach;
  const highestRadius = radius + reach;

  // `A` is the per-axis bound on the shape's gradient, in the same form `terrain.ts` derives and
  // for the same reasons — see that file's header for where each factor comes from. The three
  // rather than the two is three noise axes; the `r` that would otherwise appear does not, which
  // is the property the file header is about.
  const gradientPerAxis =
    (octaves * NOISE_GRADIENT_BOUND_3D) / TERRAIN_FEATURE +
    RIDGE_STRENGTH *
      ((octaves * NOISE_GRADIENT_BOUND_3D) / MOUNTAIN_FEATURE +
        (MOUNTAIN_MASK_OCTAVES * NOISE_GRADIENT_BOUND_3D) /
          MOUNTAIN_MASK_FEATURE);
  const perAxis = Math.abs(scale) * gradientPerAxis;
  const lipschitz = 1 / Math.sqrt(1 + 3 * perAxis * perAxis);

  const distance = (x: number, y: number, z: number): number => {
    const r = Math.sqrt(x * x + y * y + z * z);
    // The exact origin has no direction. It is deep inside the planet and reports itself as
    // solid, which is the only answer there is — and `normalize` of the zero vector would put a
    // `NaN` in every sample that reached it.
    if (r < 1e-9) return -reach;
    const inv = 1 / r;
    return r - radiusAt({ x: x * inv, y: y * inv, z: z * inv });
  };

  return Object.assign(distance, {
    lipschitz,
    /**
     * `radius`, because `radiusAt` is `radius + scale · shape` and a shape of zero happens at the
     * radius — so the radius is where the noise's own zero is, which is what a sea at a given
     * altitude covers. See `BuiltBaseField.seaLevel`, and this file's `PlanetParams.radius`.
     */
    seaLevel: radius,
    radiusAt,
    lowestRadius,
    highestRadius,
    /**
     * A box entirely inside the planet or entirely outside it holds no sign change, and both are
     * answered from the box's own radius range — two distances and eight corners, no noise
     * evaluated at all, which is the entire point of the gate.
     *
     * The comparisons are strict, for the height field's reason and with its force: a box whose
     * corner lands exactly on an extreme is *not* ruled out, because that face is the surface, and
     * skipping it would drop a surface on the seam with nothing to re-mesh it.
     */
    couldHoldSurface: (bounds: Bounds): boolean => {
      const [min, max] = radiusRangeOf(bounds);
      return min <= highestRadius && max >= lowestRadius;
    },
  });
};
