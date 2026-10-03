import { describe, expect, it } from "vitest";

import type { Vec3 } from "@big-mesh-studios/core";

import {
  MIN_RADIUS,
  parameterFloats,
  parametersToFloats,
  primitiveFromCode,
  dimensionGroups,
  primitiveHalfExtents,
  primitiveParameters,
  PRIMITIVE_NAMES,
  PRIMITIVES,
  sdBox,
  sdCapsule,
  sdEllipsoid,
  sdShape,
  shapeFromFloats,
  shapePadding,
  withParameter,
  type OperationShape,
  type ShapeType,
} from "./primitives";

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

/**
 * The capsule is **vertical**, along Y.
 *
 * **These four tests were written for an X-axis capsule and were moved, not
 * rewritten.** `lenX` became `len` and the axis became Y, so every probe that pushed
 * along x became a probe along y. The assertions are the same ones they always were: a
 * radius across the segment, a hemisphere past each end rather than a cylinder, and a
 * distance that grows by less than the movement once off-axis.
 */
describe("signed distance to a capsule", () => {
  it("reports the radius across the segment", () => {
    expect(sdCapsule(10, 2, { x: 0, y: 0, z: 0 })).toBeCloseTo(-2, 12);
    // **Off-axis, and off-axis is now y's job.** The old X-axis capsule took `{x: 0,
    // y: 5, z: 0}` for "five units to the side"; on a vertical capsule that point is
    // the end of the segment itself, so the two perpendicular axes are x and z and y
    // is the one that runs.
    expect(sdCapsule(10, 2, { x: 0, y: 0, z: 5 })).toBeCloseTo(3, 12);
    expect(sdCapsule(10, 2, { x: 5, y: 0, z: 0 })).toBeCloseTo(3, 12);
    // Halfway along the axis, still the radius inward.
    expect(sdCapsule(10, 2, { x: 0, y: 5, z: 0 })).toBeCloseTo(-2, 12);
  });

  it("runs along y, and not along x", () => {
    // The axis is a convention rather than a derivation, so it gets one test that
    // fails if the convention moves: a 10-long capsule of radius 2 reaches 5 up the Y
    // axis and 2 across it, and its length is not along X at all. Every axial
    // primitive in the table agrees on this, which is why it is worth pinning.
    expect(sdCapsule(10, 2, { x: 0, y: 7, z: 0 })).toBeCloseTo(0, 12);
    expect(sdCapsule(10, 2, { x: 3, y: 0, z: 0 })).toBeCloseTo(1, 12);
  });

  it("caps the length at the segment's ends", () => {
    // Past the end, the distance is to a hemisphere rather than to a cylinder, so
    // moving further out along the axis adds exactly what was moved — with nothing
    // off-axis to make the direction oblique.
    expect(sdCapsule(10, 2, { x: 0, y: 5, z: 0 })).toBeCloseTo(-2, 12);
    expect(sdCapsule(10, 2, { x: 0, y: 6, z: 0 })).toBeCloseTo(-1, 12);
    expect(sdCapsule(10, 2, { x: 0, y: 7, z: 0 })).toBeCloseTo(0, 12);
    expect(sdCapsule(10, 2, { x: 0, y: 8, z: 0 })).toBeCloseTo(1, 12);
  });

  it("measures to the end point, not to the axis, once past the end", () => {
    // Off-axis the distance grows by less than the movement, because the nearest
    // point on the capsule stays the end point and the direction to it is not along
    // y. A capsule that grew one-for-one here would be a cylinder, and a stroke's
    // ends would come out as blunt spikes.
    const at = (y: number): number => sdCapsule(10, 2, { x: 0, y, z: 3 });
    expect(at(6.1) - at(5.1)).toBeLessThan(1);
    expect(at(6.1) - at(5.1)).toBeGreaterThan(0);
    expect(at(6.1)).toBeCloseTo(Math.hypot(0, 1.1, 3) - 2, 12);
  });

  it("agrees with a sphere of the same radius, to within the clamped segment", () => {
    // A capsule of zero length should be a sphere, which is the one case where the
    // two shapes must be nearly indistinguishable or a stroke's first dab would
    // differ from its last.
    //
    // **"Nearly", and the bound is `MIN_RADIUS / 2` rather than floating-point
    // equality.** A zero length is clamped up to `MIN_RADIUS` so the distance function
    // cannot divide by it, which leaves the segment a half-length of `MIN_RADIUS / 2`
    // rather than none at all. The resulting disagreement with a true sphere is
    // bounded by that half-length — measured at 2.45e-4 here, against a `toBeCloseTo`
    // of 12 that this test used to assert and cannot any longer.
    const at = { x: 0.7, y: -1.3, z: 2.2 };
    const sphere = Math.hypot(at.x, at.y, at.z) - 3;
    const difference = Math.abs(sdCapsule(0, 3, at) - sphere);
    expect(difference).toBeLessThanOrEqual(MIN_RADIUS / 2);
    // And it is small enough to be irrelevant next to a voxel.
    expect(difference).toBeLessThan(1e-3);
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
      { type: "Capsule", len: 4, radius: 2 },
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

// ---------------------------------------------------------------------------
// The table itself
// ---------------------------------------------------------------------------

/**
 * Every primitive, with parameters chosen so that **no two entries have the same
 * extents**. A sweep that used one size for everything would pass a table where two
 * entries had quietly swapped their distance functions, because the shapes are then
 * indistinguishable at that size.
 */
const SAMPLES: Record<ShapeType, OperationShape> = {
  Sphere: { type: "Sphere", radius: 1.7 },
  Ellipsoid: { type: "Ellipsoid", radius: { x: 3, y: 1.4, z: 2.2 } },
  Box: { type: "Box", len: { x: 2, y: 1, z: 3 } },
  RoundBox: { type: "RoundBox", len: { x: 2, y: 1, z: 3 }, radius: 0.6 },
  Capsule: { type: "Capsule", len: 4, radius: 0.9 },
  Cone: { type: "Cone", len: 4, radius: 1.5 },
  Cylinder: { type: "Cylinder", len: 4, radius: 1.5 },
  Torus: { type: "Torus", majorRadius: 2.4, minorRadius: 0.7 },
  HexPrism: { type: "HexPrism", len: 4, radius: 1.6 },
};

/**
 * A unit vector from an index, by the Fibonacci spiral.
 *
 * **Deterministic, and evenly spread.** An even spread is the point: a distance
 * function can be correct in most directions and wrong at one corner, and a
 * pseudo-random sample would find it about half the time. The spiral covers the
 * sphere to within a couple of degrees for a few hundred points.
 */
const direction = (i: number, n: number): Vec3 => {
  const y = 1 - (2 * i + 1) / n;
  const radial = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return { x: Math.cos(theta) * radial, y, z: Math.sin(theta) * radial };
};

describe("the primitive table", () => {
  it("has one entry per primitive, and the entry agrees with its key", () => {
    // **The property the single cast in `specOf` relies on.** `sdShape` looks a shape up
    // by `shape.type` and hands the result back as a `PrimitiveSpec`, so a table whose
    // keys and `type` fields disagreed would dispatch to the wrong distance function
    // with nothing to report it. That is why this is asserted rather than typed: the
    // nine entries have nine different function types, so no `satisfies` clause can
    // express it.
    expect(PRIMITIVE_NAMES.length).toBe(Object.keys(SAMPLES).length);
    for (const name of PRIMITIVE_NAMES) {
      expect(PRIMITIVES[name].type, name).toBe(name);
      expect(SAMPLES[name], `${name} has no sample`).toBeDefined();
    }
  });

  it("gives every primitive a distinct type byte", () => {
    const codes = PRIMITIVE_NAMES.map((name) => PRIMITIVES[name].code);
    expect(new Set(codes).size, codes.join(",")).toBe(codes.length);
    // A file's type byte is the one field the arithmetic around it cannot validate,
    // so two primitives sharing one would parse a shape into a different shape.
    for (const code of codes) expect(code).toBeLessThan(256);
  });

  it("keeps the three original primitives on their original bytes", () => {
    // Ellipsoid, Box and Capsule were 0, 1 and 2 in format version 1. Retiring and
    // reusing those bytes would make a version 2 file unreadable in a way that parses
    // into plausible numbers, so the table pins them.
    expect(PRIMITIVES.Ellipsoid.code).toBe(0);
    expect(PRIMITIVES.Box.code).toBe(1);
    expect(PRIMITIVES.Capsule.code).toBe(2);
  });

  it("finds a primitive by its type byte, and refuses one it does not have", () => {
    for (const name of PRIMITIVE_NAMES) {
      expect(primitiveFromCode(PRIMITIVES[name].code), name).toBe(name);
    }
    // 9 is the first unused byte. A forward lookup must report the gap rather than
    // read a neighbouring entry.
    expect(primitiveFromCode(9)).toBeNull();
    expect(primitiveFromCode(255)).toBeNull();
  });

  it("claims to be exact everywhere except the ellipsoid", () => {
    // The flag exists for a second application that sphere-traces. If a primitive
    // were ever added that is not a true distance, this is where it gets declared —
    // and the assertion below is what stops the flag being decorative.
    const inexact = PRIMITIVE_NAMES.filter((name) => !PRIMITIVES[name].exact);
    expect(inexact).toEqual(["Ellipsoid"]);
  });

  /**
   * The primitives whose surface is reachable by a single ray from the origin.
   *
   * **Everything except the torus, and the torus is not a defect.** A torus has a
   * hole through it, so a ray from its centre along the plane of the ring passes
   * *outside* the solid, then inside the tube, then outside again: two crossings,
   * and no amount of bisection finds "the" surface from there.
   *
   * It matters because it is what a sphere tracer has to know. For meshing and for
   * picking this is irrelevant — the field is evaluated pointwise and the surface is
   * the zero set — so the torus is a normal member of this table. But a tracer
   * marching from *inside* the bounding box has no well-defined first crossing, and
   * `exact: true` does not mean "star-shaped". The test below is why that is a
   * written fact and not a surprise.
   */
  const STAR_SHAPED = PRIMITIVE_NAMES.filter((name) => name !== "Torus");

  it("crosses zero exactly once along every ray from the origin", () => {
    // Star-shaped about the origin, which is what makes `halfExtents` a usable index:
    // a ray from the origin meets the surface once, so the distance is a usable step
    // and the AABB is a usable bound. Two crossings would mean the ray passes through
    // a dimple and the BVH's box would have to cover the far side too.
    for (const name of STAR_SHAPED) {
      const shape = SAMPLES[name];
      const half = primitiveHalfExtents(shape);
      const reach = 4 * Math.max(half.x, half.y, half.z);
      for (let i = 0; i < 16; i++) {
        const d = direction(i, 16);
        const steps = 400;
        let crossings = 0;
        let previous = sdShape(shape, {
          x: d.x * reach,
          y: d.y * reach,
          z: d.z * reach,
        });
        expect(previous, `${name} should be positive far out`).toBeGreaterThan(
          0,
        );
        // Down to the origin only. Marching past it would find the far side as a
        // second crossing, which is correct and is not the property under test.
        for (let step = 1; step >= 0; step -= reach / steps) {
          const value = sdShape(shape, {
            x: d.x * step * reach,
            y: d.y * step * reach,
            z: d.z * step * reach,
          });
          if (previous > 0 !== value > 0) crossings++;
          previous = value;
        }
        expect(crossings, `${name} along (${d.x}, ${d.y}, ${d.z})`).toBe(1);
        expect(
          previous,
          `${name} should be negative at its own centre`,
        ).toBeLessThan(0);
      }
    }
  });

  it("gives every primitive a distance that is zero on its own surface", () => {
    // Found by bisecting along a ray from the origin — which needs the star-shaped
    // property, so the torus is checked by its own exact surface points instead
    // (see below) and excluded here rather than quietly passed.
    for (const name of STAR_SHAPED) {
      const shape = SAMPLES[name];
      const half = primitiveHalfExtents(shape);
      const reach = 4 * Math.max(half.x, half.y, half.z);
      for (let i = 0; i < 24; i++) {
        const d = direction(i, 24);
        let lo = 0;
        let hi = reach;
        for (let step = 0; step < 60; step++) {
          const mid = (lo + hi) / 2;
          if (sdShape(shape, { x: d.x * mid, y: d.y * mid, z: d.z * mid }) < 0)
            lo = mid;
          else hi = mid;
        }
        expect(
          Math.abs(sdShape(shape, { x: d.x * hi, y: d.y * hi, z: d.z * hi })),
          name,
        ).toBeLessThan(1e-5);
      }
    }
  });

  it("puts the torus's exact surface points on its zero set", () => {
    // A torus's surface has a closed form the other way round: sweep the tube's own
    // circle around the ring. No search, so this is exact to the precision the points
    // are generated at, and it does not rely on the shape being star-shaped.
    const shape = SAMPLES.Torus;
    const major = 2.4;
    const minor = 0.7;
    for (let i = 0; i < 200; i++) {
      const theta = (2 * Math.PI * i) / 200;
      for (let j = 0; j < 20; j++) {
        const phi = (2 * Math.PI * j) / 20;
        const radial = major + minor * Math.cos(phi);
        expect(
          Math.abs(
            sdShape(shape, {
              x: radial * Math.cos(theta),
              y: minor * Math.sin(phi),
              z: radial * Math.sin(theta),
            }),
          ),
          `torus at theta=${theta.toFixed(3)} phi=${phi.toFixed(3)}`,
        ).toBeLessThan(1e-6);
      }
    }
  });

  it("has a gradient of unit length outside every exact primitive", () => {
    // **The property meshing actually depends on.** Surface Nets places a vertex by
    // walking the gradient towards the sign change, so a gradient that is not of
    // length one moves a vertex by the wrong amount and the surface lands in the
    // wrong place. Measured as a central difference away from the surface, where the
    // field is smooth.
    //
    // The ellipsoid is excluded because it is the entry whose `exact` flag is false,
    // and this is the test that makes the flag mean something: its gradient measured
    // 0.948 where an exact distance gives 1.000, which is a 5% error in where a
    // mesher places every vertex on an ellipsoid.
    const h = 1e-5;
    for (const name of PRIMITIVE_NAMES.filter((n) => PRIMITIVES[n].exact)) {
      const shape = SAMPLES[name];
      const half = primitiveHalfExtents(shape);
      for (let i = 0; i < 12; i++) {
        const d = direction(i, 12);
        // A point well outside, so the finite difference is not straddling an edge.
        const at = {
          x: d.x * (2.5 * half.x + 1),
          y: d.y * (2.5 * half.y + 1),
          z: d.z * (2.5 * half.z + 1),
        };
        const gx =
          (sdShape(shape, { ...at, x: at.x + h }) -
            sdShape(shape, { ...at, x: at.x - h })) /
          (2 * h);
        const gy =
          (sdShape(shape, { ...at, y: at.y + h }) -
            sdShape(shape, { ...at, y: at.y - h })) /
          (2 * h);
        const gz =
          (sdShape(shape, { ...at, z: at.z + h }) -
            sdShape(shape, { ...at, z: at.z - h })) /
          (2 * h);
        const magnitude = Math.hypot(gx, gy, gz);
        expect(
          Math.abs(magnitude - 1),
          `${name} gradient length ${magnitude.toFixed(6)}`,
        ).toBeLessThan(1e-3);
      }
    }
  });

  it("never over-reports the distance for any primitive", () => {
    // The safe direction for a sphere tracer: stepping by `sd` lands short of the
    // surface, never past it. Checked for all nine rather than just the ellipsoid,
    // because this is what a second application will rely on when `exact: true` means
    // it may step by the value it is handed.
    //
    // **The bound is an upper bound on the true distance, found by walking inward.**
    // Any point strictly inside the solid is at most `D` from our starting point
    // along a path of length `D`, and the distance to the surface is no more than
    // that — so finding an interior point gives a ceiling, and `sd <= ceiling` is the
    // assertion. It is deliberately the easy direction to compute: an exact nearest
    // surface point needs constrained optimisation, and a ceiling needs a walk.
    for (const name of PRIMITIVE_NAMES) {
      const shape = SAMPLES[name];
      const half = primitiveHalfExtents(shape);
      const reach = 4 * Math.max(half.x, half.y, half.z);
      let checked = 0;
      for (let i = 0; i < 48; i++) {
        const d = direction(i, 48);
        for (const factor of [1.5, 2, 3]) {
          const p = {
            x: d.x * reach * factor * 0.25,
            y: d.y * reach * factor * 0.25,
            z: d.z * reach * factor * 0.25,
          };
          const reported = sdShape(shape, p);
          if (reported <= 0) continue;
          // Walk towards the origin, which is inside every primitive here, and stop
          // at the first interior point. The torus is inside its own hole, so a
          // point in the hole never finds one — those cases are counted rather than
          // skipped quietly.
          let found = Infinity;
          for (let step = 1; step <= 2000; step++) {
            const t = (step / 2000) * reach * factor * 0.25;
            if (sdShape(shape, { x: d.x * t, y: d.y * t, z: d.z * t }) < 0) {
              found = reach * factor * 0.25 - t;
              break;
            }
          }
          if (found === Infinity) continue;
          checked++;
          expect(
            reported,
            `${name} over-reports at ${factor}/4 of reach`,
          ).toBeLessThanOrEqual(found + 1e-6);
        }
      }
      // Every primitive must have contributed, or this loop is quietly vacuous for it.
      expect(
        checked,
        `${name} contributed no over-report cases`,
      ).toBeGreaterThan(20);
    }
  });

  it("keeps every primitive's distance finite at a degenerate size", () => {
    // A scale-to-zero in a transform panel, or a file written by a build with a
    // different `MIN_RADIUS`. A NaN in a field propagates through every comparison as
    // false and produces a hole nothing downstream can explain.
    for (const name of PRIMITIVE_NAMES) {
      const spec = PRIMITIVES[name];
      const degenerate: Record<string, unknown> = { type: name };
      for (const parameter of spec.parameters) {
        degenerate[parameter.name] =
          parameter.arity === 3 ? { x: 0, y: 0, z: 0 } : 0;
      }
      const shape = degenerate as OperationShape;
      expect(Number.isFinite(sdShape(shape, { x: 5, y: 0, z: 0 })), name).toBe(
        true,
      );
      expect(Number.isFinite(sdShape(shape, { x: 0, y: 0, z: 0 })), name).toBe(
        true,
      );
      expect(primitiveHalfExtents(shape).x >= 0, name).toBe(true);
    }
  });

  it("round-trips through the flat parameter list", () => {
    // The serialiser reads and writes floats and nothing else, so this is the only
    // place a parameter name can be wrong in a way that parses into plausible
    // numbers: a length where a radius was written, read back as a length, and every
    // operation silently the wrong size.
    for (const name of PRIMITIVE_NAMES) {
      const shape = SAMPLES[name];
      const floats = parametersToFloats(shape);
      expect(floats.length, name).toBe(parameterFloats(shape));
      expect(shapeFromFloats(name, floats), name).toEqual(shape);
    }
  });

  it("has no parameter a primitive does not declare, and declares all it has", () => {
    // Both directions. A parameter in the table but not on the shape would read
    // `undefined` into the file; a field on the shape but not in the table would be
    // silently dropped on save, which is the one that loses a user's work.
    for (const name of PRIMITIVE_NAMES) {
      const declared = PRIMITIVES[name].parameters.map((p) => p.name).sort();
      const present = Object.keys(SAMPLES[name])
        .filter((key) => key !== "type")
        .sort();
      expect(
        present,
        `${name} carries a field the table does not declare`,
      ).toEqual(declared);
    }
  });

  it("pads every primitive's box by the same softness and slack", () => {
    // `halfExtents` carries each primitive's own extent, so what is left to allow
    // for is the softness reach and one unit of slack — and that is the same for all
    // nine. A primitive whose padding differed would be a primitive the BVH could
    // index wrongly, so this is asserted per primitive rather than once.
    for (const name of PRIMITIVE_NAMES) {
      expect(shapePadding(SAMPLES[name], 0), name).toBe(1);
      expect(shapePadding(SAMPLES[name], 0.5), name).toBe(3);
    }
  });

  it("indexes each primitive by a box that contains it", () => {
    // The one property `halfExtents` exists for. Sampled on a dense sphere of surface
    // directions: a primitive whose extent was reported too small would leave part of
    // its surface outside the box the BVH indexes, and that is a hole in the mesh that
    // no other test in this repository would notice.
    for (const name of PRIMITIVE_NAMES) {
      const shape = SAMPLES[name];
      const half = primitiveHalfExtents(shape);
      let worst = 0;
      for (let i = 0; i < 400; i++) {
        const d = direction(i, 400);
        // Step out to the surface along this ray, then check the hit point's extent.
        let lo = 0;
        let hi = 4 * Math.max(half.x, half.y, half.z);
        for (let step = 0; step < 60; step++) {
          const mid = (lo + hi) / 2;
          if (sdShape(shape, { x: d.x * mid, y: d.y * mid, z: d.z * mid }) < 0)
            lo = mid;
          else hi = mid;
        }
        const p = { x: d.x * hi, y: d.y * hi, z: d.z * hi };
        worst = Math.max(
          worst,
          Math.abs(p.x) - half.x,
          Math.abs(p.y) - half.y,
          Math.abs(p.z) - half.z,
        );
      }
      expect(
        worst,
        `${name} surface escapes its half extents by ${worst}`,
      ).toBeLessThan(1e-5);
    }
  });
});

/**
 * The panel metadata.
 *
 * **Checked here rather than trusted, because a missing label is not a compile error and a
 * panel that renders `undefined` as a field name is worse than one that refuses to open.**
 * These are the only guarantees a consumer of `parameters` has, and the table is data, so
 * data is what has to be checked.
 */
describe("parameter metadata", () => {
  const everyParameter = () =>
    PRIMITIVE_NAMES.flatMap((type) =>
      primitiveParameters({ type } as OperationShape).map((parameter) => ({
        type,
        parameter,
      })),
    );

  it("gives every parameter a label", () => {
    for (const { type, parameter } of everyParameter()) {
      expect(
        parameter.label.trim(),
        `${type}.${parameter.name} has no label`,
      ).not.toBe("");
    }
  });

  it("names three axes for a vec3 and none for a number", () => {
    for (const { type, parameter } of everyParameter()) {
      if (parameter.arity === 3) {
        expect(
          parameter.axes?.length,
          `${type}.${parameter.name} is a vec3 with no axis names`,
        ).toBe(3);
        for (const axis of parameter.axes ?? [])
          expect(
            axis.trim(),
            `${type}.${parameter.name} has a blank axis`,
          ).not.toBe("");
      } else {
        expect(
          parameter.axes,
          `${type}.${parameter.name} is a number and should not name axes`,
        ).toBeUndefined();
      }
    }
  });

  it("keeps every size non-negative and every step positive", () => {
    for (const { type, parameter } of everyParameter()) {
      expect(
        parameter.min,
        `${type}.${parameter.name} allows a negative size`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        parameter.step,
        `${type}.${parameter.name} has a non-positive step`,
      ).toBeGreaterThan(0);
    }
  });

  it("does not label the same field the same way twice for one shape", () => {
    // A RoundBox's `radius` is its corner and a Capsule's `radius` is its size. Two
    // parameters in one shape sharing a label would put two identical-looking inputs on
    // screen for two different numbers.
    for (const type of PRIMITIVE_NAMES) {
      const labels = primitiveParameters({ type } as OperationShape).map(
        (parameter) => parameter.label,
      );
      expect(new Set(labels).size, `${type} has a repeated label`).toBe(
        labels.length,
      );
    }
  });

  it("agrees with the file format about how many floats a shape has", () => {
    for (const type of PRIMITIVE_NAMES) {
      const shape = { type } as OperationShape;
      const fromMetadata = primitiveParameters(shape).reduce(
        (total, parameter) => total + parameter.arity,
        0,
      );
      expect(
        fromMetadata,
        `${type} metadata and parameterFloats disagree`,
      ).toBe(parameterFloats(shape));
    }
  });
});

/**
 * The editor's view of a shape.
 *
 * **`dimensionGroups` is the only thing standing between a table entry and a rendered input,
 * and the panel is a loop over it.** So what is checked here is what a panel would show: the
 * number of inputs, what each is called, and — for `withParameter` — that an edit arrives as
 * a new object, because a store that compares by identity cannot see an in-place change.
 */
describe("dimension groups", () => {
  const groupsOf = (shape: OperationShape) => dimensionGroups(shape);

  it("gives every shape at least one field and never two per parameter", () => {
    for (const type of PRIMITIVE_NAMES) {
      const groups = groupsOf(SAMPLES[type]);
      expect(groups.length, `${type} has no dimensions`).toBeGreaterThan(0);
      for (const group of groups) {
        expect(
          [1, 3],
          `${type}.${group.name} has ${group.fields.length} fields`,
        ).toContain(group.fields.length);
      }
    }
  });

  it("reads a capsule's two numbers", () => {
    const groups = groupsOf({ type: "Capsule", len: 2.2, radius: 0.7 });
    expect(groups.map((group) => group.label)).toEqual(["Length", "Radius"]);
    expect(
      groups.flatMap((group) => group.fields.map((field) => field.value)),
    ).toEqual([2.2, 0.7]);
  });

  it("reads a box as one group of three named axes", () => {
    const groups = groupsOf({ type: "Box", len: { x: 1, y: 2, z: 3 } });
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.label).toBe("Size");
    expect(group.fields.map((field) => field.label)).toEqual([
      "Width",
      "Height",
      "Depth",
    ]);
    expect(group.fields.map((field) => field.value)).toEqual([1, 2, 3]);
    // A `Vec3` component is an axis, not a parameter of its own.
    expect(group.fields.map((field) => field.axis)).toEqual(["x", "y", "z"]);
  });

  it("leaves a scalar without an axis", () => {
    const [group] = groupsOf({ type: "Sphere", radius: 1 });
    expect(group?.fields[0]?.axis).toBeUndefined();
  });

  it("agrees with the table's arity on which is which", () => {
    for (const type of PRIMITIVE_NAMES) {
      const shape = SAMPLES[type];
      const arity = new Map(
        primitiveParameters(shape).map((parameter) => [
          parameter.name,
          parameter.arity,
        ]),
      );
      for (const group of groupsOf(shape)) {
        expect(
          group.fields.length,
          `${type}.${group.name} disagrees with its own arity`,
        ).toBe(arity.get(group.name));
      }
    }
  });
});

describe("withParameter", () => {
  it("replaces a scalar without touching the rest", () => {
    const shape: OperationShape = { type: "Capsule", len: 2.2, radius: 0.7 };
    expect(withParameter(shape, "len", undefined, 3.5)).toEqual({
      type: "Capsule",
      len: 3.5,
      radius: 0.7,
    });
  });

  it("replaces one component of a vec3", () => {
    const shape: OperationShape = { type: "Box", len: { x: 1, y: 2, z: 3 } };
    expect(withParameter(shape, "len", "y", 9)).toEqual({
      type: "Box",
      len: { x: 1, y: 9, z: 3 },
    });
  });

  it("returns a new object, because identity is how an edit is seen", () => {
    const shape: OperationShape = { type: "Capsule", len: 2.2, radius: 0.7 };
    expect(withParameter(shape, "len", undefined, 2.2)).not.toBe(shape);
    // Even a write of the same value is a new object, so the store can decide for itself
    // whether the numbers actually changed.
    expect(
      withParameter({ type: "Box", len: { x: 1, y: 1, z: 1 } }, "len", "x", 1),
    ).not.toBe(shape);
  });

  it("leaves the original alone", () => {
    const shape: OperationShape = { type: "Box", len: { x: 1, y: 2, z: 3 } };
    withParameter(shape, "len", "z", 30);
    expect(shape).toEqual({ type: "Box", len: { x: 1, y: 2, z: 3 } });
  });

  it("returns the shape itself for a parameter it does not have", () => {
    // The read side and the write side have to agree about what a shape contains, or an
    // editor can render a field it cannot write.
    const shape: OperationShape = { type: "Sphere", radius: 1 };
    expect(withParameter(shape, "majorRadius", undefined, 2)).toBe(shape);
  });
});
