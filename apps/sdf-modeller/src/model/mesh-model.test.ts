import { describe, expect, it } from "vitest";

import { DEFAULT_COLOUR } from "@big-mesh-studios/csg";
import { describeReport } from "@big-mesh-studios/meshing";

import {
  budgetFor,
  DEFAULT_BUDGET,
  meshModel,
  meshRegion,
  primitiveMesh,
  modelField,
  RESOLUTIONS,
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

/**
 * The two meshers, which is a choice rather than a quality setting.
 *
 * **Both are tested against the same models, because the claim being made is that they are
 * interchangeable at the seam and different in what they produce.** A test that exercised only one
 * would pass whether or not the seam held, since `meshModel`'s signature is what holds it.
 */
describe("choosing a mesher", () => {
  const capsule = placedPart(
    "a",
    { type: "Capsule", len: 2.2, radius: 0.7 },
    { x: 0, y: 1.1, z: 0 },
  );
  const pair = [
    capsule,
    placedPart("b", { type: "Sphere", radius: 0.8 }, { x: 1.4, y: 1.6, z: 0 }),
  ];

  it("gives each mode the same region and the same sample count", () => {
    // The interchangeability claim, made concrete: the mode decides the triangulation and nothing
    // else, so the two must agree about where the mesh is and how finely it is sampled.
    const nets = meshModel(pair, DEFAULT_BUDGET, "surface-nets")!;
    const cubes = meshModel(pair, DEFAULT_BUDGET, "marching-cubes")!;
    expect(cubes.region).toEqual(nets.region);
    expect(cubes.samples).toBe(nets.samples);
    expect(cubes.mesh.vertexCount).toBeGreaterThan(0);
    expect(cubes.mesh.indices.length).toBe(cubes.triangles * 3);
  });

  it("closes the model at every resolution on offer, with marching cubes", () => {
    /**
     * **The guarantee, checked at each setting the control offers rather than at one of them.**
     *
     * A resolution control is where a mesher's promise is most likely to quietly stop holding: the
     * fine end resolves thin features the coarse end missed, and the coarse end is where a cell is
     * barely a cell. Walking `RESOLUTIONS` is the only way to cover both.
     *
     * And it is a claim about marching cubes alone, deliberately. **Surface nets is closed on this
     * model at every one of these settings too** — it is closed on nearly everything, which is why
     * ADR 0003 could call the alternative "not manifold in general" and still be right. What it is
     * not is *guaranteed* closed where the surface is thin or sharply creased. The mode is a choice
     * between a guarantee and an observation, and `mesh-report` is what turns either into something a
     * person can see before they send it to a slicer.
     */
    for (const voxelSize of RESOLUTIONS) {
      const cubes = meshModel(pair, budgetFor(voxelSize), "marching-cubes")!;
      expect(cubes.triangles, `at ${voxelSize}`).toBeGreaterThan(0);
      expect(
        cubes.report.watertight,
        `at ${voxelSize}: ${describeReport(cubes.report)}`,
      ).toBe(true);
    }
  });

  it("puts the surface closer to where the field says it is, with marching cubes", () => {
    // **The difference you can see without reading a report.** Marching cubes places every vertex on a
    // crossing of the true surface; surface nets places one at a cell's average crossing, which is
    // inside the cell and therefore off the surface by up to half a cell. Against an analytic volume,
    // that is a measurable gap and it is the reason the finer mesh is also the truer one.
    const analytic = (4 / 3) * Math.PI * 1 ** 3;
    const sphere = [
      placedPart("s", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ];
    const error = (mode: "surface-nets" | "marching-cubes"): number =>
      Math.abs(
        meshModel(sphere, budgetFor(0.125), mode)!.report.volume / analytic - 1,
      );
    expect(error("marching-cubes")).toBeLessThan(error("surface-nets"));
  });

  it("still meshes a lone part in either mode, for the drag ghost", () => {
    // `primitiveMesh` is the drag's one build, and a drag is happening whichever mode is on.
    for (const mode of ["surface-nets", "marching-cubes"] as const) {
      const preview = primitiveMesh(capsule, DEFAULT_BUDGET);
      expect(preview?.triangles ?? 0, mode).toBeGreaterThan(0);
      const built = meshModel([capsule], DEFAULT_BUDGET, mode);
      expect(built?.triangles ?? 0, mode).toBeGreaterThan(0);
    }
  });

  it("reuses one scratch across rebuilds without carrying a mesh into the next", () => {
    // The scratch is held across rebuilds because marching cubes' vertex cache is eleven megabytes
    // at the default resolution. A mesh that carried over would show up here as a vertex count that
    // only ever goes up.
    const first = meshModel(pair, DEFAULT_BUDGET, "marching-cubes")!;
    const second = meshModel(pair, DEFAULT_BUDGET, "marching-cubes")!;
    expect(second.mesh.vertexCount).toBe(first.mesh.vertexCount);
    expect(second.triangles).toBe(first.triangles);
    expect([...second.mesh.indices]).toEqual([...first.mesh.indices]);
  });
});

describe("the resolution control", () => {
  it("offers sizes that halve, each a doubling of the work", () => {
    // **The list rather than a range, because the cost is cubic in the reciprocal.** Each step here
    // doubles the samples on an axis and so multiplies the work by eight; a slider across the same
    // interval would offer ratios a person cannot predict.
    expect(RESOLUTIONS.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < RESOLUTIONS.length; i++) {
      expect(
        RESOLUTIONS[i - 1]! / RESOLUTIONS[i]!,
        `step ${i} is not a halving`,
      ).toBeCloseTo(2, 12);
    }
    expect(RESOLUTIONS).toContain(DEFAULT_BUDGET.voxelSize);
  });

  it("changes the budget's spacing and nothing else", () => {
    // **The other two numbers are not the control's to set**, so a control that changed them would be
    // changing the memory ceiling and the small-model floor by accident.
    const fine = budgetFor(0.125);
    expect(fine.voxelSize).toBe(0.125);
    expect(fine.maxSamplesPerAxis).toBe(DEFAULT_BUDGET.maxSamplesPerAxis);
    expect(fine.minSamplesPerAxis).toBe(DEFAULT_BUDGET.minSamplesPerAxis);
  });

  it("meshes finer the smaller the voxel, and says so in the region", () => {
    const coarse = meshModel(
      [placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 })],
      budgetFor(0.5),
    )!;
    const fine = meshModel(
      [placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 })],
      budgetFor(0.125),
    )!;
    expect(fine.samples).toBeGreaterThan(coarse.samples);
    expect(fine.region.sampleSize).toBeLessThan(coarse.region.sampleSize);
  });

  it("reaches the field's candidate cell, which it did not used to", () => {
    // **The budget now reaches `modelField`.** It did not, so a rebuild at a finer resolution got a
    // BVH candidate cell sized for the default's eight voxels, which is what made the cost of
    // sampling depend on a resolution the caller never asked for. Read back off the field rather
    // than off the mesh, because the mesh is identical either way — the bug was invisible from here.
    const fine = budgetFor(0.0625);
    const field = modelField(
      [placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 })],
      fine,
    );
    expect(field.gradient(0, 0, 0).y).not.toBe(0);
    expect(
      meshRegion(
        [placedPart("a", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 })],
        fine,
      )?.sampleSize,
    ).toBeLessThanOrEqual(fine.voxelSize * 1.001);
  });
});

