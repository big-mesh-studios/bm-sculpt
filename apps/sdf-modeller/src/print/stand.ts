/**
 * Standing a mesh on a printer's bed and measuring it in millimetres.
 *
 * ## Why a model is measured rather than scaled
 *
 * **Because the world unit here is unitless and a 3MF's is not.** The modeller's own world is
 * in whatever the primitives were placed in — a `Capsule` of `len: 2.2` is two and a bit of
 * something, and nothing in this repository says what that something is in millimetres. A
 * 3MF model part carries `unit="millimeter"` and a slicer reads every number in the file
 * against it, so the export has to know how big the model is before it can write a vertex.
 *
 * So it asks, and the answer is a height rather than a ratio: the export takes how tall the
 * model should stand in millimetres and measures every other length from that. Two people
 * printing the same model at the same height get the same file; the same model at two heights
 * gives two files, and nothing in either records what it would have been otherwise.
 *
 * ## Why the extent is measured over the mesh's own vertices
 *
 * **Because `modelBounds` is deliberately loose and a loose bound would print small.**
 * `partHalfDiagonal` is documented as the smallest axis-aligned bound on a rotated shape that
 * can be computed without rotating anything (see `../model/part`), and `modelBounds` is the
 * union of those. For a model of separate parts that is a bound; for this one it is worse than
 * a bound, because a `Subtract` *removes* material and so makes the solid smaller than the
 * boxes of the parts that made it. Scaling by the union of the part boxes would print a model
 * that came out smaller than the height that was asked for, by however much was cut away.
 *
 * `big-mesh-studios`' equivalent measures over part boxes, which is the right answer there
 * because a figure's size *is* the boxes it was drawn in. Here the mesh is the model, so the
 * mesh is what is measured.
 *
 * ## Why the turn is `(x, y, z) -> (x, -z, y)`
 *
 * **Because it is right-handed and therefore a turn rather than a mirror.** The modeller draws
 * with `+y` up; a slicer reads `+z` up and expects the model sitting on the plate rather than
 * halfway through it. The matrix above has determinant +1, which leaves the mesher's outward
 * winding outward — and outward winding is how a slicer decides which side of a triangle is
 * inside, so standing a model up on the wrong hand would silently turn the solid inside out.
 *
 * The order matters: shift to the origin with the underside down **first**, stand up second,
 * measure third. Standing up before the shift would put the underside on whichever axis
 * happened to end up as the bed.
 */
import type { Vec3 } from "@big-mesh-studios/core";

/** The box a mesh's own vertices fill, or `undefined` when it has no vertices. */
export type MeshBounds = { min: Vec3; max: Vec3 };

/**
 * The box `positions` fills, reading `vertexCount` vertices of three floats each.
 *
 * **`undefined` for a mesh with no vertices**, which is different from a mesh whose vertices
 * are all at one point. The first has nothing to measure and the caller should say so; the
 * second has an extent of zero on every axis and the caller's height check is what refuses it.
 */
export const meshBounds = (
  positions: Float32Array,
  vertexCount: number,
): MeshBounds | undefined => {
  if (vertexCount === 0) return undefined;

  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (let v = 0; v < vertexCount * 3; v += 3) {
    const x = positions[v] as number;
    const y = positions[v + 1] as number;
    const z = positions[v + 2] as number;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }

  return { min, max };
};

/**
 * How many millimetres one world unit is measured as, for a model of this box to stand
 * `heightMm` tall.
 *
 * **The model's own `y` extent and not its longest axis.** The question asked is how *tall* it
 * should stand, and the answer is the axis that is up; measuring the longest axis instead
 * would make a model lying on its side print short.
 *
 * @throws when the model has no height to print, which is a box with no extent in `y`.
 */
export const millimetresFor = (
  bounds: MeshBounds,
  heightMm: number,
): number => {
  if (!Number.isFinite(heightMm) || heightMm <= 0) {
    throw new Error("a printed model needs a height above the bed");
  }

  const tall = bounds.max.y - bounds.min.y;
  if (!(tall > 0)) {
    throw new Error("this model has no height to print");
  }

  return heightMm / tall;
};

/**
 * `positions` brought over the origin, stood up, and measured — a new array of the same length.
 *
 * **Indices are untouched**, so a caller holding a mesh's triangles and colours can pair them
 * with the returned vertices without reindexing anything: the stand is a map on positions and
 * nothing else, which is why it is not folded into the mesher.
 *
 * @throws when the model has no height to print, or the height asked for is not a size.
 */
export const standOnBed = (
  positions: Float32Array,
  vertexCount: number,
  heightMm: number,
): Float32Array => {
  const bounds = meshBounds(positions, vertexCount);
  if (bounds === undefined) {
    throw new Error("this model has no height to print");
  }

  const millimetres = millimetresFor(bounds, heightMm);
  const centreX = (bounds.min.x + bounds.max.x) / 2;
  const centreZ = (bounds.min.z + bounds.max.z) / 2;

  const stood = new Float32Array(positions.length);
  for (let v = 0; v < vertexCount * 3; v += 3) {
    stood[v] = ((positions[v] as number) - centreX) * millimetres;
    stood[v + 1] = -((positions[v + 2] as number) - centreZ) * millimetres;
    stood[v + 2] = ((positions[v + 1] as number) - bounds.min.y) * millimetres;
  }

  return stood;
};
