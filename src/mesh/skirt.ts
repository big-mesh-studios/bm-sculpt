/**
 * Skirts: the geometry that hides a crack between two chunks at different levels.
 *
 * At a level-of-detail boundary the two chunks sample the same field at different
 * strides, so their surfaces meet at slightly different places. Along the shared face the
 * fine mesh has roughly twice as many boundary vertices as the coarse one, and the two do
 * not line up — the result is a hairline slit, measured at one to two fine samples wide on
 * the terrain in this project. A skirt is a short flap of geometry dropped from the open
 * boundary of the higher-detail side, spreading outward into the neighbour and downward, so
 * the slit is covered rather than closed.
 *
 * **Why a skirt rather than a refined boundary cell.** The obvious exact fix is to make the
 * coarse chunk mesh its boundary shell at the fine stride. Surface Nets' sample positions
 * are a per-axis tensor product, so refining one face refines that axis across the whole
 * chunk — it cannot localise. Doing it properly means a separately meshed fine shell stitched
 * to the coarse interior, which is stitched surface nets (ADR 0003 defers it). A skirt is
 * local, needs no protocol change beyond a six-bit mask, and covers a sub-voxel slit
 * completely.
 *
 * **Which edges get one.** A chunk does not emit the quads on the other side of its own
 * boundary, so the boundary of its triangle mesh is exactly the set of edges used by one
 * triangle. Those are the edges a skirt drops from. Only edges near a face whose neighbour
 * is at a different level are skirted, so a same-level seam — which is watertight already —
 * pays nothing.
 *
 * The material draws both sides, so a skirt's winding never decides whether it is visible;
 * the normals are still set to the face's outward direction so it shades like the wall it is.
 */

import type { Bounds, Rgb8 } from "../constants";
import { SKIRT_X_NEG, SKIRT_X_POS, SKIRT_Z_NEG, SKIRT_Z_POS } from "../world";

import type { ChunkMeshBuilder } from "./chunk-mesh";

/**
 * The faces a skirt is built on, and which way is outward.
 *
 * Only the four vertical faces. The terrain's surface is a sheet in one layer of y cells, so
 * a level-of-detail crack is where two horizontally adjacent chunks meet — a vertical face.
 * A crack across a horizontal face would need the level to differ between the chunk holding
 * the ground and the air above it, which it does not at any point the surface exists.
 */
const SIDES = [
  { bit: SKIRT_X_NEG, dir: [-1, 0, 0], axis: 0, side: -1 },
  { bit: SKIRT_X_POS, dir: [1, 0, 0], axis: 0, side: 1 },
  { bit: SKIRT_Z_NEG, dir: [0, 0, -1], axis: 2, side: -1 },
  { bit: SKIRT_Z_POS, dir: [0, 0, 1], axis: 2, side: 1 },
] as const;

const VERTICAL_SIDES = SKIRT_X_NEG | SKIRT_X_POS | SKIRT_Z_NEG | SKIRT_Z_POS;

const positionOf = (
  builder: ChunkMeshBuilder,
  index: number,
): { x: number; y: number; z: number } => ({
  x: builder.positions.at(index * 3),
  y: builder.positions.at(index * 3 + 1),
  z: builder.positions.at(index * 3 + 2),
});

const colourOf = (builder: ChunkMeshBuilder, index: number): Rgb8 => ({
  r: builder.colours.at(index * 4),
  g: builder.colours.at(index * 4 + 1),
  b: builder.colours.at(index * 4 + 2),
});

/**
 * Drops a skirt from every open boundary edge of `builder` that lies on a skirted face.
 *
 * `bounds` is the chunk's own world extent and `sampleSize` one sample, so an edge is "on"
 * a face when both its endpoints are within a shell around that face. The shell is two
 * samples thick because the boundary of the emitted surface runs through the chunk's first
 * and last owned cells *and* the one cell of padding the seam rule takes, which reaches a
 * sample beyond the extent.
 */
export const addSkirts = (
  builder: ChunkMeshBuilder,
  mask: number,
  bounds: Bounds,
  sampleSize: number,
): void => {
  if ((mask & VERTICAL_SIDES) === 0 || sampleSize <= 0) return;
  const triangles = builder.indices.size;
  if (triangles < 3) return;

  // How many triangles each edge belongs to, keyed by its lower index first. An edge used
  // once is on the mesh's open boundary; one used twice is interior.
  const uses = new Map<string, number>();
  for (let at = 0; at + 2 < triangles; at += 3) {
    const a = builder.indices.at(at);
    const b = builder.indices.at(at + 1);
    const c = builder.indices.at(at + 2);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }

  const shell = sampleSize * 2 + 1e-6;
  const onFace = (index: number, axis: 0 | 2, side: number): boolean => {
    const value =
      axis === 0
        ? builder.positions.at(index * 3)
        : builder.positions.at(index * 3 + 2);
    const lo = axis === 0 ? bounds.min.x : bounds.min.z;
    const hi = axis === 0 ? bounds.max.x : bounds.max.z;
    return side < 0 ? value <= lo + shell : value >= hi - shell;
  };

  // Outward into the neighbour and down past the slit. Generous against a crack of one to
  // two samples and cheap against a chunk's triangle count, and the extra reach is what
  // closes the pinhole where two level steps meet at a corner, where the two faces' flaps
  // have to overlap rather than merely abut.
  const outward = sampleSize * 2;
  const depth = sampleSize * 3;

  for (const [key, count] of uses) {
    if (count !== 1) continue;
    const [a, b] = key.split(",").map(Number) as [number, number];
    for (const face of SIDES) {
      if ((mask & face.bit) === 0) continue;
      if (!onFace(a, face.axis, face.side) || !onFace(b, face.axis, face.side))
        continue;

      const pa = positionOf(builder, a);
      const pb = positionOf(builder, b);
      const underA = builder.vertex(
        pa.x + face.dir[0] * outward,
        pa.y - depth,
        pa.z + face.dir[2] * outward,
      );
      const underB = builder.vertex(
        pb.x + face.dir[0] * outward,
        pb.y - depth,
        pb.z + face.dir[2] * outward,
      );
      builder.setNormal(underA, face.dir[0], 0, face.dir[2]);
      builder.setNormal(underB, face.dir[0], 0, face.dir[2]);
      builder.setColour(underA, colourOf(builder, a));
      builder.setColour(underB, colourOf(builder, b));
      builder.quad(a, b, underB, underA);
      break;
    }
  }
};