/**
 * Colour through the mesher, because that is where a colour is actually seen.
 *
 * **The rule under test is `bvh.evalPaint`'s and is pinned there**, in `packages/csg`. What this
 * covers is that it survives the journey: a vertex is on a crossing between two samples, the field
 * is asked once per vertex, and the answer is written into the packed attribute the renderer reads.
 * A model of two coloured parts is the shortest way to ask all of that at once.
 */
describe("colour, through the mesh", () => {
  const RED = { r: 255, g: 0, b: 0 };
  const BLUE = { r: 0, g: 0, b: 255 };

  /** Every distinct colour in a finished mesh, with how many vertices carry it. */
  const coloursOf = (
    mesh: ReturnType<typeof meshModel>,
  ): Map<string, number> => {
    const seen = new Map<string, number>();
    for (let i = 0; i < mesh!.mesh.vertexCount; i++) {
      const at = i * 4;
      const key = `${mesh!.mesh.colours[at]},${mesh!.mesh.colours[at + 1]},${mesh!.mesh.colours[at + 2]}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return seen;
  };

  /** The colour of the vertex nearest a world point, as `r,g,b`. */
  const colourNearest = (
    mesh: NonNullable<ReturnType<typeof meshModel>>,
    at: { x: number; y: number; z: number },
  ): string => {
    let best = Infinity;
    let index = 0;
    for (let i = 0; i < mesh.mesh.vertexCount; i++) {
      const d = Math.hypot(
        (mesh.mesh.positions[i * 3] as number) - at.x,
        (mesh.mesh.positions[i * 3 + 1] as number) - at.y,
        (mesh.mesh.positions[i * 3 + 2] as number) - at.z,
      );
      if (d < best) {
        best = d;
        index = i;
      }
    }
    const at4 = index * 4;
    return `${mesh.mesh.colours[at4]},${mesh.mesh.colours[at4 + 1]},${mesh.mesh.colours[at4 + 2]}`;
  };

  it("keeps a union of two coloured parts as two colours", () => {
    /**
     * **A figure a unit or two across, which is the scale this bug lived at.**
     *
     * The rule used to be "the last operation within a unit of the point", which is the same as
     * "the last operation within the model" for a figure this size — and the modeller's parts are
     * about a unit across. The red sphere and the blue box were close enough that the box covered
     * the sphere, the box came later in the list, and the sphere came out entirely blue.
     *
     * **Asserted by asking for the vertex nearest a known point on each surface** rather than by
     * counting colours, because the counts are not comparable: marching cubes puts a vertex on every
     * crossed edge, so a flat face emits four a cell and a sphere's curvature emits about one, and
     * the box legitimately comes out with three or four times the sphere's vertex count. A ratio
     * would be measuring the algorithms. Asking what colour a particular place *is* cannot be.
     */
    const sphere = placedPart(
      "a",
      { type: "Sphere", radius: 0.7 },
      { x: 0, y: 0, z: 0 },
      { colour: RED, opacity: 1 },
    );
    const box = placedPart(
      "b",
      { type: "Box", len: { x: 1, y: 1, z: 1 } },
      { x: 1.4, y: 0, z: 0 },
      { colour: BLUE, opacity: 1 },
    );
    const mesh = meshModel([sphere, box], budgetFor(0.125), "marching-cubes");
    expect(mesh).toBeDefined();
    const built = mesh!;

    // The far side of the sphere from the box, where the old rule was worst: the box is nearly two
    // units away and came later in the list, and the sphere was blue here too.
    expect(colourNearest(built, { x: -0.7, y: 0, z: 0 })).toBe(
      `${RED.r},${RED.g},${RED.b}`,
    );
    expect(colourNearest(built, { x: 0, y: 0.7, z: 0 })).toBe(
      `${RED.r},${RED.g},${RED.b}`,
    );
    expect(colourNearest(built, { x: 0, y: 0, z: 0.7 })).toBe(
      `${RED.r},${RED.g},${RED.b}`,
    );
    // And the box keeps its own colour, which is the other half of a union being two colours.
    expect(colourNearest(built, { x: 1.9, y: 0, z: 0 })).toBe(
      `${BLUE.r},${BLUE.g},${BLUE.b}`,
    );
    expect(colourNearest(built, { x: 1.4, y: 0, z: 0.5 })).toBe(
      `${BLUE.r},${BLUE.g},${BLUE.b}`,
    );

    // Both colours present somewhere, which is what "two colours" means before anything else.
    const seen = coloursOf(built);
    expect(seen.get(`${RED.r},${RED.g},${RED.b}`) ?? 0).toBeGreaterThan(0);
    expect(seen.get(`${BLUE.r},${BLUE.g},${BLUE.b}`) ?? 0).toBeGreaterThan(0);
  });

  it("gives each part of a chain its own colour, in order", () => {
    // Three parts end to end, so the middle one is within reach of both its neighbours and has to
    // win against one on each side. This is the case that shows the rule is about distance rather
    // than about being first or last in the list.
    const parts = [
      placedPart(
        "a",
        { type: "Sphere", radius: 0.5 },
        { x: 0, y: 0, z: 0 },
        { colour: { r: 255, g: 0, b: 0 }, opacity: 1 },
      ),
      placedPart(
        "b",
        { type: "Sphere", radius: 0.5 },
        { x: 0.9, y: 0, z: 0 },
        { colour: { r: 0, g: 255, b: 0 }, opacity: 1 },
      ),
      placedPart(
        "c",
        { type: "Sphere", radius: 0.5 },
        { x: 1.8, y: 0, z: 0 },
        { colour: { r: 0, g: 0, b: 255 }, opacity: 1 },
      ),
    ];
    const mesh = meshModel(parts, budgetFor(0.125), "marching-cubes");
    const seen = coloursOf(mesh);
    for (const colour of [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
    ]) {
      expect(
        seen.get(`${colour.r},${colour.g},${colour.b}`) ?? 0,
        `colour ${colour.r},${colour.g},${colour.b}`,
      ).toBeGreaterThan(0);
    }
  });
});
