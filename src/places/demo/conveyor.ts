/**
 * Two fields the player can feel, and nothing else to look at.
 *
 * ## What is worth seeing
 *
 * **A field is the first effect that moves the player rather than the world.** Everything else in
 * this vocabulary — shapes, zones, lights, the clock — changes what is *there*. A `createMedium`
 * changes what the player *does*, through physics that was written before this vocabulary existed:
 * `PlayerWorld.getMediumAt` has been declared in `player.ts` since the beginning and
 * `updatePlayer` has consumed it all along, with nothing on the other end of it. This demo is that
 * other end.
 *
 * - **`pushVz` without `speedScale` is a conveyor**: the player walks on it and is carried by it,
 *   and their own input is added on top rather than replaced. Walking against a belt does not
 *   fail to move you; it moves you more slowly, which is what a belt is.
 * - **`speedScale: 0` with a `sink` is quicksand**: not pushed anywhere, but walked at a quarter
 *   of the player's own speed and held down.
 * - **The two are the same effect with different numbers**, and that is the point of the shape. A
 *   separate "quicksand" tag would have been a second way to say `speedScale` and would have had
 *   to be kept in step with it.
 *
 * Nothing is drawn to mark either field. There is no overlay for them — zones have one and lights
 * do not need one — so the demonstration is that the only way to find out where a belt is, is to
 * walk onto it.
 */

import { createMedium, createShape, log, onTick } from "voxelscape";

/** The belt: long in z, thin in y, so it reads as a floor rather than a room. */
const BELT = {
  min: [-30, 0, -80] as const,
  max: [30, 2, 80] as const,
};

/** The quicksand, off to one side and low enough to fall into. */
const QUICKSAND = {
  min: [60, -6, -40] as const,
  max: [140, 2, 40] as const,
};

/** A deck to stand on while the fields are being made, and to see them from. */
const platform = (
  id: string,
  at: readonly [number, number, number],
  len: number,
): void => {
  createShape({
    place: "conveyor",
    id,
    at,
    shape: { type: "Box", len: { x: len, y: 0.5, z: len } },
    combine: "Add",
  });
};

// The belt. `pushVz: 60` is exactly a walking player's own speed, so standing still on it carries
// you at walking pace and walking on it carries you at double — which is the clearest way to see
// that the two add up.
createMedium({
  id: "belt",
  box: [
    [BELT.min[0], BELT.min[1], BELT.min[2]],
    [BELT.max[0], BELT.max[1], BELT.max[2]],
  ],
  pushVx: 0,
  pushVz: 60,
  // **`speedScale: 1` is stated rather than omitted.** This library requires it, which is worth
  // knowing: a field that pushes somewhere and also says nothing about walking is not a thing that
  // can be written by accident here.
  speedScale: 1,
});

// Quicksand. No push on either horizontal axis — it is not a conveyor that happens to be sticky —
// and a sink of 8 units a second, which is slow enough to walk out of and fast enough to notice.
createMedium({
  id: "quicksand",
  box: [
    [QUICKSAND.min[0], QUICKSAND.min[1], QUICKSAND.min[2]],
    [QUICKSAND.max[0], QUICKSAND.max[1], QUICKSAND.max[2]],
  ],
  pushVx: 0,
  pushVz: 0,
  speedScale: 0.25,
  sink: 8,
});

// Somewhere to watch it from, and something solid under the belt so the conveyor has a floor to
// push along rather than being a slab in mid-air.
platform("belt-floor", [0, -1, 0], 30);
platform("quicksand-floor", [100, -7, 0], 40);

onTick((info) => {
  for (const event of info.events) {
    // **Reading the field back is the other half of the demonstration.** The physics already
    // asks the same question the guest library does, so a script that asks it itself sees the same
    // answer — and a place whose belt works but whose belt cannot be found is the kind of thing
    // this is here to rule out.
    if (event.kind === "zone-entered") log(`walked into ${event.zoneId}`);
    if (event.kind === "zone-left") log(`left ${event.zoneId}`);
  }
  log("fields: belt and quicksand. Walk onto one.");
});
