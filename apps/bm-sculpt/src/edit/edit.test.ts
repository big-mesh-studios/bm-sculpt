import { describe, expect, it } from "vitest";

import { makeOperation } from "@big-mesh-studios/csg";
import type { Operation } from "@big-mesh-studios/csg";

import { SculptDocument, boundsOf } from "./document";
import { beginStroke, DAB_SPACING, DEFAULT_BRUSH } from "./brush";
import { SculptTool, type SculptTarget } from "./tool";
import type { BrushStroke } from "./brush";
import type { PickHit } from "@big-mesh-studios/picking";

const dab = (index: number, x = 0, radius = 10): Operation =>
  makeOperation(
    index,
    { x, y: 0, z: 0 },
    { type: "Ellipsoid", radius: { x: radius, y: radius, z: radius } },
    "Add",
  );

/**
 * A group of operations with correctly increasing indices, as a stroke writes them.
 *
 * Built by appending to a document rather than by listing radii, because an operation's
 * index is its position in the fold: a helper that restarted at zero would hand the
 * document duplicate indices and every test using two groups would be wrong in a way that
 * looks like a bug in the document.
 */
const addGroup = (
  document: SculptDocument,
  ...radii: number[]
): Operation[] => {
  const from = document.count;
  const added = radii.map((radius, at) => dab(from + at, 0, radius));
  document.add(added);
  return added;
};

