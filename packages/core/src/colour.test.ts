import { describe, expect, it } from "vitest";

import {
  byteToOpacity,
  hsvaToRgba,
  opacityToByte,
  rgbaToHsva,
  rgbaToRgb,
  rgbEquals,
  rgbToRgba,
  rgbaEquals,
} from "./colour";

const NEUTRAL = { h: 0, s: 0, v: 0, a: 1 };

describe("hue, saturation, value", () => {
  it("puts a fully saturated colour on the right sector of the wheel", () => {
    // Six sectors of 60°, and the primaries and secondaries sit on the boundaries. This
    // is the whole reason the conversion is a `switch` on `sector < n` rather than an
    // interpolation: an interpolation cannot cross a sector without passing through the
    // colour that is not between its neighbours.
    for (const [hue, expected] of [
      [0, { r: 255, g: 0, b: 0 }],
      [60, { r: 255, g: 255, b: 0 }],
      [120, { r: 0, g: 255, b: 0 }],
      [180, { r: 0, g: 255, b: 255 }],
      [240, { r: 0, g: 0, b: 255 }],
      [300, { r: 255, g: 0, b: 255 }],
      [360, { r: 255, g: 0, b: 0 }],
    ] as const) {
      const rgba = hsvaToRgba({ h: hue, s: 1, v: 1, a: 1 });
      expect({ h: hue, ...rgba }, `hue ${hue}`).toMatchObject({
        a: 255,
        ...expected,
      });
    }
  });

  it("gives white and black at the two ends of value", () => {
    expect(hsvaToRgba({ h: 0, s: 0, v: 1, a: 1 })).toMatchObject({
      r: 255,
      g: 255,
      b: 255,
    });
    expect(hsvaToRgba({ h: 0, s: 0, v: 0, a: 1 })).toMatchObject({
      r: 0,
      g: 0,
      b: 0,
    });
  });

  it("wraps a hue past the end of the wheel rather than clamping it", () => {
    // A track that ran past 360 should land on the colour it started from, not on a
    // different one — the picker drags by habit and will overshoot.
    expect(hsvaToRgba({ h: 360, s: 1, v: 1, a: 1 })).toEqual(
      hsvaToRgba({ h: 0, s: 1, v: 1, a: 1 }),
    );
    expect(hsvaToRgba({ h: 420, s: 1, v: 1, a: 1 })).toEqual(
      hsvaToRgba({ h: 60, s: 1, v: 1, a: 1 }),
    );
    expect(hsvaToRgba({ h: -60, s: 1, v: 1, a: 1 })).toEqual(
      hsvaToRgba({ h: 300, s: 1, v: 1, a: 1 }),
    );
  });

  it("clamps saturation and value rather than letting them out of range", () => {
    // **Because the result is bytes.** A channel of 256 or -1 is not a colour, it is a
    // wrap, and it would arrive somewhere downstream as a wrapped number with nothing to
    // say it had been wrong.
    const wild = hsvaToRgba({ h: 0, s: 4, v: 4, a: 4 });
    for (const channel of ["r", "g", "b", "a"] as const) {
      expect(wild[channel], channel).toBeGreaterThanOrEqual(0);
      expect(wild[channel], channel).toBeLessThanOrEqual(255);
    }
    expect(wild).toMatchObject({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("round-trips a saturated colour through its own 8-bit form", () => {
    for (const hue of [0, 37, 90, 150, 210, 275, 340]) {
      const original = { h: hue, s: 0.8, v: 0.6, a: 1 };
      const back = rgbaToHsva(hsvaToRgba(original), NEUTRAL);
      expect(back.h, `hue ${hue}`).toBeCloseTo(hue, 0);
      expect(back.v, `value ${hue}`).toBeCloseTo(0.6, 1);
      expect(back.s, `saturation ${hue}`).toBeCloseTo(0.8, 1);
    }
  });
});

describe("the conversions that have no answer", () => {
  it("keeps the fallback hue for a grey, because a grey has none", () => {
    // **The case a picker hits constantly**, and the one most likely to be got wrong:
    // three channels tie for the maximum, three formulae give three different hues, and
    // whichever is chosen changes as the colour is dragged through grey — so the hue
    // jumps about while somebody adjusts the brightness of a silver.
    // **Saturation is a different case from hue, and the difference is not a detail.**
    // A grey *has* a saturation and it is zero — that is what grey is — so only the hue
    // is undefined. Black is the one case where the saturation is undefined too, because
    // the formula that produces it divides by the maximum, which is zero there.
    for (const grey of [64, 128, 200, 255]) {
      const back = rgbaToHsva(
        { r: grey, g: grey, b: grey, a: 255 },
        {
          ...NEUTRAL,
          h: 210,
          s: 0.5,
        },
      );
      expect(back.h, `grey ${grey} keeps the fallback hue`).toBe(210);
      expect(back.s, `grey ${grey} is fully desaturated`).toBe(0);
      expect(back.v, `grey ${grey}`).toBeCloseTo(grey / 255, 6);
    }
  });

  it("keeps the fallback hue and saturation for black, which has neither", () => {
    // Black implies no chroma *and* no maximum, so it takes both fallbacks — and its
    // saturation would otherwise be a division by zero.
    const back = rgbaToHsva(
      { r: 0, g: 0, b: 0, a: 255 },
      {
        ...NEUTRAL,
        h: 42,
        s: 0.75,
      },
    );
    expect(back).toMatchObject({ h: 42, s: 0.75, v: 0, a: 1 });
    expect(Number.isFinite(back.s)).toBe(true);
  });

  it("comes back to the colour it had when a hue is restored from a grey", () => {
    // **The consequence the fallback exists for.** A person drags a colour down through
    // grey and back up; the colour they get must be the one they had.
    const chosen = { h: 300, s: 0.9, v: 0.8, a: 1 };
    const asBytes = hsvaToRgba(chosen);
    const throughGrey = rgbaToHsva(
      { r: 128, g: 128, b: 128, a: 255 },
      rgbaToHsva(asBytes, NEUTRAL),
    );
    const restored = rgbaToHsva(asBytes, throughGrey);
    expect(hsvaToRgba(restored)).toEqual(asBytes);
  });
});

describe("channels", () => {
  it("drops and adds alpha without touching the colour", () => {
    const rgba = { r: 1, g: 2, b: 3, a: 4 };
    expect(rgbaToRgb(rgba)).toEqual({ r: 1, g: 2, b: 3 });
    expect(rgba).toMatchObject({ a: 4 });
  });

  it("makes an opaque colour out of a triple by default", () => {
    expect(rgbToRgba({ r: 9, g: 8, b: 7 })).toEqual({
      r: 9,
      g: 8,
      b: 7,
      a: 255,
    });
    // And an alpha can be given, for the case where a triple came from something that has one.
    expect(rgbToRgba({ r: 9, g: 8, b: 7 }, 128).a).toBe(128);
  });

  it("compares by value, and only by value", () => {
    expect(rgbEquals({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 3 })).toBe(true);
    expect(rgbEquals({ r: 1, g: 2, b: 3 }, { r: 1, g: 2, b: 4 })).toBe(false);
    // Alpha is part of an RGBA and not of an RGB, so two colours differing only in
    // alpha are equal as triples and different as quadruples.
    expect(
      rgbEquals(rgbaToRgb({ r: 1, g: 2, b: 3, a: 0 }), { r: 1, g: 2, b: 3 }),
    ).toBe(true);
    expect(
      rgbaEquals({ r: 1, g: 2, b: 3, a: 0 }, { r: 1, g: 2, b: 3, a: 255 }),
    ).toBe(false);
  });

  it("converts an opacity to a byte and back", () => {
    // The mesh's vertex format is four bytes and `Operation.opacity` is a `0..1` float, so
    // this conversion happens at every vertex of every mesh and has to round-trip.
    for (const opacity of [0, 0.25, 0.5, 1]) {
      expect(byteToOpacity(opacityToByte(opacity)), `${opacity}`).toBeCloseTo(
        opacity,
        2,
      );
    }
    expect(opacityToByte(1), "fully opaque is 255").toBe(255);
    expect(opacityToByte(0), "fully clear is 0").toBe(0);
  });

  it("clamps an opacity into range rather than writing a byte out of one", () => {
    expect(opacityToByte(4)).toBe(255);
    expect(opacityToByte(-1)).toBe(0);
  });
});
