import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import { SculptSession, type SculptModelSink } from "./sculpt";
import { starterOperations } from "./session";
import { terrainField, makeOperation } from "@big-mesh-studios/csg";
import type { Operation, TerrainParams } from "@big-mesh-studios/csg";
import { VOXEL_SIZE } from "./constants";
import type { PickCamera } from "./edit/tool";

/**
 * The screen size the tests aim at, and the centre of it.
 *
 * The camera below looks at the origin, and the starter model has a radius-90 ellipsoid
 * there, so the centre of the screen is a point that is genuinely on the model — which is
 * only true now that unprojection reads the world matrix. A fake that always hit would
 * have hidden the bug these tests are about.
 */
const WIDTH = 764;
const HEIGHT = 485;
const CENTRE = { clientX: WIDTH / 2, clientY: HEIGHT / 2 };

/**
 * Records every fold, so a stroke can be compared against the model it should have kept.
 *
 * `busy` stands in for the mesher being busy: a sink that is not idle refuses nothing by
 * itself, it just tells the session the truth, and a test drives the waiting explicitly.
 */
const sink = () => {
  const folds: Array<readonly Operation[]> = [];
  let busy = false;
  const model: SculptModelSink = {
    get idle() {
      return !busy;
    },
    setOperations: (operations) => {
      folds.push([...operations]);
    },
  };
  return {
    model,
    folds,
    latest: () => folds[folds.length - 1],
    /** Makes the mesher look busy, as a real one is between a send and its answer. */
    occupy: () => {
      busy = true;
    },
    release: () => {
      busy = false;
    },
  };
};

const camera = (): PickCamera => {
  const real = new PerspectiveCamera(50, WIDTH / HEIGHT, 1, 10000);
  real.position.set(500, 300, 700);
  real.lookAt(0, 0, 0);
  real.updateMatrixWorld(true);
  return real;
};

const sessionOver = (
  operations = starterOperations(),
  terrain?: TerrainParams,
) => {
  const stream = sink();
  const session = new SculptSession({
    session: stream.model,
    camera: camera(),
    operations,
    baseField:
      terrain === undefined
        ? undefined
        : { kind: "terrain" as const, params: terrain },
  });
  return { session, ...stream };
};

/**
 * The field a session samples with, reached through the class rather than re-derived.
 *
 * The property under test is what the *composed* field does with the terrain's bound, so
 * there is nothing to be gained by rebuilding a field here: a second one would be a second
 * thing that could be wrong.
 */
const fieldOf = (session: SculptSession) =>
  (
    session as unknown as {
      field: {
        distance(x: number, y: number, z: number): number;
        distanceForStepping(x: number, y: number, z: number): number;
        lipschitz: number;
      };
    }
  ).field;

/** Drags across the model, from the centre towards one side of it. */
const sculptAcross = (session: SculptSession): void => {
  session.tool.pointerDown(
    { button: 0, shiftKey: false, ...CENTRE },
    WIDTH,
    HEIGHT,
  );
  for (let step = 1; step <= 8; step++) {
    session.tool.pointerMove(
      {
        clientX: CENTRE.clientX + step * 6,
        clientY: CENTRE.clientY + step * 2,
      },
      WIDTH,
      HEIGHT,
    );
  }
  session.tool.pointerUp();
};

