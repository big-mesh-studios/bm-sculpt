/**
 * The rules a payload's fields are checked against, and the checker that reads them.
 *
 * ## Why a table rather than a hand-written validator
 *
 * An effect arrives from a script this repository did not write, possibly from a peer, and
 * it is applied to the world. So it has to be validated — and a validator written as
 * twenty `if (typeof x !== "number")` chains is a place where the twenty-first field gets
 * forgotten. The symptom is not a crash: it is a field that is silently trusted, and a
 * peer that sends `"at": {"x": null}` gets an object where a vector should be.
 *
 * So the rules *are* the definition. `effects.ts` declares each tag as a list of fields
 * with a kind and a bound; this file turns that into a check. A tag that is declared is a
 * tag that is validated, because there is no second list to fall out of step with the
 * first. And because the rules are data, the same table is what a generated reference
 * document and the console's completion are read from — so the documentation cannot
 * describe a field the parser does not check, or omit one it does.
 *
 * ## The rules themselves
 *
 * Four ideas, and they are all there is:
 *
 * - **A field is present or absent.** No `undefined` in a payload, and no key that the
 *   rules do not mention — an unknown key is a peer sending something this build does not
 *   know how to validate, and accepting it is how a future field arrives at an old peer
 *   and gets ignored there while meaning something here.
 * - **A kind constrains shape, a bound constrains value.** `vec3` is three finite
 *   numbers; `MAX_COORDINATE` says how far out they may be. Two separate questions.
 * - **Every check is total.** Nothing throws, nothing reads a property it has not checked,
 *   and nothing recurses without a depth limit — a payload is untrusted input and the
 *   checker must survive anything, including a cyclic object, because the thing that
 *   validates a peer's data cannot be what crashes.
 * - **A payload is accepted or rejected whole.** There is no partial application, ever.
 */

import {
  MAX_CAUSE_LENGTH,
  MAX_CHANNEL,
  MAX_COORDINATE,
  MAX_DATA_KEY,
  MAX_DATA_KEYS,
  MAX_DATA_STRING,
  MAX_MOVEMENT_MULTIPLIER,
  MAX_NAME_LENGTH,
  MAX_OPACITY,
  MAX_PENDING_TIMERS,
  MAX_PLAYERS,
  MAX_PLAYER_ID_LENGTH,
  MAX_SHAPE_SIZE,
  MAX_SOFTNESS,
  MAX_TEXT_LENGTH,
  MAX_TIMER_MS,
  MAX_ZONE_NAME_LENGTH,
  MAX_ZONE_SIZE,
  MAX_LIGHT_INTENSITY,
  MAX_LIGHT_RADIUS,
  MAX_LIGHTS,
  MAX_MEDIUM_PUSH,
  MAX_MEDIUM_SPEED_SCALE,
  MAX_MEDIUMS,
  MAX_ZONES,
  MIN_SHAPE_SIZE,
} from "./limits";
import { Combine } from "@big-mesh-studios/csg";
import {
  PRIMITIVES,
  PRIMITIVE_NAMES,
  type ShapeType,
} from "@big-mesh-studios/sdf";

/** What a field's value has to be, before any bound is applied. */
export type FieldKind =
  /** A name: a map key, bounded in length. */
  | "name"
  /** Free text: a log line, a label. */
  | "text"
  /** A number with an explicit range. */
  | "number"
  /** A multiplier, which is a number from 0 to `MAX_MOVEMENT_MULTIPLIER`. */
  | "multiplier"
  /** A fraction, 0 to 1. */
  | "unit"
  /** An integer count. */
  | "count"
  /** A three-number vector. */
  | "vec3"
  /** A box's two corners, as a pair of `vec3`s. */
  | "box"
  /** A unit quaternion, four numbers in −1…1. */
  | "quat"
  /** `{r, g, b}` with each channel 0…255. */
  | "colour"
  /** One of the CSG combine modes. */
  | "combine"
  /** One of the three primitive shapes, with that shape's own fields. */
  | "shape"
  /** A unit quaternion, four numbers. */
  | "yaw"
  /** One of a fixed set of words. */
  | "enum"
  /** A boolean, and nothing else. Not 1, not "true", not null. */
  | "boolean";

/** One field of one payload: what it is, what it may be, and whether it must be there. */
export interface FieldRule {
  readonly name: string;
  readonly kind: FieldKind;
  /** Every field is optional unless this says otherwise. */
  readonly required?: boolean;
  /** For `enum`: the words, and only those. */
  readonly values?: readonly string[];
  /** For `count`: the most. Defaults to `MAX_*` for the kind. */
  readonly max?: number;
  /** For `number`-like kinds: the floor. */
  readonly min?: number;
  /** Documentation, carried so the generated reference can use it. */
  readonly about?: string;
}

