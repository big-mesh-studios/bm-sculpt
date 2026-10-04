/**
 * The resident chunk window: which cells exist, which slot each is in, and what
 * happens when the focus moves.
 *
 * **Slots are positions in an array, not names.** That single fact decides the whole
 * shape of this class, and it is worth stating before the arithmetic because every
 * design decision below follows from it.
 *
 * When the focus crosses a chunk boundary, cells at the far edge of the window leave
 * and cells at the near edge arrive. The leaving cells' slots are not thrown away —
 * they go on a free list, and the arriving cells pop them. A slot is therefore a
 * *recyclable pool entry*, and the same slot points at a different cell an instant
 * later. Anything whose identity is tied to a slot is destroyed by a scroll, which is
 * why paint tiles are keyed by absolute cell rather than by slot (ADR 0005).
 *
 * The alternative — a `Map` keyed by cell coordinates — is fine until the window
 * scrolls, and then it is not: reversing it means touching the renderer, the mesher,
 * the client, the picker and every edit call site at once.
 *
 * Nothing here knows what a chunk *contains*. This is the store, and the mesh, the
 * field and the paint tiles are held by something else and told when a slot changes
 * cell.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import { CoordinateMap } from "./coordinate-map";
import {
  cellCentre,
  cellDistance,
  cellsInSphere,
  chunkCellOf,
  DEFAULT_LOD_BANDS,
  lodAt,
  lodIsOff,
  overlapMaskAt,
  sphereCells,
  type CellCoord,
  type Lod,
  type LodBands,
  type OverlapMask,
} from "./level-data";

/** One resident chunk. What a slot holds. */
export interface ChunkSlot {
  /**
   * Which cell this slot currently stands for. A slot always has a cell — it is never
   * unassigned — so nothing has to null-check it, and `filled` is what says whether
   * that cell's *contents* have arrived.
   */
  cell: CellCoord;
  /** The world position of the cell's centre. */
  centre: Vec3;
  /**
   * The level of detail this slot has been asked for. Kept separate from the level
   * it currently holds, because a slot can be waiting on a fill at a level it does not
   * have yet — and comparing a request against the level it holds would re-request it
   * every frame until it arrived.
   */
  targetLod: Lod;
  /**
   * Faces of the cell whose neighbour is meshed at a finer level of detail.
   *
   * Held beside `targetLod` because it is chosen the same way and changes with it: a face
   * where a finer neighbour begins is the only place a chunk reaches outside its own
   * cells, and a slot whose target overlap moved is a slot that has to be rebuilt exactly
   * as one whose level moved.
   */
  targetOverlap: OverlapMask;
  /**
   * Whether anything has been built for this slot's current cell.
   *
   * **A query about an unfilled slot is refused, not answered.** Between the moment a
   * slot is re-pointed at an arriving cell and the moment that cell's mesh lands, the
   * slot physically holds the cell it left behind. Answering from it would put one
   * chunk's geometry at another's coordinates; zeroing it would be worse, because zero
   * is a plausible-looking answer. The reference implementation's comment on the same
   * line says it better: *it answers for neither*.
   */
  filled: boolean;
}

