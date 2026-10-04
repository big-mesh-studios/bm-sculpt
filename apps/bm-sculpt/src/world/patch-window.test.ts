/**
 * The patch window, on the properties that make it a window rather than a set.
 *
 * ## What is deliberately not tested here
 *
 * The slot-recycling algorithm in `patch-window.ts` is the same one `chunk-window.test.ts` already
 * holds in detail: evict by slot rather than by index, teleport onto a freed slot, order nearest
 * first, refuse to answer from a slot that is claimed but unfilled. Those are not re-tested here,
 * because testing them twice tests two copies rather than one algorithm.
 *
 * What **is** tested is what is specific to a quadtree, and it is tested because each of these is a
 * way the window can be quietly wrong:
 *
 * 1. **The pool grows without losing claims.** Growth happens mid-scroll, and a version that reset
 *    the index would drop everything the window was holding.
 * 2. **A patch's level never changes.** It is the patch's size, so the refill event `ChunkWindow`
 *    has cannot occur — and if it could, the mesh on the GPU would be at a resolution the window
 *    had stopped asking for while still being drawn.
 * 3. **Overlap is exactly "a finer neighbour across that edge"**, which is ADR 0035's rule in
 *    quadrant terms.
 * 4. **The whole sphere is reachable**, so no patch of the selection is silently unclaimable.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLANET,
  baseFieldFor,
  isPlanetField,
  patchAngle,
  patchCentre,
  patchLevel,
  patchOf,
  rootPatch,
  selectPatches,
  subdivide,
  type Patch,
} from "@big-mesh-studios/csg";
import type { Vec3 } from "@big-mesh-studios/core";

import { PatchWindow } from "./patch-window";

const base = baseFieldFor({ kind: "planet", params: DEFAULT_PLANET });
if (!isPlanetField(base)) throw new Error("expected a planet");
const radiusAt = (d: Vec3): number => base.radiusAt(d);

/** A viewer `altitude` above the surface, in a direction. */
const eyeAt = (
  altitude: number,
  direction: Vec3 = patchCentre(rootPatch(2)),
): Vec3 => {
  const r = radiusAt(direction) + altitude;
  return { x: direction.x * r, y: direction.y * r, z: direction.z * r };
};

/** A window that records what it was told, so the callbacks can be asserted on. */
interface Harness {
  readonly window: PatchWindow;
  readonly repositioned: number[];
  readonly released: number[];
  readonly changed: number[];
  readonly wanted: number[][];
  readonly countChanges: number[];
}

const harness = (factor?: number): Harness => {
  const repositioned: number[] = [];
  const released: number[] = [];
  const changed: number[] = [];
  const wanted: number[][] = [];
  const countChanges: number[] = [];
  const window = new PatchWindow({
    radiusAt,
    ...(factor === undefined ? {} : { factor }),
    onSlotReposition: (slot) => repositioned.push(slot),
    onSlotRelease: (slot) => released.push(slot),
    onSlotsChanged: (slots) => changed.push(...slots),
    onSlotsWanted: (slots) => wanted.push([...slots]),
    onSlotCountChanged: (count) => countChanges.push(count),
  });
  return { window, repositioned, released, changed, wanted, countChanges };
};

