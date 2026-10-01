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

/** Records every fold, so a stroke can be compared against the model it should have kept. */
const sink = () => {
  const folds: Array<readonly Operation[]> = [];
  const model: SculptModelSink = {
    setOperations: (operations) => {
      folds.push([...operations]);
    },
  };
  return { model, folds, latest: () => folds[folds.length - 1] };
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
    // The field the picker traces is rebuilt from the same list the workers are sent, so a
    // second stroke picks against the first one. If the fold dropped the model, the second
    // stroke would be placed against a field that is not what is on screen — the one
    // disagreement this design exists to rule out (ADR 0009).
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);

    sculptAcross(session);
    const afterFirst = folds[0].length;
    sculptAcross(session);

    expect(folds).toHaveLength(2);
    // Monotonic: the second stroke only ever adds.
    expect(folds[1].length).toBeGreaterThan(afterFirst);
    expect(folds[1].slice(0, afterFirst)).toEqual(folds[0]);
  });

  it("undoes a stroke without touching the model underneath it", () => {
    const operations = starterOperations();
    const { session, folds } = sessionOver(operations);
    sculptAcross(session);
    const afterStroke = folds[0].length;

    expect(session.tool.undo()).toBe(true);

    // Undo removes the stroke's dabs and leaves the model it was drawn on.
    expect(folds[1].length).toBeLessThan(afterStroke);
    expect(folds[1]).toEqual(operations);
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
