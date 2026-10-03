/**
 * A bounding volume hierarchy over the operation list, plus the persistent
 * candidate cache that makes evaluating a chunk of field fast.
 *
 * Two separate jobs, and they are separated on purpose.
 *
 * The **tree** answers "which operations could change the field anywhere in this
 * box". It is rebuilt whenever the list changes, which after a stroke is often, so
 * it is cheap: a binned surface-area-heuristic top-down build is a few
 * microseconds for the thousands of operations a session accumulates. It is never
 * updated in place, because an incremental tree is a much harder thing to get
 * right and nothing here needs it.
 *
 * The **cache** answers "which operations could change the field *here*". The
 * mesher walks a region in order, and every sample wants the same answer, so the
 * answer is kept for a box of the candidate cell — sized by the constructor, not
 * by a constant this package once imported from an application — and rebuilt
 * when a sample falls outside it. Without it, each of a chunk's 34,304 samples
 * would traverse the whole tree; with it, the traversal happens once per chunk
 * per side.
 *
 * The cache is what makes the field's cost per region independent of how many
 * operations exist elsewhere on the model. A brush stroke in one corner does not
 * make the opposite corner more expensive to mesh.
 */

import {
  DEFAULT_CANDIDATE_CELL,
  type Bounds,
  type Vec3,
} from "@big-mesh-studios/core";
import {
  boundsContain,
  CANDIDATE_MARGIN,
  emptyField,
  foldOperations,
  indexOperation,
  operationDistance,
  type IndexedOperation,
  type Operation,
  type SurfaceColour,
} from "./operations";

/** Operations per leaf before the build splits one. */
const LEAF_SIZE = 4;

/** Bins along the split axis, for the surface-area estimate. */
const BIN_COUNT = 16;

/** How deep the build is willing to recurse before splitting anyway. */
const MAX_DEPTH = 32;

/**
 * Blocks a side, when a declared region is subdivided.
 *
 * Eight, from three candidates for "smaller": 4³ measured 1.8× and 8³ measured 2.5×
 * against one list per chunk, and 8³ is where the curve flattened on this project's
 * chunk size. Sixteen was not measured to be better and would quadruple the lists a
 * chunk pays to build, so the number a measurement justified is the number here.
 *
 * A region's span is divided rather than a fixed width, so any region subdivides
 * evenly and a chunk thirty-four samples across gets about four a side — which is
 * also about the width of the operations a brush leaves, which is why the partition
 * helps where it does and not elsewhere.
 */
const BLOCKS = 8;

/** Blocks in a subdivided region, since the grid is cubic. */
const BLOCK_COUNT = BLOCKS * BLOCKS * BLOCKS;

/**
 * How near an operation's own surface a point has to be for its colour to have a say.
 *
 * **This only decides whether an operation is *near*, never *which* of the near ones wins** — the
 * nearest surface does that, and the distance it compares is the same one. That is stated here
 * because the two were once the same decision, and an absolute number doing both is how a red sphere
 * a unit across ended up painted entirely by the blue box beside it.
 *
 * So it can stay a unit. A mesher's vertex is on the surface it was interpolated from, so the
 * operation that owns a vertex is always at distance zero and always wins; this only rejects a query
 * that is nowhere near anything, and any positive reach rejects the same queries.
 */
const PAINT_REACH = 1;

/**
 * Which block a coordinate falls in along one axis, or `-1` if it is outside.
 *
 * `-1` rather than a clamp, because outside is not the same as at the edge: a point
 * beyond the region's far face has no block that provably covers it, and the caller
 * falls back to the whole gathered list rather than to a block that may not.
 */
const blockCoordinate = (value: number, min: number, max: number): number => {
  const span = max - min;
  if (!(span > 0) || value < min || value > max) return -1;
  const block = Math.floor(((value - min) / span) * BLOCKS);
  return block >= BLOCKS ? BLOCKS - 1 : block;
};

/**
 * Which block a coordinate falls in, clamped to the edges rather than rejected.
 *
 * The other half of `blockCoordinate`, for the side that asks where a box *reaches*
 * rather than where a point *is*. A candidate's grown box is outside the region on
 * purpose — that is what the margin means — so a coordinate beyond the far face is
 * the common case, and it belongs to the nearest block rather than to none of them.
 */
