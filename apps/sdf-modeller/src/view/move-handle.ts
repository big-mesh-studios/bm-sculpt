/**
 * Where the move handles are on the screen, and how far along one of them a drag has gone.
 *
 * ## Why this file is arithmetic and nothing else
 *
 * **Because it is the only part of the move tool with an answer that can be wrong.** The
 * arrows themselves are three cylinders and a cone, and whether they are drawn is a matter
 * of taste. But "which arrow did the finger take hold of" and "how far has it carried the
 * part" are arithmetic on a projection, and getting them wrong produces a tool that moves
 * the wrong part along the wrong axis — which looks like the tool misbehaving rather than
 * like a bug, and so cannot be found by looking at the screen.
 *
 * So the geometry, the projection, the hit test and the drag are here, with no renderer in
 * sight, and tested against numbers.
 *
 * ## Why the hit test is in screen space rather than a raycast
 *
 * **Because the arrows are not solid as far as picking is concerned, and pretending
 * otherwise is how this goes wrong.** An arrow is a thin cylinder that a ray hits over a
 * couple of pixels, so a raycast would make it a much smaller target than it looks — and on
 * a phone, where a finger is fifty pixels across, that is the difference between a handle
 * that works and one that cannot be hit at all. Measuring the pointer against the arrow's
 * *drawn line* gives it the size it appears to be, which is the only size a finger has ever
 * managed to aim at.
 *
 * It also means the drawn arrow and the grabbable arrow cannot disagree: both come from the
 * same two points.
 *
 * ## How a two-dimensional drag becomes a three-dimensional move
 *
 * **By projecting the drag onto the arrow's own screen direction, rather than by
 * intersecting a ray with a plane.** The usual approach needs a plane, and choosing the
 * plane is a second question with a second set of wrong answers — edge-on, it degenerates,
 * and it moves fastest when the camera looks straight down the axis being dragged, which is
 * exactly when a person most wants fine control.
 *
 * The arrow already lies along the line being moved on, and its length in the world is
 * known, so the pointer's travel along that line *is* the distance. It is the same
 * arithmetic a person does by eye: "the arrow is this long, my finger went about half of
 * it, so it moved half as far."
 *
 * ## Why an arrow pointing at the camera refuses to move
 *
 * **Because there is no answer to give.** An arrow pointing nearly at the camera covers a
 * few pixels on screen however far it is dragged, and every pixel would have to mean an
 * enormous distance, so a small wobble would send the part across the model. Rather than
 * divide by something close to zero, the arrow stops being draggable below
 * {@link TOO_FORESHORTENED} pixels — the same conclusion rm-stacker reaches, for the same
 * reason.
 */
import type { Matrix4, Vector3 } from "@random-mesh/rmsl/scene";

/** A point on the canvas, in CSS pixels from its top left. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** The canvas the handles are measured against. */
export interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

export type Axis = "x" | "y" | "z";

export const AXES: readonly Axis[] = ["x", "y", "z"];

/**
 * How much of the view's height an arrow spans.
 *
 * **A fraction of the camera's distance rather than a length in the world**, because a
 * handle has to stay the same size on screen whether the camera is pulled back to take in a
 * whole figure or brought in to work on a fingertip. The camera's focal length in units of
 * its own distance is fixed, so an arrow of `VIEW_SHARE × distance` covers `VIEW_SHARE` of
 * the canvas height at any distance at all.
 */
export const VIEW_SHARE = 0.25;

/** Proportions of an arrow's own length, so one scale makes all three parts agree. */
export const SHAFT_RADIUS = 0.028;
export const HEAD_LENGTH = 0.26;
export const HEAD_RADIUS = 0.075;

/**
 * How near the pointer has to come to an arrow, in CSS pixels, to take hold of it.
 *
 * **Twenty-two, and it is large on purpose.** rm-stacker uses twelve, which is about right
 * for a mouse. A fingertip is roughly fifty pixels across and does not report where its
 * centre is; a threshold sized for a cursor makes an arrow that looks comfortable to aim at
 * and is not. Twelve on a phone is a handle that cannot be hit without looking at it, and a
 * handle nobody can hit is a handle that is not there.
 */
export const GRAB_RADIUS = 22;

/**
 * How close to where the three arrows meet a grab has to be before it names an axis, in
 * pixels.
 *
 * **A dead zone, and deliberately so.** All three start at one point, so a grab on it is as
 * near one axis as another, and whatever answered first would win — which would make the
 * middle of the widget a coin toss rather than a place. Grabbing the middle grabs nothing,
 * and the middle is where the part is.
 */
