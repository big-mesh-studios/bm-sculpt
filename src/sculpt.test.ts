import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import { SculptSession, type SculptModelSink } from "./sculpt";
import { starterOperations } from "./session";
import type { Operation } from "./csg";
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

const sessionOver = (operations = starterOperations()) => {
  const stream = sink();
  const session = new SculptSession({
    session: stream.model,
    camera: camera(),
    operations,
  });
  return { session, ...stream };
};

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