const blockIndexClamped = (value: number, min: number, max: number): number => {
  const span = max - min;
  if (!(span > 0)) return 0;
  const block = Math.floor(((value - min) / span) * BLOCKS);
  if (block < 0) return 0;
  return block >= BLOCKS ? BLOCKS - 1 : block;
};

interface BvhNode {
  bounds: Bounds;
  left: BvhNode | null;
  right: BvhNode | null;
  /** Only on a leaf. */
  items: IndexedOperation[];
}

/** An empty box, for a node that has nothing in it yet. */
const EMPTY_BOUNDS: Bounds = {
  min: { x: Infinity, y: Infinity, z: Infinity },
  max: { x: -Infinity, y: -Infinity, z: -Infinity },
};

const emptyNode = (): BvhNode => ({
  bounds: { min: { ...EMPTY_BOUNDS.min }, max: { ...EMPTY_BOUNDS.max } },
  left: null,
  right: null,
  items: [],
});

const surfaceArea = (b: Bounds): number => {
  const dx = Math.max(0, b.max.x - b.min.x);
  const dy = Math.max(0, b.max.y - b.min.y);
  const dz = Math.max(0, b.max.z - b.min.z);
  return 2 * (dx * dy + dy * dz + dz * dx);
};

const grow = (target: Bounds, add: Bounds): void => {
  target.min.x = Math.min(target.min.x, add.min.x);
  target.min.y = Math.min(target.min.y, add.min.y);
  target.min.z = Math.min(target.min.z, add.min.z);
  target.max.x = Math.max(target.max.x, add.max.x);
  target.max.y = Math.max(target.max.y, add.max.y);
  target.max.z = Math.max(target.max.z, add.max.z);
};

const centroid = (b: Bounds): Vec3 => ({
  x: (b.min.x + b.max.x) / 2,
  y: (b.min.y + b.max.y) / 2,
  z: (b.min.z + b.max.z) / 2,
});

export class OperationBVH {
  private root: BvhNode = emptyNode();
  /** Every operation, in list order. Colour resolution needs that order. */
  private readonly all: IndexedOperation[] = [];

  /**
   * Operations whose boxes overlap the cached region, and so can change the field
   * inside it. Paint operations are excluded: they do not change the distance, so
   * including them would make every sample test against the whole model's paint
   * history for no effect.
   */
  private cached: IndexedOperation[] = [];
  /** The wide box the candidates were gathered over. */
  private cachedBounds: Bounds = emptyNode().bounds;
  /** Whether the cache has been populated at least once. */
  private primed = false;
  /**
   * The region the caller has said it is sampling, while one is open.
   *
   * `null` means the caller has not declared one, and candidates are then cached
   * around the last point asked about — which is right for a handful of ad-hoc
   * queries and wrong for a sweep.
   */
  private region: Bounds | null = null;
  /** Where the current candidates were centred. */
  private anchor: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * The declared region cut into blocks, each with the candidates that can reach it.
   *
   * `null` when there is no declared region, which is the picker and every other
   * ad-hoc query. Those gather one list around a point and take a handful of samples
   * from it, so there is nothing to subdivide and the block lookup would be pure
   * overhead; the mesh worker, which is the case that costs, always declares one.
   *
   * Flat and indexed by `blockIndex`, so a lookup is an array read rather than a
   * hash. 512 entries for an 8³ grid.
   */
  private blocks: IndexedOperation[][] | null = null;

  /** How many times the candidate cache has been rebuilt. */
  rebuilds = 0;

  /**
   * How many block lists have been built for the current region.
   *
   * Separate from `rebuilds`, which counts tree traversals, because they are
   * different work and the cost tests pin both ideas. A chunk pays one traversal and
   * up to `BLOCK_COUNT` of these.
   */
  blocksBuilt = 0;

