/**
 * The effects: everything a place script can ask the host to do.
 *
 * ## What an effect is
 *
 * A script cannot touch the world. It can only **ask**, and an ask is a `(tag, payload)`
 * pair where the tag is one of the words below and the payload is a plain object checked
 * against that tag's fields. The host decides whether to carry it out.
 *
 * That indirection is the whole security model, and it is worth being blunt about why it
 * is shaped this way rather than being a function call. Under the multiplayer model every
 * peer runs every place — and a peer sends its peers *effects*, not operations. So the
 * thing arriving here is untrusted input from a machine the host has never verified, and
 * the only thing standing between it and the fold is this file.
 *
 * ## The three rules
 *
 * 1. **Nothing crosses as an object** (ADR 0015). A payload arrives as JSON text, and
 *    `parseEffect` is the function that turns it into something trusted.
 * 2. **Accepted whole or refused whole.** `parseEffect` returns `null` for anything
 *    malformed, and the caller drops it. There is no partial application, ever, because a
 *    half-applied shape is a shape in the wrong place that nobody can explain, and
 *    "the script was rejected" is a bug report a person can act on.
 * 3. **Every field is declared, and every declared field is bounded** — by `fields.ts`,
 *    from a table rather than by hand, so a tag cannot exist without being validated.
 *
 * ## What is here, and what is not
 *
 * This is the whole vocabulary for a place that builds a world: geometry, zones, the
 * clock, the player, the camera, text, timers, and key/value state. Not figures, scripted
 * UI, items, dialog trees, pathfinding or cutscenes — each is a real system this engine
 * does not have yet, and each would have meant a tag whose host side is a stub. ADR 0017
 * records the omissions and what would unlock them.
 *
 * Nothing here *applies* anything. The applier is Phase D's host; this file is the
 * vocabulary it will switch on.
 */

import {
  CAUSE_LIMIT,
  COMBINES,
  DATA_LIMITS,
  LIGHT_LIMITS,
  MEDIUM_LIMITS,
  OPACITY_LIMIT,
  PLAYER_LIMITS,
  SOFTNESS_LIMIT,
  TIMER_LIMITS,
  ZONE_LIMITS,
  checkPayload,
  nameField,
  shapeRule,
  SHAPE_TYPES,
  type EffectSpec,
  type FieldRule,
} from "./fields";
import { MAX_CLOCK_MULTIPLIER } from "./limits";
import { MAX_OPERATIONS_PER_PLACE } from "./place-registry";

/**
 * Every tag. The union of these words is what `EffectTag` is, derived from the table
 * rather than written beside it, so a tag added to the table and a tag offered to a script
 * are the same set by construction.
 */
export const EFFECT_TAGS = [
  // Geometry — the reason a place exists.
  "shape-add",
  "shape-remove",
  "place-remove",
  "place-clear",
  // Triggers. A world-building place needs volumes that report the player entering them.
  "zone-add",
  "zone-remove",
  // Light. The first effect that is not geometry and not text — it changes how the world is lit
  // rather than what is in it, which is why it is a separate pair rather than a shape with a
  // colour on it.
  "light-add",
  "light-remove",
  // Fields the player is inside. A medium is a box that moves whoever stands in it — a conveyor,
  // a current, quicksand — and it is the one effect family that changes physics rather than what
  // the world looks like.
  "medium-add",
  "medium-remove",
  // The clock. `world/day-night-controller.ts` already has the methods these call.
  "clock-set",
  "clock-speed",
  // The player. Three of these map onto fields `src/player/player.ts` has and no caller.
  "player-place",
  "player-speed",
  "player-jump",
  "player-fly",
  // The camera.
  "camera-look",
  "camera-clear",
  // Text out.
  "log",
  "toast",
  // Scheduling. A timer is an effect that comes back as an event, which is the only way
  // anything here is deferred: there are no guest promises and no `await` (ADR 0015).
  "timer",
  // State a place keeps between visits.
  "data-set",
  "data-delete",
] as const;

/** Every tag, as a type. */
export type EffectTag = (typeof EFFECT_TAGS)[number];

/** The optional player field: omitted means "the player this peer is running". */
const OPTIONAL_PLAYER = nameField(
  "player",
  false,
  "which player; omitted means the local one",
);

