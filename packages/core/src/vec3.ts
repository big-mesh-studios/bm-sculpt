/**
 * Vector arithmetic on `Vec3`, as functions rather than methods.
 *
 * ## Why functions and not a class, and why not the renderer's
 *
 * **`Vec3` is plain data on purpose.** The operation list is cloned into every meshing worker
 * on every edit and crosses that boundary by structured clone, so the vocabulary these
 * functions operate on has to survive being copied by the platform rather than carrying
 * anything that does not. A method on a class is fine for that — methods live on the
 * prototype and do not travel with an instance — but a mutable `Vector3` whose `.add()` writes
 * through would be a different kind of hazard: every call site would be one aliasing bug away
 * from mutating a value two frames still needs.
 *
 * So these return new vectors and never write through their arguments. It costs an allocation
 * per operation, which is free next to the field evaluation that dominates a frame's cost in
 * every loop these appear in.
 *
 * **rmsl's `scene/math/Vector3` is not used here**, and the reason is a package boundary rather
 * than a preference. `packages/*` have no renderer dependency — `docs/adr/0024` moved the
 * landscape's numbers out of `csg` for a version of this argument — and `@random-mesh/rmsl`
 * is a renderer. Its maths are also mutable (`.setFromSphericalCoords` and the rest assign
 * into `this`), which is the opposite of what a field's arithmetic wants. `places/guest`'s
 * `Vector3` is the model followed here, and it is already complete.
 */

import type { Vec3 } from "./constants";

/** The zero vector, and the one. Frozen in the sense that callers must not write to it. */
export const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
export const ONE: Vec3 = Object.freeze({ x: 1, y: 1, z: 1 });

/** A vector from three numbers. Named so a literal is never spelled `{ x, y, z }` at a call site. */
export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Sum of two vectors. */
export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

/** Difference, `a - b`. */
export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

/** A vector scaled by a number. */
export const scale = (a: Vec3, k: number): Vec3 => ({
  x: a.x * k,
  y: a.y * k,
  z: a.z * k,
});

/** The vector pointing the other way. */
export const negate = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });

/** Inner product. */
export const dot = (a: Vec3, b: Vec3): number =>
  a.x * b.x + a.y * b.y + a.z * b.z;

/** Cross product, in the right-handed sense the rest of this repository uses. */
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** Squared length. Preferred over `length` where only a comparison is needed. */
export const lengthSq = (a: Vec3): number => dot(a, a);

/** Length. */
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

/** Distance between two points. */
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/**
 * A unit vector in the same direction, or the zero vector where there is no direction.
 *
 * **Zero in, zero out, rather than a division by zero.** A caller that normalises the result
 * of a cross product is asking a question whose answer is sometimes "the two were parallel",
 * and `NaN` would poison every arithmetic after it silently — a position becomes `NaN` and the
 * error surfaces a frame later as a chunk that will not mesh. Zero propagates as "no
 * direction" and is testable.
 */
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l === 0
    ? { x: 0, y: 0, z: 0 }
    : { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** The vector from `a` to `b`, at a fraction `t` of the way. */
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
});

/** Whether every component is a finite number. */
export const isFinite = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/**
 * Rotates `v` about a unit `axis` by `angle` radians, by Rodrigues' formula.
 *
 * **The axis must be a unit vector.** The formula divides by nothing but multiplies
 * `sin(angle)` by the cross product, so a non-unit axis scales the rotation by the axis's
 * length without any sign of complaint — a 45° rotation about an axis of length 2 becomes 90°.
 * Every call site here passes an axis that came out of `cross` of two unit vectors or out of
 * `onbFromDirection`, and the tests assert the axes are unit, because a rotation that is
 * silently wrong in one caller is a bug that reads as a physics bug.
 */
export const rotateAboutAxis = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const cr = cross(axis, v);
  return {
    x: v.x * c + cr.x * s + axis.x * k,
    y: v.y * c + cr.y * s + axis.y * k,
    z: v.z * c + cr.z * s + axis.z * k,
  };
};

/** The angle between two vectors, in radians, from their dot product rather than an inverse trig. */
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const la = length(a);
  const lb = length(b);
  if (la === 0 || lb === 0) return 0;
  // Clamped, because a dot product that rounds past 1 gives an `acos` of a number outside its
  // domain and the whole expression becomes `NaN` — for two vectors that are the same.
  const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return Math.acos(c);
};

/** An orthonormal basis perpendicular to a direction, from Frisvad's branchless construction. */
export interface Basis {
  /** The first perpendicular: unit, orthogonal to the direction and to `b2`. */
  readonly b1: Vec3;
  /** The second perpendicular: unit, orthogonal to the direction and to `b1`. */
  readonly b2: Vec3;
}

/**
 * A stable orthonormal basis perpendicular to `n`, from Duff et al.'s branchless
 * construction (Frisvad 2012).
 *
 * ## Why this and not a cross product against a fixed axis
 *
 * **The obvious construction fails on one input.** `cross(n, X)` degenerates whenever `n` is
 * parallel to `X`, which for a fixed `X = (0,1,0)` is exactly the case that matters here: a
 * player standing at a planet's pole has local up along `Y`. That one point would have no
 * `east` and no `north`, and every frame at it would produce a zero vector.
 *
 * The usual repair — pick whichever of two fixed axes `n` is further from — fixes the
 * degeneracy and **introduces a worse one**: the frame flips discontinuously where the choice
 * changes, so walking across that line snaps the player's heading by a quarter turn.
 *
 * This construction has neither fault. It branches on the sign of `n.z` rather than on a
 * comparison between directions, so it is continuous everywhere, and it is total: at every
 * direction, including `(0,0,-1)`, it returns two unit vectors.
 *
 * It does not return *the same* basis on opposite hemispheres — `b1` points one way for `n`
 * and the other for `-n`, deliberately, because a basis that flipped sign with the direction
 * would make a heading reverse every time a player crossed an equator. What is guaranteed is
 * orthonormality and continuity, which is what a frame needs.
 */
export const onbFromDirection = (n: Vec3): Basis => {
  const d = normalize(n);
  // `Object.is` on `-0` would take the negative branch, and `sign` is only ever read as ±1
  // multiplying terms that are symmetric in it, so `-0` is harmless here.
  const sign = d.z >= 0 ? 1 : -1;
  // The one division, and it is safe: `sign` is chosen so the denominator is `|d.z| + 1`,
  // which is never below 1.
  const a = -1 / (sign + d.z);
  const b = d.x * d.y * a;
  return {
    b1: { x: 1 + sign * d.x * d.x * a, y: sign * b, z: -sign * d.x },
    b2: { x: b, y: sign + d.y * d.y * a, z: -d.y },
  };
};