  /**
   * Half the width of the point-anchored reuse radius: the box of candidates the tree keeps
   * while it is being asked about one place.
   *
   * **A constructor option, and the reason this package has no chunk size in it.** It used to be
   * `CANDIDATE_CELL`, which was `BLOCK_WORLD`, which was one application's chunk. The value below
   * is the same 320 units so nothing about the behaviour changes — what changes is that a second
   * application, whose models are not chunks, says what *its* regions are rather than inheriting
   * this one (ADR 0024).
   */
  private readonly cellRadius: number;

  constructor(
    operations: readonly Operation[] = [],
    options: { readonly candidateCell?: number } = {},
  ) {
    this.cellRadius = (options.candidateCell ?? DEFAULT_CANDIDATE_CELL) / 2;
    this.set(operations);
  }

  /** Every operation, in list order. */
  get operations(): readonly IndexedOperation[] {
    return this.all;
  }

  /** How many operations are held. */
  get size(): number {
    return this.all.length;
  }

  /** Whether the list is empty. */
  get empty(): boolean {
    return this.all.length === 0;
  }

  /**
   * Replaces the whole list and rebuilds the tree.
   *
   * Whole-list rather than incremental, because undo removes operations from the
   * middle and a stroke adds a dozen at once: both are cheaper to answer by
   * rebuilding than by repairing, and a rebuild of a few thousand operations is
   * measured in microseconds against a meshing pass measured in milliseconds.
   */
  set(operations: readonly Operation[]): void {
    this.all.length = 0;
    const shapeOps: IndexedOperation[] = [];
    for (const operation of operations) {
      const indexed = indexOperation(operation);
      this.all.push(indexed);
      if (operation.combine !== "Paint") {
        shapeOps.push(indexed);
      }
    }
    this.root = shapeOps.length === 0 ? emptyNode() : build(shapeOps);
    // The old candidates are about a tree that no longer exists. Clearing rather
    // than recomputing here means a caller that changes the list and then samples
    // pays for one traversal rather than paying for one per sample until the next
    // rebuild, which is the case that matters.
    this.primed = false;
    this.cached = [];
    this.cachedBounds = emptyNode().bounds;
    this.region = null;
    this.anchor = { x: 0, y: 0, z: 0 };
    this.blocks = null;
  }

  /**
   * Every indexed operation whose box overlaps a given box, in **tree traversal
   * order** rather than list order.
   *
   * Fine for "is this operation anywhere near here", which is what a caller
   * usually wants, and wrong for anything that folds them — see `candidatesAt` for
   * why the order is part of the field's definition.
   */
  query(bounds: Bounds, out: IndexedOperation[] = []): IndexedOperation[] {
    out.length = 0;
    if (this.root.items.length > 0) {
      for (const item of this.root.items)
        if (overlaps(item.bounds, bounds)) out.push(item);
      return out;
    }
    queryNode(this.root, bounds, out);
    return out;
  }