/** The optional player id bound, restated as a field rule so the bound is the kind's. */
const playerField = (): FieldRule => ({
  ...OPTIONAL_PLAYER,
  about: `which player, at most ${PLAYER_LIMITS.id} characters; omitted means the local one`,
});

/** Milliseconds, for the timer. */
const afterMsField = (): FieldRule => ({
  name: "afterMs",
  kind: "number",
  min: 0,
  max: TIMER_LIMITS.ms,
  required: true,
  about: `how long to wait, at most ${TIMER_LIMITS.ms} ms`,
});

/**
 * The whole table.
 *
 * One entry per tag, in the order the tags are declared above, each field carrying its own
 * bound. **This is the definition**: `parseEffect` is a function over it, and a generated
 * reference document would be a function over it, so the three cannot disagree.
 */
export const EFFECTS: Readonly<Record<EffectTag, EffectSpec>> = {
  "shape-add": {
    tag: "shape-add",
    about:
      "Adds one operation to a place under an id the script chose. Creates the place if " +
      "it does not exist. Refused once the place holds MAX_OPERATIONS_PER_PLACE.",
    fields: [
      nameField("place"),
      nameField(
        "id",
        true,
        "an id for this shape within the place, never reused",
      ),
      { name: "at", kind: "vec3", required: true, about: "the shape's origin" },
      // **The description is generated from the table, like the validation is.**
      // It was the string "a primitive: Ellipsoid, Box or Capsule", which was true
      // when written and stopped being true the moment the table gained six entries —
      // in the one place a place author actually reads: the generated reference. A
      // hand-written list of primitive names is exactly what ADR 0025 removed, and it
      // survived in prose because prose is not a compiler.
      shapeRule(`a primitive: ${SHAPE_TYPES.join(", ")}`),
      {
        name: "combine",
        kind: "combine",
        required: true,
        about: `one of ${COMBINES.join(", ")}`,
      },
      {
        name: "softness",
        kind: "number",
        min: 0,
        max: SOFTNESS_LIMIT,
        about:
          "how far the edge blends; above this the stored box is too small",
      },
      { name: "orientation", kind: "quat", about: "a unit quaternion" },
      { name: "colour", kind: "colour", about: "r, g and b, 0 to 255" },
      {
        name: "opacity",
        kind: "unit",
        about: `carried in the file, not read by the field; at most ${OPACITY_LIMIT}`,
      },
    ],
  },

  "shape-remove": {
    tag: "shape-remove",
    about:
      "Takes one shape out of a place by id. The operation's index is not reused and " +
      "nothing else moves.",
    fields: [nameField("place"), nameField("id")],
  },

  "place-remove": {
    tag: "place-remove",
    about:
      "Removes a whole place, its shapes with it. Nothing it added is left in the undo " +
      "history, so there is nothing to undo.",
    fields: [nameField("place")],
  },

  "place-clear": {
    tag: "place-clear",
    about:
      "Empties a place but leaves the place itself, so its id stays valid.",
    fields: [nameField("place")],
  },

  "zone-add": {
    tag: "zone-add",
    about:
      "A box that reports the player entering and leaving it. The player is tested " +
      "against every zone once a frame, which is why there is a cap on how many there " +
      "can be.",
    fields: [
      nameField("id"),
      {
        name: "label",
        kind: "text",
        max: ZONE_LIMITS.name,
        about: `what to call it, at most ${ZONE_LIMITS.name} characters`,
      },
      {
        name: "box",
        kind: "box",
        required: true,
        about: `two opposite corners, each within ${ZONE_LIMITS.size} units of the origin`,
      },
    ],
  },

  "zone-remove": {
    tag: "zone-remove",
    about: "Removes a zone by id.",
    fields: [nameField("id")],
  },

  "light-add": {
    tag: "light-add",
    about:
      "Puts a light somewhere. Intensity is how bright it is at the edge of its own " +
      "radius, so reach and brightness are one number to tune rather than two to " +
      "reconcile with the distance to whatever it lands on.",
    fields: [
      nameField("id"),
      {
        name: "at",
        kind: "vec3",
        required: true,
        about: "where the light is, in world units",
      },
      {
        name: "colour",
        kind: "colour",
        required: true,
        about: "its colour, each channel 0 to 255",
      },
      {
        name: "radius",
        kind: "number",
        min: 0,
        max: LIGHT_LIMITS.radius,
        required: true,
        about: `how far it reaches, at most ${LIGHT_LIMITS.radius} units`,
      },
      {
        name: "intensity",
        kind: "number",
        min: 0,
        max: LIGHT_LIMITS.intensity,
        required: true,
        about: `how bright, up to ${LIGHT_LIMITS.intensity}`,
      },
    ],
  },

  "light-remove": {
    tag: "light-remove",
    about: "Removes a light by id.",
    fields: [nameField("id")],
  },

  "medium-add": {
    tag: "medium-add",
    about:
      "A box the player is inside that moves them: a conveyor pushes them, quicksand slows " +
      "them, a current carries them. Where two boxes overlap, the one added first wins.",
    fields: [
      nameField("id"),
      {
        name: "box",
        kind: "box",
        required: true,
        about: `two opposite corners, each within ${ZONE_LIMITS.size} units of the origin`,
      },
      {
        name: "pushVx",
        kind: "number",
        min: -MEDIUM_LIMITS.push,
        max: MEDIUM_LIMITS.push,
        required: true,
        about: `a sideways pull in units per second, up to ${MEDIUM_LIMITS.push}`,
      },
      {
        name: "pushVz",
        kind: "number",
        min: -MEDIUM_LIMITS.push,
        max: MEDIUM_LIMITS.push,
        required: true,
        about: `a forward pull in units per second, up to ${MEDIUM_LIMITS.push}`,
      },
      {
        name: "pushVy",
        kind: "number",
        min: -MEDIUM_LIMITS.push,
        max: MEDIUM_LIMITS.push,
        about:
          "upward pull, positive is up. Left out, the field does not touch falling at all.",
      },
      {
        name: "speedScale",
        kind: "number",
        min: 0,
        max: MEDIUM_LIMITS.speedScale,
        required: true,
        about: `what walking speed becomes, up to ${MEDIUM_LIMITS.speedScale}; 0 is quicksand`,
      },
      {
        name: "sink",
        kind: "number",
        min: 0,
        max: MEDIUM_LIMITS.push,
        about: `the fastest this field lets a player fall, up to ${MEDIUM_LIMITS.push}; 0 does not hold them down`,
      },
    ],
  },

  "medium-remove": {
    tag: "medium-remove",
    about: "Removes a medium by id.",
    fields: [nameField("id")],
  },

  "clock-set": {
    tag: "clock-set",
    about:
      "Jumps the clock to an elapsed-seconds mark. The cycle is 1,200 seconds.",
    fields: [
      {
        name: "seconds",
        kind: "number",
        min: 0,
        max: 1_200,
        required: true,
        about: "seconds into the cycle",
      },
    ],
  },

  "clock-speed": {
    tag: "clock-speed",
    about: "Scales how fast the cycle runs. Zero stops time.",
    fields: [
      {
        name: "multiplier",
        kind: "multiplier",
        max: MAX_CLOCK_MULTIPLIER,
        required: true,
        about: "0 stops the clock; 1 is real time",
      },
    ],
  },

  "player-place": {
    tag: "player-place",
    about: "Puts a player somewhere, facing a direction.",
    fields: [
      playerField(),
      { name: "at", kind: "vec3", required: true, about: "where to put them" },
      { name: "yaw", kind: "yaw", about: "facing, in radians" },
    ],
  },

  "player-speed": {
    tag: "player-speed",
    about: "Overrides how fast a player walks.",
    fields: [
      playerField(),
      {
        name: "multiplier",
        kind: "multiplier",
        required: true,
        about: "0 to 10, on top of the player's own speed",
      },
    ],
  },

  "player-jump": {
    tag: "player-jump",
    about: "Overrides how high a player jumps.",
    fields: [
      playerField(),
      {
        name: "multiplier",
        kind: "multiplier",
        required: true,
        about: "0 to 10, on top of the player's own jump",
      },
    ],
  },

  "player-fly": {
    tag: "player-fly",
    about:
      "Turns flight on or off. Flying discards the fall, the way the console's " +
      "`/player:fly` does, so a player is not dropped when it is switched on.",
    fields: [
      playerField(),
      {
        name: "on",
        kind: "boolean",
        required: true,
        about: "true to fly, false to fall",
      },
    ],
  },

  "camera-look": {
    tag: "camera-look",
    about: "Points the camera at a place in the world.",
    fields: [
      { name: "at", kind: "vec3", required: true, about: "what to look at" },
      {
        name: "fov",
        kind: "number",
        min: 1,
        max: 179,
        about: "field of view in degrees, if it should change",
      },
    ],
  },

  "camera-clear": {
    tag: "camera-clear",
    about: "Gives the camera back to the player.",
    fields: [],
  },

  log: {
    tag: "log",
    about: "Writes a line to the console scrollback.",
    fields: [
      {
        name: "text",
        kind: "text",
        required: true,
        about: "the line to write",
      },
    ],
  },

  toast: {
    tag: "toast",
    about: "Shows a line of text on a player's screen.",
    fields: [
      playerField(),
      {
        name: "text",
        kind: "text",
        required: true,
        about: "the line to show them",
      },
    ],
  },

  timer: {
    tag: "timer",
    about:
      "Schedules a `timer` event after a delay. The id is the script's, and timers fire " +
      "in sorted id order so two peers agree on which came first.",
    fields: [nameField("id"), afterMsField()],
  },

  "data-set": {
    tag: "data-set",
    about: "Writes a value the place can read on a later visit.",
    fields: [
      {
        name: "scope",
        kind: "enum",
        values: ["global", "player"],
        required: true,
        about: "whose it is; there are no accounts yet, so not `account`",
      },
      playerField(),
      {
        name: "key",
        kind: "name",
        required: true,
        about: `what to call it, at most ${DATA_LIMITS.key} characters`,
      },
      {
        name: "value",
        kind: "text",
        required: true,
        about: `the text to store, at most ${DATA_LIMITS.value} characters`,
      },
    ],
  },

  "data-delete": {
    tag: "data-delete",
    about: "Removes a stored value.",
    fields: [
      {
        name: "scope",
        kind: "enum",
        values: ["global", "player"],
        required: true,
        about: "whose it is",
      },
      playerField(),
      {
        name: "key",
        kind: "name",
        required: true,
        about: `what to call it, at most ${DATA_LIMITS.key} characters`,
      },
    ],
  },
};

