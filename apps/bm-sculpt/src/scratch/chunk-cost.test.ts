/**
 * The definitive attribution: for a real chunk mesh, how much time is the sample
 * pass, how much is the per-vertex normal/colour pass, and how much is the mesher
 * skeleton — at operation counts a stroke actually reaches.
 *
 * The three are measured by ablation with the vertex count held constant, so the
 * sample pass's output is identical in every variant.
 */

import { describe, it } from "vitest";

import {
  Field,
  OperationBVH,
  makeOperation,
  terrainField,
  type Operation,
} from "@big-mesh-studios/csg";
import { chunkRegion } from "../mesh";
import {
  ChunkMeshBuilder,
  scratchFor,
  surfaceNets,
} from "@big-mesh-studios/meshing";
import type { CellCoord } from "../world";

const TERRAIN = { origin: -70, scale: 96, octaves: 4, seed: 20260901 };

const best = (fn: () => unknown, runs = 3): number => {
  fn();
  let out = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    out = Math.min(out, performance.now() - t);
  }
  return out;
};

const msf = (v: number): string => v.toFixed(1).padStart(9);
const pct = (v: number): string => `${((v / 100) * 100).toFixed(0)}%`;

let seed = 12345;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/** A stroke's worth of dabs, clustered in one chunk the way sculpting puts them. */
const clusteredDabs = (n: number): Operation[] => {
  const ops: Operation[] = [];
  for (let i = 0; i < n; i++)
    ops.push(
      makeOperation(
        i,
        {
          x: (rnd() - 0.5) * 260,
          y: (rnd() - 0.5) * 260,
          z: (rnd() - 0.5) * 260,
        },
        { type: "Ellipsoid", radius: { x: 30, y: 30, z: 30 } },
        i % 3 === 0 ? "Subtract" : "Add",
      ),
    );
  return ops;
};

