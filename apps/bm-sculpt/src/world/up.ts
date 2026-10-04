/**
 * Up is a function of position, not a constant.
 *
 * ## What this file is for
 *
 * Everything below used to read the world as "down is `-Y`". Gravity was a scalar subtracted
 * from a `vy`, the player's collision box was an AABB aligned to the world axes, the ground
 * under their feet was a *height*, and the phrase "horizontally" meant "in the x/z plane".
 * A world where up varies with position cannot be described that way, so this file supplies the
 * one thing that replaces it: a `Frame`, which answers "which way is up here", and the basis
 * arithmetic that turns that answer into something a player can stand in.
 *
 * ## Why a frame and not a gravity vector
 *
 * A planet's up is `normalize(point - centre)`, which is a direction rather than a magnitude,
 * and the things that need it want a direction. The player's collision box wants two tangent
 * axes, the walking code wants a heading, the ground snap wants a distance measured along a
 * ray. A single "up" answers the first and the reader derives the rest — and deriving them in
 * one place, here, is what keeps the physics from quietly re-deriving them differently.
 *
 * ## The three frames
 *
 * - **`flatFrame`** — up is `+Y` everywhere. This is the world the application has today, and
 *   it is the reason Phase 1 can land without changing what anything looks like.
 * - **`sphericalFrame(centre)`** — up points away from a centre. A planet.
 * - **`basisAt(frame, p)`** — the orthonormal triad `{ right, up, forward }` at a point, from
 *   `onbFromDirection` so it is continuous and has no singular direction.
 *
 * ## The property the physics depends on
 *
 * **`reorientUp` is what makes walking around a sphere possible.** When the player crosses a
 * chunk boundary their local up changes, and a frame that simply adopted the new up would snap
 * their heading — the player would be walking north, cross a line, and suddenly be walking
 * east. `reorientUp` rotates the whole frame by the smallest rotation carrying the old up to
 * the new one, which preserves the heading as closely as any rotation can and leaves the
 * player looking where they were looking. That is parallel transport, and it is why walking a
 * full circle round a planet returns you to where you started instead of having spun you.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import {
  cross,
  dot,
  length,
  normalize,
  onbFromDirection,
  rotateAboutAxis,
  sub,
  vec3,
} from "@big-mesh-studios/core";

/** Which way is up, and how far the body's centre is from a point. */
export interface Frame {
  /** A unit "up" at a world point. Never zero, for any point the player can occupy. */
  upAt(p: Vec3): Vec3;
  /**
   * Distance from the body's centre, or `Infinity` for a frame with no centre.
   *
   * **Infinity rather than a radius, so a flat world has one fewer special case.** A flat
   * frame is the degenerate sphere of infinite radius, and every consumer — the water test,
   * the world bound — then needs no branch of its own.
   */
  radiusAt(p: Vec3): number;
  /** The body's centre, or `undefined` when the frame is flat. */
  readonly centre: Vec3 | undefined;
  /** Whether this frame wraps a sphere. Decides how the world bound is applied. */
  readonly spherical: boolean;
}

/** The frame the application used before up became a function of position. */
export const flatFrame: Frame = {
  upAt: () => vec3(0, 1, 0),
  radiusAt: () => Infinity,
  centre: undefined,
  spherical: false,
};

/**
 * A frame on a sphere of the given centre.
 *
 * **At the centre itself, up is `+Y` rather than undefined.** A player can be exactly at a
 * planet's centre only by arriving there deliberately through solid rock, but `normalize` of
 * the zero vector is zero and a zero `up` would make every basis below degenerate — the
 * player's collision box would collapse to a point and the frame would have no tangent axes.
 * Any unit vector is as good as any other at a point with no direction, and `+Y` means the
 * answer is at least finite and continuous enough to stand in.
 */