/**
 * Whether `tag` is one this build offers.
 *
 * A `Set` rather than `EFFECT_TAGS.includes`, because this is called once per effect per
 * step and the array is nineteen entries deep. The set is built from the array, so adding
 * a tag to `EFFECTS` is enough.
 */
const KNOWN_TAGS = new Set<string>(EFFECT_TAGS);

/** Every tag, for a caller that wants to enumerate — a completion list, a document. */
export const effectTags = (): readonly EffectTag[] => EFFECT_TAGS;

/** The fields a tag's payload is checked against, or undefined for an unknown tag. */
export const fieldsFor = (tag: string): readonly FieldRule[] | undefined =>
  KNOWN_TAGS.has(tag) ? EFFECTS[tag as EffectTag].fields : undefined;

/** What went wrong with a refused effect, for a log line somebody can act on. */
export interface EffectRefusal {
  readonly tag: string;
  readonly reason: string;
}

/**
 * Checks a payload against a tag.
 *
 * The whole trust boundary, in one function. **Returns a `ParsedEffect` or `null`, never a
 * partial one** — and the second is the part that matters. A payload that is nine-tenths
 * valid is refused, because applying the nine tenths puts a shape somewhere its author did
 * not ask for and leaves no record that anything was wrong.
 *
 * `tag` is compared against the table rather than looked up, so a tag from a future build
 * is refused by an old one — which is what makes the wire format safe to extend.
 */
