/**
 * A bridge across a dip in the ground, with a doorway and a zone that notices you arriving.
 *
 * Two things worth seeing here, and the reason this is the first demo:
 *
 * - **A zone is the only reactivity there is.** There are no entities in this build, so a
 *   place's way of noticing anything is a box the player walks into — and it is drawn, so you
 *   can see where it is.
 * - **The geometry is in another file.** `./span` is bundled as a module of its own, so this
 *   one is about reacting to the player rather than about boxes.
 *
 * `createShape`, `len` as a half-extent, and the add-then-subtract doorway are all in
 * `span.ts`, where they are described.
 */

import { createZone, log, onTick } from "voxelscape";

import { buildSpan, DECK_Y, WIDTH } from "./span";

// The place reacts, which is the only way a person can tell it is alive.
onTick((info) => {
  for (const event of info.events) {
    if (event.kind === "zone-entered") log(`arrived at ${event.zoneId}`);
    if (event.kind === "zone-left") log(`left ${event.zoneId}`);
  }
});

// The bridge itself. Its shapes are in `./span`, so this file's fold order is: nothing of its
// own, and then whatever `span` made — which is the point of the order being the call order.
buildSpan();

// The zone: ten either side of the gate, tall enough to catch a player standing on the deck.
createZone({
  id: "gate",
  label: "the gate",
  box: [
    [-10, DECK_Y, -(WIDTH + 2)],
    [10, DECK_Y + 14, WIDTH + 2],
  ],
});