describe("the model as a history", () => {
  it("starts empty with nothing to undo", () => {
    const document = new SculptDocument();
    expect(document.count).toBe(0);
    expect(document.canUndo).toBe(false);
    expect(document.canRedo).toBe(false);
  });

  it("appends operations in order", () => {
    const document = new SculptDocument();
    addGroup(document, 10, 20, 30);
    expect(document.list.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(document.count).toBe(3);
  });

  it("ignores an empty addition rather than putting a command on the stack", () => {
    // A click that landed on nothing — a stroke begun and released without moving — must
    // not be something the user has to press undo twice to get past.
    const document = new SculptDocument();
    expect(document.add([])).toBe(false);
    expect(document.canUndo).toBe(false);
  });

  it("removes what an undo added, and puts it back", () => {
    const document = new SculptDocument();
    addGroup(document, 10, 20, 30);
    addGroup(document, 40, 50);

    expect(document.count).toBe(5);
    document.undo();
    expect(document.count).toBe(3);
    expect(document.canRedo).toBe(true);

    document.redo();
    expect(document.count).toBe(5);
    expect(document.list.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("undoes a whole stroke as one step", () => {
    // A stroke across a large model is hundreds of dabs, and undoing them one at a time
    // would be unusable.
    const document = new SculptDocument();
    document.add(Array.from({ length: 200 }, (_, i) => dab(i)));
    document.undo();
    expect(document.count).toBe(0);
    expect(document.canUndo).toBe(false);
  });

  it("does not renumber what survives an undo", () => {
    // An operation's index is its position in the fold and must increase monotonically and
    // never be reused, or the colour resolution order changes under a stroke in progress.
    const document = new SculptDocument();
    addGroup(document, 10, 20, 30);
    addGroup(document, 40, 50, 60);
    document.undo();

    expect(document.list.map((o) => o.index)).toEqual([0, 1, 2]);
    const indices = document.list.map((o) => o.index);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("redo restores the operations themselves, not a record of them", () => {
    // A redo that recomputed would be free to differ from what the undo actually did.
    const document = new SculptDocument();
    addGroup(document, 11, 22, 33);
    const before = [...document.list];

    document.undo();
    document.redo();
    expect(document.list).toEqual(before);
  });

  it("forgets the redo stack once something new is added", () => {
    // The list has moved past it, so a redo would put operations back at a position that
    // no longer means what it did.
    const document = new SculptDocument();
    addGroup(document, 10, 20);
    document.undo();
    expect(document.canRedo).toBe(true);

    addGroup(document, 30);
    expect(document.canRedo).toBe(false);

    // Undoing the new group and redoing it must not bring the old one back with it.
    document.undo();
    document.redo();
    expect(document.count).toBe(1);
    expect((document.list[0].shape as { radius: { x: number } }).radius.x).toBe(
      30,
    );
  });

  it("does nothing when asked to undo or redo past the ends", () => {
    const document = new SculptDocument();
    expect(document.undo()).toBeUndefined();
    expect(document.redo()).toBeUndefined();
    addGroup(document, 10);
    expect(document.redo()).toBeUndefined();
  });

  it("throws the history away without throwing away the list", () => {
    // For loading: the list is the whole of the saved state and there is no earlier version
    // to return to.
    const document = new SculptDocument();
    addGroup(document, 10, 20);
    document.resetHistory();
    expect(document.count).toBe(2);
    expect(document.canUndo).toBe(false);
    expect(document.canRedo).toBe(false);
  });

  it("reports every change, with what it touched", () => {
    const document = new SculptDocument();
    const seen: string[] = [];
    const stop = document.onChange((_list, change) =>
      seen.push(`${change.kind}:${change.count}`),
    );

    addGroup(document, 10, 20);
    document.undo();
    document.redo();
    expect(seen).toEqual(["add:2", "undo:2", "redo:2"]);

    stop();
    addGroup(document, 30);
    expect(seen).toHaveLength(3);
  });

  it("reports bounds for an undo from the operations it removed", () => {
    const document = new SculptDocument();
    document.add([dab(0, 100, 25)]);
    const change = document.undo();
    expect(change?.bounds).toEqual({
      min: { x: 75, y: -25, z: -25 },
      max: { x: 125, y: 25, z: 25 },
    });
  });
});

describe("the bounds an edit touched", () => {
  it("has none for an empty set", () => {
    expect(boundsOf([])).toBeUndefined();
  });

  it("covers every operation's own extents", () => {
    const bounds = boundsOf([dab(0, 0, 10), dab(1, 100, 20)])!;
    expect(bounds.min.x).toBe(-10);
    expect(bounds.max.x).toBe(120);
  });

  it("takes each shape's extents from the primitive table", () => {
    // **The comment this test used to carry argued against a table**: "a table here is
    // a second place to update when a shape is added, and the wrong place to be wrong".
    // It was right, and it was also the seventh copy of a per-shape extent list. The
    // table is now in `packages/sdf`, it is the only copy, and this test asserts the
    // document reaches it — which is the thing that was worth protecting all along, that
    // an invalidation box too small makes an edit only half appear.
    const box = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 10, y: 20, z: 30 } },
      "Add",
    );
    const capsule = makeOperation(
      1,
      { x: 0, y: 0, z: 0 },
      { type: "Capsule", len: 100, radius: 10 },
      "Add",
    );
    const bounds = boundsOf([box, capsule])!;
    // The box: x to 10. The capsule is **vertical**, so it reaches 50 + 10 up y and 10
    // across x and z — where it used to be 50 + 10 along x, because its axis moved.
    expect(bounds.max.x).toBeCloseTo(10, 9);
    expect(bounds.max.y).toBeCloseTo(60, 9);
    expect(bounds.max.z).toBeCloseTo(30, 9);
  });
});

describe("a brush stroke", () => {
  it("marks a dab on the first point, so a click is a stroke", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document);
    expect(stroke.extendTo({ x: 0, y: 0, z: 0 })).toBe(1);
    expect(stroke.dabCount).toBe(1);
  });

  it("spaces dabs along the path rather than where the pointer happened to be", () => {
    // Measured from the last dab, not the last point handed in, so a fast drag produces
    // even spacing instead of gaps and a slow drag produces hundreds of redundant dabs.
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 400, y: 0, z: 0 });

    const expected = Math.floor(400 / (40 * DAB_SPACING));
    expect(stroke.dabCount).toBeGreaterThanOrEqual(expected);
  });

  it("adds nothing when the pointer has not moved far enough", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    const before = stroke.dabCount;
    stroke.extendTo({ x: 1, y: 0, z: 0 });
    expect(stroke.dabCount).toBe(before);
  });

  it("gives every dab an index that keeps increasing", () => {
    const document = new SculptDocument();
    addGroup(document, 10);
    const stroke = beginStroke(document);
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 200, y: 0, z: 0 });
    stroke.end();

    // The document already held one operation at index 0, so the stroke's own dabs start
    // at 1 and nothing anywhere repeats or goes backwards.
    const indices = document.list.map((o) => o.index);
    expect(indices[0]).toBe(0);
    expect(indices[1]).toBe(1);
    expect(indices).toHaveLength(1 + stroke.dabCount);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]);
    }
  });

  it("ends the stroke where the pointer lifted", () => {
    // Evenly spaced dabs leave a remainder of up to one spacing, which at a quarter of the
    // radius is plainly visible as the stroke stopping short of the cursor.
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    // A remainder large enough to be worth a dab of its own: 306 is thirty spacings and
    // most of one more.
    stroke.extendTo({ x: 306, y: 0, z: 0 });

    expect(stroke.bounds!.max.x).toBeCloseTo(346, 6);
  });

  it("ignores a leftover too small to be worth a dab", () => {
    // Pointer jitter rather than intent: dabbing every jittered frame of a slow drag would
    // put hundreds of redundant operations into one undo step.
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 302, y: 0, z: 0 });

    // 302 is thirty spacings and two tenths of one, so the last dab is at 300 and the
    // stroke ends two units — a twentieth of the radius — short of where the pointer was.
    expect(stroke.bounds!.max.x).toBeCloseTo(340, 6);
  });

  it("commits as one command, so a whole stroke undoes at once", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document);
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 300, y: 0, z: 0 });
    const dabs = stroke.dabCount;
    expect(dabs).toBeGreaterThan(1);

    expect(stroke.end()).toBe(true);
    expect(document.count).toBe(dabs);
    expect(document.undoDepth).toBe(1);

    document.undo();
    expect(document.count).toBe(0);
  });

  it("leaves nothing behind when discarded", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document);
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 300, y: 0, z: 0 });
    stroke.discard();

    expect(stroke.end()).toBe(false);
    expect(document.count).toBe(0);
    expect(document.canUndo).toBe(false);
  });

  it("reports the box the whole stroke touched", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    expect(stroke.bounds).toBeUndefined();

    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.extendTo({ x: 306, y: 20, z: 0 });
    const bounds = stroke.bounds!;
    expect(bounds.min.x).toBeCloseTo(-40, 6);
    expect(bounds.max.x).toBeCloseTo(346, 6);
    expect(bounds.max.y).toBeCloseTo(60, 6);
  });

  it("pads the box by the blend band, so the join is inside it", () => {
    // An invalidation box that stopped at the surface would leave the soft join outside
    // the re-meshed chunks, so the stroke would show a hard edge at the chunk boundary.
    const document = new SculptDocument();
    const soft = beginStroke(document, {
      ...DEFAULT_BRUSH,
      radius: 10,
      softness: 0.25,
    });
    soft.extendTo({ x: 0, y: 0, z: 0 });
    const bounds = soft.bounds!;
    expect(bounds.min.x).toBeCloseTo(-10 - 1, 6);
    expect(bounds.max.x).toBeCloseTo(10 + 1, 6);
  });

  it("takes the mode into the operation it writes", () => {
    const document = new SculptDocument();
    for (const [mode, expected] of [
      ["add", "Add"],
      ["subtract", "Subtract"],
      ["paint", "Paint"],
    ] as const) {
      const stroke = beginStroke(document, { ...DEFAULT_BRUSH, mode });
      stroke.extendTo({ x: 0, y: 0, z: 0 });
      stroke.end();
      expect(document.list[document.count - 1].combine).toBe(expected);
    }
  });

  it("holds softness inside the maximum", () => {
    // `MAX_SOFTNESS` exists so the candidate cache can be sized by a fixed margin; a
    // stroke that exceeded it would make that margin wrong.
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, softness: 99 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.end();
    expect(document.list[0].softness).toBeLessThanOrEqual(0.25);
  });

  it("takes a brush size from the settings, clamped away from zero", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 0 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.end();
    // A zero radius would be a division by zero in the distance function and a NaN mesh.
    expect(document.list[0].shape).toMatchObject({
      type: "Ellipsoid",
      radius: { x: expect.any(Number) },
    });
    const radius = (document.list[0].shape as { radius: { x: number } }).radius
      .x;
    expect(radius).toBeGreaterThan(0);
  });

  it("keeps a colour inside a byte", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document, {
      ...DEFAULT_BRUSH,
      mode: "paint",
      colour: { r: 999, g: -5, b: 12.6 },
    });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    stroke.end();
    expect(document.list[0].colour).toEqual({ r: 255, g: 0, b: 13 });
  });

  it("gives a colour only to a paint stroke, and no colour at all to the others", () => {
    // **This is the guard that keeps the landscape one colour.** An operation's colour
    // is what decides the colour of the surface there, whatever the operation does to the
    // geometry — so an `Add` or a `Subtract` carrying the palette's current colour would
    // repaint the terrain with it. The brush writes a colour only when painting.
    const document = new SculptDocument();
    for (const mode of ["add", "subtract", "paint"] as const) {
      const stroke = beginStroke(document, {
        ...DEFAULT_BRUSH,
        mode,
        colour: { r: 1, g: 2, b: 3 },
      });
      stroke.extendTo({ x: 0, y: 0, z: 0 });
      stroke.end();
      const operation = document.list[document.count - 1]!;
      if (mode === "paint") {
        expect(operation.colour, mode).toEqual({ r: 1, g: 2, b: 3 });
      } else {
        expect(
          operation.colour,
          `${mode} must carry no colour`,
        ).toBeUndefined();
      }
    }
  });

  it("survives a pointer jump without spinning", () => {
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 40 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    // A pointer teleport, from a stale position or a window dragged across the screen.
    expect(() => stroke.extendTo({ x: 1e6, y: 0, z: 0 })).not.toThrow();
    expect(stroke.dabCount).toBeGreaterThan(1);
  });

  it("changes shape mid-stroke without losing the ones already made", () => {
    // A tool palette makes it easy to change the brush by accident, and a stroke that
    // restarted would be two commands where the user expects one.
    const document = new SculptDocument();
    const stroke = beginStroke(document, { ...DEFAULT_BRUSH, radius: 20 });
    stroke.extendTo({ x: 0, y: 0, z: 0 });
    const first = stroke.dabCount;
    stroke.configure({ ...DEFAULT_BRUSH, radius: 80 });
    stroke.extendTo({ x: 200, y: 0, z: 0 });
    stroke.end();

    expect(stroke.dabCount).toBeGreaterThan(first);
    const radii = document.list.map(
      (o) => (o.shape as { radius: { x: number } }).radius.x,
    );
    expect(radii[0]).toBe(20);
    expect(Math.max(...radii)).toBe(80);
    expect(document.undoDepth).toBe(1);
  });
});