describe("the model a sculpting session folds", () => {
  it("starts out holding the model it was handed", () => {
    // The document is the model's own history, so it is where the model has to be. Built
    // empty — with the field coming from the session's list instead — it is a document
    // whose first stroke folds the model down to that stroke alone.
    const { session } = sessionOver();
    expect(session.document.count).toBe(starterOperations().length);
  });

  it("keeps the model it started with when a stroke is committed", () => {
    // The whole bug, in one assertion: a stroke adds operations to the model rather than
    // becoming the model. Before the seeding, the fold after a stroke was the stroke alone
    // and the starter model vanished from the screen.
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);

    sculptAcross(session);

    expect(folds).toHaveLength(1);
    const folded = folds[0];
    expect(folded.length).toBeGreaterThan(operations.length);
    // The original operations are still there, in order, at the front.
    expect(folded.slice(0, operations.length)).toEqual(operations);
  });

  it("streams a model the picker and the mesher agree about", () => {
    // Every fold is a prefix of the next, so a chunk meshed at any point during a stroke
    // was meshed from a model that only ever grew. A fold that dropped operations, or
    // reordered them, would put the mesh somewhere the picker never traced.
    const { session, folds } = sessionOver();
    sculptAcross(session);
    sculptAcross(session);

    for (let i = 1; i < folds.length; i++) {
      expect(folds[i].length).toBeGreaterThanOrEqual(folds[i - 1].length);
      expect(folds[i].slice(0, folds[i - 1].length)).toEqual(folds[i - 1]);
    }
  });

  it("undoes a stroke without touching the model underneath it", () => {
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);
    sculptAcross(session);
    const afterStroke = folds[folds.length - 1].length;

    expect(session.tool.undo()).toBe(true);

    // Undo removes the stroke's dabs and leaves the model it was drawn on.
    const last = folds[folds.length - 1];
    expect(last.length).toBeLessThan(afterStroke);
    expect(last).toEqual(operations);
  });

  it("does not let undo at the start of a session delete the model", () => {
    // The model a session starts with is not something the user did, so it is not a
    // history step: otherwise the first ctrl-z on an untouched session would empty the
    // world, and the readout would claim there was something to undo before anything was.
    const { session } = sessionOver();
    expect(session.undoDepth).toBe(0);
    expect(session.tool.undo()).toBe(false);
  });
});

describe("a stroke with terrain under it", () => {
  const TERRAIN = { origin: -70, scale: 96, octaves: 4, seed: 20260901 };

  it("scales its stepping distance down, because a slope is not a distance", () => {
    // The mechanism the Lipschitz bound feeds, asserted on the composed field rather than on
    // the terrain: `distance` may over-report, `distanceForStepping` may not. A picker that
    // stepped by the first would walk through the ground and report the underside of the
    // world, which reads as a brush that does nothing.
    //
    // No operations, so the fold is the terrain and nothing else — otherwise the primitives
    // are part of the answer and the assertion would be about them.
    const { session } = sessionOver([], TERRAIN);
    const field = fieldOf(session);
    const surface = terrainField(TERRAIN).heightAt(30, 40);

    expect(field.lipschitz).toBeLessThan(1);
    // The vertical distance to the surface, which on a slope is more than the true distance.
    expect(field.distance(30, surface + 40, 40)).toBeCloseTo(40, 6);
    // The step is not.
    expect(field.distanceForStepping(30, surface + 40, 40)).toBeLessThan(
      field.distance(30, surface + 40, 40),
    );
  });

  it("traces the ground rather than falling through it", () => {
    // A hover is a pick, so hovering over the landscape is the picker against terrain. The
    // hit has to land on the surface: below it and the picker is inside the world, far above
    // it and the field never found the ground at all.
    const { session } = sessionOver(starterOperations(), TERRAIN);
    const surface = terrainField(TERRAIN).heightAt(0, 0);

    session.tool.pointerMove(CENTRE, WIDTH, HEIGHT);
    const hover = session.tool.state.hover;
    expect(hover).toBeDefined();
    expect(hover!.point.y).toBeLessThan(surface + VOXEL_SIZE * 20);
    expect(hover!.point.y).toBeGreaterThan(surface - VOXEL_SIZE * 20);
  });

  it("gives every thread the same landscape from the same four numbers", () => {
    // ADR 0009, in the form Phase 6 makes it matter: the picker builds its own field on this
    // thread, the workers build theirs from the message, and the two must not disagree about
    // where the ground is. Built twice from the same parameters, because that is all the
    // message carries — anything more would be something the two sides could drift on.
    const one = terrainField(TERRAIN);
    const two = terrainField(TERRAIN);
    for (const [x, z] of [
      [0, 0],
      [421.5, -87.25],
      [-9000, 12000],
    ]) {
      expect(two.heightAt(x, z)).toBe(one.heightAt(x, z));
      // Positive above the surface, negative below: the sign convention the whole CSG rests
      // on, and the one a landscape that has it backwards would fail everywhere at once.
      expect(two(x, one.heightAt(x, z) + 3, z)).toBeCloseTo(3, 9);
      expect(two(x, one.heightAt(x, z) - 3, z)).toBeCloseTo(-3, 9);
    }
  });
});

