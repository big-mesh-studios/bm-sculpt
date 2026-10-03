import { describe, expect, it } from "vitest";

import {
  Field,
  DEFAULT_COLOUR,
  type BaseField,
  type PaintSource,
} from "./field";
import { OperationBVH } from "./bvh";
import { makeOperation, type Operation } from "./operations";
import { FAR_DISTANCE, type Bounds, type Vec3 } from "@big-mesh-studios/core";

const sphereAt = (
  centre: Vec3,
  radius: number,
  index = 0,
  softness = 0,
): Operation =>
  makeOperation(
    index,
    centre,
    {
      type: "Ellipsoid",
      radius: { x: radius, y: radius, z: radius },
    },
    "Add",
    { softness },
  );

/**
 * Sphere-traces a ray from `from` along `direction` until the field turns negative,
 * and returns how far it stepped — or `null` if it ran out of steps.
 *
 * Deliberately the crudest possible marcher: no bisection, no refinement, and the
 * step is the whole reported distance. It is crude because that is the only way to
 * test the *conservative stepping* property — a marcher that refines would land
 * correctly even when handed a distance that overshoots, and would hide the very
 * thing being checked.
 */
const trace = (
  field: Field,
  from: Vec3,
  direction: Vec3,
  maxSteps = 400,
  maxDistance = 40000,
): { steps: number; distance: number; endpoint: Vec3 } | null => {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  const step: Vec3 = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
  const at = (distance: number): Vec3 => ({
    x: from.x + step.x * distance,
    y: from.y + step.y * distance,
    z: from.z + step.z * distance,
  });
  // A tenth of a voxel, the same threshold the field's own gradient uses. Sphere
  // tracing converges geometrically onto the surface, so it approaches it without
  // ever crossing in exact arithmetic — a marcher that waits for a negative value
  // therefore runs forever at a tangency, and one that waits for exactly zero stalls
  // on the axis of a sphere, which is where every test ray below starts.
  const EPSILON = 0.1;
  let travelled = 0;
  for (let i = 0; i < maxSteps; i++) {
    const p = at(travelled);
    const d = field.distanceForStepping(p.x, p.y, p.z);
    if (d < EPSILON) return { steps: i, distance: travelled, endpoint: p };
    travelled += d;
    if (travelled > maxDistance) return null;
  }
  return null;
};

describe("the field's composition seam", () => {
  it("is the operations alone when there is no base field", () => {
    const withoutBase = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 100)]),
    );
    const withEmptyBase = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 100)]),
      {
        base: () => FAR_DISTANCE,
      },
    );
    expect(withoutBase.distance(0, 0, 0)).toBeCloseTo(-100, 9);
    expect(withEmptyBase.distance(0, 0, 0)).toBeCloseTo(-100, 9);
  });

  it("combines the base field first, so a brush carves into it", () => {
    // The order is the design: a subtraction has to dig into the ground, not pass
    // over it. Were the operations folded first and the base minimum'd in
    // afterwards, a carve would have no ground to remove.
    const ground: BaseField = (_x, y) => y;
    const bvh = new OperationBVH([
      makeOperation(
        0,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 40, y: 40, z: 40 } },
        "Subtract",
      ),
    ]);
    const field = new Field(bvh, { base: ground });

    // Inside the ground and inside the carve: the subtraction wins, so the field is
    // its negated distance — outside, i.e. a hole.
    expect(field.distance(0, 0, 0)).toBeGreaterThan(0);
    // Inside the ground and outside the carve: still solid. Below the surface, not
    // at it — a point exactly at y = 0 reads zero from `base` whatever else is
    // true, which says nothing about the composition.
    expect(field.distance(100, -10, 0)).toBeLessThan(0);
  });

  it("lets an operation replace a base field that reports nothing at all", () => {
    // A base field of "infinitely far" must not stop an operation from being added.
    const field = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 50)]),
      {
        base: () => Number.POSITIVE_INFINITY,
      },
    );
    expect(field.distance(0, 0, 0)).toBe(-50);
    // Saturated at the sentinel, which is what "infinitely far" means here — and
    // saturated even where no operation is a candidate at all, so that the answer
    // does not depend on where the operations happen to be.
    expect(field.distance(500, 0, 0)).toBe(FAR_DISTANCE);
    expect(field.distance(5000, 0, 0)).toBe(FAR_DISTANCE);
  });
});

