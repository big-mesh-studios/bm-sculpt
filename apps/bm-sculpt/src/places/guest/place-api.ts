/**
 * The guest library: everything a place script can call.
 *
 * ## How this file reaches the interpreter
 *
 * **It is a real TypeScript file in this repository, type-checked by `tsc --noEmit` like
 * any other, and `bundle.ts` transpiles it at bundle time.** That is the part worth
 * explaining, because the obvious alternative is to keep the guest API as a string in a
 * template literal — which is what the sibling project does, and which means the guest API
 * is never type-checked, never gets a compile error, and drifts from
 * `voxelscape.d.ts` silently.
 *
 * Here the two are the same file. `voxelscape.d.ts` re-exports these types, so a place
 * author gets exactly the declarations the interpreter runs, and `bundle.test.ts` asserts
 * that what the file exports and what the declaration offers are the same names.
 *
 * ## The two rules it obeys
 *
 * 1. **Nothing crosses the boundary but strings and numbers.** Every call to `engine` is a
 *    string or a number in and a string out. `JSON.stringify` is the only serializer used,
 *    because a format the host and the guest could disagree about is a format that will.
 * 2. **It imports nothing at runtime.** The single import below is `import type`, which
 *    `transpileModule` erases — and `bundle.test.ts` asserts the transpiled output requires
 *    nothing, because a guest module that required something would fail inside the
 *    interpreter with an error about a module the place author never wrote.
 *
 * ## Why the library exists at all
 *
 * Because the alternative is a script that hand-builds JSON. `engine.dispatch("shape-add",
 * JSON.stringify({...}))` in every place, with the field names spelled out, is the vocabulary
 * of ADR 0017 leaking into every script — and the first place to spell `combine` wrong
 * writes a shape that silently does nothing.
 */

// **A type-only import, and that is load-bearing.** This file is the guest library: it
// is bundled into a program QuickJS runs, and a test asserts that bundle contains no
// `require(` and imports nothing at runtime. `PRIMITIVES` is needed only for its type —
// `typeof PRIMITIVES[K]["parameters"]` — so importing it as a value would have pulled
// the whole primitive table into every place's bundle to read nine field names, and the
// bundle test caught exactly that.
import type { PRIMITIVES, ShapeType } from "@big-mesh-studios/sdf";

import type { GuestBridge } from "../bridge";

/**
 * The host, as the interpreter passed it in.
 *
 * **Not a module-level import and not a global.** `bundle.ts` runs the entry's source as
 * the body of a function whose one parameter this name, so a script that never receives the
 * object cannot name it — including code compiled later by a `Function` constructor, which
 * happens in global scope and sees nothing.
 */
declare const engine: GuestBridge;

/**
 * Thrown when the host refuses an effect.
 *
 * A place is code, and code that is told nothing about its own failures fails somewhere
 * else. A script that adds a two-thousand-and-first shape gets a `PlaceError` naming the
 * limit at the line that caused it, rather than a world with a bridge missing from it.
 */
export class PlaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceError";
  }
}

/**
 * Sends an effect, and throws if the host refused it.
 *
 * The one place the library talks to `engine.dispatch`, so the refusal has one answer
 * rather than nineteen call sites each deciding what to do with an empty string.
 */
const ask = (tag: string, payload: unknown): void => {
  const refusal = engine.dispatch(tag, JSON.stringify(payload));
  if (refusal !== "") throw new PlaceError(`${tag}: ${refusal}`);
};

/**
 * Asks the host a question.
 *
 * **A malformed answer becomes `null` rather than an exception.** A query cannot fail — it
 * answers "no" or "nothing there" — so a script that got something unparseable is talking
 * to a host that is not this build, and the useful thing it can do is carry on rather than
 * stop. The alternative is a place that fails to load on a version skew, which is the worst
 * time to find out.
 */
