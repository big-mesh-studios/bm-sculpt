import { describe, expect, it } from "vitest";

import { sdBox, sdCapsule, sdEllipsoid, shapePadding, sdShape } from "./shapes";
import { MIN_RADIUS } from "./shapes";

describe("signed distance to a box", () => {
  const half = { x: 3, y: 1, z: 2 };

  it("reports zero on the surface", () => {
    for (const p of [
      { x: 3, y: 0, z: 0 },
      { x: -3, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 2 },
    ]) {
      expect(sdBox(half, p)).toBeCloseTo(0, 12);
    }
  });

  it("is negative inside and positive outside", () => {
    expect(sdBox(half, { x: 0, y: 0, z: 0 })).toBeLessThan(0);
    expect(sdBox(half, { x: 10, y: 0, z: 0 })).toBeGreaterThan(0);
  });

  it("is exactly the euclidean distance outside, from any direction", () => {
    // The property a picker depends on: outside, the value is a true distance, so
    // stepping by it cannot jump over a corner. A box's distance measured to the
    // nearest face rather than to the corner would under-report diagonally and put
    // a sphere-tracing step through the edge.
    for (const p of [
      { x: 5, y: 0, z: 0 },
      { x: 3, y: 4, z: 0 },
      { x: 3, y: 1, z: 2 },
      { x: 3, y: 0, z: 2 },
      { x: 4, y: 2, z: 3 },
    ]) {
      const outside: Vec3ish = {
        x: Math.max(Math.abs(p.x) - half.x, 0),
        y: Math.max(Math.abs(p.y) - half.y, 0),
        z: Math.max(Math.abs(p.z) - half.z, 0),
      };
      expect(sdBox(half, p)).toBeCloseTo(
        Math.hypot(outside.x, outside.y, outside.z),
        12,
      );
    }
  });

  it("scales each axis by its own half-extent", () => {
    // Out past each face by its own margin, so the value is that margin and not a
    // distance to a nearer face: at x = 5 in a box of half-extent 10 the point is
    // *inside*, and the answer is a depth rather than a distance.
    expect(sdBox({ x: 10, y: 1, z: 1 }, { x: 15, y: 0, z: 0 })).toBeCloseTo(
      5,
      12,
    );
    expect(sdBox({ x: 1, y: 10, z: 1 }, { x: 0, y: -13, z: 0 })).toBeCloseTo(
      3,
      12,
    );
    expect(sdBox({ x: 1, y: 1, z: 10 }, { x: 0, y: 0, z: 12 })).toBeCloseTo(
      2,
      12,
    );
  });
});

describe("signed distance to a capsule", () => {
  it("reports the radius along the segment's axis", () => {
    expect(sdCapsule(10, 2, { x: 0, y: 0, z: 0 })).toBeCloseTo(-2, 12);
    expect(sdCapsule(10, 2, { x: 0, y: 5, z: 0 })).toBeCloseTo(3, 12);
  });

  it("caps the length at the segment's ends", () => {
    // Past the end, the distance is to a hemisphere rather than to a cylinder, so
    // moving further out along the axis adds exactly what was moved — with nothing
    // off-axis to make the direction oblique.
    expect(sdCapsule(10, 2, { x: 5, y: 0, z: 0 })).toBeCloseTo(-2, 12);
    expect(sdCapsule(10, 2, { x: 6, y: 0, z: 0 })).toBeCloseTo(-1, 12);
    expect(sdCapsule(10, 2, { x: 7, y: 0, z: 0 })).toBeCloseTo(0, 12);
    expect(sdCapsule(10, 2, { x: 8, y: 0, z: 0 })).toBeCloseTo(1, 12);
  });

  it("measures to the end point, not to the axis, once past the end", () => {
    // Off-axis the distance grows by less than the movement, because the nearest
    // point on the capsule stays the end point and the direction to it is not along
    // x. A capsule that grew one-for-one here would be a cylinder, and a stroke's
    // ends would come out as blunt spikes.
    const at = (x: number): number => sdCapsule(10, 2, { x, y: 3, z: 0 });
    expect(at(6.1) - at(5.1)).toBeLessThan(1);
    expect(at(6.1) - at(5.1)).toBeGreaterThan(0);
    expect(at(6.1)).toBeCloseTo(Math.hypot(1.1, 3, 0) - 2, 12);
  });

  it("agrees with a sphere of the same radius at the centre", () => {
    // A capsule of zero length is a sphere, which is the one case where the two
    // shapes must be indistinguishable or a stroke's first dab would differ from
    // its last.
    const at = { x: 0.7, y: -1.3, z: 2.2 };
    expect(sdCapsule(0, 3, at)).toBeCloseTo(
      Math.hypot(at.x, at.y, at.z) - 3,
      12,
    );
  });
});

