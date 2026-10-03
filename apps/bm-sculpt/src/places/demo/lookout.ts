/**
 * A platform high above the ground, with the camera pointed at it and the player moved there.
 *
 * The three things a place can ask for that are *not* geometry, and which are therefore the
 * ones most worth seeing: `movePlayer`, `setTime` and `lookAt`. A place that can only build
 * shapes is a diorama; these are what turn it into somewhere.
 *
 * **`setTime` is the one to watch.** The clock is not this place's — it is the application's,
 * the same object `/clock:` moves — so a place setting the hour is the same value a person sees
 * in the console. That is deliberate and it is the opposite of a host holding a clock of its
 * own, which would be a second answer to "what hour is it".
 */

import {
  createShape,
  log,
  lookAt,
  movePlayer,
  onTick,
  setTime,
} from "voxelscape";

/** Where the platform is, and where a player standing on it would be. */
const CENTRE: readonly [number, number, number] = [0, 90, -160];
const HALF = 24;

const box = (
  id: string,
  at: readonly [number, number, number],
  len: { readonly x: number; readonly y: number; readonly z: number },
  combine: "Add" | "Subtract" = "Add",
): void => {
  createShape({
    place: "lookout",
    id,
    at,
    shape: { type: "Box", len },
    combine,
  });
};

// A round platform: a slab, and four slabs rotated into the corners of a circle over it. A
// smooth-landscape engine has no cylinder primitive, and a box union is the honest way to
// approximate one — which is also worth seeing, because the blend is what the field is for.
box("slab", CENTRE, { x: HALF, y: 1.5, z: HALF });
box("step-north", [CENTRE[0], CENTRE[1], CENTRE[2] - HALF], {
  x: 6,
  y: 1.5,
  z: 6,
});
box("step-south", [CENTRE[0], CENTRE[1], CENTRE[2] + HALF], {
  x: 6,
  y: 1.5,
  z: 6,
});
box("step-east", [CENTRE[0] + HALF, CENTRE[1], CENTRE[2]], {
  x: 6,
  y: 1.5,
  z: 6,
});
box("step-west", [CENTRE[0] - HALF, CENTRE[1], CENTRE[2]], {
  x: 6,
  y: 1.5,
  z: 6,
});

// A mast in the middle, and a gap cut in the rail to stand in.
box("mast", [CENTRE[0], CENTRE[1] + 16, CENTRE[2]], { x: 1, y: 16, z: 1 });
box("rail-north", [CENTRE[0], CENTRE[1] + 4, CENTRE[2] - HALF], {
  x: HALF,
  y: 2.5,
  z: 0.4,
});
box("rail-south", [CENTRE[0], CENTRE[1] + 4, CENTRE[2] + HALF], {
  x: HALF,
  y: 2.5,
  z: 0.4,
});
box("rail-east", [CENTRE[0] + HALF, CENTRE[1] + 4, CENTRE[2]], {
  x: 0.4,
  y: 2.5,
  z: HALF,
});

// Put the player on it. A place that builds somewhere and leaves you on the ground has built
// a thing you would have to go and find; this one does not.
movePlayer(CENTRE[0], CENTRE[1] + 6, CENTRE[2]);

// And the camera at it, so it is on screen rather than behind you.
lookAt(CENTRE[0], CENTRE[1] + 4, CENTRE[2], 65);

// Mid-afternoon, through the *application's* clock.
setTime(300);

log("the lookout is built — look up");

onTick(() => {
  // Nothing per frame. A tick that does nothing is still a tick, and it is here to show that
  // registering one is free: the host skips a step with no events and no timers.
});