export const sphericalFrame = (centre: Vec3): Frame => ({
  upAt: (p) => {
    const d = sub(p, centre);
    const u = normalize(d);
    return u.x === 0 && u.y === 0 && u.z === 0 ? vec3(0, 1, 0) : u;
  },
  radiusAt: (p) => {
    const d = sub(p, centre);
    return Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
  },
  centre,
  spherical: true,
});

/**
 * The triad a player stands and looks in.
 *
 * **`forward` is not perpendicular to `up`, and that is the point.** The old code kept a `yaw`
 * and a `pitch`; the yaw was a heading around the world axis and the pitch was an angle off the
 * ground, and the two were independent. Collapsing them into one basis and then insisting the
 * basis be orthonormal throws the pitch away — and rolling `up` along with it, so that looking
 * up at the sky also rolls the player's idea of which way is up.
 *
 * So only one orthogonality is required, and it is the one that matters:
 *
 * - `up` — the surface normal, from the frame. **Never moved by looking.**
 * - `right` — `forward × up`, so it is always perpendicular to `up` and therefore always in the
 *   tangent plane. **Derived, never stored independently**, because a `right` kept alongside a
 *   `forward` can disagree with it and the disagreement is a rotation nobody can see.
 * - `forward` — where they look, anywhere within `maxPitch` of the tangent plane.
 *
 * The handedness is the one the old yaw/pitch parameterisation had: with yaw 0 looking along `+Z`
 * and `+Y` up, `right` came out as `(-cos yaw, 0, sin yaw)`. A player who has not touched the
 * mouse looks and strafes in exactly the direction they did before, on either frame.
 */
export interface BodyBasis {
  /** Screen-right. Unit, and perpendicular to `up`. */
  readonly right: Vec3;
  /** Local up: the surface normal. Unit. */
  readonly up: Vec3;
  /** Where the player looks. Unit. Not necessarily perpendicular to `up`. */
  readonly forward: Vec3;
}

/** The second tangent axis, `up × right`, which is always well defined because they are perpendicular. */
export const northOf = (basis: BodyBasis): Vec3 =>
  normalize(cross(basis.up, basis.right));

/**
 * Rotates a look direction about a unit axis, leaving the body's `up` alone.
 *
 * **`up` is deliberately not rotated.** This is what a yaw turn uses — rotating the heading
 * around the vertical — and what a pitch turn does *not*: pitching rolls the view, and a view
 * that rolled the player's idea of vertical with it would leave them unable to tell which way is
 * down after a single glance at the sky.
 *
 * `right` is re-derived from the two rather than rotated, because it is defined as
 * `forward × up` and a stored copy can only ever disagree with that.
 */
export const turn = (basis: BodyBasis, axis: Vec3, angle: number): BodyBasis =>
  basisFrom(basis.up, rotateAboutAxis(basis.forward, axis, angle));

/** The angle between a look direction and the tangent plane, in radians, signed. */
export const elevationOf = (basis: BodyBasis): number =>
  Math.asin(Math.max(-1, Math.min(1, dot(basis.forward, basis.up))));

/**
 * `v` with its component along `u` multiplied out — the projection of `v` into the plane
 * perpendicular to `u`, written as a removal so the caller passes the component it wants gone.
 */
const withoutComponentAlong = (v: Vec3, u: Vec3): Vec3 => {
  const k = dot(v, u);
  return { x: v.x - u.x * k, y: v.y - u.y * k, z: v.z - u.z * k };
};

/**
 * Rebuilds a basis from a look direction and an up, deriving `right` from the two.
 *
 * **`forward` is kept as given and not projected into the tangent plane.** Projecting it would
 * discard the player's pitch — the whole of it, since a pitched forward's tangent projection is
 * the heading and nothing else — and this function is called on every reorientation, so the pitch
 * would be erased sixty times a second.
 *
 * A `forward` parallel to `up` has no right to derive, and falls back to whatever
 * `onbFromDirection` offers. Returning a zero `right` instead would put a zero length on the
 * player's collision box and a zero on their heading, and the failure would surface a frame later
 * as a player who will not move.
 */