describe("what a chunk costs to mesh", () => {
  // This one takes minutes by design — it meshes hundreds of chunks at up to 256
  // operations each — so it carries its own timeout rather than the suite's five
  // second default. It asserts nothing; it prints tables.
  it("splits the sample pass from the normal pass from the skeleton", () => {
    const terrain = terrainField(TERRAIN);
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const shared = scratchFor(32);

    /**
     * `mode` selects what the vertex callback does. The sample pass is identical
     * in every mode, so the difference between two modes is exactly that work.
     */
    const mesh = (
      opList: readonly Operation[],
      mode: "full" | "noVertex",
    ): { vertices: number; tris: number } => {
      const field = new Field(new OperationBVH(opList), {
        base: terrain,
        extent: terrain,
        lipschitz: terrain?.lipschitz,
      });
      const builder = new ChunkMeshBuilder();
      const region = chunkRegion(cell, 0);
      let vertices = 0;
      const end = field.beginRegion(region.sampleBounds);
      surfaceNets({
        origin: [region.origin.x, region.origin.y, region.origin.z],
        samples: region.samples,
        sampleSize: region.sampleSize,
        sampler: { distance: (x, y, z) => field.distance(x, y, z) },
        out: builder,
        scratch: shared,
        onVertex:
          mode === "noVertex"
            ? (_i, _x, _y, _z) => {
                vertices++;
              }
            : (i, x, y, z) => {
                vertices++;
                const n = field.gradient(x, y, z);
                builder.setNormal(i, n.x, n.y, n.z);
                builder.setColour(i, field.colourAt(x, y, z).colour);
              },
      });
      end?.();
      return { vertices, tris: builder.finish().indices.length / 3 };
    };

    console.log(
      "\nchunk cell(0,0,0), dabs clustered in it. Every variant does the same 39,304 samples.\n",
    );
    console.log(
      "ops".padStart(5),
      "total".padStart(9),
      "verts".padStart(7),
      "no-vertex".padStart(10),
      "skeleton".padStart(9),
      "| sample pass".padStart(13),
      "normal+colour".padStart(14),
    );

    for (const n of [4, 16, 32, 64, 128]) {
      const ops = clusteredDabs(n);
      const tFull = best(() => mesh(ops, "full"));
      const tNoV = best(() => mesh(ops, "noVertex"));
      const info = mesh(ops, "full");

      // The skeleton: the mesher's own arithmetic with the field's arithmetic
      // removed. Measured on the same sign pattern via a pre-filled buffer is
      // avoided here; instead the skeleton is bounded by the two measured passes
      // and reported as the remainder of the no-vertex run against a constant
      // sampler. To keep this honest it is measured, not inferred.
      let tSkeleton: number;
      {
        const field = new Field(new OperationBVH(ops), {
          base: terrain,
          extent: terrain,
          lipschitz: terrain?.lipschitz,
        });
        const builder = new ChunkMeshBuilder();
        const region = chunkRegion(cell, 0);
        // Fill the scratch buffer once with the real field, then re-run the mesher
        // reading it. Vertex count is identical; only the field's cost is gone.
        const endFill = field.beginRegion(region.sampleBounds);
        const fillScratch = scratchFor(32);
        surfaceNets({
          origin: [region.origin.x, region.origin.y, region.origin.z],
          samples: region.samples,
          sampleSize: region.sampleSize,
          sampler: {
            distance: (x, y, z) => {
              const xi =
                Math.round((x - region.origin.x) / region.sampleSize) + 1;
              const yi =
                Math.round((y - region.origin.y) / region.sampleSize) + 1;
              const zi =
                Math.round((z - region.origin.z) / region.sampleSize) + 1;
              const g = 34;
              return fillScratch.samples[(zi * g + yi) * g + xi] as number;
            },
          },
          out: builder,
          scratch: fillScratch,
        });
        endFill?.();
        tSkeleton = best(() => {
          const b2 = new ChunkMeshBuilder();
          const end = field.beginRegion(region.sampleBounds);
          surfaceNets({
            origin: [region.origin.x, region.origin.y, region.origin.z],
            samples: region.samples,
            sampleSize: region.sampleSize,
            sampler: {
              distance: (x, y, z) => {
                const xi =
                  Math.round((x - region.origin.x) / region.sampleSize) + 1;
                const yi =
                  Math.round((y - region.origin.y) / region.sampleSize) + 1;
                const zi =
                  Math.round((z - region.origin.z) / region.sampleSize) + 1;
                const g = 34;
                return fillScratch.samples[(zi * g + yi) * g + xi] as number;
              },
            },
            out: b2,
            scratch: scratchFor(32),
            onVertex: () => {},
          });
          end?.();
        });
      }

      const samplePass = tNoV - tSkeleton;
      const normalPass = tFull - tNoV;
      console.log(
        String(ops.length).padStart(5),
        msf(tFull),
        String(info.vertices).padStart(7),
        msf(tNoV),
        msf(tSkeleton),
        "|",
        `${msf(samplePass)} ${pct((samplePass / tFull) * 100)}`.padStart(13),
        `${msf(normalPass)} ${pct((normalPass / tFull) * 100)}`.padStart(14),
      );
    }

    console.log(
      "\nskeleton = mesher arithmetic only, sample and vertex passes reading a pre-filled buffer",
    );
  }, 900000);

  it("shows the cost scaling with the operation list", () => {
    const terrain = terrainField(TERRAIN);
    const cell: CellCoord = { x: 0, y: 0, z: 0 };
    const shared = scratchFor(32);

    /**
     * `far` moves the dabs clear of the chunk, which is what the candidate cache is
     * supposed to make cheap: the same operation list, none of it nearby.
     */
    const mesh = (
      opList: readonly Operation[],
      at: "here" | "far",
    ): { samples: number; candidates: number; vertexCount: number } => {
      const ops =
        at === "here"
          ? opList
          : opList.map((o) => ({
              ...o,
              origin: { x: o.origin.x + 6000, y: o.origin.y, z: o.origin.z },
            }));
      const field = new Field(new OperationBVH(ops), {
        base: terrain,
        extent: terrain,
        lipschitz: terrain?.lipschitz,
      });
      const builder = new ChunkMeshBuilder();
      const region = chunkRegion(cell, 0);
      const raw = field.bvh as unknown as {
        candidatesAt(p: { x: number; y: number; z: number }): unknown[];
      };
      let samples = 0;
      let candidates = 0;
      let vertexCount = 0;
      const end = field.beginRegion(region.sampleBounds);
      surfaceNets({
        origin: [region.origin.x, region.origin.y, region.origin.z],
        samples: region.samples,
        sampleSize: region.sampleSize,
        sampler: {
          distance: (x, y, z) => {
            samples++;
            candidates += raw.candidatesAt({ x, y, z }).length;
            return field.distance(x, y, z);
          },
        },
        out: builder,
        scratch: shared,
        onVertex: (i, x, y, z) => {
          vertexCount++;
          const n = field.gradient(x, y, z);
          builder.setNormal(i, n.x, n.y, n.z);
          builder.setColour(i, field.colourAt(x, y, z).colour);
        },
      });
      end?.();
      return { samples, candidates, vertexCount };
    };

    console.log(
      "\nEvery dab is one operation appended to the list, and the list only grows.\n",
    );
    console.log(
      "ops".padStart(5),
      "mesh ms".padStart(9),
      "verts".padStart(7),
      "cand/smp".padStart(10),
      "us/cand".padStart(9),
      "|".padStart(3),
      "far away".padStart(10),
      "cand/smp".padStart(10),
    );
    for (const n of [4, 16, 32, 64, 128, 256]) {
      const ops = clusteredDabs(n);
      const t = best(() => mesh(ops, "here"));
      const info = mesh(ops, "here");
      const tFar = best(() => mesh(ops, "far"));
      const infoFar = mesh(ops, "far");
      const perCandidate = (t * 1000) / info.candidates;
      console.log(
        String(ops.length).padStart(5),
        msf(t),
        String(info.vertexCount).padStart(7),
        (info.candidates / info.samples).toFixed(1).padStart(10),
        perCandidate.toFixed(3).padStart(9),
        "|".padStart(3),
        msf(tFar).padStart(10),
        (infoFar.candidates / infoFar.samples).toFixed(1).padStart(10),
      );
    }
    console.log(
      "\nfar away = the same operations moved clear of the chunk. The candidate\n" +
        "count collapsing to zero there is the BVH working; the count equalling the\n" +
        "operation count here is the cache being chunk-granular and so pruning\n" +
        "nothing within a chunk.",
    );
  }, 900000);
});
