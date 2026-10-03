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
  marchingCubes,
  marchingCubesScratchFor,
  reportMesh,
  scratchFor,
  surfaceNets,
  type ChunkMesh,
  type MarchingCubesScratch,
  type MeshReport,
  type SurfaceNetsScratch,
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
 * The two meshers, and which one a rebuild uses.
 *
 * **A choice rather than a quality setting, because the two make different promises rather than
 * different sizes.** Surface nets is faster and lighter and is what an edit wants while a finger is
 * down; it is closed wherever the surface is well resolved, which is nearly always and is what makes
 * it a reasonable default. Marching cubes places every vertex on a real crossing of the surface and
 * is closed and manifold at every resolution — a guarantee rather than an observation — which is what
 * a model bound for a slicer wants. ADR 0003 rejected marching cubes for the landscape; the reasons
 * it gives are about streamed chunks at varying levels of detail, and none of them apply to one
 * bounded box.
 *
 * `surfaceNets` is the default because that is what this application was, and because a mesher that
 * arrives a few tens of milliseconds late is more annoying than one that is not quite closed. The
 * status line reports what the mesh actually is either way, so choosing wrong is visible.
 */
export type MeshMode = "surface-nets" | "marching-cubes";

/** The modes, with what a control needs to offer each one. */
export const MESH_MODES: ReadonlyArray<{
  readonly value: MeshMode;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "surface-nets",
    label: "Nets",
    hint: "One vertex per cell. The fewest triangles and the fastest. Closed wherever the surface is well resolved — which is nearly always, but is not a promise.",
  },
  {
    value: "marching-cubes",
    label: "Cubes",
    hint: "Vertices on the true surface, so it follows the model more closely. Closed and manifold at every resolution — this is the one to print.",
  },
];

/**
 * The voxel sizes a control offers, coarsest first.
 *
 * **A list of voxel sizes and not a slider from one to another**, because the cost is cubic in the
 * reciprocal and a slider invites the middle of its travel, where the difference is invisible and the
 * wait is real. Each step here doubles the samples on every axis and so multiplies the work by eight,
 * which is a ratio a person can predict.
 *
 * The ends are the budget's own. `0.5` is coarse enough to see a model's blocking out; `0.0625` is
 * the finest this repository offers, and above it the sampling stops being what limits the surface
 * and the field's own smoothness does.
 */
export const RESOLUTIONS = [0.5, 0.25, 0.125, 0.0625] as const;

/** The budget for one of `RESOLUTIONS`, keeping the other two numbers where they are. */
export const budgetFor = (
  voxelSize: number,
  base: MeshBudget = DEFAULT_BUDGET,
): MeshBudget => ({ ...base, voxelSize });

/**
 * Scratch, held across rebuilds.
 *
 * **Because the alternative is eleven megabytes a rebuild.** Marching cubes' vertex cache is three
 * arrays of `grid² · cells` entries and the field is `grid³` floats, so at the finest resolution a
 * rebuild allocates about twenty megabytes and throws them away — which is longer than the meshing.
 *
 * Each mode holds one, **grown but never shrunk**. A larger buffer is used as it stands: the loops
 * derive their bounds from the region rather than from the buffer, so a region that has got smaller
 * simply uses less of it. Reallocating on every change would mean the common case — nudging a part
 * at the same resolution — is the one that allocates.
 */
const HELD: {
  "surface-nets"?: { count: number; scratch: SurfaceNetsScratch };
  "marching-cubes"?: { count: number; scratch: MarchingCubesScratch };
} = {};

const heldScratch = (
  mode: MeshMode,
  samples: number,
): SurfaceNetsScratch | MarchingCubesScratch => {
  const existing = HELD[mode];
  if (existing !== undefined && existing.count >= samples)
    return existing.scratch;
  if (mode === "marching-cubes") {
    const scratch = marchingCubesScratchFor(samples);
    HELD["marching-cubes"] = { count: samples, scratch };
    return scratch;
  }
  const scratch = scratchFor(samples);
  HELD["surface-nets"] = { count: samples, scratch };
  return scratch;
};

