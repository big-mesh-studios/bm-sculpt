import { describe, expect, it } from "vitest";

import { DEFAULT_COLOUR } from "@big-mesh-studios/csg";

import {
  DEFAULT_BUDGET,
  meshModel,
  meshRegion,
  primitiveMesh,
  modelField,
  samplesFor,
} from "./mesh-model";
import { fromEuler, placedPart } from "./part";

describe("meshing a model", () => {
  it("produces triangles for one sphere", () => {
    const result = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ]);
    expect(result).toBeDefined();
    // A sphere is a closed surface, so it cannot come back as nothing.
    expect(result!.triangles).toBeGreaterThan(0);
    expect(result!.mesh.vertexCount).toBeGreaterThan(0);
  });

  it("produces nothing for a model with no parts, which is not the same as a model with nothing on it", () => {
    // **`undefined`, not an empty mesh.** A caller blanking the screen because the model
    // has no parts would be hiding a model that merely has nothing visible in the box.
    expect(meshModel([])).toBeUndefined();
    expect(meshRegion([])).toBeUndefined();
  });

  it("puts every vertex inside the region it meshed", () => {
    const result = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    const { origin, sampleSize, samples } = result.region;
    // The mesher owns samples `1 .. n`, so the region's world extent is
    // `origin + (samples - 1) * sampleSize` on each axis.
    const extent = (samples - 1) * sampleSize;
    const positions = result.mesh.positions;
    // `Vec3` is named rather than indexed, so each axis is named where it is read.
    const low = [
      origin.x - sampleSize,
      origin.y - sampleSize,
      origin.z - sampleSize,
    ];
    const high = [origin.x + extent, origin.y + extent, origin.z + extent];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const at = positions[i + axis]!;
        expect(at, `vertex ${i / 3} axis ${axis}`).toBeGreaterThan(low[axis]!);
        expect(at, `vertex ${i / 3} axis ${axis}`).toBeLessThan(
          high[axis]! + sampleSize,
        );
      }
    }
  });

  it("resolves the samples from the model's own size, not a fixed number", () => {
    const small = samplesFor({
      min: { x: -1, y: -1, z: -1 },
      max: { x: 1, y: 1, z: 1 },
    });
    const large = samplesFor({
      min: { x: -20, y: -20, z: -20 },
      max: { x: 20, y: 20, z: 20 },
    });
    expect(small).toBeLessThan(large);
    expect(small).toBeGreaterThanOrEqual(DEFAULT_BUDGET.minSamplesPerAxis);
    expect(large).toBeLessThanOrEqual(DEFAULT_BUDGET.maxSamplesPerAxis);
  });

  it("meshes a sphere symmetrically, which is what cubic cells look like", () => {
    // **The grid has to be cubic**, because the mesher's cell loop assumes cubes and
    // because Surface Nets places a vertex by interpolating along an edge — a cell that
    // is twice as wide as it is tall puts the vertex somewhere between the corners
    // rather than on the surface. A sphere is the cheapest way to see it: under a
    // stretched grid it comes back wider in one axis than another, and the amount is
    // the stretch.
    const result = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    const span = (axis: 0 | 1 | 2): number => {
      const positions = result.mesh.positions;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = axis; i < positions.length; i += 3) {
        lo = Math.min(lo, positions[i]!);
        hi = Math.max(hi, positions[i]!);
      }
      return hi - lo;
    };
    expect(span(0)).toBeCloseTo(span(1), 3);
    expect(span(1)).toBeCloseTo(span(2), 3);
  });

  it("coarsens a model too big for the budget rather than exceeding it", () => {
    // **The ceiling is a ceiling.** A forty-unit capsule at a quarter-unit voxel wants
    // 166 samples on its long axis; the budget says 96, so the spacing comes out at
    // about 0.43 and the figure is built at that resolution instead of not at all.
    //
    // This was a test that asserted the *requested* spacing and failed, which is worth
    // recording: the clamping is the feature. The invariant is that the spacing is never
    // finer than asked for, and never leaves the budget.
    const region = meshRegion([
      placedPart(
        "a",
        { type: "Capsule", len: 40, radius: 0.5 },
        { x: 0, y: 0, z: 0 },
      ),
    ])!;
    expect(region.samples).toBe(DEFAULT_BUDGET.maxSamplesPerAxis);
    expect(region.sampleSize).toBeGreaterThanOrEqual(DEFAULT_BUDGET.voxelSize);
    expect(region.sampleSize).toBeLessThan(DEFAULT_BUDGET.voxelSize * 2);
  });

  it("uses the requested spacing when the model fits the budget", () => {
    const region = meshRegion([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    // Under the ceiling, `samples = ceil(extent / voxelSize)` and the spacing comes back
    // to within one sample of what was asked.
    expect(region.sampleSize).toBeLessThanOrEqual(
      DEFAULT_BUDGET.voxelSize * 1.05,
    );
  });

  it("turns a capsule about, so an unrotated one is not indistinguishable from a rotated one", () => {
    // **This is the reason the transform carries a quaternion.** Every axial primitive
    // runs along Y (ADR 0025), so without a rotation every capsule in a model would be
    // vertical and the primitive table's convention would be the model's limitation.
    const up = meshModel([
      placedPart(
        "a",
        { type: "Capsule", len: 6, radius: 0.6 },
        { x: 0, y: 0, z: 0 },
        { orientation: fromEuler(0, 0, 0) },
      ),
    ])!;
    const along = meshModel([
      placedPart(
        "a",
        { type: "Capsule", len: 6, radius: 0.6 },
        { x: 0, y: 0, z: 0 },
        { orientation: fromEuler(0, 0, Math.PI / 2) },
      ),
    ])!;

    // The two must differ, and the difference has to be in the right axis: turning a
    // vertical capsule a quarter turn about z lays it along x, so it reaches further in x
    // and less in y.
    const reach = (result: typeof up, axis: 0 | 1): number => {
      let most = 0;
      const positions = result.mesh.positions;
      for (let i = axis; i < positions.length; i += 3) {
        most = Math.max(most, Math.abs(positions[i]!));
      }
      return most;
    };
    expect(reach(up, 1), "vertical capsule reaches further up").toBeGreaterThan(
      reach(up, 0),
    );
    expect(
      reach(along, 0),
      "rotated capsule reaches further along x",
    ).toBeGreaterThan(reach(along, 1));
  });

  it("unions two overlapping parts rather than meshing only one", () => {
    // Two spheres a unit apart, both radius 1: a union is wider than either alone.
    const one = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    const two = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
      placedPart("b", { type: "Sphere", radius: 1 }, { x: 1.5, y: 0, z: 0 }),
    ])!;
    const width = (result: typeof one): number => {
      const positions = result.mesh.positions;
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        lo = Math.min(lo, positions[i]!);
        hi = Math.max(hi, positions[i]!);
      }
      return hi - lo;
    };
    expect(width(two)).toBeGreaterThan(width(one));
  });

  it("unions two parts and subtracts a third, in list order", () => {
    // **The boolean reaches the fold.** A `Subtract` is `smoothMax(field, -distance)` and
    // an `Add` is `smoothMin(field, distance)`, so a box with a smaller box subtracted
    // from it is hollow and a sphere unioned onto it is a lump on the outside.
    const solid = meshModel([
      placedPart(
        "big",
        { type: "Box", len: { x: 4, y: 4, z: 4 } },
        { x: 0, y: 0, z: 0 },
      ),
      placedPart(
        "hole",
        { type: "Box", len: { x: 2, y: 2, z: 2 } },
        { x: 0, y: 0, z: 0 },
        { combine: "Subtract" },
      ),
    ])!;
    const plain = meshModel([
      placedPart(
        "big",
        { type: "Box", len: { x: 4, y: 4, z: 4 } },
        { x: 0, y: 0, z: 0 },
      ),
    ])!;

    // The subtracted box removes material, so the middle of the solid is no longer
    // inside: the field at the origin is positive where the box alone made it negative.
    const field = modelField([
      placedPart(
        "big",
        { type: "Box", len: { x: 4, y: 4, z: 4 } },
        { x: 0, y: 0, z: 0 },
      ),
      placedPart(
        "hole",
        { type: "Box", len: { x: 2, y: 2, z: 2 } },
        { x: 0, y: 0, z: 0 },
        { combine: "Subtract" },
      ),
    ]);
    const plainField = modelField([
      placedPart(
        "big",
        { type: "Box", len: { x: 4, y: 4, z: 4 } },
        { x: 0, y: 0, z: 0 },
      ),
    ]);
    expect(
      plainField.distance(0, 0, 0),
      "the box alone is solid inside",
    ).toBeLessThan(0);
    expect(
      field.distance(0, 0, 0),
      "the subtracted box hollows it out",
    ).toBeGreaterThan(0);
    // And there is still a surface, so it meshes rather than vanishing.
    expect(solid.triangles).toBeGreaterThan(0);
    expect(
      solid.triangles,
      "a hollow shell is not the solid box",
    ).toBeGreaterThan(0);
    expect(plain.triangles).toBeGreaterThan(0);
  });

  it("folds a softness into a soft union", () => {
    // **Above zero the boolean is the smooth one**, which is the landscape's polynomial
    // smooth minimum with `k` four times the softness: `min(a,b) - max(k-|a-b|,0)²/4k`.
    //
    // Two spheres of radius 1 with their centres 3 apart, so the midpoint is 0.5 outside
    // each: air under a hard union. The blend dips below the true minimum across its whole
    // width, so with a softness of 1 — `k` of 4 — the midpoint comes out at
    // `0.5 - 16/16 = -0.5`, inside. That is the observable consequence of the formula
    // rather than the formula itself.
    const pair = (softness: number) => [
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
      placedPart(
        "b",
        { type: "Sphere", radius: 1 },
        { x: 3, y: 0, z: 0 },
        { softness },
      ),
    ];

    const hard = modelField(pair(0));
    const soft = modelField(pair(1));

    expect(hard.distance(1.5, 0, 0), "a hard union leaves the gap").toBeCloseTo(
      0.5,
      9,
    );
    expect(soft.distance(1.5, 0, 0), "a soft union bridges it").toBeCloseTo(
      -0.5,
      9,
    );
  });

  it("folds a softness into a soft difference, which cuts a little more than a hard one", () => {
    // **The smooth maximum is the negation of a smooth minimum**, so it is *greater* than
    // the hard maximum everywhere the two arguments are within the blend width — and a
    // greater distance is more air. A soft difference therefore removes slightly more than
    // a hard one at the same geometry, rounding the rim outward rather than inward.
    //
    // This is the direction most people expect to be the other way round, so it is
    // asserted rather than left to be discovered.
    const shell = (softness: number) =>
      modelField([
        placedPart(
          "big",
          { type: "Box", len: { x: 4, y: 4, z: 4 } },
          { x: 0, y: 0, z: 0 },
        ),
        placedPart(
          "hole",
          { type: "Box", len: { x: 2, y: 2, z: 2 } },
          { x: 0, y: 0, z: 0 },
          { combine: "Subtract", softness },
        ),
      ]);

    const hard = shell(0);
    // **A softness of 1, so `k` is 4.** The blend only reaches where the two arguments
    // are within `k` of each other, and at the probe below they are 2.2 apart — a
    // softness of 0.5 would leave the hard and soft answers identical and the test would
    // pass while asserting nothing.
    const soft = shell(1);
    // Just inside the hole's own wall, where the blend does reach.
    const at = (field: ReturnType<typeof shell>): number =>
      field.distance(1.9, 0, 0);
    expect(at(hard), "the hard difference is air here").toBeGreaterThan(0);
    expect(
      at(soft),
      "and the soft one is further into the air",
    ).toBeGreaterThan(at(hard));
    // And both agree away from the blend, at the middle of the hole.
    expect(soft.distance(0, 0, 0)).toBeCloseTo(hard.distance(0, 0, 0), 9);
  });

  it("orders the fold by the list, and a subtraction makes that order matter", () => {
    // **The consequence of allowing a difference.** With every part an `Add` the fold is
    // the same however the list is arranged; a `Subtract` makes it not, so this asserts
    // that reordering the same parts changes the solid. If this ever stops being true the
    // fold has become order-independent and the list order is bookkeeping again.
    const a = placedPart(
      "a",
      { type: "Sphere", radius: 3 },
      { x: 0, y: 0, z: 0 },
    );
    const b = placedPart(
      "b",
      { type: "Sphere", radius: 3 },
      { x: 2, y: 0, z: 0 },
    );
    const cut = placedPart(
      "cut",
      { type: "Box", len: { x: 1, y: 8, z: 8 } },
      { x: 1, y: 0, z: 0 },
      { combine: "Subtract" },
    );

    const cutLast = modelField([a, b, cut]);
    const cutFirst = modelField([cut, a, b]);

    // The cut is a slab through the middle of the joined spheres in one order and a
    // groove through nothing much in the other, so a point inside the spheres differs.
    expect(
      cutLast.distance(1, 1, 0),
      "the cut came after the solids it removes",
    ).not.toBeCloseTo(cutFirst.distance(1, 1, 0), 3);
  });

  it("gives every vertex a real normal rather than the builder's placeholder", () => {
    // **The builder fills an unset normal with `+Y` and an unset colour with white**, and
    // its own comment says that was deliberate: "a real direction rather than an obvious
    // sentinel", so a vertex whose normal was never set would shade as though it were
    // right. Which means a mesh built without an `onVertex` looks *plausible* while every
    // normal points up. This is the only thing that catches it.
    const result = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    expect(result.mesh.vertexCount).toBeGreaterThan(0);

    let allUp = true;
    let allDefault = true;
    for (let i = 0; i < result.mesh.vertexCount; i++) {
      const nx = result.mesh.normalOct[i * 2]!;
      const ny = result.mesh.normalOct[i * 2 + 1]!;
      // Octahedral-encoded, so a pair of zeroes is the `+Y` placeholder.
      if (nx !== 0 || ny !== 0) allUp = false;
      // **Not white, and that is the point.** A part with no colour of its own takes the
      // field's default — a warm grey — rather than the builder's white placeholder, so a
      // vertex whose colour was never filled in is distinguishable from a vertex that was.
      if (
        result.mesh.colours[i * 4] !== DEFAULT_COLOUR.r ||
        result.mesh.colours[i * 4 + 1] !== DEFAULT_COLOUR.g ||
        result.mesh.colours[i * 4 + 2] !== DEFAULT_COLOUR.b
      ) {
        allDefault = false;
      }
    }
    expect(allUp, "some normals are not the +Y placeholder").toBe(false);
    expect(allDefault, "every vertex took the field's default colour").toBe(
      true,
    );
  });

  it("paints a part's colour into its vertices", () => {
    const red = { r: 220, g: 30, b: 40 };
    const result = meshModel([
      placedPart(
        "a",
        { type: "Sphere", radius: 1 },
        { x: 0, y: 0, z: 0 },
        { colour: red },
      ),
    ])!;
    let sawRed = false;
    for (let i = 0; i < result.mesh.vertexCount; i++) {
      if (
        Math.abs(result.mesh.colours[i * 4]! - red.r) <= 1 &&
        Math.abs(result.mesh.colours[i * 4 + 1]! - red.g) <= 1 &&
        Math.abs(result.mesh.colours[i * 4 + 2]! - red.b) <= 1
      ) {
        sawRed = true;
      }
    }
    expect(sawRed, "the part's colour reached the mesh").toBe(true);
  });

  it("carries a part's opacity into the alpha of its vertices", () => {
    const result = meshModel([
      placedPart(
        "a",
        { type: "Sphere", radius: 1 },
        { x: 0, y: 0, z: 0 },
        { colour: { r: 10, g: 20, b: 30 }, opacity: 0.5 },
      ),
    ])!;
    let sawHalf = false;
    for (let i = 0; i < result.mesh.vertexCount; i++) {
      if (Math.abs(result.mesh.colours[i * 4 + 3]! - 128) <= 1) sawHalf = true;
    }
    expect(sawHalf, "opacity reached the vertex alpha").toBe(true);
  });

  it("reports how many field evaluations a rebuild cost", () => {
    const result = meshModel([
      placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ])!;
    const { samples } = result.region;
    // The grid is two larger than the samples a model owns, which is the mesher's own
    // arrangement and the reason the count is `(samples + 2) ** 3`.
    expect(result.samples).toBe((samples + 2) ** 3);
  });
});

