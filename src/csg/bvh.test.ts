import { describe, expect, it } from "vitest";

import { OperationBVH } from "./bvh";
import {
  boundsContain,
  conjugate,
  foldOperations,
  indexOperation,
  type IndexedOperation,
  makeOperation,
  operationBounds,
  operationDistance,
  rotate,
  smoothMax,
  smoothMin,
  type Operation,
} from "./operations";
import { FAR_DISTANCE, type Quat, type Vec3 } from "../constants";
import type { OperationShape } from "./shapes";

/** A deterministic sequence, so a randomised failure can be reproduced. */
let seed = 0x51f3a7c;
const next = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const randomVector = (scale: number): Vec3 => ({
  x: (next() * 2 - 1) * scale,
  y: (next() * 2 - 1) * scale,
  z: (next() * 2 - 1) * scale,
});

/** A random unit quaternion, by normalising four uniform components. */
const randomRotation = (): Quat => {
  const q = {
    x: next() * 2 - 1,
    y: next() * 2 - 1,
    z: next() * 2 - 1,
    w: next() * 2 - 1,
  };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
};

const randomOperation = (index: number): Operation =>
  makeOperation(
    index,
    randomVector(500),
    next() < 0.34
      ? {
          type: "Ellipsoid",
          radius: {
            x: 40 + next() * 200,
            y: 40 + next() * 200,
            z: 40 + next() * 200,
          },
        }
      : next() < 0.5
        ? {
            type: "Box",
            len: {
              x: 30 + next() * 150,
              y: 30 + next() * 150,
              z: 30 + next() * 150,
            },
          }
        : { type: "Capsule", lenX: next() * 300, radius: 20 + next() * 120 },
    next() < 0.3 ? "Subtract" : "Add",
    {
      softness: next() < 0.3 ? next() * 0.2 : 0,
      orientation: randomRotation(),
    },
  );

/**
 * What a field must answer, computed with no tree, no cache, no skipping and no
 * candidate cache — and with the same saturation the real fold applies, because a
 * reference that disagrees with the definition it is checking cannot tell whether
 * the implementation or the reference is wrong.
 */
const bruteForce = (operations: readonly Operation[], p: Vec3): number => {
  let field = FAR_DISTANCE;
  for (const operation of operations) {
    if (operation.combine === "Paint") continue;
    const indexed = {
      operation,
      bounds: operationBounds(operation),
      inverseRotation: conjugate(operation.orientation),
    };
    const distance = operationDistance(indexed, p);
    field = Math.min(
      operation.combine === "Add"
        ? smoothMin(field, distance, operation.softness * 4)
        : smoothMax(field, -distance, operation.softness * 4),
      FAR_DISTANCE,
    );
  }
  return field;
};

/** The same fold with no saturation, for the assertions about the saturation. */
const bruteForceUnsaturated = (
  operations: readonly Operation[],
  p: Vec3,
): number => {
  let field = FAR_DISTANCE;
  for (const operation of operations) {
    if (operation.combine === "Paint") continue;
    const indexed = {
      operation,
      bounds: operationBounds(operation),
      inverseRotation: conjugate(operation.orientation),
    };
    const distance = operationDistance(indexed, p);
    field =
      operation.combine === "Add"
        ? smoothMin(field, distance, operation.softness * 4)
        : smoothMax(field, -distance, operation.softness * 4);
  }
  return field;
};

describe("quaternions", () => {
  it("rotates a vector and returns it to where it started when repeated", () => {
    const q = randomRotation();
    const v = randomVector(100);
    const once = rotate(v, q);
    expect(Math.hypot(once.x, once.y, once.z)).toBeCloseTo(
      Math.hypot(v.x, v.y, v.z),
      10,
    );
    const back = rotate(once, conjugate(q));
    expect(back.x).toBeCloseTo(v.x, 9);
    expect(back.y).toBeCloseTo(v.y, 9);
    expect(back.z).toBeCloseTo(v.z, 9);
  });

  it("leaves the identity alone", () => {
    const v = { x: 1, y: -2, z: 3 };
    const out = rotate(v, { x: 0, y: 0, z: 0, w: 1 });
    expect(out.x).toBe(1);
    expect(out.y).toBe(-2);
    expect(out.z).toBe(3);
  });
});