export const basisFrom = (up: Vec3, forward: Vec3): BodyBasis => {
  const u = normalize(up);
  const f = normalize(forward);
  const tangent = withoutComponentAlong(f, u);
  const right =
    tangent.x === 0 && tangent.y === 0 && tangent.z === 0
      ? onbFromDirection(u).b1
      : tangent;
  return { right: normalize(cross(right, u)), up: u, forward: f };
};

/** The basis at a point, from the frame. */
export const basisAt = (
  frame: Frame,
  p: Vec3,
  heading: Vec3 = vec3(0, 0, 1),
): BodyBasis => {
  const up = frame.upAt(p);
  const projected = withoutComponentAlong(heading, up);
  // A heading parallel to up has no tangent to project into, so fall back to whatever `onb`
  // offers. Only reachable if a caller asks for one; the player's own forward never is,
  // because the pitch clamp keeps it off the up axis.
  return projected.x === 0 && projected.y === 0 && projected.z === 0
    ? basisFrom(up, onbFromDirection(up).b1)
    : basisFrom(up, projected);
};

/**
 * Carries a basis onto a new up, keeping the player's heading.
 *
 * **The smallest rotation taking the old up to the new one, applied to the whole basis.** Three
 * cases, and the third is the one worth reading:
 *
 * - The ups agree: nothing to do.
 * - They are opposite: the axis is undefined, so any perpendicular axis will do. `onb` supplies
 *   a stable one rather than a random one, so a player who walks through a planet's core comes
 *   out facing a direction they can reason about rather than one that depends on floating-point
 *   noise. Half a turn is the only rotation that maps `u` to `-u` while being closest to the
 *   identity.
 * - Otherwise: rotate about `oldUp × newUp` by the angle between them.
 *
 * Applied to `forward` and `right` as well as `up`, so the heading is carried rather than
 * recomputed. Applying it to `up` alone would leave a heading that had slid, by exactly the
 * amount the up had moved.
 */
export const reorientUp = (basis: BodyBasis, up: Vec3): BodyBasis => {
  const next = normalize(up);
  const from = basis.up;
  const d = dot(from, next);
  if (d > 1 - 1e-12) return basis;

  // The rotation that carries `from` onto `next`, found as an axis and an angle. **It is
  // applied to the heading only** — `next` is already the answer for the up, and rotating it as
  // well is the bug this function was written with the first time: `from × next` rotates
  // `from` toward `next`, so rotating `next` by that angle moves it *away* from `next`, and the
  // frame's up drifts off the surface by that much on every call.
  if (d < -1 + 1e-12) {
    const axis = onbFromDirection(from).b1;
    return basisFrom(next, rotateAboutAxis(basis.forward, axis, Math.PI));
  }
  const raw = cross(from, next);
  const axis = normalize(raw);
  // `atan2` of the cross product's length against the dot product is the angle between the two,
  // and it stays accurate for a small angle where `acos` of the dot product would lose it.
  const angle = Math.atan2(length(raw), d);
  return basisFrom(next, rotateAboutAxis(basis.forward, axis, angle));
};

/**
 * Carries a basis from one point to another, using each point's own up.
 *
 * **This is what the player calls when they move**, and the reason is the heading. Re-deriving
 * the basis from scratch at the new position would give a frame whose tangent axes come from
 * `onbFromDirection` — continuous in *position*, but with no memory of which way the player was
 * facing, so their heading would be decided by the construction rather than by them.
 * `reorientUp` on the old basis gives both: an up that tracks the surface, and a heading that
 * only changes because the surface tilted under them.
 */
export const carryBasis = (
  basis: BodyBasis,
  frame: Frame,
  to: Vec3,
): BodyBasis => reorientUp(basis, frame.upAt(to));
