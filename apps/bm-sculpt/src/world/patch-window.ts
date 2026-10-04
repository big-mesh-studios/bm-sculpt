/**
 * The resident patch window: which patches of the cube-sphere exist, and what happens when the
 * viewer moves.
 *
 * ## Why this is a separate class and not `ChunkWindow` with a different shape
 *
 * `ChunkWindow`'s bookkeeping is subtle and well tested, and the obvious move is to generalise it
 * over "place". That is the right eventual destination and it is **not done here**: this file
 * duplicates the slot-recycling part of it, which is a real cost and is recorded below rather than
 * hidden. It is written separately because two of the window's policies are genuinely different on a
 * quadtree, and a shared implementation would have to carry both:
 *
 * 1. **Half of the refill event disappears, and the other half does not.** `ChunkWindow` has four
 *    ways a slot loses its contents. One of them — *the cell stayed and its level-of-detail band
 *    moved* — cannot happen here, because **a patch's level is its size** and changing level means
 *    being a different patch. The level is read once, when the patch is claimed, and never again.
 *
 *    **But the overlap still moves.** Whether a patch has a finer neighbour across an edge changes
 *    as the viewer walks, because that is what the level-of-detail tree does: splits appear ahead of
 *    the viewer and disappear behind. So the *other* half of the refill event is very much alive,
 *    and the first version of this file got it wrong — it computed `targetOverlap` once at claim
 *    time and never again, so a patch that acquired a finer neighbour kept meshing without reaching
 *    into it and a lens-shaped gap opened along the boundary as the player walked towards it. The
 *    overlap is recomputed for every resident patch on every scroll, and a change requests a refill
 *    without moving the slot, for exactly the reason ADR 0035 gives.
 * 2. **The pool must grow, and cannot be sized in advance.** `ChunkWindow` sizes its pool to exactly
 *    the shape's cell count and throws if a scroll ever runs dry, because a scroll replaces the
 *    number of cells it evicts. The patch selection's size *falls* as the viewer rises — 648 at the
 *    surface, 144 from a radius up, 6 from ten radii up — so the pool is sized for the largest the
 *    selection has been and grown when a bigger selection arrives.
 *
 * ## The duplication, stated plainly
 *
 * `reserve`, `claim`, `release` and the nearest-first ordering below are the same algorithm as
 * `ChunkWindow`'s. **Consolidating them means extracting a slot pool that owns `slots`, `free` and
 * the index, with the two windows supplying the shape and the event policy** — which is where the
 * two differ, as above. That is worth doing and is not done here; what is not worth doing is
 * generalising `ChunkWindow` in place, with its forty tests, on the strength of a second
 * implementation that has not been written yet.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import { CoordinateMap } from "./coordinate-map";
import {
  PATCH_ROOT,
  patchCentre,
  patchLevel,
  rootPatch,
  selectPatches,
  type Patch,
} from "@big-mesh-studios/csg";

/** One resident patch. What a slot holds. */
export interface PatchSlot {
  /**
   * Which patch this slot stands for. A slot always has one — it is never unassigned — so nothing
   * has to null-check it, and `filled` is what says whether its contents have arrived.
   */
  patch: Patch;
  /** The patch's centre in world units, on the surface. */
  centre: Vec3;
  /**
   * Which of the patch's four sides have a *finer* neighbour, and so want this patch to reach one
   * quadrant into them.
   *
   * The quadtree's answer to ADR 0035's overlap mask, and it is the same idea for the same reason: a
   * coarse patch's tessellation and its neighbour's differ by the level-of-detail error, and
   * without one reaching into the other there is a lens-shaped gap along every boundary.
   */
  targetOverlap: PatchOverlap;
  /** Whether anything has been built for this patch. */
  filled: boolean;
}

/**
 * The four sides of a patch, as a bit mask.
 *
 * **Sides rather than faces, because a patch is a quad on a cube face and its neighbours are across
 * its four edges.** Two patches of different sizes cannot be face-adjacent in the way two chunks
 * are, because a level-of-detail boundary on a quadtree runs along patch edges and every patch has
 * four of them.
 */
export interface PatchOverlap {
  readonly lowX: boolean;
  readonly highX: boolean;
  readonly lowY: boolean;
  readonly highY: boolean;
}

/** Whether two overlap masks are the same answer, for the refill check. */
const sameOverlap = (a: PatchOverlap, b: PatchOverlap): boolean =>
  a.lowX === b.lowX &&
  a.highX === b.highX &&
  a.lowY === b.lowY &&
  a.highY === b.highY;

