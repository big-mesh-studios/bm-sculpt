/**
 * The host: the trusted side of a place.
 *
 * ## What it is
 *
 * A plain object with no scene, no DOM and no network. It owns the interpreter, the event log,
 * the place registry, the zones, the timers and the stored data, and it is the only thing
 * between a peer's bytes and the fold. A script cannot call a method on it; it can dispatch an
 * effect, and the host decides.
 *
 * ## Why it is a plain object and not a subclass or a set of callbacks
 *
 * voxelscape's host takes about forty `on*` callbacks, one per effect family. That is the
 * shape a host takes when it has no idea who is listening. Here the split is by *ownership*:
 *
 * - **What the host can own, it owns** — geometry, zones, timers, data. A caller reads those
 *   through a getter, and there is no way for a listener to disagree with the log about what
 *   they hold.
 * - **What only the application can do, is eight callbacks** — put the player somewhere, point
 *   the camera, write a line. Those are the irreducible set of things a script can ask for
 *   that the host genuinely cannot answer on its own.
 *
 * So `HostEffects` has eight methods rather than forty, and everything else is a property.
 *
 * ## The step, and why it is a loop
 *
 * ```
 * step(now):
 *   1. pump the timers that are due at `now`      — each authors an event
 *   2. take the events no script has been stepped for, in fold order
 *   3. run the interpreter's handlers over them   — which dispatches effects
 *   4. apply every effect, in order
 *   5. if applying produced new events, step again — up to MAX_CASCADE_STEPS deep
 * ```
 *
 * **Step 5 is not an optimisation, it is a cap.** An effect can author an event, and an event
 * can make a script dispatch an effect. Without a depth limit a place whose two handlers
 * disagree can keep its peer inside that loop forever, holding the frame. Eight is enough for
 * anything a person writes — a place reacting to its own reaction twice over — and a script
 * that needs more is a script that should be restructured rather than given a bigger budget.
 *
 * ## Determinism
 *
 * Effects are applied in the order the script dispatched them, and a given effect applied to
 * a given state always does the same thing. That is what lets every peer derive the same
 * world from the same script (ADR 0016).
 *
 * **The eight callbacks are the exception, and deliberately.** `player-place` on one peer
 * moves that peer's player and nobody else's — which is correct, because each peer is running
 * a different player. It does mean a script cannot use them to keep two players in agreement,
 * and the record says so rather than pretending otherwise.
 */

import {
  createInterpreter,
  ScriptExecutionError,
  type Interpreter,
} from "./interpreter";
import { bundlePlace, type PlaceFiles } from "./bundle";
import { inspectEffect, type ParsedEffect } from "./effects";
import { EventLog, encodeEvents } from "./event-log";
import { eventId as makeEventId, type ScriptEvent } from "./events";
import type { GuestQuery } from "./bridge";
import {
  MAX_OPERATIONS_PER_PLACE,
  PlaceRegistry,
  type PlaceHandle,
} from "./place-registry";
import {
  MAX_CHANNEL,
  MAX_DATA_KEYS,
  MAX_LIGHTS,
  MAX_MEDIUMS,
  MAX_PENDING_TIMERS,
  MAX_ZONES,
} from "./limits";
import { Operation, OperationShape } from "@big-mesh-studios/csg";
import type { Bounds } from "../edit/document";
import type { Quat, Vec3 } from "@big-mesh-studios/core";
import type { ClockCommands } from "../console/commands";
import type { Medium } from "../player/player";

/**
 * How deep one step may cascade.
 *
 * **A cap rather than a drain.** Eight is far more than a place needs — a script reacting to
 * its own reaction twice over is already unusual — and the alternative, draining until nothing
 * is left, lets two handlers that disagree keep a peer inside the loop holding the frame with
 * no way out. A place that needs more is a place that wants restructuring rather than budget.
 */
export const MAX_CASCADE_STEPS = 8;

/** What a script found when it cast a ray. Mirrors the guest library's `RayHit`. */
export interface RayHit {
  readonly kind: "shape" | "terrain" | "water";
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly distance: number;
}

/**
 * The world, as the host reads it.
 *
 * **Every one of these is a read.** Nothing here can change the world, which is what keeps
 * the query half of the bridge (`bridge.ts`) genuinely unvalidated: there is no path from a
 * query to the fold, so there is nothing for a query's arguments to attack.
 */