  /**
   * The operations that can change the field at a point, refreshed only when the
   * point strays too far from where the current candidates were gathered.
   *
   * Two boxes, and conflating them is the bug this class of cache invites. The
   * **gather** box has to be wide, because an operation outside it is one the tree
   * never offers and so has to be provably unable to set the answer. The **reuse**
   * box has to be narrow, because near the gather box's edge an omitted operation is
   * arbitrarily close, and reusing there makes the answer depend on where the cache
   * happened to be built.
   *
   * Two access patterns want this, and neither can infer the other's:
   *
   * - **A sweep** wants one cache for a whole chunk. The region is declared, and the
   *    gather box is the region grown by `CANDIDATE_MARGIN` — so anything omitted is
   *    at least the margin outside the region, and therefore the margin from every
   *    point inside it. Reuse is the region itself.
   *
   *    Inferring the region from the points asked about, by keeping a cube around the
   *    first of them, fails by a factor of hundreds: a raster sweep exits a cube at
   *    the end of every row, and one chunk took **2,312** rebuilds for 39,304
   *    samples. Widening the reuse radius to the region's half-*diagonal* also works
   *    and needs no declaration, but gathers a larger box for the same guarantee —
   *    774 units across instead of 532 for a chunk.
   *
   * - **A handful of scattered queries** has no region to declare. Then the gather
   *    box is a chunk plus the margin around the point that triggered it, and reuse is
   *    a chunk's half-width around that point. Scattered queries then rebuild by
   *    distance travelled rather than per point — which is what makes a caller
   *    straying outside a declared region cost a rebuild instead of falling off a
   *    cliff, as it did before.
   */
  candidatesAt(p: Vec3): readonly IndexedOperation[] {
    if (!this.primed || !this.canReuseFor(p)) {
      this.cachedBounds =
        this.region !== null
          ? grown(this.region, CANDIDATE_MARGIN)
          : around(p, this.cellRadius);
      this.anchor = this.region !== null ? middleOf(this.region) : p;
      this.cached = this.query(this.cachedBounds);
      // **Sorted by list order, and this is not cosmetic.** The smooth booleans are
      // symmetric but not associative: `smin(smin(a,b),c)` and `smin(a,smin(b,c))`
      // differ, because the dent the first pair takes changes the value the third is
      // combined against. So the fold's order is part of the field's definition, and
      // the tree hands back candidates in traversal order.
      //
      // Left unsorted, two chunks either side of a level-of-detail boundary would fold
      // the same operations in different orders and disagree — a crack along every
      // boundary in the world, and one that appears only once there is a second chunk
      // to compare against, so nothing but a test comparing against a brute-force fold
      // in list order would ever notice.
      //
      // Sorted once per rebuild rather than per sample: the cache is rebuilt once or
      // twice per chunk, and a sort of a few hundred entries is nothing beside 34,304
      // folds.
      this.cached.sort(byIndex);
      this.blocks =
        this.region === null ? null : this.cutIntoBlocks(this.region);
      this.primed = true;
      this.rebuilds++;
    }
    // A declared region is subdivided, and the answer is the sub-list for the block
    // the point falls in. A point outside the region has no block, and gets the whole
    // gathered list — which is what the fold would have used anyway.
    if (this.blocks === null) return this.cached;
    const region = this.region as Bounds;
    const bx = blockCoordinate(p.x, region.min.x, region.max.x);
    const by = blockCoordinate(p.y, region.min.y, region.max.y);
    const bz = blockCoordinate(p.z, region.min.z, region.max.z);
    if (bx < 0 || by < 0 || bz < 0) return this.cached;
    return this.blocks[(bz * BLOCKS + by) * BLOCKS + bx];
  }

  /**
   * Cuts the declared region into blocks and files each gathered candidate under
   * every block it could change the field inside.
   *
   * **The chunks the fold has to look at are the problem this answers.** With one
   * candidate list for a whole chunk, every sample tests every operation near the
   * chunk — so a chunk that a user has been sculpting in, where the brush has left
   * hundreds of operations, tests all of them at all 34,304 of its samples, and its
   * cost is linear in how long they have been sculpting. Measured on this project's
   * own chunk, with the operations clustered the way a stroke clusters them, the
   * candidates tested per sample were *exactly* the operation count: 4, 64, and 256
   * operations all tested once per sample. Splitting the region into 8³ blocks and
   * giving each its own list cut that to 24 and 96, for **2.5×** on the fold, with no
   * change to the field — the blocks are a partition of the same candidates, not a
   * different set of them.
   *
   * **Why each block's list is a subset of the gathered one, which is what makes it
   * a partition rather than a second guess.** A candidate is filed under a block when
   * it is within `CANDIDATE_MARGIN` of the block, which is the same condition under
   * which it can change the field at *some* point of the block: the fold skips a
   * candidate only when the point is further from its box than the threshold, the
   * threshold is never larger than the margin, and the margin is the same one the
   * gathered list was built with. A block lies inside the region, so a candidate
   * within the margin of a block is within the margin of the region, and is therefore
   * in the gathered list already. Nothing new can enter; only things that could not
   * have mattered leave.
   *
   * **Why the order survives.** Each list is filled by walking the gathered list once
   * in list order and appending, so every list is in list order too — which is what
   * the fold's non-associativity requires, and why this can be done at all without
   * asking what "sorted candidates" means more than once.
   *
   * **One traversal, not one per block.** Blocks are cut from the gathered list
   * rather than queried for, so the tree is still walked once per chunk and
   * `rebuilds` still means what it says. The cost is a box test per candidate per
   * block it touches — for a few hundred clustered candidates, tens of thousands of
   * tests against the millions of candidate tests the partition saves.
   */
  private cutIntoBlocks(region: Bounds): IndexedOperation[][] {
    const blocks: IndexedOperation[][] = [];
    for (let i = 0; i < BLOCK_COUNT; i++) blocks.push([]);

    for (const candidate of this.cached) {
      // The block range the candidate can reach, from its box grown by the margin.
      // Every coordinate here is outside the region as often as not — that is what
      // growing by the margin means — so these clamp rather than reject.
      const b = candidate.bounds;
      const x0 = blockIndexClamped(
        b.min.x - CANDIDATE_MARGIN,
        region.min.x,
        region.max.x,
      );
      const x1 = blockIndexClamped(
        b.max.x + CANDIDATE_MARGIN,
        region.min.x,
        region.max.x,
      );
      const y0 = blockIndexClamped(
        b.min.y - CANDIDATE_MARGIN,
        region.min.y,
        region.max.y,
      );
      const y1 = blockIndexClamped(
        b.max.y + CANDIDATE_MARGIN,
        region.min.y,
        region.max.y,
      );
      const z0 = blockIndexClamped(
        b.min.z - CANDIDATE_MARGIN,
        region.min.z,
        region.max.z,
      );
      const z1 = blockIndexClamped(
        b.max.z + CANDIDATE_MARGIN,
        region.min.z,
        region.max.z,
      );
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++)
            blocks[(z * BLOCKS + y) * BLOCKS + x].push(candidate);
    }

