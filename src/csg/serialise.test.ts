import { describe, expect, it } from "vitest";

import { makeOperation, type Combine, type Operation } from "./operations";
import {
  deserialiseOperations,
  FormatError,
  FORMAT_VERSION,
  serialisedSize,
  serialiseOperations,
} from "./serialise";

let seed = 0x1d7f3a9;
const next = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const randomVector = (scale: number) => ({
  x: Math.round((next() * 2 - 1) * scale * 1000) / 1000,
  y: Math.round((next() * 2 - 1) * scale * 1000) / 1000,
  z: Math.round((next() * 2 - 1) * scale * 1000) / 1000,
});
const randomRotation = () => {
  const q = {
    x: next() * 2 - 1,
    y: next() * 2 - 1,
    z: next() * 2 - 1,
    w: next() * 2 - 1,
  };
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return {
    x: Math.round((q.x / length) * 1e6) / 1e6,
    y: Math.round((q.y / length) * 1e6) / 1e6,
    z: Math.round((q.z / length) * 1e6) / 1e6,
    w: Math.round((q.w / length) * 1e6) / 1e6,
  };
};

const randomOperation = (index: number): Operation => {
  const combine = (["Add", "Subtract", "Paint"] as const)[
    Math.floor(next() * 3)
  ] as Combine;
  const shape =
    next() < 0.4
      ? ({ type: "Ellipsoid", radius: randomVector(1) } as const)
      : next() < 0.7
        ? ({ type: "Box", len: randomVector(1) } as const)
        : ({
            type: "Capsule",
            lenX: next() * 200,
            radius: next() * 50,
          } as const);
  return makeOperation(index, randomVector(600), shape, combine, {
    softness: Math.round(next() * 200) / 1000,
    orientation: randomRotation(),
    colour: {
      r: Math.floor(next() * 256),
      g: Math.floor(next() * 256),
      b: Math.floor(next() * 256),
    },
    opacity: Math.round(next() * 100) / 100,
  });
};

/**
 * Compares two numbers to float32 precision.
 *
 * The format stores 32-bit floats, which carry about seven significant decimal
 * digits. So the tolerance has to be *relative*: a fixed absolute tolerance tight
 * enough for a small value is far too tight for a large one — 322.69 comes back as
 * 322.6900024, which is wrong in the eighth digit and not wrong at all.
 */
const FLOAT32_RELATIVE = 1e-6;

const expectFloat32 = (
  actual: number,
  expected: number,
  where: string,
): void => {
  const tolerance = FLOAT32_RELATIVE * Math.max(1, Math.abs(expected));
  expect(
    Math.abs(actual - expected),
    `${where}: ${actual} vs ${expected}`,
  ).toBeLessThanOrEqual(tolerance);
};

/**
 * Compares two operation lists at float32 precision.
 *
 * Losing the last bits is not a defect to work around: a 10-unit voxel is being
 * carved, so a feature a ten-millionth of a unit across is not a thing anyone can
 * observe, and float32 is half the file size of float64. What matters is that every
 * *field* comes back — a shape whose radius read back as a capsule's length would
 * pass any tolerance check and still be wrong — so the comparison is structural and
 * only the numbers are approximate.
 */
const expectSameOperations = (
  back: Operation[],
  written: Operation[],
): void => {
  expect(back).toHaveLength(written.length);
  for (const [i, operation] of written.entries()) {
    const other = back[i];
    const where = `operation ${i}`;
    expect(other.index, where).toBe(operation.index);
    expect(other.combine, where).toBe(operation.combine);
    expect(other.shape.type, where).toBe(operation.shape.type);
    expectFloat32(other.origin.x, operation.origin.x, `${where} origin.x`);
    expectFloat32(other.origin.y, operation.origin.y, `${where} origin.y`);
    expectFloat32(other.origin.z, operation.origin.z, `${where} origin.z`);
    expectFloat32(
      other.orientation.x,
      operation.orientation.x,
      `${where} orientation.x`,
    );
    expectFloat32(
      other.orientation.y,
      operation.orientation.y,
      `${where} orientation.y`,
    );
    expectFloat32(
      other.orientation.z,
      operation.orientation.z,
      `${where} orientation.z`,
    );
    expectFloat32(
      other.orientation.w,
      operation.orientation.w,
      `${where} orientation.w`,
    );
    expectFloat32(other.softness, operation.softness, `${where} softness`);
    expect(other.colour, where).toEqual(operation.colour);
    expectFloat32(other.opacity, operation.opacity, `${where} opacity`);

    if (operation.shape.type === "Capsule" && other.shape.type === "Capsule") {
      expectFloat32(other.shape.lenX, operation.shape.lenX, `${where} lenX`);
      expectFloat32(
        other.shape.radius,
        operation.shape.radius,
        `${where} radius`,
      );
    } else if (
      operation.shape.type !== "Capsule" &&
      other.shape.type !== "Capsule"
    ) {
      const a =
        operation.shape.type === "Box"
          ? operation.shape.len
          : operation.shape.radius;
      const b =
        other.shape.type === "Box" ? other.shape.len : other.shape.radius;
      expectFloat32(b.x, a.x, `${where} axis x`);
      expectFloat32(b.y, a.y, `${where} axis y`);
      expectFloat32(b.z, a.z, `${where} axis z`);
    }
  }
};

