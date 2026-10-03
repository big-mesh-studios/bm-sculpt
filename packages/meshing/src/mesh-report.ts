/**
 * What is wrong with a mesh.
 *
 * A mesher is easy to believe and easy to get wrong, because almost every mistake it can make still
 * produces something that looks like an object. A dropped quad is invisible from outside a solid, and
 * a flipped triangle is only visible where the lighting happens to disagree with it. So this is a
 * **separate reader** rather than something a mesher checks about itself: a mesher that validated its
 * own output would be a mesher whose bugs and whose checks shared a premise.
 *
 * ## Why positions rather than indices
 *
 * **Because a chunked mesh is watertight without sharing vertices.** Two chunks meeting at a boundary
 * each hold their own vertex where their cells meet — the same world position, two different
 * vertices — so a triangle from one and a triangle from the next are edge-adjacent in the world while
 * sharing no index at all. An index-wise count reports every such pair as unpaired however correct the
 * mesher is. ADR 0003 says this in the context of surface nets, and it is a property of the output
 * format rather than of any one mesher.
 *
 * So an edge here is a pair of **rounded positions**, and the count is how many triangles name that
 * pair. A closed, manifold, consistently wound surface has every such count exactly two.
 *
 * ## What each count means
 *
 * - **`boundaryEdges`** — an edge in exactly one triangle, so the mesh has a hole in it. This is the
 *   number that decides whether a mesh can be printed, and the only one that has to be zero.
 * - **`nonManifoldEdges`** — an edge in three or more triangles, so two shells share an edge.
 * - **`inconsistentEdges`** — an edge whose two triangles traverse it the *same* way round. Somewhere
 *   on the way round the mesh the winding turned over, which is invisible from outside a solid and is
 *   what makes a normal derived from the winding come out inside out over part of a model.
 * - **`degenerateTriangles`** — a triangle with a repeated vertex or no area. Every normal calculation
 *   downstream has to special-case one, and a slicer either rejects it or prints a speck.
 *
 * ## Why winding is measured on edges and not against the normals
 *
 * **The obvious metric — a triangle wound against its own vertex normals — is wrong, and wrong in a way
 * that looks like a fault in the mesh.** On a curved surface the two are nearly perpendicular wherever
 * the surface turns away from the viewer, so the sign of their dot product there is decided by rounding
 * rather than by geometry. A sphere of radius fifty sampled every five units reports a quarter of its
 * triangles reversed, every one of them in a ring at the silhouette, and a perfectly good mesh.
 *
 * Traversal direction is exact and has no such region. Two triangles meeting along an edge form a
 * consistent patch only if they walk that edge in opposite directions; if they walk it the same way, the
 * surface has been turned over between them, and no choice of reference direction would have said so.
 * It is the same test as the edge counts with one more piece of state per edge, and it holds on a flat
 * facet as exactly as on a sphere.
 *
 * ## Rounding is a resolution, and it scales with the mesh
 *
 * **Two vertices a rounding apart are the same vertex for this report and not the same vertex
 * anywhere else.** That is the one place this file is inexact, and the rounding is a
 * **fraction of the mesh's own size** rather than a fixed number of decimal places — because a
 * fixed count cannot serve two scales at once. A figure a few units across has legitimate edges a
 * ten-thousandth of a unit long, and rounding those four decimal places welds two real vertices into
 * one and reports a mesh as non-manifold; a landscape a thousand units across has no feature that
 * small at all.
 *
 * `WELD_PRECISION` is that fraction, and it sits above the noise floor of the `Float32Array` the
 * positions arrive in — seven significant digits — by about as much as float32 is imprecise. Below
 * it, two writes of the same point stop agreeing with each other and the whole count is noise.
 *
 * **A caller who knows better can say so**, since a mesh whose features are legitimately smaller
 * than this has one, and the report reports the resolution it used rather than hiding it.
 */

import type { ChunkMesh } from "./chunk-mesh";

/**
 * The welding resolution, as a fraction of the mesh's own extent.
 *
 * **A fraction and not a number of decimal places**, for the reason in this file's header: the
 * question is "are these the same point", and the size of a point depends on how big the model is.
 */
