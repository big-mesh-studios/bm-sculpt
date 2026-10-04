import { describe, expect, it } from "vitest";
import { flush } from "solid-js";

import { fromEuler, placedPart, type Part } from "./part";
import { HISTORY_LIMIT, MAX_PARTS, createModelStore } from "./model-store";

/**
 * Lets pending writes land, so an assertion can read them.
 *
 * ## Solid 2 batches writes, and this is why nearly every test here calls it
 *
 * **A signal write is not visible to a read until the batch is flushed.** Solid 2 beta
 * defers them:
 *
 *     const [v, setV] = createSignal(false);
 *     setV(true);
 *     v();          // false
 *     flush();
 *     v();          // true
 *
 * This is not a quirk of the test runner and it is not a bug to work around by using
 * `jsdom` or by reaching for `@solidjs/signals` — under this repository's Vitest
 * configuration `solid-js` resolves to its *development browser* build, and the same
 * deferral happens in Node, in jsdom, and in a plain `node -e`. `flushSync` does not
 * exist in Solid 2; `flush` is what it was renamed to.
 *
 * Inside a component the flush happens by itself, which is why the tests that *render*
 * pass without any of this, and why the symptom is so specific: **only a test that
 * mutates state and then reads the signal directly sees stale data.** A store test does
 * exactly that, so every one of them settles first.
 */
const settle = (): void => {
  flush();
};

const sphereAt = (id: string, x: number): Part =>
  placedPart(id, { type: "Sphere", radius: 1 }, { x, y: 0, z: 0 });

/** Reads the parts as `id@x` strings, so an assertion reads as a list. */
const shape = (store: ReturnType<typeof createModelStore>): string[] =>
  store.parts().map((part) => `${part.id}@${part.origin.x}`);

describe("the model's parts", () => {
  it("starts empty and says so", () => {
    const store = createModelStore();
    expect(store.parts()).toEqual([]);
    expect(store.selected()).toBeUndefined();
    expect(store.canUndo()).toBe(false);
  });

  it("selects the first part it is given", () => {
    // A store that can only be empty cannot be tested against a model that has
    // something in it, and the empty case is not the interesting one.
    const store = createModelStore([sphereAt("a", 0), sphereAt("b", 2)]);
    expect(store.selected()).toBe("a");
  });

  it("adds a part and selects it", () => {
    const store = createModelStore();
    expect(store.add(sphereAt("a", 1))).toBe(true);
    settle();
    expect(shape(store)).toEqual(["a@1"]);
    expect(store.selected()).toBe("a");
  });

  it("refuses a part whose id is already in use", () => {
    // Ids are never reused, so a second part with the same id is a caller bug rather
    // than a replacement.
    const store = createModelStore([sphereAt("a", 1)]);
    expect(store.add(sphereAt("a", 9))).toBe(false);
    expect(shape(store)).toEqual(["a@1"]);
  });

  it("refuses a part above the ceiling", () => {
    const store = createModelStore();
    for (let i = 0; i < MAX_PARTS; i++) store.add(sphereAt(`p${i}`, i));
    settle();
    expect(store.parts().length).toBe(MAX_PARTS);
    expect(store.add(sphereAt("one-too-many", 0))).toBe(false);
    settle();
    expect(store.parts().length).toBe(MAX_PARTS);
  });

  it("refuses to remove a part that is not there", () => {
    const store = createModelStore([sphereAt("a", 1)]);
    expect(store.remove("nope")).toBe(false);
    expect(shape(store)).toEqual(["a@1"]);
  });

  it("clears a selection that names a part which is gone", () => {
    // A stale selection would otherwise survive, and every transform aimed at it would
    // be silently refused.
    const store = createModelStore([sphereAt("a", 1)]);
    store.remove("a");
    settle();
    expect(store.selected()).toBeUndefined();
  });

  it("refuses a selection that names nothing", () => {
    const store = createModelStore([sphereAt("a", 1)]);
    store.select("nope");
    settle();
    expect(store.selected()).toBeUndefined();
  });

  it("folds its parts into operations, one Add each, in list order", () => {
    const store = createModelStore([sphereAt("a", 0), sphereAt("b", 2)]);
    const operations = store.operations();
    expect(operations.length).toBe(2);
    expect(operations.map((operation) => operation.combine)).toEqual([
      "Add",
      "Add",
    ]);
    expect(operations.map((operation) => operation.origin.x)).toEqual([0, 2]);
  });
});