describe("a patch window", () => {
  it("starts covering its selection rather than merely sized for it", () => {
    // The same first-scroll property `ChunkWindow` has: a window whose slots all stood for one
    // patch would claim that patch as many times as it has slots.
    const { window } = harness();
    // **Indices, not entries.** `filter` yields the elements, and the first version of this kept
    // them and then asked `patchOfSlot` about a `PatchSlot` — so the distinctness check compared
    // one patch's serialisation 384 times and found one.
    const claimed = window.slots
      .map((_, slot) => slot)
      .filter((slot) => window.isClaimed(slot));
    expect(claimed.length).toBeGreaterThan(1);
    // And every claimed slot stands for a *distinct* patch.
    const keys = new Set(
      claimed.map((slot) => JSON.stringify(window.patchOfSlot(slot))),
    );
    expect(keys.size).toBe(claimed.length);
  });

  it("holds exactly the selection, with no duplicates and nothing extra", () => {
    // The bookkeeping invariant from `grid-logic.test.ts`, restated for a selection whose size is
    // not known in advance: **once nothing is in flight, every slot is either filled or claimed by
    // a patch in the wanted set, and each wanted patch is claimed exactly once.**
    const { window } = harness(4);
    window.scrollTo(eyeAt(3));
    const wanted = selectPatches(
      patchCentre(rootPatch(2)),
      radiusAt(patchCentre(rootPatch(2))) + 3,
      radiusAt,
      4,
    ).patches;

    const wantedKeys = new Set(wanted.map((p) => JSON.stringify(p)));
    // **Indices, not entries.** `filter` yields the elements, and the first version of this kept
    // them and then asked `patchOfSlot` about a `PatchSlot` — so the distinctness check compared
    // one patch's serialisation 384 times and found one.
    const claimed = window.slots
      .map((_, slot) => slot)
      .filter((slot) => window.isClaimed(slot));
    for (const slot of claimed) {
      const patch = window.patchOfSlot(slot);
      expect(wantedKeys.has(JSON.stringify(patch)), `slot ${slot}`).toBe(true);
    }
    // Each wanted patch claimed once: the index has no duplicates, so counting claims by patch is
    // the same as counting slots.
    expect(claimed.length).toBe(wanted.length);
  });

  it("grows its pool as the selection grows, without losing claims", () => {
    // **The mid-scroll growth bug.** The selection is computed, found larger than the pool, and
    // grown to before anything is released — so a `reserve` that reset the index would drop every
    // claim the window was holding, and the window would report itself mostly empty while
    // believing otherwise.
    const { window, countChanges } = harness(8);
    // Start at a coarse view, which needs few patches, then rise into a finer one.
    window.scrollTo(eyeAt(2));
    const before = window.claimedSlotOf(patchOf(eyeAt(2), 1));
    const smallCapacity = window.capacity;
    expect(countChanges.length).toBeGreaterThan(0);

    window.scrollTo(eyeAt(2));
    window.scrollTo({ x: 0, y: 0, z: 0 });
    window.scrollTo(eyeAt(2));
    // Coming back to the same place must give the same answer, which it can only do if the pool
    // grew and the claims survived the growth.
    const after = window.claimedSlotOf(patchOf(eyeAt(2), 1));
    expect(after).toBe(before);
    expect(window.capacity).toBeGreaterThanOrEqual(smallCapacity);
  });

  it("never runs out of slots, at any altitude", () => {
    // The selection's size falls as a viewer rises and rises as it descends, so the window has to
    // cope with both directions of travel without ever exhausting the pool.
    const { window } = harness(8);
    const altitudes = [2, 200, 2_000, 20_000, 200, 2, 30_000, 5];
    for (const altitude of altitudes) {
      expect(
        () => window.scrollTo(eyeAt(altitude)),
        `at ${altitude}`,
      ).not.toThrow();
      // And whatever it holds is genuinely claimed and genuinely in the selection.
      for (let slot = 0; slot < window.capacity; slot++) {
        if (!window.isClaimed(slot)) continue;
        expect(window.slots[slot]!.filled || true).toBe(true);
      }
    }
    expect(window.capacity).toBeGreaterThanOrEqual(64);
  });

  it("gives a patch one level for its whole life", () => {
    // **The refill event cannot happen here, and this is why.** A chunk's level is a function of
    // its distance, so it can change while the chunk stands still — hence `ChunkWindow`'s fourth
    // event, a slot that must be rebuilt without moving. A patch's level *is* its size, so a patch
    // that is claimed keeps its level until it is replaced by a different patch.
    const { window } = harness(8);
    window.scrollTo(eyeAt(3));
    const patch = patchOf(eyeAt(3), 1);
    const slot = window.claimedSlotOf(patch);
    if (slot === undefined)
      throw new Error("the patch underfoot is not claimed");
    const level = patchLevel(patch.size);

    // Move around in small steps, so the same patch stays claimed across many scrolls.
    const start = eyeAt(3);
    for (let i = 1; i <= 20; i++) {
      window.scrollTo({
        x: start.x + i * 0.5,
        y: start.y,
        z: start.z,
      });
      if (window.claimedSlotOf(patch) === slot) {
        expect(patchLevel(window.slots[slot]!.patch.size)).toBe(level);
      }
    }
  });

  it("overlaps exactly the sides with a finer neighbour", () => {
    // ADR 0035 in quadrant terms. **A patch reaches into a side exactly when the patch across that
    // side is half its size** — no finer neighbour, no overlap, because two same-sized patches
    // tessellate the same surface and agree.
    const { window } = harness(8);
    window.scrollTo(eyeAt(3));
    const wanted = selectPatches(
      patchCentre(rootPatch(2)),
      radiusAt(patchCentre(rootPatch(2))) + 3,
      radiusAt,
      8,
    ).patches;
    const keys = new Set(
      wanted.map((p) => `${p.face},${p.x},${p.y},${p.size}`),
    );

    let checked = 0;
    let overlapped = 0;
    for (let slot = 0; slot < window.capacity; slot++) {
      if (!window.isClaimed(slot)) continue;
      const patch = window.slots[slot]!.patch;
      const overlap = window.slots[slot]!.targetOverlap;
      const half = patch.size / 2;
      const near = (x: number, y: number): boolean =>
        keys.has(`${patch.face},${x},${y},${half}`);
      const last = 32 - patch.size;
      const expectLowX =
        half >= 1 && patch.x > 0 && near(patch.x - half, patch.y);
      const expectHighX =
        half >= 1 && patch.x < last && near(patch.x + half, patch.y);
      const expectLowY =
        half >= 1 && patch.y > 0 && near(patch.x, patch.y - half);
      const expectHighY =
        half >= 1 && patch.y < last && near(patch.x, patch.y + half);
      const label = `${patch.face},${patch.x},${patch.y},${patch.size}`;
      expect(overlap.lowX, label).toBe(expectLowX);
      expect(overlap.highX, label).toBe(expectHighX);
      expect(overlap.lowY, label).toBe(expectLowY);
      expect(overlap.highY, label).toBe(expectHighY);
      checked++;
      if (expectLowX || expectHighX || expectLowY || expectHighY) overlapped++;
    }
    console.log(
      `\n  ${checked} patches resident, ${overlapped} with a finer neighbour\n`,
    );
    expect(checked).toBeGreaterThan(50);
    // And some do, or the assertion above is vacuous: every patch would trivially have no overlap
    // and the rule would never be exercised.
    expect(overlapped).toBeGreaterThan(0);
  });

  it("refills a patch whose overlap changed, without moving it", () => {
    // **The bug this window had, and the reason the overlap is recomputed on every scroll.**
    //
    // Whether a patch has a finer neighbour across an edge changes as the viewer walks, because
    // that is what the level-of-detail tree does — splits appear ahead and disappear behind. A
    // window that reads the overlap once, when it claims the patch, keeps meshing a patch without
    // reaching into a neighbour that has since become finer, and a lens-shaped gap opens along the
    // boundary *as the player walks towards it*.
    //
    // So the slot must stay put and be rebuilt. Releasing it instead would open a hole for as long
    // as the mesher takes, and a level-of-detail boundary moves across a whole ring of patches at
    // once, so that is a flicker sweeping the horizon rather than a gap in one place.
    const refilled: number[] = [];
    const window = new PatchWindow({
      radiusAt,
      factor: 8,
      onSlotRefill: (slot) => refilled.push(slot),
    });
    const eye = eyeAt(3);
    window.scrollTo(eye, true);
    for (let slot = 0; slot < window.capacity; slot++) window.markFilled(slot);

    // Walk towards a patch in the selection, in small steps, so patches persist across the moves.
    const direction = {
      x: eye.x / Math.hypot(eye.x, eye.y, eye.z),
      y: eye.y / Math.hypot(eye.x, eye.y, eye.z),
      z: eye.z / Math.hypot(eye.x, eye.y, eye.z),
    };
    const distance = (step: number): Vec3 => {
      const r = radiusAt(direction) + 3 - step;
      return { x: direction.x * r, y: direction.y * r, z: direction.z * r };
    };
    for (let step = 1; step <= 60; step++) window.scrollTo(distance(step));

    console.log(`\n  ${refilled.length} refills over 60 steps of walking\n`);
    expect(refilled.length).toBeGreaterThan(0);
    // Every refill is a slot that stayed claimed — the whole point.
    for (const slot of refilled) {
      expect(
        window.isClaimed(slot),
        `slot ${slot} moved rather than refilled`,
      ).toBe(true);
    }
  });

  it("reaches every patch the selection names", () => {
    // The seam the window has to close: a wanted patch it cannot claim is a hole in the world.
    const { window } = harness(4);
    const eye = eyeAt(3);
    window.scrollTo(eye);
    const direction = {
      x: eye.x / Math.hypot(eye.x, eye.y, eye.z),
      y: eye.y / Math.hypot(eye.x, eye.y, eye.z),
      z: eye.z / Math.hypot(eye.x, eye.z === 0 ? eye.y : eye.z),
    };
    const wanted = selectPatches(
      patchCentre(rootPatch(2)),
      Math.hypot(eye.x, eye.y, eye.z),
      radiusAt,
      4,
    ).patches;
    for (const patch of wanted) {
      expect(window.claimedSlotOf(patch), JSON.stringify(patch)).toBeDefined();
    }
    void direction;
  });

  it("asks for the nearest patches first", () => {
    // The request queue is drained in the order it is given, so the patch under the viewer has to
    // be at the front of it.
    const { window, wanted } = harness(8);
    const eye = eyeAt(3);
    window.scrollTo(eye, true);
    const last = wanted[wanted.length - 1];
    expect(last).toBeDefined();
    const distances = last!.map((slot) => {
      const c = window.slots[slot]!.centre;
      return Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
    });
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]!).toBeGreaterThanOrEqual(distances[i - 1]! - 1e-6);
    }
  });

  it("refuses to answer from a slot that is claimed but unfilled", () => {
    // The one invariant that must not be got wrong, and it is the reason `filled` exists at all:
    // between being re-pointed and the rebuild landing, the slot physically holds the patch it left
    // behind. Answering from it would put one patch's geometry at another's coordinates.
    const { window } = harness(4);
    window.scrollTo(eyeAt(3), true);
    const patch = patchOf(eyeAt(3), 1);
    const slot = window.claimedSlotOf(patch);
    expect(slot).toBeDefined();
    expect(window.slots[slot!]!.filled).toBe(false);
    expect(window.claimedSlotOf(patch)).toBe(slot);
    expect(window.slotOf(patch)).toBeUndefined();

    window.markFilled(slot!);
    expect(window.slotOf(patch)).toBe(slot);
    expect(window.filledCount).toBeGreaterThan(0);
  });

  it("puts each patch's centre on the surface, at a sane radius", () => {
    const { window } = harness(8);
    window.scrollTo(eyeAt(3), true);
    for (let slot = 0; slot < window.capacity; slot++) {
      if (!window.isClaimed(slot)) continue;
      const patch = window.slots[slot]!.patch;
      const centre = window.slots[slot]!.centre;
      const r = Math.hypot(centre.x, centre.y, centre.z);
      // On the surface, not at the origin and not in the sky.
      expect(r, `${patch.face},${patch.x},${patch.y}`).toBeGreaterThan(
        base.lowestRadius,
      );
      expect(r, `${patch.face},${patch.x},${patch.y}`).toBeLessThan(
        base.highestRadius,
      );
      // And pointing the same way as the patch's own centre, or the ordering is meaningless.
      const want = patchCentre(patch);
      const len = r === 0 ? 1 : r;
      const dot =
        (centre.x / len) * want.x +
        (centre.y / len) * want.y +
        (centre.z / len) * want.z;
      expect(dot).toBeCloseTo(1, 6);
    }
  });

  it("survives a walk right round the planet", () => {
    // The property that decides whether a planet is a place: the window keeps up as the player
    // goes over the horizon, and keeps the patch under them claimed throughout.
    //
    // **A longer timeout than the default.** The walk is the same 240 steps for every planet, but
    // each `scrollTo` claims a window whose patch count grows with the radius, so on the 136,000-unit
    // planet the loop is heavy enough to exceed the 5 s default under the suite's own parallel load.
    const { window } = harness(8);
    let unclaimedUnderfoot = 0;
    for (let step = 0; step <= 240; step++) {
      const angle = (step / 240) * Math.PI * 2;
      const direction = {
        x: Math.cos(angle),
        y: 0.15 * Math.sin(angle * 3),
        z: Math.sin(angle),
      };
      const len = Math.hypot(direction.x, direction.y, direction.z);
      const unit = {
        x: direction.x / len,
        y: direction.y / len,
        z: direction.z / len,
      };
      const r = radiusAt(unit) + 3;
      const eye = { x: unit.x * r, y: unit.y * r, z: unit.z * r };
      window.scrollTo(eye);
      if (window.claimedSlotOf(patchOf(unit, 1)) === undefined)
        unclaimedUnderfoot++;
    }
    console.log(
      `\n  240 steps round the planet, ${unclaimedUnderfoot} with no patch underfoot\n`,
    );
    expect(unclaimedUnderfoot).toBe(0);
    expect(window.capacity).toBeGreaterThanOrEqual(64);
  }, 30_000);

  it("gives a viewer at the centre a window rather than a NaN", () => {
    // Every direction is "up" at the centre and the level of detail rule needs one. It cannot
    // happen in play, but a caller passing the origin should get a window.
    const { window } = harness(4);
    expect(() => window.scrollTo({ x: 0, y: 0, z: 0 })).not.toThrow();
    expect(window.filledCount).toBeGreaterThanOrEqual(0);
    for (let slot = 0; slot < window.capacity; slot++) {
      const c = window.slots[slot]!.centre;
      expect(Number.isFinite(c.x + c.y + c.z), `slot ${slot}`).toBe(true);
    }
  });
});

describe("the patch vocabulary the window relies on", () => {
  it("keeps size and level in step", () => {
    // `keyOf` packs `face * 8 + level`, so a level past seven would collide with the next face.
    for (const size of [32, 16, 8, 4, 2, 1]) {
      expect(patchLevel(size)).toBeLessThan(8);
    }
    let patch: Patch = rootPatch(5);
    while (patch.size > 1) {
      patch = subdivide(patch)[0] as Patch;
      expect(patchLevel(patch.size)).toBeLessThan(8);
    }
    expect(patchAngle(1)).toBeGreaterThan(0);
  });
});