const askAbout = (name: string, args: unknown[]): unknown => {
  try {
    return JSON.parse(engine.query(name, JSON.stringify(args)));
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ geometry */

/**
 * A shape a script can ask for. Each carries only the numbers its primitive uses.
 *
 * **Derived from the primitive table, not written out.** This is what
 * `@big-mesh-studios/sdf`'s parameter list exists for: the shape's own field names and
 * their arities *are* the table's, so a place script gets a new primitive the day the
 * table has it, and this file — which is read by every place author and checked by the
 * demos — does not change.
 *
 * It is still a mapped type rather than `OperationShape` itself, because a script's
 * shape is `readonly` and its vectors are the `PlaceVec3` a script writes, not the
 * `Vec3` the host works in. The *structure* is derived; the readonly-ness is added here.
 */
type ParametersOf<K extends ShapeType> =
  (typeof PRIMITIVES)[K]["parameters"][number];

export type PlaceShape = {
  readonly [K in ShapeType]: {
    readonly type: K;
  } & {
    readonly [P in ParametersOf<K> as P["name"]]: P["arity"] extends 3
      ? PlaceVec3
      : number;
  };
}[ShapeType];

/** A position, as three plain numbers — an array, because that is what JSON makes of it. */
export type Vec3Like = readonly [number, number, number];

/**
 * A shape's own dimensions, as an object.
 *
 * **Which is not the same as `Vec3Like`, and the asymmetry is a trap worth naming.** A
 * position crosses the boundary as an array, so `at` is `[x, y, z]`. A shape's dimensions are
 * part of the CSG type (`OperationShape` in `@big-mesh-studios/sdf`) where they are objects, and the
 * host copies them straight through rather than converting — so `len` is `{ x, y, z }`.
 *
 * The first version of this file typed both as arrays, and the demos under `demo/` — which are
 * type-checked, which is the whole point of ADR 0018 — refused every box they wrote. It would
 * have reached a place author as a compile error with nothing saying which of the two was
 * wrong.
 */
export type PlaceVec3 = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/** How a shape changes the field. */
export type Combine = "Add" | "Subtract" | "Paint";

export interface CreateShapeOptions {
  /** Which place it belongs to. Created if it does not exist. */
  readonly place: string;
  /**
   * Its name within that place.
   *
   * **Never optional and never generated.** Two peers run the same script and derive the
   * same operations rather than receiving them (ADR 0016), so an id this peer invented
   * would be a different id on every peer and every shape would appear once per peer.
   */
  readonly id: string;
  /** Where it is. */
  readonly at: Vec3Like;
  readonly shape: PlaceShape;
  readonly combine: Combine;
  /** How far the edge blends. Above 0.25 the stored box is smaller than the shape's reach. */
  readonly softness?: number;
  /** A unit quaternion. */
  readonly orientation?: readonly [number, number, number, number];
  /** A colour, 0 to 255 per channel. */
  readonly colour?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
  readonly opacity?: number;
}

/**
 * Adds one operation to a place.
 *
 * **Returns nothing.** A handle would be a second identity for a thing the script already
 * has a name for, and the id *is* the handle — which is what `removeShape` takes. An object
 * identity across the boundary is exactly what ADR 0015 forbids, so a handle here could only
 * be a number, and a number the script chose is a name.
 */
export const createShape = (options: CreateShapeOptions): void => {
  ask("shape-add", {
    place: options.place,
    id: options.id,
    at: options.at,
    shape: options.shape,
    combine: options.combine,
    ...(options.softness === undefined ? {} : { softness: options.softness }),
    ...(options.orientation === undefined
      ? {}
      : { orientation: options.orientation }),
    ...(options.colour === undefined ? {} : { colour: options.colour }),
    ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
  });
};

/** Takes one shape out of a place by the id `createShape` was given. */
export const removeShape = (place: string, id: string): void => {
  ask("shape-remove", { place, id });
};

/** Removes a whole place, its shapes with it. Nothing it added is in the undo history. */
export const removePlace = (place: string): void => {
  ask("place-remove", { place });
};

/** Empties a place but leaves the place itself, so its name stays valid. */
export const clearPlace = (place: string): void => {
  ask("place-clear", { place });
};

/* -------------------------------------------------------------------- zones */

/**
 * A box that reports the player entering and leaving it.
 *
 * Zones are how a place built out of shapes reacts to anything: a door that opens, a lift
 * that starts, a line that says you have arrived. There is no entity system in v1, so this
 * is the whole of a place's reactivity.
 */
export interface CreateZoneOptions {
  /** Its name. Never generated, for the same reason a shape's id is not. */
  readonly id: string;
  readonly label?: string;
  readonly box: readonly [Vec3Like, Vec3Like];
}

export const createZone = (options: CreateZoneOptions): void => {
  ask("zone-add", {
    id: options.id,
    ...(options.label === undefined ? {} : { label: options.label }),
    box: options.box,
  });
};

export const removeZone = (id: string): void => {
  ask("zone-remove", { id });
};

/* ------------------------------------------------------------------- lights */

export interface CreateLightOptions {
  /** Its name, and how it is referred to when removed. Never generated. */
  readonly id: string;
  /** Where it is, in world units. */
  readonly at: Vec3Like;
  /** Its colour, each channel 0 to 255 — as everywhere else in this library. */
  readonly colour: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  };
  /**
   * How far it reaches, in world units.
   *
   * **The same number says how bright it is**, which is what makes it worth stating plainly: the
   * falloff is scaled so that `intensity` is the brightness *at the edge of this radius*. A light
   * of radius 100 at intensity 1 is as bright at 100 units as one of radius 20 is at 20. Neither
   * is bright in the middle — a lamp is hottest at its own centre — and the choice is made so a
   * place author tunes one number instead of reconciling brightness against whatever distance
   * the light happens to land on.
   */
  readonly radius: number;
  /**
   * How bright, up to 10. **Read alongside `radius`, not instead of it**: `1` is a bright light,
   * and what it looks like from somewhere depends on how far away that somewhere is.
   */
  readonly intensity: number;
}

export const createLight = (options: CreateLightOptions): void => {
  ask("light-add", {
    id: options.id,
    at: options.at,
    colour: options.colour,
    radius: options.radius,
    intensity: options.intensity,
  });
};

export const removeLight = (id: string): void => {
  ask("light-remove", { id });
};

/* ------------------------------------------------------------------ fields */

export interface CreateMediumOptions {
  /** Its name, and how it is referred to when removed. Never generated. */
  readonly id: string;
  /** Two opposite corners, in any order — the field sorts them. */
  readonly box: readonly [Vec3Like, Vec3Like];
  /**
   * Sideways pull, in world units per second. **Zero on one axis makes it a one-way belt.**
   */
  readonly pushVx: number;
  /** Forward pull, in world units per second. */
  readonly pushVz: number;
  /**
   * Upward pull, positive is up. **Left out, the field does not touch falling at all** — which is
   * what makes one conveyor definition also a floor, rather than also being an updraft.
   */
  readonly pushVy?: number;
  /**
   * What walking speed becomes while inside. **0 is quicksand**: the player moves at a fraction
   * of their own speed, or not at all, and `sink` decides how fast they go down.
   */
  readonly speedScale: number;
  /**
   * The fastest this field lets a player fall, in world units per second. Left out or zero, they
   * fall at their own gravity — so a slow belt is `speedScale` alone and quicksand is this too.
   */
  readonly sink?: number;
}

export const createMedium = (options: CreateMediumOptions): void => {
  ask("medium-add", {
    id: options.id,
    box: options.box,
    pushVx: options.pushVx,
    pushVz: options.pushVz,
    speedScale: options.speedScale,
    ...(options.pushVy === undefined ? {} : { pushVy: options.pushVy }),
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
};

export const removeMedium = (id: string): void => {
  ask("medium-remove", { id });
};

/**
 * What a scripted field at a point does to whoever is inside it, or `undefined` where none sits.
 *
 * **A query about a place rather than about the player.** "Am I standing on my belt" is a question
 * about a box and a position, and asking it that way means the answer does not change when there
 * is more than one player. There is one today (`MAX_PLAYERS`), so the two would agree; they would
 * not after.
 */
export const getMediumAt = (
  x: number,
  y: number,
  z: number,
): Medium | undefined => {
  const found = askAbout("getMediumAt", [x, y, z]);
  return isMedium(found) ? found : undefined;
};

/** What a field does to a player inside it. The same five numbers the physics reads. */
export interface Medium {
  /** Sideways pull, in world units per second. */
  readonly pushVx: number;
  readonly pushVz: number;
  /** Upward pull, positive is up. `null` when the field does not touch falling. */
  readonly pushVy: number | null;
  /** What walking speed becomes. */
  readonly speedScale: number;
  /** The fastest this field lets a player fall. Zero does not hold them down. */
  readonly sink: number;
}

/**
 * Whether an answer off the bridge is a field.
 *
 * **Every field checked, because a field with four of its five numbers is not a field** — the
 * physics would add `undefined` to a velocity and produce a NaN that travels. A query that cannot
 * fail should still refuse to hand back something that would.
 */
const isMedium = (value: unknown): value is Medium => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const isNumber = (key: string): boolean =>
    typeof candidate[key] === "number" &&
    Number.isFinite(candidate[key] as number);
  return (
    isNumber("pushVx") &&
    isNumber("pushVz") &&
    isNumber("speedScale") &&
    isNumber("sink") &&
    (candidate["pushVy"] === null || isNumber("pushVy"))
  );
};

/* -------------------------------------------------------------------- clock */

/** Jumps the clock to a mark in its cycle. The cycle is 1,200 seconds. */
export const setTime = (seconds: number): void => {
  ask("clock-set", { seconds });
};

/** Scales how fast the cycle runs. Zero stops time. */
export const setTimeSpeed = (multiplier: number): void => {
  ask("clock-speed", { multiplier });
};

/* ------------------------------------------------------------------- player */

export const movePlayer = (
  x: number,
  y: number,
  z: number,
  yaw?: number,
): void => {
  ask("player-place", { at: [x, y, z], ...(yaw === undefined ? {} : { yaw }) });
};

export const setPlayerSpeed = (multiplier: number): void => {
  ask("player-speed", { multiplier });
};

export const setPlayerJump = (multiplier: number): void => {
  ask("player-jump", { multiplier });
};

export const setFlying = (on: boolean): void => {
  ask("player-fly", { on });
};

/* ------------------------------------------------------------------- camera */

export const lookAt = (x: number, y: number, z: number, fov?: number): void => {
  ask("camera-look", { at: [x, y, z], ...(fov === undefined ? {} : { fov }) });
};

/** Gives the camera back to the player. */
export const clearCamera = (): void => {
  ask("camera-clear", {});
};

/* ------------------------------------------------------------------ output */

export const log = (text: string): void => {
  ask("log", { text });
};

export const toast = (text: string): void => {
  ask("toast", { text });
};

/**
 * Schedules a `timer` event.
 *
 * **The delay and the id are separate parameters, id first**, so a script can build a name
 * from something it already has. Timers fire in sorted id order, so the order a script's timers
 * arrive in is the order they were *named* in rather than the order they were set — which is
 * what makes two peers agree about which of two that came due together came first.
 *
 * **Setting an id that is already pending does nothing.** Not "resets it", not "queues a
 * second": nothing. That is what makes the obvious pattern work —
 *
 * ```ts
 * let fired = false;
 * onTick((info) => {
 *   if (info.events.some((e) => e.kind === "timer")) { fired = true; openTheDoor(); }
 *   if (!fired) after("door", 3000);   // arms once, and fires once
 * });
 * ```
 *
 * — and it is the opposite of what a "reset the deadline" reading would suggest. A place that
 * wants a repeating timer re-arms it when the event arrives, by which point the id is free.
 */
export const after = (id: string, delayMs: number): void => {
  ask("timer", { id, afterMs: delayMs });
};

/* --------------------------------------------------------------------- data */

/**
 * Writes a value the place can read on a later visit.
 *
 * Global rather than per-player: v1 has no accounts and one local player, and `scope` is an
 * enum precisely so that adding accounts is a data change rather than a format change.
 */
export const saveData = (key: string, value: string): void => {
  ask("data-set", { scope: "global", key, value });
};

/** Reads a stored value, or undefined when there is none. */
export const loadData = (key: string): string | undefined => {
  const value = askAbout("getData", [key]);
  return typeof value === "string" ? value : undefined;
};

export const deleteData = (key: string): void => {
  ask("data-delete", { scope: "global", key });
};

/* ------------------------------------------------------------------- world */

/** Whether a point is inside material. Water is not material. */
export const getSolidAt = (x: number, y: number, z: number): boolean =>
  askAbout("getSolidAt", [x, y, z]) === true;

/** The terrain's surface height at a column. */
export const getHeightAt = (x: number, z: number): number => {
  const height = askAbout("getHeightAt", [x, z]);
  return typeof height === "number" ? height : 0;
};

/** Whether a point is underwater. */
export const getWaterAt = (x: number, y: number, z: number): boolean =>
  askAbout("getWaterAt", [x, y, z]) === true;

/** What a ray found, or undefined for nothing. */
export interface RayHit {
  readonly kind: "shape" | "terrain" | "water";
  readonly point: Vec3Like;
  /** Which way the surface faced, as a unit vector. */
  readonly normal: Vec3Like;
  readonly distance: number;
}

/**
 * Casts a ray against the world and reports what it hit.
 *
 * **Traces the same field the picker does** (ADR 0009), which is why this is a query and not
 * a grid walk: there is no voxel DDA here, and no step cap, because a surface is found by
 * the sign of a distance function.
 */
export const raycast = (
  origin: Vec3Like,
  direction: Vec3Like,
  maxDistance: number,
): RayHit | undefined => {
  const hit = askAbout("raycast", [origin, direction, maxDistance]);
  return isRayHit(hit) ? hit : undefined;
};

const isRayHit = (value: unknown): value is RayHit => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["kind"] === "string" &&
    typeof candidate["distance"] === "number" &&
    Array.isArray(candidate["point"]) &&
    Array.isArray(candidate["normal"])
  );
};

