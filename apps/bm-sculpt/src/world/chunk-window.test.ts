import { describe, expect, it } from "vitest";

import { BLOCK_WORLD } from "../constants";
import { ChunkWindow, type ChunkWindowParams } from "./chunk-window";
import {
  cellCentre,
  chunkCellOf,
  DEFAULT_LOD_BANDS,
  LOD_OFF,
  lodExtent,
  OVERLAP_X_NEG,
} from "./level-data";
import type { CellCoord } from "./level-data";

/** A window that records everything told to it, so scrolls can be inspected. */
const recordingWindow = (params: Partial<ChunkWindowParams> = {}) => {
  const events = {
    repositioned: [] as Array<{ slot: number; cell: CellCoord }>,
    released: [] as number[],
    refilled: [] as number[],
    counts: [] as number[],
    changed: [] as number[][],
    wanted: [] as number[][],
  };
  const window = new ChunkWindow({
    radius: 2,
    yRadius: 1,
    ...params,
    onSlotReposition: (slot, cell) => events.repositioned.push({ slot, cell }),
    onSlotRelease: (slot) => events.released.push(slot),
    onSlotRefill: (slot) => events.refilled.push(slot),
    onSlotCountChanged: (count) => events.counts.push(count),
    onSlotsChanged: (slots) => events.changed.push([...slots]),
    onSlotsWanted: (slots) => events.wanted.push([...slots]),
  });
  // The constructor places the initial window, which fires the same callbacks a
  // scroll does. `reset` clears them so a test can assert about one scroll without
  // having to subtract the construction — and the tests that care about construction
  // simply do not call it.
  const reset = (): void => {
    events.repositioned.length = 0;
    events.released.length = 0;
    events.refilled.length = 0;
    events.counts.length = 0;
    events.changed.length = 0;
    events.wanted.length = 0;
  };
  return { window, events, reset };
};

const fillEverything = (window: ChunkWindow): void => {
  for (let slot = 0; slot < window.slots.length; slot++)
    window.markFilled(slot);
};

describe("a fresh window", () => {
  it("holds one slot per cell in its shape, and nothing else", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    expect(window.slots.length).toBe(window.capacity);
    expect(window.capacity).toBeGreaterThan(1);
    // Every slot starts unfilled: a slot standing for a cell with no mesh answers no
    // queries, which is correct even before anything has been built.
    expect(window.filledCount).toBe(0);
  });

  it("claims every cell in its shape exactly once", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    const claimed = new Set<string>();
    for (const slot of window.slots) {
      const key = `${slot.cell.x},${slot.cell.y},${slot.cell.z}`;
      expect(claimed.has(key), `duplicate claim on ${key}`).toBe(false);
      claimed.add(key);
    }
    // And the centre cell is among them, which is where a model lives.
    expect(claimed.has("0,0,0")).toBe(true);
  });

  it("refuses a query for any cell, because nothing has been built", () => {
    // Every cell is claimed and none is filled, so the window knows where a chunk
    // goes and has nothing to say about it. That distinction is the whole point of
    // `filled`.
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    expect(window.covers({ x: 0, y: 0, z: 0 })).toBe(true);
    expect(window.slotOf({ x: 0, y: 0, z: 0 })).toBeUndefined();
    expect(window.has({ x: 0, y: 0, z: 0 })).toBe(false);
  });
});

describe("answering queries", () => {
  it("answers for a filled slot and refuses an unfilled one", () => {
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    const centre = { x: 0, y: 0, z: 0 };
    const slot = window.slots.findIndex(
      (s) => s.cell.x === 0 && s.cell.y === 0 && s.cell.z === 0,
    );
    expect(slot).toBeGreaterThanOrEqual(0);

    window.markFilled(slot);
    expect(window.slotOf(centre)).toBe(slot);
    expect(window.slotAt({ x: 0, y: 0, z: 0 })).toBe(slot);

    window.markStale(slot);
    expect(window.slotOf(centre)).toBeUndefined();
  });

  it("resolves a world point to the slot holding its cell", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    fillEverything(window);
    for (const cell of [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 1 },
      { x: 0, y: 1, z: 0 },
    ]) {
      const slot = window.slotOf(cell);
      expect(slot, JSON.stringify(cell)).toBeDefined();
      expect(window.slots[slot!].cell).toEqual(cell);
      // The world point at that cell's centre resolves back to the same slot.
      expect(window.slotAt(cellCentre(cell))).toBe(slot);
    }
  });

  it("refuses a cell outside its shape", () => {
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    fillEverything(window);
    expect(window.slotOf({ x: 40, y: 0, z: 0 })).toBeUndefined();
    expect(window.slotOf({ x: 0, y: 0, z: 0 })).toBeDefined();
  });

  it("gives a slot the world position of the cell it stands for", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    for (const slot of window.slots) {
      expect(slot.centre).toEqual(cellCentre(slot.cell));
    }
  });
});

