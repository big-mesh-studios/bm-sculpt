import { describe, expect, it } from "vitest";
import { flush } from "solid-js";

import { fromEuler, type Part } from "./part";
import {
  HISTORY_LIMIT,
  MAX_PARTS,
  barePart,
  createModelStore,
} from "./model-store";

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
  barePart(id, { type: "Sphere", radius: 1 }, { x, y: 0, z: 0 });

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
