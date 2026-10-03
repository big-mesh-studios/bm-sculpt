/**
 * What one chunk's worth of sampling costs.
 *
 * ## Why this is here and not in `packages/csg`
 *
 * **Because it is measured at *this application's* scale, and that is the only scale the number
 * means anything at.** The field it builds is `CHUNK_VOXELS + FIELD_BORDER` samples a side, spaced
 * `VOXEL_SIZE` apart — every one of those four numbers belongs to `apps/bm-sculpt` and to nothing
 * in `packages/csg`, which has no chunk and no voxel size to name. A CSG package carrying its own
 * idea of what a chunk is would be exactly the coupling ADR 0024 took apart: the cost of a field
 * would be a second app's number, and it would change silently when that app's chunk did.
 *
 * The ceiling below is a claim about *this* landscape's streaming. Whether the operation tree is
 * fast enough is a question about the landscape's chunk size, and the answer belongs beside the
 * chunk size.
 */
import { describe, expect, it } from "vitest";

import { Field, makeOperation, OperationBVH } from "@big-mesh-studios/csg";
import type { Operation } from "@big-mesh-studios/csg";
import { CHUNK_VOXELS, FIELD_BORDER, VOXEL_SIZE } from "../constants";

/**
 * Not a benchmark in the sense of reporting a number for its own sake, but a ceiling.
 * The failure it guards against is not "a bit slower" but "ten times slower after a
 * change that looked harmless" — an extra tree traversal per sample, a sort inside the
 * fold, a lost candidate cache. Either is invisible in review and obvious here.
 *
 * Measured: **250-275 ms** for one chunk on an ARM phone. A 2016 laptop is several
 * times quicker, and four workers run four chunks at once.
 *
 * The ceiling is ten times the measurement, which is far too loose to be a claim about
 * this machine and is deliberate on two counts.
 *
 * A ceiling has to hold wherever it runs, and this one runs at 250 ms on its own and
 * over 800 ms as part of the whole suite: the suite runs its files in parallel, so a
 * time-based assertion measures the machine's willingness to serve four threads as much
 * as it measures this code. Set near the measurement it fails on a slow runner; set
 * near the target it fails on the machine doing the measuring.
 *
 * What it is for is catching a *change*, and those are factors of ten, not tens of
 * percent, so a ten-times ceiling separates them from everything else. A regression a
 * few percent slower would not be caught here — and does not need to be, because the
 * second test in this file pins the property such a change would break without
 * reference to a clock at all.
 */
const CHUNK_SAMPLE_BUDGET_MS = 2500;

let seed = 0x9e3779b9;
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};

/**
 * A model roughly the size a session reaches: three hundred brush strokes clustered
 * where the user has been working, plus a few large placed primitives. The
 * clustering is the point — a session's operations are *not* spread evenly, and a
 * synthetic model that spreads them would flatter the cache.
 */
const aSessionsWorthOfOperations = (): Operation[] => {
  const operations: Operation[] = [];
  for (let i = 0; i < 300; i++) {
    operations.push(
      makeOperation(
        i,
        {
          x: (rnd() - 0.5) * 600,
          y: (rnd() - 0.5) * 600,
          z: (rnd() - 0.5) * 600,
        },
        {
          type: "Ellipsoid",
          radius: {
            x: 20 + rnd() * 40,
            y: 20 + rnd() * 40,
            z: 20 + rnd() * 40,
          },
        },
        i % 5 === 0 ? "Subtract" : "Add",
        { softness: rnd() < 0.4 ? rnd() * 0.18 : 0 },
      ),
    );
  }
  for (let i = 0; i < 10; i++) {
    operations.push(
      makeOperation(
        300 + i,
        {
          x: (rnd() - 0.5) * 900,
          y: (rnd() - 0.5) * 900,
          z: (rnd() - 0.5) * 900,
        },
        {
          type: "Box",
          len: {
            x: 60 + rnd() * 120,
            y: 60 + rnd() * 120,
            z: 60 + rnd() * 120,
          },
        },
        "Add",
      ),
    );
  }
  return operations;
};