export interface ChunkWindowParams {
  /** Chunk radius in x and z. */
  radius: number;
  /** Chunk radius in y, which is normally smaller — see `sphereCells`. */
  yRadius?: number;
  /** How far each level of detail reaches. */
  bands?: LodBands;
  /**
   * Told when a slot starts standing for a different cell. The renderer clears the
   * slot's old geometry here, so that the previous cell's surface is not drawn at the
   * new cell's position for the frames between the switch and the rebuild.
   */
  onSlotReposition?: (slot: number, cell: CellCoord) => void;
  /** Told when a slot leaves the window for good. */
  onSlotRelease?: (slot: number) => void;
  /**
   * Told the new slot count **before** a reshape rebuilds the pool. What draws the
   * slots counts them: a slot it still counted among a superchunk's members would
   * keep that superchunk waiting for a slot the window no longer has, and the wait
   * has a stall backstop behind it, so the symptom would be geometry appearing late
   * rather than never.
   */
  onSlotCountChanged?: (count: number) => void;
  /** Told which slots a focus move has invalidated and must have rebuilt. */
  onSlotsChanged?: (slots: readonly number[]) => void;
  /**
   * Told a slot's *contents* have gone stale without the slot moving.
   *
   * The third way a slot loses its contents, and the one that was missing: a sculpt edit
   * invalidates the chunks it touched and leaves them exactly where they are, so neither
   * reposition nor release fires. Without this the window would correctly forget it was
   * filled while whatever holds the slot's geometry kept drawing it — the model visibly
   * unchanged by the edit, and the edit invisible in the undo history's effect.
   */
  onSlotStale?: (slot: number) => void;
  /**
   * Told a slot's *resolution* is out of date while the slot itself stays put.
   *
   * The fourth event, and the one that used to be folded into `onSlotRelease`. A cell
   * whose level-of-detail band has moved is still that cell, at the same coordinates, and
   * the mesh already on the GPU is a surface of that cell — built at a resolution the
   * window no longer wants, and nothing else wrong with it. So the right response is to
   * keep it drawn and replace it, not to take it out of the scene and put a hole where it
   * was for as long as the mesher takes.
   *
   * That is the whole difference from a release, and it is worth a callback of its own
   * because the two are otherwise indistinguishable from outside: both queue the slot for
   * a rebuild, and only one of them may throw away what is already there.
   */
  onSlotRefill?: (slot: number) => void;
  /**
   * Called once per arriving or refilled slot, in the order they should be worked.
   * The client uses it to request meshes, nearest first.
   */
  onSlotsWanted?: (slots: readonly number[]) => void;
}

export class ChunkWindow {
  /** Every slot, indexed by slot. Its identity is what everything else holds. */
  readonly slots: ChunkSlot[] = [];

  radius: number;
  yRadius: number;
  bands: LodBands;

  /** Which cell each slot stands for, for answering "what is here". */
  private readonly index = new CoordinateMap<number>();

  /** Slot numbers not currently claimed by a cell. */
  private readonly free: number[] = [];

  /** Which cell the window is centred on. */
  private focus: CellCoord = { x: 0, y: 0, z: 0 };

  /** How many times the window has moved. */
  scrolls = 0;

  private readonly params: ChunkWindowParams;

  constructor(params: ChunkWindowParams) {
    this.params = params;
    this.radius = params.radius;
    this.yRadius = params.yRadius ?? params.radius;
    this.bands = params.bands ?? DEFAULT_LOD_BANDS;
    this.allocate(cellsInSphere(this.radius, this.yRadius));
    // The window has to start out *covering* its shape, not merely sized for it. A
    // freshly constructed window whose slots all stand for the origin cell would
    // claim that cell as many times as there are slots, and every other cell in the
    // shape would be unclaimed — so the first scroll would have to evict cells that
    // were never there and would double-claim the origin.
    this.place(sphereCells({ x: 0, y: 0, z: 0 }, this.radius, this.yRadius), {
      x: 0,
      y: 0,
      z: 0,
    });
  }

  /** How many slots the window holds, which is fixed for a given shape. */
  get capacity(): number {
    return this.slots.length;
  }

  /** The cell the window is centred on. */
  get focusCell(): CellCoord {
    return this.focus;
  }

  /**
   * The slot standing for a cell, or undefined when the window does not hold it or
   * holds it unfilled.
   *
   * Backs every spatial query, and has to be O(1) — a picker asks several times a
   * frame and the mesher asks once per sample. A linear scan over a few hundred slots
   * per query would be the hot path of the whole application.
   */
  slotOf(cell: CellCoord): number | undefined {
    const slot = this.index.get(cell.x, cell.y, cell.z);
    if (slot === undefined || !this.slots[slot].filled) return undefined;
    return slot;
  }

  /** The slot standing for whichever cell contains a world point. */
  slotAt(world: Vec3): number | undefined {
    const cell = chunkCellOf(world);
    return this.slotOf(cell);
  }

  /** Whether the window holds a cell's contents. */
  has(cell: CellCoord): boolean {
    return this.slotOf(cell) !== undefined;
  }

  /** Whether a cell is inside the window's shape, whether or not it is filled. */
  covers(cell: CellCoord): boolean {
    return this.index.has(cell.x, cell.y, cell.z);
  }