/* ------------------------------------------------------------------- events */

/**
 * A fact the host delivered, as the guest sees it.
 *
 * **A union over `kind`, not one type with an index signature.** The first version had
 * `[field: string]: unknown`, which meant `event.zoneId` compiled and was `unknown` — so a
 * place author had to cast every field of every event, and the type checker could not tell
 * them that `event.timerId` does not exist on a `zone-entered`. The host's own payload types
 * are the ones to reuse, since they are what the wire format is validated against.
 */
export type PlaceEvent = PlaceEventUnion;

type PlaceEventBase<K extends string> = {
  readonly kind: K;
  /** Who caused it. `"local"` for a peer acting on itself. */
  readonly producer: string;
};

type PlaceEventUnion =
  | (PlaceEventBase<"player-joined"> & { readonly player: string })
  | (PlaceEventBase<"player-left"> & { readonly player: string })
  | (PlaceEventBase<"player-died"> & {
      readonly player: string;
      readonly cause: string;
    })
  | (PlaceEventBase<"zone-entered"> & { readonly zoneId: string })
  | (PlaceEventBase<"zone-left"> & { readonly zoneId: string })
  | (PlaceEventBase<"timer"> & { readonly timerId: string })
  | (PlaceEventBase<"data-changed"> & {
      readonly scope: string;
      readonly player: string;
      readonly key: string;
      readonly deleted: boolean;
      readonly value?: string;
    });

