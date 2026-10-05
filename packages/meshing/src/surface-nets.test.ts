import { describe, expect, it } from "vitest";

import { ChunkMeshBuilder, meshBytes, VERTEX_BYTES } from "./chunk-mesh";
import {
  scratchFor,
  surfaceNets,
  SURFACE_NETS_CELLS,
  SURFACE_NETS_GRID,
  uniformLane,
} from "./surface-nets";
import { sdBox, sdCapsule, sdEllipsoid } from "@big-mesh-studios/sdf";

const STEP = 10;
const N = 16;

/** An edge as an unordered key, so winding is not baked into the comparison. */
const edgeKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;

/** The same, for two already-formatted position keys. */
const positionEdgeKey = (a: string, b: string): string =>
  a < b ? `${a}~${b}` : `${b}~${a}`;

/** How many triangles each distinct edge belongs to. */
const edgeUses = (indices: ArrayLike<number>): Map<string, number> => {
  const uses = new Map<string, number>();
  for (let at = 0; at < indices.length; at += 3) {
    const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]];
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = edgeKey(p, q);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return uses;
};

/** Rounded so that position comparisons are about geometry, not float printing. */
const at4 = (value: number): string => value.toFixed(4);

const positionKey = (out: ChunkMeshBuilder, index: number): string =>
  `${at4(out.positions.at(index * 3))},${at4(out.positions.at(index * 3 + 1))},${at4(out.positions.at(index * 3 + 2))}`;

/**
 * Triangles keyed by position, with the cyclic rotation that puts them in a canonical
 * order but **not** a reversal.
 *
 * Rotation rather than reversal is deliberate: it makes two meshes comparable only if
 * they agree about which way round each triangle goes, so a quad wound backwards at a
 * chunk seam fails this rather than passing quietly.
 */
const canonicalTriangles = (out: ChunkMeshBuilder): string[] => {
  const indices = out.indices.exact();
  const triangles: string[] = [];
  for (let at = 0; at < indices.length; at += 3) {
    const v = [
      positionKey(out, indices[at]),
      positionKey(out, indices[at + 1]),
      positionKey(out, indices[at + 2]),
    ];
    let first = 0;
    for (let i = 1; i < 3; i++) if (v[i] < v[first]) first = i;
    triangles.push(
      [v[first], v[(first + 1) % 3], v[(first + 2) % 3]].join("|"),
    );
  }
  return triangles;
};

/** Eight chunks covering `[0, 2 * span]` on every axis. */
const tileOrigins = (
  span: number,
): ReadonlyArray<readonly [number, number, number]> => {
  const origins: Array<readonly [number, number, number]> = [];
  for (const z of [0, span]) {
    for (const y of [0, span]) {
      for (const x of [0, span]) origins.push([x, y, z]);
    }
  }
  return origins;
};

const mesh = (
  origin: readonly [number, number, number],
  samples: number,
  field: (x: number, y: number, z: number) => number,
  sampleSize = STEP,
  scratch = scratchFor(samples),
  out = new ChunkMeshBuilder(),
): ChunkMeshBuilder => {
  surfaceNets({
    origin,
    samples,
    sampleSize,
    sampler: { distance: field },
    out,
    scratch,
  });
  return out;
};

const sphere = (x: number, y: number, z: number, radius: number): number =>
  Math.hypot(x, y, z) - radius;

const boxField =
  (centre: [number, number, number], half: number) =>
  (x: number, y: number, z: number): number =>
    sdBox(
      { x: half, y: half, z: half },
      { x: x - centre[0], y: y - centre[1], z: z - centre[2] },
    );

const torus =
  (centre: [number, number, number], major: number, minor: number) =>
  (x: number, y: number, z: number): number => {
    const ring = Math.hypot(x - centre[0], y - centre[1]) - major;
    return Math.hypot(ring, z - centre[2]) - minor;
  };

/**
 * A field of four shapes, deliberately awkward: a sphere, a box with flat walls and
 * corners, a thin torus, and a sphere sitting off to one side.
 *
 * Confined to within `[-10, 170]` on every axis, which is the region a single chunk
 * spanning `[0, 160]` can reach once its padding is counted. That confinement is what
 * lets the seam tests below compare a big chunk, a 2x2 tiling and a single-axis pair
 * against each other: each of those covers a *different* volume, so the only way they
 * can be expected to agree is if all of them contain the whole surface. It still crosses
 * the `160` seams on all three axes — the ring reaches 162 on x and y, the pillar 165
 * on z — so the boundary is genuinely exercised.
 */
const mixed = (x: number, y: number, z: number): number => {
  const ball = sphere(x - 80, y - 80, z - 80, 40);
  const wall = boxField([30, 120, 80], 28)(x, y, z);
  const ring = torus([120, 120, 80], 28, 14)(x, y, z);
  const pillar = sphere(x - 80, y - 60, z - 140, 25);
  return Math.min(ball, wall, ring, pillar);
};

describe("the grid a chunk meshes", () => {
  it("pads the sample grid by two and the cell grid by one", () => {
    expect(SURFACE_NETS_GRID(16)).toBe(18);
    expect(SURFACE_NETS_CELLS(16)).toBe(17);
  });

  it("allocates scratch buffers for the padded grid, not the owned count", () => {
    // Sized to `samples` the sample buffer would be too small, and every write past its
    // end is silently dropped while every read past its end returns 0. A field that is
    // uniformly solid then reads as half solid and half air, and the mesher invents a
    // surface in the middle of solid rock.
    const scratch = scratchFor(N);
    const grid = SURFACE_NETS_GRID(N);
    const cells = SURFACE_NETS_CELLS(N);
    expect(scratch.samples.length).toBe(grid * grid * grid);
    expect(scratch.cellVertex.length).toBe(cells * cells * cells);
  });
});