  /**
   * The slot standing for a cell, whether or not that cell is filled.
   *
   * The counterpart to `slotOf`, and the one anything *holding* slots wants rather than
   * anything *asking about* one. `slotOf` refuses an unfilled slot because a query about a
   * chunk whose contents have not arrived has no honest answer; a holder of slots needs to
   * know where a chunk lives precisely while its contents are missing, since that is
   * exactly when it has to invalidate, re-request or re-mesh it.
   *
   * Using `slotOf` for that job fails quietly and expensively: every unfilled chunk looks
   * like it is not in the window at all, so a sculpt edit skips the chunks that were still
   * being meshed, which are the ones most likely to be mid-answer.
   */
  claimedSlotOf(cell: CellCoord): number | undefined {
    return this.index.get(cell.x, cell.y, cell.z);
  }

  /**
   * Whether a slot is currently claimed by a cell.
   *
   * Distinct from `filled`: a slot between being re-pointed at an arriving cell and
   * that cell's mesh landing is claimed but unfilled, and something holding slots —
   * the renderer's superchunk membership, the client's in-flight map — has to be able
   * to tell those apart from a slot that has been released outright.
   */
  isClaimed(slot: number): boolean {
    const entry = this.slots[slot];
    if (entry === undefined) return false;
    return this.index.get(entry.cell.x, entry.cell.y, entry.cell.z) === slot;
  }

  /** The cell a slot stands for, or undefined if the slot has been released. */
  cellOfSlot(slot: number): CellCoord | undefined {
    return this.isClaimed(slot) ? this.slots[slot].cell : undefined;
  }