export const HUB_RADIUS = 18;

/** Below this many pixels of screen length, an arrow stops being draggable. */
export const TOO_FORESHORTENED = 10;

/** One arrow, as two points on the canvas. */
export interface ArmOnScreen {
  readonly axis: Axis;
  /** Where the three arrows meet: the part's origin. */
  readonly from: ScreenPoint;
  /** The far end of this arrow. */
  readonly to: ScreenPoint;
}

/**
 * Where a world point lands on a canvas `size` big, or `undefined` if it is out of frame.
 *
 * **`undefined` for anything outside the depth range, which is also how an arrow behind the
 * camera is left ungrabbable.** A point behind the camera comes back from the projection
 * mirrored into the middle of the picture, where it would read as an ordinary position — so
 * a handle on the far side of a figure would be drawn as though it pointed at the viewer and
 * would be grabbed when the person reached for the near side.
 *
 * **Canvas y is flipped**, because the canvas counts downwards and the projection counts up.
 */
export const projectToScreen = (
  point: Vector3,
  viewProjection: Matrix4,
  size: ScreenSize,
): ScreenPoint | undefined => {
  const out = point.clone().applyMatrix4(viewProjection);
  if (out.z < -1 || out.z > 1) return undefined;
  return {
    x: ((out.x + 1) / 2) * size.width,
    y: ((1 - out.y) / 2) * size.height,
  };
};

/**
 * How far `point` is from the line running from `from` to `to`, in pixels.
 *
 * **Clamped to the segment rather than to the infinite line**, so a point past the tip
 * measures to the tip. That is the difference between an arrow you can grab anywhere along
 * its length and one whose grip stops short of the head, and it is why the tip is `to`.
 */
export const distanceToSegment = (
  point: ScreenPoint,
  from: ScreenPoint,
  to: ScreenPoint,
): number => {
  const run = { x: to.x - from.x, y: to.y - from.y };
  const lengthSquared = run.x * run.x + run.y * run.y;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y);
  }
  const along = Math.max(
    0,
    Math.min(
      1,
      ((point.x - from.x) * run.x + (point.y - from.y) * run.y) / lengthSquared,
    ),
  );
  return Math.hypot(
    point.x - (from.x + run.x * along),
    point.y - (from.y + run.y * along),
  );
};

/**
 * Which arrow the pointer has hold of, or `undefined` for none of them and for the dead
 * zone at the hub.
 *
 * **The nearest wins where two arrows cross.** That is what makes the arrow drawn in front
 * the one that is grabbed, and it is why this does not simply test x, then y, then z: a
 * widget whose pick order is its axis order silently reaches through the figure for the arm
 * behind it.
 */
export const armUnderPointer = (
  pointer: ScreenPoint,
  arms: readonly ArmOnScreen[],
): Axis | undefined => {
  const hub = arms[0];
  if (
    hub !== undefined &&
    Math.hypot(pointer.x - hub.from.x, pointer.y - hub.from.y) < HUB_RADIUS
  ) {
    return undefined;
  }

  let closest: { axis: Axis; distance: number } | undefined;
  for (const arm of arms) {
    const distance = distanceToSegment(pointer, arm.from, arm.to);
    if (
      distance <= GRAB_RADIUS &&
      (closest === undefined || distance < closest.distance)
    ) {
      closest = { axis: arm.axis, distance };
    }
  }
  return closest?.axis;
};

/**
 * How far along its own axis a drag has carried an arrow, in world units.
 *
 * **Absolute rather than accumulated.** The caller passes the pointer's travel since the
 * grab began, so the answer is recomputed from where the drag started every time. A version
 * that added up each move would drift, because every rounding would be kept — and a part
 * that does not come back to where it was put down when the finger returns to the arrow is
 * the kind of wrong that makes a tool feel broken.
 *
 * **Zero for an arrow too foreshortened to read a distance off.** See the header.
 */
export const distanceDragged = (
  dragged: ScreenPoint,
  arm: ArmOnScreen,
  armLength: number,
): number => {
  const run = { x: arm.to.x - arm.from.x, y: arm.to.y - arm.from.y };
  const onScreen = Math.hypot(run.x, run.y);
  if (onScreen < TOO_FORESHORTENED) return 0;
  // **The projection of the drag onto the arrow's screen direction**, which is the only
  // part of a two-dimensional movement that lies along a one-dimensional axis.
  const along = (dragged.x * run.x + dragged.y * run.y) / onScreen;
  return (along / onScreen) * armLength;
};
