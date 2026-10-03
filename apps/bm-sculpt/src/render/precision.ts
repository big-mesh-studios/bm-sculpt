/**
 * Which shader precision to compile at, and how to find out.
 *
 * GLSL ES 3.0 makes `highp` mandatory in the vertex stage and optional in the
 * fragment stage. A fragment shader that declares `highp` on a device without it
 * does not fail to compile — the qualifier is silently dropped — so nothing reports
 * the downgrade. The mesh goes on rendering, at the lower precision, and the only
 * symptom is banded lighting on a surface that should have been smooth. That is
 * exactly the kind of failure that reaches a user's screen rather than a console,
 * which is why it is measured here at boot instead of being assumed.
 *
 * Two consequences for the shape of this file, both learned the hard way.
 *
 * **A measurement that cannot report its own failure is not a measurement.** The first
 * version returned `undefined` from a bare `catch`, and the readout said "not probed" —
 * which is indistinguishable from "probed and the device has no WebGL 2". That is the
 * difference between a device that cannot run this renderer and a bug in the probe, and
 * the two call for opposite responses. So the probe returns a *reason*.
 *
 * **The part worth testing is the part that can be.** `probeFragmentPrecision` was
 * described here as "the thin part that needs a context", and so went untested — while
 * being the part that failed. It does not need a context, only an object with one
 * method, so it takes a structural type and is tested directly.
 */

import type { Precision } from "./precision-types";

export type { Precision };

/**
 * Reads a context's fragment-stage precision report.
 *
 * Structural rather than `WebGL2RenderingContext`, because what it needs is one method
 * and five constants. Taking the concrete type is what made it untestable and therefore
 * untested.
 */
export interface PrecisionContext {
  readonly FRAGMENT_SHADER: number;
  readonly LOW_FLOAT: number;
  readonly MEDIUM_FLOAT: number;
  readonly HIGH_FLOAT: number;
  readonly LOW_INT: number;
  readonly MEDIUM_INT: number;
  getShaderPrecisionFormat(
    shaderType: number,
    precisionType: number,
  ): { precision?: number } | null;
}

/** What a probe found, or why it found nothing. */
export type PrecisionProbe =
  | { readonly ok: true; readonly precision: Precision }
  | { readonly ok: false; readonly reason: string };

/**
 * The best precision this device can honour in the fragment stage.
 *
 * Floats are asked about before integers because a surface is shaded from interpolated
 * floats: an integer precision says nothing about whether banding will appear.
 * `mediump` on a fragment stage is ten bits of mantissa, which quantises a world
 * coordinate to roughly a thousand steps across the view, and that is enough to see on a
 * large flat surface — so the gap between the two is not one this code should pretend
 * does not exist.
 *
 * `lowp` is the floor because some contexts are reported as having no floating-point
 * precision at all, and returning nothing there would leave the renderer's `precision`
 * unset, which is a different failure with a worse message.
 */
export const choosePrecision = (caps: FragmentPrecision): Precision => {
  if (caps.highpFloat > 0) return "highp";
  if (caps.mediumpFloat > 0) return "mediump";
  return "lowp";
};

/** What a context reports about each precision in the fragment stage. */
export interface FragmentPrecision {
  lowpFloat: number;
  mediumpFloat: number;
  highpFloat: number;
  lowpInt: number;
  mediumpInt: number;
}

/**
 * Reads a context's fragment-stage precision report.
 *
 * The DOM types allow this query to answer null, which the specification's table of
 * guarantees has no case for but which a driver is free to produce. Read as zero:
 * zero is what `choosePrecision` already treats as "this precision is not available",
 * so the one odd answer flows into the decision that already knows how to refuse it.
 */
export const probeFragmentPrecision = (
  gl: PrecisionContext,
): FragmentPrecision => {
  const digits = (type: number): number => {
    const answer = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, type);
    return typeof answer?.precision === "number" ? answer.precision : 0;
  };
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
 * A context is created and handed straight back rather than kept: the renderer's own
 * context is the one that matters, and asking this one first keeps the question — which
 * precisions does this *device* support — from being answered by however the
 * application happens to have configured its own context first.
 */
export const detectFragmentPrecision = (): PrecisionProbe => {
  if (typeof document === "undefined") {
    return { ok: false, reason: "no document, so no context to probe" };
  }
  let gl: WebGL2RenderingContext | null = null;
  try {
    const canvas = document.createElement("canvas");
    gl = canvas.getContext("webgl2");
  } catch (reason) {
    return {
      ok: false,
      reason: `asking for a WebGL 2 context threw: ${message(reason)}`,
    };
  }

  if (gl === null) {
    // Worth distinguishing from every other failure here, because it is the one that
    // says the *renderer* cannot run at all rather than that this probe is wrong.
    return { ok: false, reason: "this browser gave no WebGL 2 context" };
  }

  try {
    return { ok: true, precision: choosePrecision(probeFragmentPrecision(gl)) };
  } catch (reason) {
    return {
      ok: false,
      reason: `reading precision caps threw: ${message(reason)}`,
    };
  } finally {
    // Always, including on the paths that returned above. A throwaway context that is
    // not released is a GPU context the page holds for its whole life, and browsers cap
    // how many a page may hold.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
};

/** The one line a readout shows for a probe's answer. */
export const describePrecision = (probe: PrecisionProbe): string =>
  probe.ok ? probe.precision : `unavailable — ${probe.reason}`;

const message = (reason: unknown): string =>
  reason instanceof Error ? reason.message : String(reason);
