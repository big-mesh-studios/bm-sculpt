/**
 * The events: everything the host tells a place script has happened.
 *
 * ## Why effects are not enough
 *
 * An effect is a request and events are facts, and the distinction is the whole of the
 * multiplayer model. Under ADR 0016's authority model there is no server and every peer
 * runs every place, so **the operation list is recomputed on each peer rather than
 * received**: two peers that run the same script against the same seed derive the same
 * bridge without either of them sending geometry to the other.
 *
 * What cannot be recomputed is anything that *happened*. A player walked into a door, a
 * timer came due, someone died. Those are facts, they travel, and they arrive — late, out
 * of order, twice, or never. So this file is where the determinism requirements live, and
 * they are four:
 *
 * 1. **An event has an id the producer chose, and it is never generated here.** Every peer
 *    runs every script, so an id this peer invented would be a different id on every peer
 *    and every effect would apply N times.
 * 2. **An event has a position in a total order, and it is not arrival order.** Two peers
 *    given the same facts must fold them the same way whatever order they arrived in, so
 *    the order is `at`, then `producer`, then `id` — all three of which are in the event.
 * 3. **Delivery is idempotent.** A fact applied twice must be applied once, so the log
 *    keys on the id and a repeat is dropped rather than folded.
 * 4. **The clock is injected.** `at` comes from a shared clock rather than `Date.now`, or
 *    two peers a few hundred milliseconds apart order the same facts differently and never
 *    re-converge.
 *
 * ## What is here
 *
 * Seven kinds, which is what a world-building place needs to be a world rather than a
 * diorama: people arriving and leaving, the triggers a script placed reporting themselves,
 * the one deferred thing (`timer`), death, and a change to stored state. Not figures,
 * items, damage or dialog — each belongs to a system this engine does not have, and
 * ADR 0017 records the omissions.
 */

import {
  MAX_CAUSE_LENGTH,
  MAX_EVENT_ID_LENGTH,
  MAX_PLAYER_ID_LENGTH,
  MAX_PRODUCER_LENGTH,
  MAX_ZONE_NAME_LENGTH,
} from "./limits";
import { checkPayload, type FieldRule, type Refusal } from "./fields";

/** Every kind. The union of these is what `EventKind` is. */
export const EVENT_KINDS = [
  /** A peer arrived in this place. */
  "player-joined",
  /** A peer left. */
  "player-left",
  /** A player died, for whatever reason a place or the world decided. */
  "player-died",
  /** The player entered a zone this place placed. */
  "zone-entered",
  /** …and left it. */
  "zone-left",
  /** A timer a place set came due. */
  "timer",
  /** A stored value changed, locally or on another peer. */
  "data-changed",
] as const;

/** Every kind, as a type. */
export type EventKind = (typeof EVENT_KINDS)[number];

/** The id of an event, assembled by {@link eventId} rather than generated anywhere else. */
export type EventId = string;

/** A fact, with everything needed to order it and to know whether it has been applied. */
export interface ScriptEvent<P = Record<string, unknown>> {
  /**
   * Unique among events from this producer, forever.
   *
   * The producer's own, and never generated: see rule 1 above. `eventId` builds it.
   */
  readonly id: EventId;
  /** When it happened, on the shared clock, in milliseconds. */
  readonly at: number;
  /** Who caused it — a peer's identity. `"local"` for a peer acting on itself. */
  readonly producer: string;
  readonly kind: EventKind;
  /** What happened, checked against `EVENT_FIELDS[kind]`. */
  readonly payload: P;
}

/** A player identity. Peer-supplied, so bounded, and never interpolated anywhere. */
const playerField = (): FieldRule => ({
  name: "player",
  kind: "name",
  required: true,
  about: `a peer's identity, at most ${MAX_PLAYER_ID_LENGTH} characters`,
});

/** The fields each kind's payload is checked against. */
export const EVENT_FIELDS: Readonly<Record<EventKind, readonly FieldRule[]>> = {
  "player-joined": [playerField()],
  "player-left": [playerField()],
  "player-died": [
    playerField(),
    {
      name: "cause",
      kind: "name",
      required: true,
      about: `what killed them, at most ${MAX_CAUSE_LENGTH} characters`,
    },
  ],
  "zone-entered": [
    {
      name: "zoneId",
      kind: "name",
      required: true,
      about: "the zone that was entered, by the id `zone-add` gave it",
    },
  ],
  "zone-left": [
    {
      name: "zoneId",
      kind: "name",
      required: true,
      about: "the zone that was left",
    },
  ],
  timer: [
    {
      name: "timerId",
      kind: "name",
      required: true,
      about: "the timer that came due, by the id the script gave it",
    },
  ],
  "data-changed": [
    {
      name: "scope",
      kind: "enum",
      values: ["global", "player"],
      required: true,
      about: "whose value changed",
    },
    playerField(),
    {
      name: "key",
      kind: "name",
      required: true,
      about: "which value changed",
    },
    {
      name: "deleted",
      kind: "boolean",
      required: true,
      about: "true when the value went away rather than being written",
    },
    {
      name: "value",
      kind: "text",
      about: "what it is now; absent when `deleted`",
    },
  ],
};