/** Frees the held scratch. For a test that wants the module to start from nothing. */
export const releaseScratch = (): void => {
  delete HELD["surface-nets"];
  delete HELD["marching-cubes"];
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
 * The model as CSG operations, one per part, in list order.
 *
 * **The list order is the fold order, and that now means something.** With every part an
 * `Add` the fold came out the same however the list was arranged, so a part's position was
 * bookkeeping. A `Subtract` in the list makes it not: `A`, `B`, then a difference of `C`
 * is a different solid from the same three parts in another order, and nothing recovers
 * which was meant. So the indices are the parts' positions deliberately, and reordering a
 * model is editing it.
 *
 * **`Paint` is deliberately not reachable from here.** It adds no material — it only
 * colours — and a part's colour counts whatever its boolean is, so a coloured `Add`
 * already covers it. Mapping it would offer a mode that does strictly less than `Add`.
 */
export const partsToOperations = (parts: readonly Part[]): Operation[] =>
  parts.map((part, index) =>
    makeOperation(index, part.origin, part.shape, part.combine, {
      orientation: part.orientation,
      softness: part.softness,
      // **Both or neither.** An opacity with no colour is a number nothing reads, so it is
      // not passed — which keeps `Operation.colour` the single thing that decides whether a
      // part has an appearance of its own.
      ...(part.colour === undefined
        ? {}
        : { colour: part.colour, opacity: part.opacity ?? 1 }),
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
  /**
   * Whether the mesh is closed, manifold and consistently wound.
   *
   * **On every result rather than on request, because the interesting failures are the ones nothing
   * looks like.** A clipped mesh and a mesh whose winding has turned over both draw perfectly, and the
   * only moment a person can act on either is before they send it to a slicer.
   */
  readonly report: MeshReport;
}

/**
 * Meshes one part on its own, centred on the origin, for a preview.
 *
 * ## Why this is not `meshModel([part])`
 *
 * **Because a single-part model is not the part.** `meshModel` folds the list, and a lone
 * `Subtract` folded against a base of `Infinity` comes out as nothing at all — so a preview
 * of a difference would have been an empty scene, which is a very confusing thing to show
 * somebody who is dragging it somewhere. Forcing `Add` and a hard edge gives the primitive's
 * own surface, which is what a preview of a move is: the shape that is going somewhere, not
 * the effect it currently has on the model.
 *
 * ## Why the origin is dropped and the orientation is not
 *
 * **So the mesh comes out in the part's own frame, with its turn already in it.** The caller
 * then only has to set a position to place it, and a drag costs one position write per
 * frame. Keeping the orientation in the mesh rather than on the object also means the
 * preview cannot drift out of step with the part: there is one turn, and it is baked into
 * the vertices.
 *
 * ## Why it is built once rather than per frame of a drag
 *
 * **Because a drag along one axis cannot change a shape**, so after the first build the
 * vertices are exactly right for every remaining frame. See `view/ghost.ts`.
 */
export const primitiveMesh = (
  part: Part,
  budget: MeshBudget = DEFAULT_BUDGET,
): MeshResult | undefined => {
  const local: Part = {
    ...part,
    origin: { x: 0, y: 0, z: 0 },
    combine: "Add",
    softness: 0,
  };
  return meshModel([local], budget);
};

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
  mode: MeshMode = "surface-nets",
): MeshResult | undefined => {
  const region = meshRegion(parts, budget);
  if (region === undefined) return undefined;

  // **The budget, this time.** It was not passed before, which meant the BVH's candidate cell was
  // always the default's eight voxels rather than this region's sample size — so a rebuild at a
  // finer resolution got a candidate cell sized for a coarser one, and the cost of sampling stopped
  // being independent of the resolution the caller asked for.
  const field = modelField(parts, budget);
  const builder = new ChunkMeshBuilder();
  const params = {
    origin: [region.origin.x, region.origin.y, region.origin.z] as const,
    samples: region.samples,
    sampleSize: region.sampleSize,
    // `Field.distance` already *is* a `SurfaceSampler`: one method, negative inside.
    sampler: field,
    out: builder,
    onVertex: (index: number, x: number, y: number, z: number) => {
      /**
       * **The normal and the colour of every vertex, from the field.**
       *
       * This was absent, and its absence was not a cosmetic bug. `ChunkMeshBuilder.vertex`
       * fills an unset normal with `+Y` and an unset colour with white — and the builder's
       * own comment says the `+Y` was chosen to be "a real direction rather than an obvious
       * sentinel", so that a vertex whose normal was never set would shade as though it were
       * right. Which is exactly what happened: this model was being drawn with every normal
       * pointing up and every vertex white.
       *
       * Both come from the field rather than from the mesh, because both are properties of
       * the surface and the mesher knows nothing about fields — `SurfaceSampler` is one
       * method, a distance.
       *
       * **Called once per vertex rather than once per cell**, which is true of both meshers but only
       * matters for one: marching cubes shares a vertex between the cells around an edge, so filling
       * a normal per cell would write the same vertex several times over.
       */
      const normal = field.gradient(x, y, z);
      builder.setNormal(index, normal.x, normal.y, normal.z);
      const { colour, opacity } = field.colourAt(x, y, z);
      builder.setColour(index, colour, Math.round(opacity * 255));
    },
  };

  const scratch = heldScratch(mode, region.samples);
  if (mode === "marching-cubes") {
    marchingCubes({
      ...params,
      scratch: scratch as MarchingCubesScratch,
    });
  } else {
    surfaceNets({ ...params, scratch: scratch as SurfaceNetsScratch });
  }

  const mesh = builder.finish();
  return {
    mesh,
    region,
    samples: (region.samples + 2) ** 3,
    triangles: builder.triangleCount,
    report: reportMesh(mesh),
  };
};