describe("the operation list round trip", () => {
  it("reads back every field that was written", () => {
    const operations = Array.from({ length: 200 }, (_, i) =>
      randomOperation(i),
    );
    const back = deserialiseOperations(serialiseOperations(operations));
    expectSameOperations(back, operations);
  });

  it("round-trips an empty list", () => {
    expect(deserialiseOperations(serialiseOperations([]))).toEqual([]);
  });

  it("round-trips every shape type", () => {
    // Each shape has a different parameter count, so a format that assumed one size
    // would parse two of the three correctly and the third into the next operation.
    const operations = [
      makeOperation(
        0,
        { x: 1, y: 2, z: 3 },
        { type: "Ellipsoid", radius: { x: 4, y: 5, z: 6 } },
        "Add",
      ),
      makeOperation(
        1,
        { x: 1, y: 2, z: 3 },
        { type: "Box", len: { x: 4, y: 5, z: 6 } },
        "Subtract",
      ),
      makeOperation(
        2,
        { x: 1, y: 2, z: 3 },
        { type: "Capsule", lenX: 7, radius: 8 },
        "Add",
      ),
      makeOperation(
        3,
        { x: 1, y: 2, z: 3 },
        { type: "Capsule", lenX: 7, radius: 8 },
        "Paint",
        {
          colour: { r: 9, g: 10, b: 11 },
        },
      ),
    ];
    expect(deserialiseOperations(serialiseOperations(operations))).toEqual(
      operations,
    );
  });

  it("round-trips a rotated operation, rather than losing its orientation", () => {
    // An orientation is four floats that nothing else in the file repeats, so a
    // format that forgot it would produce a correctly-shaped primitive at the right
    // position pointing the wrong way — which looks like a renderer bug, not a file
    // bug.
    // Normalised here rather than written out by hand, because a quaternion that is
    // not quite unit fails the length assertion below for reasons that have nothing
    // to do with the format — and this test is about the round trip.
    const raw = { x: 0.183, y: -0.548, z: 0.732, w: 0.361 };
    const length = Math.hypot(raw.x, raw.y, raw.z, raw.w);
    const orientation = {
      x: raw.x / length,
      y: raw.y / length,
      z: raw.z / length,
      w: raw.w / length,
    };
    const operation = makeOperation(
      0,
      { x: 0, y: 0, z: 0 },
      { type: "Box", len: { x: 1, y: 2, z: 3 } },
      "Add",
      {
        orientation,
      },
    );
    const [back] = deserialiseOperations(serialiseOperations([operation]));
    for (const axis of ["x", "y", "z", "w"] as const) {
      expectFloat32(
        back.orientation[axis],
        orientation[axis],
        `orientation ${axis}`,
      );
    }
    // And it is still a unit quaternion to float32 precision, which is what the
    // distance functions assume when they rotate by it. They are not exact even so —
    // the error is around three parts in ten thousand — and it is three parts in ten
    // thousand of a 10-unit voxel, so nothing downstream can observe it.
    const roundTripped = Math.hypot(
      back.orientation.x,
      back.orientation.y,
      back.orientation.z,
      back.orientation.w,
    );
    expectFloat32(roundTripped, 1, "quaternion length");
  });
});

