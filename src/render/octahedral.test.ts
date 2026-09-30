import { describe, expect, it } from "vitest";

import {
  decodeOctahedral,
  decodeOctahedralSnorm16,
  encodeOctahedral,
  encodeOctahedralSnorm16,
  normalized,
  SNORM16_MAX,
  writeOctahedralNormal,
} from "./octahedral";

/** The angle between two directions, in degrees. */
const angleBetween = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number => {
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return (Math.acos(dot) * 180) / Math.PI;
};

/** Directions worth testing, spread over the whole sphere. */
const directions = (): Array<{ x: number; y: number; z: number }> => {
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let x = -3; x <= 3; x++) {
    for (let y = -3; y <= 3; y++) {
      for (let z = -3; z <= 3; z++) {
        out.push(normalized({ x, y, z }));
      }
    }
  }
  // The six axes and eight corners are the cases the fold's branches turn over
  // on, and a grid with three steps per axis does not land on any of them.
  for (const axis of [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ]) {
    out.push(axis);
  }
  return out;
};

describe("octahedral encoding", () => {
  it("round-trips every direction it is given", () => {
    // The fold and its inverse, in full precision, must be a bijection. A
    // failure here is a branch of the fold reading a value the other has
    // already written, which shows up as a handful of directions being wrong
    // rather than as a general drift.
    //
    // Not an exact comparison: the round trip is six divisions and a square root,
    // so the last bit is not preserved and claiming otherwise would be claiming
    // something false. Twelve decimal places is far tighter than any direction a
    // mesh will produce, and tight enough that a branch reading a stale value
    // — which is orders of magnitude wrong — cannot hide inside it.
    for (const n of directions()) {
      const back = decodeOctahedral(encodeOctahedral(n));
      expect(back.x).toBeCloseTo(n.x, 12);
      expect(back.y).toBeCloseTo(n.y, 12);
      expect(back.z).toBeCloseTo(n.z, 12);
    }
  });

  it("round-trips the poles and axes, where the fold's branches turn over", () => {
    const cases = [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: -1, z: 0 },
      {
        x: -0.5773502691896258,
        y: -0.5773502691896258,
        z: -0.5773502691896258,
      },
    ];
    for (const n of cases) {
      const back = decodeOctahedral(encodeOctahedral(n));
      expect(angleBetween(n, back)).toBeLessThan(1e-9);
    }
  });

  it("keeps a zero vector as the +Z pole rather than a NaN", () => {
    // A degenerate normal is what a mesh with a repeated vertex produces. It
    // must cost that one vertex, not poison every other one: NaN here would
    // propagate into the interleaved attribute array and out to the GPU.
    expect(encodeOctahedral({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0 });
    expect(decodeOctahedral({ x: 0, y: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalized({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("stays inside the square the fold maps onto", () => {
    for (const n of directions()) {
      const f = encodeOctahedral(n);
      expect(Math.abs(f.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(f.y)).toBeLessThanOrEqual(1);
    }
  });

  it("loses less than a tenth of a degree through the 16-bit channels", () => {
    // The budget that matters: sixteen bits per component against eight. An
    // `unorm8x4` pair would land near four tenths of a degree, which is visible
    // as banding on a smooth surface, and this is the number that says the
    // four-byte layout is worth taking.
    for (const n of directions()) {
      const [x, y] = encodeOctahedralSnorm16(n);
      const back = decodeOctahedral(decodeOctahedralSnorm16(x, y));
      expect(angleBetween(n, back)).toBeLessThan(0.1);
    }
  });

  it("writes into an interleaved array at the offset it is given", () => {
    const array = new Int16Array(8).fill(999);
    writeOctahedralNormal(array, 4, { x: 0, y: 1, z: 0 });

    // Untouched before the offset, which is what makes one call safe to make per
    // vertex in a loop rather than only for vertex zero.
    expect([...array.slice(0, 4)]).toEqual([999, 999, 999, 999]);
    expect(array[6]).toBe(999);
    expect(array[7]).toBe(999);

    // The +Y pole folds onto the origin of the square, so both channels are zero
    // and the decode of them is the pole.
    const back = decodeOctahedral(decodeOctahedralSnorm16(array[4], array[5]));
    expect(angleBetween({ x: 0, y: 1, z: 0 }, back)).toBeLessThan(0.1);
  });

  it("keeps every encoded channel inside the signed 16-bit range", () => {
    for (const n of directions()) {
      for (const channel of encodeOctahedralSnorm16(n)) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(-SNORM16_MAX);
        expect(channel).toBeLessThanOrEqual(SNORM16_MAX);
      }
    }
  });
});