export interface HostWorld {
  /**
   * The registry the host writes shapes into. The host does not own it; a session does.
   *
   * **Held rather than created, because the fold index comes from the session's own counter.**
   * A registry built over a different `FoldOrder` would hand out indices the session's brush
   * also hands out, and two operations sharing an index is a surface quietly wrong.
   */
  readonly places: PlaceRegistry;
  /**
   * Told what a place's geometry now covers, so the caller can re-mesh it.
   *
   * **This is the seam that makes a place visible, and it is not optional in practice.** The
   * host writes into the registry directly, so nothing else would notice: a `SculptSession`
   * re-meshes when *it* applies a change, and a shape a script made bypasses it entirely. The
   * symptom of leaving this out is not subtle geometry, it is a bridge that exists in the
   * collision field and in no mesh — so the player stands on something nobody can see, and
   * the console reports no operations.
   *
   * It carries the same `bounds` contract as `edit/document.ts`'s `Change`, and for the same
   * reason: a caller is handed the box rather than being asked to work it out, because two
   * places working out the same box is how they come to disagree about what an edit touched.
   * `undefined` means nothing was added, so a remove need not re-mesh anything.
   */
  geometryChanged(bounds: Bounds | undefined): void;
  /** The terrain's own surface height at a column, or undefined with no height field. */
  readonly terrainHeight?: ((x: number, z: number) => number) | undefined;
  /** Whether a point is inside material. Water is not material. */
  solidAt(x: number, y: number, z: number): boolean;
  /** Whether a point is underwater. */
  waterAt(x: number, y: number, z: number): boolean;
  /**
   * The scripted field at a point, or undefined where none stands.
   *
   * **Optional, and absent means the application has no places at all** rather than "no field
   * here" — the same distinction `GameWorld` makes for `getMediumAt`, and for the same reason: a
   * query cannot fail, but it should still be honest about what it does not know.
   */
  mediumAt?(x: number, y: number, z: number): HostMedium | undefined;
  /**
   * Traces a ray against the same field the picker does.
   *
   * Traces the *same* field rather than a copy — ADR 0009's invariant, extended from edits to
   * questions. A script asking "what is over there" and the player looking at it must be
   * answered by one field, or a place that builds a bridge in response to a ray would be
   * building it against a surface nobody can see.
   */
  raycast(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maxDistance: number,
  ): RayHit | undefined;
}

/** The eight things only the application can do. See the file header. */
export interface HostEffects {
  /** A line for the console. */
  log(text: string): void;
  /** A line on the player's screen. */
  toast(text: string): void;
  movePlayer(at: Vec3, yaw?: number): void;
  setPlayerSpeed(multiplier: number): void;
  setPlayerJump(multiplier: number): void;
  setFlying(on: boolean): void;
  lookAt(at: Vec3, fov?: number): void;
  clearCamera(): void;
}

/**
 * The clock a place can move.
 *
 * **The console's own `ClockCommands`, not a parallel copy.** The first version of this file
 * declared its own shape and claimed to be a reuse, which it was not — it differed in both
 * argument type and return type, so `DayNightController` satisfied one and not the other, and
 * the compiler would have said so at the wiring. Declaring it as the same interface means
 * there is one description of what a clock is asked to do, and a place and `/clock:` cannot
 * drift apart on what that is.
 *
 * `describe()` is not used by a place and is here only because the interface is shared; a
 * place has no readout to be described to.
 */
export type HostClock = ClockCommands;

/**
 * A light the host owns, as a renderer would read it.
 *
 * **Colour in 0…1, where the effect vocabulary says 0…255.** The conversion happens once, here at
 * the boundary, so the renderer never has to know that a place speaks in bytes — and so a place
 * that sends `255` and one that sends `1.0` cannot produce the same light by accident.
 */
export interface Light {
  readonly id: string;
  readonly at: Vec3;
  readonly colour: readonly [number, number, number];
  /** How far it reaches. Zero means it lights nothing. */
  readonly radius: number;
  /** How bright, at the edge of its own radius. Zero means it lights nothing. */
  readonly intensity: number;
}

/**
 * The field the player is standing in, in the shape the physics already reads.
 *
 * **A re-export of `player.ts`'s own `Medium`, and the reason is the same as `HostClock`'s.** The
 * host hands this straight to `PlayerWorld.getMediumAt`, so a second declaration here would be a
 * second thing that has to agree with the first — and a stub shaped like a copy rather than like
 * the real interface would compile happily while proving nothing about the wiring. One type, and
 * the compiler checks that the host really does produce what the physics consumes.
 */
export type HostMedium = Medium;

/** A box the host owns that the player is inside, as the physics asks for it. */
interface OwnedMedium {
  readonly id: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly medium: HostMedium;
}

