/**
 * Colour spaces, and the conversions between them.
 *
 * ## Why this is here rather than in an application
 *
 * **`Rgb8` was already here** — it is what `Operation.colour` is and what every layer
 * passes around — and a colour type with no way to *choose* a colour is only half a
 * vocabulary. Hue/saturation/value is the space a picker has to work in: it has a corner
 * that is "no hue at all", and eight-bit RGB has nowhere to put a hue, so a picker built
 * on RGB alone cannot represent a saturated red without the hue collapsing the moment
 * somebody touches a slider.
 *
 * So this is the third space, next to the first, rather than a component that would have
 * had to define its own types anyway.
 *
 * ## What is not here
 *
 * **No palette, and no notion of a named colour.** A palette is an application's memory of
 * what a person has used; which colours those are is a decision about a model, not about
 * colour. The conversions here are pure and have no state at all.
 *
 * ## Provenance
 *
 * Ported from the sibling monorepo's `packages/maths`, which had no tests for it. The
 * arithmetic is unchanged; what is new is the coverage, and the two conversions that are
 * easy to get subtly wrong are the ones asserted rather than assumed — the grey and black
 * cases in `fromRGBA`, where hue and saturation have no defined value.
 */

/** A colour as three 8-bit channels. What an operation carries. */
export interface Rgb8 {
  r: number;
  g: number;
  b: number;
}

/** A colour as four 8-bit channels, alpha included. What a picker carries. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const rgbaEquals = (a: RGBA, b: RGBA): boolean =>
  a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

export const rgbEquals = (a: Rgb8, b: Rgb8): boolean =>
  a.r === b.r && a.g === b.g && a.b === b.b;

/** A CSS colour, for a swatch or an inline style. */
export const rgbaToCss = ({ r, g, b, a }: RGBA): string =>
  `rgba(${r}, ${g}, ${b}, ${a / 255})`;

export const rgbToCss = ({ r, g, b }: Rgb8): string => `rgb(${r}, ${g}, ${b})`;

/**
 * Hue, saturation, value and alpha — the space a picker drags in.
 *
 * **Hue in degrees and the rest in `0..1`.** Degrees because a hue slider is a number a
 * person reads; a fraction because saturation and value are not read, only dragged, and
 * `0..1` is what a pointer's fraction across a track already is.
 */
export interface HSVA {
  /** Hue in degrees, `0..360`. */
  h: number;
  /** Saturation, `0..1`. */
  s: number;
  /** Value — brightness — `0..1`. */
  v: number;
  /** Alpha, `0..1`. */
  a: number;
}

export const hsvaEquals = (a: HSVA, b: HSVA): boolean =>
  a.h === b.h && a.s === b.s && a.v === b.v && a.a === b.a;

/**
 * Hue wrapped into `0..360`.
 *
 * **Wrapping rather than clamping, because a hue past 360 is a hue that has gone round.**
 * A track that ran past its end should land on the same colour it started from, and a
 * picker whose red end turned into something else would be a small trap in a control a
 * person drags by habit.
 */
const wrapHue = (h: number): number => ((h % 360) + 360) % 360;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * HSVA to 8-bit RGBA.
 *
 * **Hue wraps and the rest clamp, so no out-of-range input can produce an out-of-range
 * channel.** That matters because the result goes straight into a `DataView` or a byte
 * array somewhere downstream, where 256 is not a colour but a wrap.
 */
export const hsvaToRgba = (hsva: HSVA): RGBA => {
  const h = wrapHue(hsva.h);
  const s = clamp01(hsva.s);
  const v = clamp01(hsva.v);
  const a = clamp01(hsva.a);

  const chroma = v * s;
  const sector = h / 60;
  // Rises and falls across each pair of sectors, tracing the ramp between primaries.
  const ramp = chroma * (1 - Math.abs((sector % 2) - 1));
  const floor = v - chroma;

  const [r, g, b] =
    sector < 1
      ? [chroma, ramp, 0]
      : sector < 2
        ? [ramp, chroma, 0]
        : sector < 3
          ? [0, chroma, ramp]
          : sector < 4
            ? [0, ramp, chroma]
            : sector < 5
              ? [ramp, 0, chroma]
              : [chroma, 0, ramp];

  return {
    r: Math.round((r + floor) * 255),
    g: Math.round((g + floor) * 255),
    b: Math.round((b + floor) * 255),
    a: Math.round(a * 255),
  };
};

/**
 * 8-bit RGBA to HSVA.
 *
 * ## Not total, and the gap is the interesting part
 *
 * **Every grey has no defined hue, and black has neither hue nor saturation.** A grey has
 * three candidates for its maximum channel and the three formulae give three different
 * answers, so any of them is as good as another — and the answer that changes as a colour
 * is dragged through grey would make a picker's hue jump about while somebody adjusts the
 * brightness of a silver.
 *
 * So those components are taken from `fallback` instead, which is the hue and saturation
 * the picker currently has. A colour passing through a degenerate point keeps the choice
 * the person last made, and returning to where they were gives back the colour they had.
 */
export const rgbaToHsva = (rgba: RGBA, fallback: HSVA): HSVA => {
  const r = rgba.r / 255;
  const g = rgba.g / 255;
  const b = rgba.b / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;

  // `max === 0` implies `chroma === 0`, so black takes both fallbacks.
  const s = max === 0 ? fallback.s : chroma / max;
  const h =
    chroma === 0
      ? fallback.h
      : wrapHue(
          60 *
            (max === r
              ? (g - b) / chroma
              : max === g
                ? (b - r) / chroma + 2
                : (r - g) / chroma + 4),
        );

  return { h, s, v: max, a: rgba.a / 255 };
};

/** HSVA as a CSS colour, by way of the 8-bit conversion everything else goes through. */
export const hsvaToCss = (hsva: HSVA): string => rgbaToCss(hsvaToRgba(hsva));

/**
 * A byte triple from four channels, dropping alpha.
 *
 * **Here rather than at each call site**, because a picker handing an RGBA to something
 * that wants an `Rgb8` is the ordinary case and a cast at every such call is a chance to
 * forget.
 */
export const rgbaToRgb = ({ r, g, b }: RGBA): Rgb8 => ({ r, g, b });

/** The four channels of a triple, fully opaque. */
export const rgbToRgba = ({ r, g, b }: Rgb8, a = 255): RGBA => ({ r, g, b, a });

/** A colour as bytes, from an opacity in `0..1`. */
export const opacityToByte = (opacity: number): number =>
  Math.round(clamp01(opacity) * 255);

/** An opacity in `0..1`, from a byte. */
export const byteToOpacity = (alpha: number): number => clamp01(alpha / 255);