describe("operation bounds", () => {
  it("contains every point of the shape it holds", () => {
    // The index box missing part of its own shape would drop the operation
    // wherever that part is, and the surface would have a hole shaped like the
    // operation rather than like an error.
    for (const shape of [
      { type: "Ellipsoid", radius: { x: 30, y: 12, z: 70 } },
      { type: "Box", len: { x: 20, y: 40, z: 10 } },
      { type: "Capsule", lenX: 120, radius: 25 },
    ] as const) {
      const operation = makeOperation(0, { x: 7, y: -3, z: 11 }, shape, "Add");
      const bounds = operationBounds(operation);
      for (const point of shapeSurfacePoints(shape)) {
        const world = { x: point.x + 7, y: point.y - 3, z: point.z + 11 };
        expect(
          boundsContain(bounds, world),
          `${shape.type} ${JSON.stringify(world)}`,
        ).toBe(true);
      }
    }
  });

  it("contains the origin even for a shape with no extent", () => {
    const operation = makeOperation(
      0,
      { x: 5, y: 5, z: 5 },
      { type: "Capsule", lenX: 0, radius: 0 },
      "Add",
    );
    expect(
      boundsContain(operationBounds(operation), { x: 5, y: 5, z: 5 }),
    ).toBe(true);
  });

  it("grows by four times the softness, so a soft blend is not clipped", () => {
    const hard = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 10, y: 10, z: 10 } },
      "Add",
    );
    const soft = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 10, y: 10, z: 10 } },
      "Add",
      {
        softness: 0.2,
      },
    );
    const hardReach = operationBounds(hard).max.x - 10;
    const softReach = operationBounds(soft).max.x - 10;
    expect(softReach - hardReach).toBeCloseTo(0.8, 6);
  });

  it("follows the operation's rotation", () => {
    // A quarter turn about y swaps the x and z half-extents. A box that kept its
    // axis-aligned box would be indexed wrongly for every rotated primitive, which
    // is every primitive the user places by hand.
    const quarter: Quat = { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
    const operation = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 100, y: 10, z: 5 } },
      "Add",
      {
        orientation: quarter,
      },
    );
    const bounds = operationBounds(operation);
    expect(bounds.max.x).toBeCloseTo(5 + 1, 6);
    expect(bounds.max.z).toBeCloseTo(100 + 1, 6);
    expect(bounds.max.y).toBeCloseTo(10 + 1, 6);
  });
});

describe("the smooth booleans", () => {
  it("reduces to the hard boolean at zero softness", () => {
    for (const [a, b] of [
      [1, 2],
      [-3, 5],
      [0, 0],
      [100, -100],
    ]) {
      expect(smoothMin(a, b, 0)).toBe(Math.min(a, b));
      expect(smoothMax(a, b, 0)).toBe(Math.max(a, b));
    }
  });

  it("is the hard boolean when the two are further apart than the blend band", () => {
    // Smoothness only reaches across `k`. Beyond it the answer must be exactly the
    // hard one, or two surfaces that are nowhere near each other would still pull
    // each other and the model would look inflated.
    const k = 4;
    expect(smoothMin(0, 10, k)).toBe(0);
    expect(smoothMax(0, -10, k)).toBe(0);
  });

  it("is continuous across the band, with no step where the two meet", () => {
    // Continuity is the whole reason a smooth boolean exists. A jump would put a
    // crease in the surface along a line no brush drew, and the mesher would render
    // it as a visible edge.
    const k = 4;
    let previous = smoothMin(0, k, k);
    for (let t = k; t > -k; t -= 0.01) {
      const value = smoothMin(0, t, k);
      expect(Math.abs(value - previous)).toBeLessThan(0.2);
      previous = value;
    }
  });

  it("is symmetric, and never worse than the hard minimum", () => {
    for (const [a, b] of [
      [1, 2],
      [-1, 3],
      [2, -1],
    ]) {
      expect(smoothMin(a, b, 4)).toBeCloseTo(smoothMin(b, a, 4), 12);
      expect(smoothMin(a, b, 4)).toBeLessThanOrEqual(Math.min(a, b));
      expect(smoothMax(a, b, 4)).toBeGreaterThanOrEqual(Math.max(a, b));
    }
  });

  it("subtracts by taking the smooth maximum of the field and the negated shape", () => {
    // A subtraction removes material, so it must be tested against something there
    // is to remove: a lone `Subtract` in empty space correctly does nothing, and a
    // test that expected it to reach out and create material would be asserting a
    // bug.
    const solid = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 100, y: 100, z: 100 } },
      "Add",
    );
    const carve = makeOperation(
      1,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 10, y: 10, z: 10 } },
      "Subtract",
    );
    const inside = [solid, carve].map(indexOperation);

    // In the big box but outside the small one: still solid, so still negative.
    expect(foldOperations(inside, { x: 50, y: 0, z: 0 }, 100)).toBeLessThan(0);
    // Inside both: carved out, so the field is now outside — positive.
    expect(foldOperations(inside, { x: 0, y: 0, z: 0 }, 100)).toBeGreaterThan(
      0,
    );
    // Outside both: unchanged.
    expect(foldOperations(inside, { x: 300, y: 0, z: 0 }, 100)).toBe(100);
    // And the carve is exactly the negated distance of the small box.
    expect(foldOperations(inside, { x: 0, y: 0, z: 0 }, 100)).toBeCloseTo(
      10,
      9,
    );
  });

  it("ignores a paint operation entirely, on the field", () => {
    const paint = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 50, y: 50, z: 50 } },
      "Paint",
      {
        colour: { r: 255, g: 0, b: 0 },
      },
    );
    const indexed = {
      operation: paint,
      bounds: operationBounds(paint),
      inverseRotation: paint.orientation,
    };
    expect(foldOperations([indexed], { x: 0, y: 0, z: 0 }, 42)).toBe(42);
  });
});

