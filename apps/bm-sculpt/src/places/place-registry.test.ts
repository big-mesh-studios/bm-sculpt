import { describe, expect, it } from "vitest";

import {
  MAX_OPERATIONS_PER_PLACE,
  PlaceRegistry,
  placeOperation,
} from "./place-registry";
import { Field, OperationBVH } from "@big-mesh-studios/csg";
import type { Operation } from "@big-mesh-studios/csg";
import type { Vec3 } from "@big-mesh-studios/core";
import { SculptDocument } from "../edit/document";
import { beginStroke } from "../edit/brush";
import { CHUNK_VOXELS, FIELD_BORDER, VOXEL_SIZE } from "../constants";

/**
 * A place is a named group of operations, and these are the properties that make that
 * claim true rather than merely plausible.
 *
 * The three that matter most, in order: **flatten is the only fold order**
 * (`sculpt.ts` reads the operation list in four places and all four go through it),
 * **a place is not in the history** (so undo cannot delete one by accident), and **two
 * peers building the same place derive the same list** (because the operation list is
 * recomputed on every peer rather than replicated — ADR 0015).
 */

const registryOver = (document: SculptDocument): PlaceRegistry =>
  new PlaceRegistry(document.order);

const boxAt = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/**
 * A box at a position, with a placeholder index — what a *place* is given.
 *
 * `placeOperation` deliberately leaves `index` at zero for `PlaceHandle.add` to
 * overwrite, so this value must never reach the fold directly.
 */
const aBox = (at: Vec3): ReturnType<typeof placeOperation> =>
  placeOperation(at, { type: "Box", len: { x: 40, y: 40, z: 40 } }, "Add");

/**
 * Hands out ids for shapes as they are added, so a test that says "add a shape" does not
 * also have to invent a name for it — and so a test that cares about ids asks for one.
 */
const shapeIds = (): ((at?: Vec3) => string) => {
  let next = 0;
  return () => `s${next++}`;
};

/** A box with a real index, for the document — what a *stroke* is given. */
const aDocumentBox = (
  document: SculptDocument,
  at: Vec3,
): ReturnType<typeof placeOperation> => ({
  ...aBox(at),
  index: document.order.allocate(),
});

describe("a place is named", () => {
  it("is found by the name it was created with", () => {
    const registry = registryOver(new SculptDocument());
    const place = registry.create("bridge");

    expect(place.name).toBe("bridge");
    expect(registry.has("bridge")).toBe(true);
    expect(registry.names).toEqual(["bridge"]);
    expect(registry.get("bridge")).toBe(place);
    expect(registry.get("quarry")).toBeUndefined();
  });

  it("is created once, however many times it is asked for", () => {
    // A script that runs its setup on load and again on a re-entry event should not
    // take the place down with it. Second `create` continues the same place rather than
    // making a second one that would fold at the same index.
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const first = registry.create("bridge");
    first.add(ids(), aBox(boxAt(0, 0, 0)));
    const again = registry.create("bridge");

    expect(again.count).toBe(1);
    expect(registry.count).toBe(1);
    expect(registry.operationCount).toBe(1);
  });

  it("takes a name away entirely, and forgets it", () => {
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    registry.create("bridge").add(ids(), aBox(boxAt(0, 0, 0)));

    expect(registry.remove("bridge")).toBe(true);
    expect(registry.has("bridge")).toBe(false);
    expect(registry.operationCount).toBe(0);
    expect(registry.flatten([])).toEqual([]);
    // A second removal is a no-op rather than an error, so a caller cleaning up after
    // a script that already cleaned up after itself does not have to ask first.
    expect(registry.remove("bridge")).toBe(false);
  });

  it("empties a place without taking the name away", () => {
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const place = registry.create("bridge");
    place.add(ids(), aBox(boxAt(0, 0, 0)));
    place.add(ids(), aBox(boxAt(80, 0, 0)));

    expect(registry.clear("bridge")).toBe(true);
    expect(place.count).toBe(0);
    // Still there, so a script holding the handle keeps working.
    expect(registry.has("bridge")).toBe(true);
    expect(place.add(ids(), aBox(boxAt(0, 0, 0)))).toBeDefined();
    expect(place.count).toBe(1);
  });

  it("folds in the order places were created", () => {
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    registry.create("first").add(ids(), aBox(boxAt(10, 0, 0)));
    registry.create("second").add(ids(), aBox(boxAt(20, 0, 0)));
    registry.create("third").add(ids(), aBox(boxAt(30, 0, 0)));

    expect(registry.names).toEqual(["first", "second", "third"]);
    expect(registry.flatten([]).map((op) => op.origin.x)).toEqual([10, 20, 30]);
  });

  it("puts a recreated name last in the fold, not back where it was", () => {
    // Deliberate, and the reason is in `fold-order.ts`: an operation's index must never
    // be reused, so a place cannot go back to a position whose indices its predecessor
    // already spent. Restoring the position would change the surface rather than
    // reproduce it, silently.
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    registry.create("first").add(ids(), aBox(boxAt(10, 0, 0)));
    registry.create("second").add(ids(), aBox(boxAt(20, 0, 0)));
    registry.remove("first");
    registry.create("first").add(ids(), aBox(boxAt(11, 0, 0)));

    expect(registry.names).toEqual(["second", "first"]);
    expect(registry.flatten([]).map((op) => op.origin.x)).toEqual([20, 11]);
  });
});