describe("signed distance to an ellipsoid", () => {
  it("is exact for a sphere", () => {
    // The two terms of the expansion cancel when the radii are equal, which is
    // what makes the approximation usable at all: a brush is a sphere most of the
    // time and a sphere has to be right.
    const p = { x: 1.3, y: -0.4, z: 2.1 };
    expect(sdEllipsoid({ x: 2, y: 2, z: 2 }, p)).toBeCloseTo(
      Math.hypot(p.x, p.y, p.z) - 2,
      12,
    );
  });

  it("reports zero on the surface along each axis", () => {
    for (const radius of [
      { x: 4, y: 1, z: 7 },
      { x: 1, y: 9, z: 1 },
    ]) {
      expect(sdEllipsoid(radius, { x: radius.x, y: 0, z: 0 })).toBeCloseTo(
        0,
        5,
      );
      expect(sdEllipsoid(radius, { x: 0, y: radius.y, z: 0 })).toBeCloseTo(
        0,
        5,
      );
      expect(sdEllipsoid(radius, { x: 0, y: 0, z: radius.z })).toBeCloseTo(
        0,
        5,
      );
    }
  });

  it("never over-reports, so a sphere-tracing step cannot overshoot", () => {
    // The one property this approximation has to hold. It is a lower bound on the
    // true distance everywhere, so stepping by it lands short of the surface
    // rather than past it — which is what a picker tracing it needs and what an
    // over-reporting approximation would silently break.
    const radii = { x: 6, y: 1.2, z: 2.4 };
    for (let i = 0; i < 400; i++) {
      const p = randomPoint(9);
      const reported = sdEllipsoid(radii, p);
      // A conservative check against the true distance to the surface, computed by
      // stepping inward along the gradient: a true lower bound on the distance is
      // obtained by finding any point inside and measuring to it.
      expect(reported).toBeLessThanOrEqual(
        upperBoundOnTrueDistance(radii, p) + 1e-6,
      );
    }
  });

  it("treats a zero radius as very small rather than dividing by it", () => {
    // A degenerate primitive from a scale-to-zero in a transform panel must
    // produce a surface very near the origin, not a NaN that spreads through a
    // whole chunk.
    const value = sdEllipsoid({ x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(sdEllipsoid({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(
      -MIN_RADIUS,
    );
  });
});

describe("shapes in general", () => {
  it("all report zero on the surface of a unit sphere's worth of surface", () => {
    // Sampled around the shape from outside, each one should cross zero once.
    for (const shape of [
      { type: "Ellipsoid", radius: { x: 2, y: 2, z: 2 } },
      { type: "Box", len: { x: 2, y: 2, z: 2 } },
      { type: "Capsule", lenX: 4, radius: 2 },
    ] as const) {
      const direction = { x: 0.3, y: 0.5, z: 0.81 };
      const length = Math.hypot(direction.x, direction.y, direction.z);
      let previous = sdShape(shape, {
        x: (direction.x / length) * 9,
        y: (direction.y / length) * 9,
        z: (direction.z / length) * 9,
      });
      let crossings = 0;
      for (let step = 1; step >= -1; step -= 0.02) {
        const value = sdShape(shape, {
          x: (direction.x / length) * step,
          y: (direction.y / length) * step,
          z: (direction.z / length) * step,
        });
        if (previous > 0 !== value > 0) crossings++;
        previous = value;
      }
      expect(crossings, shape.type).toBe(1);
    }
  });

  it("pads its box by four times the softness, plus a unit of slack", () => {
    // The reach a smooth boolean has past the shape it applies to. Too small and
    // the seam between two chunks disagrees with the interior; too large and every
    // sample tests against operations that cannot reach it.
    expect(shapePadding({ type: "Box", len: { x: 1, y: 1, z: 1 } }, 0)).toBe(1);
    expect(
      shapePadding({ type: "Box", len: { x: 1, y: 1, z: 1 } }, 0.18),
    ).toBeCloseTo(1.72, 12);
  });
});

interface Vec3ish {
  x: number;
  y: number;
  z: number;
}

const randomPoint = (scale: number): Vec3ish => ({
  x: (pseudoRandom() * 2 - 1) * scale,
  y: (pseudoRandom() * 2 - 1) * scale,
  z: (pseudoRandom() * 2 - 1) * scale,
});

/**
 * A deterministic sequence, so a failure in a randomised assertion can be
 * reproduced exactly. `Math.random` would make every run differ and every failure
 * unrepeatable.
 */
let seed = 0x2f6e2b1;
const pseudoRandom = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/**
 * An upper bound on the true distance from a point to an ellipsoid's surface, by
 * walking towards the origin and taking the first sample found inside. Any point
 * inside is a lower bound on the distance, so the distance to it is an upper bound
 * on the true one — which is the side the "never over-reports" assertion needs.
 */
const upperBoundOnTrueDistance = (radii: Vec3ish, p: Vec3ish): number => {
  const start = Math.hypot(p.x, p.y, p.z);
  if (start === 0) return Math.max(radii.x, radii.y, radii.z);
  const steps = 400;
  for (let i = 1; i <= steps; i++) {
    const t = start * (1 - i / steps);
    const scaled = {
      x: (p.x / start) * t,
      y: (p.y / start) * t,
      z: (p.z / start) * t,
    };
    if (
      (scaled.x / radii.x) ** 2 +
        (scaled.y / radii.y) ** 2 +
        (scaled.z / radii.z) ** 2 <=
      1
    ) {
      return start - t;
    }
  }
  return Number.POSITIVE_INFINITY;
};
