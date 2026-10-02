/**
 * A row of lanterns, lit one at a time by a timer.
 *
 * The thing worth seeing is `after`, and specifically the rule that matters: **setting an id
 * that is already pending does nothing.** So the obvious pattern works —
 *
 * ```ts
 * if (!lit.has(next)) after("next", 400);
 * ```
 *
 * — and arms once and fires once, rather than re-arming itself before it could ever come due.
 * The first version of the host replaced instead, and this place silently never lit a lantern
 * at all. ADR 0019 has the measurement.
 *
 * It also shows the thing a place cannot do yet: there is no way to *turn a light off* again,
 * because v1's vocabulary has geometry and zones but no lights. Each lantern is therefore a
 * shape that appears and stays, which is what a smooth-landscape engine can honestly offer.
 */

import { createShape, log, after, onTick } from "voxelscape";

/** How many, how far apart, and where. */
const COUNT = 8;
const SPACING = 60;
const FIRST_X = -((COUNT - 1) * SPACING) / 2;
const GROUND_Y = 30;
const EVERY_MS = 400;

const box = (
  id: string,
  at: readonly [number, number, number],
  len: { readonly x: number; readonly y: number; readonly z: number },
  colour?: { readonly r: number; readonly g: number; readonly b: number },
): void => {
  createShape({
    place: "lanterns",
    id,
    at,
    shape: { type: "Box", len },
    combine: "Add",
    ...(colour === undefined ? {} : { colour }),
  });
};

/** Which lanterns are lit, so a script does not build one twice. */
const lit = new Set<string>();

/** The next one to light, or undefined when they are all lit. */
const nextIndex = (): number | undefined => {
  for (let i = 0; i < COUNT; i++) {
    if (!lit.has(`lantern-${i}`)) return i;
  }
  return undefined;
};

onTick((info) => {
  for (const event of info.events) {
    if (event.kind !== "timer") continue;
    // Armed with the *next index in the id*, so the host's sorted fire order is also the order
    // a person would expect: lantern-0 before lantern-1 before lantern-10.
    const wanted = event.timerId;
    const index = Number(wanted.replace("lantern-", ""));
    if (lit.has(wanted)) continue;
    lit.add(wanted);

    const x = FIRST_X + index * SPACING;
    box(
      wanted,
      [x, GROUND_Y, 0],
      { x: 2, y: 3, z: 2 },
      { r: 255, g: 214, b: 140 },
    );
    // A plinth under each one, so a lantern is standing on something rather than floating.
    box(`plinth-${wanted}`, [x, GROUND_Y - 8, 0], { x: 4, y: 5, z: 4 });
    log(`lit ${wanted}`);

    const next = nextIndex();
    if (next !== undefined) after(`lantern-${next}`, EVERY_MS);
    else log("every lantern is lit");
  }
});

// Arm the first one. A timer is the only way anything is deferred — there are no promises in a
// place (ADR 0015) — so this is the whole of how the row starts lighting.
after("lantern-0", 600);
