/**
 * The places this build ships with.
 *
 * ## Why they are here at all
 *
 * A place's on-disk form — a zip with a manifest — is a later phase, and until then the only
 * way to load one is to have it in the tree. That is worth doing for two reasons beyond
 * convenience: it is the only way to *see* the whole stack working end to end in a browser
 * before anything is on disk, and a built-in place is something to point the reference
 * implementation at while the two are still being brought into agreement.
 *
 * ## A demo is more than one file, where it should be
 *
 * `bridge` ships as `main.ts` plus `span.ts`, because a place is a bundle and a single-file
 * demo would only ever demonstrate the case that needs no bundler. That one import is the
 * whole of the multi-file path: the bundler rewrites `./span` to a module id, and the
 * interpreter requires it the ordinary way.
 *
 * ## They are `?raw`, so they are type-checked and bundled
 *
 * **A place's source is TypeScript that the compiler sees**, the same as the guest library —
 * which is the point of ADR 0018 and the reason these are `.ts` files rather than strings. A
 * demo that does not compile is a failing demo rather than a broken example, and a typo in an
 * effect's field name is caught here rather than at runtime by a refusal.
 *
 * `import … ?raw` rather than a `Record<string, string>` literal, so the source is the file and
 * the file is the source. There is no second copy to drift.
 *
 * ## What they are not
 *
 * Not a showcase. Each is small enough to read in one sitting and does one thing, because a
 * demo that does four things demonstrates none of them — the same argument
 * `csg/cost.test.ts` makes about asserting a *change* rather than a number.
 */

import BRIDGE_SOURCE from "./demo/bridge.ts?raw";
import SPAN_SOURCE from "./demo/span.ts?raw";
import LANTERN_SOURCE from "./demo/lanterns.ts?raw";
import LOOKOUT_SOURCE from "./demo/lookout.ts?raw";
import CONVEYOR_SOURCE from "./demo/conveyor.ts?raw";

/** One of the places this build ships. */
export interface DemoPlace {
  readonly id: string;
  /** What it does, in a phrase, for the console's list. */
  readonly summary: string;
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
}

/**
 * Every demo, in the order `/place:list` shows them.
 *
 * **Ids are names, not indices**, so a console command naming one keeps working when a demo is
 * added or removed around it.
 */
export const DEMO_PLACES: readonly DemoPlace[] = [
  {
    id: "bridge",
    summary:
      "a bridge in two files, with a doorway and a zone that notices you arriving",
    files: { "main.ts": BRIDGE_SOURCE, "span.ts": SPAN_SOURCE },
    entry: "main.ts",
  },
  {
    id: "lanterns",
    summary:
      "a row of real lights, and a timer that turns them on one at a time",
    files: { "main.ts": LANTERN_SOURCE },
    entry: "main.ts",
  },
  {
    id: "conveyor",
    summary:
      "a belt you can stand on and be carried by, and quicksand beside it",
    files: { "main.ts": CONVEYOR_SOURCE },
    entry: "main.ts",
  },
  {
    id: "lookout",
    summary: "a platform above the ground, and the camera pointed at it",
    files: { "main.ts": LOOKOUT_SOURCE },
    entry: "main.ts",
  },
];

/** The demo with that id, or undefined. */
export const demoPlace = (id: string): DemoPlace | undefined =>
  DEMO_PLACES.find((demo) => demo.id === id);

/**
 * The demo ids, for a console command's completion.
 *
 * Read from `DEMO_PLACES` rather than written out, so adding a demo makes it completable with
 * nothing else to remember.
 */
export const demoIds = (): readonly string[] =>
  DEMO_PLACES.map((demo) => demo.id);