/** Why a payload was refused, or `null` when it was not. Read by a test, never shown raw. */
export type Refusal = { readonly field: string; readonly why: string };

/**
 * The deepest an accepted value may nest.
 *
 * Shapes nest one level — a shape is an object of numbers — and that is all. The limit is
 * not about the vocabulary; it is that the checker walks whatever it is given, and a
 * payload from a peer may be arbitrarily deep or cyclic.
 */
const MAX_DEPTH = 4;

/** A plain object, as opposed to an array, a primitive, or null. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number, which is not what `typeof NaN` and `typeof Infinity` both say. */
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Checks one field.
 *
 * Returns a `Refusal` naming the field and what was wrong with it, or `null`. A refusal
 * always names a field so the log line a host writes can be read by whoever wrote the
 * script — "shape-add was rejected" is not a bug report, "shape-add was rejected:
 * at.x is not a finite number" is.
 */
export const checkField = (
  rule: FieldRule,
  value: unknown,
  depth = 0,
): Refusal | null => {
  const bad = (why: string): Refusal => ({ field: rule.name, why });
  if (depth > MAX_DEPTH) return bad("nested too deeply");

  switch (rule.kind) {
    case "name":
      if (typeof value !== "string") return bad("is not a string");
      if (value.length === 0) return bad("is empty");
      if (value.length > MAX_NAME_LENGTH) {
        return bad(`is longer than ${MAX_NAME_LENGTH} characters`);
      }
      return null;

    case "text":
      if (typeof value !== "string") return bad("is not a string");
      // The kind's default, overridable per field — a zone's label is a *name* as well as
      // text, and an identity that may be longer than a name is not one.
      if (value.length > (rule.max ?? MAX_TEXT_LENGTH)) {
        return bad(`is longer than ${rule.max ?? MAX_TEXT_LENGTH} characters`);
      }
      return null;

    case "number":
    case "multiplier":
    case "unit":
    case "count":
      if (!isNumber(value)) return bad("is not a finite number");
      return checkRange(rule, value, bad);

    case "yaw":
      if (!isNumber(value)) return bad("is not a finite number");
      // Not a quaternion: a yaw is one angle in radians, and the host turns it into one.
      if (value < -2 * Math.PI || value > 2 * Math.PI) {
        return bad("is not an angle in radians");
      }
      return null;

    case "quat":
      if (!Array.isArray(value) || value.length !== 4) {
        return bad("is not four numbers");
      }
      for (const part of value) {
        if (!isNumber(part))
          return bad("has a part that is not a finite number");
        if (part < -1 || part > 1) return bad("has a part outside -1 to 1");
      }
      return null;

    case "boolean":
      // Strictly a boolean. `1` and `"true"` would both be *accepted* by a truthiness
      // check and then mean something different to the peer that sent them and to the one
      // that did not, and a boolean is the one field type where that is a plausible bug
      // rather than a far-fetched one.
      if (typeof value !== "boolean") return bad("is not a boolean");
      return null;

    case "enum": {
      if (typeof value !== "string") return bad("is not a string");
      if (rule.values?.includes(value) !== true) {
        return bad(`is not one of: ${rule.values?.join(", ") ?? "none"}`);
      }
      return null;
    }

    case "combine": {
      if (value !== "Add" && value !== "Subtract" && value !== "Paint") {
        return bad("is not Add, Subtract or Paint");
      }
      return null;
    }

    case "vec3":
      return checkVec3(value, bad, MAX_COORDINATE);

    case "box": {
      if (!Array.isArray(value) || value.length !== 2) {
        return bad("is not a pair of corners");
      }
      for (let i = 0; i < 2; i++) {
        const refusal = checkVec3(value[i], bad, MAX_ZONE_SIZE);
        if (refusal !== null) return refusal;
      }
      return null;
    }

    case "colour": {
      if (!isPlainObject(value)) return bad("is not an object");
      for (const channel of ["r", "g", "b"] as const) {
        const part = value[channel];
        if (!isNumber(part)) return bad(`${channel} is not a finite number`);
        if (part < 0 || part > MAX_CHANNEL) {
          return bad(`${channel} is outside 0 to ${MAX_CHANNEL}`);
        }
        if (!Number.isInteger(part))
          return bad(`${channel} is not a whole number`);
      }
      return null;
    }

    case "shape":
      return checkShape(value, bad);
  }
};