/** A zone the host owns, as a renderer would read it. */
export interface Zone {
  readonly id: string;
  readonly label: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A timer that has been set and has not yet come due. */
interface PendingTimer {
  readonly id: string;
  /** When it comes due, on the shared clock. */
  readonly dueAt: number;
}

export interface HostOptions {
  /** The place's files, as `bundle.ts` takes them. */
  readonly files: PlaceFiles;
  /** Which file runs. */
  readonly entry: string;
  /** Seed for the script's `Math.random`. Peers pass the same one. */
  readonly seed: number;
  /** The shared clock, in milliseconds. Every event's `at` comes from here. */
  readonly now: () => number;
  readonly world: HostWorld;
  readonly effects: HostEffects;
  readonly clock: HostClock;
  /**
   * Told about everything a person needs to know: a refused effect, a script that threw, a
   * timer that could not be set.
   *
   * **Never throws and never blocks.** A script's problems are reported here and the host
   * carries on — a place that fails to build one shape is a place with one missing shape, not a
   * peer that has stopped.
   */
  readonly onNotice?: (message: string) => void;
}

/**
 * A place, running.
 *
 * Construct it, call `step` every frame, and read the collections the renderer needs. There is
 * no `start` and no `tick` — the frame loop is the caller's, and a host that owns a clock of its
 * own would be a second answer to "what hour is it", which ADR 0011 is about.
 */
export class PlaceHost {
  private interpreter: Interpreter | undefined;
  private readonly log = new EventLog();
  private readonly zones = new Map<string, Zone>();
  private readonly lights = new Map<string, Light>();
  /**
   * The fields, in insertion order.
   *
   * **A `Map` rather than a sorted collection, because the order *is* the rule.** Where two boxes
   * overlap, the one added first wins — which is deterministic, because it is the same order the
   * effects were dispatched in, which is the same order on every peer running the same script
   * (ADR 0016). Sorting them would make the precedence a function of position instead, which is
   * less predictable and no more deterministic.
   */
  private readonly mediums = new Map<string, OwnedMedium>();
  /** Zones the player is inside, so a move can tell an entry from a stay. */
  private inside = new Set<string>();
  private timers: PendingTimer[] = [];
  private readonly data = new Map<string, string>();
  /** Where the player was last seen, so `movePlayer` can tell a move from a first look. */
  private lastSeen: Vec3 | undefined;
  /** Event ids this peer has authored, so two cannot collide. */
  private sequence = 0;
  /**
   * How many facts this peer has authored, so a step can tell whether applying effects
   * produced anything without walking the log.
   *
   * A count rather than a scan of `log.all()`: the log holds up to `MAX_EVENTS`, and the scan
   * would run once per cascade depth — so thirty thousand comparisons a frame to answer a
   * question that is a single integer.
   */
  private authoredCount = 0;
  /** The most recent failure, for a readout. `undefined` when the place is clean. */
  private problem: string | undefined;

  constructor(private readonly options: HostOptions) {}

  /** The interpreter, once a place is loaded. */
  get runtime(): Interpreter | undefined {
    return this.interpreter;
  }

  /** The facts, in fold order. */
  get events(): readonly ScriptEvent[] {
    return this.log.all();
  }

  /** The zones, in the order they were added. */
  get zoneList(): readonly Zone[] {
    return [...this.zones.values()];
  }

  /**
   * The lights a renderer should draw this frame, nearest first.
   *
   * **Nearest to the player, truncated to `MAX_DRAWN_LIGHTS`, and ties broken by id.** All three
   * are about the same thing: two peers must draw the same lights, or the same world is lit
   * differently on two machines (ADR 0016). Sorting by distance alone would leave a pair at
   * exactly equal distances to be ordered by `Map` insertion — which is the order the scripts
   * happened to run in, and is therefore a peer divergence waiting to happen.
   *
   * **A copy, sorted, every call.** The alternative is to keep the list sorted as lights are added
   * and removed, which would need the player's position at mutation time — and the player moves.
   * `MAX_LIGHTS` is 256 and the sort is by squared distance on plain numbers, so the whole thing
   * is a few hundred comparisons once a frame.
   */
  visibleLights(from: Vec3 | undefined, max: number): readonly Light[] {
    if (this.lights.size === 0) return [];
    const at = (light: Light): number =>
      from === undefined
        ? 0
        : (light.at.x - from.x) ** 2 +
          (light.at.y - from.y) ** 2 +
          (light.at.z - from.z) ** 2;

    return [...this.lights.values()]
      .sort((one, other) => at(one) - at(other) || (one.id < other.id ? -1 : 1))
      .slice(0, Math.max(max, 0));
  }

  /** How many lights exist, for a readout. */
  get lightCount(): number {
    return this.lights.size;
  }

  /** How many fields exist, for a readout. */
  get mediumCount(): number {
    return this.mediums.size;
  }

  /**
   * The field at a point, or `undefined` where none stands.
   *
   * **The first box that contains the point, and it is a bound method on purpose** — this is
   * `PlayerWorld.getMediumAt`, handed to the physics, which asks once a frame at the player's
   * centre. With `MAX_MEDIUMS` at 64 that is 64 box tests a frame, which is nothing, and it is the
   * reason the count is capped well below `MAX_ZONES`.
   *
   * **Inclusive on both corners.** A player standing exactly on the edge of a conveyor is on the
   * conveyor, and a half-open box would make the belt drop them the moment they reached its far
   * end — the single most obvious way for this feature to look broken.
   */
  mediumAt = (x: number, y: number, z: number): HostMedium | undefined => {
    for (const owned of this.mediums.values()) {
      const { min, max } = owned;
      if (
        x >= min[0] &&
        x <= max[0] &&
        y >= min[1] &&
        y <= max[1] &&
        z >= min[2] &&
        z <= max[2]
      ) {
        return owned.medium;
      }
    }
    return undefined;
  };