    this.blocksBuilt = BLOCK_COUNT;
    return blocks;
  }

  /**
   * Declares the region about to be sampled, so that one candidate cache serves all
   * of it, and returns a function that ends it.
   *
   * The region is the chunk's **sample** extent, which is `BLOCK_WORLD` plus a voxel
   * of border on each side rather than `BLOCK_WORLD` itself: a chunk of thirty-two
   * voxels across samples at thirty-four positions, spanning a little more than the
   * three hundred and twenty units the chunk covers. Getting that wrong does not
   * break anything — the reuse radius still bounds the rebuilds — but it does mean
   * paying for two builds where one would do.
   *
   * Nested calls are not supported and are not needed: the mesher walks one chunk at a
   * time. The returned disposer ends the region and drops the cache, so the next
   * query builds afresh rather than answering from candidates gathered for a region
   * that has passed.
   */
  beginRegion(bounds: Bounds): () => void {
    this.region = bounds;
    this.primed = false;
    this.blocks = null;
    return () => this.endRegion();
  }

  /** Ends the declared region, returning to point-anchored caching. */
  endRegion(): void {
    this.region = null;
    this.primed = false;
    this.blocks = null;
  }

  /** Whether the gathered candidates cover `p` closely enough to answer about it. */
  private canReuseFor(p: Vec3): boolean {
    if (this.region !== null) return boundsContain(this.region, p);
    const reach = this.cellRadius;
    return (
      Math.abs(p.x - this.anchor.x) <= reach &&
      Math.abs(p.y - this.anchor.y) <= reach &&
      Math.abs(p.z - this.anchor.z) <= reach
    );
  }

  /**
   * The signed distance to the operations alone, with no base field.
   *
   * The same fold `Field.distance` performs, starting from emptiness. Both go
   * through `foldOperations` rather than each doing their own loop, so a query
   * with a base field and one without cannot drift apart — which is the failure
   * that would show up as a seam where the base field begins.
   */
  evalSDF(x: number, y: number, z: number): number {
    return foldOperations(
      this.candidatesAt({ x, y, z }),
      { x, y, z },
      emptyField(),
    );
  }

  /**
   * The surface normal at a point, as central differences of the field.
   *
   * Central rather than analytic because the field is a composition — a smooth
   * minimum of several operations has no closed-form derivative, and an analytic
   * gradient would have to be derived per boolean and would still miss the
   * combination. Six evaluations is what `fast-surface-nets` spends on the same
   * job.
   *
   * The step is one tenth of the smallest distance any operation can report, so
   * that the two samples never straddle a surface and average to nearly zero —
   * which is what produces the dark seams and speckled faces that a too-large step
   * gives on a curved surface.
   */
  evalGradient(x: number, y: number, z: number, step = 0.1): Vec3 {
    const dx = this.evalSDF(x + step, y, z) - this.evalSDF(x - step, y, z);
    const dy = this.evalSDF(x, y + step, z) - this.evalSDF(x, y - step, z);
    const dz = this.evalSDF(x, y, z + step) - this.evalSDF(x, y, z - step);
    const length = Math.hypot(dx, dy, dz);
    return length === 0
      ? { x: 0, y: 0, z: 1 }
      : { x: dx / length, y: dy / length, z: dz / length };
  }

  /**
   * The colour of the surface at a point, from whichever operation's surface is **nearest** it.
   *
   * **Any operation with a colour, not only a `Paint`.** Before this, only
   * `combine === "Paint"` was consulted, which made a solid operation unable to
   * carry colour at all: `applyOperation` makes `Paint` a no-op on the distance, so
   * `Paint` was coloured but invisible and `Add` was visible but colourless. A
   * model of coloured parts could not be expressed.
   *
   * The rule is now that `combine` decides geometry and `colour` decides
   * appearance, and an operation with no colour simply has no say in the second.
   * **That places the obligation on whoever builds an operation** — an `Add` that
   * carries a brush's current colour would paint, so the producers set a colour
   * only where one is meant. `docs/adr/` records the change and the version bump it
   * forced.
   *
   * ## Nearest wins, not last
   *
   * **This was "last writer wins among the operations within a unit of the point", and on a small
   * model that meant every shape repainted every other one.** A figure modeller's parts are about a
   * unit across, so *within a unit* is *within the model*: a red sphere and a blue box a unit and a
   * bit apart both satisfied it, and because the box came later in the list it answered for the
   * sphere's whole surface. The sphere came out entirely blue.
   *
   * The reach is not the thing that was wrong, though. It has to exist — a point nowhere near any
   * shape has no colour, which is what lets the caller fall through to a paint tile and then to a
   * default. What was wrong is that the reach was also deciding *which* colour, so a shape merely
   * being nearby out-voted the shape the point is actually on.
   *
   * So the rule is now: among the operations near enough to have a say, **the one whose own surface
   * is closest takes it**. At a point on a shape's surface that shape's distance is zero and nothing
   * beats it, however large the model or however late the other shape appears in the list. The reach
   * is left doing the one job it is good at, which is rejecting a point that is nowhere near anything.
   *
   * **Ties go to the later operation**, so two coincident surfaces still resolve in list order and the
   * answer stays deterministic.
   */
  evalPaint(x: number, y: number, z: number): SurfaceColour | undefined {
    const point = { x, y, z };
    let found: SurfaceColour | undefined;
    let nearest = Infinity;
    for (const indexed of this.all) {
      const operation = indexed.operation;
      if (operation.colour === undefined) continue;
      if (!boundsContain(indexed.bounds, point)) continue;
      const distance = operationDistance(indexed, point);
      // `PAINT_REACH`, not `<= 1` written out — see the note on the constant for what the reach is
      // and is not deciding.
      if (distance > PAINT_REACH) continue;
      const away = Math.abs(distance);
      // `<=`, so a tie is the later operation's — see the note on ties above.
      if (away <= nearest) {
        nearest = away;
        found = { colour: operation.colour, opacity: operation.opacity };
      }
    }
    return found;
  }

  /**
   * Drops the candidate cache, so the next sample rebuilds it.
   *
   * Not needed for correctness — a stale cache only costs a few extra candidate
   * tests, since every candidate is still checked against its own box — but worth
   * calling after a change, so that the rebuild count reflects reality and the
   * first sample of a new chunk does not inherit the last chunk's answer.
   */
  invalidate(): void {
    this.primed = false;
    this.blocks = null;
  }
}