const NO_OVERLAP: PatchOverlap = {
  lowX: false,
  highX: false,
  lowY: false,
  highY: false,
};

/**
 * A patch as a three-integer key.
 *
 * **`face * 8 + level`, not four integers.** `CoordinateMap` is keyed by three, and the patch's
 * `size` is redundant with its level — `size = PATCH_ROOT / 2^level` — so packing the two into one
 * integer fits the existing map with no change to it. Six faces and six levels need forty-eight
 * values, so eight is enough and the packing is `face * 8 + level`.
 */
const keyOf = (patch: Patch): [number, number, number] => [
  patch.face * 8 + patchLevel(patch.size),
  patch.x,
  patch.y,
];

export interface PatchWindowParams {
  /** The surface radius in a direction, for the level of detail rule and for patch centres. */
  readonly radiusAt: (d: Vec3) => number;
  /**
   * How finely to refine, from `selectPatches`. Absent is its default.
   *
   * **Not a parameter of this class's own arithmetic**, so that the window and the selection cannot
   * disagree about what the finest patch is.
   */
  readonly factor?: number;
  /** Told when a slot starts standing for a different patch. */
  readonly onSlotReposition?: (slot: number, patch: Patch) => void;
  /** Told when a slot leaves the window for good. */
  readonly onSlotRelease?: (slot: number) => void;
  /** Told the new slot count before the pool grows, for the same reason `ChunkWindow` does. */
  readonly onSlotCountChanged?: (count: number) => void;
  /** Told which slots a move invalidated and must have rebuilt. */
  readonly onSlotsChanged?: (slots: readonly number[]) => void;
  /**
   * Told a slot's contents are out of date while the slot itself stays put — a sculpt edit, or an
   * overlap that changed because a neighbour split.
   *
   * **Distinct from `onSlotRelease`, and the difference matters.** The geometry already on the GPU
   * is a surface of this patch, built for a resolution and an overlap the window no longer wants.
   * Releasing it would open a hole for as long as the mesher takes, and a level-of-detail boundary
   * moves across a whole ring of patches at once, so that is not a gap somewhere in the model but a
   * flicker sweeping the horizon on every step. So it is replaced, not taken away.
   */
  readonly onSlotRefill?: (slot: number) => void;
  /** Told a slot's contents have gone stale without the slot moving — a sculpt edit. */
  readonly onSlotStale?: (slot: number) => void;
  /** Called once per arriving slot, in the order they should be worked. */
  readonly onSlotsWanted?: (slots: readonly number[]) => void;
}

export class PatchWindow {
  /** Every slot, indexed by slot. Its identity is what everything else holds. */
  readonly slots: PatchSlot[] = [];

  /** Which patch each slot stands for, for answering "what is here". */
  private readonly index = new CoordinateMap<number>();

  /** Slot numbers not currently claimed by a patch. */
  private readonly free: number[] = [];

  /** Where the viewer was last time it moved. */
  private focus: Vec3 = { x: 0, y: 0, z: 0 };

  /** Whether anything has been scrolled yet. */
  private started = false;

  private readonly params: PatchWindowParams;

  constructor(params: PatchWindowParams) {
    this.params = params;
    this.reserve(64);
    // The window starts out *covering* the selection around the origin rather than merely sized for
    // it, for the reason `ChunkWindow` does: a window whose slots all stood for one patch would
    // claim that patch as many times as it has slots and leave every other patch unclaimed.
    this.scrollTo({ x: 0, y: 0, z: 0 }, true);
  }

  /** How many slots the window holds. Grows as the selection does. */
  get capacity(): number {
    return this.slots.length;
  }

  /** The slot standing for a patch, or undefined when unfilled or absent. */
  slotOf(patch: Patch): number | undefined {
    const slot = this.claimedSlotOf(patch);
    return slot !== undefined && this.slots[slot]!.filled ? slot : undefined;
  }

  /** The slot standing for a patch, whether or not it is filled. */
  claimedSlotOf(patch: Patch): number | undefined {
    const [a, b, c] = keyOf(patch);
    return this.index.get(a, b, c);
  }

  /** Whether the window holds a patch's contents. */
  has(patch: Patch): boolean {
    return this.slotOf(patch) !== undefined;
  }

  /** Whether a patch is claimed, whether or not filled. */
  covers(patch: Patch): boolean {
    return this.claimedSlotOf(patch) !== undefined;
  }

  /** Whether a slot is currently claimed by the patch it names. */
  isClaimed(slot: number): boolean {
    const entry = this.slots[slot];
    if (entry === undefined) return false;
    const [a, b, c] = keyOf(entry.patch);
    return this.index.get(a, b, c) === slot;
  }