describe("a shape inside a place is addressed by the id its creator gave it", () => {
  it("finds and removes one, leaving the rest and the fold order alone", () => {
    // What `shape-remove` needs. An operation is otherwise only a position in the fold,
    // and a position is not something a script can still know about a step later.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const place = registry.create("bridge");

    place.add("deck", aBox(boxAt(0, 0, 0)));
    place.add("pier", aBox(boxAt(400, 0, 0)));
    place.add("mast", aBox(boxAt(800, 0, 0)));

    expect(place.ids()).toEqual(["deck", "pier", "mast"]);
    expect(place.remove("pier")).toBe(true);

    expect(place.ids()).toEqual(["deck", "mast"]);
    expect(place.count).toBe(2);
    expect(registry.flatten(document.list).map((op) => op.origin.x)).toEqual([
      0, 800,
    ]);
    // A second removal is a no-op rather than an error, so a script cleaning up after a
    // shape it already removed does not have to ask first.
    expect(place.remove("pier")).toBe(false);
  });

  it("refuses a second shape under an id that is taken", () => {
    // "Last one wins" would be a divergence: two peers could disagree about whether an id
    // means the first shape or the second, and they would fold in different orders.
    const registry = registryOver(new SculptDocument());
    const place = registry.create("bridge");

    expect(place.add("deck", aBox(boxAt(0, 0, 0)))).toBeDefined();
    expect(place.has("deck")).toBe(true);
    expect(place.add("deck", aBox(boxAt(400, 0, 0)))).toBeUndefined();

    // The first one is untouched rather than replaced.
    expect(place.count).toBe(1);
    expect(registry.flatten([]).map((op) => op.origin.x)).toEqual([0]);
  });

  it("keeps the indices around a removal out of reach of reuse", () => {
    // `fold-order.ts` requires an index to increase and never be reused. A removal leaves
    // a hole, which is fine — indices need to increase, not to be contiguous — and the
    // shape added afterwards must not land in the hole.
    const registry = registryOver(new SculptDocument());
    const place = registry.create("bridge");
    place.add("a", aBox(boxAt(0, 0, 0)));
    place.add("b", aBox(boxAt(1, 0, 0)));
    place.add("c", aBox(boxAt(2, 0, 0)));

    place.remove("b");
    const added = place.add("d", aBox(boxAt(3, 0, 0)));

    const indices = registry.flatten([]).map((op) => op.index);
    expect(indices).toEqual([0, 2, 3]);
    expect(added?.index).toBe(3);
    expect(indices).not.toContain(1);
  });

  it("keeps one place's ids out of another's", () => {
    // Ids are scoped to their place, so two places can both have a "deck" — which is what
    // a person writing two similar structures would expect, and what keeps a script from
    // having to invent globally unique names.
    const registry = registryOver(new SculptDocument());
    const bridge = registry.create("bridge");
    const quay = registry.create("quay");

    expect(bridge.add("deck", aBox(boxAt(0, 0, 0)))).toBeDefined();
    expect(quay.add("deck", aBox(boxAt(0, 0, 0)))).toBeDefined();

    bridge.remove("deck");
    expect(bridge.count).toBe(0);
    expect(quay.count).toBe(1);
  });

  it("empties ids as well as operations when a place is cleared", () => {
    // A cleared place that still reported its old ids would let a script remove shapes
    // that are no longer there and think it had succeeded.
    const registry = registryOver(new SculptDocument());
    const place = registry.create("bridge");
    place.add("deck", aBox(boxAt(0, 0, 0)));

    registry.clear("bridge");
    expect(place.ids()).toEqual([]);
    expect(place.bounds).toBeUndefined();
    expect(place.has("deck")).toBe(false);
  });
});

