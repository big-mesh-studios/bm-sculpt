/**
 * Reading and writing the operation list.
 *
 * Format version 1. A file holds the model and nothing else: no voxels, no mesh,
 * no field. That is the direct consequence of the field being computed rather than
 * stored (ADR 0002), and it makes a file's size a function of how much the user
 * has done rather than of how big the model is — a year of sculpting is kilobytes.
 *
 * The layout is fixed-width and little-endian, which makes it seekable and
 * impossible to misparse in a way that yields plausible numbers: a shape's
 * parameter count depends on its type, but its position does not, because every
 * shape's parameters are contiguous after the shape's type byte.
 *
 * ```
 * u16  version
 * u32  operationCount
 * per operation:
 *   u8   combine      0 Add, 1 Subtract, 2 Paint
 *   u8   shapeType    0 Ellipsoid, 1 Box, 2 Capsule
 *   f32  origin x, y, z
 *   f32  orientation x, y, z, w
 *   f32  softness
 *   ...  shape parameters, three f32 for Ellipsoid and Box, two for Capsule
 *   u8   colour r, g, b
 *   f32  opacity
 * ```
 */

import type { Quat, Vec3 } from "@big-mesh-studios/core";
import { COMBINE, type Combine, type Operation } from "./operations";
import {
  parameterFloats,
  parametersToFloats,
  primitiveFromCode,
  PRIMITIVES,
  shapeFromFloats,
  type OperationShape,
} from "@big-mesh-studios/sdf";

/**
 * The version this build writes, and the only one it can read.
 *
 * ## Why 3
 *
 * **Because a colour now means something on any operation, not only on a `Paint`.**
 * Every operation this build wrote before version 3 carries a `colour` field, and on
 * the brush that produced it was the brush's current colour — set on `Add` and
 * `Subtract` operations as well, with a comment saying the other modes ignored it.
 * They did ignore it. Under version 3 they do not, so **opening a version 2 file
 * would paint the entire model with whatever colour the brush happened to be
 * holding.** The bytes are all still there and all still parse; what changed is what
 * they mean, which is the one thing a version byte cannot leave ambiguous.
 *
 * ## The two earlier bumps
 *
 * **Version 2 was six new primitives and one changed one.** The six needed type bytes
 * version 1 did not have. The changed one was the capsule: it was `lenX`, along X, and
 * is now `len`, along Y — which this repository's gravity and its player both agree is
 * up. Reading the old bytes as the new ones would put a capsule's length where its
 * radius was.
 *
 * The three original primitives kept their bytes across that bump (Ellipsoid 0, Box 1,
 * Capsule 2), which the table's test asserts. That does **not** make a version 1 file
 * readable: a v1 operation is 34 or 30 bytes depending on its shape and a v2 one is 40
 * or 36, so the counts disagree and the reader refuses the version before it reads an
 * operation. Keeping the bytes means a reader can be told what the numbers meant, not
 * that the files are interchangeable.
 */
export const FORMAT_VERSION = 3;

/**
 * Bytes one operation takes, apart from its shape's parameters: the combine mode,
 * the shape type, an origin, an orientation, a softness, a colour and an opacity.
 */
const FIXED_BYTES = 1 + 1 + 3 * 4 + 4 * 4 + 4 + 3 + 4;

/** The colour written when an operation somehow has none, matching the default. */
const WHITE = { r: 255, g: 255, b: 255 };

/**
 * Bytes one operation takes.
 *
 * **The parameter count comes from the table now**, which is the point of ADR 0025:
 * it used to be a conditional on `shape.type === "Capsule"`, and a fourth primitive
 * with a different number of parameters would have been written by hand here and
 * disagreed with the reader by one float — which parses into plausible numbers
 * rather than failing.
 */
const shapeParameterCount = (shape: OperationShape): number =>
  parameterFloats(shape);

/** Bytes one operation takes. */
const operationBytes = (shape: OperationShape): number =>
  FIXED_BYTES + shapeParameterCount(shape) * 4;

/** A malformed file, named rather than thrown as a bare `Error`. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const combineFromCode = (code: number): Combine => {
  switch (code) {
    case COMBINE.Add:
      return "Add";
    case COMBINE.Subtract:
      return "Subtract";
    case COMBINE.Paint:
      return "Paint";
    default:
      throw new FormatError(`operation ${code} is not a combine mode`);
  }
};

const codeFromCombine = (combine: Combine): number => {
  switch (combine) {
    case "Add":
      return COMBINE.Add;
    case "Subtract":
      return COMBINE.Subtract;
    case "Paint":
      return COMBINE.Paint;
  }
};

/**
 * Reads a shape's parameters. The type byte is not among them — it was read as part
 * of the operation's fixed part, where the format puts it, and this reads from
 * straight after the softness. Writing it here as well is how the two sides came to
 * disagree by one byte, which parses into plausible-looking garbage.
 */