/**
 * The result of checking one effect: it was good, or here is why it was not.
 *
 * **A union rather than a value-or-null, and the reason is a log line.** A host told only
 * "no" can say "a peer sent an effect this build refused", which is a fact nobody can act on.
 * Told the reason, it can say which field and what was wrong with it — which is a bug report.
 * `parseEffect` below is this function with the reason thrown away, for the callers that
 * genuinely do not care.
 */
export type InspectedEffect =
  { readonly effect: ParsedEffect } | { readonly refusal: EffectRefusal };

/**
 * Checks a payload against a tag, and says what it found.
 *
 * The whole trust boundary, in one function. **A payload that is nine-tenths valid is refused
 * whole**, because applying the nine tenths puts a shape somewhere its author did not ask for
 * and leaves no record that anything was wrong. There is no partial result and no way to ask
 * for one.
 *
 * `tag` is compared against the table rather than looked up, so a tag from a future build is
 * refused by an old one — which is what makes the wire format safe to extend, and which is
 * also why an unknown tag is a *refusal with a reason* rather than a silent null.
 */
export const inspectEffect = (
  tag: unknown,
  payload: unknown,
): InspectedEffect => {
  if (typeof tag !== "string") {
    return {
      refusal: { tag: `${typeof tag}`, reason: "the tag is not a string" },
    };
  }
  const fields = fieldsFor(tag);
  if (fields === undefined) {
    return { refusal: { tag, reason: "is not an effect this build knows" } };
  }

  const refusal = checkPayload(fields, payload);
  if (refusal !== null) {
    return {
      refusal: {
        tag,
        reason:
          refusal.field === ""
            ? refusal.why
            : `${refusal.field} ${refusal.why}`,
      },
    };
  }

  // The assertion, and what makes it honest: `EFFECTS[tag].fields` is the *definition* of each
  // payload, `checkPayload` is the checker for that definition, and this line runs only once
  // that checker has passed. There is no second list of required fields that could fall out of
  // step with the first — that is the whole reason the vocabulary is a table rather than a
  // `switch`.
  return { effect: { tag, payload } as ParsedEffect };
};