/** The range check shared by the four numeric kinds, since the bounds differ per kind. */
const checkRange = (
  rule: FieldRule,
  value: number,
  bad: (why: string) => Refusal,
): Refusal | null => {
  // A count is a count: 1.5 zones is not one zone, it is a bug that would be read as "the
  // zone count was 1.5" by whoever tried to work out why the last zone did not appear.
  if (rule.kind === "count" && !Number.isInteger(value)) {
    return bad("is not a whole number");
  }
  const [low, high] = boundsFor(rule);
  if (value < low) return bad(`is below ${low}`);
  if (value > high) return bad(`is above ${high}`);
  return null;
};

/**
 * The range a numeric field may take, from its kind and its own `min`/`max`.
 *
 * **The kind supplies a default and the field may override it.** That ordering is the
 * point: a field that says nothing still gets a bound, so there is no way to write a field
 * with no limit — and a field that needs a different bound than its kind's default can say
 * so. `clock-speed`'s multiplier is a clock multiplier, not a walking speed, and a shared
 * ceiling of ten would have made a hundred-times day unreachable while a `player-speed`
 * field was allowed to go to ninety.
 */
const boundsFor = (rule: FieldRule): [number, number] => {
  switch (rule.kind) {
    case "multiplier":
      return [0, rule.max ?? MAX_MOVEMENT_MULTIPLIER];
    case "unit":
      return [0, rule.max ?? 1];
    case "count":
      return [0, rule.max ?? Number.MAX_SAFE_INTEGER];
    default:
      return [rule.min ?? -MAX_COORDINATE, rule.max ?? MAX_COORDINATE];
  }
};

const checkVec3 = (
  value: unknown,
  bad: (why: string) => Refusal,
  limit: number,
): Refusal | null => {
  if (!Array.isArray(value) || value.length !== 3) {
    return bad("is not three numbers");
  }
  for (const part of value) {
    if (!isNumber(part)) return bad("has a part that is not a finite number");
    if (part < -limit || part > limit) {
      return bad(`has a part outside -${limit} to ${limit}`);
    }
  }
  return null;
};

/**
 * Checks a primitive shape, and the fields that belong to that primitive.
 *
 * **The per-shape fields are the part worth reading.** Every primitive carries different
 * numbers: an ellipsoid a radius on each axis, a box a length on each axis, a capsule a
 * length and one radius, a torus a major and a minor radius. A checker that read all of
 * them for every shape would accept a capsule with a `len` object, and then the shape
 * would be built from a field it does not have — which is how a `len` of `undefined`
 * becomes a `NaN` origin three modules away, in the fold.
 *
 * So the shape's own keys are checked against the shape it names, and nothing else is
 * accepted.
 */
const checkShape = (
  value: unknown,
  bad: (why: string) => Refusal,
): Refusal | null => {
  if (!isPlainObject(value)) return bad("is not an object");
  const type = value["type"];
  if (typeof type !== "string" || !isShapeType(type)) {
    return bad(`has no type of ${SHAPE_TYPES.join(", ")}`);
  }

  const within = (n: unknown): boolean =>
    isNumber(n) && n >= MIN_SHAPE_SIZE && n <= MAX_SHAPE_SIZE;

  // **The fields are checked against the primitive table, one entry at a time.**
  //
  // This was a `switch` over three literal shape names, one branch per primitive, each
  // naming its own fields. This file held the sixth copy of that list; the other five
  // are the distance function, the half extents, the file format's read and its write,
  // and the parameter count that decides where they disagree. Every one had to be found
  // and edited to add a primitive, which is why `packages/sdf` now has one table.
  //
  // The property worth keeping is the one the old switch was built around: a shape's
  // keys are checked against the shape it names, and nothing else is accepted. A
  // checker that read every field for every shape would accept a capsule with a `len`
  // object, and the fold would build a shape from a field it does not have — a `NaN`
  // origin three modules away.
  const spec = PRIMITIVES[type];
  for (const parameter of spec.parameters) {
    const given = value[parameter.name];
    if (parameter.arity === 3) {
      if (!isPlainObject(given)) return bad(`has no ${parameter.name} object`);
      for (const axis of ["x", "y", "z"] as const) {
        if (!within(given[axis])) {
          return bad(
            `has a ${parameter.name}.${axis} outside ${MIN_SHAPE_SIZE} to ${MAX_SHAPE_SIZE}`,
          );
        }
      }
    } else if (!within(given)) {
      return bad(
        `has a ${parameter.name} outside ${MIN_SHAPE_SIZE} to ${MAX_SHAPE_SIZE}`,
      );
    }
  }

  // **And nothing but its own keys**, which is the other half of the rule. A `radius`
  // on a torus — which has `majorRadius` and `minorRadius` — is a payload this build
  // cannot check, and there is no safe reading of a field nobody validated.
  for (const key of Object.keys(value)) {
    if (key === "type") continue;
    if (!spec.parameters.some((parameter) => parameter.name === key)) {
      return bad(`has a ${key}, which ${type} does not take`);
    }
  }
  return null;
};

