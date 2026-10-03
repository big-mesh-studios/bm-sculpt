/**
 * The bridge's geometry, split into its own file so `main.ts` can be about behaviour.
 *
 * ## Why a demo has two files
 *
 * **A place is a bundle, not a script.** `main.ts` imports `./span` and the bundler rewrites
 * that to a module id, which is the same machinery a real place with a dozen files uses — so
 * this demo exercises it rather than the one-file case it would otherwise demonstrate. The
 * import is written the ordinary way, `./span`, because that is what a person would write.
 *
 * It is also the honest shape for this particular place: everything below is geometry, and a
 * file called `main.ts` that is entirely `createShape` calls is a file whose name is a lie.
 */

import { createShape } from "voxelscape";

/** Where the bridge is and how big. Half-extents, so the deck is 400 units across. */
export const SPAN = 200;
export const DECK_Y = 24;
export const WIDTH = 10;

/**
 * Adds one box to the place.
 *
 * Written once so every number below says what it means, and so `combine` and `colour` are
 * visible at the top of each call rather than hidden inside a literal.
 */
const box = (
  id: string,
  at: readonly [number, number, number],
  len: { readonly x: number; readonly y: number; readonly z: number },
  combine: "Add" | "Subtract" | "Paint" = "Add",
  colour?: { readonly r: number; readonly g: number; readonly b: number },
): void => {
  createShape({
    place: "bridge",
    id,
    at,
    // Half-extents, so `len: { x: 4 }` is eight units across. This is in the
    // guest library's docs too; it is here because it is the thing a person gets
    // wrong first.
    shape: { type: "Box", len },
    combine,
    ...(colour === undefined ? {} : { colour }),
  });
};

/**
 * Builds the whole span.
 *
 * A function rather than top-level statements because **the fold order is the call order**: a
 * module's statements run in the order they are written, so building in a function called
 * once is the same thing — and it says "this runs once, now" rather than leaving it to be
 * inferred from the absence of a loop.
 */
export const buildSpan = (): void => {
  // The deck, and the two towers it stands on.
  box("deck", [0, DECK_Y, 0], { x: SPAN, y: 1.5, z: WIDTH });
  box("tower-west", [-SPAN, 0, 0], { x: 4, y: 24, z: WIDTH + 4 });
  box("tower-east", [SPAN, 0, 0], { x: 4, y: 24, z: WIDTH + 4 });

  // A rail along each side, so the deck reads as a bridge rather than a slab.
  box("rail-west", [0, DECK_Y + 4, -WIDTH], { x: SPAN, y: 2.5, z: 0.4 });
  box("rail-east", [0, DECK_Y + 4, WIDTH], { x: SPAN, y: 2.5, z: 0.4 });

  // A wall across the middle…
  box("gate", [0, DECK_Y + 10, 0], { x: 1, y: 9, z: WIDTH });
  // …with a doorway cut out of it. **The same box twice, once added and once taken away**,
  // which is the whole of what `combine` is for: the fold order is what makes this read as a
  // hole rather than a wall in front of one.
  box("gate-door", [0, DECK_Y + 3, 0], { x: 3, y: 3.5, z: 3 }, "Subtract");
  // A lip round the hole, painted rather than shaped — third in the fold and last in paint
  // resolution, so it lands on the surface the subtraction exposed.
  box(
    "gate-door-lip",
    [0, DECK_Y + 3, 0],
    { x: 3.4, y: 3.9, z: 3.4 },
    "Paint",
    {
      r: 255,
      g: 196,
      b: 120,
    },
  );
};