/**
 * A tool test bed: picks wherever it is told to, and records what it was asked to commit.
 *
 * The tool's whole job is deciding what a pointer event means, so the tests drive events
 * rather than geometry — the picking is `picker.test.ts`'s job and is tested there.
 */
type Hit = PickHit;

const ON_SURFACE: Hit = {
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  distance: 900,
  steps: 12,
};

/** `null` rather than `undefined` for "no surface", because passing `undefined` to a
 * parameter with a default gets the default. A function picks by position, for the tests
 * that need a stroke to *travel* rather than to land on the same point repeatedly. */
const toolBed = (
  hit:
    | Hit
    | null
    | ((clientX: number, clientY: number) => Hit | null) = ON_SURFACE,
) => {
  const commits: BrushStroke[] = [];
  const strokes: BrushStroke[] = [];
  const previews: BrushStroke[] = [];
  let discards = 0;
  let undoCalls = 0;
  let redoCalls = 0;

  const target: SculptTarget = {
    pick: (_camera, clientX, clientY) =>
      (typeof hit === "function" ? hit(clientX, clientY) : hit) ?? undefined,
    beginStroke: () => {
      const stroke = beginStroke(new SculptDocument(), DEFAULT_BRUSH);
      strokes.push(stroke);
      return stroke;
    },
    preview: (stroke) => previews.push(stroke),
    commit: (stroke) => commits.push(stroke),
    discardStroke: () => {
      discards++;
    },
    undo: () => {
      undoCalls++;
      return true;
    },
    redo: () => {
      redoCalls++;
      return true;
    },
  };

  const tool = new SculptTool({
    camera: {
      projectionMatrixInverse: { elements: [] },
      matrixWorld: { elements: [] },
      position: { x: 0, y: 0, z: 0 },
    },
    target,
  });

  return {
    tool,
    commits,
    strokes,
    previews,
    discards: () => discards,
    undoCalls: () => undoCalls,
    redoCalls: () => redoCalls,
  };
};

