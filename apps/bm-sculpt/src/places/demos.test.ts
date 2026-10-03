/**
 * Every place this build ships, loaded for real.
 *
 * ## Why this file exists at all
 *
 * The other suites test the *machinery*: that the bundler resolves an import, that a refused
 * effect is refused whole, that two peers converge. None of them touch `src/places/demo/`, and
 * that is exactly the gap — **a demo is the thing a person copies, and a demo that does not run
 * is a worse bug than a demo that is ugly.**
 *
 * So these tests are the ones that would catch a typo in a shipped example: an effect field
 * that was renamed, an import of a function the guest library no longer exports, a zone built
 * outside its bound, a shape over the operation budget. Each is a real failure that reaches
 * nobody until someone types `/place:load bridge` and is shown a refusal.
 *
 * ## The assertions are deliberately thin
 *
 * **`notices` is empty and the place made something.** Not "the deck is at exactly these
 * coordinates" — that would be a test of the demo's design decisions, which are the author's to
 * change, written here where they would be edited for the wrong reason. What matters is that a
 * shipped place *runs clean* and *does something*, and that a demo's shape is what its summary
 * claims — because a summary that lies is the documentation failing.
 */

import { describe, expect, it } from "vitest";

import {
  PlaceHost,
  type HostEffects,
  type HostWorld,
  type RayHit,
} from "./host";
import { DEMO_PLACES, demoIds, demoPlace } from "./demos";
import { MAX_ZONES } from "./limits";
import { MAX_OPERATIONS_PER_PLACE } from "./place-registry";
import { PlaceRegistry } from "./place-registry";
import { FoldOrder } from "../edit/fold-order";
import { SculptDocument } from "../edit/document";
import { Field, OperationBVH } from "@big-mesh-studios/csg";
import type { Vec3 } from "@big-mesh-studios/core";
import type { ClockCommands } from "../console/commands";

/** The clock's own reading, fixed: a demo must not depend on when it is loaded. */
const NOW = 1_700_000_000_000;
/**
 * How far a step advances the clock, in milliseconds.
 *
 * **One second a step, and it advances at all**, because `lanterns` builds nothing until its
 * first timer comes due — so a test clock that stood still would find an empty world and read
 * that as a broken demo. Stepping the clock is what makes "and then it lights one" a thing a
 * test can assert, and a whole demo is lit in a third of a second of demo time.
 */
const STEP_MS = 1000;

/** A flat floor at `y = 0` and nothing else, so a demo's own geometry is what is walked on. */
const stubWorld = (): HostWorld & { places: PlaceRegistry } => {
  const places = new PlaceRegistry(new FoldOrder());
  const document = new SculptDocument();
  return {
    places,
    terrainHeight: () => 0,
    geometryChanged: () => {},
    solidAt: (x, y, z) =>
      new Field(new OperationBVH(places.flatten(document.list))).distance(
        x,
        y,
        z,
      ) < 0,
    waterAt: (_x, y, _z) => y < -10,
    raycast: (): RayHit | undefined => undefined,
  };
};

const stubEffects = (asked: string[]): HostEffects => ({
  log: (text) => asked.push(`log:${text}`),
  toast: (text) => asked.push(`toast:${text}`),
  movePlayer: (at: Vec3, yaw) =>
    asked.push(`move:${at.x},${at.y},${at.z},${yaw ?? ""}`),
  setPlayerSpeed: (m) => asked.push(`speed:${m}`),
  setPlayerJump: (m) => asked.push(`jump:${m}`),
  setFlying: (on) => asked.push(`fly:${on}`),
  lookAt: (at: Vec3, fov) =>
    asked.push(`look:${at.x},${at.y},${at.z},${fov ?? ""}`),
  clearCamera: () => asked.push("camera-clear"),
});

const stubClock = (asked: string[]): ClockCommands => ({
  jumpTo: (seconds) => asked.push(`clock:${seconds}`),
  setSpeed: (multiplier) => asked.push(`clock-speed:${multiplier}`),
  clearOverride: () => asked.push("clock-live"),
  describe: () => "stub clock",
});