describe("a place is not in the history", () => {
  it("cannot be reached by undo, however much of the document is undone", () => {
    // The reason a place owns its own list rather than being a range in the document's.
    // As a range it would be on the undo stack, and one ctrl-z would either delete the
    // whole place or — worse — be blocked, because the top of the stack is 2000
    // operations the user never made.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    const cube = (at: Vec3) =>
      placeOperation(at, { type: "Box", len: { x: 10, y: 10, z: 10 } }, "Add");

    document.add([cube(boxAt(0, 0, 0))]);
    const place = registry.create("bridge");
    place.add(ids(), aBox(boxAt(0, 0, 0)));

    document.add([cube(boxAt(1, 0, 0))]);

    expect(document.undo()).toBeDefined();
    expect(document.undo()).toBeDefined();
    // The document is empty. The place is not, and is still folded in.
    expect(document.list).toEqual([]);
    expect(place.count).toBe(1);
    expect(registry.flatten(document.list)).toHaveLength(1);
  });

  it("survives the document being reset underneath it", () => {
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    const place = registry.create("bridge");
    place.add(ids(), aBox(boxAt(0, 0, 0)));
    place.add(ids(), aBox(boxAt(80, 0, 0)));

    document.clear();
    expect(registry.flatten(document.list)).toHaveLength(2);
  });
});

