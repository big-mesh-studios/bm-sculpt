/**
 * Which shader precision to compile at, and how to find out.
 *
 * GLSL ES 3.0 makes `highp` mandatory in the vertex stage and optional in the
 * fragment stage. A fragment shader that declares `highp` on a device without it
 * does not fail to compile — the qualifier is silently dropped — so nothing
 * reports the downgrade. The mesh goes on rendering, at the lower precision, and
 * the only symptom is banded lighting on a surface that should have been
 * smooth. That is exactly the kind of failure that reaches a user's screen
 * rather than a console, which is why it is measured here at boot instead of
 * being assumed.
 *
 * The measurement itself is the standard `getShaderPrecisionFormat` query. What
 * is left is separating the decision from the measurement: `choosePrecision` is
 * pure and is what the tests drive, and `probeFragmentPrecision` is the thin
 * part that needs a context.
 */

/** The precisions RMSL compiles a program at, matching GLSL's own three. */
export type Precision = "lowp" | "mediump" | "highp";

/**
 * What a context reports about each precision in the fragment stage, as the
 * number of decimal digits it holds — zero meaning the qualifier is absent and
 * a declaration of it would be dropped.
 */
export interface FragmentPrecision {
  lowpFloat: number;
  mediumpFloat: number;
  highpFloat: number;
  lowpInt: number;
  mediumpInt: number;
}

/**
 * The best precision this device can honour in the fragment stage.
 *
 * Floats are asked about before integers because a surface is shaded from
 * interpolated floats: an integer precision says nothing about whether banding
 * will appear. `mediump` on a fragment stage is ten bits of mantissa, which
 * quantises a world coordinate to roughly a thousand steps across the view, and
 * that is enough to see on a large flat surface — so the gap between the two is
 * not one this code should pretend does not exist.
 *
 * `lowp` is the floor because some context is reported as having no floating
 * point precision at all, and returning `undefined` there would leave the
 * renderer's `precision` unset, which is a different failure with a worse
 * message.
 */
export const choosePrecision = (caps: FragmentPrecision): Precision => {
  if (caps.highpFloat > 0) return "highp";
  if (caps.mediumpFloat > 0) return "mediump";
  return "lowp";
};

/** Reads a context's fragment-stage precision report. */
export const probeFragmentPrecision = (
  gl: WebGL2RenderingContext,
): FragmentPrecision => {
  // The DOM types this is checked against allow the query to answer null, which
  // the specification's table of guarantees has no case for but which a driver
  // is free to produce. Read as zero: zero is what `choosePrecision` already
  // treats as "this precision is not available", so the one odd answer flows
  // into the decision that already knows how to refuse it.
  const digits = (type: number): number =>
    gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, type)?.precision ?? 0;
  return {
    lowpFloat: digits(gl.LOW_FLOAT),
    mediumpFloat: digits(gl.MEDIUM_FLOAT),
    highpFloat: digits(gl.HIGH_FLOAT),
    lowpInt: digits(gl.LOW_INT),
    mediumpInt: digits(gl.MEDIUM_INT),
  };
};

/**
 * The precision to build a renderer with, measured from a throwaway context.
 *
 * A context is created and handed straight back to the browser rather than being
 * kept: the renderer's own context is the one that matters, and asking this one
 * first keeps the question — which precisions does this device support — from
 * being answered by the context the application happens to configure first.
 *
 * A device that refuses a context at all is reported as `undefined` and the
 * caller uses its own default, because a renderer built on `null` would fail
 * with a less useful message than this one can give.
 */
export const detectFragmentPrecision = (): Precision | undefined => {
  if (typeof document === "undefined") return undefined;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (gl === null) return undefined;
    const precision = choosePrecision(probeFragmentPrecision(gl));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return precision;
  } catch {
    return undefined;
  }
};
