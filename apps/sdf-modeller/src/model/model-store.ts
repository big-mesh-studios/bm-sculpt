/**
 * The model's store: parts, a selection, and an undo history.
 *
 * ## Why undo is a command with an inverse rather than a snapshot
 *
 * **Because a snapshot of a model is a list of primitives, and a model of a thousand parts
 * is a thousand primitives copied on every drag.** The sibling's editor learned this the
 * same way: each edit is paired with the command that undoes it, so undoing a transform
 * restores the numbers that were there before rather than reconstructing them from
 * something.
 *
 * A snapshot store is not wrong for a model this size, and it is much less code. It is
 * rejected here for two reasons that are about what happens next rather than about speed:
 * a snapshot cannot be *diffed*, so "what changed" is not answerable, and it cannot be
 * *sent*, so the file format and the multiplayer record (both of which are coming) would
 * have to be derived from the snapshots rather than from the edits.
 *
 * ## Why the history is a bounded stack
 *
 * **Because an unbounded history in a browser tab is a memory leak with a keyboard
 * shortcut.** `HISTORY_LIMIT` bounds it, and the oldest entry is dropped rather than the
 * newest, so undo walks back as far as it can and stops.
 */
import { createSignal, type Accessor } from "solid-js";

import { IDENTITY, type Part } from "./part";
import { partsToOperations } from "./mesh-model";
import type { Operation } from "@big-mesh-studios/csg";
import type { Quat, Vec3 } from "@big-mesh-studios/core";

/**
 * One undoable edit, as the edit and the edit that puts it back.
 *
 * **Two functions rather than a function that returns its own inverse.** The
 * returning-inverse form loses the original as soon as it is called: undoing pops a
 * command, calls it, gets the inverse, and now has no way to *redo* because the thing
 * that would have redone it is gone. It can be worked around by rebuilding an inverse of
 * the inverse, which is a second pair of closures per entry for a mistake that is easier
 * not to make. An entry moves between the two stacks untouched — undoing calls `invert`,
 * redoing calls `apply` — so there is one representation and one way to read it.
 */
export interface HistoryEntry {
  readonly label: string;
  readonly apply: () => void;
  readonly invert: () => void;
}

/**
 * How many edits are remembered.
 *
 * **A number rather than unlimited, and chosen by what a person actually undoes.** A
 * hundred is more than a modelling session's worth of deliberate steps and small enough
 * that holding them costs nothing measurable, because an entry is two closures and a
 * string rather than a copy of the model.
 */
export const HISTORY_LIMIT = 100;

/** What a caller may change about a part. */
export interface PartTransform {
  readonly origin?: Vec3;
  readonly orientation?: Quat;
  readonly shape?: Part["shape"];
}

export interface ModelStore {
  readonly parts: Accessor<readonly Part[]>;
  readonly selected: Accessor<string | undefined>;
  readonly canUndo: Accessor<boolean>;
  readonly canRedo: Accessor<boolean>;
  readonly undoLabel: Accessor<string | undefined>;
  readonly redoLabel: Accessor<string | undefined>;

  /** The CSG operations the current parts fold into, in list order. */
  readonly operations: Accessor<readonly Operation[]>;

  readonly part: (id: string) => Part | undefined;
  readonly select: (id: string | undefined) => void;

  /** Adds a part and selects it. Refused above `MAX_PARTS`. */
  readonly add: (part: Part) => boolean;
  /** Removes a part. Refused for an id that is not there. */
  readonly remove: (id: string) => boolean;
  /**
   * Changes a part's transform or shape.
   *
   * **Refused when nothing would change**, because an edit that changes nothing is an
   * undo step that undoes nothing, and a person pressing ctrl-z after a drag that did
   * not move should be taken further back rather than nowhere.
   */
  readonly transform: (id: string, change: PartTransform) => boolean;

  readonly undo: () => void;
  readonly redo: () => void;
}

/**
 * The most parts a model may hold.
 *
 * **A ceiling on the fold as much as on memory.** Every part is an operation the BVH
 * indexes, and the cost of a sample is the operations that reach it — so this bounds a
 * rebuild's worst case, which is what the meshing budget assumes it has.
 */
export const MAX_PARTS = 512;

const sameVec3 = (a: Vec3, b: Vec3): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;

const sameQuat = (a: Quat, b: Quat): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;

/**
 * Builds a store over an initial set of parts.
 *
 * **The factory takes its initial state rather than starting empty**, because a store that
 * can only be empty cannot be tested against a model that has something in it, and the
 * empty case is not the interesting one. A caller wanting an empty model passes `[]`.
 */
