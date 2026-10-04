import { describe, expect, it } from "vitest";

import type { Bounds, Rgb8, Vec3 } from "@big-mesh-studios/core";
import { BLOCK_WORLD, CHUNK_VOXELS, VOXEL_SIZE } from "../constants";
import {
  type CellCoord,
  type Lod,
  cellCentre,
  chunkCellOf,
  lodSampleSize,
  lodSamples,
  OVERLAP_X_NEG,
  OVERLAP_X_POS,
  OVERLAP_Z_NEG,
  OVERLAP_Z_POS,
} from "../world";

import { type ChunkMesh } from "@big-mesh-studios/meshing";
import {
  chunkOriginOn,
  chunkRegion,
  chunkSpan,
  type MeshField,
  type MeshRequest,
  sampleCount,
  sampleSizeAt,
  SurfaceNetsChunkMesher,
} from "./chunk-mesher";

const LOD0: Lod = 0;

/** The three axis names, so a loop over `0 | 1 | 2` can index a `Vec3` or a `CellCoord`. */
const AXES = ["x", "y", "z"] as const;

/** A sphere centred anywhere, plus counters for everything the mesher asked of it. */
const sphere = (centre: Vec3, radius: number) => {
  const calls = {
    distance: 0,
    gradient: 0,
    colour: 0,
    regions: 0,
    skipTests: 0,
  };
  const distance = (x: number, y: number, z: number): number =>
    Math.hypot(x - centre.x, y - centre.y, z - centre.z) - radius;

  const field: MeshField = {
    distance: (x, y, z) => {
      calls.distance++;
      return distance(x, y, z);
    },
    distanceForStepping: distance,
    gradient: (x, y, z) => {
      calls.gradient++;
      const dx = x - centre.x;
      const dy = y - centre.y;
      const dz = z - centre.z;
      const r = Math.hypot(dx, dy, dz) || 1;
      return { x: dx / r, y: dy / r, z: dz / r };
    },
    colourAt: () => {
      calls.colour++;
      return { colour: { r: 10, g: 20, b: 30 }, opacity: 1 };
    },
    beginRegion: () => {
      calls.regions++;
      return () => {};
    },
    couldHoldSurface: () => {
      calls.skipTests++;
      return true;
    },
  };
  return { field, calls, distance };
};

const at = (centre: Vec3, radius = 45) => sphere(centre, radius);

/** A position rounded so comparisons are about geometry, not float printing. */
const key4 = (value: number): string => value.toFixed(4);

const positionOf = (mesh: ChunkMesh, index: number): string =>
  `${key4(mesh.positions[index * 3])},${key4(mesh.positions[index * 3 + 1])},${key4(mesh.positions[index * 3 + 2])}`;

/** Triangles by position, cyclically rotated into a canonical order but not reversed. */
const trianglesOf = (mesh: ChunkMesh): string[] => {
  const triangles: string[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const v = [
      positionOf(mesh, mesh.indices[at]),
      positionOf(mesh, mesh.indices[at + 1]),
      positionOf(mesh, mesh.indices[at + 2]),
    ];
    let first = 0;
    for (let i = 1; i < 3; i++) if (v[i] < v[first]) first = i;
    triangles.push(
      [v[first], v[(first + 1) % 3], v[(first + 2) % 3]].join("|"),
    );
  }
  return triangles;
};

/**
 * Whether two adjacent chunks' meshes meet with no crack and no overlap.
 *
 * Compared **by position**, never by index: each chunk holds its own vertex where its
 * cells meet its neighbour's, so an edge can belong to two triangles in the world while
 * sharing no index pair. An index-wise check reports correct chunking as broken.
 */