  /** Every slot, whether filled or not. */
  get filledCount(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.filled) count++;
    return count;
  }

  /**
   * Moves the window's centre to a world point, and does nothing if it is already
   * there.
   *
   * Returns whether it moved. A caller in a frame loop calls this every frame, and
   * rebuilding on a focus that has not crossed a boundary would thrash the mesh
   * request queue and invalidate every slot for no reason.
   *
   * The order of the three passes matters and is load-bearing:
   *
   * 1. **Evict**, walking by slot rather than over the index, because removing an
   *    entry from a hash table rearranges what follows it to close its probe gap — so a
   *    walk over the index would read another cell's entries as its own.
   * 2. **Teleport** each arriving cell onto a freed slot. The slot is marked unfilled
   *    here, *before* anything is requested for it.
   * 3. **Order** the work nearest-first, so the ground being walked toward is built
   *    before the ground behind.
   */
  scrollTo(world: Vec3): boolean {
    const centre = chunkCellOf(world);
    if (
      centre.x === this.focus.x &&
      centre.y === this.focus.y &&
      centre.z === this.focus.z
    ) {
      return false;
    }

    const arriving = sphereCells(centre, this.radius, this.yRadius);

    // A cell that stays in the window keeps its slot, but the level of detail it was
    // built at was chosen for its old distance. One whose band has moved across is
    // rebuilt in place, so a cell being walked toward sheds its coarse mesh before it
    // comes into view rather than after.
    const refilling: number[] = [];

    for (let slot = 0; slot < this.slots.length; slot++) {
      const entry = this.slots[slot];
      // Skipped where a cell has already been freed but not yet claimed: it is in the
      // index under nobody's name, and this slot is somebody else's now.
      if (this.index.get(entry.cell.x, entry.cell.y, entry.cell.z) !== slot)
        continue;

      if (!this.shapeContains(entry.cell, centre)) {
        this.params.onSlotRelease?.(slot);
        this.index.delete(entry.cell.x, entry.cell.y, entry.cell.z);
        this.free.push(slot);
        continue;
      }

      const wanted = lodAt(entry.cell, centre, this.bands);
      const wantedOverlap = overlapMaskAt(entry.cell, centre, this.bands);
      if (wanted !== entry.targetLod || wantedOverlap !== entry.targetOverlap) {
        // Refill, not release. The cell has not changed — only the resolution it is to be
        // built at — so the geometry on the GPU is still this cell's own surface, sitting
        // at the coordinates it has always sat at, and is merely the wrong one to look at
        // for a few hundred milliseconds. Releasing it would open a hole for exactly as
        // long as the mesher takes, and a band boundary crosses a whole ring of cells at
        // once, so that is not a gap somewhere in the model but a flicker sweeping the
        // horizon on every step. `onSlotRelease` is left to the two events where the cell
        // itself moves, because there the old geometry really does belong elsewhere.
        this.params.onSlotRefill?.(slot);
        // Unfilled as well as queued, so nothing reads this slot as answered: the window
        // keeps asking for it, and a query about it is refused rather than answered from
        // geometry at a resolution the window has stopped asking for. Keeping the surface
        // drawn and refusing to answer from it are not in tension — the picker traces the
        // field rather than the mesh (ADR 0009), so what is on screen and what a query may
        // read have been separate concerns since then, and this is where the window settles
        // its own half of the question.
        entry.filled = false;
        refilling.push(slot);
        entry.targetLod = wanted;
        entry.targetOverlap = wantedOverlap;
      }
    }

    const entering: number[] = [];
    for (const cell of arriving) {
      if (this.index.has(cell.x, cell.y, cell.z)) continue;
      const slot = this.free.pop();
      if (slot === undefined) {
        // The pool is sized for exactly this window's shape, and a scroll replaces the
        // same number of cells it evicts — so running dry means the shape changed
        // under the pool, which is a bug rather than a runtime condition to recover
        // from. Failing loudly here beats drawing a window with a hole in it.
        throw new Error(
          "[ChunkWindow] slot pool exhausted; the window shape and its pool disagree",
        );
      }
      this.index.set(cell.x, cell.y, cell.z, slot);
      const entry = this.slots[slot];
      entry.cell = cell;
      entry.centre = cellCentre(cell);
      entry.targetLod = lodAt(cell, centre, this.bands);
      entry.targetOverlap = overlapMaskAt(cell, centre, this.bands);
      // The slot still holds the cell it left behind and now stands for this one.
      // Until the rebuild lands it answers for neither.
      entry.filled = false;
      this.params.onSlotReposition?.(slot, cell);
      entering.push(slot);
    }

    this.focus = centre;
    this.scrolls++;

    const wanted = [...entering, ...refilling];
    if (wanted.length === 0) return true;

    // Nearest first, because the caller's request queue is drained in the order it is
    // given and the chunk under the pointer has to be there before anything else.
    wanted.sort(
      (a, b) => this.distanceToSlot(a, world) - this.distanceToSlot(b, world),
    );

    this.params.onSlotsChanged?.(wanted);
    this.params.onSlotsWanted?.(wanted);
    return true;
  }

  /**
   * Rebuilds the window at a different shape, or different level-of-detail bands,
   * around the cell it is already centred on.
   *
   * The pool keeps its identity across this, which everything holding a slot depends
   * on, so the array is truncated or extended in place rather than replaced. What
   * draws the slots is told the new size **first**: a slot it still counted among a
   * superchunk's members would keep that superchunk waiting for a slot the window no
   * longer has.
   *
   * Every slot is refilled, because a slot that keeps its cell may still want
   * different geometry: a wider window moves the level-of-detail shells outward under
   * cells already held, and moving the shells directly does the same.
   *
   * @returns how many slots the window now holds.
   */
  reshape(radius: number, yRadius: number, bands: LodBands): number {
    const wanted = cellsInSphere(radius, yRadius);
    const before = this.slots.length;

    // Every slot is about to stand for a different cell, or for none.
    for (let slot = 0; slot < before; slot++) this.params.onSlotRelease?.(slot);

    this.params.onSlotCountChanged?.(wanted);

    this.radius = radius;
    this.yRadius = yRadius;
    this.bands = bands;

    this.slots.length = wanted;
    for (let slot = before; slot < wanted; slot++) {
      this.slots[slot] = {
        cell: { x: 0, y: 0, z: 0 },
        centre: { x: 0, y: 0, z: 0 },
        targetLod: lodAt({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, bands),
        targetOverlap: overlapMaskAt(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          bands,
        ),
        filled: false,
      };
    }

    this.place(sphereCells(this.focus, radius, yRadius), this.focus);
    return wanted;
  }

  /**
   * Claims a set of cells onto free slots, nearest first, and asks for their work.
   *
   * Used by the constructor and by `reshape`, both of which need the window to start
   * out covering its shape rather than merely sized for it.
   */
  private place(cells: readonly CellCoord[], centre: CellCoord): void {
    // Nothing keeps its cell any more, so the index and the free list start again
    // rather than being mended entry by entry. The index is presized for the whole
    // window, because a scroll replaces the number of cells it evicts and a rehash
    // mid-scroll would cost more than the scroll's own tree work.
    this.index.clear();
    this.free.length = 0;
    for (let slot = 0; slot < this.slots.length; slot++) this.free.push(slot);

    const ordered = [...cells].sort(
      (a, b) => cellDistance(a, centre) - cellDistance(b, centre),
    );
    const taken: number[] = [];
    for (const cell of ordered) {
      const slot = this.free.pop();
      if (slot === undefined) break;
      this.index.set(cell.x, cell.y, cell.z, slot);
      const entry = this.slots[slot];
      entry.cell = cell;
      entry.centre = cellCentre(cell);
      entry.targetLod = lodAt(cell, centre, this.bands);
      entry.targetOverlap = overlapMaskAt(cell, centre, this.bands);
      entry.filled = false;
      taken.push(slot);
    }

    this.params.onSlotsChanged?.(taken);
    this.params.onSlotsWanted?.(taken);
  }

  /**
   * Marks a slot's contents as arrived.
   *
   * The generation counter is what makes this safe against a rebuild that was already
   * in flight: a result for a slot that has since been re-pointed or re-targeted is
   * applied and then immediately invalidated by the next `invalidate`, which is
   * harmless, rather than being allowed to mark a slot filled for the wrong cell.
   */
  markFilled(slot: number): void {
    const entry = this.slots[slot];
    if (entry === undefined) return;
    entry.filled = true;
  }

  /**
   * Marks a slot's contents as stale, so queries against it are refused.
   *
   * Refuses to do so twice: an edit that touches a chunk already waiting on a mesh would
   * otherwise be told about it every time, and a stroke invalidating the same box on every
   * dab would re-request it on every dab.
   */
  markStale(slot: number): void {
    const entry = this.slots[slot];
    if (entry === undefined) return;
    if (!entry.filled) return;
    entry.filled = false;
    this.params.onSlotStale?.(slot);
  }

  /** The level of detail a slot currently holds, as a sample size. */
  lodOf(slot: number): Lod {
    const entry = this.slots[slot];
    return entry.targetLod;
  }

  /** The faces a slot's mesh reaches into, because a neighbour is at a finer level. */
  overlapOf(slot: number): OverlapMask {
    const entry = this.slots[slot];
    return entry.targetOverlap;
  }

  /** Whether the window's level of detail is switched off. */
  get levelOfDetailOff(): boolean {
    return lodIsOff(this.bands);
  }

  /** Distance from a world point to a slot's centre, in world units. */
  private distanceToSlot(slot: number, world: Vec3): number {
    const centre = this.slots[slot].centre;
    return Math.hypot(
      centre.x - world.x,
      centre.y - world.y,
      centre.z - world.z,
    );
  }

  private shapeContains(cell: CellCoord, centre: CellCoord): boolean {
    const dx = cell.x - centre.x;
    const dy = cell.y - centre.y;
    const dz = cell.z - centre.z;
    if (this.yRadius <= 0)
      return dy === 0 && dx * dx + dz * dz <= this.radius * this.radius;
    const ky = this.radius / this.yRadius;
    return dx * dx + dz * dz + (dy * ky) ** 2 <= this.radius * this.radius;
  }

  private allocate(count: number): void {
    for (let slot = 0; slot < count; slot++) {
      this.slots[slot] = {
        cell: { x: 0, y: 0, z: 0 },
        centre: { x: 0, y: 0, z: 0 },
        targetLod: lodAt(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          this.bands,
        ),
        targetOverlap: overlapMaskAt(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0 },
          this.bands,
        ),
        filled: false,
      };
    }
    // Popped, so the last slot goes out first and the first few are claimed in
    // reading order — which makes the initial build deterministic without depending
    // on the order `sphereCells` happened to produce.
    for (let slot = count - 1; slot >= 0; slot--) this.free.push(slot);
  }
}
