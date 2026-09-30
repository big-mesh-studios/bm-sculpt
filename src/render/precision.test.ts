import { describe, expect, it } from "vitest";

import { choosePrecision, type FragmentPrecision } from "./precision";

const report = (over: Partial<FragmentPrecision> = {}): FragmentPrecision => ({
  lowpFloat: 5,
  mediumpFloat: 10,
  highpFloat: 23,
  lowpInt: 8,
  mediumpInt: 16,
  ...over,
});

describe("choosing a fragment precision", () => {
  it("takes highp where the device has it", () => {
    // What nearly every desktop reports, and what a 2016-class laptop reports.
    expect(choosePrecision(report())).toBe("highp");
  });

  it("falls back to mediump where highp is absent", () => {
    // The case the probe exists for. GLSL ES 3.0 makes `highp` optional in the
    // fragment stage, and a qualifier that is not supported is dropped
    // silently — so without this the shader would compile at mediump while
    // claiming highp, and the only symptom would be banded shading.
    expect(choosePrecision(report({ highpFloat: 0 }))).toBe("mediump");
  });

  it("falls back to lowp where only that is present", () => {
    expect(choosePrecision(report({ highpFloat: 0, mediumpFloat: 0 }))).toBe(
      "lowp",
    );
  });

  it("returns lowp rather than nothing where nothing is reported", () => {
    // Not `undefined`: the renderer's precision is left unset by undefined,
    // which is a different failure with a worse message. Zero is what
    // `choosePrecision` already reads as unavailable, so the one odd answer
    // flows into the branch that knows how to refuse it.
    expect(
      choosePrecision(report({ lowpFloat: 0, mediumpFloat: 0, highpFloat: 0 })),
    ).toBe("lowp");
  });

  it("reads availability from the float digits, not the integer ones", () => {
    // A surface is shaded from interpolated floats. An integer precision says
    // nothing about whether banding will appear, so a device reporting a wide
    // integer range and no highp floats is a device to shade at mediump. There
    // is no `highpInt` in the report at all, for the same reason: highp integers
    // are required by GLSL ES 3.0 and cannot go missing.
    expect(
      choosePrecision(report({ highpFloat: 0, lowpInt: 32, mediumpInt: 32 })),
    ).toBe("mediump");
  });

  it("treats one digit of float precision as available", () => {
    // A single digit is not worth having, but it is not the same as none, and
    // the alternative is refusing a precision the device does in fact offer.
    expect(choosePrecision(report({ highpFloat: 1 }))).toBe("highp");
    expect(choosePrecision(report({ highpFloat: 0, mediumpFloat: 1 }))).toBe(
      "mediump",
    );
  });
});