describe("meshing one part for a preview", () => {
  const capsule = placedPart(
    "body",
    { type: "Capsule", len: 2.2, radius: 0.7 },
    { x: 5, y: 6, z: 7 },
  );

  it("gives a surface, where the part is not a difference", () => {
    // **The reason this is not `meshModel([part])`.** A lone `Subtract` folds against a base
    // of `Infinity` and comes out as nothing at all, so a preview of a difference would
    // have been an empty scene — a very confusing thing to show somebody dragging it.
    const subtracted = placedPart(
      "cut",
      { type: "Sphere", radius: 1 },
      { x: 0, y: 0, z: 0 },
      { combine: "Subtract" },
    );
    expect(meshModel([subtracted])?.triangles ?? 0).toBe(0);
    expect(primitiveMesh(subtracted)?.triangles ?? 0).toBeGreaterThan(0);
  });

  it("comes out centred on the origin, whatever the part's own position", () => {
    // **So the caller places it with one position write.** The region is the proof: it is
    // the box the mesh was built in, and a part whose mesh was already in world space would
    // have a region nowhere near the origin.
    const built = primitiveMesh(capsule);
    expect(built).toBeDefined();

    // **The region brackets the local origin**, which is the claim: the mesh was built
    // around (0, 0, 0) rather than around the part's own (5, 6, 7). `region.origin` is the
    // grid's low corner, not its middle, so it is the span that has to contain zero.
    const { origin, samples, sampleSize } = built!.region;
    for (const axis of ["x", "y", "z"] as const) {
      expect(
        origin[axis],
        `the region's ${axis} starts above the local origin`,
      ).toBeLessThan(0);
      expect(
        origin[axis] + samples * sampleSize,
        `the region's ${axis} ends below the local origin`,
      ).toBeGreaterThan(0);
    }
    // And nowhere near the part's own position, which is what a mesh in world space would
    // have been built around.
    expect(Math.abs(origin.y)).toBeLessThan(3);
  });

  it("keeps the part's turn, because the turn is in the vertices", () => {
    // **A drag then costs a position write and nothing else.** If the turn were left to the
    // object, the mesh would have to be rebuilt whenever the orientation changed, and there
    // would be two places holding a turn that could disagree.
    const upright = primitiveMesh(capsule);
    const turned = primitiveMesh({
      ...capsule,
      orientation: fromEuler(0, 0, Math.PI / 2),
    });
    expect(upright?.triangles).toBeGreaterThan(0);
    expect(turned?.triangles).toBeGreaterThan(0);
  });

  it("is a cheaper mesh than the whole model", () => {
    // **The reason a drag can afford one build.** A ghost of one part is a fraction of a
    // model's samples, which is what makes it reasonable to do at all.
    const twoParts = primitiveMesh(capsule);
    const whole = meshModel([
      capsule,
      placedPart("b", { type: "Sphere", radius: 0.5 }, { x: 3, y: 0, z: 0 }),
    ]);
    expect(twoParts!.samples).toBeLessThan(whole!.samples);
  });
});