describe("the bounding volume hierarchy", () => {
  it("matches a brute-force fold exactly, when nothing is soft", () => {
    // The load-bearing assertion. Every optimisation below — the tree, the bins,
    // the candidate cache, the per-operation box skip — has to leave the sum
    // unchanged, and each can be wrong in a way that shows up as a smooth surface
    // in one place and a hole in another rather than as an error.
    //
    // With every softness at zero there is no smooth dent anywhere, so the skip is
    // exact and the answer must be bit-identical rather than merely close. A
    // disagreement here means an operation is being skipped that should not be, or
    // counted twice.
    const hard = Array.from({ length: 240 }, (_, i) => {
      const operation = randomOperation(i);
      return { ...operation, softness: 0 };
    });
    const bvh = new OperationBVH(hard);

    for (let i = 0; i < 3000; i++) {
      const p = randomVector(900);
      expect(bvh.evalSDF(p.x, p.y, p.z), JSON.stringify(p)).toBe(
        bruteForce(hard, p),
      );
    }
  });

  it("matches a brute-force fold exactly, with soft operations too", () => {
    // Exactly, everywhere — not merely to within a bound near the surface. An
    // earlier version of this file accepted a small error in the far field on the
    // strength of an argument that the skip could not change a sign. That argument
    // was about soft blending only, and it missed the real bug: the box test was
    // dropping hard operations outright. The fold is now exact and is held to it.
    const soft = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(soft);

    for (let i = 0; i < 3000; i++) {
      const p = randomVector(900);
      expect(bvh.evalSDF(p.x, p.y, p.z), JSON.stringify(p)).toBeCloseTo(
        bruteForce(soft, p),
        9,
      );
    }
  });

  it("never changes the sign, however soft the operations are", () => {
    // The property the mesher and the picker actually depend on, asserted
    // separately from the value so that a failure names which one broke.
    const soft = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(soft);

    for (let i = 0; i < 4000; i++) {
      const p = randomVector(900);
      expect(Math.sign(bvh.evalSDF(p.x, p.y, p.z)), JSON.stringify(p)).toBe(
        Math.sign(bruteForce(soft, p)),
      );
    }
  });

  it("saturates the field, and never lets a subtraction push it past the sentinel", () => {
    // A subtraction is a maximum, so it can *raise* the field — and an unbounded
    // field is what forced the candidate cache to be sized by the model. Saturating
    // at `FAR_DISTANCE` bounds it, which is what lets the cache be sized by a
    // constant. This is a definitional change, so it is asserted directly rather
    // than left to be discovered by a test that compares two implementations.
    const ops = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(ops);
    let saturated = 0;
    for (let i = 0; i < 3000; i++) {
      const p = randomVector(900);
      const value = bvh.evalSDF(p.x, p.y, p.z);
      expect(value).toBeLessThanOrEqual(FAR_DISTANCE);
      if (value === FAR_DISTANCE) saturated++;
    }
    // And there is such a region — otherwise the clamp is dead code and the cache
    // argument rests on it having no effect.
    expect(saturated).toBeGreaterThan(0);
  });

  it("moves no sign change by saturating", () => {
    // The property the clamp has to keep for the mesher: saturation may only
    // change values in the far field, so the surface is where it was. Compared
    // against the unsaturated fold near zero, where the mesher interpolates.
    const ops = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(ops);

    let compared = 0;
    for (let i = 0; i < 8000 && compared < 400; i++) {
      const p = randomVector(900);
      const raw = bruteForceUnsaturated(ops, p);
      if (Math.abs(raw) > 2) continue;
      compared++;
      expect(bvh.evalSDF(p.x, p.y, p.z), JSON.stringify(p)).toBeCloseTo(raw, 9);
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("actually splits, rather than collapsing into one leaf", () => {
    // A silent regression guard. The split's cost estimate and the leaf's have to
    // be in the same units; when they were not, every split was refused, the tree
    // became a single leaf, and every query degenerated into a full scan of the
    // whole model — which is still *correct*, so nothing failed.
    const ops = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(ops);

    // A model this size, spread over a volume, must produce more than one node and
    // must not be one leaf.
    const root = treeRoot(bvh);
    expect(countNodes(root)).toBeGreaterThan(1);
    expect(root.items.length).toBeLessThan(ops.length);
  });

  it("keeps every node's bounds containing its own items", () => {
    // The other half of the tree's correctness. A node whose box does not contain
    // what it holds prunes that item away from queries it should have answered.
    const ops = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(ops);
    let seen = 0;
    const walk = (node: TreeNodeLike): void => {
      for (const item of node.items) {
        seen++;
        expect(item.bounds.min.x).toBeGreaterThanOrEqual(
          node.bounds.min.x - 1e-9,
        );
        expect(item.bounds.max.x).toBeLessThanOrEqual(node.bounds.max.x + 1e-9);
        expect(item.bounds.min.y).toBeGreaterThanOrEqual(
          node.bounds.min.y - 1e-9,
        );
        expect(item.bounds.max.y).toBeLessThanOrEqual(node.bounds.max.y + 1e-9);
        expect(item.bounds.min.z).toBeGreaterThanOrEqual(
          node.bounds.min.z - 1e-9,
        );
        expect(item.bounds.max.z).toBeLessThanOrEqual(node.bounds.max.z + 1e-9);
      }
      if (node.left !== null) walk(node.left);
      if (node.right !== null) walk(node.right);
    };
    walk(treeRoot(bvh));
    // Every operation is reachable exactly once.
    expect(seen).toBe(ops.length);
  });

  it("costs the same to sample a point however much model is elsewhere", () => {
    // What the cache is actually for. A chunk's cost has to depend on the chunk and
    // not on how much has been sculpted somewhere else — and a sculptor's second
    // hour is spent on one corner of the model, so "elsewhere" is where all the
    // operations accumulate.
    //
    // Adding a thousand operations a long way off must not change the candidate
    // count at a nearby point by even one. This is the property that failed when the
    // margin was sized by the model: the cache grew to hold everything, and a chunk's
    // cost scaled with the model instead of the chunk.
    const near = Array.from({ length: 40 }, (_, i) =>
      makeOperation(
        i,
        { x: next() * 100 - 50, y: next() * 100 - 50, z: next() * 100 - 50 },
        {
          type: "Ellipsoid",
          radius: { x: 20, y: 20, z: 20 },
        },
        "Add",
      ),
    );
    const probe = { x: 12, y: -7, z: 30 };

    const before = new OperationBVH(near).candidatesAt(probe).length;

    const distant = Array.from({ length: 1000 }, (_, i) =>
      makeOperation(
        100 + i,
        {
          x: 9000 + next() * 500,
          y: 9000 + next() * 500,
          z: 9000 + next() * 500,
        },
        {
          type: "Ellipsoid",
          radius: { x: 30, y: 30, z: 30 },
        },
        "Add",
      ),
    );
    const after = new OperationBVH([...near, ...distant]).candidatesAt(
      probe,
    ).length;

    expect(after).toBe(before);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(near.length + 1);
  });

  it("agrees exactly close to the surface, where the mesher interpolates", () => {
    // The exactness test above samples the whole volume, where most samples are far
    // from anything. This one samples where the field is near zero, which is the
    // only region a consumer reads finely — the mesher interpolates a crossing
    // between adjacent samples, so a small error there moves the surface itself.
    const soft = Array.from({ length: 240 }, (_, i) => randomOperation(i));
    const bvh = new OperationBVH(soft);

    let compared = 0;
    for (let i = 0; i < 8000 && compared < 400; i++) {
      const p = randomVector(900);
      if (Math.abs(bruteForce(soft, p)) > 2) continue;
      compared++;
      expect(bvh.evalSDF(p.x, p.y, p.z), JSON.stringify(p)).toBeCloseTo(
        bruteForce(soft, p),
        9,
      );
    }
    expect(compared).toBeGreaterThan(50);
  });

  it("is a function of position alone, with no memory of where it was asked", () => {
    // The property that lets two chunks either side of a level-of-detail boundary
    // agree: each samples the same function, at its own stride, and neither can be
    // influenced by what the other sampled. A field that depended on traversal order
    // would put a crack along every boundary in the world, and the difference would
    // be invisible in any single-chunk test.
    const operations = Array.from({ length: 160 }, (_, i) =>
      randomOperation(i),
    );
    const bvh = new OperationBVH(operations);
    const forward: Array<[Vec3, number]> = [];
    for (let i = 0; i < 400; i++) {
      const p = randomVector(320);
      forward.push([p, bvh.evalSDF(p.x, p.y, p.z)]);
    }
    // The same points, asked in reverse and interleaved with unrelated ones. The
    // candidate cache has been rebuilt many times over in between.
    for (const [p, expected] of [...forward].reverse()) {
      bvh.evalSDF(
        ...(Object.values(randomVector(900)) as [number, number, number]),
      );
      expect(bvh.evalSDF(p.x, p.y, p.z), JSON.stringify(p)).toBe(expected);
    }
  });

  it("returns only the operations whose boxes overlap a query", () => {
    const operations = Array.from({ length: 120 }, (_, i) =>
      randomOperation(i),
    );
    const bvh = new OperationBVH(operations);
    const box = {
      min: { x: -50, y: -50, z: -50 },
      max: { x: 50, y: 50, z: 50 },
    };
    const found = bvh.query(box);

    for (const candidate of bvh.operations) {
      const overlaps =
        candidate.bounds.min.x <= box.max.x &&
        candidate.bounds.max.x >= box.min.x &&
        candidate.bounds.min.y <= box.max.y &&
        candidate.bounds.max.y >= box.min.y &&
        candidate.bounds.min.z <= box.max.z &&
        candidate.bounds.max.z >= box.min.z;
      expect(
        found.includes(candidate),
        `found ${JSON.stringify(candidate.bounds)}`,
      ).toBe(overlaps);
    }
  });

  it("rebuilds its candidates only when a sample leaves the cached chunk", () => {
    // The property that makes a chunk's cost independent of the size of the model:
    // walking a chunk's 34,304 samples must not be 34,304 tree traversals.
    const operations = Array.from({ length: 500 }, (_, i) =>
      randomOperation(i),
    );
    const bvh = new OperationBVH(operations);
    const before = bvh.rebuilds;

    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        bvh.evalSDF(i * 4 - 40, j * 4 - 40, 0);
      }
    }
    // 400 samples inside one 320-unit chunk, so at most a couple of rebuilds: the
    // cache is one chunk wide and these are all within about 80 units of each
    // other.
    expect(bvh.rebuilds - before).toBeLessThan(4);
  });

  it("holds every paint operation out of the candidate cache", () => {
    // Paint operations do not change the distance, so leaving them in the cache
    // would make every sample on the model test against its entire paint history
    // for no effect.
    const operations = [
      makeOperation(
        0,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 5, y: 5, z: 5 } },
        "Add",
      ),
      makeOperation(
        1,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 900, y: 900, z: 900 } },
        "Paint",
      ),
    ];
    const bvh = new OperationBVH(operations);
    const candidates = bvh.candidatesAt({ x: 0, y: 0, z: 0 });
    expect(candidates).toHaveLength(1);
    expect(bvh.operations).toHaveLength(2);
  });

  it("reports every paint operation's colour, last one first", () => {
    const operations = [
      makeOperation(
        0,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 100, y: 100, z: 100 } },
        "Paint",
        {
          colour: { r: 255, g: 0, b: 0 },
        },
      ),
      makeOperation(
        1,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 50, y: 50, z: 50 } },
        "Paint",
        {
          colour: { r: 0, g: 255, b: 0 },
        },
      ),
    ];
    const bvh = new OperationBVH(operations);
    // Inside both: the later one wins.
    expect(bvh.evalPaint(0, 0, 0)).toEqual({ r: 0, g: 255, b: 0 });
    // Inside the first but outside the second, whose half-extent is 25 at this
    // point: only the earlier operation applies, and its colour stands.
    expect(bvh.evalPaint(60, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    // Outside both: nothing, which is what lets the caller fall through to a paint
    // tile and then to a default rather than this inventing a colour.
    expect(bvh.evalPaint(200, 0, 0)).toBeUndefined();
  });

  it("reports nothing for an empty model", () => {
    const bvh = new OperationBVH();
    expect(bvh.empty).toBe(true);
    expect(bvh.evalSDF(0, 0, 0)).toBe(100);
    expect(
      bvh.query({ min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } }),
    ).toHaveLength(0);
  });

  it("survives coincident operations, which is what a brush produces", () => {
    // Every dab of a hard stroke is the same primitive at the same place until the
    // stroke moves. Coincident centroids are the one input that can defeat a
    // splitting build, and a sculpting session produces them constantly.
    const operations = Array.from({ length: 200 }, (_, i) =>
      makeOperation(
        i,
        { x: 10, y: 10, z: 10 },
        { type: "Ellipsoid", radius: { x: 20, y: 20, z: 20 } },
        "Add",
      ),
    );
    const bvh = new OperationBVH(operations);
    expect(bvh.size).toBe(200);
    expect(bvh.evalSDF(10, 10, 10)).toBeCloseTo(-20, 9);
  });

  it("survives a single operation and two, which cannot be split", () => {
    for (const count of [0, 1, 2]) {
      const operations = Array.from({ length: count }, (_, i) =>
        randomOperation(i),
      );
      const bvh = new OperationBVH(operations);
      const p = randomVector(300);
      expect(bvh.evalSDF(p.x, p.y, p.z)).toBeCloseTo(
        bruteForce(operations, p),
        9,
      );
    }
  });
});

