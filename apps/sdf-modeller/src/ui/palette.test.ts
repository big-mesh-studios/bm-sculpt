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
