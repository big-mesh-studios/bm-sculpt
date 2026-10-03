/**
 * Octahedral normal encoding: a unit vector in three components becomes two.
 *
 * Surface nets normals are arbitrary — no axis-aligned face index names them, so
 * the trick a voxel mesher uses of storing a face index and rebuilding the
 * normal from it does not apply. Two signed 16-bit channels carry the pair in
 * the same four bytes an `unorm8x4` would have used, and the decode is a handful
 * of arithmetic operations with no branch and no lookup table.
 *
 * The encoding folds the sphere onto the octahedron by dividing the vector by
 * its Manhattan length, which is a bijection from the unit sphere onto the
 * square [-1, 1]², and folds the lower hemisphere back over the upper by
 * mirroring across the diagonal. The decode is the same fold in reverse: build
 * a vector whose z is whatever is left of the unit sphere's height budget, then
 * — when that came out negative, meaning the point was in the lower hemisphere —
 * mirror x and y back out and take the height as what remains.
 *
 * The arithmetic here is written twice on purpose. This file is the copy that
 * can be tested without a graphics device; `octahedralNode` in
 * `src/render/spike-material.ts` is the copy the shader runs. Having both is the
 * only way to notice when they drift apart, and `octahedral.test.ts` checks
 * them against each other.
 */

import type { Vec3 } from "./constants";

export type { Vec3 };

/** A point in the square [-1, 1]², which is where a unit vector is folded to. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * The signed 16-bit channels a `snorm16x2` attribute stores, which is the form
 * the value reaches the shader in: whole numbers scaling -1 to 32767.
 */
export const SNORM16_MAX = 32767;

/** Folds a unit vector onto the octahedron, into [-1, 1]². */
export const encodeOctahedral = (n: Vec3): Vec2 => {
  const l1 = Math.abs(n.x) + Math.abs(n.y) + Math.abs(n.z);
  // A zero vector has no direction to fold. Encoding it as the +Z pole means it
  // decodes to something rather than to a division by zero, which matters
  // because a degenerate normal is exactly what a mesh with a repeated vertex
  // produces, and a NaN here would poison the whole mesh rather than one vertex.
  if (l1 === 0) {
    return { x: 0, y: 0 };
  }

  let x = n.x / l1;
  let y = n.y / l1;
  if (n.z < 0) {
    // The lower hemisphere shares the upper one's square, mirrored across the
    // diagonal. Both components read the pair as it was before either was
    // written, or the second fold measures the first one's result.
    const beforeX = x;
    const beforeY = y;
    x = (1 - Math.abs(beforeY)) * (beforeX >= 0 ? 1 : -1);
    y = (1 - Math.abs(beforeX)) * (beforeY >= 0 ? 1 : -1);
  }
  return { x, y };
};

/** Unfolds a point of [-1, 1]² back to the unit vector that folds onto it. */
export const decodeOctahedral = (f: Vec2): Vec3 => {
  let x = f.x;
  let y = f.y;
  let z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    // The point was in the lower hemisphere's square. Undo the mirror: whatever
    // height the square spent, put it back into x and y, and take what is left
    // of the budget as the now-negative z.
    const t = -z;
    x += x >= 0 ? -t : t;
    y += y >= 0 ? -t : t;
  }
  const length = Math.hypot(x, y, z);
  return length === 0
    ? { x: 0, y: 0, z: 1 }
    : { x: x / length, y: y / length, z: z / length };
};

/**
 * Quantizes a unit vector to the pair of signed 16-bit channels it is stored
 * as, which is the lossy step the attribute format performs on the host rather
 * than in the shader.
 */
export const encodeOctahedralSnorm16 = (n: Vec3): [number, number] => {
  const f = encodeOctahedral(n);
  return [Math.round(f.x * SNORM16_MAX), Math.round(f.y * SNORM16_MAX)];
};

/** Reads a pair of signed 16-bit channels back as a point of [-1, 1]². */
export const decodeOctahedralSnorm16 = (x: number, y: number): Vec2 => ({
  x: x / SNORM16_MAX,
  y: y / SNORM16_MAX,
});

/**
 * Encodes a whole vertex normal into a `snorm16x2` array at `offset`,
 * normalising first so the caller can hand over a direction of any length.
 */
export const writeOctahedralNormal = (
  array: Int16Array,
  offset: number,
  n: Vec3,
): void => {
  const length = Math.hypot(n.x, n.y, n.z);
  const unit =
    length === 0
      ? { x: 0, y: 0, z: 1 }
      : { x: n.x / length, y: n.y / length, z: n.z / length };
  const [x, y] = encodeOctahedralSnorm16(unit);
  array[offset] = x;
  array[offset + 1] = y;
};

/** The unit vector a set of normals on a sphere should sum to across a face. */
export const normalized = (n: Vec3): Vec3 => {
  const length = Math.hypot(n.x, n.y, n.z);
  return length === 0
    ? { x: 0, y: 0, z: 1 }
    : { x: n.x / length, y: n.y / length, z: n.z / length };
};