/**
 * Checks a whole payload against a list of rules.
 *
 * **A missing required field and an unknown field are both refusals**, and neither is
 * recoverable. The first is a script that did not say what it meant to; the second is a
 * peer sending something this build cannot check, and there is no safe reading of a field
 * nobody validated.
 *
 * Returns the *first* refusal, because a log line naming the first problem is more use
 * than one naming all of them, and because a malformed payload has no defined "rest".
 */
export const checkPayload = (
  rules: readonly FieldRule[],
  payload: unknown,
): Refusal | null => {
  if (!isPlainObject(payload))
    return { field: "", why: "payload is not an object" };

  for (const key of Object.keys(payload)) {
    if (!rules.some((rule) => rule.name === key)) {
      return { field: key, why: "is not a field this build knows" };
    }
  }

  for (const rule of rules) {
    const value = payload[rule.name];
    if (value === undefined) {
      if (rule.required === true) {
        return { field: rule.name, why: "is required and was not given" };
      }
      continue;
    }
    const refusal = checkField(rule, value);
    if (refusal !== null) return refusal;
  }
  return null;
};

/** One effect: its tag and the rules its payload is checked against. */
export interface EffectSpec {
  readonly tag: string;
  readonly fields: readonly FieldRule[];
  /** Documentation, carried so the generated reference can use it. */
  readonly about: string;
}

/**
 * The shape rule, restated so `effects.ts` does not import a CSG type for a *description*.
 *
 * The `shape` kind already carries the validation; this is the tag's own description of
 * which primitives exist, so a reader of `effects.ts` sees the vocabulary without having to
 * open `@big-mesh-studios/sdf`.
 */
export const shapeRule = (about: string): FieldRule => ({
  name: "shape",
  kind: "shape",
  about,
});

/** A name field, declared once because every payload that has one means the same thing. */
export const nameField = (
  name: string,
  required = true,
  about = "a name the caller chose, never generated",
): FieldRule => ({ name, kind: "name", required, about });

/**
 * Limits that are not per-field, re-exported so `effects.ts` reads its bounds from one
 * place rather than following an import chain.
 *
 * `MAX_OPERATIONS_PER_PLACE` is deliberately **not** here: it bounds the registry rather
 * than a payload, and it carries a measurement. It lives beside the code that enforces it.
 */
export const DATA_LIMITS = {
  keys: MAX_DATA_KEYS,
  key: MAX_DATA_KEY,
  value: MAX_DATA_STRING,
} as const;
/** Re-exported for the same reason. */
export const ZONE_LIMITS = {
  count: MAX_ZONES,
  name: MAX_ZONE_NAME_LENGTH,
  size: MAX_ZONE_SIZE,
} as const;

/** Re-exported for the same reason. */
export const MEDIUM_LIMITS = {
  count: MAX_MEDIUMS,
  push: MAX_MEDIUM_PUSH,
  speedScale: MAX_MEDIUM_SPEED_SCALE,
} as const;

/** Re-exported for the same reason. */
export const LIGHT_LIMITS = {
  count: MAX_LIGHTS,
  radius: MAX_LIGHT_RADIUS,
  intensity: MAX_LIGHT_INTENSITY,
} as const;
/** Re-exported for the same reason. */
export const TIMER_LIMITS = {
  ms: MAX_TIMER_MS,
  pending: MAX_PENDING_TIMERS,
} as const;
/** Re-exported for the same reason. */
export const PLAYER_LIMITS = {
  count: MAX_PLAYERS,
  id: MAX_PLAYER_ID_LENGTH,
} as const;
/** Re-exported for the same reason. */
export const CAUSE_LIMIT = MAX_CAUSE_LENGTH;
/** Re-exported for the same reason. */
export const OPACITY_LIMIT = MAX_OPACITY;
/** Re-exported for the same reason. */
export const SOFTNESS_LIMIT = MAX_SOFTNESS;

/** The combine modes, spelled once so a rule and a reader cannot disagree. */
export const COMBINES: readonly Combine[] = ["Add", "Subtract", "Paint"];

/**
 * The primitives a script may ask for, taken from the table.
 *
 * **This was a literal list of three names**, which is the shape the table was meant to
 * remove: a script asking for a `Cone` would have been refused with a message naming a
 * vocabulary this repository's own `sdf` package already had. Read from the table, a
 * primitive added there is available to every place immediately, with no second edit
 * and no way for the two lists to disagree.
 */
export const SHAPE_TYPES: readonly ShapeType[] = PRIMITIVE_NAMES;

/** Whether a string names a primitive this build has. */
export const isShapeType = (type: string): type is ShapeType =>
  (PRIMITIVE_NAMES as readonly string[]).includes(type);
