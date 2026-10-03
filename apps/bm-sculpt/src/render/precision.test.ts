import { describe, expect, it } from "vitest";

import {
  type FragmentPrecision,
  choosePrecision,
  describePrecision,
  probeFragmentPrecision,
} from "./precision";

const report = (over: Partial<FragmentPrecision> = {}): FragmentPrecision => ({
  lowpFloat: 5,
  mediumpFloat: 10,
  highpFloat: 23,
  lowpInt: 8,
  mediumpInt: 16,
  ...over,
});

/**
 * A stand-in for a context, holding only the caps.
 *
 * What `probeFragmentPrecision` needs is one method and five constants, so it can be
 * tested without a browser — which is the point of it taking a structural type. The
 * version that took a `WebGL2RenderingContext` was described as needing a context, and
 * so went untested, and it was the part that failed in a browser.
 */
const fakeContext = (
  caps: Partial<
    Record<"low" | "medium" | "high" | "lowInt" | "mediumInt", number | null>
  >,
) => ({
  FRAGMENT_SHADER: 0x8b30,
  LOW_FLOAT: 0x8df0,
  MEDIUM_FLOAT: 0x8df1,
  HIGH_FLOAT: 0x8df2,
  LOW_INT: 0x8df3,
  MEDIUM_INT: 0x8df4,
  getShaderPrecisionFormat(_shader: number, type: number) {
    const key =
      type === 0x8df0
        ? "low"
        : type === 0x8df1
          ? "medium"
          : type === 0x8df2
            ? "high"
            : type === 0x8df3
              ? "lowInt"
              : "mediumInt";
    if (!(key in caps)) {
      // A cap the test did not mention is absent, which is what zero means. Throwing
      // here instead reported "unexpected precision type 36339" for an omitted field,
      // sending the reader after the wrong constant.
      return { precision: 0 };
    }
    const value = caps[key as keyof typeof caps];
    return value === null ? null : { precision: value };
  },
});

describe("reading a context's precision caps", () => {
  it("reads the float and integer digits separately", () => {
    const caps = probeFragmentPrecision(
      fakeContext({ low: 7, medium: 10, high: 23, lowInt: 7, mediumInt: 10 }),
    );
    expect(caps).toEqual({
      lowpFloat: 7,
      mediumpFloat: 10,
      highpFloat: 23,
      lowpInt: 7,
      mediumpInt: 10,
    });
  });

  it("reads a null answer as zero rather than propagating it", () => {
    // The specification's table of guarantees has no case for this, but a driver is free
    // to produce it, and zero is already what `choosePrecision` treats as unavailable.
    const caps = probeFragmentPrecision(
      fakeContext({ low: 7, medium: 10, high: null }),
    );
    expect(caps.highpFloat).toBe(0);
    expect(choosePrecision(caps)).toBe("mediump");
  });

  it("reads an answer with no precision field as zero", () => {
    const gl = {
      ...fakeContext({ low: 7, medium: 10, high: 23 }),
      getShaderPrecisionFormat: () => ({}),
    };
    expect(probeFragmentPrecision(gl).highpFloat).toBe(0);
  });

  it("asks the fragment stage, not the vertex stage", () => {
    // GLSL makes highp mandatory in the vertex stage, so asking there would answer
    // "yes" on every device and settle nothing.
    const asked: number[] = [];
    const gl = fakeContext({ high: 23 });
    probeFragmentPrecision({
      ...gl,
      getShaderPrecisionFormat: (shader, type) => {
        asked.push(shader);
        return gl.getShaderPrecisionFormat(shader, type);
      },
    });
    expect(asked.every((shader) => shader === gl.FRAGMENT_SHADER)).toBe(true);
  });

  it("lets a failure inside the query reach the caller", () => {
    // Swallowed here it became a silent "not probed", which is indistinguishable from a
    // device with no WebGL 2 — a bug and a limitation that call for opposite responses.
    const gl = {
      ...fakeContext({ high: 23 }),
      getShaderPrecisionFormat: () => {
        throw new Error("context lost");
      },
    };
    expect(() => probeFragmentPrecision(gl)).toThrow(/context lost/);
  });
});

describe("describing a probe for the readout", () => {
  it("says the precision when there is one", () => {
    expect(describePrecision({ ok: true, precision: "highp" })).toBe("highp");
    expect(describePrecision({ ok: true, precision: "lowp" })).toBe("lowp");
  });

  it("says why when there is not", () => {
    // The whole point of the change: a readout that cannot distinguish "this device
    // cannot run the renderer" from "this probe is wrong" settles nothing.
    const described = describePrecision({
      ok: false,
      reason: "this browser gave no WebGL 2 context",
    });
    expect(described).toContain("no WebGL 2 context");
  });
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
