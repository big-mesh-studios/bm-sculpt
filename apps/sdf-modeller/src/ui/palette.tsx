/**
 * A palette: the colours this model has used, and the picker that adds to them.
 *
 * ## Why the palette is part of the store and not of the panel
 *
 * **Because "the colours this model has used" is a fact about the model**, and a panel
 * that remembered them would lose them on the next remount — which on a phone is every
 * rotation, since a width query tears a layout down and rebuilds it.
 *
 * ## Why the palette is part of undo
 *
 * **Because adding a colour to the palette is an edit.** It changes what the model can be
 * expressed in, and a person who adds a colour, changes their mind about the part, and
 * presses ctrl-z expects the part to change back — not to have the palette also rewind and
 * take the colour with it. So the palette's history entries are no-ops on undo, which is
 * the cheapest way to be honest about the fact that nothing about the model changed.
 *
 * ## Why nothing adds to it automatically
 *
 * **Because a drag on the picker is not a decision to remember a colour.** The picker's
 * `onColour` fires on every pointer move, so a single swipe across the chart arrives as
 * dozens of distinct colours. An earlier version of this panel called `remember` from the
 * colour setter, which meant one gesture filled the palette and pushed out the colours the
 * person had actually chosen — the cap made it a fixed-size flood rather than a growing one.
 *
 * So the palette only ever changes because somebody tapped the **add** box. Dragging changes
 * the part being edited and nothing else, and keeping a colour is one deliberate tap.
 *
 * ## Why it is capped
 *
 * **Because it is unbounded memory attached to a document.** There is no upper bound on how
 * many colours a person might try, and every one of them is four bytes plus a swatch, which
 * is small until it is ten thousand. The cap is reached by dropping the least recently used
 * entry, not by refusing the newest — refusing would make a colour that happens to be the
 * hundredth unpickable, which is the one case where a cap is actually felt.
 */
import { createSignal } from "solid-js";

import { rgbEquals, rgbaToCss, type RGBA } from "@big-mesh-studios/core";

import styles from "./palette.module.css";

/**
 * How many colours are remembered.
 *
 * **Thirty-two, and the number is about the panel rather than about memory.** A row of
 * swatches on a phone fits about five across, so thirty-two is six rows — enough that
 * nobody has to remember anything they used three colours ago, and few enough that the
 * whole list is visible without scrolling on the device this was built for.
 */
export const PALETTE_LIMIT = 32;

export interface Palette {
  readonly colours: () => readonly RGBA[];
  /** Whether the given colour is already in the palette. */
  readonly has: (colour: RGBA) => boolean;
  /**
   * Adds a colour, or moves an existing one to the most-recent end.
   *
   * Returns whether the palette changed, so a caller can skip an undo entry when the
   * colour was already there.
   */
  readonly remember: (colour: RGBA) => boolean;
  /**
   * Replaces every colour, for a file being opened.
   *
   * **And not part of undo**, for the same reason `remember` is not: a palette entry is not a
   * fact about the model's geometry, so rewinding it alongside would take a colour away from a
   * model that is still using it. Opening a file sets the palette outside the history entirely,
   * which is the honest description of what happened — the colours arrived with the parts.
   *
   * **Capped at `PALETTE_LIMIT` like `remember`, dropping from the end.** A file may name more
   * colours than the panel shows, and the alternative to dropping is showing a list whose length
   * a file decides.
   */
  readonly set: (colours: readonly RGBA[]) => void;
  /** Forgets every colour. */
  readonly clear: () => void;
}

export const createPalette = (initial: readonly RGBA[] = []): Palette => {
  // Most-recent first, because the top of a list is what somebody reaches for and the
  // bottom is what they scroll to.
  const [colours, setColours] = createSignal<readonly RGBA[]>([...initial]);

  const sameColour = (a: RGBA, b: RGBA): boolean =>
    rgbEquals(a, b) && a.a === b.a;

  return {
    colours,

    has: (colour) => colours().some((held) => sameColour(held, colour)),

    /**
     * **Composed through the setter's updater rather than read-then-write.**
     *
     * Solid 2 defers a signal write until the batch is flushed, so reading `colours()` and
     * then assigning would compose against a *stale* value whenever two colours are
     * remembered inside one batch — and the second would replace the first rather than join
     * it. The updater form composes against the pending value, which is what it exists for.
     */
    remember: (colour) => {
      const existing = colours();
      if (existing.some((held) => sameColour(held, colour))) return false;
      setColours((pending) =>
        // Dropped from the end, so the oldest falls off rather than the newest.
        [colour, ...pending].slice(0, PALETTE_LIMIT),
      );
      return true;
    },

    clear: () => {
      setColours([]);
    },

    set: (incoming) => {
      // **Written as one array rather than through `remember` in a loop**, because `remember`
      // reads `colours()` before writing and Solid 2 defers the write — so thirty-two calls in a
      // row would each compose against the same stale list and the last one would win. The
      // updater form composes against the pending value, which is what it is for.
      setColours([...incoming].slice(0, PALETTE_LIMIT));
    },
  };
};

export function PaletteRow(props: {
  palette: Palette;
  /**
   * The colour currently being edited.
   *
   * **Read rather than stored, because it belongs to the part and not to the palette.** It
   * is what the add box offers to remember and what marks a swatch as the one in use.
   */
  colour: RGBA;
  onPick: (colour: RGBA) => void;
  /** Adds `colour` to the palette. The only thing in the application that can. */
  onAdd: (colour: RGBA) => void;
}) {
  return (
    <div class={styles.palette} aria-label="Colours used in this model">
      {/*
        **The add box, first, and showing the colour it would add.**
        *
        A blank box would ask somebody to remember what they just chose and trust that it is
        the right one; filling it with the current colour makes the tap a statement about a
        colour rather than about a place. It carries the same checkerboard as a swatch, so a
        translucent colour is legible in it too.
      */}
      <button
        type="button"
        class={styles.add}
        style={{ "--swatch": rgbaToCss(props.colour) }}
        aria-label={`add ${rgbaToCss(props.colour)} to the palette`}
        onClick={() => {
          props.onAdd(props.colour);
        }}
      >
        +
      </button>
      {props.palette.colours().length === 0 ? (
        <p class={styles.empty}>colours you use are kept here</p>
      ) : (
        props.palette.colours().map((colour, index) => (
          <button
            type="button"
            // **The ring marks the swatch the model is using right now**, which is the one
            // a person looks for after picking something new. Alpha is compared too,
            // because a swatch with no alpha and the same RGB is a different colour here.
            // A template rather than `classList`, which Solid's DOM does not have.
            class={`${styles.swatch}${
              rgbEquals(colour, props.colour) && colour.a === props.colour.a
                ? ` ${styles.current}`
                : ""
            }`}
            style={{ "--swatch": rgbaToCss(colour) }}
            aria-label={`use ${rgbaToCss(colour)}`}
            onClick={() => {
              props.onPick(colour);
            }}
          >
            {/* An index so that two identical colours are still two keys, and so that
                removing one does not shift the other. */}
            {index}
          </button>
        ))
      )}
    </div>
  );
}
