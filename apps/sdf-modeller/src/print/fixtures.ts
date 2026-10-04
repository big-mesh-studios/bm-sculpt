/**
 * A solid box as a `ChunkMesh`, for tests.
 *
 * ## Why this lives in `src` rather than beside the tests
 *
 * **Because four test files need it and a fixture in a test file is not importable.** The
 * repository's other tests each carry their own helpers, which works while they each need a
 * different one; a box with outward winding, a reach, a signed volume and an outward-face count
 * is wanted by the stand tests, the writer tests and the export tests, and three copies of a
 * winding convention is three chances to have one of them wrong in the direction the tests are
 * supposed to be checking.
 *
 * **Nothing in the application imports it**, so it is not in the bundle — Vite only reaches a
 * module something reachable imports. It is here because the alternative is duplication, not
 * because it ships.
 *
 * ## The winding
 *
 * **Counter-clockwise seen from outside the box**, which is what `reportMesh` measures and what
 * `standOnBed` has to preserve. A fixture wound the other way would make the outwardness tests
 * pass for a mesh that is inside out, which is the one thing those tests exist to catch.
 */
import { ChunkMeshBuilder, type ChunkMesh } from "@big-mesh-studios/meshing";

import type { MeshBounds } from "./stand";

/**
 * A box's eight corners, numbered so that each face below can name four of them in order.
 *
 * ```
 * 3---2      7---6
 * |   |      |   |
 * 0---1      4---5   z0 in front, z1 behind
 * ```
 */
const CORNERS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

/**
 * Six faces of four corners, wound outward.
 *
 * **Derived from the diagram rather than written as indices**, because the numbering above is a
 * picture and this is what the picture means. The alternative is six rows of magic numbers
 * whose winding nothing checks.
 */
const FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 3, 2, 1], // front, facing -z
  [4, 5, 6, 7], // back, facing +z
  [0, 4, 7, 3], // left, facing -x
  [1, 2, 6, 5], // right, facing +x
  [0, 1, 5, 4], // bottom, facing -y
  [3, 7, 6, 2], // top, facing +y
];

/**
 * A solid box from `low` to `high`, wound outward, coloured `colour` on every vertex.
 *
 * **One colour for the whole box rather than per face**, because the interesting colour
 * behaviour is a *gradient*, and a box with one colour has none. Tests that want a gradient
 * build their own vertices; this one wants a solid to stand on the bed.
 */
export const boxMesh = (
  bounds: MeshBounds,
  colour: readonly [number, number, number, number] = [255, 0, 0, 255],
): ChunkMesh => {
  const builder = new ChunkMeshBuilder();

  const span = {
    x: bounds.max.x - bounds.min.x,
    y: bounds.max.y - bounds.min.y,
    z: bounds.max.z - bounds.min.z,
  };

  for (const [u, v, w] of CORNERS) {
    const index = builder.vertex(
      bounds.min.x + u * span.x,
      bounds.min.y + v * span.y,
      bounds.min.z + w * span.z,
    );
    builder.setColour(
      index,
      { r: colour[0], g: colour[1], b: colour[2] },
      colour[3],
    );
  }

  for (const face of FACES) {
    builder.quad(face[0], face[1], face[2], face[3]);
  }

  return builder.finish();
};

/** The box a solid of `size` to a side centred on the origin fills. */
export const boundsAbout = (size: number): MeshBounds => {
  const half = size / 2;
  return {
    min: { x: -half, y: -half, z: -half },
    max: { x: half, y: half, z: half },
  };
};

/** A box centred on the origin, `size` to a side. */
export const centredBox = (
  size: number,
  colour?: readonly [number, number, number, number],
): ChunkMesh => boxMesh(boundsAbout(size), colour);

/**
 * A solid's reach, named for the three directions of a printer rather than for the three axes
 * of the model.
 *
 * **The naming is the assertion.** A model is stood up before it is measured, so its up axis
 * becomes the printer's depth, and a test that says `upSpan` is saying the turn happened.
 */
export const reachOf = (mesh: ChunkMesh) => {
  const low = { across: Infinity, front: Infinity, up: Infinity };
  const high = { across: -Infinity, front: -Infinity, up: -Infinity };

  for (let v = 0; v < mesh.vertexCount * 3; v += 3) {
    low.across = Math.min(low.across, mesh.positions[v] as number);
    high.across = Math.max(high.across, mesh.positions[v] as number);
    low.front = Math.min(low.front, mesh.positions[v + 1] as number);
    high.front = Math.max(high.front, mesh.positions[v + 1] as number);
    low.up = Math.min(low.up, mesh.positions[v + 2] as number);
    high.up = Math.max(high.up, mesh.positions[v + 2] as number);
  }

  return {
    low,
    high,
    acrossSpan: high.across - low.across,
    frontSpan: high.front - low.front,
    upSpan: high.up - low.up,
  };
};

/**
 * The room a solid's own triangles enclose, which is the solid's own volume when they face
 * outward and the negative of it when they face inward.
 */
export const signedVolume = (mesh: ChunkMesh): number => {
  const { positions, indices } = mesh;
  const corner = (at: number) => {
    const v = (indices[at] as number) * 3;
    return [
      positions[v] as number,
      positions[v + 1] as number,
      positions[v + 2] as number,
    ] as const;
  };

  let total = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [corner(t), corner(t + 1), corner(t + 2)];
    total +=
      a[0] * (b[1] * c[2] - b[2] * c[1]) -
      a[1] * (b[0] * c[2] - b[2] * c[0]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
  }

  return total / 6;
};

/**
 * How many of a solid's faces point away from its middle rather than towards it.
 *
 * A box turned about its own middle stays convex, so this is the outwardness of every face of
 * it — which is what a slicer reads a triangle by, and what standing a model up on the wrong
 * hand would silently reverse.
 */
export const outwardFaces = (mesh: ChunkMesh): number => {
  const { positions, indices } = mesh;
  const { low, high } = reachOf(mesh);
  const middle = {
    x: (low.across + high.across) / 2,
    y: (low.front + high.front) / 2,
    z: (low.up + high.up) / 2,
  };

  let outward = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const at = (k: number) => {
      const v = (indices[t + k] as number) * 3;
      return [
        positions[v] as number,
        positions[v + 1] as number,
        positions[v + 2] as number,
      ] as const;
    };
    const [a, b, c] = [at(0), at(1), at(2)];

    const edge = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
    const next = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
    const normal = [
      edge[1] * next[2] - edge[2] * next[1],
      edge[2] * next[0] - edge[0] * next[2],
      edge[0] * next[1] - edge[1] * next[0],
    ] as const;

    const centre = [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ] as const;
    const away = [
      centre[0] - middle.x,
      centre[1] - middle.y,
      centre[2] - middle.z,
    ] as const;

    if (normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2] > 0) {
      outward++;
    }
  }

  return outward;
};

/** `mesh` with its vertices replaced, for asserting on a mesh after something stood it up. */
export const stoodMesh = (
  mesh: ChunkMesh,
  vertices: Float32Array,
): ChunkMesh => ({
  ...mesh,
  positions: vertices,
});