/** Points spread over a shape's surface, for the bounds assertions. */
const shapeSurfacePoints = (shape: OperationShape): Vec3[] => {
  const points: Vec3[] = [];
  if (shape.type === "Ellipsoid") {
    for (let i = 0; i < 8; i++) {
      const sign = (bit: number): number => (i & (1 << bit) ? 1 : -1);
      points.push({
        x: shape.radius.x * sign(0),
        y: shape.radius.y * sign(1),
        z: shape.radius.z * sign(2),
      });
    }
  } else if (shape.type === "Box") {
    for (let i = 0; i < 8; i++) {
      const sign = (bit: number): number => (i & (1 << bit) ? 1 : -1);
      points.push({
        x: shape.len.x * sign(0),
        y: shape.len.y * sign(1),
        z: shape.len.z * sign(2),
      });
    }
  } else {
    for (const x of [-shape.lenX / 2, 0, shape.lenX / 2]) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * Math.PI * 2;
        points.push({
          x,
          y: shape.radius * Math.cos(angle),
          z: shape.radius * Math.sin(angle),
        });
      }
    }
  }
  return points;
};

interface TreeNodeLike {
  bounds: { min: Vec3; max: Vec3 };
  items: IndexedOperation[];
  left: TreeNodeLike | null;
  right: TreeNodeLike | null;
}

/** Reaches into the tree, which is otherwise private, to assert its shape. */
const treeRoot = (bvh: OperationBVH): TreeNodeLike =>
  (bvh as unknown as { root: TreeNodeLike }).root;

const countNodes = (node: TreeNodeLike): number =>
  1 +
  (node.left !== null ? countNodes(node.left) : 0) +
  (node.right !== null ? countNodes(node.right) : 0);