/**
 * The same, keeping only the good ones. See `inspectEffect` for why a host should not use this.
 */
export const parseEffect = (
  tag: unknown,
  payload: unknown,
): ParsedEffect | null => {
  const inspected = inspectEffect(tag, payload);
  return "effect" in inspected ? inspected.effect : null;
};

/**
 * The same, from the JSON text a payload actually arrives as.
 *
 * **A separate function because `JSON.parse` can throw**, and because a host should not
 * have to wrap every call in a `try` to be safe from a peer's bytes. A truncated payload —
 * which is what a connection cut mid-message looks like — is refused here rather than
 * thrown, because refusing it is exactly right.
 */
export const parseEffectJson = (
  tag: unknown,
  json: unknown,
): ParsedEffect | null => {
  if (typeof json !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  return parseEffect(tag, parsed);
};

/** A tag and a payload that has been checked. The only shape a host will act on. */
export type ParsedEffect =
  | { readonly tag: "shape-add"; readonly payload: ShapeAdd }
  | { readonly tag: "shape-remove"; readonly payload: PlaceById }
  | { readonly tag: "place-remove"; readonly payload: PlaceOnly }
  | { readonly tag: "place-clear"; readonly payload: PlaceOnly }
  | { readonly tag: "zone-add"; readonly payload: ZoneAdd }
  | { readonly tag: "zone-remove"; readonly payload: IdOnly }
  | { readonly tag: "light-add"; readonly payload: LightAdd }
  | { readonly tag: "light-remove"; readonly payload: IdOnly }
  | { readonly tag: "medium-add"; readonly payload: MediumAdd }
  | { readonly tag: "medium-remove"; readonly payload: IdOnly }
  | { readonly tag: "clock-set"; readonly payload: ClockSet }
  | { readonly tag: "clock-speed"; readonly payload: ClockSpeed }
  | { readonly tag: "player-place"; readonly payload: PlayerPlace }
  | { readonly tag: "player-speed"; readonly payload: PlayerSpeed }
  | { readonly tag: "player-jump"; readonly payload: PlayerSpeed }
  | { readonly tag: "player-fly"; readonly payload: PlayerFly }
  | { readonly tag: "camera-look"; readonly payload: CameraLook }
  | { readonly tag: "camera-clear"; readonly payload: EmptyPayload }
  | { readonly tag: "log"; readonly payload: Text }
  | { readonly tag: "toast"; readonly payload: Toast }
  | { readonly tag: "timer"; readonly payload: Timer }
  | { readonly tag: "data-set"; readonly payload: DataSet }
  | { readonly tag: "data-delete"; readonly payload: DataDelete };

/** A payload with nothing in it, which is still checked rather than assumed. */
export type EmptyPayload = Record<string, never>;

/** `place-remove`, `place-clear`. */
export interface PlaceOnly {
  readonly place: string;
}
/** `shape-remove`, `zone-remove`. */
export interface PlaceById {
  readonly place: string;
  readonly id: string;
}
/** `zone-remove`, on its own. */
export interface IdOnly {
  readonly id: string;
}
/** `shape-add`. */
export interface ShapeAdd {
  readonly place: string;
  readonly id: string;
  readonly at: readonly [number, number, number];
  readonly shape: unknown;
  readonly combine: unknown;
  readonly softness?: number;
  readonly orientation?: readonly [number, number, number, number];
  readonly colour?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
  readonly opacity?: number;
}
/**
 * `light-add`.
 *
 * **Intensity means "bright at the edge of my own radius"**, and that is worth saying in the type
 * as well as in the rule: it is the one field whose units are not their name. A caller who reads
 * `intensity: 1` as "one unit of candela" would get a light a hundred times too dim and no
 * explanation. The reasoning is in `render/point-lights.ts`.
 */
export interface LightAdd {
  readonly id: string;
  readonly at: readonly [number, number, number];
  /** Each channel 0 to 255, as everywhere else a place speaks of colour. */
  readonly colour: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
  readonly radius: number;
  readonly intensity: number;
}

/**
 * `medium-add`.
 *
 * **`pushVy` and `sink` are absent rather than null**, and a field that omits both is one that
 * does not touch falling. Making them null-on-the-wire would mean every payload has to spell out
 * "none" for two of its six fields, and a field's job is to say what it does.
 */
export interface MediumAdd {
  readonly id: string;
  readonly box: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ];
  readonly pushVx: number;
  readonly pushVz: number;
  readonly pushVy?: number;
  readonly speedScale: number;
  readonly sink?: number;
}

