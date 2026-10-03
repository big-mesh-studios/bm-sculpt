/**
 * The replicated fact store: an event log that is the same log on every peer.
 *
 * ## The shape of the problem
 *
 * Under the multiplayer model there is no server. Peers exchange events, and every peer
 * runs every place, so a script must reach the same conclusion from the same facts on every
 * machine. Three things follow, and this file is exactly those three things:
 *
 * - **Facts are never forgotten.** A peer that joins late needs the whole history, because
 *   the log is the log — a log missing its first hundred events is a different log. So
 *   this is not a ring buffer, and exceeding `MAX_EVENTS` is a *refusal* rather than an
 *   eviction. An eviction would be silently divergent, which is the one failure mode the
 *   whole design exists to rule out.
 * - **Application is idempotent.** The same fact can arrive twice — from a peer and from a
 *   retry, or from two peers who both saw it — and must be folded once. The log keys on
 *   the event's id, which is why that id is the producer's to choose and never generated
 *   (see `events.ts`).
 * - **The order is the fold's, not arrival's.** `inOrder()` sorts, so a peer that received
 *   events 3, 1, 2 folds them 1, 2, 3. Arrival order would make two peers diverge the
 *   moment their connections hiccuped.
 *
 * ## What this is not
 *
 * It is not a transport, and it does not know one exists. Merging a peer's batch is one
 * call; deciding when to make it is Phase F's problem, and this file is unchanged by that
 * decision.
 */

import { MAX_EVENTS } from "./limits";
import {
  compareEvents,
  decodeEvents,
  parseEvent,
  type EventId,
  type ScriptEvent,
} from "./events";

export class EventLog {
  /**
   * By id, which is what makes `add` idempotent and `has` a lookup rather than a scan.
   *
   * A `Map` and not an array because the two questions are different sizes: "have I seen
   * this?" is asked once per arriving event and must not be linear, while "give me the
   * order" is answered once per step and is allowed to sort.
   */
  private readonly byId = new Map<EventId, ScriptEvent>();
  /** Ids already handed to a script, so a step is not stepped twice for one fact. */
  private readonly delivered = new Set<EventId>();

  /** How many facts are held. */
  get size(): number {
    return this.byId.size;
  }

  /** Whether that fact has arrived. */
  has(id: EventId): boolean {
    return this.byId.has(id);
  }

  /** That fact, if it has arrived. */
  get(id: EventId): ScriptEvent | undefined {
    return this.byId.get(id);
  }

  /**
   * Records a fact, if it is well-formed and not already held.
   *
   * **Returns what changed, and a caller should act on that rather than on arrival.** A
   * peer that sends the same batch twice — which a retry does — gets `0` the second time,
   * and a host that ignores this will fold the fact twice.
   *
   * Refused rather than partially recorded: a malformed event is dropped whole, and the
   * log's other events are untouched. A log that had accepted half of an event would be a
   * log two peers disagreed about.
   */
  add(event: ScriptEvent): boolean {
    if (this.byId.has(event.id)) return false;
    if (this.byId.size >= MAX_EVENTS) return false;
    this.byId.set(event.id, event);
    return true;
  }

  /**
   * Merges facts from a peer, and reports what was new.
   *
   * The number is *new* facts, which is the only number worth acting on: a peer resending
   * a batch reports zero, and a host that stepped its script for the whole batch rather
   * than the new part would step for nothing.
   */
  apply(events: readonly ScriptEvent[]): number {
    let added = 0;
    for (const event of events) {
      if (this.add(event)) added++;
    }
    return added;
  }

  /**
   * Merges a peer's wire batch, reporting both what was new and what was refused.
   *
   * `refused` is here so that a host can log it. A peer sending events this build cannot
   * read is a version skew, and a version skew that is invisible is a peer whose world
   * quietly differs from everyone else's.
   */
  applyJson(json: unknown): {
    readonly added: number;
    readonly refused: number;
  } {
    const { events, refused } = decodeEvents(json);
    return { added: this.apply(events), refused };
  }

  /**
   * Facts a script has not been stepped for yet, in the order they fold.
   *
   * Sorted here rather than at insertion, so that the order a script sees is the total
   * order from `events.ts` and not the order the network happened to deliver in. Marked as
   * delivered *before* returning, so a step that throws still consumes them: a script that
   * fails is a script with a bug, and re-running it on the same facts would loop forever.
   */
  undelivered(): ScriptEvent[] {
    const pending: ScriptEvent[] = [];
    for (const event of this.byId.values()) {
      if (this.delivered.has(event.id)) continue;
      pending.push(event);
      this.delivered.add(event.id);
    }
    return pending.sort(compareEvents);
  }

  /** Everything, in fold order. For a read-out, not for stepping. */
  all(): ScriptEvent[] {
    return [...this.byId.values()].sort(compareEvents);
  }

  /**
   * The wire form of everything not yet delivered, and marks it delivered.
   *
   * For a peer relaying its own facts onward. Separate from `undelivered` because
   * *delivering to a script* and *having sent it to a peer* are different questions — a
   * peer that asked to relay only after stepping would hold facts back from the rest of
   * the mesh — and conflating them means a fact is either stepped twice or relayed late.
   */
  undeliveredJson(): string {
    return encodeEvents(this.undelivered());
  }

  /**
   * Marks a fact as stepped for, without stepping.
   *
   * For a log restored from a save: the history a place was saved with has already been
   * folded into whatever the script did, so re-stepping it would repeat every decision it
   * ever made. The distinction is `has` versus this — a fact can be held and not pending,
   * and a log where those are the same thing can only ever start empty.
   */
  markDelivered(id: EventId): void {
    this.delivered.add(id);
  }

  /** Whether a fact is waiting to be stepped. */
  isPending(id: EventId): boolean {
    return this.byId.has(id) && !this.delivered.has(id);
  }

  /** Forgets everything, delivered state included. For loading a saved place. */
  clear(): void {
    this.byId.clear();
    this.delivered.clear();
  }
}

/** The wire form of a list of facts. */
export const encodeEvents = (events: readonly ScriptEvent[]): string =>
  JSON.stringify(events);

/** Decodes and validates a list of facts, dropping what is malformed. */
export { decodeEvents };

/**
 * Builds the log a saved place starts from.
 *
 * Separate from `new EventLog()` because a loaded log is one whose ids are already in
 * `delivered` — a saved place should not step its script for the history it was saved
 * with. The events themselves are still checked, because a saved file is untrusted input in
 * exactly the way a peer's bytes are.
 */
export const loadedEventLog = (json: unknown): EventLog => {
  const { events } = decodeEvents(json);
  const log = new EventLog();
  for (const event of events) log.add(event);
  for (const event of log.all()) log.markDelivered(event.id);
  return log;
};

/** Reads a single event off a wire. Exported for the host's per-event path. */
export const parseWireEvent = (json: unknown): ScriptEvent | undefined =>
  typeof json === "string" ? parseEvent(safeParse(json)) : undefined;

const safeParse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
};