describe("undo", () => {
  it("takes an added part back and puts it back", () => {
    const store = createModelStore();
    store.add(sphereAt("a", 1));
    settle();
    expect(store.canUndo()).toBe(true);
    expect(store.undoLabel()).toBe("add a");

    store.undo();

    settle();
    expect(store.parts()).toEqual([]);
    expect(store.canRedo()).toBe(true);

    store.redo();

    settle();
    expect(shape(store)).toEqual(["a@1"]);
  });

  it("puts a removed part back where it was, not at the end", () => {
    // **This is the assertion that matters for the file format.** A part that came back
    // appended would come back after everything added while it was gone. For a union that
    // looks identical — which is why it would go unnoticed until order was recorded.
    const store = createModelStore([
      sphereAt("a", 0),
      sphereAt("b", 1),
      sphereAt("c", 2),
    ]);
    store.remove("b");
    settle();
    store.add(sphereAt("d", 3));
    settle();
    expect(shape(store)).toEqual(["a@0", "c@2", "d@3"]);

    // One undo for the add, one for the remove, each settled before the next.
    store.undo();
    settle();
    store.undo();
    settle();
    expect(shape(store)).toEqual(["a@0", "b@1", "c@2"]);
  });

  it("restores a transform exactly, rather than approximately", () => {
    const store = createModelStore([sphereAt("a", 0)]);
    const before = store.part("a")!.orientation;
    store.transform("a", {
      origin: { x: 5, y: 6, z: 7 },
      orientation: fromEuler(0.3, 0.4, 0.5),
    });
    settle();
    expect(store.part("a")!.origin).toEqual({ x: 5, y: 6, z: 7 });

    store.undo();

    settle();
    expect(store.part("a")!.origin).toEqual({ x: 0, y: 0, z: 0 });
    expect(store.part("a")!.orientation).toEqual(before);

    store.redo();

    settle();
    expect(store.part("a")!.origin).toEqual({ x: 5, y: 6, z: 7 });
  });

  it("refuses a transform that changes nothing", () => {
    // An edit that changes nothing is an undo step that undoes nothing, so ctrl-z after
    // a drag that did not move should go further back rather than nowhere.
    const store = createModelStore([sphereAt("a", 3)]);
    expect(store.transform("a", { origin: { x: 3, y: 0, z: 0 } })).toBe(false);
    expect(store.canUndo()).toBe(false);
    expect(
      store.transform("a", { origin: { x: 3, y: 0.001, z: 0 } }),
      "a real move is still an edit",
    ).toBe(true);
    settle();
    expect(store.canUndo()).toBe(true);
  });

  it("refuses a transform aimed at a part that is not there", () => {
    const store = createModelStore([sphereAt("a", 0)]);
    expect(store.transform("nope", { origin: { x: 1, y: 1, z: 1 } })).toBe(
      false,
    );
    expect(store.canUndo()).toBe(false);
  });

  it("does nothing at the bottom of the history", () => {
    const store = createModelStore([sphereAt("a", 0)]);
    store.undo();
    settle();
    store.undo();
    settle();
    expect(shape(store)).toEqual(["a@0"]);
  });

  it("does nothing at the top of the redo stack", () => {
    const store = createModelStore([sphereAt("a", 0)]);
    store.add(sphereAt("b", 1));
    settle();
    store.redo();
    settle();
    expect(shape(store)).toEqual(["a@0", "b@1"]);
  });

  it("throws the redo branch away when a new edit follows an undo", () => {
    // The behaviour of every undo stack: once you edit after undoing, the edits you had
    // undone are no longer reachable, because the model they described no longer follows
    // from the one you are now in.
    const store = createModelStore([sphereAt("a", 0)]);
    store.add(sphereAt("b", 1));
    settle();
    store.add(sphereAt("c", 2));
    settle();
    store.undo();
    settle();
    expect(store.canRedo()).toBe(true);

    store.add(sphereAt("d", 3));

    settle();
    expect(store.canRedo()).toBe(false);
    expect(shape(store)).toEqual(["a@0", "b@1", "d@3"]);
  });

  it("bounds the history and drops the oldest, not the newest", () => {
    const store = createModelStore();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++)
      store.add(sphereAt(`p${i}`, i));
    // Undoing everything the history still holds gets back to the first ten, because the
    // first ten edits were dropped from the bottom rather than the top.
    let undone = 0;
    while (store.canUndo()) {
      store.undo();
      settle();
      undone++;
    }
    expect(undone).toBe(HISTORY_LIMIT);
    expect(store.parts().length).toBe(10);
  });

  it("names what undo and redo would do", () => {
    const store = createModelStore();
    expect(store.undoLabel()).toBeUndefined();
    store.add(sphereAt("a", 1));
    settle();
    expect(store.undoLabel()).toBe("add a");
    expect(store.redoLabel()).toBeUndefined();
    store.undo();
    settle();
    expect(store.redoLabel()).toBe("add a");
  });

  it("walks all the way back and all the way forward again", () => {
    const store = createModelStore();
    const expected: string[][] = [[]];
    for (let i = 0; i < 12; i++) {
      store.add(sphereAt(`p${i}`, i));
      settle();
      expected.push([...expected[expected.length - 1]!, `p${i}@${i}`]);
    }
    for (let step = expected.length - 1; step > 0; step--) {
      store.undo();
      settle();
      expect(shape(store), `after ${step} undos`).toEqual(expected[step - 1]);
    }
    for (let step = 1; step < expected.length; step++) {
      store.redo();
      settle();
      expect(shape(store), `after ${step} redos`).toEqual(expected[step]);
    }
  });
});

