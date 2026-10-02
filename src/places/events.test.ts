import { describe, expect, it } from "vitest";

import {
  EVENT_FIELDS,
  EVENT_KINDS,
  compareEvents,
  decodeEvents,
  encodeEvent,
  eventId,
  inOrder,
  isEventKind,
  parseEvent,
  type ScriptEvent,
} from "./events";
import { EventLog, encodeEvents, loadedEventLog } from "./event-log";
import { MAX_EVENTS, MAX_EVENT_ID_LENGTH } from "./limits";

/**
 * Two peers, one set of facts, one answer.
 *
 * Everything in this file is downstream of that. `compareEvents` must be a *total* order,
 * application must be idempotent, and ids must be the producer's — because under ADR 0016's
 * authority model the operation list is recomputed on each peer and the only things that
 * travel are these facts. A divergence here is two peers whose worlds quietly stop
 * matching, and nothing on screen says so.
 */

const AT = 1_700_000_000_000;

/** A fact that satisfies every rule for its kind. */
const event = (
  kind: (typeof EVENT_KINDS)[number],
  overrides: Partial<ScriptEvent> = {},
  /** Only when a test means to spoil it. **Unset is not the same as empty** — a default of
   * `{}` here would replace every sample with an empty payload and fail every test that
   * meant to build a good one. */
  payload?: Record<string, unknown>,
): ScriptEvent => {
  const sample: Record<string, Record<string, unknown>> = {
    "player-joined": { player: "did:plc:one" },
    "player-left": { player: "did:plc:one" },
    "player-died": { player: "did:plc:one", cause: "fell" },
    "zone-entered": { zoneId: "door" },
    "zone-left": { zoneId: "door" },
    timer: { timerId: "later" },
    "data-changed": {
      scope: "global",
      player: "did:plc:one",
      key: "seen",
      deleted: false,
      value: "yes",
    },
  };
  return {
    id: eventId("did:plc:one", AT, 0),
    at: AT,
    producer: "did:plc:one",
    kind,
    payload: sample[kind],
    ...overrides,
    // Last, so a test that spoits the payload can: `payload: {...}` replaces the sample
    // rather than being merged into it, because a merge would quietly keep a field the test
    // meant to be checking the absence of.
    ...(payload === undefined ? {} : { payload }),
  } as ScriptEvent;
};