/** The middle of a box. */
const middleOf = (bounds: Bounds): Vec3 => ({
  x: (bounds.min.x + bounds.max.x) / 2,
  y: (bounds.min.y + bounds.max.y) / 2,
  z: (bounds.min.z + bounds.max.z) / 2,
});

/** A box grown by the same amount on every side. */
const grown = (bounds: Bounds, by: number): Bounds => ({
  min: { x: bounds.min.x - by, y: bounds.min.y - by, z: bounds.min.z - by },
  max: { x: bounds.max.x + by, y: bounds.max.y + by, z: bounds.max.z + by },
});

/**
 * A box of one candidate cell plus the margin, centred on a point.
 *
 * **The radius is passed rather than read**, which is what makes the cache size a property of the
 * tree that is asked for it rather than a property of whoever imported the constant first.
 */
const around = (p: Vec3, cellRadius: number): Bounds => {
  const reach = cellRadius + CANDIDATE_MARGIN;
  return {
    min: { x: p.x - reach, y: p.y - reach, z: p.z - reach },
    max: { x: p.x + reach, y: p.y + reach, z: p.z + reach },
  };
};

/** List order, which is the order the fold has to run in. */
const byIndex = (a: IndexedOperation, b: IndexedOperation): number =>
  a.operation.index - b.operation.index;

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.min.x <= b.max.x &&
  a.max.x >= b.min.x &&
  a.min.y <= b.max.y &&
  a.max.y >= b.min.y &&
  a.min.z <= b.max.z &&
  a.max.z >= b.min.z;