describe("a chunk with a surface in it", () => {
  it("emits vertices and triangles", () => {
    const out = mesh([0, 0, 0], N, (x, y, z) => sphere(x, y, z, 45));
    expect(out.vertexCount).toBeGreaterThan(0);
    expect(out.triangleCount).toBeGreaterThan(0);
    expect(out.indices.size).toBe(out.triangleCount * 3);
  });

  it("emits nothing for a field with no surface anywhere near it", () => {
    // The common case in a terrain world: most chunks are all air, and the mesher has
    // to be able to say so cheaply and without emitting degenerate geometry.
    const out = mesh([0, 0, 0], N, () => 1000);
    expect(out.vertexCount).toBe(0);
    expect(out.triangleCount).toBe(0);
  });

  it("emits nothing for a field that is solid everywhere", () => {
    // The case that catches a mis-sized sample buffer: with one, half the samples read
    // as air and a shell appears around every solid chunk.
    const out = mesh([0, 0, 0], N, () => -1000);
    expect(out.vertexCount).toBe(0);
    expect(out.triangleCount).toBe(0);
  });

  it("keeps every index inside the vertex range", () => {
    const out = mesh([0, 0, 0], N, mixed);
    for (const index of out.indices) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(out.vertexCount);
    }
  });

  it("emits no degenerate triangles", () => {
    // A zero-area face casts as a black speck under any lighting and every downstream
    // normal calculation has to special-case it. The mesher is the only place that can
    // avoid producing one in the first place.
    const out = mesh([0, 0, 0], N, mixed);
    const indices = out.indices.exact();
    for (let at = 0; at < indices.length; at += 3) {
      const [a, b, c] = [indices[at], indices[at + 1], indices[at + 2]];
      expect(
        new Set([a, b, c]).size,
        `triangle at ${at} repeats a vertex`,
      ).toBe(3);
      const [pa, pb, pc] = [a, b, c].map((i) => out.positionOf(i));
      const ux = pb.x - pa.x;
      const uy = pb.y - pa.y;
      const uz = pb.z - pa.z;
      const vx = pc.x - pa.x;
      const vy = pc.y - pa.y;
      const vz = pc.z - pa.z;
      const area =
        Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      expect(area, `triangle at ${at} has area ${area}`).toBeGreaterThan(1e-6);
    }
  });

  it("puts every vertex close to where the field says the surface is", () => {
    // The vertex is the average of a cell's edge crossings, so it sits within half a
    // cell diagonal of the surface it approximates. A vertex far from the surface means
    // the crossing average is wrong, which reads as a surface that is smoothly and
    // unmissably the wrong shape.
    const radius = 45;
    const out = mesh([0, 0, 0], N, (x, y, z) => sphere(x, y, z, radius));
    for (let i = 0; i < out.vertexCount; i++) {
      const p = out.positionOf(i);
      expect(
        Math.abs(sphere(p.x, p.y, p.z, radius)),
        `vertex ${i}`,
      ).toBeLessThan(STEP);
    }
  });

  it("keeps every vertex within the chunk's own extent plus one cell of padding", () => {
    // A vertex outside even the padding would be a vertex belonging to a neighbour,
    // drawn in two places.
    const span = N * STEP;
    const out = mesh([0, 0, 0], N, (x, y, z) =>
      sphere(x - 5, y - 5, z - 5, 40),
    );
    for (let i = 0; i < out.vertexCount; i++) {
      const p = out.positionOf(i);
      for (const [axis, value] of [
        ["x", p.x],
        ["y", p.y],
        ["z", p.z],
      ] as const) {
        expect(value, `vertex ${i} ${axis}`).toBeGreaterThanOrEqual(-STEP);
        expect(value, `vertex ${i} ${axis}`).toBeLessThanOrEqual(span + STEP);
      }
    }
  });
});

/**
 * The seam rule, tested as the property it is for.
 *
 * Each chunk meshes its own cells, but a quad belongs to a primal *edge*, and the four
 * cells around an edge straddle chunk boundaries. Both halves of a boundary could
 * therefore claim the interface quads, or neither could, and either mistake shows up as
 * duplicated geometry or a crack.
 *
 * The rule is that a chunk owning cells `[base, base + n)` emits the edges in that same
 * range, taking the four cells it needs from one cell of low-side padding — so
 * neighbouring chunks emit consecutive, disjoint runs and every edge in the world is
 * emitted exactly once.
 *
 * That is awkward to assert directly and easy to assert *indirectly*: mesh a region as
 * one big chunk, mesh the same region as several small ones, and require the result to
 * be the identical set of triangles. Not the same count, not the same shape — the same
 * triangles. A duplicated quad, a missing quad, a flipped winding and a vertex in the
 * wrong place all fail it.
 */