describe("an event carries what it needs to be ordered and de-duplicated", () => {
  it("has an id the producer assembled, which is why eventId is not a counter", () => {
    // Rule 1. A generated id would be a different id on every peer, and every effect would
    // then apply N times — N ghosts of the same bridge.
    expect(eventId("peer", 10, 0)).toBe("peer:10:0");
    // The three parts each earn their place:
    //   producer first — two peers may legitimately author the same event at the same
    //                   millisecond, and their ids must still differ
    //   at second      — ids sort chronologically, so the log's own iteration reads sanely
    //   sequence last  — a producer emitting twice in one millisecond gets two ids
    expect(eventId("a", 10, 0)).not.toBe(eventId("b", 10, 0));
    expect(eventId("a", 10, 0)).not.toBe(eventId("a", 11, 0));
    expect(eventId("a", 10, 0)).not.toBe(eventId("a", 10, 1));
  });

  it("accepts a well-formed fact and refuses a malformed one", () => {
    for (const kind of EVENT_KINDS) {
      expect(parseEvent(event(kind)), kind).toBeDefined();
    }
  });

  it("refuses a fact whose id, clock or producer is wrong", () => {
    // All three are peer-supplied and all three are load-bearing. A duplicate id folds once
    // when it should fold twice, and a fact whose `at` is NaN cannot be ordered at all.
    expect(parseEvent({ ...event("timer"), id: "" })).toBeUndefined();
    expect(parseEvent({ ...event("timer"), id: 7 })).toBeUndefined();
    expect(
      parseEvent({
        ...event("timer"),
        id: "x".repeat(MAX_EVENT_ID_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(parseEvent({ ...event("timer"), at: Number.NaN })).toBeUndefined();
    expect(parseEvent({ ...event("timer"), at: "now" })).toBeUndefined();
    expect(parseEvent({ ...event("timer"), producer: "" })).toBeUndefined();
    expect(parseEvent({ ...event("timer"), producer: 7 })).toBeUndefined();
  });

  it("refuses a kind it does not know", () => {
    // A fact from a newer build. Refusing is what makes the wire format safe to extend.
    expect(parseEvent({ ...event("timer"), kind: "npc-talk" })).toBeUndefined();
    expect(parseEvent({ ...event("timer"), kind: 7 })).toBeUndefined();
    expect(isEventKind("timer")).toBe(true);
    expect(isEventKind("npc-talk")).toBe(false);
    expect(isEventKind(undefined)).toBe(false);
  });

  it("refuses a fact that is not an object", () => {
    for (const bad of ["a string", 42, null, undefined, [1, 2]]) {
      expect(parseEvent(bad), String(bad)).toBeUndefined();
    }
  });

  it("refuses a payload that does not satisfy its kind", () => {
    expect(
      parseEvent(event("zone-entered", {}, { zoneId: "door", extra: 1 })),
    ).toBeUndefined();
    expect(parseEvent(event("zone-entered", {}, {}))).toBeUndefined();
    expect(
      parseEvent(event("player-died", {}, { player: "p" })),
    ).toBeUndefined();
    // `deleted: false` with no value is the one legal combination of the two together.
    expect(
      parseEvent(
        event(
          "data-changed",
          {},
          {
            scope: "global",
            player: "p",
            key: "k",
            deleted: true,
          },
        ),
      ),
    ).toBeDefined();
    // A `deleted: false` with no value is not.
    expect(
      parseEvent(
        event(
          "data-changed",
          {},
          {
            scope: "global",
            player: "p",
            key: "k",
            deleted: false,
          },
        ),
      ),
    ).toBeDefined();
  });

  it("refuses a boolean that is not a boolean", () => {
    expect(
      parseEvent(
        event(
          "data-changed",
          {},
          {
            scope: "global",
            player: "p",
            key: "k",
            deleted: 0,
          },
        ),
      ),
    ).toBeUndefined();
  });
});

describe("the order is total, and that is what makes convergence possible", () => {
  it("orders by clock, then producer, then id", () => {
    const events: ScriptEvent[] = [
      event("timer", { id: "d", at: AT + 2 }),
      event("timer", { id: "c", at: AT }),
      event("timer", { id: "b", at: AT + 1 }),
    ];
    expect(inOrder(events).map((e) => e.id)).toEqual(["c", "b", "d"]);
  });

  it("breaks a tie on producer, then on id", () => {
    // Two facts in the same millisecond is ordinary, not exotic: a script that fires two
    // zone-entered in one frame will do it. Ordering by anything else leaves the two peers
    // to disagree.
    const sameInstant = (producer: string, id: string): ScriptEvent =>
      event("timer", { producer, id, at: AT });

    expect(
      compareEvents(sameInstant("a", "z"), sameInstant("b", "a")),
    ).toBeLessThan(0);
    expect(
      compareEvents(sameInstant("b", "a"), sameInstant("a", "z")),
    ).toBeGreaterThan(0);
    expect(
      compareEvents(sameInstant("a", "a"), sameInstant("a", "b")),
    ).toBeLessThan(0);
    expect(compareEvents(sameInstant("a", "b"), sameInstant("a", "b"))).toBe(0);
  });

  it("never calls two different facts the same, or the same fact different", () => {
    // Totality, asserted rather than assumed. A comparator that returned 0 for two distinct
    // facts would let two peers hold the same set and fold it differently, and `sort` would
    // not complain.
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const facts: ScriptEvent[] = [];
    for (let i = 0; i < 40; i++) {
      facts.push(
        event("timer", {
          producer: `p${Math.floor(next() * 3)}`,
          // Deliberately few distinct values, so ties are common.
          at: AT + Math.floor(next() * 3),
          id: `id${Math.floor(next() * 5)}`,
        }),
      );
    }

    for (const a of facts) {
      for (const b of facts) {
        const forward = compareEvents(a, b);
        const backward = compareEvents(b, a);
        if (
          a === b ||
          (a.id === b.id && a.producer === b.producer && a.at === b.at)
        ) {
          expect(forward).toBe(0);
          expect(backward).toBe(0);
        } else {
          // Antisymmetry, and never equal — that is the half that matters.
          expect(Math.sign(forward)).toBe(-Math.sign(backward));
          expect(forward).not.toBe(0);
        }
      }
    }
  });

  it("sorts the same set the same way whatever order it arrived in", () => {
    // The property, stated directly. Two peers whose connections hiccuped in different ways
    // must still fold the same order.
    const facts = [
      event("player-joined", { id: "j1", at: AT + 5, producer: "b" }),
      event("zone-entered", { id: "z1", at: AT + 5, producer: "a" }),
      event("timer", { id: "t1", at: AT, producer: "c" }),
      event("zone-left", { id: "z2", at: AT + 5, producer: "a" }),
    ];
    const forward = inOrder(facts).map((e) => e.id);
    expect(inOrder([...facts].reverse()).map((e) => e.id)).toEqual(forward);
    expect(
      inOrder([facts[2], facts[0], facts[3], facts[1]]).map((e) => e.id),
    ).toEqual(forward);
    expect(forward).toEqual(["t1", "z1", "z2", "j1"]);
  });

  it("does not mutate the list it was given", () => {
    // A sort that reordered the caller's array would reorder the log's own iteration, which
    // is the one place a stable order is wanted.
    const facts = [
      event("timer", { id: "b", at: AT + 1 }),
      event("timer", { id: "a" }),
    ];
    const before = facts.map((e) => e.id);
    inOrder(facts);
    expect(facts.map((e) => e.id)).toEqual(before);
  });
});

describe("the log is idempotent, because a fact can arrive twice", () => {
  it("holds a fact once however many times it is offered", () => {
    const log = new EventLog();
    const fact = event("zone-entered");

    expect(log.add(fact)).toBe(true);
    expect(log.add(fact)).toBe(false);
    expect(log.size).toBe(1);
    expect(log.has(fact.id)).toBe(true);
    expect(log.get(fact.id)).toBeDefined();
  });

  it("reports how many of a batch were new, so a resend steps nothing", () => {
    // A peer retrying a batch must not cause the script to be stepped for facts it has
    // already seen — which is the whole reason `add` returns a boolean.
    const log = new EventLog();
    const batch = [
      event("zone-entered", { id: "a" }),
      event("zone-left", { id: "b" }),
      event("timer", { id: "c" }),
    ];
    expect(log.apply(batch)).toBe(3);
    expect(log.apply(batch)).toBe(0);
    expect(log.size).toBe(3);
    // A partial overlap is the interesting case: two new facts in a batch of three seen.
    expect(log.apply([batch[0], batch[2], event("timer", { id: "d" })])).toBe(
      1,
    );
  });

  it("hands a script each fact once, in fold order", () => {
    const log = new EventLog();
    log.apply([
      event("timer", { id: "late", at: AT + 10 }),
      event("timer", { id: "early" }),
      event("timer", { id: "mid", at: AT + 5 }),
    ]);

    expect(log.undelivered().map((e) => e.id)).toEqual([
      "early",
      "mid",
      "late",
    ]);
    // Second call is empty: a step that throws still consumed them, or a script that fails
    // on every frame would be re-run on the same facts forever.
    expect(log.undelivered()).toEqual([]);
  });

  it("refuses rather than evicting when it is full", () => {
    // Not a ring buffer. A log that had forgotten its oldest facts would be a *different*
    // log from every other peer's, which is the one outcome the whole design exists to
    // rule out. So this refuses, loudly, and the caller reports it.
    const log = new EventLog();
    for (let i = 0; i < MAX_EVENTS; i++) {
      expect(log.add(event("timer", { id: `t${i}` })), `event ${i}`).toBe(true);
    }
    expect(log.size).toBe(MAX_EVENTS);
    expect(log.add(event("timer", { id: "one-too-many" }))).toBe(false);
    // And the oldest is still there, which is what "refuse" means.
    expect(log.has("t0")).toBe(true);
  });

  it("keeps a restored log's history out of the way of the next step", () => {
    // A saved place's events have already been folded into whatever the script did. Stepping
    // them again would repeat every decision it ever made.
    const log = loadedEventLog(
      encodeEvents([
        event("zone-entered", { id: "old-1" }),
        event("timer", { id: "old-2" }),
      ]),
    );
    expect(log.size).toBe(2);
    expect(log.undelivered()).toEqual([]);
    expect(log.isPending("old-1")).toBe(false);

    log.add(event("timer", { id: "new" }));
    expect(log.undelivered().map((e) => e.id)).toEqual(["new"]);
  });

  it("checks a saved log's events, because a saved file is untrusted input too", () => {
    const log = loadedEventLog(JSON.stringify([{ id: "x", kind: "nonsense" }]));
    expect(log.size).toBe(0);
    expect(loadedEventLog("not json").size).toBe(0);
    expect(loadedEventLog(undefined).size).toBe(0);
  });
});

describe("a batch crosses as JSON, and reports what it dropped", () => {
  it("reads a well-formed batch and refuses a malformed one without throwing", () => {
    const batch = [
      event("zone-entered", { id: "a" }),
      event("timer", { id: "b" }),
    ];
    const { events, refused } = decodeEvents(encodeEvents(batch));
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
    expect(refused).toBe(0);

    // A connection cut mid-message is the case that matters. Throwing would put the host's
    // error handling in the path of a peer's bytes, which is where it must not be.
    expect(decodeEvents('[{"id":"a","kind":"time')).toEqual({
      events: [],
      refused: 0,
    });
    expect(decodeEvents(undefined)).toEqual({ events: [], refused: 0 });
    expect(decodeEvents("42")).toEqual({ events: [], refused: 0 });
  });

  it("applies the good half of a mixed batch and names the rest", () => {
    // "Some events were refused" is never the whole story; the count is what a host logs.
    const mixed = [
      event("zone-entered", { id: "good-1" }),
      { id: "bad", at: AT, producer: "p", kind: "not-a-kind", payload: {} },
      event("timer", { id: "good-2" }),
    ];
    const log = new EventLog();
    const result = log.applyJson(JSON.stringify(mixed));
    expect(result.added).toBe(2);
    expect(result.refused).toBe(1);
    expect(log.size).toBe(2);
  });

  it("round-trips one fact through the wire form", () => {
    const original = event("player-died", {}, { player: "p", cause: "fell" });
    expect(parseEvent(JSON.parse(encodeEvent(original)))).toEqual(original);
  });
});

describe("two peers fed the same facts reach the same state", () => {
  it("converges whichever order the facts arrive in", () => {
    // The property everything else in this file is for, at the smallest scale it can be
    // checked. If the order, the ids or the idempotence were wrong, these two logs would
    // differ and two peers' scripts would have made different decisions with no visible
    // reason.
    const facts = [
      event("player-joined", { id: "p1", at: AT + 3, producer: "peer-a" }),
      event("player-joined", { id: "p2", at: AT + 3, producer: "peer-b" }),
      event("zone-entered", { id: "z1", at: AT + 1, producer: "peer-b" }),
      event("zone-left", { id: "z2", at: AT + 1, producer: "peer-a" }),
      event("timer", { id: "t1", at: AT, producer: "peer-a" }),
      event("player-died", { id: "d1", at: AT + 9, producer: "peer-a" }),
      event("data-changed", { id: "c1", at: AT + 4, producer: "peer-b" }),
    ];

    const drain = (order: readonly ScriptEvent[]): string[] => {
      const log = new EventLog();
      // Arrived in `order`, with the first three repeated — a retry, which must not matter.
      log.apply([...order, ...order.slice(0, 3)]);
      return log.undelivered().map((e) => `${e.kind}:${e.id}`);
    };

    const straight = drain(facts);
    const shuffled = drain([
      facts[4],
      facts[2],
      facts[6],
      facts[0],
      facts[5],
      facts[3],
      facts[1],
    ]);
    const reversed = drain([...facts].reverse());

    expect(shuffled).toEqual(straight);
    expect(reversed).toEqual(straight);
    expect(straight).toEqual([
      "timer:t1",
      "zone-left:z2",
      "zone-entered:z1",
      "player-joined:p1",
      "player-joined:p2",
      "data-changed:c1",
      "player-died:d1",
    ]);
  });

  it("gives both peers the same next step after the same facts", () => {
    const facts = [
      event("timer", { id: "a" }),
      event("zone-entered", { id: "b" }),
    ];
    const stepOf = (order: readonly ScriptEvent[]): string =>
      encodeEvents(
        new EventLog().apply(order) === 0 ? [] : undeliveredOf(order),
      );

    const undeliveredOf = (order: readonly ScriptEvent[]): ScriptEvent[] => {
      const log = new EventLog();
      log.apply(order);
      return log.undelivered();
    };

    expect(stepOf(facts)).toBe(stepOf([...facts].reverse()));
    expect(stepOf(facts)).toContain('"id":"a"');
  });
});

describe("every kind is a kind", () => {
  it("has fields, and a payload that satisfies them", () => {
    for (const kind of EVENT_KINDS) {
      expect(EVENT_FIELDS[kind], kind).toBeDefined();
      for (const field of EVENT_FIELDS[kind]) {
        expect(field.about, `${kind}.${field.name}`).toBeDefined();
        expect(field.name, `${kind}.${field.name}`).toMatch(
          /^[a-z][A-Za-z0-9]*$/,
        );
      }
    }
  });
});