describe("conservative stepping", () => {
  it("traces to the surface of a model made of exact distances", () => {
    const field = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 200)]),
    );
    const hit = trace(field, { x: 0, y: 500, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(hit).not.toBeNull();
    // Sphere tracing converges geometrically, so the reported distance lands just
    // short of the surface at 300 from the origin.
    expect(hit?.distance).toBeGreaterThan(280);
    expect(hit?.distance).toBeLessThanOrEqual(300);
  });

  it("does not step through a surface when the base field over-reports", () => {
    // **The Phase 1 gate.** A height field is not a distance function: it is exact
    // in one direction and over-reports in the others by whatever the terrain's
    // gradient is. Stepping by it unmodified marches straight through the ground,
    // and the picker then reports a surface on the far side of the model.
    //
    // Here the base field is `y * SLOPE`, whose true Lipschitz constant is `SLOPE`.
    // Scaled down by it, the field is a valid lower bound and the marcher stops at
    // the ground.
    const SLOPE = 6;
    // A slope in y only: a flat-ish plane with a gradient six times too steep to
    // be a distance. That is what a height field is.
    const steep: BaseField = (_x, y) => y * SLOPE;

    // No operations at all, so the ground is the only thing in the way.
    const unbounded = new Field(new OperationBVH([]), { base: steep });
    const bounded = new Field(new OperationBVH([]), {
      base: steep,
      lipschitz: 1 / SLOPE,
    });

    // Close to the ground, where it matters. The base reports six times the true
    // vertical distance; the saturation in the fold caps a step at
    // `FAR_DISTANCE`, which is further than the distance to the surface — so the
    // unbounded step lands *underneath* it.
    expect(unbounded.distanceForStepping(0, 50, 0)).toBeGreaterThan(50);
    const through = trace(
      unbounded,
      { x: 0, y: 50, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(through?.endpoint.y ?? 1).toBeLessThan(-1);

    // With the bound the step is the true distance, and it stops on the surface.
    expect(bounded.lipschitz).toBeCloseTo(1 / SLOPE, 12);
    expect(bounded.distanceForStepping(0, 50, 0)).toBeLessThanOrEqual(50);
    const stopped = trace(
      bounded,
      { x: 0, y: 50, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(stopped).not.toBeNull();
    expect(stopped?.endpoint.y ?? -1).toBeGreaterThan(-2);

    // And from far away it still converges on the ground rather than overshooting
    // it, which is the case a saturated step handles correctly and is worth
    // confirming separately.
    const fromAbove = trace(
      bounded,
      { x: 0, y: 900, z: 0 },
      { x: 0, y: -1, z: 0 },
    );
    expect(fromAbove).not.toBeNull();
    expect(fromAbove?.endpoint.y ?? -1).toBeGreaterThan(-2);
  });

  it("never reports a step longer than the distance to the surface, over a whole sweep", () => {
    // Swept rather than spot-checked, because a conservative bound that is wrong
    // only at particular angles or particular distances is the usual way one of
    // these turns out not to be conservative at all.
    const SLOPE = 4.5;
    const ground: BaseField = (x, y, z) =>
      (y - Math.sin(x / 60) * 30 - Math.cos(z / 70) * 25) * SLOPE;
    const ops = Array.from({ length: 12 }, (_, i) =>
      makeOperation(
        i,
        {
          x: (i % 4) * 90 - 135,
          y: 60 + i * 12,
          z: Math.floor(i / 4) * 90 - 90,
        },
        {
          type: "Ellipsoid",
          radius: { x: 30, y: 45, z: 30 },
        },
        i % 3 === 0 ? "Subtract" : "Add",
      ),
    );
    const field = new Field(new OperationBVH(ops), {
      base: ground,
      lipschitz: 1 / SLOPE,
    });

    for (let i = 0; i < 40; i++) {
      const angle = (i / 40) * Math.PI * 2;
      const from = {
        x: Math.cos(angle) * 900,
        y: 700,
        z: Math.sin(angle) * 900,
      };
      const towards = { x: -from.x, y: -700, z: -from.z };
      const hit = trace(field, from, towards, 400, 4000);

      if (hit === null) continue;
      // The ray stopped. It must have stopped *at* the surface rather than past it:
      // stepping by a distance that is not a lower bound lands with a negative value
      // several units beyond the crossing, and that overshoot is what this measures.
      const overshoot = -field.distance(
        hit.endpoint.x,
        hit.endpoint.y,
        hit.endpoint.z,
      );
      // Generous, because this bound is derived from the slope of a smooth surface
      // and the surface is sampled at a voxel a tenth of a step — not because the
      // property is approximate. A real violation is metres, not millimetres.
      expect(overshoot, JSON.stringify({ from, hit })).toBeLessThan(20);
    }
  });

  it("refuses a bound that would make the field over-report", () => {
    const bvh = new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 50)]);
    // A factor above one claims surfaces are further away than they are, which is
    // precisely the failure the bound exists to prevent — so it is clamped rather
    // than trusted.
    expect(new Field(bvh, { lipschitz: 4 }).lipschitz).toBe(1);
    expect(new Field(bvh, { lipschitz: 0 }).lipschitz).toBe(1);
    expect(new Field(bvh, { lipschitz: -2 }).lipschitz).toBe(1);
    expect(new Field(bvh, { lipschitz: 0.5 }).lipschitz).toBe(0.5);
  });
});