describe("a transform", () => {
  it("moves a part without touching the others", () => {
    const store = createModelStore([sphereAt("a", 0), sphereAt("b", 5)]);
    store.transform("a", { origin: { x: 2, y: 0, z: 0 } });
    settle();
    expect(shape(store)).toEqual(["a@2", "b@5"]);
  });

  it("changes a part's primitive", () => {
    const store = createModelStore([sphereAt("a", 0)]);
    store.transform("a", { shape: { type: "Box", len: { x: 1, y: 2, z: 3 } } });
    settle();
    expect(store.part("a")!.shape).toEqual({
      type: "Box",
      len: { x: 1, y: 2, z: 3 },
    });
    store.undo();
    settle();
    expect(store.part("a")!.shape.type).toBe("Sphere");
  });

  it("leaves the rest of the transform alone when only part of it is given", () => {
    // A drag sends an origin every frame and a rotation only on release. Passing the
    // whole transform each time would reset the rotation to identity mid-drag.
    const store = createModelStore([sphereAt("a", 0)]);
    store.transform("a", { orientation: fromEuler(0, 0, Math.PI / 2) });
    settle();
    store.transform("a", { origin: { x: 4, y: 0, z: 0 } });
    settle();
    expect(store.part("a")!.origin).toEqual({ x: 4, y: 0, z: 0 });
    expect(store.part("a")!.orientation).toEqual(fromEuler(0, 0, Math.PI / 2));
  });
});