const queryNode = (
  node: BvhNode,
  bounds: Bounds,
  out: IndexedOperation[],
): void => {
  if (node.items.length > 0) {
    for (const item of node.items)
      if (overlaps(item.bounds, bounds)) out.push(item);
    return;
  }
  if (node.left !== null && overlaps(node.left.bounds, bounds))
    queryNode(node.left, bounds, out);
  if (node.right !== null && overlaps(node.right.bounds, bounds))
    queryNode(node.right, bounds, out);
};

/** Bounds that contain every item, computed once per node. */
const boundsOf = (items: readonly IndexedOperation[]): Bounds => {
  const bounds: Bounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  for (const item of items) grow(bounds, item.bounds);
  return bounds;
};

/**
 * Builds a tree by splitting each node's items along whichever of the three axes
 * and whichever of sixteen bins gives the cheapest split.
 *
 * A surface-area heuristic rather than a median or a count split because operation
 * boxes vary by orders of magnitude — a 20-unit brush dab next to a 1500-unit
 * primitive — and a count split on that distribution produces a tree whose
 * traversal cost is unrelated to how much work it saves. The estimate is the same
 * one every BVH uses: the total area of the leaves each candidate split would
 * produce, times how many items pass through them.
 */
const build = (items: IndexedOperation[]): BvhNode => {
  const node: BvhNode = {
    bounds: boundsOf(items),
    left: null,
    right: null,
    items: [],
  };
  if (items.length <= LEAF_SIZE) {
    node.items = items;
    return node;
  }

  const split = chooseSplit(items, node.bounds);
  if (split === null) {
    node.items = items;
    return node;
  }

  const left: IndexedOperation[] = [];
  const right: IndexedOperation[] = [];
  for (const item of items) {
    const side = axisOf(centroid(item.bounds), split.axis) < split.position;
    (side ? left : right).push(item);
  }
  // A split that puts everything on one side would recurse forever on the same
  // items. It can only happen with coincident centroids, and the depth limit
  // catches it, but the explicit check keeps the depth limit from being load
  // bearing for a case that has its own fix.
  if (left.length === 0 || right.length === 0) {
    node.items = items;
    return node;
  }

  node.left = buildAt(left, 1);
  node.right = buildAt(right, 1);
  return node;
};

const buildAt = (items: IndexedOperation[], depth: number): BvhNode => {
  if (depth >= MAX_DEPTH) {
    return { bounds: boundsOf(items), left: null, right: null, items };
  }
  return build(items);
};

interface Split {
  axis: 0 | 1 | 2;
  position: number;
}