describe("whether a box could hold a surface", () => {
  const box = (minY: number, maxY: number) => ({
    min: { x: -100, y: minY, z: -100 },
    max: { x: 100, y: maxY, z: 100 },
  });
  const GROUND_LEVEL = box(1000, 2000);
  const BELOW = box(0, 100);
  const ABOVE = box(5000, 5200);
  const SKY = box(5900, 6100);
  /** A base field that knows only that the ground lies between 1000 and 2000. */
  const extent = {
    couldHoldSurface: (b: Bounds) => b.max.y >= 1000 && b.min.y <= 2000,
  };
  const floating = sphereAt({ x: 0, y: 6000, z: 0 }, 50);
  const elsewhere = sphereAt({ x: 9000, y: 9000, z: 9000 }, 50);

  it("cannot answer for itself, and says so by claiming every box", () => {
    // A field with no base field has nothing to bound, so it must not skip anything. This
    // is the operations-only world, and the behaviour it had before any of this existed.
    const field = new Field(new OperationBVH([]));
    expect(field.couldHoldSurface(BELOW)).toBe(true);
    expect(field.couldHoldSurface(ABOVE)).toBe(true);
  });

  it("believes a base field that says a box is empty", () => {
    const field = new Field(new OperationBVH([]), { extent });
    expect(field.couldHoldSurface(BELOW)).toBe(false);
    expect(field.couldHoldSurface(ABOVE)).toBe(false);
  });

  it("does not consult the operation list when the base field says yes", () => {
    // The common case, and it must stay cheap: a terrain world asks this for every chunk
    // of every frame, and the answer is two comparisons.
    const field = new Field(new OperationBVH([floating]), { extent });
    expect(field.couldHoldSurface(GROUND_LEVEL)).toBe(true);
  });

  it("keeps a box the base field calls empty when it holds an operation", () => {
    // **The failure this whole arrangement exists to prevent.** A sphere floating in the
    // sky is in a chunk the terrain says is nothing but air. Believing the terrain alone
    // deletes it, and nothing re-meshes it: the mesher that skipped the chunk recorded an
    // answer, so the hole is permanent and looks like a modelling bug.
    const field = new Field(new OperationBVH([floating]), { extent });
    expect(field.couldHoldSurface(SKY)).toBe(true);
  });

  it("still rules out a box that holds nothing at all", () => {
    // The other half: the answer has to be allowed to be `false`, or the gate saves nothing.
    // An operation far outside the box must not keep it alive.
    const field = new Field(new OperationBVH([elsewhere]), { extent });
    expect(field.couldHoldSurface(SKY)).toBe(false);
  });
});