const seamIsSealed = (
  ...meshes: ChunkMesh[]
): { bad: number; total: number } => {
  const uses = new Map<string, number>();
  for (const mesh of meshes) {
    for (const triangle of trianglesOf(mesh)) {
      const [a, b, c] = triangle.split("|");
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = p < q ? `${p}~${q}` : `${q}~${p}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }
  }
  let bad = 0;
  for (const count of uses.values()) if (count !== 2) bad++;
  return { bad, total: uses.size };
};

describe("the region a chunk meshes", () => {
  it("is exactly the chunk's own world extent", () => {
    // The extent has to land on chunk boundaries at every level, or a coarse chunk cannot
    // stand in for four fine ones and the level-of-detail scheme collapses.
    for (const lod of [0, 1, 2] as Lod[]) {
      for (const cell of [
        { x: 0, y: 0, z: 0 },
        { x: 3, y: -2, z: 1 },
      ] as CellCoord[]) {
        const region = chunkRegion(cell, lod);
        const centre = cellCentre(cell);
        for (const axis of AXES) {
          expect(region.bounds.min[axis], `lod ${lod} ${axis}`).toBeCloseTo(
            centre[axis] - BLOCK_WORLD / 2,
            9,
          );
          expect(region.bounds.max[axis], `lod ${lod} ${axis}`).toBeCloseTo(
            centre[axis] + BLOCK_WORLD / 2,
            9,
          );
        }
      }
    }
  });

  it("agrees with the level arithmetic the world schedules in", () => {
    for (const lod of [0, 1, 2] as Lod[]) {
      const region = chunkRegion({ x: 0, y: 0, z: 0 }, lod);
      expect(region.samples).toBe(lodSamples(lod));
      expect(region.sampleSize).toBe(lodSampleSize(lod));
      expect(region.samples * region.sampleSize).toBeCloseTo(BLOCK_WORLD, 9);
      expect(chunkSpan(lod)).toBeCloseTo(BLOCK_WORLD, 9);
    }
  });

  it("starts at the origin the mesher is told to use", () => {
    for (const lod of [0, 1, 2] as Lod[]) {
      for (const cell of [
        { x: 0, y: 0, z: 0 },
        { x: -4, y: 5, z: 1 },
      ] as CellCoord[]) {
        const region = chunkRegion(cell, lod);
        expect(region.origin.x).toBeCloseTo(chunkOriginOn(cell, "x", lod), 9);
        expect(region.origin.y).toBeCloseTo(chunkOriginOn(cell, "y", lod), 9);
        expect(region.origin.z).toBeCloseTo(chunkOriginOn(cell, "z", lod), 9);
      }
    }
  });

  it("samples one voxel beyond the chunk on every side", () => {
    // The low side is the seam rule's one cell of padding; the high side is padded to
    // match so the sampling loop is a plain cube rather than a special case on one edge.
    const region = chunkRegion({ x: 0, y: 0, z: 0 }, LOD0);
    for (const axis of AXES) {
      expect(region.sampleBounds.min[axis], axis).toBeCloseTo(
        region.bounds.min[axis] - VOXEL_SIZE,
        9,
      );
      expect(region.sampleBounds.max[axis], axis).toBeCloseTo(
        region.bounds.max[axis] + VOXEL_SIZE,
        9,
      );
    }
  });

  it("puts a coarse chunk's origin on its own stride's grid", () => {
    // A level-of-detail chunk must sit on the grid of its own stride, or its cells will
    // not line up with a neighbour's at the same level and the surface will crack.
    for (const lod of [0, 1, 2] as Lod[]) {
      const size = lodSampleSize(lod);
      const origin = chunkOriginOn({ x: 5, y: 0, z: 0 }, "x", lod);
      expect(origin % size, `lod ${lod}`).toBeCloseTo(0, 9);
    }
  });

  it("counts the samples it will take, padding included", () => {
    expect(sampleCount(0)).toBe((CHUNK_VOXELS + 2) ** 3);
    // Coarser levels take fewer samples of the same chunk, which is what makes them
    // cheaper rather than merely smaller.
    expect(sampleCount(2)).toBeLessThan(sampleCount(0));
  });

  it("names the sample size it will use", () => {
    expect(sampleSizeAt(0)).toBe(VOXEL_SIZE);
    expect(sampleSizeAt(1)).toBe(VOXEL_SIZE * 2);
  });
});

describe("meshing a chunk through the field", () => {
  it("produces a mesh with positions, normals and colours filled in", () => {
    // A normal left at its placeholder of +Y and a colour left at its placeholder of
    // white both pass a length check while meaning nothing, so the fills are counted
    // rather than merely sized.
    const { field, calls } = at({ x: 0, y: 0, z: 0 });
    const mesh = new SurfaceNetsChunkMesher(field).mesh({
      cell: { x: 0, y: 0, z: 0 },
      lod: LOD0,
    });

    expect(mesh.vertexCount).toBeGreaterThan(0);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    expect(mesh.normalOct.length).toBe(mesh.vertexCount * 2);
    expect(mesh.colours.length).toBe(mesh.vertexCount * 4);
    expect(calls.gradient).toBe(mesh.vertexCount);
    expect(calls.colour).toBe(mesh.vertexCount);
  });

  it("points every normal away from the sphere's centre", () => {
    const centre = { x: 20, y: -10, z: 5 };
    const mesh = new SurfaceNetsChunkMesher(at(centre).field).mesh({
      cell: { x: 0, y: 0, z: 0 },
      lod: LOD0,
    });
    expect(mesh.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < mesh.vertexCount; i++) {
      const away = {
        x: mesh.positions[i * 3] - centre.x,
        y: mesh.positions[i * 3 + 1] - centre.y,
        z: mesh.positions[i * 3 + 2] - centre.z,
      };
      const r = Math.hypot(away.x, away.y, away.z) || 1;
      // Read back out of the octahedral pair the way the shader does, rather than
      // trusting the values that went in.
      const u = mesh.normalOct[i * 2] / 32767;
      const v = mesh.normalOct[i * 2 + 1] / 32767;
      const dot =
        (u * away.x + v * away.y + (1 - Math.abs(u) - Math.abs(v)) * away.z) /
        r;
      expect(dot, `vertex ${i}`).toBeGreaterThan(0.5);
    }
  });

  it("writes the field's colour into every vertex", () => {
    const wanted: Rgb8 = { r: 7, g: 8, b: 9 };
    const mesh = new SurfaceNetsChunkMesher({
      ...at({ x: 0, y: 0, z: 0 }).field,
      // **A partial opacity as well as the colour**, because the mesher now scales
      // what it is given into the vertex's fourth byte and this asserts the colour
      // alone would not catch a dropped `Math.round(opacity * 255)`.
      colourAt: () => ({ colour: wanted, opacity: 0.5 }),
    }).mesh({ cell: { x: 0, y: 0, z: 0 }, lod: LOD0 });

    for (let i = 0; i < mesh.vertexCount; i++) {
      expect(mesh.colours[i * 4], `vertex ${i} red`).toBe(7);
      expect(mesh.colours[i * 4 + 1], `vertex ${i} green`).toBe(8);
      expect(mesh.colours[i * 4 + 2], `vertex ${i} blue`).toBe(9);
      expect(mesh.colours[i * 4 + 3], `vertex ${i} alpha`).toBe(128);
    }
  });

  it("declares the sample region for the whole chunk, and ends it afterwards", () => {
    // One candidate cache serving 34,304 samples is the difference between one rebuild
    // and dozens.
    const regions: Bounds[] = [];
    let live = 0;
    const mesher = new SurfaceNetsChunkMesher({
      ...at({ x: 0, y: 0, z: 0 }).field,
      beginRegion: (bounds) => {
        regions.push(bounds);
        live++;
        return () => {
          live--;
        };
      },
    });

    mesher.mesh({ cell: { x: 0, y: 0, z: 0 }, lod: LOD0 });
    mesher.mesh({ cell: { x: 1, y: 0, z: 0 }, lod: LOD0 });

    expect(regions).toHaveLength(2);
    expect(live).toBe(0);
    expect(regions[1].min.x - regions[0].min.x).toBeCloseTo(BLOCK_WORLD, 9);
  });

  it("ends the region even when meshing throws", () => {
    // A worker that kept a stale region after a failure would mesh every later chunk
    // with the wrong candidates, and nothing would say so.
    let live = 0;
    const boom: MeshField = {
      ...at({ x: 0, y: 0, z: 0 }).field,
      beginRegion: () => {
        live++;
        return () => {
          live--;
        };
      },
      distance: () => {
        throw new Error("sampling failed");
      },
    };
    expect(() =>
      new SurfaceNetsChunkMesher(boom).mesh({
        cell: { x: 0, y: 0, z: 0 },
        lod: LOD0,
      }),
    ).toThrow(/sampling failed/);
    expect(live).toBe(0);
  });

  it("reuses its buffers, so a second chunk leaks nothing from the first", () => {
    // Both the scratch and the builder are per-thread and long-lived, so this is the
    // path that actually runs.
    const mesher = new SurfaceNetsChunkMesher(at({ x: 0, y: 0, z: 0 }).field);
    const first = mesher.mesh({ cell: { x: 0, y: 0, z: 0 }, lod: LOD0 });
    const empty = mesher.mesh({ cell: { x: 40, y: 40, z: 40 }, lod: LOD0 });
    const again = mesher.mesh({ cell: { x: 0, y: 0, z: 0 }, lod: LOD0 });

    expect(first.vertexCount).toBeGreaterThan(0);
    // The middle chunk is far from the sphere and has no surface at all; holding on to
    // the first chunk's vertices would give it some.
    expect(empty.vertexCount).toBe(0);
    expect(empty.indices.length).toBe(0);
    expect(again.vertexCount).toBe(first.vertexCount);
    expect(trianglesOf(again)).toEqual(trianglesOf(first));
  });

  it("asks before sampling a chunk that cannot hold a surface", () => {
    // In a terrain world most chunks are entirely air or entirely solid, and answering
    // that with one box test instead of 34,304 evaluations is most of what streaming is.
    const { field, calls } = at({ x: 0, y: 0, z: 0 });
    const mesher = new SurfaceNetsChunkMesher(field);
    expect(mesher.couldHaveMesh({ x: 0, y: 0, z: 0 }, LOD0)).toBe(true);
    expect(calls.skipTests).toBe(1);

    expect(
      new SurfaceNetsChunkMesher({
        ...field,
        couldHoldSurface: () => false,
      }).couldHaveMesh({ x: 0, y: 0, z: 0 }, LOD0),
    ).toBe(false);
  });

  it("gives two mesher instances the same answer", () => {
    // A mesher whose output depended on which instance asked would make the pool's
    // assignment of chunks to workers visible in the model.
    const request: MeshRequest = { cell: { x: 0, y: 0, z: 0 }, lod: LOD0 };
    const one = new SurfaceNetsChunkMesher(at({ x: 0, y: 0, z: 0 }).field).mesh(
      request,
    );
    const other = new SurfaceNetsChunkMesher(
      at({ x: 0, y: 0, z: 0 }).field,
    ).mesh(request);
    expect(trianglesOf(other)).toEqual(trianglesOf(one));
  });

  it("meshes a chunk where it is, not somewhere else", () => {
    // A sign error in the origin still looks plausible on one chunk; it shows up as a
    // mesh that is empty where the model is, and full where it is not.
    const centre = {
      x: 7 * BLOCK_WORLD,
      y: 2 * BLOCK_WORLD,
      z: -3 * BLOCK_WORLD,
    };
    const mesher = new SurfaceNetsChunkMesher(at(centre).field);
    const cell: CellCoord = { x: 7, y: 2, z: -3 };

    expect(mesher.mesh({ cell, lod: LOD0 }).vertexCount).toBeGreaterThan(0);
    // Every other chunk is empty, including the one at the origin where an unsigned
    // origin would have put the sphere.
    expect(
      mesher.mesh({ cell: { x: 0, y: 0, z: 0 }, lod: LOD0 }).vertexCount,
    ).toBe(0);
    expect(
      mesher.mesh({ cell: { x: 7, y: 2, z: -2 }, lod: LOD0 }).vertexCount,
    ).toBe(0);
  });

  it("keeps every vertex inside its chunk's extent plus padding", () => {
    const mesher = new SurfaceNetsChunkMesher(
      at({ x: 150, y: 150, z: 150 }).field,
    );
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const region = chunkRegion(cell, LOD0);
    const mesh = mesher.mesh({ cell, lod: LOD0 });
    expect(mesh.vertexCount).toBeGreaterThan(0);

    for (let i = 0; i < mesh.vertexCount; i++) {
      for (const component of [0, 1, 2] as const) {
        const axis = AXES[component];
        const value = mesh.positions[i * 3 + component];
        expect(value, `vertex ${i} ${axis}`).toBeGreaterThanOrEqual(
          region.sampleBounds.min[axis] - 1e-6,
        );
        expect(value, `vertex ${i} ${axis}`).toBeLessThanOrEqual(
          region.sampleBounds.max[axis] + 1e-6,
        );
      }
    }
  });
});

describe("overlap at a level-of-detail face", () => {
  /**
   * A horizontal plane at `y = 0`, so the surface is a sheet that runs out of the chunk's
   * four vertical faces — and, unlike a closed shape inside the chunk, it is still there in
   * the cell beyond the boundary. That is the cell the overlap exists to reach.
   */
  const plane: MeshField = {
    distance: (_x, y) => y,
    distanceForStepping: (_x, y) => y,
    gradient: () => ({ x: 0, y: 1, z: 0 }),
    colourAt: () => ({ colour: { r: 1, g: 2, b: 3 }, opacity: 1 }),
    couldHoldSurface: () => true,
  };
  const mesher = new SurfaceNetsChunkMesher(plane);
  const request = (overlap?: number): MeshRequest =>
    overlap === undefined
      ? { cell: { x: 0, y: 0, z: 0 }, lod: LOD0 }
      : { cell: { x: 0, y: 0, z: 0 }, lod: LOD0, overlap };

  /**
   * How far the mesh reaches on one axis, which is what an overlap moves.
   *
   * A vertex is the average of crossings inside its own cell, so it sits in the middle of
   * that cell rather than at its edge: the furthest vertex of a chunk that owns no cell
   * past its boundary is half a sample inside it. The assertions below are written as
   * differences for that reason — "one sample further" is the property, and a vertex's
   * exact position within its cell is the mesher's business.
   */
  const reach = (mesh: ChunkMesh, component: 0 | 1 | 2): number => {
    let furthest = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++)
      furthest = Math.max(furthest, mesh.positions[i * 3 + component]);
    return furthest;
  };
  const nearest = (mesh: ChunkMesh, component: 0 | 1 | 2): number => {
    let closest = Infinity;
    for (let i = 0; i < mesh.vertexCount; i++)
      closest = Math.min(closest, mesh.positions[i * 3 + component]);
    return closest;
  };

  it("meshes the cell beyond the boundary on the faces that step", () => {
    // The mechanism, with a face marked the mesh crosses the chunk's own edge by one sample
    // instead of stopping on it. The distinction is the shape: nothing is added below the
    // surface, so this is a surface that continues rather than a flap hanging off it — which
    // is what a tunnel through a level step used to run into.
    const plain = mesher.mesh(request());
    const region = chunkRegion({ x: 0, y: 0, z: 0 }, LOD0);
    expect(plain.vertexCount).toBeGreaterThan(0);
    expect(reach(plain, 0)).toBeCloseTo(
      region.bounds.max.x - VOXEL_SIZE / 2,
      6,
    );

    const overlapped = mesher.mesh(request(OVERLAP_X_POS | OVERLAP_Z_POS));
    expect(reach(overlapped, 0)).toBeCloseTo(
      region.bounds.max.x + VOXEL_SIZE / 2,
      6,
    );
    expect(reach(overlapped, 2)).toBeCloseTo(
      region.bounds.max.z + VOXEL_SIZE / 2,
      6,
    );
    // And the faces that did not step are untouched, which is what the per-axis count in
    // `overlapCells` buys: a whole extra shell would move all three axes.
    expect(reach(mesher.mesh(request(OVERLAP_X_POS)), 2)).toBeCloseTo(
      reach(plain, 2),
      6,
    );
  });

  it("adds nothing when no face has a level step", () => {
    // The common case: a chunk whose neighbours are all at its level, or all coarser, pays
    // nothing. This is most chunks in the world, and it is what keeps the overlap off every
    // same-level seam.
    const plain = mesher.mesh(request());
    const zero = mesher.mesh(request(0));
    expect(zero.vertexCount).toBe(plain.vertexCount);
    expect(zero.triangleCount).toBe(plain.triangleCount);
    expect(trianglesOf(zero)).toEqual(trianglesOf(plain));
  });

  it("reaches one cell lower for a face whose neighbour below is finer", () => {
    // The other end, and the reason the mesher's run is described by its origin rather
    // than by a range: a cell below index one does not exist, so an overlap at the low end
    // is a region one cell lower and the same run length.
    const plain = mesher.mesh(request());
    const below = mesher.mesh(request(OVERLAP_X_NEG | OVERLAP_Z_NEG));
    const region = chunkRegion({ x: 0, y: 0, z: 0 }, LOD0);
    // One cell lower and the same run length, so the far end of the chunk does not move.
    // The near end is one sample further out than it was — and one further than the plain
    // mesh's, whose low padding cell already sits half a sample below the boundary.
    expect(reach(below, 0)).toBeCloseTo(reach(plain, 0), 6);
    expect(nearest(below, 0)).toBeCloseTo(nearest(plain, 0) - VOXEL_SIZE, 6);
    expect(nearest(plain, 0)).toBeCloseTo(
      region.bounds.min.x - VOXEL_SIZE / 2,
      6,
    );
  });

  it("samples the cells the overlap added, or the cache answers for elsewhere", () => {
    // The candidate cache is told a region and answers every sample inside it from the
    // candidates gathered for it. A region that does not cover the extra cell's samples
    // gets those samples answered from somewhere else, which is a surface with holes in it
    // and nothing reporting an error.
    const regions: Bounds[] = [];
    const counted = new SurfaceNetsChunkMesher({
      ...plane,
      beginRegion: (bounds) => {
        regions.push(bounds);
        return () => {};
      },
    });
    counted.mesh(request(OVERLAP_X_POS));
    expect(regions).toHaveLength(1);
    expect(regions[0]?.max.x).toBeCloseTo(
      chunkRegion({ x: 0, y: 0, z: 0 }, LOD0).sampleBounds.max.x + VOXEL_SIZE,
      6,
    );
  });

  it("asks the skip gate about the cells the overlap added", () => {
    // A gate that tested only the chunk's own extent could answer "nothing here" for a
    // chunk whose only surface is in the cell it reaches into — a hole with nothing to fill
    // it, since nothing would ever ask again.
    const asked: Bounds[] = [];
    const counted = new SurfaceNetsChunkMesher({
      ...plane,
      couldHoldSurface: (bounds) => {
        asked.push(bounds);
        return true;
      },
    });
    counted.couldHaveMesh({ x: 0, y: 0, z: 0 }, LOD0, OVERLAP_X_POS);
    expect(asked[0]?.max.x).toBeCloseTo(
      chunkRegion({ x: 0, y: 0, z: 0 }, LOD0).sampleBounds.max.x + VOXEL_SIZE,
      6,
    );
  });
});

describe("the seam, through the field", () => {
  // The mesher's own tests pin the seam for a bare sampler with hand-written origins.
  // Here the field supplies the samples and the origin comes from level arithmetic, so
  // the seam also has to survive the two agreeing about where a chunk begins — and no
  // single-chunk test can see a disagreement about that.
  it("seals the boundary between two chunks on each axis", () => {
    for (const axis of [0, 1, 2] as const) {
      // Centred on the *boundary* between the two chunks rather than inside either, so
      // that the surface genuinely has to cross from one chunk's cells into the other's.
      const centre = { x: 40, y: 40, z: 40 };
      centre[AXES[axis]] = BLOCK_WORLD / 2;
      const mesher = new SurfaceNetsChunkMesher(at(centre, 60).field);

      const low: CellCoord = { x: 0, y: 0, z: 0 };
      const high: CellCoord = { x: 0, y: 0, z: 0 };
      high[AXES[axis]] = 1;

      const a = mesher.mesh({ cell: low, lod: LOD0 });
      const b = mesher.mesh({ cell: high, lod: LOD0 });
      expect(
        a.triangleCount,
        `axis ${axis}: low chunk is empty`,
      ).toBeGreaterThan(0);
      expect(
        b.triangleCount,
        `axis ${axis}: high chunk is empty`,
      ).toBeGreaterThan(0);

      const { bad, total } = seamIsSealed(a, b);
      expect(
        bad,
        `axis ${axis}: ${bad} of ${total} edges are not shared by two triangles`,
      ).toBe(0);
    }
  });

  it("gives every quad to exactly one chunk of a tiled region", () => {
    // The ownership rule stated as its consequence: across a region meshed as several
    // chunks, no triangle appears twice. A quad duplicated would be drawn twice; a rule
    // that let both chunks claim the interface would produce them in pairs.
    // Straddling the corner where the four chunks meet, and flat in z so it stays within
    // the one row of chunks being tiled.
    const centre = { x: BLOCK_WORLD / 2, y: BLOCK_WORLD / 2, z: 0 };
    const mesher = new SurfaceNetsChunkMesher(at(centre, 90).field);

    const tiled = (
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ] as const
    ).map(([x, y, z]) => mesher.mesh({ cell: { x, y, z }, lod: LOD0 }));

    for (const mesh of tiled) expect(mesh.triangleCount).toBeGreaterThan(0);

    const all = tiled.flatMap(trianglesOf);
    expect(all.length).toBeGreaterThan(0);
    expect(all.length, "a quad was claimed by two chunks").toBe(
      new Set(all).size,
    );

    // And the surface is closed across the whole tiled region, seams included.
    const { bad, total } = seamIsSealed(...tiled);
    expect(
      bad,
      `${bad} of ${total} edges are not shared by two triangles`,
    ).toBe(0);
  });
});

describe("where chunks are", () => {
  it("round-trips a world point through its chunk", () => {
    // The mesher derives its origin from the cell and the renderer derives a cell from
    // a world point. If those disagreed, chunks would be meshed where they are not
    // drawn — invisible to any test that only looks at one chunk.
    for (const world of [
      { x: 0, y: 0, z: 0 },
      { x: 159, y: -161, z: 320 },
      { x: -480, y: 1, z: 7 },
      { x: 480, y: 480, z: 480 },
    ] as Vec3[]) {
      const cell = chunkCellOf(world);
      const region = chunkRegion(cell, LOD0);
      const inside =
        world.x >= region.bounds.min.x &&
        world.x < region.bounds.max.x &&
        world.y >= region.bounds.min.y &&
        world.y < region.bounds.max.y &&
        world.z >= region.bounds.min.z &&
        world.z < region.bounds.max.z;
      expect(
        inside,
        `(${world.x}, ${world.y}, ${world.z}) landed in cell ${cell.x},${cell.y},${cell.z}`,
      ).toBe(true);
    }
  });

  it("partitions the world, so no point belongs to two chunks", () => {
    for (const world of [
      { x: 0, y: 0, z: 0 },
      { x: BLOCK_WORLD / 2 - 0.001, y: 0, z: 0 },
      { x: BLOCK_WORLD / 2, y: 0, z: 0 },
      { x: BLOCK_WORLD / 2 + 0.001, y: 0, z: 0 },
    ] as Vec3[]) {
      const cell = chunkCellOf(world);
      const region = chunkRegion(cell, LOD0);
      const inside =
        world.x >= region.bounds.min.x && world.x < region.bounds.max.x;
      expect(inside, `(${world.x}, ${world.y}, ${world.z})`).toBe(true);
    }
  });
});
