/**
 * The two-dimensional noise domains this project considered and rejected.
 *
 * A **domain** is a way of naming the 2D noise argument from a direction. Every one of these
 * is a plausible design and none of them works, for the reason each states. They live in
 * their own file because `gate-1-noise-domain.test.ts` has to *measure* each of them, and a
 * domain that exists only as a rejected candidate has no business in the planet field.
 *
 * ## The requirement
 *
 * The field is `|p - c| - (R + scale·g)` where `g` is the landscape's shape. A domain that
 * is discontinuous makes `g` discontinuous, so the field **steps** and the mesher opens a
 * crack along the step. Two tests follow, and a candidate has to pass both:
 *
 * 1. **No step.** The height must not jump across the boundary.
 * 2. **No repetition and no collapse.** Different parts of the sphere must get different
 *    landscapes, and a single point must not swallow a neighbourhood.
 *
 * The second is not a restatement of the first. `cubeFaceDomain` below passes neither, the
 * dominant-axis domain passes the first and fails the second, and a single projection passes
 * the first and fails the second differently — so continuity alone would have been the wrong
 * thing to test.
 */

import {
  PerlinNoise2D,
  TERRAIN_FEATURE,
  FACE_COUNT,
  cubePointAt,
  type Direction,
} from "@big-mesh-studios/csg";

/**
 * A two-argument noise domain: a direction in, a noise argument out.
 *
 * The argument is exposed separately from the value because **collapse is a property of the
 * argument, not of the height**. A domain whose argument vanishes at a pole still hands out
 * heights that differ across that cap, because the noise gradient there is steep enough to
 * make a tiny argument range a visible height range — which is exactly what made a first
 * attempt at measuring collapse report "no collapse" for the two domains that collapse
 * hardest.
 */
export interface NoiseDomain {
  readonly name: string;
  /** The noise's argument at a direction. Three components for the 3D domain. */
  readonly argumentAt: (d: Direction) => readonly number[];
  /** The noise's value at a direction. */
  readonly at: (d: Direction) => number;
}

/** Keeps a direction on the unit sphere so every domain sees the same magnitude. */
export const unit = (d: Direction): Direction => {
  const length = Math.hypot(d.x, d.y, d.z) || 1;
  return { x: d.x / length, y: d.y / length, z: d.z / length };
};

/**
 * Six cube-face charts, addressed by `(face, u, v)`.
 *
 * Continuous as a map from a direction to `(face, u, v)` — the faces tile the cube surface
 * with no gap and no overlap — and therefore **not** continuous as a map back to a noise
 * argument, because the six parameterisations disagree about which coordinate is which
 * across an edge. `gate-1-noise-domain.test.ts` finds the disagreeing edges by search and
 * measures the step.
 */
export const cubeFaceDomain = (noise: PerlinNoise2D): NoiseDomain => {
  // Which face a direction falls on is its dominant axis, and the parameters come from
  // `faceOf`, which inverts the convention in `cube-face.ts`.
  const faceOf = (d: Direction): { face: number; u: number; v: number } => {
    const ax = Math.abs(d.x);
    const ay = Math.abs(d.y);
    const az = Math.abs(d.z);
    if (ax >= ay && ax >= az) {
      return d.x >= 0
        ? { face: 0, u: -d.z, v: -d.y }
        : { face: 1, u: d.z, v: -d.y };
    }
    if (ay >= az) {
      return d.y >= 0
        ? { face: 2, u: d.x, v: d.z }
        : { face: 3, u: d.x, v: -d.z };
    }
    return d.z >= 0
      ? { face: 4, u: d.x, v: -d.y }
      : { face: 5, u: -d.x, v: -d.y };
  };

  return {
    name: "cube-face (u, v)",
    argumentAt: (d) => {
      const f = faceOf(unit(d));
      return [f.u, f.v];
    },
    at: (d) => {
      const f = faceOf(unit(d));
      return noise.fbm(f.u, f.v, 4);
    },
  };
};

/**
 * Drop the dominant axis and use the other two.
 *
 * The obvious improvement on a single projection: continuous, since at the `x = y`
 * boundary the two branches `(n.y, n.z)` and `(n.x, n.z)` agree exactly, and unlike a single
 * projection it does not collapse at *both* poles. It has two other faults instead, and
 * both are worse than a crease:
 *
 * - **Repetition.** The argument is drawn from the same `[-1, 1]²` three times, once per
 *   dominant axis, so `(1,0,0)`, `(0,1,0)` and `(0,0,1)` all read `(0, 0)` and the same
 *   continent appears three times at right angles to itself.
 * - **A pinch at the poles.** The retained pair vanishes there, so the neighbourhood of
 *   every axis pole is one point of noise again — the failure a single projection has, just
 *   moved.
 */
export const dominantAxisDomain = (noise: PerlinNoise2D): NoiseDomain => {
  const argumentAt = (d: Direction): readonly number[] => {
    const n = unit(d);
    const ax = Math.abs(n.x);
    const ay = Math.abs(n.y);
    const az = Math.abs(n.z);
    if (ax >= ay && ax >= az) return [n.y, n.z];
    if (ay >= az) return [n.x, n.z];
    return [n.x, n.y];
  };
  return {
    name: "dominant axis dropped",
    argumentAt,
    at: (d) => {
      const a = argumentAt(d);
      return noise.fbm(a[0] as number, a[1] as number, 4);
    },
  };
};

/**
 * One projection: `(n.x, n.z)`.
 *
 * Continuous everywhere, and the collapse is total — the whole `y` axis, both poles and
 * every azimuth around them, is the single argument `(0, 0)`. Included because it is the
 * domain a person reaches for first and it is the worst of the three.
 */
export const singleProjectionDomain = (noise: PerlinNoise2D): NoiseDomain => {
  const argumentAt = (d: Direction): readonly number[] => {
    const n = unit(d);
    return [n.x, n.z];
  };
  return {
    name: "single projection (n.x, n.z)",
    argumentAt,
    at: (d) => {
      const a = argumentAt(d);
      return noise.fbm(a[0] as number, a[1] as number, 4);
    },
  };
};

/**
 * Three-dimensional noise of the direction.
 *
 * The only one that passes both tests, and the reason is not subtle: it needs no chart. A
 * 2D domain has to name a sphere with two numbers, which cannot be done continuously, so
 * every 2D domain pays somewhere. Three dimensions does not pay anywhere.
 *
 * The face count is imported only so the import above is not mistaken for the chart this
 * domain needs.
 */
export const noise3Domain = (
  scale: number,
  at: (d: Direction) => number,
): NoiseDomain => ({
  name: "3D noise",
  argumentAt: (d) => {
    const n = unit(d);
    return [n.x * scale, n.y * scale, n.z * scale];
  },
  at: (d) => at(unit(d)),
});

export { FACE_COUNT, cubePointAt, TERRAIN_FEATURE };
