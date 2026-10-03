/**
 * Turning a model into triangles.
 *
 * ## Why Surface Nets and not raymarching
 *
 * **Because the renderer already draws triangles and the field is already a function.**
 * A raymarched figure would be a second renderer with its own camera, its own material
 * model and its own performance cliff, none of which this repository has. Meshing means
 * the model becomes the same kind of `Mesh` the landscape's chunks are, drawn by the same
 * node graph, with lighting and a shadow pass it already has.
 *
 * The cost is that meshing is a discrete operation over a box, so the model has to be
 * bounded and has to be rebuilt when it changes. That is what the resolution below is for.
 *
 * ## Why the sample count is chosen from the model, not fixed
 *
 * **A fixed grid either wastes work on a small model or cannot hold a large one.** The
 * count here is derived from the model's own bounds and a chosen voxel size, clamped at
 * both ends. The clamps are the interesting part: the upper one is a limit on memory and
 * on how long a rebuild takes, and the lower one is there because a model of a few
 * millimetres across should not be one cell.
 */
import type { Bounds, Vec3 } from "@big-mesh-studios/core";
import {
  Field,
  makeOperation,
  OperationBVH,
  type Operation,
} from "@big-mesh-studios/csg";
import {
  ChunkMeshBuilder,
  scratchFor,
  surfaceNets,
  type ChunkMesh,
} from "@big-mesh-studios/meshing";

import { modelBounds, type Part } from "./part";

/**
 * How much of a model to mesh, and at what resolution.
 *
 * **`samples` is not chosen here** — it is derived, because a number the caller has to
 * keep in step with the model's size is a number that will be wrong.
 */
export interface MeshBudget {
  /** World units per sample. Smaller is finer and slower. */
  readonly voxelSize: number;
  /** The most samples on any one axis, whatever the model's size asks for. */
  readonly maxSamplesPerAxis: number;
  /** The fewest, so a tiny model is still more than one cell. */
  readonly minSamplesPerAxis: number;
}

/**
 * The default budget, and every number in it is a trade rather than a default.
 *
 * - **`voxelSize: 0.25`** puts a surface within an eighth of a unit of where it belongs on
 *   a figure a person is looking at closely. Halving it doubles the samples on each axis,
 *   which is eight times the work, so this is the first number to raise and the reason the
 *   slider is a voxel size rather than a sample count.
 * - **`maxSamplesPerAxis: 96`** is a ceiling on rebuild time. At 96³ the sampling pass is
 *   under a million field evaluations, which is a few tens of milliseconds on a phone and
 *   is why the rebuild is debounced rather than run per frame.
 * - **`minSamplesPerAxis: 8`**, so a model a few millimetres across is not one cell and
 *   therefore not a single vertex.
 */
export const DEFAULT_BUDGET: MeshBudget = {
  voxelSize: 0.25,
  maxSamplesPerAxis: 96,
  minSamplesPerAxis: 8,
};

/**
 * Samples per axis for a model of these bounds.
 *
 * **The model's longest axis gets the budget; the others get the same spacing, not the
 * same count.** Making it a per-axis count would give a long thin model a stretched grid,
 * and the mesher's cell loop assumes cells are cubes.
 */
export const samplesFor = (
  bounds: Bounds,
  budget: MeshBudget = DEFAULT_BUDGET,
): number => {
  const longest = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  const asked = Math.ceil(longest / budget.voxelSize);
  return Math.max(
    budget.minSamplesPerAxis,
    Math.min(budget.maxSamplesPerAxis, asked),
  );
};

/**
 * The model as CSG operations: one `Add` per part.
 *
 * **A union, and nothing else.** Subtraction, intersection and paint are all things the
 * `Combine` type can say and none of them are things this model says, so the mapping is
 * total in one direction: every part is an `Add`. The indices are the parts' positions in
 * the list, which is what makes the fold order the order the parts are listed in — and
 * therefore the order a person can rely on.
 */
export const partsToOperations = (parts: readonly Part[]): Operation[] =>
  parts.map((part, index) =>
    makeOperation(index, part.origin, part.shape, "Add", {
      orientation: part.orientation,
      softness: 0,
    }),
  );

/**
 * A model as a field to sample, ready for `SurfaceSampler`.
 *
 * **`Field.distance` already *is* a `SurfaceSampler`** — one method, negative inside — so
 * the meshing seam needs nothing written for it. The BVH is given the model's own scale as
 * its candidate cell, which is what makes its cost independent of how many parts there
 * are: without it a hundred small parts and one hundred parts of the same total size cost
 * very different amounts.
 */
export const modelField = (
  parts: readonly Part[],
  budget = DEFAULT_BUDGET,
): Field => {
  const operations = partsToOperations(parts);
  const region = meshRegion(parts, budget);
  return new Field(
    new OperationBVH(operations, {
      candidateCell: region?.sampleSize ?? budget.voxelSize * 8,
    }),
    {
      base: () => Infinity,
    },
  );
};

/**
 * Where a model's mesh should be built, and how finely.
 *
 * **`pad` is a whole sample, not a fraction of one.** The mesher emits geometry owned by
 * the samples `1 .. n` on each axis, and a surface within half a cell of the edge of the
 * owned range is lost — which shows up as a figure with its extremities shaved off, and
 * only when the model happens to fill the box exactly.
 */
export const meshRegion = (
  parts: readonly Part[],
  budget: MeshBudget = DEFAULT_BUDGET,
): { origin: Vec3; samples: number; sampleSize: number } | undefined => {
  const bounds = modelBounds(parts, budget.voxelSize);
  if (bounds === undefined) return undefined;
  const samples = samplesFor(bounds, budget);
  // The longest axis fills the budget; the spacing comes from it, so the shorter axes are
  // covered with fewer samples rather than stretched.
  const longest = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  const sampleSize = longest / samples;
  return {
    // One sample back from the low corner, because `surfaceNets` puts sample `0` one step
    // *before* the origin it is given — see `SurfaceNetsParams.origin`.
    origin: {
      x: bounds.min.x + sampleSize,
      y: bounds.min.y + sampleSize,
      z: bounds.min.z + sampleSize,
    },
    samples,
    sampleSize,
  };
};

/** What one rebuild produced, and what it cost. */
export interface MeshResult {
  readonly mesh: ChunkMesh;
  readonly region: NonNullable<ReturnType<typeof meshRegion>>;
  /** Field evaluations, for the readout and for the budget test. */
  readonly samples: number;
  /** Triangles, zero when the model has no surface in the box. */
  readonly triangles: number;
}

/**
 * Meshes a whole model.
 *
 * **`undefined` for a model with no parts**, which is different from a model that meshes
 * to nothing. The first has nothing to draw and the caller should show an empty scene; the
 * second has parts and the caller should leave the previous mesh up rather than blanking
 * the screen because a shape is smaller than one sample.
 */
export const meshModel = (
  parts: readonly Part[],
  budget: MeshBudget = DEFAULT_BUDGET,
): MeshResult | undefined => {
  const region = meshRegion(parts, budget);
  if (region === undefined) return undefined;

  const field = modelField(parts);
  const builder = new ChunkMeshBuilder();
  surfaceNets({
    origin: [region.origin.x, region.origin.y, region.origin.z],
    samples: region.samples,
    sampleSize: region.sampleSize,
    // `Field.distance` already *is* a `SurfaceSampler`: one method, negative inside.
    sampler: field,
    out: builder,
    scratch: scratchFor(region.samples),
  });

  return {
    mesh: builder.finish(),
    region,
    samples: (region.samples + 2) ** 3,
    triangles: builder.triangleCount,
  };
};