describe("gradients", () => {
  it("points away from the surface, along every axis", () => {
    const field = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 200)]),
    );
    const gradient = field.gradient(0, 200, 0);
    expect(gradient.y).toBeCloseTo(1, 3);
    expect(gradient.x).toBeCloseTo(0, 3);

    const sideways = field.gradient(200, 0, 0);
    expect(sideways.x).toBeCloseTo(1, 3);
  });

  it("is a unit vector, or exactly up where there is no surface", () => {
    const field = new Field(
      new OperationBVH([sphereAt({ x: 0, y: 0, z: 0 }, 100)]),
    );
    for (const p of [
      { x: 0, y: 100, z: 0 },
      { x: 50, y: 0, z: 86 },
      { x: 0, y: 900, z: 0 },
    ]) {
      const g = field.gradient(p.x, p.y, p.z);
      expect(Math.hypot(g.x, g.y, g.z), JSON.stringify(p)).toBeCloseTo(1, 6);
    }
  });

  it("agrees with the analytic normal of the shape it is on", () => {
    // The step is a tenth of a voxel, small enough that a symmetric difference
    // tracks the true gradient closely. If it were too large this would drift, which
    // is the failure that shows up as dark seams along a surface rather than as a
    // visibly wrong normal — and it is worth checking against the shape's own
    // geometry rather than against another finite difference, which would share the
    // same error.
    const centre = { x: 10, y: -20, z: 40 };
    const field = new Field(new OperationBVH([sphereAt(centre, 150)]));
    for (const offset of [
      { x: 90, y: 60, z: -10 },
      { x: -140, y: -20, z: 40 },
      { x: 10, y: 130, z: 40 },
    ]) {
      const g = field.gradient(offset.x, offset.y, offset.z);
      const outward = {
        x: offset.x - centre.x,
        y: offset.y - centre.y,
        z: offset.z - centre.z,
      };
      const length = Math.hypot(outward.x, outward.y, outward.z);
      expect(g.x, JSON.stringify(offset)).toBeCloseTo(outward.x / length, 2);
      expect(g.y, JSON.stringify(offset)).toBeCloseTo(outward.y / length, 2);
      expect(g.z, JSON.stringify(offset)).toBeCloseTo(outward.z / length, 2);
    }
  });
});