describe("the file format's size", () => {
  it("is exactly the buffer it hands back", () => {
    // The mesher's upload budget is denominated in bytes, and a size that is an
    // estimate is a budget that is wrong by whatever the estimate missed.
    for (const count of [0, 1, 7, 200]) {
      const operations = Array.from({ length: count }, (_, i) =>
        randomOperation(i),
      );
      const buffer = serialiseOperations(operations);
      expect(buffer.byteLength, `${count} operations`).toBe(
        serialisedSize(operations),
      );
    }
  });

  it("reuses a buffer of exactly the right size", () => {
    const operations = Array.from({ length: 20 }, (_, i) => randomOperation(i));
    const size = serialisedSize(operations);
    const target = new ArrayBuffer(size);
    expect(serialiseOperations(operations, target)).toBe(target);
  });

  it("allocates a fresh buffer when handed one of the wrong size", () => {
    const operations = Array.from({ length: 20 }, (_, i) => randomOperation(i));
    const wrong = new ArrayBuffer(serialisedSize(operations) + 1);
    const result = serialiseOperations(operations, wrong);
    expect(result).not.toBe(wrong);
    expect(result.byteLength).toBe(serialisedSize(operations));
  });

  it("scales with what the user did, not with how big the model is", () => {
    // The consequence of the field being computed rather than stored: a file's size
    // is a function of the operation count alone. A thousand operations is a few
    // tens of kilobytes — a saved voxel grid for the same model would have been
    // hundreds of megabytes.
    const thousand = Array.from({ length: 1000 }, (_, i) =>
      makeOperation(
        i,
        { x: 0, y: 0, z: 0 },
        { type: "Ellipsoid", radius: { x: 1, y: 1, z: 1 } },
        "Add",
      ),
    );
    // Fifty-three bytes an ellipsoid, fifty-three for a box, forty-nine for a
    // capsule, plus six for the header.
    expect(serialisedSize(thousand)).toBe(1000 * 53 + 6);
  });
});

describe("refusing a malformed file", () => {
  it("refuses a version it does not know", () => {
    // Read at this version's field widths, a later version's file would parse into a
    // list of plausible primitives at plausible positions. Refusing is better than
    // producing a model that is subtly not the one that was saved.
    const buffer = serialiseOperations([randomOperation(0)]);
    new DataView(buffer).setUint16(0, FORMAT_VERSION + 1, true);
    expect(() => deserialiseOperations(buffer)).toThrow(FormatError);
    expect(() => deserialiseOperations(buffer)).toThrow(/version/);
  });

  it("refuses a file too short to hold a header", () => {
    expect(() => deserialiseOperations(new ArrayBuffer(0))).toThrow(
      FormatError,
    );
    expect(() => deserialiseOperations(new ArrayBuffer(5))).toThrow(
      /at least 6 bytes/,
    );
  });

  it("refuses a count that runs past the end of the buffer", () => {
    // A truncated download, or a file whose count field is corrupt. Reading on would
    // return operations made of whatever followed.
    const operations = Array.from({ length: 10 }, (_, i) => randomOperation(i));
    const buffer = serialiseOperations(operations);
    new DataView(buffer).setUint32(2, 10000, true);
    expect(() => deserialiseOperations(buffer)).toThrow(FormatError);
    expect(() => deserialiseOperations(buffer)).toThrow(/runs past the end/);
  });

  it("refuses a shape type it does not know", () => {
    const buffer = serialiseOperations([randomOperation(0)]);
    // The shape's type byte sits after the two combine/shape bytes.
    new DataView(buffer).setUint8(6 + 1, 99);
    expect(() => deserialiseOperations(buffer)).toThrow(/shape type 99/);
  });

  it("refuses a combine mode it does not know", () => {
    const buffer = serialiseOperations([randomOperation(0)]);
    new DataView(buffer).setUint8(6, 99);
    expect(() => deserialiseOperations(buffer)).toThrow(
      /99 is not a combine mode/,
    );
  });

  it("names itself when it throws, rather than throwing a bare error", () => {
    try {
      deserialiseOperations(new ArrayBuffer(3));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FormatError);
      expect((error as FormatError).name).toBe("FormatError");
    }
  });
});

describe("indices after a load", () => {
  it("are assigned by position, so a loaded list orders like a live one", () => {
    // Colour resolution and undo both depend on index order. A file that disagreed
    // with a live list about it would be a bug that appears only after a save and
    // reload — the worst time for one.
    const operations = [
      makeOperation(
        17,
        { x: 0, y: 0, z: 0 },
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        "Add",
      ),
      makeOperation(
        99,
        { x: 5, y: 0, z: 0 },
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        "Add",
      ),
      makeOperation(
        3,
        { x: 9, y: 0, z: 0 },
        { type: "Box", len: { x: 1, y: 1, z: 1 } },
        "Add",
      ),
    ];
    const back = deserialiseOperations(serialiseOperations(operations));
    expect(back.map((operation) => operation.index)).toEqual([0, 1, 2]);
    // And the list order — which is what the fold runs in — survives, even though
    // the stored indices were not sequential.
    expect(back.map((operation) => operation.origin.x)).toEqual([0, 5, 9]);
  });
});
