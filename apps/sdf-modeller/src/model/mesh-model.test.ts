import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET,
  meshModel,
  meshRegion,
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
      {
        id: "a",
        shape: { type: "Capsule", len: 6, radius: 0.6 },
        origin: { x: 0, y: 0, z: 0 },
        orientation: fromEuler(0, 0, 0),
      },
    ])!;
    const along = meshModel([
      {
        id: "a",
        shape: { type: "Capsule", len: 6, radius: 0.6 },
        origin: { x: 0, y: 0, z: 0 },
        orientation: fromEuler(0, 0, Math.PI / 2),
      },
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