describe("colour", () => {
  it("falls back to the default where nothing has been painted", () => {
    const field = new Field(new OperationBVH([]));
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: DEFAULT_COLOUR,
      opacity: 1,
    });
  });

  it("takes a painted tile ahead of a paint operation", () => {
    // The tile is the direct record of a stroke and the operation is the shape it
    // was drawn through. Choosing the other way round would make a hard paint vanish
    // the moment a soft paint covered the same ground.
    const paint: PaintSource = { at: () => ({ r: 1, g: 2, b: 3 }) };
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 50, y: 50, z: 50 } },
          "Paint",
          {
            colour: { r: 200, g: 100, b: 50 },
          },
        ),
      ]),
      { paint },
    );
    // **A tile is opaque**, because a tile stores three bytes per sample and there
    // is nowhere in that layout for a fourth.
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: { r: 1, g: 2, b: 3 },
      opacity: 1,
    });
  });

  it("takes a paint operation's colour where there is no tile", () => {
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 50, y: 50, z: 50 } },
          "Paint",
          {
            colour: { r: 200, g: 100, b: 50 },
          },
        ),
      ]),
    );
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: { r: 200, g: 100, b: 50 },
      opacity: 1,
    });
    expect(field.colourAt(500, 0, 0)).toEqual({
      colour: DEFAULT_COLOUR,
      opacity: 1,
    });
  });

  it("takes a solid operation's colour, because a colour no longer needs a Paint", () => {
    // **The change this whole arrangement exists for.** `Paint` is a no-op on the
    // distance — it colours and adds no material — so before this, a coloured *solid*
    // operation could not be expressed at all: `Add` was visible but colourless, and
    // `Paint` was coloured but invisible. A model of coloured parts had nowhere to go.
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 50, y: 50, z: 50 } },
          "Add",
          { colour: { r: 12, g: 34, b: 56 }, opacity: 0.5 },
        ),
      ]),
    );
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: { r: 12, g: 34, b: 56 },
      opacity: 0.5,
    });
    // And it is still solid, which is the part `Paint` could not do.
    expect(field.distance(0, 0, 0)).toBeLessThan(0);
  });

  it("says nothing for a solid operation with no colour", () => {
    // **The half of the rule that keeps a landscape from turning one colour.** An
    // operation with no colour has no say in appearance, so the answer falls through
    // to the default rather than inventing a white to fill the gap.
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 50, y: 50, z: 50 } },
          "Add",
        ),
      ]),
    );
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: DEFAULT_COLOUR,
      opacity: 1,
    });
  });

  it("lets a later operation's colour win over an earlier one where the two coincide", () => {
    // **Overlapping solids of different colours is the case a model of coloured parts is made
    // of**, and here the two are coincident, so the nearest surface is a tie and the later one
    // takes it. The combine mode takes no part in that either.
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 50, y: 50, z: 50 } },
          "Add",
          { colour: { r: 255, g: 0, b: 0 } },
        ),
        makeOperation(
          1,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 25, y: 25, z: 25 } },
          "Add",
          { colour: { r: 0, g: 0, b: 255 } },
        ),
      ]),
    );
    expect(field.colourAt(0, 0, 0).colour).toEqual({ r: 0, g: 0, b: 255 });
    expect(field.colourAt(40, 0, 0).colour).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("does not let a neighbour's colour reach across a model", () => {
    /**
     * **The bug this records, at the scale where it appeared.**
     *
     * The rule used to be "the last operation within a unit of the point", which is the same as
     * "the last operation within the model" for a figure a unit or two across — and a figure
     * modeller's parts are about a unit across. A red sphere and a blue box a unit and a bit
     * apart both satisfied it, the box came later in the list, and the sphere came out entirely
     * blue. Every vertex of the sphere, including the far side from the box, was blue.
     *
     * So the numbers here are deliberately tiny. Everything in this file's other colour tests is
     * tens of units across, which is why they all passed while the modeller's own model did not.
     */
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Sphere", radius: 0.7 },
          "Add",
          { colour: { r: 255, g: 0, b: 0 }, opacity: 1 },
        ),
        makeOperation(
          1,
          { x: 1.2, y: 0, z: 0 },
          { type: "Box", len: { x: 0.5, y: 0.5, z: 0.5 } },
          "Add",
          { colour: { r: 0, g: 0, b: 255 }, opacity: 1 },
        ),
      ]),
    );
    const red = { r: 255, g: 0, b: 0 };
    const blue = { r: 0, g: 0, b: 255 };

    // **The far side of the sphere, the point the bug was worst at.** The box is 1.9 units away
    // and comes later in the list; the sphere's own surface is here.
    expect(
      field.colourAt(-0.7, 0, 0).colour,
      "the far side of the sphere",
    ).toEqual(red);
    expect(field.colourAt(0, 0.7, 0).colour, "the top of the sphere").toEqual(
      red,
    );
    expect(field.colourAt(0, 0, 0.7).colour, "the front of the sphere").toEqual(
      red,
    );
    // And the box keeps its own colour, which is the other half of a union being two colours.
    expect(field.colourAt(1.7, 0, 0).colour, "the box's own surface").toEqual(
      blue,
    );
  });

  it("gives a nested shape its own colour rather than the one enclosing it", () => {
    /**
     * **The same bug, in its other form, and it is the more alarming one.** An enclosing solid is
     * *deeply inside* rather than merely nearby, so it satisfied the old reach by a wide margin and
     * the outer colour reached all the way in. Here the shell comes first and the sphere second, so
     * list order happened to save it; the test is here because that was luck rather than a rule, and
     * with the shell second it was the sphere that came out the wrong colour.
     */
    const field = new Field(
      new OperationBVH([
        makeOperation(
          0,
          { x: 0, y: 0, z: 0 },
          { type: "Box", len: { x: 2, y: 2, z: 2 } },
          "Add",
          { colour: { r: 0, g: 255, b: 0 }, opacity: 1 },
        ),
        makeOperation(
          1,
          { x: 0, y: 0, z: 0 },
          { type: "Sphere", radius: 0.5 },
          "Add",
          { colour: { r: 255, g: 0, b: 0 }, opacity: 1 },
        ),
      ]),
    );
    expect(field.colourAt(2, 0, 0).colour, "the shell's own surface").toEqual({
      r: 0,
      g: 255,
      b: 0,
    });
    expect(
      field.colourAt(0.5, 0, 0).colour,
      "the sphere's own surface",
    ).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("asks the tile only once per call, and passes the point through", () => {
    // Once per call matters: the mesher asks for a colour at every vertex, and a
    // tile lookup that was not the first thing tried would double the cost of the
    // whole meshing pass.
    const asked: Vec3[] = [];
    const paint: PaintSource = {
      at: (x, y, z) => {
        asked.push({ x, y, z });
        return undefined;
      },
    };
    const field = new Field(new OperationBVH([]), { paint });
    field.colourAt(7, 8, 9);
    expect(asked).toEqual([{ x: 7, y: 8, z: 9 }]);
  });
});