/** The kinds, so a place author can write a `switch` that the compiler will check. */
export const EVENT_KINDS = [
  "player-joined",
  "player-left",
  "player-died",
  "zone-entered",
  "zone-left",
  "timer",
  "data-changed",
] as const;

/** What a tick is given: the shared clock, and whatever arrived. */
export interface TickInfo {
  readonly now: number;
  readonly events: readonly PlaceEvent[];
}

/**
 * Registers a function to run on every step.
 *
 * Called during load, before the first step, so a place builds itself from its handlers
 * rather than from something that has to ask to be run.
 *
 * **The handler receives an object, not positional arguments**, because the event list grows
 * and a script written against two positional arguments would break silently when a third
 * appeared. It is also the only place in the library where a structured value exists, and it
 * is built *inside* the interpreter from two strings — so the object a script sees never
 * crossed the boundary.
 */
export const onTick = (handler: (info: TickInfo) => void): void => {
  engine.onTick((clockJson: string, eventsJson: string) => {
    handler(parseTick(clockJson, eventsJson));
  });
};

/** Whether a kind is one this library knows, for the drop-above. */
const isKnownKind = (kind: string): kind is PlaceEvent["kind"] =>
  (EVENT_KINDS as readonly string[]).includes(kind);

/**
 * Turns the host's two strings into a tick.
 *
 * **Never throws.** A malformed clock or event list becomes an empty tick, because the
 * alternative is a script that cannot start — and the failure would be reported as a parse
 * error in a file the place author cannot see.
 */