/** `zone-add`. */
export interface ZoneAdd {
  readonly id: string;
  readonly label?: string;
  readonly box: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ];
}
/** `clock-set`. */
export interface ClockSet {
  readonly seconds: number;
}
/** `clock-speed`. */
export interface ClockSpeed {
  readonly multiplier: number;
}
/** `player-place`. */
export interface PlayerPlace {
  readonly player?: string;
  readonly at: readonly [number, number, number];
  readonly yaw?: number;
}
/** `player-speed`, `player-jump`. */
export interface PlayerSpeed {
  readonly player?: string;
  readonly multiplier: number;
}
/** `player-fly`. */
export interface PlayerFly {
  readonly player?: string;
  readonly on: boolean;
}
/** `camera-look`. */
export interface CameraLook {
  readonly at: readonly [number, number, number];
  readonly fov?: number;
}
/** `log`. */
export interface Text {
  readonly text: string;
}
/** `toast`. */
export interface Toast {
  readonly player?: string;
  readonly text: string;
}
/** `timer`. */
export interface Timer {
  readonly id: string;
  readonly afterMs: number;
}
/** `data-set`. */
export interface DataSet {
  readonly scope: string;
  readonly player?: string;
  readonly key: string;
  readonly value: string;
}
/** `data-delete`. */
export interface DataDelete {
  readonly scope: string;
  readonly player?: string;
  readonly key: string;
}

/**
 * The limits a host needs in order to apply effects, gathered so it reads its bounds from
 * one import rather than following a chain.
 *
 * `shapesPerPlace` is `MAX_OPERATIONS_PER_PLACE`, imported rather than re-declared: it is
 * enforced by `PlaceRegistry` and carries a measurement, so there is exactly one number and
 * the host is told where it came from.
 */
export const EFFECT_LIMITS = {
  data: DATA_LIMITS,
  zones: ZONE_LIMITS,
  lights: LIGHT_LIMITS,
  mediums: MEDIUM_LIMITS,
  timers: TIMER_LIMITS,
  players: PLAYER_LIMITS,
  cause: CAUSE_LIMIT,
  shapesPerPlace: MAX_OPERATIONS_PER_PLACE,
} as const;