describe("the field's purity", () => {
  it("gives the same answer however it is asked, in any order", () => {
    // What makes the field safe to clone into a worker and safe to sample from two
    // chunks at once: the only mutable state is the candidate cache, and no answer
    // depends on it. Without that, the mesher's catch-up pass would change the model
    // it is catching up to.
    const ops = Array.from({ length: 80 }, (_, i) =>
      makeOperation(
        i,
        {
          x: (i % 8) * 70 - 245,
          y: Math.floor(i / 8) * 70 - 245,
          z: ((i * 3) % 8) * 70 - 245,
        },
        {
          type: "Ellipsoid",
          radius: { x: 40, y: 25, z: 55 },
        },
        i % 4 === 0 ? "Subtract" : "Add",
        { softness: i % 5 === 0 ? 0.15 : 0 },
      ),
    );
    const field = new Field(new OperationBVH(ops));

    const points = Array.from({ length: 500 }, (_, i) => ({
      x: ((i * 37) % 700) - 350,
      y: ((i * 91) % 700) - 350,
      z: ((i * 53) % 700) - 350,
    }));
    const forward = points.map((p) => field.distance(p.x, p.y, p.z));
    for (const [i, p] of [...points.entries()].reverse()) {
      expect(field.distance(p.x, p.y, p.z), JSON.stringify(p)).toBe(forward[i]);
    }
  });

  it("changes only the operations when the list is replaced", () => {
    // Probed far from the sphere, where the base field is the only thing deciding
    // the answer. At the sphere's centre both agree, because a hundred units inside
    // an operation beats any starting value.
    const operations = [sphereAt({ x: 0, y: 0, z: 0 }, 100)];
    const alone = new Field(new OperationBVH(operations));
    const withBase = new Field(new OperationBVH(operations), { base: () => 5 });
    expect(alone.distance(5000, 0, 0)).toBe(FAR_DISTANCE);
    expect(withBase.distance(5000, 0, 0)).toBe(5);

    // Replacing the list leaves the base field alone, and moves the sphere.
    const moved = new Field(new OperationBVH(operations), { base: () => 5 });
    moved.setOperations([sphereAt({ x: 400, y: 0, z: 0 }, 100, 0)]);
    expect(moved.distance(5000, 0, 0)).toBe(5);
    expect(moved.distance(400, 0, 0)).toBeLessThan(0);
    expect(moved.distance(0, 0, 0)).toBeGreaterThan(0);
  });
});