  /** The patch a slot stands for, or undefined if released. */
  patchOfSlot(slot: number): Patch | undefined {
    return this.isClaimed(slot) ? this.slots[slot]!.patch : undefined;
  }

  /** Every slot, whether filled or not. */
  get filledCount(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.filled) count++;
    return count;
  }

  /** Marks a slot's contents as arrived. */
  markFilled(slot: number): void {
    const entry = this.slots[slot];
    if (entry === undefined) return;
    entry.filled = true;
  }

  /** Every patch the window holds, filled or not. */
  patches(): readonly Patch[] {
    return this.slots.map((slot) => slot.patch);
  }

  /**
   * Moves the window to a viewer position, and returns whether anything changed.
   *
   * **The selection is recomputed whole rather than diffed against a stored shape.** For a cubic
   * lattice the wanted cells are a box around the focus and the evictions follow from it
   * arithmetically; for a quadtree the wanted set comes out of a traversal, so it is cheaper and
   * far less error-prone to take it as given and work out what is no longer in it.
   */
  scrollTo(eye: Vec3, force = false): boolean {
    if (
      !force &&
      this.started &&
      eye.x === this.focus.x &&
      eye.y === this.focus.y &&
      eye.z === this.focus.z
    ) {
      return false;
    }
    this.started = true;

    const length = Math.hypot(eye.x, eye.y, eye.z);
    // **A viewer at the exact centre has no direction.** Every direction is "up" there, and the
    // level of detail rule needs one. It cannot happen in play — the planet's surface is four
    // thousand units out — but a caller that passes the origin should get a window rather than a
    // silent `NaN` propagating through every distance comparison.
    const direction: Vec3 =
      length === 0
        ? { x: 0, y: 1, z: 0 }
        : { x: eye.x / length, y: eye.y / length, z: eye.z / length };
    const wanted = selectPatches(
      direction,
      length,
      this.params.radiusAt,
      this.params.factor,
    ).patches;

    // The overlap of each wanted patch depends on its neighbours being finer, so the wanted set is
    // indexed first and the masks are computed against it rather than against the tree.
    const wantedKeys = new Set(wanted.map((patch) => keyOf(patch).join(",")));

    this.ensureCapacity(wanted.length);

    // **Release by walking slots, not the index.** Removing an entry from a hash table rearranges
    // what follows it to close its probe gap, so a walk over the index would read another patch's
    // entry as its own. This is the same reason and the same ordering `ChunkWindow` uses.
    const arriving: number[] = [];
    const refilling: number[] = [];
    for (let slot = 0; slot < this.slots.length; slot++) {
      const entry = this.slots[slot]!;
      const [a, b, c] = keyOf(entry.patch);
      // Skipped where a slot has been freed but not yet claimed: it is in the index under nobody's
      // name, and this slot is somebody else's now.
      if (this.index.get(a, b, c) !== slot) continue;
      if (!wantedKeys.has(`${a},${b},${c}`)) {
        this.params.onSlotRelease?.(slot);
        this.index.delete(a, b, c);
        this.free.push(slot);
        continue;
      }
      // **Still wanted, but is it still wanted the same way?** A neighbour splitting or un-splitting
      // changes which sides reach into which, and the mesh already on the GPU was built for the old
      // answer. This is the refill event, and it is why the overlap cannot be computed once.
      const overlap = this.overlapOf(entry.patch, wantedKeys);
      if (!sameOverlap(overlap, entry.targetOverlap)) {
        entry.targetOverlap = overlap;
        // Unfilled as well as queued, so nothing reads this slot as answered: the window keeps
        // asking, and a query about it is refused rather than answered from geometry that no longer
        // crosses the boundary properly.
        entry.filled = false;
        this.params.onSlotRefill?.(slot);
        refilling.push(slot);
      }
    }

    for (const patch of wanted) {
      const [a, b, c] = keyOf(patch);
      if (this.index.has(a, b, c)) continue;
      const slot = this.free.pop();
      if (slot === undefined) {
        // Cannot happen: the pool was grown to the selection's size above. Throwing rather than
        // drawing a window with a hole in it is the right failure, as it is for `ChunkWindow`.
        throw new Error(
          "[PatchWindow] slot pool exhausted after growing it to the selection",
        );
      }
      this.index.set(a, b, c, slot);
      const entry = this.slots[slot]!;
      entry.patch = patch;
      entry.centre = this.centreOf(patch);
      entry.targetOverlap = this.overlapOf(patch, wantedKeys);
      // The slot still holds the patch it left behind and now stands for this one. Until the
      // rebuild lands it answers for neither.
      entry.filled = false;
      this.params.onSlotReposition?.(slot, patch);
      arriving.push(slot);
    }

    this.focus = { x: eye.x, y: eye.y, z: eye.z };
    if (arriving.length === 0 && refilling.length === 0) return true;

    // Nearest first, because the caller's queue is drained in the order it is given and the patch
    // under the pointer has to be there before anything else.
    const distance = (slot: number): number => {
      const centre = this.slots[slot]!.centre;
      return Math.hypot(centre.x - eye.x, centre.y - eye.y, centre.z - eye.z);
    };
    // Arriving before refilling, so a patch that needs building for the first time is built before
    // one that needs rebuilding, and both nearest-first within their own group.
    const queued = [...arriving, ...refilling];
    queued.sort((a, b) => distance(a) - distance(b));

    this.params.onSlotsChanged?.(queued);
    this.params.onSlotsWanted?.(queued);
    return true;
  }

  /** Marks a slot's contents stale without the slot moving — a sculpt edit. */
  markStale(slot: number): void {
    const entry = this.slots[slot];
    if (entry === undefined || !this.isClaimed(slot)) return;
    entry.filled = false;
    this.params.onSlotStale?.(slot);
  }

  /** Grows the pool to hold `count` patches, if it cannot already. */
  private ensureCapacity(count: number): void {
    if (count <= this.slots.length) return;
    // Doubling, so a viewer rising through a doubling of the selection does not reallocate on every
    // step. The callback comes first for the reason in `ChunkWindow.reshape`: whatever draws the
    // slots counts them, and a slot it still counts among a superchunk's members would keep that
    // superchunk waiting for a slot the window no longer has.
    let wanted = Math.max(64, this.slots.length);
    while (wanted < count) wanted *= 2;
    this.reserve(wanted);
  }

  /**
   * Grows the pool to exactly `count` slots, **without disturbing what is already claimed.**
   *
   * **Extension only, and it never clears the index or the free list.** Growth happens in the
   * middle of a scroll — the selection is computed, found to be larger than the pool, and grown to
   * before anything is released — so a version that reset the index would drop every claim the
   * window currently holds and leave `free` claiming slots that are in use. The first version of
   * this method did exactly that, being a copy of `ChunkWindow.reshape`, which is safe there
   * because a reshape happens between scrolls and deliberately releases everything.
   *
   * There is no shrinking: the selection falls as a viewer rises, and a smaller pool than the
   * largest seen costs nothing but slots that sit on the free list.
   */
  private reserve(count: number): void {
    const before = this.slots.length;
    if (count <= before) return;
    this.params.onSlotCountChanged?.(count);
    for (let slot = before; slot < count; slot++) {
      const patch = placeholder();
      this.slots[slot] = {
        patch,
        centre: this.centreOf(patch),
        targetOverlap: NO_OVERLAP,
        filled: false,
      };
      // Pushed, so the new slots are handed out last and the earlier numbering stays stable for
      // whatever is already holding slots.
      this.free.push(slot);
    }
  }

  /** The patch's centre on the surface, in world units. */
  private centreOf(patch: Patch): Vec3 {
    const direction = patchCentre(patch);
    const r = this.params.radiusAt(direction);
    return { x: direction.x * r, y: direction.y * r, z: direction.z * r };
  }

  /**
   * Which of a patch's four sides have a finer neighbour across them.
   *
   * **A patch reaches into a side exactly when the patch across that side is half its size.** The
   * level-of-detail boundary runs along the shared edge, and the coarser patch's tessellation
   * differs from the finer one's by the level-of-detail error, so one of them has to continue past
   * the edge or there is a lens-shaped gap along it. Only the finer neighbour's presence matters:
   * where the neighbour is the same size the two surfaces agree and no overlap is wanted.
   */
  private overlapOf(patch: Patch, wanted: ReadonlySet<string>): PatchOverlap {
    const half = patch.size / 2;
    if (half < 1) return NO_OVERLAP;
    const near = (x: number, y: number): boolean =>
      wanted.has(
        keyOf({ face: patch.face, x, y, size: half } as Patch).join(","),
      );
    const last = PATCH_ROOT - patch.size;
    return {
      lowX: patch.x > 0 && near(patch.x - half, patch.y),
      highX: patch.x < last && near(patch.x + half, patch.y),
      lowY: patch.y > 0 && near(patch.x, patch.y - half),
      highY: patch.y < last && near(patch.x, patch.y + half),
    };
  }
}

/** A slot's placeholder patch, for one that stands for nothing yet. */
const placeholder = (): Patch => rootPatch(0);