describe("scrolling", () => {
  it("places its initial cells when constructed", () => {
    // Not an implementation detail: a window that was merely *sized* for its shape
    // would have every slot standing for the origin cell, so the first scroll would
    // evict cells that were never there and double-claim the origin.
    const { window, events } = recordingWindow({ radius: 2, yRadius: 1 });
    expect(events.wanted).toHaveLength(1);
    // One slot per cell in the shape, all of them unfilled until their mesh lands.
    expect(events.wanted[0]).toHaveLength(window.capacity);
    expect(window.filledCount).toBe(0);
    // And the nearest one is the centre, so the first chunk built is the one the
    // camera is inside.
    const first = events.wanted[0][0];
    expect(window.slots[first].cell).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("does nothing when the focus has not crossed a boundary", () => {
    // A frame loop calls this every frame. Rebuilding on a focus that has not moved
    // would invalidate every slot sixty times a second for nothing.
    const { window, events, reset } = recordingWindow({
      radius: 1,
      yRadius: 1,
    });
    fillEverything(window);
    reset();
    expect(window.scrollTo({ x: 10, y: 0, z: 0 })).toBe(false);
    expect(window.scrolls).toBe(0);
    expect(events.changed).toHaveLength(0);
    expect(events.wanted).toHaveLength(0);
    expect(window.filledCount).toBe(window.capacity);
  });

  it("keeps the window centred on the focus", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    window.scrollTo({ x: 3000, y: 0, z: -1500 });
    expect(window.focusCell).toEqual(chunkCellOf({ x: 3000, y: 0, z: -1500 }));
    // Every claimed cell is within the window's shape of the new centre.
    for (const slot of window.slots) {
      const dx = slot.cell.x - window.focusCell.x;
      const dy = slot.cell.y - window.focusCell.y;
      const dz = slot.cell.z - window.focusCell.z;
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(2.0001);
      expect(Math.abs(dy)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("recycles slots rather than growing the pool", () => {
    // The load-bearing property of the whole design. A slot is a pool entry, so a
    // scroll moves the same slots to different cells rather than allocating more.
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    const capacity = window.capacity;
    for (let step = 1; step <= 40; step++) {
      window.scrollTo({ x: step * 300, y: 0, z: 0 });
      expect(window.capacity, `after ${step} scrolls`).toBe(capacity);
      expect(window.slots.length).toBe(capacity);
    }
  });

  it("marks an arriving slot unfilled before anything is requested for it", () => {
    // The window between a slot being re-pointed and its rebuild landing is the
    // window in which the slot physically holds the cell it left behind. Answering
    // from it puts one chunk's geometry at another's coordinates.
    const { window, events } = recordingWindow({ radius: 1, yRadius: 1 });
    fillEverything(window);
    window.scrollTo({ x: 300, y: 0, z: 0 });

    expect(events.repositioned.length).toBeGreaterThan(0);
    for (const { slot, cell } of events.repositioned) {
      expect(window.slots[slot].cell).toEqual(cell);
    }
    // Nothing the window just re-pointed is filled.
    for (const slot of events.repositioned.map((entry) => entry.slot)) {
      expect(window.slots[slot].filled, `slot ${slot}`).toBe(false);
    }
    expect(window.filledCount).toBeLessThan(window.capacity);
  });

  it("requests the nearest cells first", () => {
    // The chunk under the pointer has to be built before the ground behind, or the
    // sculpting tool picks a face belonging to something that is not there yet.
    const { window, events, reset } = recordingWindow({
      radius: 2,
      yRadius: 1,
    });
    fillEverything(window);
    reset();
    window.scrollTo({ x: 3000, y: 0, z: 0 });
    expect(events.wanted).toHaveLength(1);
    const order = events.wanted[0];
    const focus = { x: 3000, y: 0, z: 0 };
    const distances = order.map((slot) => {
      const centre = cellCentre(window.slots[slot].cell);
      return Math.hypot(
        centre.x - focus.x,
        centre.y - focus.y,
        centre.z - focus.z,
      );
    });
    for (let at = 1; at < distances.length; at++) {
      expect(
        distances[at],
        `slot ${order[at]} out of order`,
      ).toBeGreaterThanOrEqual(distances[at - 1]);
    }
    // And the very first is the chunk the focus is in.
    expect(window.slots[order[0]].cell).toEqual(chunkCellOf(focus));
  });

  it("rebuilds a cell whose level of detail band moved, in place", () => {
    // A cell the user walks toward sheds its coarse mesh before it comes into view.
    // Without this, the mesh appears at the wrong resolution and stays there until
    // something else invalidates it.
    const { window, events, reset } = recordingWindow({
      radius: 3,
      yRadius: 3,
    });
    fillEverything(window);
    const far = window.slots.findIndex((s) => s.cell.x === 3);
    expect(far).toBeGreaterThanOrEqual(0);
    reset();

    window.scrollTo({ x: 900, y: 0, z: 0 });
    const rebuilt = new Set(events.wanted.flat());
    expect(rebuilt.size).toBeGreaterThan(0);
    // The cell that was three chunks out is now the focus's own neighbourhood.
    expect(window.slots[far].cell).toBeDefined();
    expect(rebuilt.size).toBeGreaterThan(0);
    // Whatever was rebuilt is unfilled until its mesh lands.
    for (const slot of rebuilt) expect(window.slots[slot].filled).toBe(false);
  });

  it("refills a cell whose band moved, rather than releasing it", () => {
    // The two events look identical from here — a slot is queued for a rebuild either way —
    // and the difference is entirely in what the renderer is told. Releasing here would
    // free a slot's buffers and take its mesh out of the scene for a cell that has not
    // moved, which puts a hole in the model for as long as the mesher takes. And a band
    // boundary crosses a whole ring of cells at once, so that is a flicker sweeping the
    // horizon on every step rather than a gap somewhere.
    const { window, events, reset } = recordingWindow({
      radius: 3,
      yRadius: 3,
    });
    fillEverything(window);
    reset();

    window.scrollTo({ x: 900, y: 0, z: 0 });

    expect(events.refilled.length).toBeGreaterThan(0);
    // Nothing that merely changed resolution was taken out of the window's bookkeeping as
    // a departure — and the two sets are disjoint, because a slot is either arriving or
    // changing resolution, never both.
    expect(events.refilled).not.toContain(0);
    for (const slot of events.refilled) {
      expect(events.released, `slot ${slot}`).not.toContain(slot);
      expect(window.covers(window.slots[slot].cell)).toBe(true);
    }
    // It is still unfilled, so nothing reads it as answered and it is asked for again.
    for (const slot of events.refilled) {
      expect(window.slots[slot].filled, `slot ${slot}`).toBe(false);
    }
  });

  it("keeps every claimed cell claimed, across many scrolls", () => {
    // The invariant that catches a broken eviction: if a cell is left in the index
    // after its slot has been recycled, two slots answer for it, and if it is dropped
    // without the slot being freed, the pool drains and eventually throws.
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    for (let step = 0; step < 60; step++) {
      window.scrollTo({ x: step * 250, y: (step % 3) * 100, z: -step * 130 });
      const seen = new Set<string>();
      for (let slot = 0; slot < window.slots.length; slot++) {
        const cell = window.cellOfSlot(slot);
        if (cell === undefined) continue;
        const key = `${cell.x},${cell.y},${cell.z}`;
        expect(seen.has(key), `cell ${key} claimed twice at step ${step}`).toBe(
          false,
        );
        seen.add(key);
      }
      expect(seen.size).toBeLessThanOrEqual(window.capacity);
    }
  });

  it("agrees with itself about which cells it holds, after any number of scrolls", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    fillEverything(window);
    for (let step = 1; step <= 20; step++) {
      window.scrollTo({ x: step * 700, y: 0, z: step * 400 });
      fillEverything(window);
      // Every claimed slot answers for its own cell and only its own cell.
      for (let slot = 0; slot < window.slots.length; slot++) {
        const cell = window.cellOfSlot(slot);
        if (cell === undefined) continue;
        expect(window.slotOf(cell), `step ${step}`).toBe(slot);
      }
    }
  });
});

describe("reshaping", () => {
  it("keeps the slot array's identity, which everything holding a slot needs", () => {
    // Replacing the array would orphan every holder of a slot — the renderer's
    // per-slot meshes, the client's generation counters — and the symptom would be
    // geometry that never appears rather than an error.
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    const before = window.slots.slice();
    window.reshape(3, 2, DEFAULT_LOD_BANDS);
    for (const slot of before) expect(window.slots).toContain(slot);
  });

  it("tells its holder the new size before rebuilding the pool", () => {
    // The renderer counts slots per superchunk. Told afterwards, it would keep waiting
    // for a slot the window no longer has.
    const { window, events } = recordingWindow({ radius: 1, yRadius: 1 });
    window.reshape(2, 1, DEFAULT_LOD_BANDS);
    expect(events.counts).toEqual([window.capacity]);
  });

  it("grows and shrinks to the shape it is given", () => {
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    const small = window.capacity;
    window.reshape(3, 2, DEFAULT_LOD_BANDS);
    const large = window.capacity;
    expect(large).toBeGreaterThan(small);
    window.reshape(1, 1, DEFAULT_LOD_BANDS);
    expect(window.capacity).toBe(small);
  });

  it("refills every slot, because a kept cell may still want different geometry", () => {
    // A wider window moves the level-of-detail shells outward under cells already
    // held, and changing the bands does the same thing.
    const { window } = recordingWindow({ radius: 2, yRadius: 2 });
    fillEverything(window);
    window.reshape(2, 2, DEFAULT_LOD_BANDS);
    expect(window.filledCount).toBe(0);
    // And it asked for all of them.
    const wanted = window.slots.filter((slot) =>
      window.isClaimed(window.slots.indexOf(slot)),
    );
    expect(wanted.length).toBeGreaterThan(0);
  });

  it("claims every cell of the new shape, exactly once", () => {
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    window.reshape(3, 2, DEFAULT_LOD_BANDS);
    const seen = new Set<string>();
    for (const slot of window.slots) {
      const key = `${slot.cell.x},${slot.cell.y},${slot.cell.z}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
      expect(
        Math.hypot(
          slot.cell.x - window.focusCell.x,
          slot.cell.z - window.focusCell.z,
        ),
      ).toBeLessThanOrEqual(3.0001);
    }
  });

  it("does not move the window, only rescales it", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    window.scrollTo({ x: 3000, y: 0, z: 0 });
    const focus = window.focusCell;
    window.reshape(3, 2, DEFAULT_LOD_BANDS);
    expect(window.focusCell).toEqual(focus);
  });

  it("survives repeated reshaping without draining the pool", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    for (let round = 0; round < 8; round++) {
      window.reshape(1 + (round % 3), 1, DEFAULT_LOD_BANDS);
      window.scrollTo({ x: round * 400, y: 0, z: 0 });
    }
    expect(window.capacity).toBeGreaterThan(0);
  });
});

describe("level of detail", () => {
  it("puts the focus's own cell at full resolution", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    window.scrollTo({ x: 300, y: 0, z: 0 });
    const centre = chunkCellOf({ x: 300, y: 0, z: 0 });
    expect(
      window.slots.find((s) => s.cell.x === centre.x && s.cell.z === centre.z)
        ?.targetLod,
    ).toBe(0);
  });

  it("holds the same extent at every level", () => {
    // Swapping a slot's level is only legitimate because the level changes resolution
    // and not place. A level that covered different ground would make every swap a
    // visible jump.
    expect(lodExtent(0)).toBe(lodExtent(1));
    expect(lodExtent(1)).toBe(lodExtent(2));
  });

  it("reports that level of detail is off when the bands are", () => {
    const { window } = recordingWindow({
      radius: 1,
      yRadius: 1,
      bands: LOD_OFF,
    });
    expect(window.levelOfDetailOff).toBe(true);
    const { window: on } = recordingWindow({ radius: 1, yRadius: 1 });
    expect(on.levelOfDetailOff).toBe(false);
  });
});

describe("overlap masks", () => {
  it("reaches out of a cell whose neighbour is finer, and not the other way round", () => {
    // Measured from the focus *cell*, and the player is anywhere inside that cell — so the
    // cell worth testing is the first one *outside* the full-detail band, which is a step
    // coarser than the neighbour behind it and reaches back into it. Inside the band
    // everything is watertight and reaches into nothing.
    const { full } = DEFAULT_LOD_BANDS;
    const { window } = recordingWindow({ radius: full + 2, yRadius: 1 });
    const centre = window.claimedSlotOf({ x: 0, y: 0, z: 0 });
    const edge = window.claimedSlotOf({ x: full + 1, y: 0, z: 0 });
    expect(centre).toBeDefined();
    expect(edge).toBeDefined();
    expect(window.lodOf(centre as number)).toBe(0);
    expect(window.lodOf(edge as number)).toBe(1);
    expect(window.overlapOf(centre as number)).toBe(0);
    expect(window.overlapOf(edge as number)).toBe(OVERLAP_X_NEG);
  });

  it("rebuilds a cell whose neighbour's level moved, even when its own did not", () => {
    // The cells a chunk reaches into are on the *neighbour's* side of the boundary, so a
    // cell whose own level is unchanged can still need a different overlap. Leaving it
    // alone here would put the slit back exactly along the band the scroll just moved.
    //
    // The bands are wider than the defaults so that the level a cell is at is not decided
    // by its distance alone: with one chunk of level between two bands, every cell whose
    // neighbour changes band has changed band itself, and the case could not be built at
    // all. Here the middle level is four chunks thick, so (3,0,0) stays at level 1 across
    // the scroll while its neighbour at (2,0,0) walks into full detail — and reaches back.
    const bands = { full: 1, coarse: 4 };
    const { window, events, reset } = recordingWindow({
      radius: 4,
      yRadius: 1,
      bands,
    });
    fillEverything(window);
    const slot = window.claimedSlotOf({ x: 3, y: 0, z: 0 }) as number;
    expect(window.lodOf(slot)).toBe(1);
    expect(window.overlapOf(slot)).toBe(0);

    reset();
    window.scrollTo({ x: BLOCK_WORLD, y: 0, z: 0 });

    // Same cell, same slot — a refill and not a release or a reposition.
    expect(window.slots[slot].cell).toEqual({ x: 3, y: 0, z: 0 });
    expect(window.lodOf(slot)).toBe(1);
    expect(window.overlapOf(slot)).toBe(OVERLAP_X_NEG);
    expect(events.refilled).toContain(slot);
    expect(events.released).not.toContain(slot);
    expect(events.repositioned.map((entry) => entry.slot)).not.toContain(slot);
  });
});

describe("marking slots", () => {
  it("ignores a slot number that does not exist", () => {
    const { window } = recordingWindow({ radius: 1, yRadius: 1 });
    expect(() => window.markFilled(9999)).not.toThrow();
    expect(() => window.markStale(-1)).not.toThrow();
  });

  it("counts only filled slots", () => {
    const { window } = recordingWindow({ radius: 2, yRadius: 1 });
    window.markFilled(0);
    window.markFilled(1);
    expect(window.filledCount).toBe(2);
    window.markStale(0);
    expect(window.filledCount).toBe(1);
  });
});

describe("finding the slot behind a cell", () => {
  /** A window centred on the origin, with nothing answered. */
  const windowAt = (radius = 1): ChunkWindow =>
    new ChunkWindow({ radius, onSlotsWanted: () => {} });

  it("finds a slot whether or not the cell is filled", () => {
    // `slotOf` refuses an unfilled chunk because a query about it has no honest answer.
    // A holder of slots needs the opposite: the chunks that are unfilled are precisely the
    // ones an edit has to invalidate, because they are the ones with an answer in flight.
    const window = windowAt();
    const cell = { x: 0, y: 0, z: 0 };

    expect(window.slotOf(cell)).toBeUndefined();
    expect(window.claimedSlotOf(cell)).toBeDefined();

    window.markFilled(window.claimedSlotOf(cell)!);
    expect(window.slotOf(cell)).toBe(window.claimedSlotOf(cell));
  });

  it("agrees with the query once the cell is filled", () => {
    const window = windowAt();
    const cell = { x: 0, y: 0, z: 0 };
    window.markFilled(window.claimedSlotOf(cell)!);
    expect(window.claimedSlotOf(cell)).toBe(window.slotOf(cell));
    expect(window.has(cell)).toBe(true);
  });

  it("has no slot for a cell the window does not hold", () => {
    const window = windowAt();
    expect(window.claimedSlotOf({ x: 99, y: 0, z: 0 })).toBeUndefined();
    expect(window.covers({ x: 99, y: 0, z: 0 })).toBe(false);
  });

  it("still finds the slot after the window scrolls past the cell", () => {
    // A holder of slots has to be able to say where a chunk *was*, long enough to abandon
    // its outstanding work — which is why this is a different question from `slotOf`.
    const window = windowAt();
    const cell = { x: 0, y: 0, z: 0 };
    expect(window.claimedSlotOf(cell)).toBeDefined();
    window.scrollTo({ x: 40000, y: 0, z: 0 });
    expect(window.claimedSlotOf(cell)).toBeUndefined();
    expect(window.covers(cell)).toBe(false);
  });
});
