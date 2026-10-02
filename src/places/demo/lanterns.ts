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
 * Each lantern is a **real light** — `createLight`, not a coloured box — so it goes out when the
 * timer that lit it is answered, and the row can be rebuilt from nothing by loading it again.
 * The plinths are still geometry, because a lantern with nothing to stand on is a lantern
 * floating in the air.
 *
 * ## The one number worth reading twice
 *
 * `radius` and `intensity` are not independent, and the documentation says so twice because it is
 * the thing a place author gets wrong: the falloff is scaled so that `intensity` is the brightness
 * **at the edge of its own radius**. A lantern of radius 90 at intensity 1 is as bright at 90 units
 * as one of radius 20 is at 20 — neither bright in the middle, because a lamp is hottest at its own
 * centre. So `radius` is how far it reaches and `intensity` is how bright it is where it stops.
 */

import { createLight, createShape, log, after, onTick } from "voxelscape";

/** How many, how far apart, and where. */
const COUNT = 8;
const SPACING = 60;
const FIRST_X = -((COUNT - 1) * SPACING) / 2;
const GROUND_Y = 30;
const EVERY_MS = 400;

/** How far each lantern reaches, and how bright it is where it stops. */
const RADIUS = 90;
const INTENSITY = 1;

/**
 * The light itself.
 *
 * **Separate from the plinth because they have opposite fates.** The plinth is geometry and
 * appears once and stays; the light appears and can be taken away again, which is the thing this
 * demo exists to show. Keeping them apart also keeps the id namespace honest — a shape and a light
 * are different kinds of object, and they only share the table they are keyed in.
 */
const lamp = (id: string, at: readonly [number, number, number]): void => {
  createLight({
    id,
    at,
    colour: { r: 255, g: 214, b: 140 },
    radius: RADIUS,
    intensity: INTENSITY,
  });
};

const box = (
  id: string,
  at: readonly [number, number, number],
  len: { readonly x: number; readonly y: number; readonly z: number },
): void => {
  createShape({
    place: "lanterns",
    id,
    at,
    shape: { type: "Box", len },
    combine: "Add",
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
    lamp(wanted, [x, GROUND_Y, 0]);
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