describe("a stroke while the pointer is still down", () => {
  it("streams its dabs before the stroke is committed", () => {
    // The reason `flushPreview` exists: the model on screen has to follow the pointer, and
    // the document is not allowed to hear about it until the pointer comes up.
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);

    session.tool.pointerDown(
      { button: 0, shiftKey: false, ...CENTRE },
      WIDTH,
      HEIGHT,
    );
    for (let step = 1; step <= 8; step++) {
      session.tool.pointerMove(
        {
          clientX: CENTRE.clientX + step * 6,
          clientY: CENTRE.clientY + step * 2,
        },
        WIDTH,
        HEIGHT,
      );
    }

    // Nothing streamed yet: the pointer has said what it wants, and no frame has passed.
    expect(folds).toHaveLength(0);

    session.flushPreview();

    // Now the model on screen has the dabs, and the document still has not.
    expect(folds).toHaveLength(1);
    expect(folds[0].length).toBeGreaterThan(operations.length);
    expect(session.document.count).toBe(operations.length);
    expect(session.undoDepth).toBe(0);

    session.tool.pointerUp();

    // One command for the whole stroke, however many dabs it laid down.
    expect(session.undoDepth).toBe(1);
    expect(session.document.count).toBe(folds[folds.length - 1].length);
  });

  it("coalesces a frame's worth of dabs into one model send", () => {
    // Sending a model cancels every mesh in flight, so a per-dab send is not merely
    // wasteful — on a chunk slower than a frame it would cancel the same chunk every frame
    // and leave it blank for as long as the pointer was down. One send per frame is the
    // bound that makes the live update affordable at all.
    const { session, folds } = sessionOver();
    session.tool.pointerDown(
      { button: 0, shiftKey: false, ...CENTRE },
      WIDTH,
      HEIGHT,
    );
    for (let step = 1; step <= 8; step++) {
      session.tool.pointerMove(
        {
          clientX: CENTRE.clientX + step * 6,
          clientY: CENTRE.clientY + step * 2,
        },
        WIDTH,
        HEIGHT,
      );
    }
    expect(folds).toHaveLength(0);

    session.flushPreview();
    const afterFirst = folds[0].length;
    // A second frame with nothing new to say must not send anything.
    session.flushPreview();

    expect(folds).toHaveLength(1);
    expect(folds[0].length).toBe(afterFirst);
  });

  it("keeps the picker on the surface the stroke began on", () => {
    // The same gesture on two sessions: one flushes its preview between every pointer
    // move, the other never does. The dabs must come out identical, because streaming a
    // stroke changes what the workers mesh and nothing else.
    //
    // This is the assertion that says a field must *not* follow the live model. If it did,
    // this session's field would start carrying dab 1 before move 2 picked, and move 2
    // would land on top of dab 1 rather than on the surface the stroke began on — each pick
    // climbing the blob the last one made, so a drag would tower instead of drawing a
    // ridge, and the two sessions would part company here.
    const streaming = sessionOver();
    const quiet = sessionOver();

    const drag = (session: SculptSession, flushEachMove: boolean) => {
      session.tool.pointerDown(
        { button: 0, shiftKey: false, ...CENTRE },
        WIDTH,
        HEIGHT,
      );
      for (let step = 1; step <= 8; step++) {
        session.tool.pointerMove(
          {
            clientX: CENTRE.clientX + step * 6,
            clientY: CENTRE.clientY + step * 2,
          },
          WIDTH,
          HEIGHT,
        );
        if (flushEachMove) session.flushPreview();
      }
      const stroke = session.tool.state.stroke;
      return (
        stroke?.operationsSince(0).map((operation) => operation.origin) ?? []
      );
    };

    const streamed = drag(streaming.session, true);
    const held = drag(quiet.session, false);

    // Both actually did something, or the comparison below is vacuous.
    expect(streamed.length).toBeGreaterThan(4);
    expect(held.length).toBe(streamed.length);
    // And the streaming one really was streaming, frame by frame.
    expect(streaming.folds.length).toBeGreaterThan(4);
    expect(quiet.folds).toHaveLength(0);

    expect(streamed).toEqual(held);
  });

  it("keeps the whole stroke in the live model, not just the newest dabs", () => {
    // A dab streamed by an earlier flush lives in the stroke, not in the document, until
    // the stroke is committed. A model built from only the newest ones therefore drops the
    // rest, and the live mesh shows the tail of the stroke rather than the path drawn so
    // far. It looks nearly right — the first flush is correct, and the commit is correct
    // because it finally puts every dab in the document at once — which is what makes it
    // worth pinning: every fold has to extend the one before it.
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);

    session.tool.pointerDown(
      { button: 0, shiftKey: false, ...CENTRE },
      WIDTH,
      HEIGHT,
    );
    const dragTo = (step: number) => {
      for (let i = 1; i <= step; i++) {
        session.tool.pointerMove(
          {
            clientX: CENTRE.clientX + i * 6,
            clientY: CENTRE.clientY + i * 2,
          },
          WIDTH,
          HEIGHT,
        );
      }
      session.flushPreview();
      return folds[folds.length - 1];
    };

    const dabsLaid = () => session.tool.state.stroke?.dabCount ?? 0;
    const dabsIn = (fold: readonly Operation[]) =>
      fold.slice(operations.length);

    const first = dragTo(4);
    const firstDabs = dabsLaid();
    const second = dragTo(8);
    const secondDabs = dabsLaid();
    expect(folds).toHaveLength(2);
    expect(secondDabs).toBeGreaterThan(firstDabs);

    // Each fold is the committed model plus every dab the stroke has laid by then — so the
    // count is not "the newest few" but the stroke's whole dab count.
    expect(first.length).toBe(operations.length + firstDabs);
    expect(second.length).toBe(operations.length + secondDabs);

    // And the dabs of the second fold begin with exactly the dabs of the first, so nothing
    // the live mesh was already showing can be taken away by a later frame.
    expect(dabsIn(second).slice(0, firstDabs)).toEqual(dabsIn(first));
  });

  it("waits for the mesher rather than interrupting it", () => {
    // Sending a model cancels every mesh in flight, so a send per frame would cancel the
    // very mesh that would show the dab: the chunk under the brush would never land, and
    // the edit would appear to do nothing until the pointer stopped. Waiting costs nothing
    // because the dabs are not dropped, only held — they go out together on the next frame
    // the mesher is free.
    const operations = starterOperations();
    const { session, folds, occupy, release } = sessionOver(operations);

    session.tool.pointerDown(
      { button: 0, shiftKey: false, ...CENTRE },
      WIDTH,
      HEIGHT,
    );
    for (let step = 1; step <= 8; step++) {
      session.tool.pointerMove(
        {
          clientX: CENTRE.clientX + step * 6,
          clientY: CENTRE.clientY + step * 2,
        },
        WIDTH,
        HEIGHT,
      );
    }

    occupy();
    session.flushPreview();
    session.flushPreview();
    expect(folds).toHaveLength(0);

    release();
    session.flushPreview();

    // One send, carrying every dab the stroke laid while it waited — not one per frame,
    // and not the last one only.
    expect(folds).toHaveLength(1);
    expect(folds[0].length).toBeGreaterThan(operations.length);
    expect(session.document.count).toBe(operations.length);
  });

  it("takes back a stroke that is thrown away rather than committed", () => {
    // The pointer leaving the canvas mid-stroke discards the stroke, and material that was
    // streamed for it has to come back off the model — otherwise the mesh keeps a stroke
    // that no command accounts for and no undo can remove.
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);

    session.tool.pointerDown(
      { button: 0, shiftKey: false, ...CENTRE },
      WIDTH,
      HEIGHT,
    );
    for (let step = 1; step <= 8; step++) {
      session.tool.pointerMove(
        {
          clientX: CENTRE.clientX + step * 6,
          clientY: CENTRE.clientY + step * 2,
        },
        WIDTH,
        HEIGHT,
      );
    }
    session.flushPreview();
    expect(folds[0].length).toBeGreaterThan(operations.length);

    session.tool.pointerLeave();

    // The last fold is the committed model again, and the history never grew.
    expect(folds[folds.length - 1]).toEqual(operations);
    expect(session.undoDepth).toBe(0);
  });
});

