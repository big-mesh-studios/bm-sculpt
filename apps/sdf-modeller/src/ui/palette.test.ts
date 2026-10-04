// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flush } from "solid-js";

import { createPalette, PALETTE_LIMIT } from "./palette";

/** Solid 2 defers writes until the batch is flushed, so a read needs one. See ADR 0028. */
const settle = (): void => {
  flush();
};

const red = { r: 255, g: 0, b: 0, a: 255 };
const blue = { r: 0, g: 0, b: 255, a: 255 };

describe("a palette", () => {
  it("starts with whatever it was given, most recent first", () => {
    expect(createPalette([red, blue]).colours()).toEqual([red, blue]);
    expect(createPalette().colours()).toEqual([]);
  });

  it("remembers a new colour at the front, and says it changed", () => {
    const palette = createPalette([blue]);
    expect(palette.remember(red)).toBe(true);
    settle();
    expect(palette.colours()).toEqual([red, blue]);
  });

  it("says it did not change for a colour it already holds", () => {
    // **So the caller can skip an undo entry.** A palette that reported a change every time
    // would fill the history with no-ops, and ctrl-z would step through them doing nothing.
    const palette = createPalette([red]);
    expect(palette.remember(red)).toBe(false);
    settle();
    expect(palette.colours()).toEqual([red]);
  });

  it("compares alpha as well as colour, because a translucent red is a different colour", () => {
    const palette = createPalette([red]);
    expect(palette.remember({ ...red, a: 128 })).toBe(true);
    settle();
    expect(palette.colours()).toHaveLength(2);
    expect(palette.has({ ...red, a: 128 })).toBe(true);
    expect(palette.has(red)).toBe(true);
    expect(palette.has(blue)).toBe(false);
  });

  it("drops the oldest colour rather than refusing the newest", () => {
    // **Refusing would make the hundredth colour unpickable**, which is the one case where
    // a cap is actually felt. Dropping the oldest keeps the recent ones, which are the ones
    // anybody reaches for.
    const palette = createPalette();
    for (let i = 0; i < PALETTE_LIMIT + 5; i++) {
      palette.remember({ r: i, g: 0, b: 0, a: 255 });
    }
    settle();
    expect(palette.colours()).toHaveLength(PALETTE_LIMIT);
    // The five oldest are gone and the most recent is at the front.
    expect(palette.colours()[0]).toEqual({
      r: PALETTE_LIMIT + 4,
      g: 0,
      b: 0,
      a: 255,
    });
    expect(palette.has({ r: 0, g: 0, b: 0, a: 255 }), "the oldest went").toBe(
      false,
    );
  });

  it("forgets everything when asked", () => {
    const palette = createPalette([red, blue]);
    palette.clear();
    settle();
    expect(palette.colours()).toEqual([]);
  });

  it("holds a colour that differs only in alpha as a separate entry", () => {
    // **Alpha is part of the identity here**, and this is why: the picker has an alpha
    // slider, so a translucent version of a colour already in the row is a colour somebody
    // chose. Merging them would make the alpha slider unreachable for anything already
    // remembered.
    const palette = createPalette([red]);
    palette.remember({ ...red, a: 128 });
    settle();
    expect(palette.colours()).toHaveLength(2);
    expect(palette.has({ ...red, a: 128 })).toBe(true);
  });
});

describe("setting a palette outright, for a file being opened", () => {
  it("replaces every colour", () => {
    const palette = createPalette([red, blue]);
    palette.set([blue]);
    settle();
    expect(palette.colours()).toEqual([blue]);
  });

  it("takes an empty list, which is a file whose model was never painted", () => {
    const palette = createPalette([red]);
    palette.set([]);
    settle();
    expect(palette.colours()).toEqual([]);
  });

  it("keeps the order it was given, rather than reordering by use", () => {
    // **The order is the panel's, not the model's.** The panel shows the most recent first, so
    // a file's palette arrives in the order its author saw it and reopening it looks the same
    // as it did when it was saved.
    const palette = createPalette();
    palette.set([blue, red]);
    settle();
    expect(palette.colours()).toEqual([blue, red]);
  });

  it("caps at the limit rather than showing a longer list than a file asked for", () => {
    const palette = createPalette();
    const many = Array.from({ length: PALETTE_LIMIT + 4 }, (_, i) => ({
      r: i,
      g: 0,
      b: 0,
      a: 255,
    }));
    palette.set(many);
    settle();
    expect(palette.colours()).toHaveLength(PALETTE_LIMIT);
  });

  it("keeps the first of what it was given when it caps, rather than the last", () => {
    // **Which end it drops is the same question `remember` answers**, and the answer is the
    // oldest, because refusing or dropping the newest makes the colour somebody just chose the
    // one thing a cap actually costs.
    const palette = createPalette();
    const many = Array.from({ length: PALETTE_LIMIT + 1 }, (_, i) => ({
      r: i,
      g: 0,
      b: 0,
      a: 255,
    }));
    palette.set(many);
    settle();
    expect(palette.colours()[0]).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(palette.has({ r: PALETTE_LIMIT, g: 0, b: 0, a: 255 })).toBe(false);
  });

  it("does not copy the list it was given", () => {
    // **So a caller mutating its own array afterwards cannot change the palette** — which is
    // the difference between the palette holding a value and holding a reference to one.
    const mine = [red, blue];
    const palette = createPalette();
    palette.set(mine);
    settle();
    mine.push({ r: 0, g: 255, b: 0, a: 255 });
    expect(palette.colours()).toHaveLength(2);
  });
});