export const WELD_PRECISION = 1e-6;

export interface MeshReportOptions {
  /**
   * Positions closer together than this count as the same vertex, in world units.
   *
   * **The one thing a caller is likely to have an opinion about**, because a model can legitimately
   * have features smaller than any fraction of its own size. Left out, it is derived from the mesh's
   * bounding box.
   */
  readonly quantum?: number;
}

export interface MeshReport {
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Edges in exactly one triangle. Zero is the requirement for a closed solid. */
  readonly boundaryEdges: number;
  /** Edges in three or more triangles. */
  readonly nonManifoldEdges: number;
  /** Edges whose two triangles walk them the same way, so the winding turned over between them. */
  readonly inconsistentEdges: number;
  /** Triangles with a repeated vertex or no area. */
  readonly degenerateTriangles: number;
  /**
   * The distance within which two vertices were treated as one, in world units.
   *
   * **Reported so the numbers above can be read.** A `nonManifoldEdges` count is only meaningful
   * alongside the resolution that produced it: the same mesh can be manifold at one welding
   * resolution and not at another, and a reader told "2" with no scale has been told half of it.
   */
  readonly weldDistance: number;
  /**
   * The enclosed volume by the divergence theorem, in cubic world units.
   *
   * **Signed, and positive when the winding is outward**, so it is a check on the mesh as a whole rather
   * than on any triangle: a mesh whose winding turns over has a volume that is the difference of two
   * numbers rather than either of them. Compared against a shape of known volume it also says whether
   * the mesh is the right size, which no count here can.
   */
  readonly volume: number;
  /**
   * Whether every edge is shared by exactly two triangles, both walking it in opposite directions, and
   * every triangle has area.
   *
   * **The one line a caller puts in front of a person.** Whether that is enough to print is the
   * slicer's business rather than this package's; what it means is that the mesh is closed, manifold and
   * consistently wound, which is everything a mesher is answerable for.
   */
  readonly watertight: boolean;
}

/** The three components of a position, by vertex index. */
const at = (
  positions: Float32Array,
  index: number,
): { x: number; y: number; z: number } => ({
  x: positions[index * 3] as number,
  y: positions[index * 3 + 1] as number,
  z: positions[index * 3 + 2] as number,
});

/**
 * The mesh's own size, as the diagonal of its bounding box.
 *
 * **A box diagonal and not a maximum coordinate, because a model can sit anywhere.** A figure
 * centred a hundred thousand units from the origin has large coordinates and a small diagonal, and a
 * resolution taken from the coordinates would be far coarser than the model.
 */
const extentOf = (positions: Float32Array, vertices: number): number => {
  if (vertices === 0) return 0;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis] as number;
      if (!Number.isFinite(value)) continue;
      if (value < (lo[axis] as number)) lo[axis] = value;
      if (value > (hi[axis] as number)) hi[axis] = value;
    }
  }
  const span = [
    (hi[0] as number) - (lo[0] as number),
    (hi[1] as number) - (lo[1] as number),
    (hi[2] as number) - (lo[2] as number),
  ];
  return Math.hypot(span[0] as number, span[1] as number, span[2] as number);
};

/** What the report learned about one edge from the triangles that named it. */
interface EdgeUse {
  /** How many triangles named it. */
  uses: number;
  /** The direction the first of them walked it: `true` for low key to high. */
  forward: boolean;
  /** Whether every later one walked it the other way. */
  agrees: boolean;
}