const down = (
  overrides: Partial<{
    button: number;
    shiftKey: boolean;
    clientX: number;
    clientY: number;
  }> = {},
) => ({
  button: 0,
  shiftKey: false,
  clientX: 100,
  clientY: 100,
  ...overrides,
});

describe("what a pointer drag means", () => {
  it("sculpts on a left drag", () => {
    const { tool, strokes } = toolBed();
    expect(tool.pointerDown(down(), 800, 600)).toBe("sculpt");
    expect(strokes).toHaveLength(1);
    expect(tool.state.sculpting).toBe(true);
  });

  it("orbits on a right drag, so a drag can never do two things", () => {
    const { tool, strokes } = toolBed();
    expect(tool.pointerDown(down({ button: 2 }), 800, 600)).toBe("orbit");
    expect(strokes).toHaveLength(0);
    expect(tool.state.sculpting).toBe(false);
  });

  it("pans on a shift drag, whichever button is underneath the shift", () => {
    // Shift is a modifier rather than a gesture of its own, so it pans from the left button
    // as well as the right. Asserted on both because the tool and the camera read the same
    // rule from two files, and a rule that drifts leaves the tool reporting one gesture
    // while the camera performs another.
    const { tool, strokes } = toolBed();
    expect(tool.pointerDown(down({ shiftKey: true }), 800, 600)).toBe("pan");
    expect(
      tool.pointerDown(down({ button: 2, shiftKey: true }), 800, 600),
    ).toBe("pan");
    expect(
      tool.pointerDown(down({ button: 1, shiftKey: true }), 800, 600),
    ).toBe("pan");
    expect(strokes).toHaveLength(0);
  });

  it("pans on the middle button", () => {
    expect(toolBed().tool.pointerDown(down({ button: 1 }), 800, 600)).toBe(
      "pan",
    );
  });

  it("begins no stroke when a sculpt press lands on nothing", () => {
    // Pressing on empty space and dragging onto the model is not a stroke; it is a stroke
    // from wherever it first landed.
    const { tool, strokes } = toolBed(null);
    expect(tool.pointerDown(down(), 800, 600)).toBe("sculpt");
    expect(strokes).toHaveLength(0);
  });

  it("extends the stroke as the pointer moves", () => {
    const { tool, strokes } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 140, clientY: 100 }, 800, 600);
    expect(strokes[0].dabCount).toBeGreaterThan(0);
  });

  it("keeps the stroke open across a gap in the model", () => {
    // Dragging over empty space and coming back is one stroke, which is what a user
    // expects; ending it would put two commands in the history for one gesture.
    let hit: Hit | null = ON_SURFACE;
    const commits: BrushStroke[] = [];
    const strokes: BrushStroke[] = [];
    const tool = new SculptTool({
      camera: {
        projectionMatrixInverse: { elements: [] },
        matrixWorld: { elements: [] },
        position: { x: 0, y: 0, z: 0 },
      },
      target: {
        pick: () => hit ?? undefined,
        beginStroke: () => {
          const stroke = beginStroke(new SculptDocument(), DEFAULT_BRUSH);
          strokes.push(stroke);
          return stroke;
        },
        preview: () => {},
        commit: (stroke) => commits.push(stroke),
        discardStroke: () => {},
        undo: () => false,
        redo: () => false,
      },
    });

    tool.pointerDown(down(), 800, 600);
    hit = null;
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    expect(tool.state.sculpting).toBe(true);

    hit = {
      point: { x: 10, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      distance: 890,
      steps: 13,
    };
    tool.pointerMove({ clientX: 300, clientY: 100 }, 800, 600);
    tool.pointerUp();

    expect(strokes).toHaveLength(1);
    expect(commits).toHaveLength(1);
  });

  it("commits on release, once", () => {
    const { tool, commits } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    tool.pointerUp();
    expect(commits).toHaveLength(1);
    expect(tool.state.sculpting).toBe(false);
  });

  it("does not commit a stroke that never landed", () => {
    // Pressed and released without moving, or moving over nothing: an empty command in the
    // undo stack is something the user has to press undo twice to get past.
    const { tool, commits } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerUp();
    expect(commits).toHaveLength(0);
  });

  it("throws the stroke away when the pointer leaves the canvas", () => {
    // Leaving mid-drag is a gesture the user did not finish, and half of it is not what
    // they meant.
    const { tool, commits, strokes } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    tool.pointerLeave();
    expect(tool.state.sculpting).toBe(false);
    expect(commits).toHaveLength(0);
    expect(strokes[0].end()).toBe(false);
  });

  it("begins no second stroke when a second pointer goes down", () => {
    // On a touch screen the second finger arrives as `button === 0` — identical to the
    // first — so a caller forwarding every press would replace the stroke in progress with
    // a new one and lose it. One stroke at a time is this class's own invariant precisely
    // because the event cannot be trusted to say which finger it is.
    const { tool, strokes, commits } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);

    const kind = tool.pointerDown(down(), 800, 600);

    expect(kind).toBe("sculpt");
    expect(strokes).toHaveLength(1);
    // The stroke in progress is the one that started it, not a replacement.
    expect(tool.state.stroke).toBe(strokes[0]);
    tool.pointerUp();
    expect(commits).toHaveLength(1);
  });

  it("stops laying dabs while suspended, and picks up where it left off after", () => {
    // A second finger means the user has stopped painting and started navigating. Painting
    // through it would put every dab after the interruption somewhere they were not
    // pointing, because the camera is moving underneath the brush.
    //
    // The pick travels with the pointer, so "no dabs were laid" is a statement about the
    // suspension rather than about the brush having nothing to do.
    const along = (clientX: number) => ({
      ...ON_SURFACE,
      point: { x: clientX / 10, y: 0, z: 0 },
    });
    const { tool, strokes } = toolBed((clientX) => along(clientX));

    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    const laid = strokes[0].dabCount;
    expect(laid).toBeGreaterThan(0);

    tool.setSuspended(true);
    for (let step = 0; step < 5; step++) {
      tool.pointerMove({ clientX: 400 + step * 40, clientY: 300 }, 800, 600);
    }
    // A long way from where the stroke was, so resuming could not be a rounding error.
    expect(strokes[0].dabCount).toBe(laid);

    tool.setSuspended(false);
    tool.pointerMove({ clientX: 600, clientY: 300 }, 800, 600);
    expect(strokes[0].dabCount).toBeGreaterThan(laid);
  });

  it("keeps the suspended stroke, so releasing still commits what was laid", () => {
    // Suspended is not "no stroke". Throwing the work away on a pinch the user made by
    // accident is worse than a slightly odd stroke, and the dabs are already paid for.
    const { tool, strokes, commits } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    tool.setSuspended(true);
    tool.pointerMove({ clientX: 500, clientY: 300 }, 800, 600);

    tool.pointerUp();

    expect(commits).toHaveLength(1);
    expect(commits[0]).toBe(strokes[0]);
  });

  it("does not even hover while suspended", () => {
    // A preview that chases a finger the user is using to pan is worse than no preview, and
    // the hover is a pick, and a pick under a moving camera is a hit in the wrong place.
    const { tool } = toolBed();

    // First the control: an ordinary move does hover, or the assertion below is vacuous.
    tool.pointerMove({ clientX: 200, clientY: 100 }, 800, 600);
    expect(tool.state.hover).toBeDefined();

    tool.setSuspended(true);
    tool.pointerMove({ clientX: 500, clientY: 300 }, 800, 600);
    expect(tool.state.hover).toBeUndefined();
  });

  it("previews the surface under a hovering pointer", () => {
    const { tool } = toolBed();
    expect(tool.state.hover).toBeUndefined();
    tool.pointerMove({ clientX: 100, clientY: 100 }, 800, 600);
    expect(tool.state.hover).toEqual({
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
    });
  });

  it("previews nothing over empty space", () => {
    const { tool } = toolBed(null);
    tool.pointerMove({ clientX: 100, clientY: 100 }, 800, 600);
    expect(tool.state.hover).toBeUndefined();
  });

  it("does not move the preview while a stroke is in progress", () => {
    // The preview would otherwise chase the pointer along the surface being drawn, which
    // is a flickering ring rather than a cursor.
    const { tool } = toolBed();
    tool.pointerDown(down(), 800, 600);
    tool.pointerMove({ clientX: 300, clientY: 300 }, 800, 600);
    expect(tool.state.hover).toBeUndefined();
  });
});

describe("history keys", () => {
  it("undoes and redoes through the target", () => {
    const { tool, undoCalls, redoCalls } = toolBed();
    expect(tool.undo()).toBe(true);
    expect(tool.redo()).toBe(true);
    expect(undoCalls()).toBe(1);
    expect(redoCalls()).toBe(1);
  });

  it("reports failure when there is nothing to undo", () => {
    const tool = new SculptTool({
      camera: {
        projectionMatrixInverse: { elements: [] },
        matrixWorld: { elements: [] },
        position: { x: 0, y: 0, z: 0 },
      },
      target: {
        pick: () => undefined,
        beginStroke: () => beginStroke(new SculptDocument()),
        preview: () => {},
        commit: () => {},
        discardStroke: () => {},
        undo: () => false,
        redo: () => false,
      },
    });
    expect(tool.undo()).toBe(false);
    expect(tool.redo()).toBe(false);
  });
});