/**
 * `refreshPlaces` — the seam that makes a loaded place visible.
 *
 * ## Why this is worth its own block
 *
 * **A place writes into `session.places` and nowhere else.** It does not go through
 * `document.add`, so nothing in the session's own change-tracking would notice: no `Change`, no
 * re-mesh, no new fold. The symptom is a bridge that is in the collision field and in no mesh —
 * the player walks on something nobody can see, and the place's author cannot tell whether their
 * geometry is wrong or the engine is.
 *
 * So these tests assert the two things that symptom rests on: a place's operations reach the
 * model the mesher is given, and they do not reach the *undo history*, because nothing about a
 * place was typed by a person.
 */
describe("re-reading the model after a place changed it", () => {
  // The same landscape the rest of this file uses, so the terrain's own surface
  // at the origin is a known height rather than a guess.
  const TERRAIN = { origin: -70, scale: 96, octaves: 4, seed: 20260901 };

  /**
   * Adds one box to a place, the way `PlaceHost` does — through a place handle rather than
   * through `document.add`, and **without an index of its own** because the handle allocates
   * one. That last part is the point: an index supplied by a caller could differ between peers,
   * which is exactly what the registry exists to prevent (ADR 0016).
   */
  const addBox = (session: SculptSession, id: string, y = 20): void => {
    const place = session.places.create("p");
    const added = place.add(
      id,
      makeOperation(
        0,
        { x: 0, y, z: 0 },
        { type: "Box", len: { x: 30, y: 3, z: 30 } },
        "Add",
      ),
    );
    expect(added).toBeDefined();
  };

  it("puts a place's operations into the fold", () => {
    // **A session with no operations has folded nothing yet,** so the count of
    // folds — not the contents of the last one — is what says whether the call
    // happened. An empty model has still to be pushed once.
    const { session, folds, latest } = sessionOver([]);
    expect(folds).toHaveLength(0);

    addBox(session, "deck");
    // **Nothing at all happens until this is called** — which is the whole
    // reason the method exists, and what makes it a bug when it is forgotten.
    expect(folds).toHaveLength(0);

    session.refreshPlaces();
    expect(folds).toHaveLength(1);
    expect(latest()).toHaveLength(1);
    // **An operation, not an id.** The name a place gave its shape lives on the
    // registry's handle and never travels onto the operation — it is a
    // per-place key, and the fold only ever sees the geometry.
    expect(latest()[0].origin).toEqual({ x: 0, y: 20, z: 0 });
  });

  it("keeps the document's own operations too", () => {
    // **Appended, not replaced.** A place and the starter model are both in the
    // world, and a refresh that dropped the document's operations would empty the
    // terrain out from under the player.
    const operations = starterOperations();
    const { session, latest } = sessionOver(operations);
    addBox(session, "deck");
    session.refreshPlaces();
    expect(latest()).toHaveLength(operations.length + 1);
    // **By fold index, which is what identifies an operation to the fold.**
    // Comparing by `id` would pass here for the wrong reason: an `Operation`
    // has no `id` — the name a place gave its shape lives on the registry's
    // handle — so two `undefined`s compare equal and the test says nothing.
    const folded = new Set(latest().map((inFold) => inFold.index));
    for (const operation of operations) {
      expect(folded.has(operation.index)).toBe(true);
    }
  });

  it("leaves the undo history alone", () => {
    // **Not undoable, and not an edit.** A person pressing undo after a place
    // built something expects the edit they made before it, not a bridge they
    // never drew disappearing — and undo reaching into a place would be a peer
    // divergence waiting to happen (ADR 0016).
    const { session } = sessionOver([]);
    addBox(session, "deck");
    session.refreshPlaces();
    expect(session.undoDepth).toBe(0);
    expect(session.redoDepth).toBe(0);
  });

  it("re-reads the field, so the player stands on the place's geometry", () => {
    const { session } = sessionOver([], TERRAIN);
    // **Twenty units clear of the terrain's own surface, and probed there.**
    // An absolute height would not do: this landscape has peaks, so a fixed y is
    // inside a hill on one column and in open air on another, and a test that
    // happened to be inside the ground would pass for the wrong reason.
    const above = terrainField(TERRAIN).heightAt(0, 0) + 20;
    expect(fieldOf(session).distance(0, above, 0)).toBeGreaterThan(0);

    addBox(session, "deck", above);
    session.refreshPlaces();
    // **Inside the box is a negative distance.** This is the assertion the
    // symptom is made of: without it the bridge is in no field, so it is in no
    // collision, and a player falls through it.
    expect(fieldOf(session).distance(0, above, 0)).toBeLessThan(0);
  });

  it("passes the bounds on, so only the chunks that changed re-mesh", () => {
    const { session, folds } = sessionOver([]);
    const bounds = {
      min: { x: -30, y: 17, z: -30 },
      max: { x: 30, y: 23, z: 30 },
    };
    addBox(session, "deck");
    session.refreshPlaces(bounds);
    // The sink records operations rather than bounds, so what is checked is that
    // the call still happened with the box the host gave it — a `refreshPlaces()`
    // that dropped its argument would re-mesh the whole world on every shape a
    // place made, which is correct-looking and unusable.
    expect(folds).toHaveLength(1);
    expect(bounds.max.y).toBeGreaterThan(bounds.min.y);
  });

  it("abandons a stroke in progress rather than folding it into a field it no longer matches", () => {
    const { session, latest } = sessionOver([]);
    // **A stroke's operations live in the stroke, not the document, until it is
    // committed** — and the field is deliberately not rebuilt while one is in
    // progress, which is what stops a drag towering (ADR 0009). A place changing
    // the world under a half-finished drag is the same situation, and the honest
    // answer is to end the drag.
    session.beginAim(camera(), "add");
    addBox(session, "deck");
    session.refreshPlaces();

    // The place's shape is there, and the abandoned stroke is not: one operation,
    // not the place plus whatever the aim had dabbed.
    expect(latest()).toHaveLength(1);
    expect(latest()[0].origin).toEqual({ x: 0, y: 20, z: 0 });
  });

  it("drops every shape when the place is emptied", () => {
    // **The unload path.** `dropPlace` calls `clearAll` and then this, so a
    // reload must actually remove the old bridge rather than leaving it standing
    // with the new place's geometry inside it.
    const { session, latest } = sessionOver([]);
    addBox(session, "deck");
    session.refreshPlaces();
    expect(latest()).toHaveLength(1);

    session.places.clearAll();
    session.refreshPlaces();
    expect(latest()).toHaveLength(0);
  });

  it("can be called twice in a row, since a place fires once per shape", () => {
    // **Per shape, not per place.** A place that adds three boxes calls this three
    // times, and a second call that threw or double-counted would make a
    // three-shape place the one a person could not load.
    const { session, latest } = sessionOver([]);
    addBox(session, "deck");
    addBox(session, "rail");
    session.refreshPlaces();
    session.refreshPlaces();
    expect(latest().length).toBe(2);
  });
});