export const createModelStore = (initial: readonly Part[] = []): ModelStore => {
  const [parts, setParts] = createSignal<readonly Part[]>([...initial]);
  const [selected, setSelected] = createSignal<string | undefined>(
    initial.length > 0 ? initial[0]!.id : undefined,
  );

  // Two stacks rather than one list with a cursor, because a new edit after an undo
  // discards the redo branch and a cursor has to be clamped as well as truncated.
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  const [historyVersion, setHistoryVersion] = createSignal(0);

  const touched = (): void => {
    setHistoryVersion((n) => n + 1);
  };

  const record = (entry: HistoryEntry): void => {
    undoStack.push(entry);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    // **A new edit after an undo throws the redo branch away.** That is what every undo
    // stack does, and it is why the redo label is cleared rather than left pointing at an
    // edit that can no longer be reached.
    redoStack = [];
    touched();
  };

  const replace = (id: string, change: PartTransform): void => {
    setParts((current) =>
      current.map((part) =>
        part.id === id
          ? {
              ...part,
              origin: change.origin ?? part.origin,
              orientation: change.orientation ?? part.orientation,
              shape: change.shape ?? part.shape,
            }
          : part,
      ),
    );
  };

  const store: ModelStore = {
    parts,
    selected,
    // Each of these reads the version counter, so a change to either stack is a change
    // to what they return. Reading `undoStack.length` directly would not be reactive.
    canUndo: () => {
      historyVersion();
      return undoStack.length > 0;
    },
    canRedo: () => {
      historyVersion();
      return redoStack.length > 0;
    },
    undoLabel: () => {
      historyVersion();
      return undoStack[undoStack.length - 1]?.label;
    },
    redoLabel: () => {
      historyVersion();
      return redoStack[redoStack.length - 1]?.label;
    },

    operations: () => partsToOperations(parts()),

    part: (id) => parts().find((part) => part.id === id),

    select: (id) => {
      // Selecting an id that is not there clears the selection rather than setting it,
      // so a stale selection cannot survive the part it named being removed.
      setSelected(
        id !== undefined && parts().some((p) => p.id === id) ? id : undefined,
      );
    },

    add: (part) => {
      if (parts().some((existing) => existing.id === part.id)) return false;
      if (parts().length >= MAX_PARTS) return false;
      setParts((current) => [...current, part]);
      setSelected(part.id);
      record({
        label: `add ${part.id}`,
        apply: () => {
          setParts((current) => [...current, part]);
          setSelected(part.id);
        },
        invert: () => {
          setParts((current) =>
            current.filter((existing) => existing.id !== part.id),
          );
          setSelected(undefined);
        },
      });
      return true;
    },

    remove: (id) => {
      const existing = parts().find((part) => part.id === id);
      if (existing === undefined) return false;
      const wasSelected = selected() === id;
      // **The position is captured now, not looked up when the part comes back.** By then
      // it is gone, so `findIndex` answers -1 and the restore appends — which puts it
      // after everything added in the meantime. For a union that is invisible, which is
      // why it is worth the one line.
      const index = parts().findIndex((part) => part.id === id);
      setParts((current) => current.filter((part) => part.id !== id));
      setSelected(wasSelected ? undefined : selected());
      record({
        label: `remove ${id}`,
        // `apply` is the edit itself and `invert` puts it back, which for a removal means
        // the two are the reverse of what the order of the calls suggests: undoing a
        // removal *restores* the part. Writing them the other way round — which this did
        // first, and which compiled — makes undo a removal a second time.
        apply: () => {
          setParts((current) => current.filter((part) => part.id !== id));
          setSelected(undefined);
        },
        invert: () => {
          // **Restored at its old position, not appended.** A removed part that came back
          // at the end of the list would come back *after* every part added while it was
          // gone, and for a union that happens to look the same — which is exactly why it
          // would go unnoticed until the file format started recording order.
          setParts((current) => {
            const next = [...current];
            // Clamped, because the list may have shrunk since — a part removed and then
            // undone too would otherwise splice past the end, which `splice` tolerates
            // but which silently appends rather than restoring.
            next.splice(Math.min(index, next.length), 0, existing);
            return next;
          });
          if (wasSelected) setSelected(id);
        },
      });
      return true;
    },

    transform: (id, change) => {
      const existing = parts().find((part) => part.id === id);
      if (existing === undefined) return false;

      const nextOrigin = change.origin ?? existing.origin;
      const nextOrientation = change.orientation ?? existing.orientation;
      const nextShape = change.shape ?? existing.shape;
      const unchanged =
        sameVec3(nextOrigin, existing.origin) &&
        sameQuat(nextOrientation, existing.orientation) &&
        nextShape === existing.shape;
      if (unchanged) return false;

      const before = {
        origin: existing.origin,
        orientation: existing.orientation,
        shape: existing.shape,
      };
      replace(id, change);
      record({
        label: `change ${id}`,
        apply: () =>
          replace(id, {
            origin: nextOrigin,
            orientation: nextOrientation,
            shape: nextShape,
          }),
        invert: () => replace(id, before),
      });
      return true;
    },

    // **The entry moves between the stacks untouched.** Undo calls `invert` and redo
    // calls `apply`, so an undo followed by a redo is the original edit run twice and
    // nothing has to be reconstructed on the way.
    undo: () => {
      const entry = undoStack.pop();
      if (entry === undefined) return;
      entry.invert();
      redoStack.push(entry);
      touched();
    },

    redo: () => {
      const entry = redoStack.pop();
      if (entry === undefined) return;
      entry.apply();
      undoStack.push(entry);
      touched();
    },
  };

  return store;
};

/** A part with no rotation, for a store that has just been given a shape and a point. */
export const barePart = (
  id: string,
  shape: Part["shape"],
  origin: Vec3,
): Part => ({
  id,
  shape,
  origin,
  orientation: IDENTITY,
});