describe("the seam between chunks", () => {
  it("produces exactly the triangles one big chunk produces", () => {
    // Each chunk spans `N * STEP`, so two of them cover `2 * N * STEP` — which is what
    // `samples: N * 2` describes.
    const span = N * STEP;
    const whole = mesh([0, 0, 0], N * 2, mixed);

    // Tiled on all three axes: the pillar crosses `z = 160`, and a tiling that stopped
    // at `z = 160` would leave that stretch of surface with no owner at all — which is
    // a hole the size of the missing chunks, not a seam.
    const parts: ChunkMeshBuilder[] = [];
    const scratch = scratchFor(N);
    for (const origin of tileOrigins(span)) {
      parts.push(mesh(origin, N, mixed, STEP, scratch));
    }

    const expected = canonicalTriangles(whole);
    const actual = parts.flatMap(canonicalTriangles);

    expect(actual.length).toBe(expected.length);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it("isolates each axis, so a failure says which seam broke", () => {
    // The 2x2x2 tiling above finds a broken seam but does not say which one. Tiling one
    // axis at a time does, and needs a field built for it: the surface has to cross the
    // tiled axis's seam and stay *within* a single chunk on the other two, or the parts
    // of it outside that chunk would simply have no owner and the test would be
    // measuring a missing chunk rather than a seam.
    const span = N * STEP;
    const seam = N * 2 * STEP;
    const centre: [number, number, number] = [85, 85, 85];

    for (const axis of [0, 1, 2] as const) {
      const here: [number, number, number] = [...centre];
      here[axis] = seam;
      const field = (x: number, y: number, z: number): number =>
        sphere(x - here[0], y - here[1], z - here[2], 40);

      const whole = mesh([0, 0, 0], N * 2, field);
      const tiled =
        axis === 0
          ? [mesh([0, 0, 0], N, field), mesh([span, 0, 0], N, field)]
          : axis === 1
            ? [mesh([0, 0, 0], N, field), mesh([0, span, 0], N, field)]
            : [mesh([0, 0, 0], N, field), mesh([0, 0, span], N, field)];

      expect(
        whole.triangleCount,
        `axis ${axis}: nothing to compare`,
      ).toBeGreaterThan(0);
      expect(
        [...tiled.flatMap(canonicalTriangles)].sort(),
        `axis ${axis}`,
      ).toEqual([...canonicalTriangles(whole)].sort());
    }
  });

  it("leaves every edge shared by two triangles, by position", () => {
    // Compared **by position rather than by index**, and the distinction is the whole
    // point. Two chunks meeting at a boundary each hold their own vertex where their
    // cells meet — the same world position, two different vertices — so a triangle from
    // one chunk and a triangle from the next are edge-adjacent in the world while
    // sharing no index. An index-wise count would report those as unpaired however
    // correct the mesher is.
    //
    // Positionally there is nothing to forgive: if chunking duplicated a quad, an edge
    // would belong to four triangles, and if it dropped one, to only one.
    const span = N * STEP;
    const whole = mesh([0, 0, 0], N * 2, mixed);
    const scratch = scratchFor(N);
    const parts = tileOrigins(span).map((origin) =>
      mesh(origin, N, mixed, STEP, scratch),
    );

    const combined = parts.flatMap((part) => canonicalTriangles(part));

    const uses = new Map<string, number>();
    for (const triangle of combined) {
      const [a, b, c] = triangle.split("|");
      for (const [p, q] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const key = positionEdgeKey(p, q);
        uses.set(key, (uses.get(key) ?? 0) + 1);
      }
    }

    const counts: Record<number, number> = {};
    for (const count of uses.values()) counts[count] = (counts[count] ?? 0) + 1;
    expect(counts).toEqual({ 2: uses.size });

    // And the same histogram as one chunk over the whole region, which is the stronger
    // statement: chunking changed neither the surface nor its topology.
    expect(combined.length).toBe(whole.triangleCount);
    expect([...combined].sort()).toEqual([...canonicalTriangles(whole)].sort());
  });

  it("gives each chunk its own vertices at a shared boundary", () => {
    // A chunk meshes only its own cells, so it cannot know a neighbour's. Two chunks
    // either side of a boundary therefore hold *separate* vertices at the same world
    // position — that is expected, and is why the renderer relies on the mesh being
    // watertight rather than on shared indices. What must hold is that the positions
    // agree, or the two halves of the surface will not line up.
    const boundary = N * STEP;
    const low = mesh([0, 0, 0], N, mixed);
    const high = mesh([boundary, 0, 0], N, mixed);
    expect(low.triangleCount).toBeGreaterThan(0);
    expect(high.triangleCount).toBeGreaterThan(0);

    // Every vertex either chunk produced on the interface plane must be at the same
    // world position in both.
    const onPlane = (
      out: ChunkMeshBuilder,
      want: (i: number) => boolean,
    ): string[] => {
      const found: string[] = [];
      for (let i = 0; i < out.vertexCount; i++) {
        if (want(i)) found.push(positionKey(out, i));
      }
      return found.sort();
    };
    const closeTo = (value: number, target: number): boolean =>
      Math.abs(value - target) < 1e-6;

    const lowEdge = onPlane(low, (i) =>
      closeTo(low.positions.at(i * 3), boundary - STEP),
    );
    const highEdge = onPlane(high, (i) =>
      closeTo(high.positions.at(i * 3), boundary - STEP),
    );
    expect(highEdge).toEqual(lowEdge);
  });
});

/**
 * A cell gate, and the case it exists for.
 *
 * The field below is the sea alone: a half-space above a waterline, and nothing else. It
 * is everywhere a water surface would be, including inside the rock, because that is what
 * a radius is. The ground is given separately as a `marker`, and the gate refuses every
 * cell with a corner inside it — which is what turns the sea into water.
 *
 * The ground is a slab with a wall standing out of it rather than noise, so the test can
 * say which cells are being refused and check that the survivors are where it says.
 */
describe("a cell gate", () => {
  /**
   * Open air above `y = 60`, solid below it, with a wall of rock standing up out of the
   * sea between `x = 60` and `x = 100` — so the field has a shoreline for the gate to
   * cut along and cells on both sides of one.
   *
   * `min`, because the floor and the wall are two solids and a point inside either one is
   * inside the ground: the union of two fields is their minimum.
   */
  const groundAt = (x: number, y: number, z: number): number => {
    const wall = sdBox(
      { x: 20, y: 40, z: 40 },
      { x: x - 80, y: y - 70, z: z - 80 },
    );
    return Math.min(y - 60, wall);
  };

  /**
   * The waterline, at `y = 85` — deliberately off the sample grid, which sits on multiples
   * of ten. A surface landing exactly on a sample is a coincidence a gate has to survive
   * but that a test should not depend on, because the sea's own surface lands on nothing.
   */
  const WATERLINE = 85;
  const sea = (_x: number, y: number, _z: number): number => WATERLINE - y;

  /** The question the gate can answer: is any corner of this cell inside the ground? */
  const outOfTheGround = (
    _corners: Float32Array,
    marks: Float32Array,
  ): boolean => {
    for (let corner = 0; corner < 8; corner++)
      if (marks[corner]! < 0) return false;
    return true;
  };

  const gated = (
    origin: readonly [number, number, number],
    samples: number,
    scratch = scratchFor(samples),
    out = new ChunkMeshBuilder(),
  ): ChunkMeshBuilder => {
    surfaceNets({
      origin,
      samples,
      sampleSize: STEP,
      sampler: { distance: sea },
      marker: { distance: groundAt },
      cellGate: outOfTheGround,
      out,
      scratch,
    });
    return out;
  };

  it("emits nothing at all when every crossing cell is refused", () => {
    // The pathological case, and the one that has to be right: a gate that refuses
    // everything must produce an empty mesh rather than a mesh of degenerate triangles,
    // because `quadAcross` refuses a quad naming a vertex that was never emitted.
    const out = new ChunkMeshBuilder();
    surfaceNets({
      origin: [0, 0, 0],
      samples: N,
      sampleSize: STEP,
      sampler: { distance: (x, y, z) => sphere(x, y, z, 45) },
      cellGate: () => false,
      out,
      scratch: scratchFor(N),
    });
    expect(out.vertexCount).toBe(0);
    expect(out.triangleCount).toBe(0);
  });

  it("drops the sea where it runs into the ground", () => {
    const ungated = mesh([0, 0, 0], N * 2, sea);
    const out = gated([0, 0, 0], N * 2);

    expect(ungated.triangleCount).toBeGreaterThan(0);
    expect(out.triangleCount).toBeGreaterThan(0);
    // The wall stands up through the waterline, so the open sea loses the rectangle of
    // waterline the wall occupies — 40 by 80 units out of 320 by 320.
    expect(out.triangleCount).toBeLessThan(ungated.triangleCount);
  });

  it("puts every surviving vertex on the waterline and outside the ground", () => {
    const out = gated([0, 0, 0], N * 2);
    const indices = out.indices.exact();
    expect(indices.length).toBeGreaterThan(0);
    for (let at = 0; at < indices.length; at += 3) {
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[at + corner]!;
        const x = out.positions.at(v * 3)!;
        const y = out.positions.at(v * 3 + 1)!;
        const z = out.positions.at(v * 3 + 2)!;
        // The water surface is flat at 85, so a surviving vertex can be nowhere else —
        // and the ungated mesh also puts vertices down on the floor at 60 and all over
        // the wall, which is what the second half rules out.
        expect(y).toBeCloseTo(WATERLINE, 1);
        expect(groundAt(x, y, z)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("leaves the water alone where the ground is nowhere near it", () => {
    // The gate's failure mode that would be hardest to see: over-refusing and losing the
    // open sea along with the shore. A chunk clear of the wall must come back whole,
    // vertex for vertex, which is the whole of what "the gate removes the wall and
    // nothing else" comes to.
    const out = gated([200, 0, 0], N);
    const ungated = mesh([200, 0, 0], N, sea);
    expect(canonicalTriangles(out)).toEqual(canonicalTriangles(ungated));
  });

  it("agrees with its neighbour about every cell they share", () => {
    // The whole point. Two chunks meshing the same field under the same gate must produce
    // the mesh one chunk covering both produces, or the gate has opened a seam — which is
    // what the ungated seam test above rules out and what this rules out again once a gate
    // and a marker are in play.
    const span = N * STEP;
    const whole = gated([0, 0, 0], N * 2);
    const parts: ChunkMeshBuilder[] = [];
    const scratch = scratchFor(N);
    for (const origin of tileOrigins(span)) {
      parts.push(gated(origin, N, scratch));
    }
    const expected = canonicalTriangles(whole).sort();
    const actual = parts.flatMap(canonicalTriangles).sort();
    expect(actual.length).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  it("reads a zeroed marker as open ground when none was given", () => {
    // Which is what lets a gate written for the sea run on a mesh that was handed no
    // landscape at all: nothing is inside anything, so nothing is refused.
    const withNothing = new ChunkMeshBuilder();
    surfaceNets({
      origin: [0, 0, 0],
      samples: N,
      sampleSize: STEP,
      sampler: { distance: sea },
      cellGate: outOfTheGround,
      out: withNothing,
      scratch: scratchFor(N),
    });
    const withoutGate = mesh([0, 0, 0], N, sea);
    expect(canonicalTriangles(withNothing)).toEqual(
      canonicalTriangles(withoutGate),
    );
  });

  it("changes no existing caller, which passes no gate and no marker", () => {
    // A second sampling pass that only runs when a marker is given is the reason nothing
    // else had to change, and this is what says so.
    const withGate = new ChunkMeshBuilder();
    surfaceNets({
      origin: [0, 0, 0],
      samples: N,
      sampleSize: STEP,
      sampler: { distance: (x, y, z) => sphere(x, y, z, 45) },
      cellGate: () => true,
      out: withGate,
      scratch: scratchFor(N),
    });
    const without = mesh([0, 0, 0], N, (x, y, z) => sphere(x, y, z, 45));
    expect(canonicalTriangles(withGate)).toEqual(canonicalTriangles(without));
  });
});

/**
 * Manifoldness, scoped to what the mesher actually promises.
 *
 * Naive surface nets is *not* manifold in general: a quad is emitted per sign-changing
 * edge, and when a surface is thin or sharply creased the cells round a dual edge can
 * yield one quad where two are needed, leaving that edge in a single triangle. That is
 * the accepted cost of the method over marching cubes (ADR 0003) — it buys one vertex
 * per cell and no ambiguous cases, and it pays in exactly this way.
 *
 * It is, however, manifold wherever the surface is resolved, which is the part worth
 * pinning. That two chunks produce the same mesh as one (above) is what makes chunking
 * safe; this is what makes the base mesher safe.
 */
describe("manifoldness of a resolved surface", () => {
  it("shares every edge between exactly two triangles", () => {
    for (const [name, field] of [
      [
        "sphere",
        (x: number, y: number, z: number) => sphere(x - 80, y - 80, z - 80, 30),
      ],
      ["box", boxField([80, 80, 80], 30)],
      [
        "ellipsoid",
        (x: number, y: number, z: number) =>
          sdEllipsoid(
            { x: 30, y: 45, z: 60 },
            { x: x - 80, y: y - 80, z: z - 80 },
          ),
      ],
      ["torus", torus([80, 80, 80], 40, 35)],
      [
        "capsule",
        (x: number, y: number, z: number) =>
          sdCapsule(25, 60, { x: x - 80, y: y - 80, z: z - 80 }),
      ],
    ] as const) {
      const out = mesh([0, 0, 0], N, field);
      expect(out.triangleCount, name).toBeGreaterThan(0);
      for (const [key, uses] of edgeUses(out.indices.exact())) {
        expect(uses, `${name}: edge ${key}`).toBe(2);
      }
    }
  });

  it("is closed at the corners, where a surface is least well conditioned", () => {
    // A capsule's surface runs along the line where its distance field is least well
    // conditioned, so this is where a vertex placed wrongly would show up.
    const out = mesh([0, 0, 0], N, (x, y, z) =>
      sdCapsule(20, 50, { x: x - 80, y: y - 80, z: z - 80 }),
    );
    for (const [key, uses] of edgeUses(out.indices.exact())) {
      expect(uses, `edge ${key}`).toBe(2);
    }
  });
});

describe("winding", () => {
  it("faces every triangle out of the solid", () => {
    // Checked against the field gradient at each triangle's centroid, which points out
    // of the solid by definition. Only reliable for convex shapes: at a concave crease
    // the centroid's gradient can legitimately disagree with the face, which is why each
    // shape is meshed on its own here.
    for (const [name, field] of [
      [
        "sphere",
        (x: number, y: number, z: number) => sphere(x - 80, y - 80, z - 80, 30),
      ],
      [
        "sphere, larger",
        (x: number, y: number, z: number) => sphere(x - 80, y - 80, z - 80, 50),
      ],
      ["box", boxField([80, 80, 80], 30)],
      ["torus", torus([80, 80, 80], 40, 35)],
    ] as const) {
      const out = mesh([0, 0, 0], N, field);
      const indices = out.indices.exact();
      const h = 0.05;
      const gradientAt = (
        x: number,
        y: number,
        z: number,
      ): [number, number, number] => [
        field(x + h, y, z) - field(x - h, y, z),
        field(x, y + h, z) - field(x, y - h, z),
        field(x, y, z + h) - field(x, y, z - h),
      ];

      for (let at = 0; at < indices.length; at += 3) {
        const [pa, pb, pc] = [
          indices[at],
          indices[at + 1],
          indices[at + 2],
        ].map((i) => out.positionOf(i));
        const normal = [
          (pb.y - pa.y) * (pc.z - pa.z) - (pb.z - pa.z) * (pc.y - pa.y),
          (pb.z - pa.z) * (pc.x - pa.x) - (pb.x - pa.x) * (pc.z - pa.z),
          (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x),
        ];
        const cx = (pa.x + pb.x + pc.x) / 3;
        const cy = (pa.y + pb.y + pc.y) / 3;
        const cz = (pa.z + pb.z + pc.z) / 3;
        const gradient = gradientAt(cx, cy, cz);
        const dot =
          normal[0] * gradient[0] +
          normal[1] * gradient[1] +
          normal[2] * gradient[2];
        expect(
          dot,
          `${name}: triangle at ${at} faces into the solid`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("sampling coarser", () => {
  it("covers the same world span with fewer samples", () => {
    // LOD is a sampling stride over the same analytic field (ADR 0004), not a smaller
    // mesh. Halving the samples and doubling the step must therefore describe the same
    // world region — which is what makes a chunk's neighbours comparable across levels.
    const samples = N;
    const fine = mesh([0, 0, 0], samples, (x, y, z) => sphere(x, y, z, 45));
    const coarse = mesh(
      [0, 0, 0],
      samples / 2,
      (x, y, z) => sphere(x, y, z, 45),
      STEP * 2,
    );

    expect(coarse.triangleCount).toBeGreaterThan(0);
    expect(coarse.vertexCount).toBeLessThan(fine.vertexCount);

    // And the coarse surface is still on the surface, just less finely placed.
    for (let i = 0; i < coarse.vertexCount; i++) {
      const p = coarse.positionOf(i);
      expect(Math.abs(sphere(p.x, p.y, p.z, 45))).toBeLessThan(STEP * 2);
      expect(p.x).toBeGreaterThanOrEqual(-STEP * 2);
      expect(p.x).toBeLessThanOrEqual(N * STEP + STEP * 2);
    }
  });

  it("still meshes consistently against the same field", () => {
    // The seam rule cannot depend on the sampling stride, or chunks at different levels
    // would not fit together. At stride two, two chunks of eight samples cover the same
    // span as one chunk of sixteen.
    // Tiled on all three axes, for the same reason as above: ownership is per chunk, so
    // surface outside the region the tiles cover has no owner at all, and that is a
    // missing chunk rather than a seam.
    const coarse = STEP * 2;
    const span = (N / 2) * coarse;
    const whole = mesh([0, 0, 0], N, mixed, coarse);
    const scratch = scratchFor(N / 2);
    const parts = tileOrigins(span).map((origin) =>
      mesh(origin, N / 2, mixed, coarse, scratch),
    );
    expect(whole.triangleCount).toBeGreaterThan(0);

    expect([...parts.flatMap(canonicalTriangles)].sort()).toEqual(
      [...canonicalTriangles(whole)].sort(),
    );
  });
});

describe("the mesh's layout", () => {
  it("copies its arrays to their exact length, so a transfer delivers them", () => {
    // A transferred *view* is detached, which would deliver an empty array to the main
    // thread — silently, because the transfer itself succeeds.
    const out = mesh([0, 0, 0], N, mixed);
    const finished = out.finish();

    expect(finished.positions.length).toBe(finished.vertexCount * 3);
    expect(finished.normalOct.length).toBe(finished.vertexCount * 2);
    expect(finished.colours.length).toBe(finished.vertexCount * 4);
    expect(finished.indices.length).toBe(finished.triangleCount * 3);

    // And the copy is not a view: growing the builder afterwards must not change it.
    const before = finished.positions.length;
    out.positions.push(123);
    expect(finished.positions.length).toBe(before);
  });

  it("occupies twenty bytes a vertex", () => {
    // The number the upload budget is denominated in, checked against what the formats
    // occupy rather than against the constant beside it.
    const finished = mesh([0, 0, 0], N, mixed).finish();
    expect(
      finished.positions.byteLength +
        finished.normalOct.byteLength +
        finished.colours.byteLength,
    ).toBe(meshBytes(finished.vertexCount));
    expect(VERTEX_BYTES).toBe(20);
  });

  it("folds a normal into two channels inside the signed range", () => {
    const out = new ChunkMeshBuilder();
    for (const normal of [
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0.5773502691896258, y: 0.5773502691896258, z: 0.5773502691896258 },
    ]) {
      out.setNormal(
        out.vertex(normal.x, normal.y, normal.z),
        normal.x,
        normal.y,
        normal.z,
      );
    }
    expect(out.normalOct.size).toBe(out.vertexCount * 2);
    for (const channel of out.normalOct.array()) {
      expect(channel).toBeGreaterThanOrEqual(-32767);
      expect(channel).toBeLessThanOrEqual(32767);
    }
  });

  it("writes a colour into its three lanes and leaves the fourth opaque", () => {
    const out = new ChunkMeshBuilder();
    const index = out.vertex(0, 0, 0);
    out.setColour(index, { r: 12, g: 34, b: 56 });
    expect(out.colours.at(index * 4)).toBe(12);
    expect(out.colours.at(index * 4 + 1)).toBe(34);
    expect(out.colours.at(index * 4 + 2)).toBe(56);
    expect(out.colours.at(index * 4 + 3)).toBe(255);
  });

  it("refuses to set a value past what has been written", () => {
    const out = new ChunkMeshBuilder();
    out.vertex(0, 0, 0);
    expect(() => out.setColour(9, { r: 1, g: 2, b: 3 })).toThrow(/past/);
  });
});

describe("reusing a scratch buffer", () => {
  it("produces the same mesh twice from the same scratch", () => {
    // The scratch is per-thread and reused for every chunk, so a missed `clear` shows
    // up as a second mesh carrying the first one's vertices.
    const scratch = scratchFor(N);
    const field = (x: number, y: number, z: number): number =>
      sphere(x, y, z, 45);
    const first = mesh([0, 0, 0], N, field, STEP, scratch).finish();
    const second = mesh([0, 0, 0], N, field, STEP, scratch).finish();

    expect(second.vertexCount).toBe(first.vertexCount);
    expect(second.triangleCount).toBe(first.triangleCount);
    expect([...second.indices]).toEqual([...first.indices]);
  });

  it("does not carry one chunk's vertices into another's", () => {
    const scratch = scratchFor(N);
    expect(mesh([0, 0, 0], N, () => 1000, STEP, scratch).vertexCount).toBe(0);
    expect(
      mesh([0, 0, 0], N, (x, y, z) => sphere(x, y, z, 45), STEP, scratch)
        .vertexCount,
    ).toBeGreaterThan(0);
    // And the other way round: a surface followed by nothing must not keep the surface.
    const after = mesh([0, 0, 0], N, () => 1000, STEP, scratch).finish();
    expect(after.vertexCount).toBe(0);
    expect(after.indices.length).toBe(0);
  });

  it("reuses one builder across chunks without leaking between them", () => {
    // Both the scratch and the output are meant to be per-thread and long-lived, so
    // this is the path that actually runs.
    const scratch = scratchFor(N);
    const out = new ChunkMeshBuilder();
    mesh([0, 0, 0], N, mixed, STEP, scratch, out);
    const first = out.vertexCount;
    mesh([N * STEP, 0, 0], N, () => 1000, STEP, scratch, out);
    expect(out.vertexCount).toBe(0);
    mesh([N * STEP, 0, 0], N, mixed, STEP, scratch, out);
    expect(out.vertexCount).toBeGreaterThan(0);
    expect(out.vertexCount).not.toBe(first + first);
  });
});

/**
 * A chunk that owns cells outside its own extent.
 *
 * This is the mechanism a level-of-detail seam is closed with (ADR 0035): the coarser of
 * two neighbouring chunks meshes one cell into the finer one, so the two surfaces overlap
 * across the plane between them rather than stopping on it. The property worth pinning is
 * that owning a cell and *being told* to own it are the same thing — that `extra` widens
 * the run rather than adding a second, differently-placed surface — because the alternative
 * reading of the parameter would put the extra cells somewhere the caller did not ask for.
 */
describe("a chunk owning cells beyond its own extent", () => {
  // A blob filling the chunk and past it, so the extra cells are crossed rather than
  // empty: a field that stops short of them would make "owns one more cell" and "owns the
  // same cells" indistinguishable, because neither would put a vertex there.
  const blob = (x: number, y: number, z: number): number =>
    sphere(x - 85, y - 85, z - 85, 100);

  const meshExtra = (
    origin: readonly [number, number, number],
    samples: number,
    extra: readonly [number, number, number],
    field: (x: number, y: number, z: number) => number,
  ): ChunkMeshBuilder => {
    const out = new ChunkMeshBuilder();
    surfaceNets({
      origin,
      samples,
      extra,
      sampleSize: STEP,
      sampler: { distance: field },
      out,
      scratch: scratchFor(samples, Math.max(...extra)),
    });
    return out;
  };

  it("is the same mesh as owning the cells outright", () => {
    // The statement of the equivalence, and the reason the parameter is a count per axis
    // rather than a range: a chunk told to own more cells than it was promised must
    // produce exactly the mesh it produces owning those cells itself. Two chunks in the
    // world reach different numbers of cells in the same place, and this is the property
    // that lets them meet.
    const wide = meshExtra([0, 0, 0], N, [1, 1, 1], blob).finish();
    const owned = mesh([0, 0, 0], N + 1, blob).finish();

    expect(owned.vertexCount).toBeGreaterThan(0);
    expect(wide.vertexCount).toBe(owned.vertexCount);
    expect([...wide.indices]).toEqual([...owned.indices]);
    for (let i = 0; i < owned.vertexCount; i++) {
      expect(wide.positions[i * 3], `vertex ${i}`).toBe(owned.positions[i * 3]);
      expect(wide.positions[i * 3 + 1], `vertex ${i}`).toBe(
        owned.positions[i * 3 + 1],
      );
      expect(wide.positions[i * 3 + 2], `vertex ${i}`).toBe(
        owned.positions[i * 3 + 2],
      );
    }
  });

  it("reaches no further than the cells it was given", () => {
    // The other direction, and the one that would be invisible if only the first were
    // tested: a vertex past the widened run would be a vertex belonging to a neighbour
    // further still, drawn in two places. The run is `samples + extra` cells from
    // `origin`, so that is where the padding stops.
    const out = meshExtra([0, 0, 0], N, [1, 1, 0], blob);
    const span = (N + 1) * STEP;
    expect(out.vertexCount).toBeGreaterThan(0);
    for (let i = 0; i < out.vertexCount; i++) {
      for (const [axis, value] of [
        ["x", out.positions.at(i * 3)],
        ["y", out.positions.at(i * 3 + 1)],
        ["z", out.positions.at(i * 3 + 2)],
      ] as const) {
        expect(value, `vertex ${i} ${axis}`).toBeGreaterThanOrEqual(-STEP);
        expect(value, `vertex ${i} ${axis}`).toBeLessThanOrEqual(span);
      }
    }
  });

  it("leaves an axis alone that takes no extra cell", () => {
    // Per axis, not per chunk. A chunk with one finer neighbour on one face owns one more
    // cell on that axis and none on the others; a shell of them on all six would be a
    // third of the mesh again, on seams that need nothing.
    const plain = mesh([0, 0, 0], N, blob);
    const oneAxis = meshExtra([0, 0, 0], N, [1, 0, 0], blob);
    const allAxes = meshExtra([0, 0, 0], N, [1, 1, 1], blob);

    expect(oneAxis.vertexCount).toBeGreaterThan(plain.vertexCount);
    expect(allAxes.vertexCount).toBeGreaterThan(oneAxis.vertexCount);

    /** How far the mesh reaches on one component, which is what an extra cell moves. */
    const reach = (out: ChunkMeshBuilder, component: 0 | 1 | 2): number => {
      let furthest = -Infinity;
      for (let i = 0; i < out.vertexCount; i++) {
        furthest = Math.max(furthest, out.positions.at(i * 3 + component));
      }
      return furthest;
    };
    expect(reach(oneAxis, 0)).toBeGreaterThan(reach(plain, 0));
    expect(reach(oneAxis, 1)).toBe(reach(plain, 1));
    expect(reach(oneAxis, 2)).toBe(reach(plain, 2));
    expect(reach(allAxes, 1)).toBeGreaterThan(reach(plain, 1));
  });

  it("refuses a scratch too small for the cells it is asked to own", () => {
    // Sized to `samples` when it will own `samples + 1`, the sample buffer is one cell
    // short along one axis and the cell buffer one short in every direction — which is the
    // silent corruption the guard exists to catch, and not something a mesh comparison
    // would attribute to the right cause.
    expect(() => meshExtra([0, 0, 0], N, [1, 0, 0], blob)).not.toThrow();

    const out = new ChunkMeshBuilder();
    expect(() =>
      surfaceNets({
        origin: [0, 0, 0],
        samples: N,
        extra: [1, 0, 0],
        sampleSize: STEP,
        sampler: { distance: blob },
        out,
        scratch: scratchFor(N),
      }),
    ).toThrow(/scratch/);
  });
});

/**
 * Unevenly spaced samples.
 *
 * "Evenly spaced" is an assumption about the world rather than about this algorithm, and
 * at a level-of-detail boundary it stops being true: a coarse chunk and a fine one put
 * their owned cells either side of a shared plane, so a chunk that refined its own
 * boundary shell would have cells of two different widths. These tests pin that a lane
 * set says where the samples are, and that where it agrees with an even grid the result
 * is identical — which is what makes the refinement possible without changing what the
 * algorithm means.
 */
describe("sample lanes", () => {
  const LANES_N = 8;
  const GRID = SURFACE_NETS_GRID(LANES_N);
  // A tilted plane rather than a sphere, so that it cuts every cell it passes through
  // with a clear sign change on its corners. A sphere only straddles a cell whose corners
  // happen to fall either side of it, which makes "this cell has a vertex" a fact about
  // the numbers chosen rather than about the code.
  const field = (x: number, y: number, _z: number): number => y - 3 - x * 0.4;
  const across = (step: number): Float64Array => uniformLane(0, step, GRID);

  type Lanes = { x: Float64Array; y: Float64Array; z: Float64Array };

  const meshWith = (
    lanes: Lanes,
    scratch: ReturnType<typeof scratchFor>,
    out: ChunkMeshBuilder,
  ): ChunkMeshBuilder => {
    surfaceNets({
      origin: [0, 0, 0],
      samples: LANES_N,
      sampleSize: STEP,
      lanes,
      sampler: { distance: field },
      out,
      scratch,
    });
    return out;
  };

  /** Where the mesher put the vertex for a cell, or undefined if it emitted none. */
  const cellPosition = (
    scratch: ReturnType<typeof scratchFor>,
    out: ChunkMeshBuilder,
    cx: number,
    cy: number,
    cz: number,
  ): { x: number; y: number; z: number } | undefined => {
    const cells = SURFACE_NETS_CELLS(LANES_N);
    const index = scratch.cellVertex[(cz * cells + cy) * cells + cx];
    return index < 0 ? undefined : out.positionOf(index);
  };

  it("gives the same answer as an even grid when the lanes are evenly spaced", () => {
    // The equivalence that lets the rest of the project ignore lanes entirely: passing
    // them explicitly must be indistinguishable from not passing them, so every existing
    // caller and test keeps meaning what it meant.
    const grid = SURFACE_NETS_GRID(LANES_N);
    const even = {
      x: uniformLane(0, STEP, grid),
      y: uniformLane(0, STEP, grid),
      z: uniformLane(0, STEP, grid),
    };
    // Finished, because the builder's own buffers are a growable: indexing one past its
    // length yields undefined, and `undefined === undefined` would make every comparison
    // below pass while checking nothing.
    const implicit = mesh([0, 0, 0], LANES_N, field).finish();
    const explicit = meshWith(
      even,
      scratchFor(LANES_N),
      new ChunkMeshBuilder(),
    ).finish();

    expect(explicit.vertexCount).toBe(implicit.vertexCount);
    expect([...explicit.indices]).toEqual([...implicit.indices]);
    for (let i = 0; i < implicit.vertexCount; i++) {
      for (const component of [0, 1, 2] as const) {
        expect(
          explicit.positions[i * 3 + component],
          `vertex ${i} component ${component}`,
        ).toBe(implicit.positions[i * 3 + component]);
      }
    }
  });

  it("places a refined cell's vertex where an even grid of that width puts it", () => {
    // The point of lanes. Two meshes that cover the *same world cells* express that
    // coverage differently: one as a uniformly fine grid, the other as a coarse grid
    // whose first cell has been narrowed to match. The cell they share is the same piece
    // of world, so its vertex has to be the same point — which it only can be if the
    // algorithm is told where the samples are rather than how far apart they are.
    // Both grids are expressed as lanes, because the point is that they agree on y and z
    // and disagree only on x — which a single `sampleSize` cannot express.
    const fine = scratchFor(LANES_N);
    const fineOut = meshWith(
      { x: across(5), y: across(10), z: across(10) },
      fine,
      new ChunkMeshBuilder(),
    );

    // Cell 1 of the fine grid spans x 0..5. The coarse grid below is 10 wide everywhere
    // except its second cell, which is narrowed onto the same span.
    const coarse = scratchFor(LANES_N);
    const coarseOut = meshWith(
      {
        x: Float64Array.from([-20, -10, 0, 5, 25, 45, 65, 85, 105, 125]),
        y: across(10),
        z: across(10),
      },
      coarse,
      new ChunkMeshBuilder(),
    );

    // Cell (1, cy, cz) of the fine grid and cell (2, cy, cz) of the coarse one are the
    // same world cell on x, and identical on y and z because those lanes match.
    let compared = 0;
    let worst = 0;
    for (let cz = 1; cz < SURFACE_NETS_CELLS(LANES_N) - 1; cz++)
      for (let cy = 1; cy < SURFACE_NETS_CELLS(LANES_N) - 1; cy++) {
        const a = cellPosition(fine, fineOut, 1, cy, cz);
        const b = cellPosition(coarse, coarseOut, 2, cy, cz);
        if (a === undefined || b === undefined) continue;
        compared++;
        worst = Math.max(
          worst,
          Math.abs(a.x - b.x),
          Math.abs(a.y - b.y),
          Math.abs(a.z - b.z),
        );
      }

    expect(compared).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-9);
  });

  it("moves every vertex by exactly what the lane moved by", () => {
    // The other direction: a lane has to be honoured, or the equivalence above would pass
    // for a mesher that ignored lanes entirely.
    //
    // The field depends only on y, which is what makes a shift of the x lane a pure
    // translation. Shifting the samples of a field that varies along x would move the
    // surface relative to the lattice and change which cells straddle, so the mesh would
    // legitimately differ in more than position. With a field blind to x, nothing about
    // the crossings can change — so the same vertices must appear, seven units along.
    // Deliberately blind to x and z.
    const flat = (_x: number, y: number, _z: number): number => y - 3;
    const build = (lanes: Lanes, out: ChunkMeshBuilder): ChunkMeshBuilder => {
      surfaceNets({
        origin: [0, 0, 0],
        samples: LANES_N,
        sampleSize: STEP,
        lanes,
        sampler: { distance: flat },
        out,
        scratch: scratchFor(LANES_N),
      });
      return out;
    };

    const even = build(
      { x: across(STEP), y: across(STEP), z: across(STEP) },
      new ChunkMeshBuilder(),
    ).finish();
    const shifted = across(STEP);
    for (let i = 0; i < GRID; i++) shifted[i] = shifted[i]! + 7;
    const moved = build(
      { x: shifted, y: across(STEP), z: across(STEP) },
      new ChunkMeshBuilder(),
    ).finish();

    expect(moved.vertexCount).toBe(even.vertexCount);
    expect([...moved.indices]).toEqual([...even.indices]);
    for (let i = 0; i < even.vertexCount; i++) {
      expect(moved.positions[i * 3], `vertex ${i} x`).toBeCloseTo(
        (even.positions[i * 3] as number) + 7,
        9,
      );
      // And nothing else moved, or the lane on one axis would be leaking into the others.
      expect(moved.positions[i * 3 + 1]).toBe(even.positions[i * 3 + 1]);
      expect(moved.positions[i * 3 + 2]).toBe(even.positions[i * 3 + 2]);
    }
  });
});