describe("flatten is the only fold order", () => {
  it("interleaves a place with the document rather than putting all of one first", () => {
    // **The regression this records.** `flatten` used to concatenate document-then-places,
    // which looked right until a place kept building: it then sat at the end of the list
    // holding indices above the document's later ones, so the field folded
    // chronologically (`bvh.ts` sorts candidates by index) while `bvh.evalPaint`
    // settled colour by list order. The two orders disagreed, and a user painting
    // over a script's painted wall lost because the script's operations came later in
    // the list despite having been made first.
    //
    // **List order is still what settles colour between coincident surfaces**, which is what
    // the next test is about: `evalPaint` now gives it to whichever surface is *nearest*, and
    // only a tie falls to the order.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    const quarry = registry.create("quarry");

    document.add([aDocumentBox(document, boxAt(0, 0, 0))]);
    quarry.add(ids(), aBox(boxAt(1, 0, 0)));
    document.add([aDocumentBox(document, boxAt(2, 0, 0))]);
    quarry.add(ids(), aBox(boxAt(3, 0, 0)));

    // Chronological: the document's second operation was made after the place's first,
    // and folds after it.
    expect(registry.flatten(document.list).map((op) => op.origin.x)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("resolves paint in fold order, so a later operation wins even across owners", () => {
    // The claim above, made to discriminate.
    //
    // **The two paints are coincident**, which is what makes list order decide anything:
    // `evalPaint` gives a colour to the nearest surface and settles a tie by order, and two
    // boxes at the same place with the same size are as near as each other can be. So
    // whichever colour survives is a direct read-out of the order `flatten` returned.
    //
    // Set up so the two orders give opposite answers: the place paints red first and the
    // document paints blue second, so index order says blue wins, while a
    // document-then-places concatenation would put blue *first* in the list and let red
    // win instead. Asserting blue is therefore the assertion that flatten sorts.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    const paint = (at: Vec3, colour: { r: number; g: number; b: number }) =>
      placeOperation(
        at,
        { type: "Box", len: { x: 60, y: 60, z: 60 } },
        "Paint",
        {
          colour,
        },
      );

    const quarry = registry.create("quarry");
    quarry.add(ids(), paint(boxAt(0, 0, 0), { r: 200, g: 0, b: 0 }));
    document.add([
      {
        ...paint(boxAt(0, 0, 0), { r: 0, g: 0, b: 200 }),
        index: document.order.allocate(),
      },
    ]);

    const field = new Field(new OperationBVH(registry.flatten(document.list)));

    // The document's blue was made second, so it is last in the fold and wins.
    // A colour and an opacity now, rather than a colour alone: an operation's colour
    // decides the surface colour wherever the operation is, and its opacity travels
    // with it so that a reader is not asked a second time.
    expect(field.colourAt(0, 0, 0)).toEqual({
      colour: { r: 0, g: 0, b: 200 },
      opacity: 1,
    });
  });

  it("puts the document first and places after it in the list it returns", () => {
    // The layout, which is what makes equal indices resolve deterministically rather
    // than being an accident. It is *not* the fold order — see the interleaving test
    // above, which is what it looks like when a place keeps building.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    document.add([
      aDocumentBox(document, boxAt(1, 0, 0)),
      aDocumentBox(document, boxAt(2, 0, 0)),
    ]);
    registry.create("a").add(ids(), aBox(boxAt(3, 0, 0)));
    registry.create("b").add(ids(), aBox(boxAt(4, 0, 0)));

    expect(registry.flatten(document.list).map((op) => op.origin.x)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("yields indices that strictly increase, which is what the fold needs", () => {
    // `src/csg/bvh.ts` sorts candidates by `index` with the comment "List order, which
    // is the order the fold has to run in", because `foldOperations` combines with a
    // smooth minimum: symmetric, not associative. An index repeated anywhere in this
    // list would put two operations into the fold in an order nothing asked for, and
    // change the surface. This is the assertion that makes the counter in `fold-order`
    // load-bearing rather than tidy.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    document.add([
      aDocumentBox(document, boxAt(0, 0, 0)),
      aDocumentBox(document, boxAt(1, 0, 0)),
    ]);
    const a = registry.create("a");
    a.add(ids(), aBox(boxAt(2, 0, 0)));
    a.add(ids(), aBox(boxAt(3, 0, 0)));
    document.add([aDocumentBox(document, boxAt(4, 0, 0))]);
    registry.create("b").add(ids(), aBox(boxAt(5, 0, 0)));
    a.add(ids(), aBox(boxAt(6, 0, 0)));

    const indices = registry.flatten(document.list).map((op) => op.index);
    expect(indices).toHaveLength(7);
    for (let i = 1; i < indices.length; i++) {
      expect(
        indices[i],
        `index ${i} must exceed index ${i - 1}`,
      ).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("keeps a real brush stroke from colliding with a place", () => {
    // The failure this exists to prevent, through the actual production path rather than
    // a stand-in: a stroke taking `document.count` as its base while a place already
    // holds indices above that length, so the two hand out the same numbers. It is
    // invisible in review and the surface is quietly wrong — two operations folded in
    // an order nobody asked for.
    //
    // The stroke interleaves with the place deliberately, because that is the case
    // `document.count` could not survive: after the place's first shape the document's
    // length is 1 while the place holds index 0.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const ids = shapeIds();
    const quarry = registry.create("quarry");

    const firstStroke = beginStroke(document);
    firstStroke.dab(boxAt(0, 0, 0));
    quarry.add(ids(), aBox(boxAt(400, 0, 0)));

    const secondStroke = beginStroke(document);
    secondStroke.dab(boxAt(400, 0, 0));
    quarry.add(ids(), aBox(boxAt(800, 0, 0)));
    firstStroke.end();
    secondStroke.end();

    const indices = registry.flatten(document.list).map((op) => op.index);
    expect(indices).toHaveLength(4);
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("returns the document's own list unchanged when there are no places", () => {
    // The cost the editor and the game pay for the registry existing at all.
    const document = new SculptDocument();
    document.add([
      aDocumentBox(document, boxAt(0, 0, 0)),
      aDocumentBox(document, boxAt(1, 0, 0)),
    ]);
    expect(registryOver(document).flatten(document.list)).toEqual(
      document.list,
    );
  });
});

describe("two peers building the same place derive the same list", () => {
  it("produces identical operations from the same calls in the same order", () => {
    // The property the whole multiplayer model rests on, at the smallest scale it can
    // be checked. Every peer runs every place and *derives* the operation list rather
    // than receiving it, so anything derived from it — indices included — has to come
    // out identical or two peers' worlds diverge with nothing on screen to say so.
    const build = (): string => {
      const document = new SculptDocument();
      const registry = registryOver(document);
      const ids = shapeIds();
      const bridge = registry.create("bridge");
      for (let i = 0; i < 12; i++) bridge.add(ids(), aBox(boxAt(i * 40, 0, 0)));
      const lanterns = registry.create("lanterns");
      for (let i = 0; i < 7; i++)
        lanterns.add(ids(), aBox(boxAt(0, 40 * i, 0)));
      return JSON.stringify(registry.flatten(document.list));
    };

    expect(build()).toBe(build());
  });

  it("assigns the same index to the same call whichever order two places are made in", () => {
    // Two places created in opposite orders are two different worlds, and that is
    // correct rather than surprising: the fold order *is* creation order. What has to
    // hold is that each place's own indices do not depend on the other, so a peer that
    // created them in the same order as everyone else agrees.
    const build = (): number[] => {
      const document = new SculptDocument();
      const registry = registryOver(document);
      const ids = shapeIds();
      const quarry = registry.create("quarry");
      const first = registry.create("first");
      quarry.add(ids(), aBox(boxAt(0, 0, 0)));
      first.add(ids(), aBox(boxAt(0, 0, 0)));
      return registry.flatten(document.list).map((op) => op.index);
    };
    expect(build()).toEqual([0, 1]);
  });

  it("overwrites an index the caller tried to supply", () => {
    // A caller-supplied index is how two peers end up folding a shape in different
    // orders: the guest is not a trusted source of the one number the fold depends on.
    const document = new SculptDocument();
    const registry = registryOver(document);
    const place = registry.create("bridge");
    const added = place.add("bridge-deck", {
      ...aBox(boxAt(0, 0, 0)),
      index: 9999,
    });
    expect(added?.index).toBe(0);
    expect(place.ids()).toEqual(["bridge-deck"]);
  });
});

describe("a place refuses to grow past the measurement", () => {
  it("stops at the limit and says so, rather than growing or failing quietly", () => {
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const place = registry.create("bridge");

    for (let i = 0; i < MAX_OPERATIONS_PER_PLACE; i++) {
      expect(
        place.add(ids(), aBox(boxAt(i, 0, 0))),
        `operation ${i}`,
      ).toBeDefined();
    }
    expect(place.full).toBe(true);

    // Refused, not truncated and not thrown: a script with a bug in it gets an error a
    // person can read, and the place keeps the 2000 operations it legitimately built.
    expect(place.add(ids(), aBox(boxAt(0, 0, 0)))).toBeUndefined();
    expect(place.count).toBe(MAX_OPERATIONS_PER_PLACE);
  });

  it("counts a refused operation so the host can report it", () => {
    // A refusal nobody notices is a world with a missing bridge. This is what makes it
    // notice-able without inspecting every handle.
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const place = registry.create("bridge");
    for (let i = 0; i < MAX_OPERATIONS_PER_PLACE + 1; i++)
      place.add(ids(), aBox(boxAt(i, 0, 0)));

    expect(place.full).toBe(true);
    expect(place.count).toBe(MAX_OPERATIONS_PER_PLACE);
  });

  it("counts one place against the limit, not the whole registry", () => {
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const bridge = registry.create("bridge");
    const quarry = registry.create("quarry");

    for (let i = 0; i < MAX_OPERATIONS_PER_PLACE; i++)
      bridge.add(ids(), aBox(boxAt(i, 0, 0)));
    expect(bridge.full).toBe(true);
    // The second place is unaffected: the limit is about how big one model can get
    // before a chunk stops being affordable to sample, not a quota for the session.
    expect(quarry.full).toBe(false);
    expect(quarry.add(ids(), aBox(boxAt(0, 0, 0)))).toBeDefined();
  });
});

describe("a place's own extent", () => {
  it("reports the box its operations reach, for the invalidation they imply", () => {
    // Same contract as a document change: `sculpt.ts` is handed `change.bounds` so a
    // listener does not work out for itself which chunks an edit touched. A place is
    // told the same way.
    const registry = registryOver(new SculptDocument());
    const ids = shapeIds();
    const place = registry.create("bridge");

    expect(place.bounds).toBeUndefined();
    place.add(ids(), aBox(boxAt(0, 0, 0)));
    place.add(ids(), aBox(boxAt(200, 0, 0)));
    expect(place.bounds).toBeDefined();
    expect(place.bounds?.min.x).toBeLessThan(0);
    expect(place.bounds?.max.x).toBeGreaterThan(200);
  });
});

/**
 * The measurement `MAX_OPERATIONS_PER_PLACE` was chosen from.
 *
 * Not a benchmark for its own sake: the number exists because `csg/cost.test.ts` already
 * holds a 310-operation model to a ceiling, and a script-authored place is not 310
 * operations. This sweeps the range and prints the curve, so the constant has a
 * provenance and so the next person to move it can see what they are trading.
 *
 * **Cost is driven by how many operations overlap the chunk, not how many exist**, so
 * the model here is deliberately hostile: every operation is placed *inside* the sampled
 * region. A place that scattered its shapes across a kilometre would cost far less per
 * operation, and a measurement made that way would flatter the limit.
 */
describe("what a place costs to sample", () => {
  const SAMPLE_SPAN = (CHUNK_VOXELS + FIELD_BORDER * 2) * VOXEL_SIZE;

  /**
   * Every operation packed inside the sampled chunk, which is the worst a place can be.
   *
   * Deliberately hostile. The field's candidate cache is a chunk wide, so the cost of a
   * sample is driven by how many operations *overlap the chunk* rather than how many
   * exist — a place whose shapes were spread across a kilometre would cost much less per
   * operation, and measuring that way would flatter the limit and let a bigger number
   * through.
   */
  const aClusterOf = (count: number): Operation[] => {
    const operations: Operation[] = [];
    for (let i = 0; i < count; i++) {
      operations.push({
        ...placeOperation(
          { x: (i % 24) * 12, y: Math.floor(i / 576) * 12, z: (i % 7) * 12 },
          { type: "Ellipsoid", radius: { x: 30, y: 30, z: 30 } },
          i % 5 === 0 ? "Subtract" : "Add",
        ),
        index: i,
      });
    }
    return operations;
  };

  const sweep = (count: number): number => {
    const field = new Field(new OperationBVH(aClusterOf(count)));
    const n = CHUNK_VOXELS + FIELD_BORDER * 2;
    const release = field.bvh.beginRegion({
      min: { x: 0, y: 0, z: 0 },
      max: { x: SAMPLE_SPAN, y: SAMPLE_SPAN, z: SAMPLE_SPAN },
    });

    /** `planes` layers of the sweep, so a warm-up can be a fraction of one. */
    const run = (planes: number): number => {
      let acc = 0;
      for (let z = 0; z < planes; z++) {
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            acc += field.distance(
              x * VOXEL_SIZE,
              y * VOXEL_SIZE,
              z * VOXEL_SIZE,
            );
          }
        }
      }
      return acc;
    };

    // A **partial** untimed warm-up, not the full extra sweep `csg/cost.test.ts` runs.
    //
    // The JIT warms within the first few thousand samples, so the remainder of a full
    // warm-up is about a second of CPU spent on nothing — and this file's cost is not
    // paid alone. Vitest runs every file in parallel, so a dense sweep here is a
    // neighbour that a timing-sensitive test in another file has to get by. That is not
    // hypothetical: with the full-length warm-up this test took ~3.5 s and
    // `world/cloud-bake-client.test.ts` timed out at vitest's 5 s default in a suite run,
    // twice, while passing in isolation and in nine consecutive suite runs once this
    // sweep was halved. Four layers is a twentieth of a sweep and warms the same code.
    run(4);

    const started = performance.now();
    const total = run(n);
    const elapsed = performance.now() - started;
    release();
    expect(total).not.toBe(0);
    return elapsed;
  };

  /**
   * Generous, and unlike every other test in this repository, because this one is slow
   * by nature rather than by accident: four sweeps of 39,936 samples, each run twice so
   * the timed pass is not measuring a first-call JIT. A raised limit is *supposed* to make
   * this slow, and supposed to be red.
   */
  it("costs a session's worth of operations a bounded factor more, not an order of magnitude", () => {
    // **A ratio, not a wall clock, and that is not a subtlety.** This sweep measures
    // 39,936 field samples four times over. Run alone it takes about a second; run as
    // part of the full suite — every file in parallel — the same sweep took **3.5
    // seconds** on this machine with this code, against a 2.5 second ceiling. A
    // time-based assertion here measures the runner's willingness to serve threads,
    // which is what `csg/cost.test.ts`'s own comment says, and it would go red on a
    // busy machine while saying nothing at all about the code.
    //
    // Both numbers come from the *same* run, so whatever the machine's mood is it is
    // in both and the quotient is stable where neither absolute is. That quotient is
    // the property worth having: a place costs roughly what its size says, plus the
    // superlinear part below.
    const samples = (CHUNK_VOXELS + FIELD_BORDER * 2) ** 3;
    const perSample = (ms: number): string =>
      `${((ms * 1000) / samples).toFixed(2)} us/sample`;

    // What a hand-sculpted session reaches: the same 310 `csg/cost.test.ts` blesses.
    // The comparison is against a model this repository already considers normal.
    const aSessionIsWorth = sweep(310);
    const aFullPlaceIsWorth = sweep(MAX_OPERATIONS_PER_PLACE);

    console.log(
      [
        `    310 ops  ${aSessionIsWorth.toFixed(0).padStart(6)} ms  ${perSample(aSessionIsWorth)}`,
        `${String(MAX_OPERATIONS_PER_PLACE).padStart(5)} ops  ${aFullPlaceIsWorth
          .toFixed(0)
          .padStart(6)} ms  ${perSample(aFullPlaceIsWorth)}`,
        `    ratio   ${(aFullPlaceIsWorth / aSessionIsWorth).toFixed(1)}x`,
      ].join("\n"),
    );

    // Six and a half times the operations, so about 7x is what the curve predicts. The
    // allowance covers the superlinear part and a machine that schedules the sweep
    // badly mid-run. **A raised limit crosses it:** 4,000 operations measured roughly
    // 27x a session's worth, which is over the line — so raising
    // `MAX_OPERATIONS_PER_PLACE` without measuring is a failing test rather than a
    // slower world nobody notices until they are holding a phone.
    expect(aFullPlaceIsWorth / aSessionIsWorth).toBeLessThan(20);
  }, 60_000);
});