/** Every edge, with how many triangles named it and which way they walked it. */
const edgeUses = (
  positions: Float32Array,
  indices: ArrayLike<number>,
  quantum: number,
): Map<string, EdgeUse> => {
  const keys = new Map<number, string>();
  const uses = new Map<string, EdgeUse>();
  // Keyed per vertex rather than per position, so a mesh holding two vertices at the same place — which
  // chunking produces on purpose — does not remeasure the same three numbers once per triangle.
  const keyOf = (index: number): string => {
    const found = keys.get(index);
    if (found !== undefined) return found;
    const p = at(positions, index);
    const made = `${Math.round(p.x / quantum)},${Math.round(p.y / quantum)},${Math.round(p.z / quantum)}`;
    keys.set(index, made);
    return made;
  };

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const corners = [
      indices[i] as number,
      indices[i + 1] as number,
      indices[i + 2] as number,
    ];
    for (const [p, q] of [
      [corners[0], corners[1]],
      [corners[1], corners[2]],
      [corners[2], corners[0]],
    ] as const) {
      const a = keyOf(p);
      const b = keyOf(q);
      const forward = a <= b;
      const edge = forward ? `${a}~${b}` : `${b}~${a}`;
      const seen = uses.get(edge);
      if (seen === undefined)
        uses.set(edge, { uses: 1, forward, agrees: true });
      else {
        seen.uses++;
        if (seen.forward === forward) seen.agrees = false;
      }
    }
  }
  return uses;
};

/**
 * What is wrong with `mesh`.
 *
 * **Reads the finished mesh rather than a builder**, because a builder's buffers are growable and a report
 * of a partly filled one would describe a mesh that does not exist yet.
 */
export const reportMesh = (
  mesh: ChunkMesh,
  options: MeshReportOptions = {},
): MeshReport => {
  const { positions, indices, vertexCount, triangleCount } = mesh;
  const extent = extentOf(positions, vertexCount);
  // **Never zero**, because a degenerate extent would divide by zero and turn every position into
  // `Infinity`, which welds the whole mesh into one vertex and reports a great deal of nonsense very
  // calmly. A mesh with no extent has no edges to count, and the counts below say so.
  const quantum =
    options.quantum ?? Math.max(extent * WELD_PRECISION, Number.EPSILON);

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const seen of edgeUses(positions, indices, quantum).values()) {
    if (seen.uses === 1) boundaryEdges++;
    else if (seen.uses > 2) nonManifoldEdges++;
    else if (!seen.agrees) inconsistentEdges++;
  }

  let degenerateTriangles = 0;
  let volume = 0;
  for (let i = 0; i + 2 < triangleCount * 3; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    const pa = at(positions, a);
    const pb = at(positions, b);
    const pc = at(positions, c);
    const x = (pb.y - pa.y) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.y - pa.y);
    const y = (pb.z - pa.z) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.z - pa.z);
    const z = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    if (a === b || b === c || a === c || Math.hypot(x, y, z) === 0) {
      degenerateTriangles++;
      continue;
    }
    volume +=
      (pa.x * (pb.y * pc.z - pc.y * pb.z) +
        pb.x * (pc.y * pa.z - pa.y * pc.z) +
        pc.x * (pa.y * pb.z - pb.y * pa.z)) /
      6;
  }

  return {
    vertexCount,
    triangleCount,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    degenerateTriangles,
    weldDistance: quantum,
    volume,
    watertight:
      triangleCount > 0 &&
      boundaryEdges === 0 &&
      nonManifoldEdges === 0 &&
      inconsistentEdges === 0 &&
      degenerateTriangles === 0 &&
      volume > 0,
  };
};

/** One line for a readout, and the only description of a report that is ever needed. */
export const describeReport = (report: MeshReport): string => {
  if (report.triangleCount === 0) return "no surface";
  if (report.watertight) {
    return `watertight · ${report.triangleCount} triangles · ${Math.round(report.volume)}u³`;
  }
  if (report.boundaryEdges > 0) {
    return `${report.boundaryEdges} open edge${report.boundaryEdges === 1 ? "" : "s"} — not printable`;
  }
  const problems: string[] = [];
  if (report.nonManifoldEdges > 0) {
    problems.push(`${report.nonManifoldEdges} non-manifold edges`);
  }
  if (report.inconsistentEdges > 0) {
    problems.push(`${report.inconsistentEdges} edges wound the same way`);
  }
  if (report.degenerateTriangles > 0) {
    problems.push(`${report.degenerateTriangles} degenerate triangles`);
  }
  return problems.join(", ");
};