/**
 * Builds an event's id.
 *
 * **`producer:at:sequence`, and each part is load-bearing.** The producer is first because
 * two peers may legitimately author the same event at the same millisecond and their ids
 * must still differ. `at` is second so that ids sort chronologically, which makes the log's
 * own iteration order a sane one to read. The sequence is last so that a producer that
 * emits two events in one millisecond — which a script doing two `zone-entered` in a frame
 * will — still gets two distinct ids.
 *
 * Built here rather than in the host so that there is one place that knows the shape, and
 * so that a peer which invented its own id format could not interleave events with the ones
 * it received.
 */
export const eventId = (
  producer: string,
  at: number,
  sequence: number,
): EventId => `${producer}:${Math.trunc(at)}:${Math.trunc(sequence)}`;

/** Whether `kind` is one this build offers. */
export const isEventKind = (value: unknown): value is EventKind =>
  typeof value === "string" &&
  (EVENT_KINDS as readonly string[]).includes(value);

/**
 * Checks an event and returns it, or undefined.
 *
 * **The id, the clock and the producer are validated here too**, not only the payload,
 * because all three are peer-supplied and all three are load-bearing: a duplicate id would
 * be folded once when it should be twice, and an event whose `at` is `NaN` cannot be
 * ordered at all.
 *
 * Refused whole, for the same reason an effect is.
 */
export const parseEvent = (value: unknown): ScriptEvent | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;

  const id = candidate["id"];
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (id.length > MAX_EVENT_ID_LENGTH) return undefined;

  const at = candidate["at"];
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;

  const producer = candidate["producer"];
  if (typeof producer !== "string" || producer.length === 0) return undefined;
  if (producer.length > MAX_PRODUCER_LENGTH) return undefined;

  const kind = candidate["kind"];
  if (!isEventKind(kind)) return undefined;

  const refusal: Refusal | null = checkPayload(
    EVENT_FIELDS[kind],
    candidate["payload"],
  );
  if (refusal !== null) return undefined;

  return {
    id,
    at,
    producer,
    kind,
    // Safe for the same reason `parseEffect`'s is: `EVENT_FIELDS[kind]` is the definition of
    // this payload and `checkPayload` is its checker.
    payload: candidate["payload"] as Record<string, unknown>,
  };
};

/** The wire form: a JSON string, because nothing crosses as an object (ADR 0015). */
export const encodeEvent = (event: ScriptEvent): string =>
  JSON.stringify(event);

/**
 * Decodes a batch, dropping anything malformed and reporting what was dropped.
 *
 * A batch rather than one event, because that is how they travel, and because a peer that
 * sent five facts where three were well-formed should have the three applied — **the
 * dropped ones are named in the return value**, so "some events were refused" is never the
 * whole story.
 */
export const decodeEvents = (
  json: unknown,
): { readonly events: ScriptEvent[]; readonly refused: number } => {
  if (typeof json !== "string") return { events: [], refused: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { events: [], refused: 0 };
  }
  if (!Array.isArray(parsed)) return { events: [], refused: 0 };

  const events: ScriptEvent[] = [];
  let refused = 0;
  for (const candidate of parsed) {
    const event = parseEvent(candidate);
    if (event === undefined) refused++;
    else events.push(event);
  }
  return { events, refused };
};

/**
 * The order two events fold in.
 *
 * **`at`, then `producer`, then `id` — all three, always.** Any subset is a bug that
 * looks fine on one peer and wrong on the second, because two events can share a
 * millisecond and two producers can share an identity.
 *
 * *Why* this order rather than the other two permutations: `at` first because causality is
 * the only ordering a script can reason about; `producer` second because it is fixed for
 * the life of a peer and so is stable across a long event history; and `id` last because
 * it is the only one guaranteed unique, which makes the comparison **total**. A total
 * order is what lets two peers hold different sets of the same facts and still agree.
 */
export const compareEvents = (a: ScriptEvent, b: ScriptEvent): number => {
  if (a.at !== b.at) return a.at - b.at;
  if (a.producer !== b.producer) return a.producer < b.producer ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

/** The order a script is handed events in. Ascending. */
export const inOrder = (events: readonly ScriptEvent[]): ScriptEvent[] =>
  [...events].sort(compareEvents);

/** How long a peer may keep an event, in milliseconds. A day. */
export const MAX_EVENT_LIFETIME_MS = 86_400_000;

/** Re-exported so a host reading its bounds finds the zone name limit beside them. */
export const ZONE_NAME_LIMIT = MAX_ZONE_NAME_LENGTH;