  /**
   * How many timers are waiting, for a readout.
   *
   * **Not the only number that matters, and the reason it is exposed at all** is that a place
   * which fires a timer on every tick looks identical to one that does nothing until the
   * numbers are read: a console that could only say "loaded" is what made this worth having.
   */
  get pendingTimerCount(): number {
    return this.timers.length;
  }

  /** The registry the place writes through, for a readout. */
  get places(): PlaceRegistry {
    return this.options.world.places;
  }

  /** The stored data, for a save. */
  get storedData(): ReadonlyMap<string, string> {
    return this.data;
  }

  /** The most recent failure, or `undefined`. */
  get lastProblem(): string | undefined {
    return this.problem;
  }

  /**
   * Bundles the place, starts the interpreter, and loads it.
   *
   * **Separate from construction because it is the part that can fail**, and the failure is
   * worth catching at a boundary: a bundle error names the file and the import, while a
   * throw from the constructor would be indistinguishable from the host failing to build.
   */
  async load(): Promise<void> {
    const bundle = bundlePlace(this.options.files, this.options.entry);
    const interpreter = await createInterpreter({
      seed: this.options.seed,
      now: this.options.now,
      onDispatch: (tag, payloadJson): string => {
        const outcome = this.dispatch(tag, payloadJson);
        return outcome === undefined ? "" : outcome;
      },
      onQuery: (name, argsJson): string => this.ask(name, argsJson),
    });
    this.interpreter = interpreter;

    // **Reported, not thrown.** A place whose top-level code throws — a `PlaceError` from a
    // refused effect, or its own mistake — is a broken place, not a broken host, and the
    // distinction matters here because `load` is called from a session that is already
    // running. Letting the error out would put a place's failure into the frame loop's error
    // handling, which is where nothing knows what a `PlaceError` is.
    //
    // The interpreter is kept either way, so a place that failed to build can be stepped and
    // will simply do nothing — which is the same outcome as a place that built half of itself.
    try {
      interpreter.load(bundle);
    } catch (error) {
      const detail =
        error instanceof ScriptExecutionError
          ? `${error.kind}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      this.report(`the place failed while loading: ${detail}`);
    }
  }

  /**
   * Runs one frame: timers, then the script, then whatever it asked for.
   *
   * **The order is the whole design.** Timers first, because a timer that came due before this
   * frame began belongs to this frame — a place that sets a zero-delay timer and reacts to it
   * should see it in the same step, not the next one. Effects last, because applying them
   * while the script is still running would let a script see the world it has already changed
   * *part* of, which is the self-feeding field ADR 0009 warns about in a different place.
   */
  step(): void {
    if (this.interpreter === undefined) return;
    this.problem = undefined;

    for (let depth = 0; depth < MAX_CASCADE_STEPS; depth++) {
      this.fireDueTimers();
      const pending = this.log.undelivered();
      if (pending.length === 0 && depth > 0) return;

      const before = this.authoredCount;
      try {
        this.interpreter.step(
          JSON.stringify(this.options.now()),
          encodeEvents(pending),
        );
      } catch (error) {
        if (!(error instanceof ScriptExecutionError)) {
          this.report(
            `the place failed for a reason the host cannot read: ${error}`,
          );
          return;
        }
        this.report(`${error.kind}: ${error.message}`);
      }

      if (this.producedEvents(before) && depth + 1 < MAX_CASCADE_STEPS)
        continue;
      return;
    }
  }

  /**
   * Tells the host where the player is, so zones can report themselves.
   *
   * **This is how a place finds out anything happened.** There are no entities in v1 — no
   * other players, no NPCs — so the player's own movement is the only event a world-building
   * place can react to. A place that wants a door to open makes a zone and waits for this.
   *
   * Derives the crossings rather than being told them: the host remembers where the player
   * was and reports only the zones that were entered or left, so a player standing still inside
   * a zone reports nothing rather than the same thing sixty times a second.
   */
  movePlayer(x: number, y: number, z: number): void {
    const at: Vec3 = { x, y, z };
    if (
      this.lastSeen !== undefined &&
      this.lastSeen.x === x &&
      this.lastSeen.y === y &&
      this.lastSeen.z === z
    ) {
      return;
    }
    this.lastSeen = at;

    const now = this.options.now();
    for (const zone of this.zones.values()) {
      const was = this.inside.has(zone.id);
      const is = pointInZone(zone, x, y, z);
      if (was === is) continue;
      if (is) this.inside.add(zone.id);
      else this.inside.delete(zone.id);
      // **Entered and left are the same crossing seen from two sides**, which is why one
      // branch decides rather than two. A player who moves from inside a zone to outside it
      // has left it; a player who moves from outside to inside has entered it; a player who
      // moves within either has done neither, and `was === is` above has already said so.
      this.author(is ? "zone-entered" : "zone-left", { zoneId: zone.id }, now);
    }
  }

  /** Forgets the host. The interpreter's memory is not reclaimed without this. */
  dispose(): void {
    this.interpreter?.dispose();
    this.interpreter = undefined;
    this.zones.clear();
    this.lights.clear();
    this.mediums.clear();
    this.inside.clear();
    this.timers = [];
  }

  /* ------------------------------------------------------------- dispatching */

  /**
   * Checks one effect and carries it out, or returns why not.
   *
   * **The trust boundary, called once per effect.** `inspectEffect` decides whether the effect
   * is well-formed — and that check is the whole reason a peer's bytes cannot reach the fold
   * malformed. Only then does `apply` run, and only on an effect that passed.
   */
  private dispatch(tag: string, payloadJson: string): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadJson);
    } catch {
      return this.refuse(tag, "payload is not JSON");
    }

    const inspected = inspectEffect(tag, parsed);
    if ("refusal" in inspected) {
      return this.refuse(tag, inspected.refusal.reason);
    }

    try {
      this.apply(inspected.effect);
      return undefined;
    } catch (error) {
      // An effect that throws is a bug in the host, not in the place, so it is reported and
      // the step continues. The alternative — letting it out — would put the host's own frame
      // in a place's error handling.
      return this.refuse(
        tag,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Applies one checked effect.
   *
   * **A `switch` over the whole vocabulary, and that is deliberate.** Every effect is handled
   * in this one function rather than in nineteen handlers scattered across the host, so the
   * question "is every tag handled?" is answerable by reading it, and `no case matches` is a
   * type error rather than a silent no-op.
   *
   * Deterministic: given the same state and the same effect, the same thing happens.
   */
  private apply(effect: ParsedEffect): void {
    const payload = effect.payload as Record<string, unknown>;

    /**
     * Reads a payload field.
     *
     * **A payload is JSON, so a position is a three-element array; an `Operation` holds a
     * `Vec3`, which is an object.** Every conversion is here rather than at each call site,
     * and the reason is that the two shapes are genuinely different: an array crosses the
     * boundary as an array because that is what `JSON.stringify` makes of a tuple, and an
     * object would be a shape the guest library would have to build and the host would have to
     * take apart. So `vec3` and `quat` are the two places the wire and the model differ, and
     * they are named rather than inlined at thirteen call sites.
     */
    const name = (key: string): string => String(payload[key]);
    const number = (key: string): number => Number(payload[key]);
    const optionalNumber = (key: string): number | undefined =>
      payload[key] === undefined ? undefined : Number(payload[key]);
    const vec3 = (key: string): Vec3 => {
      const value = payload[key] as [number, number, number];
      return { x: value[0], y: value[1], z: value[2] };
    };
    const quat = (key: string): Quat | undefined => {
      const value = payload[key] as
        [number, number, number, number] | undefined;
      return value === undefined
        ? undefined
        : { x: value[0], y: value[1], z: value[2], w: value[3] };
    };
    const shape = (key: string): OperationShape =>
      payload[key] as OperationShape;

    switch (effect.tag) {
      case "shape-add": {
        const place = this.place(name("place"));
        const combine = name("combine") as Operation["combine"];
        const operation: Operation = {
          origin: vec3("at"),
          orientation: quat("orientation") ?? IDENTITY,
          shape: shape("shape"),
          softness: optionalNumber("softness") ?? 0,
          combine,
          // Opacity is carried either way — it is a number every operation has and the
          // serialiser always writes it — but it only means anything where a colour is
          // painted, and an unpainted operation's opacity is read and discarded.
          opacity: optionalNumber("opacity") ?? 1,
          // **The colour only where the effect is painting**, and this is the same rule
          // the brush follows. A colour on any operation decides the colour of the surface
          // there, so a bridge built with `combine: "Add"` and the default white would paint
          // itself white rather than take the world's material — and a place author who set
          // a colour on an `Add` would get a coloured solid, which is a thing worth being
          // able to ask for and not worth having as a side effect of leaving it out.
          ...(combine === "Paint"
            ? { colour: (payload["colour"] as Operation["colour"]) ?? WHITE }
            : {}),
          // **A placeholder, not a value.** `PlaceHandle.add` overwrites the index — it is
          // the only thing that may set one, because an index is a position in the fold and
          // the fold's order has to come from the shared counter (ADR 0016). Anything else here
          // would be a shape folded somewhere its author did not ask for.
          index: 0,
        };
        const added = place.add(name("id"), operation);
        // `add` returns undefined for a full place *or* a taken id, and the effect vocabulary
        // cannot tell the two apart — so both are reported the same way. That is deliberate:
        // the script's next step is the same either way, which is to use different ids or a
        // bigger place.
        if (added === undefined) {
          throw new Error(
            `could not add "${name("id")}": the place is full at ${MAX_OPERATIONS_PER_PLACE} operations, or that id is taken`,
          );
        }
        // The box of the whole place rather than of this one shape, and deliberately: `add`
        // reports nothing about where it put the operation, and a caller re-meshing a shape's
        // own box would miss the neighbours a *subtract* changed. Recomputing the place's
        // bounds is O(n) over a list capped at `MAX_OPERATIONS_PER_PLACE`, and it happens once
        // per shape added rather than once per frame.
        this.geometryChanged(place.bounds);
        return;
      }

      // **Each of these re-meshes with the box the place had *before* the removal.** A remove
      // has no new bounds to report, and `undefined` would tell the caller to re-mesh nothing —
      // which is exactly backwards: the surface that is now missing is the box the removed
      // shape was in. So the box is read first and handed over afterwards.
      case "shape-remove": {
        const place = this.place(name("place"));
        const was = place.bounds;
        if (place.remove(name("id"))) this.geometryChanged(was);
        return;
      }

      case "place-remove": {
        const place = this.place(name("place"));
        const was = place.bounds;
        if (this.options.world.places.remove(name("place")))
          this.geometryChanged(was);
        return;
      }

      case "place-clear": {
        const place = this.place(name("place"));
        const was = place.bounds;
        if (this.options.world.places.clear(name("place")))
          this.geometryChanged(was);
        return;
      }

      case "zone-add": {
        if (this.zones.has(name("id")))
          throw new Error(`a zone called "${name("id")}" exists`);
        if (this.zones.size >= MAX_ZONES) {
          throw new Error(`a place may hold ${MAX_ZONES} zones at once`);
        }
        const [a, b] = payload["box"] as [
          [number, number, number],
          [number, number, number],
        ];
        this.zones.set(name("id"), {
          id: name("id"),
          label: optionalString(payload, "label") ?? name("id"),
          min: [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.min(a[2], b[2]),
          ],
          max: [
            Math.max(a[0], b[0]),
            Math.max(a[1], b[1]),
            Math.max(a[2], b[2]),
          ],
        });
        return;
      }

      case "zone-remove":
        this.zones.delete(name("id"));
        this.inside.delete(name("id"));
        return;

      case "light-add": {
        if (this.lights.has(name("id"))) {
          throw new Error(`a light called "${name("id")}" exists`);
        }
        if (this.lights.size >= MAX_LIGHTS) {
          throw new Error(`a world may hold ${MAX_LIGHTS} lights at once`);
        }
        const at = payload["at"] as [number, number, number];
        const colour = payload["colour"] as { r: number; g: number; b: number };
        this.lights.set(name("id"), {
          id: name("id"),
          at: { x: at[0], y: at[1], z: at[2] },
          // **Normalised here, once.** 255 to 1 is the only conversion in the place layer, and it
          // is at the boundary rather than in a shader or a per-draw thunk.
          colour: [
            colour.r / MAX_CHANNEL,
            colour.g / MAX_CHANNEL,
            colour.b / MAX_CHANNEL,
          ],
          radius: number("radius"),
          intensity: number("intensity"),
        });
        return;
      }

      case "light-remove":
        this.lights.delete(name("id"));
        return;

      case "medium-add": {
        if (this.mediums.has(name("id"))) {
          throw new Error(`a medium called "${name("id")}" exists`);
        }
        if (this.mediums.size >= MAX_MEDIUMS) {
          throw new Error(`a world may hold ${MAX_MEDIUMS} fields at once`);
        }
        const [a, b] = payload["box"] as [
          [number, number, number],
          [number, number, number],
        ];
        this.mediums.set(name("id"), {
          id: name("id"),
          // **Corners sorted, as a zone's are.** A place author writes two opposite corners in
          // whatever order they think of them, and a box whose min is above its max contains
          // nothing — which would be a conveyor that silently does not push.
          min: [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.min(a[2], b[2]),
          ],
          max: [
            Math.max(a[0], b[0]),
            Math.max(a[1], b[1]),
            Math.max(a[2], b[2]),
          ],
          medium: {
            pushVx: number("pushVx"),
            pushVz: number("pushVz"),
            // **`undefined` becomes `null`, because that is what the physics asks for.** A field
            // that did not name a vertical pull should not be fighting the fall at all, and the
            // type says `null` for "none" rather than zero.
            pushVy: optionalNumber("pushVy") ?? null,
            speedScale: number("speedScale"),
            sink: optionalNumber("sink") ?? 0,
          },
        });
        return;
      }

      case "medium-remove":
        this.mediums.delete(name("id"));
        return;

      case "clock-set":
        // The seconds are already checked to `0..1200` by the effect's rule, so this is a
        // whole number of seconds into the cycle rather than a mark that needs reducing.
        this.options.clock.jumpTo(number("seconds"));
        return;

      case "clock-speed":
        this.options.clock.setSpeed(number("multiplier"));
        return;

      case "player-place":
        this.options.effects.movePlayer(vec3("at"), optionalNumber("yaw"));
        return;

      case "player-speed":
        this.options.effects.setPlayerSpeed(number("multiplier"));
        return;

      case "player-jump":
        this.options.effects.setPlayerJump(number("multiplier"));
        return;

      case "player-fly":
        this.options.effects.setFlying(payload["on"] === true);
        return;

      case "camera-look":
        this.options.effects.lookAt(vec3("at"), optionalNumber("fov"));
        return;

      case "camera-clear":
        this.options.effects.clearCamera();
        return;

      case "log":
        this.options.effects.log(name("text"));
        return;

      case "toast":
        this.options.effects.toast(name("text"));
        return;

      case "timer":
        this.setTimer(name("id"), number("afterMs"));
        return;

      case "data-set":
        this.setData(name("key"), name("value"));
        return;

      case "data-delete":
        this.deleteData(name("key"));
        return;
    }
  }

  /* ---------------------------------------------------------------- querying */

  /**
   * Answers a script's question, or says why it cannot.
   *
   * **Every branch returns JSON, and no branch can change anything.** The interpreter already
   * refuses a name that is not in the closed set, so the `default` here is unreachable from a
   * place and exists for the case of the host and the bridge disagreeing — which `tsc` would
   * catch, so this is a runtime belt rather than a type-level brace.
   */
  private ask(name: string, argsJson: string): string {
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return JSON.stringify(null);
    }
    const values = Array.isArray(args) ? (args as unknown[]) : [];
    const world = this.options.world;
    const triple = (at: number): [number, number, number] => {
      const value = values[at] as [number, number, number];
      return [value[0], value[1], value[2]];
    };

    switch (name as GuestQuery) {
      case "getSolidAt":
        return JSON.stringify(
          world.solidAt(
            Number(values[0]),
            Number(values[1]),
            Number(values[2]),
          ),
        );
      case "getHeightAt":
        // **No terrain, and a zero rather than a refusal.** A query cannot fail (see
        // `bridge.ts`), and a world with no height field is a world where every column is
        // flat — which is what an editor session over an operations-only model *is*, so this
        // is the common case rather than an edge.
        return JSON.stringify(
          world.terrainHeight?.(Number(values[0]), Number(values[1])) ?? 0,
        );
      case "getWaterAt":
        return JSON.stringify(
          world.waterAt(
            Number(values[0]),
            Number(values[1]),
            Number(values[2]),
          ),
        );
      case "getMediumAt": {
        // **`undefined` becomes `null`,** because that is what the guest library's type says and
        // `JSON.stringify(undefined)` is `undefined`, which is not JSON and would reach the
        // interpreter as the string "undefined" rather than as a missing value.
        const medium = world.mediumAt?.(
          Number(values[0]),
          Number(values[1]),
          Number(values[2]),
        );
        return JSON.stringify(medium ?? null);
      }

      case "raycast":
        return JSON.stringify(
          world.raycast(triple(0), triple(1), Number(values[2])) ?? null,
        );
      case "getData":
        return JSON.stringify(this.data.get(String(values[0])) ?? null);
      default:
        // Unreachable from a place: the interpreter refuses a name not in the closed set.
        // Here for the host and the bridge disagreeing, which `tsc` also catches — so this is
        // a runtime belt rather than a type-level brace.
        return JSON.stringify(null);
    }
  }

  /* -------------------------------------------------------------------- data */

  private setData(key: string, value: string): void {
    if (!this.data.has(key) && this.data.size >= MAX_DATA_KEYS) {
      throw new Error(`a place may store ${MAX_DATA_KEYS} values at once`);
    }
    this.data.set(key, value);
    this.author(
      "data-changed",
      { scope: "global", player: "local", key, deleted: false, value },
      this.options.now(),
    );
  }

  private deleteData(key: string): void {
    // A delete of something absent still authors the fact: a peer that has it needs to hear
    // that it no longer does, and silence would leave the two logs different.
    this.data.delete(key);
    this.author(
      "data-changed",
      { scope: "global", player: "local", key, deleted: true },
      this.options.now(),
    );
  }

  /* ------------------------------------------------------------------ timers */

  /**
   * Schedules a timer, and says so if it could not.
   *
   * **A timer is an event that has not happened yet, which is why this is the only
   * deferral mechanism in the vocabulary.** There are no guest promises and no `await`
   * (ADR 0015), so a place that wants to do something later asks for an event.
   *
   * Re-setting an id replaces it rather than queueing a second, so a place that sets the same
   * timer every step gets one event when it stops — which is the behaviour that makes a
   * per-step `after` usable rather than a way to fill the host's table in a second.
   */
  private setTimer(id: string, afterMs: number): void {
    // **Ignored while one with that id is already pending, rather than replacing it.** This is
    // the second version of this method and the first one was wrong in a way that only showed
    // up when a test used it: the first replaced, which meant a place writing the obvious
    // `if (!fired) after("later", 1000)` inside a per-frame handler re-armed its own timer
    // before it could ever come due, and so *never fired*. Silently, with no error anywhere.
    //
    // Ignoring makes the natural pattern work — arm once, fire once — and a place that wants
    // a repeating timer re-arms it when the event arrives, by which point the id is free. The
    // cost is that a pending timer cannot be pushed back, which no v1 effect needs.
    if (this.timers.some((timer) => timer.id === id)) return;

    if (this.timers.length >= MAX_PENDING_TIMERS) {
      throw new Error(
        `a place may have ${MAX_PENDING_TIMERS} timers pending at once`,
      );
    }
    this.timers.push({ id, dueAt: this.options.now() + afterMs });
  }

  /**
   * Fires the timers that are due, in sorted id order.
   *
   * **Sorted rather than in the order they were set**, so two peers agree about which of two
   * timers that came due in the same millisecond came first. Two timers becoming due together
   * is ordinary — two `after(…, 0)` calls in one step — and arrival order would leave it to
   * whichever the script's execution happened to reach first.
   *
   * **The event id is minted here, not when the timer was set.** It was minted at set time in
   * the first version, and that quietly defeated the sort: the ids were already assigned in the
   * order the script set them, so sorting the timers afterwards could not reorder anything and
   * the log's own order (`at`, then producer, then id) put them back the way they came in. An
   * event's identity belongs to when the event *happened*, and that is also what makes two
   * peers agree: same timers, same order, same ids.
   */
  private fireDueTimers(): void {
    if (this.timers.length === 0) return;
    const now = this.options.now();
    const due = this.timers
      .filter((timer) => timer.dueAt <= now)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (due.length === 0) return;

    this.timers = this.timers.filter((timer) => timer.dueAt > now);
    for (const timer of due) {
      this.authoredCount++;
      this.log.add({
        id: makeEventId("local", timer.dueAt, this.sequence++),
        at: timer.dueAt,
        producer: "local",
        kind: "timer",
        payload: { timerId: timer.id },
      });
    }
  }

  /* ------------------------------------------------------------------- zones */

  /* ------------------------------------------------------------------ events */

  /**
   * Authors a fact this peer produced.
   *
   * **The id is assembled, never generated** — `producer:at:sequence` — and `sequence` is this
   * peer's own counter, which is what makes two events in the same millisecond distinguishable.
   * It is also what makes the id *reproducible*: every peer running the same script reaches the
   * same events in the same order, so the same ids, so the same fold.
   */
  private author(
    kind: ScriptEvent["kind"],
    payload: Record<string, unknown>,
    at: number,
  ): void {
    this.authoredCount++;
    this.log.add({
      id: makeEventId("local", at, this.sequence++),
      at,
      producer: "local",
      kind,
      payload,
    });
  }

  /** Whether applying effects produced anything a script has not been stepped for. */
  private producedEvents(since: number): boolean {
    return this.authoredCount !== since;
  }

  /* ------------------------------------------------------------------ shared */

  /**
   * The place an effect names, created if it does not exist.
   *
   * **Creating on demand rather than requiring a separate `place-add`**, because a place is a
   * name for a group of shapes and the group appearing and the name appearing are the same
   * moment. A separate tag would mean a script that created a shape without the tag got a
   * refusal, which is a worse outcome than a place that appears when something is first put in
   * it.
   */
  private place(name: string): PlaceHandle {
    return this.options.world.places.create(name);
  }

  /** Hands the caller the box a place's geometry now covers, so it can re-mesh that much. */
  private geometryChanged(bounds: Bounds | undefined): void {
    this.options.world.geometryChanged(bounds);
  }

  /** Reports a problem and returns it, so `dispatch` can hand it back to the script. */
  private refuse(tag: string, reason: string): string {
    const message = `${tag} refused: ${reason}`;
    this.problem = message;
    this.report(message);
    return message;
  }

  private report(message: string): void {
    this.problem ??= message;
    this.options.onNotice?.(message);
  }
}

/** The unit rotation every operation starts from, and the one a payload without one means. */
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

/** The colour a payload without one means: white, which `makeOperation` also defaults to. */
const WHITE = { r: 255, g: 255, b: 255 };

/** A payload field that may be absent, read without asserting it is present. */
const optionalString = (
  payload: Record<string, unknown>,
  key: string,
): string | undefined =>
  payload[key] === undefined ? undefined : String(payload[key]);

/** Whether a point is inside a zone's box, inclusive of its faces. */
const pointInZone = (zone: Zone, x: number, y: number, z: number): boolean =>
  x >= zone.min[0] &&
  x <= zone.max[0] &&
  y >= zone.min[1] &&
  y <= zone.max[1] &&
  z >= zone.min[2] &&
  z <= zone.max[2];
