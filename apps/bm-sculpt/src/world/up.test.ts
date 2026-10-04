/**
 * Up is a function of position: the frame it builds, and its two hard requirements.
 *
 * ## The two requirements, and why they are the two
 *
 * **Orthonormality** is arithmetic. `onbFromDirection` either returns unit vectors or it does
 * not, and a test either measures it or the physics is quietly wrong in a way that shows up as
 * a player who slides.
 *
 * **Continuity** is the one that actually earns this file. Walking round a planet has to
 * return you to where you started: the player's heading is carried by `reorientUp`, and
 * `reorientUp` is only allowed to rotate by the amount the surface tilted. A frame with a
 * discontinuity in it — the kind a "pick whichever fixed axis is further away" construction has
 * — turns that into a player who spins once per lap without touching the mouse. So continuity
 * is measured by *stepping* around the sphere and asserting the frame barely moved, rather than
 * by comparing two arbitrary points, which a discontinuity could pass by luck.
 *
 * The pole is where a frame is most likely to be wrong and it gets its own case: a body at the
 * pole of the world has an up that is not near any world axis, which is precisely the input
 * that makes `cross(up, X)` degenerate.
 */

import { describe, expect, it } from "vitest";

import {
  cross,
  dot,
  length,
  normalize,
  onbFromDirection,
  vec3,
} from "@big-mesh-studios/core";
import {
  basisAt,
  basisFrom,
  carryBasis,
  flatFrame,
  northOf,
  reorientUp,
  sphericalFrame,
  type BodyBasis,
} from "./up";

/** Directions on a sphere, including every pole and a spread between them. */
const DIRECTIONS = (count = 12): ReturnType<typeof vec3>[] => {
  const out: ReturnType<typeof vec3>[] = [];
  for (let i = 0; i <= count; i++) {
    const theta = (Math.PI * i) / count;
    for (let j = 0; j < 2 * count; j++) {
      const phi = (2 * Math.PI * j) / (2 * count);
      out.push(
        vec3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        ),
      );
    }
  }
  return out;
};

const CENTRE = vec3(0, 0, 0);
const RADIUS = 4000;

describe("the flat frame", () => {
  it("reports +Y everywhere and no centre", () => {
    for (const p of [vec3(0, 0, 0), vec3(1e6, -7, 3)]) {
      expect(flatFrame.upAt(p)).toEqual(vec3(0, 1, 0));
      expect(flatFrame.radiusAt(p)).toBe(Infinity);
    }
    expect(flatFrame.centre).toBeUndefined();
    expect(flatFrame.spherical).toBe(false);
  });

  it("puts a player facing +Z on the same basis the yaw/pitch parameterisation gave", () => {
    // The compatibility this whole refactor has to keep: with yaw 0 and pitch 0 the old
    // look direction was `(0, 0, 1)` and the old screen-right was `(-1, 0, 0)`.
    const basis = basisAt(flatFrame, vec3(0, 0, 0));
    expect(basis.up).toEqual(vec3(0, 1, 0));
    expect(basis.forward).toEqual(vec3(0, 0, 1));
    expect(basis.right).toEqual(vec3(-1, 0, 0));
  });
});

describe("a spherical frame", () => {
  const frame = sphericalFrame(CENTRE);

  it("points up away from the centre", () => {
    for (const d of DIRECTIONS(6)) {
      const p = { x: d.x * RADIUS, y: d.y * RADIUS, z: d.z * RADIUS };
      const up = frame.upAt(p);
      // Not `toEqual`: normalising `d * 4000` cannot return `d` bit for bit, and asking it to
      // would be asserting about the last bit of a division rather than about the direction.
      expect(up.x).toBeCloseTo(d.x, 12);
      expect(up.y).toBeCloseTo(d.y, 12);
      expect(up.z).toBeCloseTo(d.z, 12);
      expect(frame.radiusAt(p)).toBeCloseTo(RADIUS, 9);
    }
  });

  it("is continuous at the centre rather than undefined", () => {
    // A player can reach the centre by digging, and a zero `up` would collapse the collision
    // box to a point and leave the basis with no tangent axes at all.
    const up = frame.upAt(CENTRE);
    expect(length(up)).toBeCloseTo(1, 12);
  });

  it("carries its centre and says it is spherical", () => {
    expect(frame.centre).toEqual(CENTRE);
    expect(frame.spherical).toBe(true);
  });
});