const readShape = (
  view: DataView,
  offset: number,
  type: number,
): { shape: OperationShape; next: number } => {
  const name = primitiveFromCode(type);
  if (name === null) {
    throw new FormatError(`shape type ${type} is not one this version writes`);
  }
  // The count comes from the table, and `shapeFromFloats` walks the same parameter
  // list to rebuild the shape, so the two cannot disagree about how wide a primitive
  // is. The dummy empty call is how that count is asked for without a shape in hand.
  const count = parameterFloats(shapeFromFloats(name, []));
  const floats: number[] = [];
  for (let i = 0; i < count; i++) {
    floats.push(view.getFloat32(offset + i * 4, true));
  }
  return { shape: shapeFromFloats(name, floats), next: offset + count * 4 };
};

/** Writes a shape's parameters, returning the offset after them. */
const writeShape = (
  view: DataView,
  offset: number,
  shape: OperationShape,
): number => {
  const floats = parametersToFloats(shape);
  for (let i = 0; i < floats.length; i++) {
    view.setFloat32(offset + i * 4, floats[i], true);
  }
  return offset + floats.length * 4;
};

/** The exact byte length a serialised list will take. */
export const serialisedSize = (operations: readonly Operation[]): number => {
  let bytes = 2 + 4;
  for (const operation of operations) bytes += operationBytes(operation.shape);
  return bytes;
};

/** Writes a list into a buffer sized by `serialisedSize`. */
export const serialiseOperations = (
  operations: readonly Operation[],
  target?: ArrayBuffer,
): ArrayBuffer => {
  const size = serialisedSize(operations);
  const buffer =
    target !== undefined && target.byteLength === size
      ? target
      : new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint16(0, FORMAT_VERSION, true);
  view.setUint32(2, operations.length, true);

  let at = 6;
  for (const operation of operations) {
    view.setUint8(at, codeFromCombine(operation.combine));
    view.setUint8(at + 1, PRIMITIVES[operation.shape.type].code);
    at += 2;
    view.setFloat32(at, operation.origin.x, true);
    view.setFloat32(at + 4, operation.origin.y, true);
    view.setFloat32(at + 8, operation.origin.z, true);
    at += 12;
    view.setFloat32(at, operation.orientation.x, true);
    view.setFloat32(at + 4, operation.orientation.y, true);
    view.setFloat32(at + 8, operation.orientation.z, true);
    view.setFloat32(at + 12, operation.orientation.w, true);
    at += 16;
    view.setFloat32(at, operation.softness, true);
    at += 4;
    at = writeShape(view, at, operation.shape);
    const colour = operation.colour ?? WHITE;
    view.setUint8(at, colour.r);
    view.setUint8(at + 1, colour.g);
    view.setUint8(at + 2, colour.b);
    view.setFloat32(at + 3, operation.opacity, true);
    at += 7;
  }
  return buffer;
};

/**
 * Reads a list back.
 *
 * Fails on a version it does not know rather than attempting it. A version number
 * that is not recognised is not a small incompatibility to be tolerated — the file
 * is a fixed-width record and reading a later one at this version's field widths
 * produces a list of plausible-looking primitives at plausible-looking positions,
 * which is worse than refusing.
 */
export const deserialiseOperations = (buffer: ArrayBuffer): Operation[] => {
  if (buffer.byteLength < 6) {
    throw new FormatError(
      `a file needs at least 6 bytes for its version and count, and this one is ${buffer.byteLength}`,
    );
  }
  const view = new DataView(buffer);
  const version = view.getUint16(0, true);
  if (version !== FORMAT_VERSION) {
    throw new FormatError(
      `this file is version ${version} and this build reads version ${FORMAT_VERSION}`,
    );
  }

  const count = view.getUint32(2, true);
  const operations: Operation[] = [];
  let at = 6;

  for (let i = 0; i < count; i++) {
    if (at + FIXED_BYTES > buffer.byteLength) {
      throw new FormatError(
        `operation ${i} of ${count} runs past the end of a ${buffer.byteLength} byte file`,
      );
    }
    const combine = combineFromCode(view.getUint8(at));
    const shapeType = view.getUint8(at + 1);
    at += 2;

    const origin: Vec3 = {
      x: view.getFloat32(at, true),
      y: view.getFloat32(at + 4, true),
      z: view.getFloat32(at + 8, true),
    };
    at += 12;
    const orientation: Quat = {
      x: view.getFloat32(at, true),
      y: view.getFloat32(at + 4, true),
      z: view.getFloat32(at + 8, true),
      w: view.getFloat32(at + 12, true),
    };
    at += 16;
    const softness = view.getFloat32(at, true);
    at += 4;

    const read = readShape(view, at, shapeType);
    at = read.next;
    const colour: { r: number; g: number; b: number } = {
      r: view.getUint8(at),
      g: view.getUint8(at + 1),
      b: view.getUint8(at + 2),
    };
    const opacity = view.getFloat32(at + 3, true);
    at += 7;

    operations.push({
      // Indexed by position in the file rather than stored, so that a list loaded
      // from a file and one built in this session have identical indices. Colour
      // resolution and undo both depend on index order, and a file that
      // disagreed with a live list about it would be a bug that only appeared after
      // a save and reload.
      index: i,
      origin,
      orientation,
      shape: read.shape,
      softness,
      combine,
      colour,
      opacity,
    });
  }

  return operations;
};