describe("what a chunk costs to sample", () => {
  it("samples a whole chunk's field inside the budget", () => {
    const operations = aSessionsWorthOfOperations();
    const field = new Field(new OperationBVH(operations));

    const n = CHUNK_VOXELS + FIELD_BORDER * 2;
    const samples = n * n * n;
    void samples;

    // Declared the way the mesher will: one chunk's sample extent, which spans
    // thirty-four voxel positions rather than the thirty-two voxels of the chunk.
    const endRegion = declareChunk(field, (n - 1) * VOXEL_SIZE);

    // One untimed pass, so the measurement is not dominated by a first-call JIT and
    // by whatever the tree build allocated.
    const sweep = (): number => {
      let acc = 0;
      for (let z = 0; z < n; z++) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            acc += field.distance(
              x * VOXEL_SIZE,
              y * VOXEL_SIZE,
              z * VOXEL_SIZE,
            );
          }
        }
      }
      return acc;
    };
    sweep();

    const started = performance.now();
    const total = sweep();
    const elapsed = performance.now() - started;

    // Reported whether or not the assertion passes, so a regression shows its
    // magnitude rather than only that it happened.
    console.log(
      `${samples.toLocaleString()} samples over ${operations.length} operations ` +
        `in ${elapsed.toFixed(1)} ms (${((elapsed * 1000) / samples).toFixed(2)} us/sample)`,
    );
    endRegion();
    expect(total).not.toBe(0);
    expect(elapsed).toBeLessThan(CHUNK_SAMPLE_BUDGET_MS);
  });

  it("spends its rebuilds on chunks, not on samples", () => {
    // The invariant behind the cost above: a chunk's samples share a handful of tree
    // traversals. If this number scales with the sample count then the cache has
    // stopped working, and the budget above would be passing only because the model
    // happens to be small.
    const operations = aSessionsWorthOfOperations();
    const bvh = new OperationBVH(operations);
    const field = new Field(bvh);

    const n = CHUNK_VOXELS + FIELD_BORDER * 2;
    const endRegion = declareChunk(field, (n - 1) * VOXEL_SIZE);
    const before = bvh.rebuilds;
    for (let z = 0; z < n; z++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          field.distance(x * VOXEL_SIZE, y * VOXEL_SIZE, z * VOXEL_SIZE);
        }
      }
    }
    const rebuilds = bvh.rebuilds - before;
    endRegion();
    console.log(`${samples(n)} samples caused ${rebuilds} candidate rebuilds`);
    // Two or three for a chunk: the reuse box is a chunk, and a sweep of a chunk can
    // start a third of one outside the first one's centre.
    expect(rebuilds).toBeLessThanOrEqual(4);
  });

  it("holds a gradient's cost to a few field samples", () => {
    // The mesher pays one gradient per surface vertex, and each is six field
    // evaluations. If this ratio climbs, something is re-querying per evaluation.
    const operations = aSessionsWorthOfOperations();
    const field = new Field(new OperationBVH(operations));

    const point = (): [number, number, number] => [
      (rnd() - 0.5) * 400,
      (rnd() - 0.5) * 400,
      (rnd() - 0.5) * 400,
    ];
    for (let i = 0; i < 50; i++) field.gradient(...point());

    const count = 500;
    const gradientStart = performance.now();
    for (let i = 0; i < count; i++) field.gradient(...point());
    const gradientMs = performance.now() - gradientStart;

    const sampleStart = performance.now();
    for (let i = 0; i < count * 6; i++) {
      const [x, y, z] = point();
      field.distance(x, y, z);
    }
    const sampleMs = performance.now() - sampleStart;

    console.log(
      `${count} gradients ${gradientMs.toFixed(1)} ms vs ${count * 6} samples ` +
        `${sampleMs.toFixed(1)} ms`,
    );
    // Generous: a gradient should be about six samples, and the allowance covers the
    // fixed overhead of the two measurement loops.
    expect(gradientMs).toBeLessThan(sampleMs * 4 + 20);
  });
});

const samples = (n: number): number => n * n * n;

/**
 * Declares the region a chunk's sweep covers, matching where the sweep actually
 * samples rather than where the chunk nominally sits. The two differ by a voxel of
 * border, and declaring the nominal box instead would leave the sweep's last row
 * outside the region — legal, but it costs a second cache build for nothing.
 */
const declareChunk = (field: Field, span: number): (() => void) =>
  field.bvh.beginRegion({
    min: { x: 0, y: 0, z: 0 },
    max: { x: span, y: span, z: span },
  });