describe("an orthonormal basis", () => {
  it("is orthonormal for every direction on the sphere, poles included", () => {
    for (const d of DIRECTIONS(10)) {
      const { b1, b2 } = onbFromDirection(d);
      expect(length(b1), JSON.stringify(d)).toBeCloseTo(1, 10);
      expect(length(b2), JSON.stringify(d)).toBeCloseTo(1, 10);
      expect(dot(b1, b2), JSON.stringify(d)).toBeCloseTo(0, 10);
      expect(dot(b1, d), JSON.stringify(d)).toBeCloseTo(0, 10);
      expect(dot(b2, d), JSON.stringify(d)).toBeCloseTo(0, 10);
    }
  });

  it("exists for every direction, including the one a fixed axis fails on", () => {
    // `(0,1,0)` is the input that makes `cross(n, (0,1,0))` the zero vector — and it is
    // exactly where a player stands at a planet's pole.
    for (const n of [
      vec3(0, 1, 0),
      vec3(0, -1, 0),
      vec3(0, 0, 1),
      vec3(0, 0, -1),
      vec3(1, 0, 0),
      vec3(-1, 0, 0),
    ]) {
      const { b1, b2 } = onbFromDirection(n);
      expect(length(b1), JSON.stringify(n)).toBeCloseTo(1, 10);
      expect(length(b2), JSON.stringify(n)).toBeCloseTo(1, 10);
    }
  });

  it("is not continuous across the plane it branches on, and nothing needs it to be", () => {
    // This is a property of Frisvad's construction, measured rather than asserted from the
    // source: it branches on the sign of `n.z`, so `b1`'s z component is `-sign(n.z) · n.x` and
    // crossing `z = 0` turns the basis through half a turn. The test says so out loud, because
    // the temptation is to assume "branchless" means "smooth" and then to rely on it.
    //
    // Nothing does. The only two callers are degenerate cases where any axis will do — a
    // heading already parallel to up, and an up that has turned exactly inside out. Where
    // continuity is actually required, `carryBasis` supplies it, and the two lap tests below
    // are the ones that hold it to that.
    // A **unit** direction, because `onbFromDirection` normalises first and `b1.z` is
    // `∓n.x` of the *normalised* input — an input of `(0.6, 0.5, ±1e-6)` is 0.781 long and
    // would make the expected jump 1.536 rather than 1.2.
    const above = onbFromDirection(vec3(0.6, 0.8, 1e-6));
    const below = onbFromDirection(vec3(0.6, 0.8, -1e-6));
    expect(Math.abs(above.b1.z - below.b1.z)).toBeCloseTo(2 * 0.6, 6);
  });

  it("builds a body's basis from a heading and an up", () => {
    const up = normalize(vec3(1, 1, 0));
    const basis = basisFrom(up, vec3(0, 0, 1));
    expect(length(basis.up)).toBeCloseTo(1, 10);
    expect(length(basis.forward)).toBeCloseTo(1, 10);
    expect(length(basis.right)).toBeCloseTo(1, 10);
    expect(dot(basis.forward, basis.up)).toBeCloseTo(0, 10);
    expect(dot(basis.right, basis.up)).toBeCloseTo(0, 10);
    expect(dot(basis.right, basis.forward)).toBeCloseTo(0, 10);
    // `right` is `forward × up`, which is the handedness the old parameterisation had.
    const expected = cross(basis.forward, basis.up);
    expect(basis.right.x).toBeCloseTo(expected.x, 10);
    expect(basis.right.y).toBeCloseTo(expected.y, 10);
    expect(basis.right.z).toBeCloseTo(expected.z, 10);
  });

  it("gives a second tangent axis that is unit and perpendicular", () => {
    for (const d of DIRECTIONS(4)) {
      const basis = basisFrom(d, vec3(0, 1, 0));
      const north = northOf(basis);
      expect(length(north)).toBeCloseTo(1, 10);
      expect(dot(north, basis.up)).toBeCloseTo(0, 10);
      expect(dot(north, basis.right)).toBeCloseTo(0, 10);
    }
  });
});