/**
 * The cheapest place to divide a set of items, or null when nothing divides it.
 *
 * For each axis, the items are sorted into sixteen bins and the cost of every
 * possible boundary is evaluated as `leftArea * leftCount + rightArea *
 * rightCount` — the standard surface-area estimate, and the reason this is a
 * heuristic build rather than a median split: operation boxes here span three
 * orders of magnitude, and a median split on that distribution produces a tree
 * whose traversal cost bears no relation to how much work it saves.
 *
 * Both directions' areas are accumulated in one pass each, so the sweep is linear
 * in the bin count. Recomputing the right-hand area inside the boundary loop
 * instead would be quadratic in it, which for sixteen bins is three hundred
 * bounding-box unions per node — more than the rest of the build.
 */
const chooseSplit = (
  items: readonly IndexedOperation[],
  bounds: Bounds,
): Split | null => {
  let best: Split | null = null;
  let bestCost = Infinity;

  for (const axis of [0, 1, 2] as const) {
    const extent = axisExtent(bounds, axis);
    // A flat extent means every centroid lies on one plane, and sixteen bins over
    // zero width would divide nothing.
    if (!(extent > 0)) continue;
    const scale = BIN_COUNT / extent;
    const low = axisAt(bounds.min, axis);

    const counts = new Int32Array(BIN_COUNT);
    const bins = Array.from({ length: BIN_COUNT }, () => emptyNode().bounds);
    for (const item of items) {
      const relative = (axisOf(centroid(item.bounds), axis) - low) * scale;
      const bin =
        relative <= 0
          ? 0
          : relative >= BIN_COUNT - 1
            ? BIN_COUNT - 1
            : Math.floor(relative);
      counts[bin]++;
      grow(bins[bin], item.bounds);
    }

    // Left to right: what the bins before the boundary contain.
    const leftArea = new Float64Array(BIN_COUNT);
    const leftCount = new Int32Array(BIN_COUNT);
    const leftBounds: Bounds = emptyNode().bounds;
    let count = 0;
    for (let bin = 0; bin < BIN_COUNT; bin++) {
      count += counts[bin];
      grow(leftBounds, bins[bin]);
      leftCount[bin] = count;
      leftArea[bin] = surfaceArea(leftBounds);
    }

    // Right to left: the mirror, so each boundary can be costed in constant time.
    const rightArea = new Float64Array(BIN_COUNT);
    const rightCount = new Int32Array(BIN_COUNT);
    const rightBounds: Bounds = emptyNode().bounds;
    count = 0;
    for (let bin = BIN_COUNT - 1; bin >= 0; bin--) {
      count += counts[bin];
      grow(rightBounds, bins[bin]);
      rightCount[bin] = count;
      rightArea[bin] = surfaceArea(rightBounds);
    }

    for (let bin = 0; bin < BIN_COUNT - 1; bin++) {
      // An empty side is a boundary that does not divide.
      if (leftCount[bin] === 0 || rightCount[bin + 1] === 0) continue;
      const cost =
        leftArea[bin] * leftCount[bin] +
        rightArea[bin + 1] * rightCount[bin + 1];
      if (cost < bestCost) {
        bestCost = cost;
        best = { axis, position: low + (bin + 1) / scale };
      }
    }
  }

  // Refuse a split that costs more than not splitting. A leaf is a linear scan of
  // its items, so the cost of staying a leaf is `count * area`, and a split costs
  // `leftArea * leftCount + rightArea * rightCount`. **Both sides of that comparison
  // have to be in the same units.** Comparing the split's area-times-count against a
  // plain length multiplied by the count makes the leaf look arbitrarily expensive,
  // every split is refused, and the tree silently collapses into one leaf — which is
  // still *correct*, so nothing fails, and every query degenerates into a full scan.
  const leafCost = items.length * surfaceArea(bounds);
  if (best === null || bestCost >= leafCost) return null;
  return best;
};

const axisOf = (v: Vec3, axis: 0 | 1 | 2): number =>
  axis === 0 ? v.x : axis === 1 ? v.y : v.z;

const axisAt = (v: Vec3, axis: 0 | 1 | 2): number =>
  axis === 0 ? v.x : axis === 1 ? v.y : v.z;

const axisExtent = (b: Bounds, axis: 0 | 1 | 2): number =>
  axisAt(b.max, axis) - axisAt(b.min, axis);