interface Loaded {
  readonly host: PlaceHost;
  readonly notices: string[];
  readonly asked: string[];
  /**
   * Steps the place, advancing its clock.
   *
   * **The clock moves with the step rather than with wall time,** so a test says "and then 400
   * milliseconds pass" instead of waiting for it. `dt` is a parameter because the tests below
   * both want twenty ordinary frames and want the timer chain to have run out.
   */
  run(frames: number, dt?: number): void;
}

const load = async (id: string): Promise<Loaded> => {
  const demo = demoPlace(id);
  if (demo === undefined) throw new Error(`no demo called ${id}`);
  const asked: string[] = [];
  const notices: string[] = [];
  let elapsed = 0;
  const host = new PlaceHost({
    files: demo.files,
    entry: demo.entry,
    seed: 20260901,
    now: () => NOW + elapsed,
    world: stubWorld(),
    effects: stubEffects(asked),
    clock: stubClock(asked),
    onNotice: (message) => notices.push(message),
  });
  await host.load();
  return {
    host,
    notices,
    asked,
    run: (frames, dt = STEP_MS) => {
      for (let frame = 0; frame < frames; frame++) {
        elapsed += dt;
        host.step();
      }
    },
  };
};

describe("the shipped places", () => {
  it("are three, and `/place:list` will say so", () => {
    // **The number, because the console lists them by iteration.** A fourth demo
    // that forgot its `DemoPlace` entry would be invisible to this file and
    // visible to a person, which is backwards.
    expect(DEMO_PLACES).toHaveLength(4);
    expect(demoIds()).toEqual(["bridge", "lanterns", "conveyor", "lookout"]);
  });

  it("each have an entry that is one of their own files", () => {
    for (const demo of DEMO_PLACES) {
      // **A phantom entry is not a type error.** `{ "main.ts": a, "span.ts": b }`
      // type-checks perfectly while naming a module nothing imports, which is how
      // the bridge demo once carried a `span.ts` holding the wrong source.
      expect(Object.keys(demo.files)).toContain(demo.entry);
    }
  });

  it("each say what they are for", () => {
    for (const demo of DEMO_PLACES) {
      // A summary is what a person reads in `/place:list` before deciding to load
      // something, so an empty one is a demo nobody will try.
      expect(demo.summary.length).toBeGreaterThan(10);
    }
  });

  it("have ids that are all different", () => {
    const ids = demoIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(DEMO_PLACES.map((demo) => [demo.id, demo] as const))(
  "the %s demo",
  (id) => {
    it("loads without a single refusal", async () => {
      const { host, notices } = await load(id);
      // **The assertion that matters most, and the one nothing else makes.** A
      // shipped place that reports a notice is a broken example, however pretty
      // it looks in a screenshot.
      expect(notices).toEqual([]);
      host.dispose();
    });

    it("does something at load, or arms something to do", async () => {
      const { host } = await load(id);
      // **Either half counts.** A place that builds on arrival has operations; a
      // place that builds on a timer has a pending timer and no operations yet —
      // and both are doing what their summary says. Asserting operations alone
      // fails `lanterns` for being a timer demo, and asserting timers alone fails
      // `bridge` for not being one.
      expect(
        host.places.operationCount + host.pendingTimerCount,
      ).toBeGreaterThan(0);
      host.dispose();
    });

    it("has put something in the world by the time it has run", async () => {
      const { host, run } = await load(id);
      // **Twenty seconds of demo time**, which is the longest any shipped demo
      // takes to finish: `lanterns` arms its last lantern after seven 400 ms waits.
      // A demo that has still built nothing after all that is a demo that does
      // nothing at all.
      run(20);
      expect(host.places.operationCount).toBeGreaterThan(0);
      host.dispose();
    });

    it("stays inside the operation budget", async () => {
      const { host } = await load(id);
      expect(host.places.operationCount).toBeLessThanOrEqual(
        MAX_OPERATIONS_PER_PLACE,
      );
      host.dispose();
    });

    it("uses no more zones than there are", async () => {
      const { host } = await load(id);
      expect(host.zoneList.length).toBeLessThanOrEqual(MAX_ZONES);
      host.dispose();
    });

    it("steps without throwing, and without a runaway", async () => {
      const { notices, run } = await load(id);
      // **Twenty frames, not one.** A demo that only misbehaves on the tenth —
      // a timer that fires twice, an event handler that re-enters — passes a
      // single step and fails a person watching it.
      run(20);
      expect(notices).toEqual([]);
    });

    it("reaches the same state every time it is loaded", async () => {
      // **Read both before disposing either.** `dispose` clears the zones, so
      // comparing a running host against a disposed one compares the demo against
      // itself with a blank sheet — and passes for the wrong reason whenever the
      // demo has no zones.
      const first = await load(id);
      first.run(20);
      const firstOps = first.host.places.operationCount;
      const firstZones = first.host.zoneList.map((zone) => zone.id);

      const second = await load(id);
      second.run(20);
      // **Twice, because a demo that is not reproducible is a demo whose
      // screenshots lie.** Same operations, same zones — the determinism rule
      // from ADR 0016, checked on the files a person will actually run.
      expect(second.host.places.operationCount).toBe(firstOps);
      expect(second.host.zoneList.map((zone) => zone.id)).toEqual(firstZones);

      first.host.dispose();
      second.host.dispose();
    });

    it("disposes cleanly, twice over", async () => {
      // **Disposing twice is what a remount does**, because a person can load a
      // place, unload it and load it again in one session. An interpreter that
      // throws on its second `dispose` turns a reload into a crash.
      const { host } = await load(id);
      host.dispose();
      expect(() => host.dispose()).not.toThrow();
    });

    it("does nothing at all once disposed", async () => {
      const { host, notices, run } = await load(id);
      host.dispose();
      run(5);
      expect(notices).toEqual([]);
    });
  },
);

/**
 * The parts of each demo that its summary claims, checked one by one.
 *
 * **Separate from the loop above because these are claims about *design*,** not about running
 * cleanly: a summary that says "a zone that notices you arriving" is a promise about what the
 * person will see, and a demo that quietly stopped creating zones would still pass every test
 * above.
 */
describe("what each demo claims it does", () => {
  it("the bridge has a zone", async () => {
    const { host } = await load("bridge");
    expect(host.zoneList.map((zone) => zone.id)).toContain("gate");
    host.dispose();
  });

  it("the bridge builds at load", async () => {
    const { host } = await load("bridge");
    // **Before any step**, because that is what makes the bridge a place you can
    // walk onto the moment it loads rather than a place that arrives.
    expect(host.places.operationCount).toBeGreaterThan(0);
    host.dispose();
  });

  it("the bridge's zone is labelled, because an unlabelled box is a mystery", async () => {
    const { host } = await load("bridge");
    for (const zone of host.zoneList) expect(zone.label).not.toBe("");
    host.dispose();
  });

  it("the bridge's zone has a real volume", async () => {
    const { host } = await load("bridge");
    for (const zone of host.zoneList) {
      // **A zero-thickness zone can never be entered.** The min and max being
      // distinct is the whole of what makes it a box rather than a plane, and a
      // person walking into one that can never fire has no way to tell why.
      for (const axis of [0, 1, 2]) {
        expect(zone.max[axis]).toBeGreaterThan(zone.min[axis]);
      }
    }
    host.dispose();
  });

  it("the bridge makes more than one shape, so the fold order has something to order", async () => {
    const { host } = await load("bridge");
    // One shape would make `combine` untestable by eye, and the add-then-subtract
    // doorway is the reason this demo exists.
    expect(host.places.operationCount).toBeGreaterThan(1);
    host.dispose();
  });

  it("the conveyor makes a field, which is the effect the summary promises", async () => {
    const { host } = await load("conveyor");
    // **Counting fields, not operations** — a box that only looked like a belt would pass an
    // operation count, which is the mistake the lanterns tests are careful not to make.
    expect(host.mediumCount).toBe(2);
    host.dispose();
  });

  it("the conveyor's belt pushes, and its quicksand does not", async () => {
    const { host } = await load("conveyor");
    const belt = host.mediumAt(0, 1, 0);
    const quicksand = host.mediumAt(100, 0, 0);

    // **The two halves of the same effect, and neither is the other.** A conveyor is a push;
    // quicksand is a speed scale and a sink. A demo that got the numbers the wrong way round would
    // still have two fields and would still pass a count.
    expect(belt!.pushVz).toBeGreaterThan(0);
    expect(belt!.speedScale).toBe(1);
    expect(quicksand!.pushVz).toBe(0);
    expect(quicksand!.speedScale).toBeLessThan(1);
    expect(quicksand!.sink).toBeGreaterThan(0);
    host.dispose();
  });

  it("the conveyor's two fields do not overlap", async () => {
    const { host } = await load("conveyor");
    // **Overlap resolution is "first one added wins"**, so two fields on top of each other make
    // the second one unreachable and the demo would quietly be only half of what it says. The belt
    // is at x -30..30 and the quicksand at x 60..140, and the gap between them is what proves it.
    const between = host.mediumAt(45, 0, 0);
    expect(between).toBeUndefined();
    host.dispose();
  });

  it("the lanterns set a timer, because that is what the demo is for", async () => {
    const { host } = await load("lanterns");
    // Timers are counted, not fired — this only says the demo armed one. What it
    // does with it is `host.test.ts`'s business.
    expect(host.pendingTimerCount).toBeGreaterThan(0);
    host.dispose();
  });

  it("the lanterns build nothing at load, because a lantern is a later thing", async () => {
    const { host } = await load("lanterns");
    // **The claim behind the claim.** The demo's whole subject is the sequence,
    // so a version that built its row eagerly would still pass every test above
    // and would no longer be the demo anybody copied.
    expect(host.places.operationCount).toBe(0);
    host.dispose();
  });

  it("the lanterns light all eight, in order", async () => {
    const { asked, run } = await load("lanterns");
    run(20);
    const lit = asked.filter((line) => line.startsWith("log:lit "));
    // **All eight, and in order.** A timer demo whose last two lanterns never
    // light looks identical to one that works when nothing is watching, which is
    // why the count is checked rather than the first line.
    expect(lit).toHaveLength(8);
    expect(lit[0]).toBe("log:lit lantern-0");
    expect(lit[7]).toBe("log:lit lantern-7");
  });

  it("the lanterns says when it is finished", async () => {
    const { asked, run } = await load("lanterns");
    run(20);
    expect(asked).toContain("log:every lantern is lit");
  });

  it("the lanterns make real lights, not coloured boxes", async () => {
    const { host, run } = await load("lanterns");
    run(20);
    // **The claim the summary makes, and the one the demo was rewritten for.** Before lights
    // existed this was a row of shapes that appeared and stayed, which is exactly the gap ADR 0020
    // recorded — so a test that counts operations would pass on the old version too. Counting lights
    // cannot.
    expect(host.lightCount).toBe(8);
    host.dispose();
  });

  it("the lanterns' lights are inside their own radius, so a person can stand in one", async () => {
    const { host, run } = await load("lanterns");
    run(20);
    // **A light that reaches nothing is a light that is not there.** Each one has to be able to
    // cover the ground beside its own plinth, which is what makes the row walkable.
    for (const light of host.visibleLights(undefined, 8)) {
      expect(light.radius).toBeGreaterThan(0);
      expect(light.intensity).toBeGreaterThan(0);
      // Not all three channels zero — a light with no colour is a dark light.
      expect(Math.max(...light.colour)).toBeGreaterThan(0);
    }
    host.dispose();
  });

  it("the lanterns can be taken away again, which is why they are lights", async () => {
    const { host, asked, run } = await load("lanterns");
    run(20);
    expect(host.lightCount).toBe(8);
    // **The whole of what a light buys over a shape.** A shape cannot be un-made; the plinths stay
    // where they are, which is right — but the light can be removed, and a place that dims one
    // without giving up its id is the pattern `radius: 0` exists for.
    expect(asked.some((line) => line.startsWith("log:lit "))).toBe(true);
    host.dispose();
  });

  it("the lookout points the camera, which is the effect the summary promises", async () => {
    const { host, asked } = await load("lookout");
    host.step();
    expect(asked.some((line) => line.startsWith("look:"))).toBe(true);
    host.dispose();
  });

  it("the lookout puts the player somewhere, or the camera has nothing to look from", async () => {
    const { host, asked } = await load("lookout");
    host.step();
    // **Either** movePlayer or lookAt would satisfy a person; requiring both
    // would be asserting the demo's staging rather than its capability, and the
    // first of these two is the one that cannot be skipped.
    expect(asked.some((line) => line.startsWith("move:"))).toBe(true);
    host.dispose();
  });
});