const parseTick = (clockJson: string, eventsJson: string): TickInfo => {
  let now = engine.now();
  // Narrowed to `unknown[]` rather than left `unknown`: it is whatever a peer sent, and the
  // loop below is the place that decides each element is worth believing.
  let raw: readonly unknown[] = [];
  try {
    const clock = JSON.parse(clockJson) as unknown;
    if (typeof clock === "number") now = clock;
    const parsed = JSON.parse(eventsJson) as unknown;
    if (Array.isArray(parsed)) raw = parsed;
  } catch {
    // An empty tick. See above.
  }
  const events: PlaceEvent[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { kind, producer, payload } = candidate as Record<string, unknown>;
    // **The kind is checked before anything is built, not after.** A fact from a host that
    // knows a kind this library does not would otherwise be cast into a union member whose
    // fields are not there, and the first thing the script reads would be `undefined` in a
    // field the compiler said was a string. An unknown kind is dropped instead, which is also
    // what a version skew wants.
    if (typeof kind !== "string" || !isKnownKind(kind)) continue;
    events.push({
      // The cast is honest because of what the two lines above established: the kind is one of
      // ours, and the payload came from a host that validated it against `EVENT_FIELDS` for
      // exactly that kind. TypeScript cannot see either of those from here — the union's
      // members are not distinguished by anything the compiler can trace through a spread — so
      // this is the one place in the library that asserts rather than proves, and the comment
      // says which.
      kind,
      producer: typeof producer === "string" ? producer : "local",
      // **Unwrapped, and this is the shape a script is written against.** The wire form
      // nests a fact's own fields under `payload` — that is what `events.ts` validates, and
      // nesting is what keeps an event's fields from colliding with its own `kind` and `at`.
      // So `event.zoneId` here, rather than `event.payload.zoneId`, and the flattening is
      // the one place in this library where a structured value is assembled rather than
      // parsed: it happens *inside* the interpreter, from strings the host produced, so
      // nothing crosses the boundary that did not already.
      ...(typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {}),
    } as PlaceEventUnion);
  }
  return { now, events };
};

