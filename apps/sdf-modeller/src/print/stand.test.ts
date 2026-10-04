import { describe, expect, it } from "vitest";
import type { ChunkMesh } from "@big-mesh-studios/meshing";

import {
  boundsAbout,
  boxMesh,
  outwardFaces,
  reachOf,
  signedVolume,
  stoodMesh,
} from "./fixtures";
import { meshBounds, millimetresFor, standOnBed } from "./stand";

/** Stands a mesh up and hands it back whole, so the shared assertions can read it. */
const stand = (mesh: ChunkMesh, heightMm: number): ChunkMesh =>
  stoodMesh(mesh, standOnBed(mesh.positions, mesh.vertexCount, heightMm));

/** A box `size` to a side, sitting with its underside at `bottom` and its centre at `x`/`z`. */
const boxAt = (
  size: number,
  {
    x = 0,
    bottom = 0,
    z = 0,
  }: { x?: number; bottom?: number; z?: number } = {},
): ChunkMesh => {
  const half = size / 2;
  return boxMesh({
    min: { x: x - half, y: bottom, z: z - half },
    max: { x: x + half, y: bottom + size, z: z + half },
  });
};

describe("meshBounds", () => {
  it("reads the box a mesh's own vertices fill", () => {
    expect(meshBounds(boxAt(2).positions, 8)).toEqual({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: 2, z: 1 },
    });
  });

  it("reads only as many vertices as it is told, not the whole array", () => {
    // **The count is an argument rather than being derived**, so it is the argument that says
    // how much of the array is geometry. Four corners, and a fifth well outside them.
    const positions = new Float32Array([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5,
    ]);

    expect(meshBounds(positions, 4)?.max).toEqual({ x: 1, y: 1, z: 0 });
    expect(meshBounds(positions, 5)?.max).toEqual({ x: 5, y: 5, z: 5 });
  });

  it("says a mesh with no vertices has no box rather than a box at the origin", () => {
    expect(meshBounds(new Float32Array(0), 0)).toBeUndefined();
  });

  it("gives a mesh whose corners are all one point a box of no extent", () => {
    // **Zero, not `undefined`, and the difference is who refuses it.** A mesh at one point does
    // have a box; it is the caller's height check that has to notice the box is flat.
    const flat = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);

    expect(meshBounds(flat, 3)).toEqual({
      min: { x: 1, y: 1, z: 1 },
      max: { x: 1, y: 1, z: 1 },
    });
  });
});

describe("millimetresFor", () => {
  it("makes the model's own height the height asked for", () => {
    const bounds = {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 3, y: 10, z: 3 },
    };

    expect(millimetresFor(bounds, 100)).toBeCloseTo(10, 12);
  });

  it("measures the up axis rather than the longest one", () => {
    // **A model lying on its side is the case that tells the two apart.** Ten across and two up
    // measures as two tall, so asking for twenty makes the across span a hundred.
    const bounds = {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 2, z: 3 },
    };

    expect(millimetresFor(bounds, 20)).toBeCloseTo(10, 12);
  });

  it("refuses a height that is not a size", () => {
    const bounds = boundsAbout(2);

    for (const height of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => millimetresFor(bounds, height)).toThrow(/needs a height/);
    }
  });

  it("refuses a model with no height to print", () => {
    expect(() => millimetresFor(boundsAbout(0), 100)).toThrow(/no height/);
  });
});

describe("standOnBed", () => {
  it("measures the whole model to the height it is asked for", () => {
    for (const height of [40, 100, 12.5]) {
      const stood = stand(boxAt(10), height);
      const reach = reachOf(stood);

      expect(reach.upSpan).toBeCloseTo(height, 6);
      expect(reach.low.up).toBeCloseTo(0, 6);
    }
  });

  it("stands the model on the bed rather than through it", () => {
    // **Sitting high, not floating.** A box whose underside is seven units up has to come down
    // to the bed, and the part of the assertion that matters is that it comes down rather than
    // being scaled into the negative.
    const reach = reachOf(stand(boxAt(3, { bottom: 7 }), 50));

    expect(reach.low.up).toBeCloseTo(0, 6);
    expect(reach.upSpan).toBeCloseTo(50, 6);
  });

  it("stands the model up, so the height it was drawn at is the height printed", () => {
    // Ten up and two across: which of the model's axes is the tall one is the whole of what
    // standing it up decides.
    const tall = boxMesh({
      min: { x: -1, y: 0, z: -1 },
      max: { x: 1, y: 10, z: 1 },
    });
    const reach = reachOf(stand(tall, 100));

    expect(reach.upSpan).toBeCloseTo(100, 6);
    expect(reach.acrossSpan).toBeCloseTo(20, 6);
    expect(reach.frontSpan).toBeCloseTo(20, 6);
  });

  it("centres the model over the middle of the bed", () => {
    const { low, high } = reachOf(stand(boxAt(4, { x: 6, z: -4 }), 40));

    expect(low.across + high.across).toBeCloseTo(0, 6);
    expect(low.front + high.front).toBeCloseTo(0, 6);
  });

  it("winds every face outward, so a slicer still reads a solid", () => {
    // **The assertion the whole turn exists for.** A mirror rather than a turn would leave a
    // model that looks right and prints inside out, and no count of triangles would show it.
    for (const mesh of [boxAt(4), boxAt(4, { x: 6, bottom: 7, z: -4 })]) {
      const stood = stand(mesh, 40);

      expect(signedVolume(stood)).toBeGreaterThan(0);
      expect(outwardFaces(stood)).toBe(stood.triangleCount);
    }
  });

  it("encloses a solid of the room it is measured to", () => {
    // Forty millimetres to a side, and a box's twelve triangles are the box itself, so the room
    // they enclose is its volume.
    expect(signedVolume(stand(boxAt(4), 40))).toBeCloseTo(40 ** 3, 3);
  });

  it("leaves the triangles and the colours exactly where they were", () => {
    // **The stand is a map on positions and nothing else.** A mesh's indices are shared with the
    // colour lanes and with the report, so a stand that reindexed or rebuilt either would break
    // the things downstream of it that have nothing to do with printing.
    const mesh = boxAt(4);
    const stood = stand(mesh, 40);

    expect(stood.indices).toBe(mesh.indices);
    expect(stood.colours).toBe(mesh.colours);
    expect(stood.vertexCount).toBe(mesh.vertexCount);
  });

  it("hands back a new array rather than the one it was given", () => {
    const mesh = boxAt(4);
    const before = Float32Array.from(mesh.positions);

    standOnBed(mesh.positions, mesh.vertexCount, 40);

    expect(Array.from(mesh.positions)).toEqual(Array.from(before));
  });

  it("refuses a mesh with no vertices", () => {
    expect(() => standOnBed(new Float32Array(0), 0, 100)).toThrow(
      /no height to print/,
    );
  });

  it("refuses a height that is not a size, before touching anything", () => {
    expect(() => standOnBed(boxAt(4).positions, 8, 0)).toThrow(
      /needs a height/,
    );
  });
});