describe("reorienting onto a new up", () => {
  const orthonormal = (b: BodyBasis): boolean =>
    length(b.up) > 0.999 &&
    length(b.forward) > 0.999 &&
    length(b.right) > 0.999 &&
    Math.abs(dot(b.up, b.forward)) < 1e-9 &&
    Math.abs(dot(b.up, b.right)) < 1e-9 &&
    Math.abs(dot(b.forward, b.right)) < 1e-9;

  it("leaves an unchanged up alone", () => {
    const basis = basisFrom(vec3(0, 1, 0), vec3(0, 0, 1));
    expect(reorientUp(basis, vec3(0, 1, 0))).toBe(basis);
  });

  /**
   * A player's heading, as two numbers in the frame they are standing in.
   *
   * **Why not the world-space forward vector.** Walking along a planet's equator *does* change
   * the inertial heading — a player who kept facing the same compass direction would be turned
   * bodily by the planet, and that is geometry rather than a bug. What must not change is the
   * heading *relative to the ground under their feet*, which is what "they are still facing
   * the way they set out" means to a player, and what parallel transport guarantees. So it is
   * measured in the player's own frame, as `(forward · right, forward · north)`.
   */
  const localHeading = (b: BodyBasis): readonly [number, number] => {
    const north = northOf(b);
    return [dot(b.forward, b.right), dot(b.forward, north)];
  };

  it("turns the basis by the smallest rotation, so the local heading survives", () => {
    // The property a player feels: look one way, walk a quarter of the way round the planet,
    // and still be looking the same way *relative to the ground*. A frame that adopted only the
    // new up would let the heading slide by however far the up moved.
    const frame = sphericalFrame(CENTRE);
    let basis = basisAt(frame, vec3(RADIUS, 0, 0), vec3(0, 0, 1));
    const before = localHeading(basis);

    const steps = 200;
    for (let i = 1; i <= steps; i++) {
      const theta = (Math.PI / 2) * (i / steps);
      basis = carryBasis(
        basis,
        frame,
        vec3(RADIUS * Math.cos(theta), 0, RADIUS * Math.sin(theta)),
      );
    }

    const after = localHeading(basis);
    expect(after[0]).toBeCloseTo(before[0] as number, 6);
    expect(after[1]).toBeCloseTo(before[1] as number, 6);
  });

  it("stays orthonormal through a full lap, and comes back to where it started", () => {
    // The strongest statement of continuity available: a lap of the planet's circumference
    // with no net rotation in the player's heading. Any discontinuity in the frame along the
    // way shows up as a heading that is not the one they set out with.
    const frame = sphericalFrame(CENTRE);
    // A circle of latitude rather than a great circle, and started *on* it: an earlier version
    // began at the equator and looped along a parallel at `theta = 0.7`, then asserted the
    // up had returned to where it began. It had not, because a parallel at one latitude does
    // not pass through a point at another, and the assertion was wrong about geometry rather
    // than about the frame.
    const theta = 0.7;
    const start = vec3(RADIUS * Math.sin(theta), RADIUS * Math.cos(theta), 0);
    let basis = basisAt(frame, start, vec3(1, 0, 0));
    const opened = basis;
    const openedHeading = localHeading(basis);
    const steps = 2000;
    for (let i = 1; i <= steps; i++) {
      const phi = (2 * Math.PI * i) / steps;
      basis = carryBasis(
        basis,
        frame,
        vec3(
          RADIUS * Math.sin(theta) * Math.cos(phi),
          RADIUS * Math.cos(theta),
          RADIUS * Math.sin(theta) * Math.sin(phi),
        ),
      );
      expect(orthonormal(basis), `step ${i}`).toBe(true);
    }
    // Back at the starting point, so the up is the same. The heading is too: a player who has
    // walked all the way round a planet is facing what they started facing.
    expect(basis.up.x).toBeCloseTo(opened.up.x, 6);
    expect(basis.up.y).toBeCloseTo(opened.up.y, 6);
    expect(basis.up.z).toBeCloseTo(opened.up.z, 6);
    const heading = localHeading(basis);
    expect(heading[0]).toBeCloseTo(openedHeading[0] as number, 6);
    expect(heading[1]).toBeCloseTo(openedHeading[1] as number, 6);
    void opened;
  });

  it("handles an up that has turned inside out", () => {
    // `oldUp × newUp` is the zero vector here, so the axis is undefined and any of the
    // infinitely many half turns will do. What matters is that it produces a valid frame
    // rather than a zero vector from a division by a zero length.
    const basis = basisFrom(vec3(0, 1, 0), vec3(0, 0, 1));
    const flipped = reorientUp(basis, vec3(0, -1, 0));
    expect(orthonormal(flipped)).toBe(true);
    expect(flipped.up.y).toBeCloseTo(-1, 10);
  });
});
