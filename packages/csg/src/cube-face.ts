/**
 * The cube-to-sphere direction map.
 *
 * Six faces, each parameterised by `(u, v) ∈ [-1, 1]²`, each mapped to a unit direction by
 * the spherified-cube warp. This is the map that replaces the cubic chunk lattice: a cell on
 * this world is a **patch of a cube face**, so every cell is on the surface and the streaming
 * budget buys distance instead of rock.
 *
 * It began as a phase-0 spike kept in `scratch`, where the lattice was chosen instead and this
 * file was measured only to settle the noise-domain question. The measurement is what promoted
 * it: the map **is** continuous as a map to a direction, while the six face parameterisations
 * disagree about what `(u, v)` means across an edge — which is exactly why the noise has to be
 * addressed by direction and never by `(u, v)`. See ADR 0038.
 *
 * ## The axis convention, and why it is written out rather than derived
 *
 * Each face is `(u, v)` mapped to a cube point with the face's axis carrying `±1`, the
 * first in-face axis carrying `-v` and the second carrying `-u`. The signs are not
 * arbitrary: they are what makes the parameterisation **continuous on the cube surface**.
 * Under this convention `+X` at `u = 1` and `-Z` at `u = -1` are the same cube point
 * `(1, -v, -1)` at the same `v`, and `+X` at `u = -1` and `+Z` at `u = 1` are the same cube
 * point `(1, -v, 1)` at the same `v`. `cube-face.test.ts` checks all twelve edges and all
 * eight corners, because those twelve edges are the only places this map can be discontinuous
 * and a seam at any of them is a seam in the finished planet.
 *
 * ## The warp, and why not just normalise
 *
 * Normalising the cube point makes a sphere, and bunches its vertices into the corners
 * where three faces meet while leaving the face centres sparse. A patch lattice inherits
 * that unevenness and so does every level of detail chosen from it — a patch at a corner
 * covers far less of the sphere than a patch at a face centre of the same `(u, v)` extent,
 * so an unwarped lattice spends its finest detail where the surface is smallest. The warp
 * below pushes each axis out by a factor that depends only on that axis, which evens the
 * distribution while staying continuous and monotonic, so it cannot fold the map.
 */

import type { Vec3 } from "@big-mesh-studios/core";

/** The six cube faces, as `+axis` and the two in-face axes. */
export const FACE_POS_X = 0;
export const FACE_NEG_X = 1;
export const FACE_POS_Y = 2;
export const FACE_NEG_Y = 3;
export const FACE_POS_Z = 4;
export const FACE_NEG_Z = 5;

export const FACE_COUNT = 6;

/** A unit direction. The same type as any other direction in the codebase. */
export type Direction = Vec3;

const clampFace = (face: number): number =>
  face < 0 ? 0 : face > FACE_COUNT - 1 ? FACE_COUNT - 1 : Math.floor(face);

/**
 * The cube point a face parameter sits on, before the warp.
 *
 * Exposed because the warp is a pure function of this, and testing the two separately is
 * how a failure gets attributed: a discontinuity here is a convention error, and one in
 * `directionAt` is a warp error.
 */
export const cubePointAt = (face: number, u: number, v: number): Vec3 => {
  switch (clampFace(face)) {
    case FACE_POS_X:
      return { x: 1, y: -v, z: -u };
    case FACE_NEG_X:
      return { x: -1, y: -v, z: u };
    case FACE_POS_Y:
      return { x: u, y: 1, z: v };
    case FACE_NEG_Y:
      return { x: u, y: -1, z: -v };
    case FACE_POS_Z:
      return { x: u, y: -v, z: 1 };
    default:
      return { x: -u, y: -v, z: -1 };
  }
};

/**
 * The spherified-cube warp: one axis at a time, each pushed out by a factor that depends
 * only on that axis, so the map is continuous and monotonic in every coordinate.
 *
 * `x * sqrt(1 - y²/2 - z²/2 + y²z²/3)` and its two rotations. On the unit cube the
 * radicand is `1` at a face centre and `4/3` at a corner, which is where the evening
 * comes from: a face centre is left alone and a corner is pushed out far enough that the
 * arc lengths of neighbouring faces match.
 */
const warp = (x: number, y: number, z: number): Vec3 => ({
  x: x * Math.sqrt(1 - (y * y) / 2 - (z * z) / 2 + (y * y * z * z) / 3),
  y: y * Math.sqrt(1 - (z * z) / 2 - (x * x) / 2 + (z * z * x * x) / 3),
  z: z * Math.sqrt(1 - (x * x) / 2 - (y * y) / 2 + (x * x * y * y) / 3),
});

/**
 * The unit direction a face parameter names.
 *
 * Continuous in `(u, v)` and across face edges, because `cubePointAt` is continuous on the
 * cube surface and `warp` and the normalisation are continuous functions of it.
 */
export const directionAt = (face: number, u: number, v: number): Vec3 => {
  const c = cubePointAt(face, u, v);
  const w = warp(c.x, c.y, c.z);
  const length = Math.hypot(w.x, w.y, w.z) || 1;
  return { x: w.x / length, y: w.y / length, z: w.z / length };
};

/**
 * The face a direction belongs to, and its `(u, v)`.
 *
 * The face is the dominant axis, and the parameters are recovered by inverting the
 * convention above rather than by projecting: `u` and `v` are the cube coordinates, and the
 * warp is not its own inverse, so the returned `(u, v)` are the *cube* parameters. That is
 * enough to answer "which face and roughly where on it", which is all a patch address
 * needs; a patch that wanted to invert the warp exactly would have to solve it.
 */
export const faceOf = (d: Vec3): { face: number; u: number; v: number } => {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax >= ay && ax >= az) {
    return d.x >= 0
      ? { face: FACE_POS_X, u: -d.z, v: -d.y }
      : { face: FACE_NEG_X, u: d.z, v: -d.y };
  }
  if (ay >= az) {
    return d.y >= 0
      ? { face: FACE_POS_Y, u: d.x, v: d.z }
      : { face: FACE_NEG_Y, u: d.x, v: -d.z };
  }
  return d.z >= 0
    ? { face: FACE_POS_Z, u: d.x, v: -d.y }
    : { face: FACE_NEG_Z, u: -d.x, v: -d.y };
};