describe("nextId", () => {
  it("hands out a fresh number each time", () => {
    const store = createModelStore();
    expect(store.nextId()).not.toBe(store.nextId());
  });

  it("skips an id the model already holds", () => {
    // **The reason this is on the store rather than in the panel.** A file saved with
    // `part-1`, `part-2` and `part-3` would otherwise be followed by a counter that was still
    // near one, and the next part a person added would be refused for colliding with a part
    // already on screen — a button that silently does nothing.
    const store = createModelStore([
      placedPart("part-1", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
      placedPart("part-2", { type: "Sphere", radius: 1 }, { x: 2, y: 0, z: 0 }),
    ]);

    const handed = store.nextId();
    store.add(
      placedPart(handed, { type: "Sphere", radius: 1 }, { x: 4, y: 0, z: 0 }),
    );
    settle();

    expect(store.parts().filter((part) => part.id === handed)).toHaveLength(1);
  });

  it("skips an id that is not of the shape it hands out", () => {
    // **Because it asks the model rather than parsing the ids.** A file's ids are
    // caller-chosen, so there is no numbering in them to resume from, and a counter that
    // continued from the highest `part-N` it could find would miss anything else.
    const store = createModelStore([
      placedPart("head", { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    ]);
    let handed = store.nextId();
    while (handed === "head") handed = store.nextId();

    expect(handed).not.toBe("head");
  });

  it("does not reuse a number after the part holding it is deleted", () => {
    // **`Part.id` promises this**, and a selection, an undo entry and a save file all refer to
    // an id meaning one thing at one time.
    const store = createModelStore();
    const first = store.nextId();
    store.add(
      placedPart(first, { type: "Sphere", radius: 1 }, { x: 0, y: 0, z: 0 }),
    );
    settle();
    store.remove(first);
    settle();

    expect(store.nextId()).not.toBe(first);
  });
});

describe("load", () => {
  const three = [sphereAt("a", 0), sphereAt("b", 2), sphereAt("c", 4)];

  it("replaces the whole model", () => {
    const store = createModelStore(three);
    expect(store.load([sphereAt("x", 9)], "open")).toBe(true);
    settle();
    expect(shape(store)).toEqual(["x@9"]);
  });

  it("is one undo step rather than a removal per part", () => {
    // **What a person who opens a file and presses ctrl-z wants.** The model they had, not the
    // model minus the parts the file happened to add — and a hundred removals would be a
    // hundred entries against a limit of a hundred.
    const store = createModelStore(three);
    store.load([sphereAt("x", 9), sphereAt("y", 11)], "open");
    settle();

    store.undo();
    settle();
    expect(shape(store)).toEqual(["a@0", "b@2", "c@4"]);
  });

  it("redoes as the load it undid", () => {
    const store = createModelStore(three);
    store.load([sphereAt("x", 9)], "open");
    settle();
    store.undo();
    settle();
    store.redo();
    settle();
    expect(shape(store)).toEqual(["x@9"]);
  });

  it("puts the old parts back where they were, not at the end", () => {
    // **Order is the fold order**, so a restore that appended would produce a different solid
    // from the same parts — invisibly, because a union looks the same however it is arranged,
    // until a `Subtract` is in the list.
    const store = createModelStore(three);
    store.load([sphereAt("x", 9)], "open");
    settle();
    store.undo();
    settle();
    store.add(sphereAt("added", 6));
    settle();

    expect(shape(store)).toEqual(["a@0", "b@2", "c@4", "added@6"]);
  });

  it("throws the redo branch away, like any other edit", () => {
    const store = createModelStore(three);
    store.transform("a", { origin: { x: 1, y: 0, z: 0 } });
    settle();
    store.undo();
    settle();
    store.load([sphereAt("x", 9)], "open");
    settle();

    expect(store.canRedo()).toBe(false);
  });

  it("labels the step, so ctrl-z says what it is undoing", () => {
    const store = createModelStore(three);
    store.load([sphereAt("x", 9)], "open duck.sdfmod");
    settle();
    expect(store.undoLabel()).toBe("open duck.sdfmod");
  });

  it("restores the selection it had, not the first part of the new model", () => {
    // **Undoing an open is getting back to the state before it**, and which part happened to
    // be selected is part of that state.
    const store = createModelStore(three);
    store.select("b");
    settle();
    store.load([sphereAt("x", 9)], "open");
    settle();
    expect(store.selected()).toBe("x");

    store.undo();
    settle();
    expect(store.selected()).toBe("b");
  });

  it("selects the first part of what it loaded", () => {
    // **Rather than nothing**, because a model with parts in it and no selection shows an
    // empty transform panel, which reads as a broken application.
    const store = createModelStore(three);
    store.load([sphereAt("x", 9), sphereAt("y", 11)], "open");
    settle();
    expect(store.selected()).toBe("x");
  });

  it("selects nothing when it loaded nothing", () => {
    const store = createModelStore(three);
    store.load([], "open");
    settle();
    expect(store.selected()).toBeUndefined();
  });

  it("refuses more parts than the store would hold", () => {
    // **And refuses them before writing anything**, so the model is left exactly as it was
    // rather than half-replaced.
    const store = createModelStore(three);
    const tooMany = Array.from({ length: MAX_PARTS + 1 }, (_, i) =>
      sphereAt(`p${i}`, i),
    );

    expect(store.load(tooMany, "open")).toBe(false);
    settle();
    expect(shape(store)).toEqual(["a@0", "b@2", "c@4"]);
    expect(store.canUndo()).toBe(false);
  });

  it("refuses two parts sharing one id", () => {
    // **Because `add` refuses them too, and a load must not be a way around that.** Two ids
    // that are the same string are one part as far as a selection is concerned.
    const store = createModelStore(three);
    expect(store.load([sphereAt("same", 0), sphereAt("same", 2)], "open")).toBe(
      false,
    );
    settle();
    expect(shape(store)).toEqual(["a@0", "b@2", "c@4"]);
  });

  it("loads an empty model, which is a thing a file can hold", () => {
    const store = createModelStore(three);
    expect(store.load([], "open")).toBe(true);
    settle();
    expect(shape(store)).toEqual([]);
  });
});
