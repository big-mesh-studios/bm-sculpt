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

import type { Part } from "./part";
import { partsToOperations } from "./mesh-model";
import type { Operation } from "@big-mesh-studios/csg";
import type { Quat, Rgb8, Vec3 } from "@big-mesh-studios/core";

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
  /**
   * Whether this part unions or subtracts.
   *
   * Part of the transform rather than of the shape because that is what it is: the same
   * primitive in the same place is a different solid under a different boolean, and the
   * panel that changes it is the same one that changes where the part is.
   */
  readonly combine?: Part["combine"];
  /** How far the boolean blends. Zero is a hard edge; see `Part.softness`. */
  readonly softness?: number;
  /**
   * The colour this part is painted.
   *
   * **`undefined` clears it**, which is not the same as not passing the field — a caller
   * that wants a part to stop having a colour of its own has to be able to say so, and a
   * `colour?: Rgb8` that fell back to the old value could not. The panel passes
   * `undefined` explicitly for that.
   */
  readonly colour?: Rgb8 | undefined;
  /** How opaque the colour is, `0..1`. Read only where a colour is set. */
  readonly opacity?: number;
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

  /**
   * A part id nothing in this model is using.
   *
   * **The store hands these out rather than the panel that adds parts**, for two reasons and
   * the second is the one that bit. The first is that two callers must not be able to hand out
   * the same id, which is what a shared allocator is for. The second is that **opening a file
   * brings ids with it**: a file saved with `part-1`, `part-2` and `part-3` would otherwise be
   * followed by a panel whose counter was still at one, and the next part a person added would
   * be refused by `add` for colliding with a part that is already on screen. So this skips any
   * id the model currently holds.
   *
   * Never reuses a number either, because `Part.id` promises that and an undo entry, a selection
   * and a save file all refer to an id meaning one thing at one time.
   */
  readonly nextId: () => string;

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

  /**
   * Replaces the whole model, as one undoable step.
   *
   * **One step rather than a removal per part**, because a person who opens a file and presses
   * ctrl-z wants the model they had, not the model minus the parts the file happened to add.
   * A hundred removals would also be a hundred history entries against a limit of a hundred.
   *
   * **Refused for more than `MAX_PARTS` parts or for two parts sharing an id.** The first is
   * the budget `add` enforces and a file is not a way around it; the second would make a
   * selection, an undo entry and a save file each ambiguous about which part they name.
   */
  readonly load: (parts: readonly Part[], label: string) => boolean;

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

/**
 * The next part number.
 *
 * **Module state, and that is the point.** An id has to be unique in a model, and a counter
 * held by whichever component happened to add a part last cannot be — two panels, or a panel
 * and a keyboard shortcut, would both start at one. See `ModelStore.nextId`, which also skips
 * ids the model already holds so that opening a file cannot collide with it.
 */
let handed = 1;

const sameVec3 = (a: Vec3, b: Vec3): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;

const sameQuat = (a: Quat, b: Quat): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;

/** Colours compare by value, and an absent colour is not the same as a black one. */
const sameColour = (a: Rgb8 | undefined, b: Rgb8 | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.r === b.r && a.g === b.g && a.b === b.b;

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
              combine: change.combine ?? part.combine,
              softness: change.softness ?? part.softness,
              colour: "colour" in change ? change.colour : part.colour,
              opacity: change.opacity ?? part.opacity,
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

    nextId: () => {
      // **The skip is what makes opening a file safe, and it is why this is not a parse of the
      // ids already held.** A file's ids are caller-chosen — `body`, `arm`, whatever — so there
      // is no numbering in them to continue from, and a counter that tried to resume from the
      // highest `part-N` it could find would miss any id that is not of that shape. Asking the
      // model what it holds is a linear scan of at most `MAX_PARTS` entries, once per tap.
      let candidate = `part-${handed++}`;
      while (parts().some((part) => part.id === candidate)) {
        candidate = `part-${handed++}`;
      }
      return candidate;
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
      // **`colour` is the one field where `undefined` means "clear it"** rather than
      // "leave it", so it is read off the key rather than coalesced with `??`.
      const nextShape = change.shape ?? existing.shape;
      const hasColour = "colour" in change;
      const nextColour = hasColour ? change.colour : existing.colour;
      const nextCombine = change.combine ?? existing.combine;
      const nextSoftness = change.softness ?? existing.softness;
      const unchanged =
        sameVec3(nextOrigin, existing.origin) &&
        sameQuat(nextOrientation, existing.orientation) &&
        nextShape === existing.shape &&
        nextCombine === existing.combine &&
        nextSoftness === existing.softness &&
        sameColour(nextColour, existing.colour);
      if (unchanged) return false;

      const before = {
        origin: existing.origin,
        orientation: existing.orientation,
        shape: existing.shape,
        combine: existing.combine,
        softness: existing.softness,
        colour: existing.colour,
        opacity: existing.opacity,
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

    load: (incoming, label) => {
      if (incoming.length > MAX_PARTS) return false;

      // **Both refusals checked before anything is written**, so a refused load leaves the
      // model exactly as it was rather than half-replaced. `add` refuses a duplicate id for the
      // same reason and `load` cannot be a way around it.
      const seen = new Set<string>();
      for (const part of incoming) {
        if (seen.has(part.id)) return false;
        seen.add(part.id);
      }

      // **Captured before the write, not read after it.** Solid 2 defers a signal write until
      // the batch is flushed, so a `parts()` read after `setParts` is the *old* list — which
      // would make `invert` restore the model that was just loaded.
      const before = parts();
      const wasSelected = selected();
      const next = [...incoming];
      // **The first part selected rather than nothing**, because a model with parts in it and
      // no selection shows an empty transform panel, which reads as a broken application
      // rather than as "nothing is selected".
      const nextSelected = next[0]?.id;

      const install = (): void => {
        setParts(next);
        setSelected(nextSelected);
      };

      install();
      record({
        label,
        apply: install,
        // **The selection goes back to what it was, not to the first part.** Undoing an open is
        // getting back to the state before it, and the part that happened to be selected before
        // is part of that state.
        invert: () => {
          setParts(before);
          setSelected(wasSelected);
        },
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