/* --------------------------------------------------------------- small maths */

export const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** A number from the seeded generator, so two peers drawing the same place agree. */
export const random = (): number => engine.random();

/** A whole number in `[low, high]`, from the seeded generator. */
export const randint = (low: number, high: number): number =>
  low + Math.floor(engine.random() * (high - low + 1));

/** A number in `[low, high)`, from the seeded generator. */
export const randFloat = (low: number, high: number): number =>
  low + engine.random() * (high - low);

/** One of the entries, or undefined for an empty array. From the seeded generator. */
export const choice = <T>(items: readonly T[]): T | undefined =>
  items.length === 0 ? undefined : items[randint(0, items.length - 1)];

/**
 * A three-component vector, for a place that is mostly arithmetic on positions.
 *
 * **Guest-side only and never crosses the boundary**: every function that takes a position
 * takes a `Vec3Like`, which a `Vector3` converts into with `toArray`. A vector object sent
 * to the host would be object identity crossing (ADR 0015), and would have to be
 * re-validated there — the same numbers, checked twice.
 */
export class Vector3 {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}

  static zero(): Vector3 {
    return new Vector3(0, 0, 0);
  }

  static one(): Vector3 {
    return new Vector3(1, 1, 1);
  }

  static fromArray(values: Vec3Like): Vector3 {
    return new Vector3(values[0], values[1], values[2]);
  }

  add(other: Vector3): Vector3 {
    return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
  }

  subtract(other: Vector3): Vector3 {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  scale(factor: number): Vector3 {
    return new Vector3(this.x * factor, this.y * factor, this.z * factor);
  }

  dot(other: Vector3): number {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }

  cross(other: Vector3): Vector3 {
    return new Vector3(
      this.y * other.z - this.z * other.y,
      this.z * other.x - this.x * other.z,
      this.x * other.y - this.y * other.x,
    );
  }

  get length(): number {
    return Math.sqrt(this.dot(this));
  }

  unit(): Vector3 {
    const length = this.length;
    return length === 0 ? Vector3.zero() : this.scale(1 / length);
  }

  lerp(other: Vector3, t: number): Vector3 {
    return new Vector3(
      lerp(this.x, other.x, t),
      lerp(this.y, other.y, t),
      lerp(this.z, other.z, t),
    );
  }

  /** The plain triple every crossing to the host takes. */
  toArray(): Vec3Like {
    return [this.x, this.y, this.z];
  }

  equals(other: Vector3): boolean {
    return this.x === other.x && this.y === other.y && this.z === other.z;
  }
}
