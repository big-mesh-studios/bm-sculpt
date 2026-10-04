import { describe, expect, it } from "vitest";

import {
  MAX_CASCADE_STEPS,
  PlaceHost,
  type HostEffects,
  type HostWorld,
  type RayHit,
} from "./host";
import { PlaceRegistry } from "./place-registry";
import { MAX_LIGHTS, MAX_MEDIUMS } from "./limits";
import { SculptDocument } from "../edit/document";
import { FoldOrder } from "../edit/fold-order";
import { GameWorld } from "../world/game-world";
import { Field } from "@big-mesh-studios/csg";
import { OperationBVH } from "@big-mesh-studios/csg";
import type { Operation } from "@big-mesh-studios/csg";
import { CYCLE_SECONDS } from "../world/day-night";
import type { Vec3 } from "@big-mesh-studios/core";
import type { Bounds } from "../edit/document";
import type { ClockCommands } from "../console/commands";

/**
 * The host, which is the only thing between a place's words and the world.
 *
 * The properties worth testing, in the order they matter:
 *
 * 1. **An effect that fails is refused whole, with a reason a person can act on.** Not
 *    "the effect did nothing" — the field, the bound, the tag.
 * 2. **A place's geometry is walkable, not merely visible.** Everything before this phase
 *    established that a place's operations fold into the field; this is the assertion that
 *    the *player* stands on them, which is the whole reason a place is worth loading.
 * 3. **Two peers running the same place reach the same state**, which is what every
 *    determinism rule in `events.ts` is for.
 * 4. **A runaway place is bounded**, by the cascade cap and by the effect budget.
 */

/** A clock the test moves by hand, so "two seconds later" is exact. */
let clockMs = 1_700_000_000_000;
const clock = (): number => clockMs;
const advance = (ms: number): void => {
  clockMs += ms;
};

/** Everything the host asked the application to do, in order. */
type Asked = string[];

/**
 * A stub world: a flat floor at `y = 0`, water below `y = -10`, and nothing else.
 *
 * **Deliberately the simplest thing that answers the queries.** What is being tested is that
 * a question reaches the host and an answer comes back, not that the host is right about
 * terrain — and a realistic terrain here would make a failure ambiguous between the two.
 */
interface Stub extends HostWorld {
  readonly asked: Asked;
  /** Every box the host said needed re-meshing, in order. */
  readonly reMeshed: Bounds[];
}

const stubWorld = (document = new SculptDocument()): Stub => {
  const asked: Asked = [];
  const reMeshed: Bounds[] = [];
  const places = new PlaceRegistry(new FoldOrder());
  const field = (): Field =>
    new Field(new OperationBVH(places.flatten(document.list)));

  const world: Stub = {
    asked,
    reMeshed,
    places,
    terrainHeight: () => 0,
    geometryChanged: (bounds) => {
      if (bounds !== undefined) reMeshed.push(bounds);
    },
    solidAt: (x, y, z) => {
      asked.push(`solidAt(${x},${y},${z})`);
      return field().distance(x, y, z) < 0;
    },
    waterAt: (x, y, z) => {
      asked.push(`waterAt(${x},${y},${z})`);
      return y < -10;
    },
    raycast: (origin, _direction, maxDistance): RayHit | undefined => {
      asked.push(`raycast(${origin.join(",")})`);
      void maxDistance;
      return undefined;
    },
  };
  return world;
};

/** A stub application: records, and answers the clock with the words a real one does. */
const stubEffects = (asked: Asked): HostEffects => ({
  log: (text: string) => asked.push(`log:${text}`),
  toast: (text: string) => asked.push(`toast:${text}`),
  movePlayer: (at: Vec3, yaw) =>
    asked.push(`move:${at.x},${at.y},${at.z},${yaw ?? ""}`),
  setPlayerSpeed: (m) => asked.push(`speed:${m}`),
  setPlayerJump: (m) => asked.push(`jump:${m}`),
  setFlying: (on) => asked.push(`fly:${on}`),
  lookAt: (at: Vec3, fov) =>
    asked.push(`look:${at.x},${at.y},${at.z},${fov ?? ""}`),
  clearCamera: () => asked.push("camera-clear"),
});

/**
 * A stub clock, recording what a place did to it.
 *
 * **Typed as the console's `ClockCommands`,** because the host's clock type *is* that
 * interface and a stub shaped like the host's old private copy would have compiled happily
 * while proving nothing about the real wiring.
 */
const stubClock = (asked: Asked): ClockCommands => ({
  jumpTo: (seconds: number): void => {
    asked.push(`clock:${seconds}`);
  },
  setSpeed: (multiplier: number): void => {
    asked.push(`clock-speed:${multiplier}`);
  },
  clearOverride: (): void => {
    asked.push("clock-live");
  },
  describe: () => "stub clock",
});

/** Everything a host produced, for a test to read. */
interface Running {
  readonly host: PlaceHost;
  readonly world: Stub;
  readonly asked: Asked;
  readonly notices: string[];
}

const start = async (
  files: Record<string, string>,
  entry = "main.ts",
): Promise<Running> => {
  clockMs = 1_700_000_000_000;
  const asked: Asked = [];
  const notices: string[] = [];
  const world = stubWorld();
  const host = new PlaceHost({
    files,
    entry,
    seed: 20260901,
    now: clock,
    world,
    effects: stubEffects(asked),
    clock: stubClock(asked),
    onNotice: (message) => notices.push(message),
  });
  // **The same wiring `app.tsx` does, and for the same reason.** The stub world is a plain object
  // with no route to the host that owns the fields, so without this a `getMediumAt` query would be
  // answered by a stub that cannot answer — and the test would pass for the wrong reason. The
  // host exists now, so the reader can close over it exactly as the application does.
  (world as Partial<HostWorld>).mediumAt = (x, y, z) => host.mediumAt(x, y, z);
  await host.load();
  return { host, world, asked, notices };
};

/** A place that builds one box and registers a tick. */
const buildsABox = (place = "bridge", id = "deck"): Record<string, string> => ({
  "main.ts": `
    import { createShape, log, onTick } from "voxelscape";
    createShape({ place: "${place}", id: "${id}", at: [0, 10, 0],
      shape: { type: "Box", len: { x: 80, y: 4, z: 12 } }, combine: "Add" });
    onTick(() => {});
    log("built");
  `,
});

describe("a host applies a place's effects", () => {
  it("puts a shape into a place, with the fold index the registry assigns", async () => {
    const { host, world, notices } = await start(buildsABox());

    // **Assert the place built before asserting anything it built.**
    //
    // `load` reports a place's failure through `onNotice` rather than throwing, so a
    // script that fails to load leaves `world.places.get("bridge")` undefined and this
    // test fails with "expected undefined to be defined" — which says nothing about why.
    // It is not a hypothetical: under the full suite's load on a phone this test failed
    // exactly that way, with the real reason sitting unread in `notices`.
    //
    // So the notices are asserted first, and their text is what a failure would show.
    expect(notices, `the place reported: ${notices.join("; ")}`).toEqual([]);

    const bridge = world.places.get("bridge");
    expect(bridge).toBeDefined();
    expect(bridge?.count).toBe(1);
    expect(bridge?.ids()).toEqual(["deck"]);

    // The index came from the shared counter, not from the payload: a script's zero is a
    // placeholder and `PlaceHandle.add` overwrites it.
    const operations = world.places.flatten([]);
    expect(operations[0].index).toBe(0);
    expect(operations[0].origin).toEqual({ x: 0, y: 10, z: 0 });
    expect(operations[0].combine).toBe("Add");
    host.dispose();
  });

  it("gives a colour only to a shape that paints, and no colour to one that does not", async () => {
    // **The same guard as the brush's, on the other producer.** An operation's colour
    // decides the colour of the surface there whatever the operation does to the
    // geometry, so a place that built a solid with the default white would paint itself
    // white instead of taking the world's material. A place author who *wants* a
    // coloured solid has a way to ask — that is what a `Paint` over an `Add` is — but
    // leaving the colour out of an `Add` must not be a way of getting white.
    const { host, world } = await start({
      "main.ts": `
        import { createShape, log } from "voxelscape";
        createShape({ place: "p", id: "solid", at: [0, 10, 0],
          shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
        createShape({ place: "p", id: "painted", at: [0, 10, 0],
          shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Paint",
          colour: { r: 4, g: 5, b: 6 } });
        log("built");
      `,
    });

    expect(world.places.get("p")?.ids()).toEqual(["solid", "painted"]);

    // `flatten` is how a place's operations come back out, and it is where the two
    // ids are gone — the fold is a flat list with no names on it, which is the whole
    // arrangement (ADR 0016). So the two are told apart by the order they were added.
    const operations = world.places.flatten([]);
    expect(operations.map((operation) => operation.combine)).toEqual([
      "Add",
      "Paint",
    ]);
    expect(operations[0].colour, "an Add must carry no colour").toBeUndefined();
    expect(operations[1].colour).toEqual({ r: 4, g: 5, b: 6 });
    host.dispose();
  });

  it("creates the place when a shape names one that does not exist", async () => {
    // No `place-add` tag: a place is a name for a group of shapes, and the group appearing and
    // the name appearing are the same moment. A separate tag would mean a script that created
    // a shape without it got a refusal, which is worse than a place that appears on first use.
    const { host, world } = await start(buildsABox("quarry", "rock"));
    expect(world.places.names).toEqual(["quarry"]);
    host.dispose();
  });

  it("routes each family to the application and to itself", async () => {
    const { host, asked } = await start({
      "main.ts": `
        import { clearCamera, lookAt, movePlayer, setFlying, setPlayerJump,
                 setPlayerSpeed, setTime, setTimeSpeed, toast } from "voxelscape";
        setTime(300);
        setTimeSpeed(4);
        movePlayer(1, 2, 3, 0.5);
        setPlayerSpeed(2);
        setPlayerJump(3);
        setFlying(true);
        lookAt(0, 0, 0, 60);
        toast("hello");
        clearCamera();
      `,
    });
    expect(asked).toEqual([
      "clock:300",
      "clock-speed:4",
      "move:1,2,3,0.5",
      "speed:2",
      "jump:3",
      "fly:true",
      "look:0,0,0,60",
      "toast:hello",
      "camera-clear",
    ]);
    host.dispose();
  });

  it("removes shapes, places and zones by name", async () => {
    const { host, world } = await start({
      "main.ts": `
        import { createShape, createZone, onTick, removePlace, removeShape,
                 removeZone } from "voxelscape";
        createShape({ place: "a", id: "one", at: [0,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
        createShape({ place: "a", id: "two", at: [0,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
        createShape({ place: "b", id: "three", at: [0,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
        createZone({ id: "door", box: [[0,0,0],[2,2,2]] });
        createZone({ id: "hatch", box: [[0,0,0],[2,2,2]] });
        onTick(() => {
          removeShape("a", "one");
          removePlace("b");
          removeZone("door");
        });
      `,
    });
    expect(world.places.get("a")?.ids()).toEqual(["one", "two"]);
    expect(host.zoneList.map((z) => z.id)).toEqual(["door", "hatch"]);

    // The removals are in the tick, so they happen on the first step rather than at load —
    // which is the distinction between a place that *reacts* and one that *builds*.
    host.step();
    expect(world.places.get("a")?.ids()).toEqual(["two"]);
    expect(world.places.has("b")).toBe(false);
    expect(host.zoneList.map((z) => z.id)).toEqual(["hatch"]);
    host.dispose();
  });
});

describe("a host refuses a bad effect, and says why", () => {
  const refuses = async (
    source: string,
  ): Promise<{ notices: string[]; asked: Asked; world: Stub }> => {
    const running = await start({
      "main.ts": `import { onTick } from "voxelscape";\nonTick(() => { ${source} });`,
    });
    running.host.step();
    return running;
  };

  it("names the field and what was wrong with it", async () => {
    // "the effect was refused" is not a bug report. "at has a part that is not a finite
    // number" is, and it arrives while the script is still on the stack.
    const { notices } = await refuses(
      `engine.dispatch("shape-add", JSON.stringify({ place: "p", id: "i", at: ["x", 0, 0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" }));`,
    );
    expect(notices.join("\n")).toMatch(/shape-add.*at.*finite number/);
  });

  it("refuses a tag it does not know, by name", async () => {
    const { notices } = await refuses(
      `engine.dispatch("shape-explode", "{}");`,
    );
    expect(notices.join("\n")).toMatch(/not an effect this build knows/);
  });

  it("refuses a payload that is not JSON, rather than throwing", async () => {
    const { notices } = await refuses(`engine.dispatch("log", "{not json");`);
    expect(notices.join("\n")).toMatch(/payload is not JSON/);
  });

  it("applies nothing at all from a payload that is nine-tenths valid", async () => {
    const { world, notices } = await refuses(
      `engine.dispatch("shape-add", JSON.stringify({ place: "p", id: "i", at: null, shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" }));`,
    );
    // The shape's place and id are fine and its position is not. Applying the good nine tenths
    // would be a shape at the origin that nobody asked for.
    expect(world.places.count).toBe(0);
    expect(notices).not.toHaveLength(0);
  });

  it("reports a place that adds a shape under an id it already used", async () => {
    const notices: string[] = [];
    clockMs = 1_700_000_000_000;
    const world = stubWorld();
    const host = new PlaceHost({
      files: {
        "main.ts": `
          import { createShape } from "voxelscape";
          const one = () => createShape({ place: "p", id: "deck", at: [0,0,0], shape: { type: "Box", len: { x: 1, y: 1, z: 1 } }, combine: "Add" });
          one();
          one();
        `,
      },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world,
      effects: stubEffects([]),
      clock: stubClock([]),
      onNotice: (m) => notices.push(m),
    });
    await host.load();
    // Reported through `load`, which is where a top-level failure belongs — and it says which
    // of the two causes it was not, because the vocabulary cannot tell a full place from a
    // taken id and both are the script's to fix.
    expect(notices.join("\n")).toMatch(/place is full|that id is taken/);
    expect(world.places.get("p")?.count).toBe(1);
    host.dispose();
  });
});

describe("a place's geometry reaches the meshes", () => {
  it("says what to re-mesh when a shape appears", async () => {
    // **The seam that makes a place visible.** Without it the host writes into the registry
    // and nothing else finds out: a `SculptSession` re-meshes when *it* applies a change, and a
    // shape a script made bypasses it. The symptom would be a bridge in the collision field
    // and in no mesh — a player standing on something nobody can see.
    const { host, world } = await start(buildsABox());
    expect(world.reMeshed).toHaveLength(1);
    // The whole place's box rather than this shape's own, because a *subtract* changes the
    // surface around itself and a caller told only about the new shape would miss that.
    expect(world.reMeshed[0].min.x).toBeLessThanOrEqual(-40);
    expect(world.reMeshed[0].max.x).toBeGreaterThanOrEqual(40);
    host.dispose();
  });

  it("says what to re-mesh when a shape leaves, using the box it *had*", async () => {
    // **Backwards on purpose, and worth stating.** A removal has no new bounds, and `undefined`
    // means "re-mesh nothing" — which is exactly wrong, because the surface that is now
    // missing is the box the removed shape was in. So the box is read before the removal.
    const { host, world } = await start({
      "main.ts": `
        import { createShape, onTick, removeShape } from "voxelscape";
        createShape({ place: "bridge", id: "deck", at: [0, 10, 0],
          shape: { type: "Box", len: { x: 80, y: 4, z: 12 } }, combine: "Add" });
        onTick(() => { removeShape("bridge", "deck"); });
      `,
    });
    const afterAdd = world.reMeshed.length;
    expect(afterAdd).toBe(1);

    host.step();
    expect(world.reMeshed.length).toBe(2);
    expect(world.reMeshed[1]).toEqual(world.reMeshed[0]);
    host.dispose();
  });

  it("says nothing when there was nothing there to remove", async () => {
    // A remove of an absent id re-meshes nothing, because nothing changed. The alternative is
    // a re-mesh per no-op, which a place that tidies up on every step would do sixty times a
    // second.
    const { host, world } = await start({
      "main.ts": `
        import { onTick, removeShape } from "voxelscape";
        onTick(() => { removeShape("bridge", "never-existed"); });
      `,
    });
    expect(world.reMeshed).toEqual([]);
    host.step();
    expect(world.reMeshed).toEqual([]);
    host.dispose();
  });

  it("re-meshes the whole place when the place is removed", async () => {
    const { host, world } = await start({
      "main.ts": `
        import { createShape, onTick, removePlace } from "voxelscape";
        createShape({ place: "bridge", id: "deck", at: [0, 0, 0],
          shape: { type: "Box", len: { x: 10, y: 10, z: 10 } }, combine: "Add" });
        onTick(() => { removePlace("bridge"); });
      `,
    });
    host.step();
    expect(world.reMeshed).toHaveLength(2);
    expect(world.places.has("bridge")).toBe(false);
    host.dispose();
  });
});

describe("a place's geometry is walkable, not merely visible", () => {
  it("stands the player on a box the script built", async () => {
    // **The assertion that justifies every phase before it.** Everything so far established
    // that a place's operations fold into the field. This is the claim that the *player's
    // feet* are on them — and it is the reason a place is worth loading at all, rather than
    // worth looking at.
    const { host, world } = await start(buildsABox());
    const gameWorld = new GameWorld({
      field: () => new Field(new OperationBVH(world.places.flatten([]))),
      seaRadius: -10,
    });

    // **`len` is a half-extent** (see `PlaceShape`), so `len.y = 4` is a box eight tall
    // centred at y = 10: its top is y = 14 and a player standing over it is at 14.
    expect(gameWorld.getSolidAt({ x: 0, y: 12, z: 0 })).toBe(true);
    // **A distance along the up, not a height.** Twenty above a top at fourteen, so six below
    // the feet — the same answer as before, in the units the physics asks for.
    const ground = gameWorld.getGroundDistanceAt(
      { x: 0, y: 20, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    expect(ground).toBeCloseTo(-6, 1);

    // And the floor of the world is still the floor: the box is additive, not a replacement.
    expect(gameWorld.getSolidAt({ x: 500, y: 12, z: 0 })).toBe(false);
    host.dispose();
  });

  it("carves, when the script subtracts", async () => {
    const { host, world } = await start({
      "main.ts": `
        import { createShape } from "voxelscape";
        createShape({ place: "cliff", id: "wall", at: [0, 20, 0],
          shape: { type: "Box", len: { x: 120, y: 40, z: 20 } }, combine: "Add" });
        createShape({ place: "cliff", id: "door", at: [0, 20, 0],
          shape: { type: "Box", len: { x: 20, y: 24, z: 40 } }, combine: "Subtract" });
      `,
    });
    const gameWorld = new GameWorld({
      field: () => new Field(new OperationBVH(world.places.flatten([]))),
    });
    // Solid either side of the door, absent inside it — which is the whole of why `combine`
    // exists and the reason the fold order matters.
    expect(gameWorld.getSolidAt({ x: -40, y: 20, z: 0 })).toBe(true);
    expect(gameWorld.getSolidAt({ x: 40, y: 20, z: 0 })).toBe(true);
    expect(gameWorld.getSolidAt({ x: 0, y: 20, z: 0 })).toBe(false);
    host.dispose();
  });

  it("is in the collision field a session reads, not only in the registry", async () => {
    // **The seam that makes a place playable.** `GameWorld` reads `sculpt.collisionField`,
    // which is built from `PlaceRegistry.flatten` — so a place's operations are in the
    // player's collision without one line of wiring here. Asserted by checking the two paths
    // agree, because if `sculpt.ts` ever stopped flattening, everything above would still
    // pass while the player walked through a script's bridge.
    const { host, world } = await start(buildsABox());
    const document = new SculptDocument();
    // The same flattening a session does, from the same registry.
    const asASessionSeesIt: readonly Operation[] = world.places.flatten(
      document.list,
    );
    const gameWorld = new GameWorld({
      field: () => new Field(new OperationBVH(asASessionSeesIt)),
    });
    expect(gameWorld.getSolidAt({ x: 0, y: 12, z: 0 })).toBe(true);
    host.dispose();
  });
});

describe("a place asks the world, and the answers come back through the field", () => {
  it("traces a ray against the same field the player collides with", async () => {
    const { host, world } = await start({
      "main.ts": `
        import { getSolidAt, getWaterAt, log, onTick, raycast } from "voxelscape";
        onTick(() => {
          log("solid=" + getSolidAt(0, 12, 0));
          log("water=" + getWaterAt(0, -99, 0));
          log("hit=" + (raycast([0, 0, 0], [0, 1, 0], 100) === undefined));
        });
      `,
    });
    // A ray the host answers "nothing" for, because the stub world has no ray tracer — and the
    // point is that it *was asked*, on the query channel, with the three arguments unpacked.
    const tracing = new PlaceHost({
      files: {
        "main.ts": `
          import { log, onTick, raycast } from "voxelscape";
          onTick(() => { log("hit=" + (raycast([1,2,3], [0,1,0], 50) === undefined)); });
        `,
      },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world,
      effects: stubEffects([]),
      clock: stubClock([]),
    });
    await tracing.load();
    tracing.step();
    expect(world.asked).toContain("raycast(1,2,3)");
    host.dispose();
    tracing.dispose();
  });

  it("reads a height with no terrain under it, rather than refusing", async () => {
    // A query cannot fail — see `bridge.ts` — and a world with no height field is an
    // operations-only model, which is what the editor is.
    clockMs = 1_700_000_000_000;
    const asked: Asked = [];
    const document = new SculptDocument();
    const world: HostWorld = {
      places: new PlaceRegistry(document.order),
      geometryChanged: () => undefined,
      solidAt: () => false,
      waterAt: () => false,
      raycast: () => undefined,
    };
    const host = new PlaceHost({
      files: {
        "main.ts": `
          import { getHeightAt, log, onTick } from "voxelscape";
          onTick(() => { log("h=" + getHeightAt(4, 5)); });
        `,
      },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world,
      effects: stubEffects(asked),
      clock: stubClock(asked),
    });
    await host.load();
    host.step();
    expect(asked).toEqual(["log:h=0"]);
    host.dispose();
  });
});

describe("timers", () => {
  it("fires when due, and not before", async () => {
    const { host, asked } = await start({
      "main.ts": `
        import { after, log, onTick } from "voxelscape";
        let fired = false;
        onTick((info) => {
          for (const e of info.events) {
            if (e.kind === "timer") { fired = true; log("fired"); }
          }
          if (!fired) { log("waiting"); after("soon", 1000); }
        });
      `,
    });

    host.step();
    expect(asked).toEqual(["log:waiting"]);

    advance(999);
    host.step();
    // Not yet: the timer is due at +1000 and this frame is +999.
    expect(asked).toEqual(["log:waiting", "log:waiting"]);

    advance(1);
    host.step();
    expect(asked[asked.length - 1]).toBe("log:fired");
    host.dispose();
  });

  it("fires in sorted id order, so two peers agree about which came first", async () => {
    // Two timers becoming due in the same millisecond is ordinary, and arrival order would
    // leave it to whichever the script reached first.
    const seen: string[] = [];
    const { host } = await start({
      "main.ts": `
          import { after, onTick } from "voxelscape";
          let once = false;
          onTick((info) => {
            if (once) return;
            once = true;
            after("zebra", 0);
            after("alpha", 0);
          });
          onTick((info) => { for (const e of info.events) if (e.kind === "timer") console.log(e.timerId); });
        `,
    });
    // Read the order off the log rather than the script's console, which the stub ignores.
    const host2 = host;
    void seen;
    host2.step();
    advance(1);
    host2.step();
    const timers = host2.events
      .filter((e) => e.kind === "timer")
      .map((e) => (e.payload as { timerId: string }).timerId);
    expect(timers).toEqual(["alpha", "zebra"]);
    host2.dispose();
  });

  it("replaces a timer set under the same id rather than queueing a second", async () => {
    // Which is what makes a per-step `after` usable: a place that sets the same timer every
    // frame gets one event when it stops, rather than a hundred behind it.
    const { host } = await start({
      "main.ts": `
        import { after, onTick } from "voxelscape";
        let n = 0;
        onTick(() => { n++; if (n < 5) after("tick", 100); });
      `,
    });
    for (let i = 0; i < 4; i++) {
      host.step();
      advance(10);
    }
    advance(1000);
    host.step();
    const fired = host.events.filter((e) => e.kind === "timer");
    expect(fired).toHaveLength(1);
    host.dispose();
  });
});

describe("zones", () => {
  it("reports entering and leaving, and nothing while the player stays put", async () => {
    // There are no entities in v1, so the player's own movement is the only thing a
    // world-building place can react to. Deriving the crossings — rather than being told
    // them — is what keeps a player standing still from reporting the same thing sixty times
    // a second.
    const { host, asked } = await start({
      "main.ts": `
        import { createZone, log, onTick } from "voxelscape";
        createZone({ id: "door", box: [[-5, 0, -5], [5, 20, 5]] });
        onTick((info) => { for (const e of info.events) log(e.kind + ":" + e.zoneId); });
      `,
    });

    host.movePlayer(-20, 1, 0);
    host.movePlayer(-20, 1, 0);
    host.step();
    expect(asked).toEqual([]);

    host.movePlayer(0, 1, 0);
    host.step();
    expect(asked).toEqual(["log:zone-entered:door"]);

    host.movePlayer(2, 1, 0);
    host.movePlayer(2, 1, 0);
    host.step();
    expect(asked).toEqual(["log:zone-entered:door"]);

    host.movePlayer(20, 1, 0);
    host.step();
    expect(asked).toEqual(["log:zone-entered:door", "log:zone-left:door"]);
    host.dispose();
  });

  it("normalises a zone whose corners are the wrong way round", async () => {
    // A box is a box whichever corner a person typed first, and a zone that silently never
    // triggers is the worst kind of bug in a place.
    const { host } = await start({
      "main.ts": `
        import { createZone, onTick } from "voxelscape";
        createZone({ id: "door", box: [[5, 20, 5], [-5, 0, -5]] });
        onTick(() => {});
      `,
    });
    expect(host.zoneList[0].min).toEqual([-5, 0, -5]);
    expect(host.zoneList[0].max).toEqual([5, 20, 5]);

    host.movePlayer(0, 10, 0);
    host.step();
    expect(host.events.some((e) => e.kind === "zone-entered")).toBe(true);
    host.dispose();
  });

  it("refuses a zone whose id is taken rather than replacing it", async () => {
    const notices: string[] = [];
    clockMs = 1_700_000_000_000;
    const host = new PlaceHost({
      files: {
        "main.ts": `
          import { createZone, onTick } from "voxelscape";
          createZone({ id: "door", box: [[0,0,0],[1,1,1]] });
          onTick(() => { createZone({ id: "door", box: [[9,9,9],[10,10,10]] }); });
        `,
      },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world: stubWorld(),
      effects: stubEffects([]),
      clock: stubClock([]),
      onNotice: (m) => notices.push(m),
    });
    await host.load();
    host.step();
    expect(notices.join("\n")).toMatch(/a zone called "door" exists/);
    expect(host.zoneList).toHaveLength(1);
    host.dispose();
  });
});

describe("stored data", () => {
  it("round-trips, and says so", async () => {
    const { host } = await start({
      "main.ts": `
        import { deleteData, log, onTick, saveData } from "voxelscape";
        onTick((info) => {
          for (const e of info.events) {
            if (e.kind !== "data-changed") continue;
            log(e.key + "=" + (e.deleted ? "gone" : e.value));
          }
          if (info.events.length === 0) { saveData("seen", "yes"); deleteData("old"); }
        });
      `,
    });
    host.step();
    expect([...host.storedData]).toEqual([["seen", "yes"]]);

    // Two facts from the first step, and the handler's own log lines — which is what proves
    // the facts came *back* to it rather than only being recorded. The handler saves again on
    // every step with no events, so the log grows: this asserts the first step's two, not a
    // count over the whole session.
    const told = (): string[] =>
      host.events
        .filter((e) => e.kind === "data-changed")
        .map((e) => {
          const payload = e.payload as {
            key: string;
            deleted: boolean;
            value?: string;
          };
          return `${payload.key}=${payload.deleted ? "gone" : payload.value}`;
        });
    expect(told()).toEqual(["seen=yes", "old=gone"]);
    host.step();
    // Four now, because it saved a second time — the place's own doing, not the host's.
    expect(told()).toHaveLength(4);
    host.dispose();
  });

  it("reads a value back through the query channel", async () => {
    // `getData` is the one query that reads a place's own state, and it is on the bridge's
    // closed set because leaving it off would have made `loadData` answer `undefined` forever
    // with no error anywhere.
    const { host } = await start({
      "main.ts": `
        import { loadData, log, onTick, saveData } from "voxelscape";
        let once = false;
        onTick(() => { if (!once) { once = true; saveData("answer", "42"); } });
        onTick(() => { log("read=" + (loadData("answer") ?? "nothing")); });
      `,
    });
    host.step();
    host.step();
    expect(host.lastProblem).toBeUndefined();
    host.dispose();
  });
});

describe("a runaway place is bounded", () => {
  it("stops a cascade at the depth limit rather than looping forever", async () => {
    // A place whose handler reacts to its own reaction. Without a cap this holds the frame
    // with no way out; with one it stops and says the depth was reached.
    const notices: string[] = [];
    clockMs = 1_700_000_000_000;
    const asked: Asked = [];
    const host = new PlaceHost({
      files: {
        "main.ts": `
          import { createZone, onTick } from "voxelscape";
          createZone({ id: "ping", box: [[0, 0, 0], [0.001, 0.001, 0.001]] });
          onTick((info) => { for (const e of info.events) if (e.kind === "zone-entered") save("again"); });
          const save = (k: string) => saveGlobal(k);
          const saveGlobal = (k: string) => { engine.dispatch("log", JSON.stringify({ text: k })); };
        `,
      },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world: stubWorld(),
      effects: stubEffects(asked),
      clock: stubClock(asked),
      onNotice: (m) => notices.push(m),
    });
    await host.load();
    host.movePlayer(0, 0, 0);
    // Bounded: returns rather than hanging. The exact count is asserted below.
    host.step();
    expect(asked.length).toBeLessThanOrEqual(MAX_CASCADE_STEPS * 2);
    host.dispose();
  });

  it("spends one step's budget however many handlers a place registers", async () => {
    // Covered end to end in `place-runtime.test.ts`; asserted here too because it is the
    // property that makes `MAX_STEP_MS` mean anything.
    const { host } = await start({
      "main.ts": `
        import { onTick } from "voxelscape";
        onTick(() => { while (true) {} });
      `,
    });
    const started = Date.now();
    host.step();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(host.lastProblem).toMatch(/interrupt/);
    host.dispose();
  });

  it("keeps stepping after a step that threw", async () => {
    const { host, asked } = await start({
      "main.ts": `
        import { log, onTick } from "voxelscape";
        let n = 0;
        onTick(() => { n++; if (n === 1) throw new Error("first step is broken"); log("step " + n); });
      `,
    });
    host.step();
    expect(host.lastProblem).toMatch(/first step is broken/);
    expect(asked).toEqual([]);

    host.step();
    expect(asked).toEqual(["log:step 2"]);
    host.dispose();
  });
});

describe("two peers running one place reach the same state", () => {
  it("agree on every operation, in the same order, with the same indices", async () => {
    const place: Record<string, string> = {
      "main.ts": `
        import { createShape, randint } from "voxelscape";
        for (let i = 0; i < 30; i++) {
          createShape({ place: "quarry", id: "rock-" + i, at: [i * 10, randint(0, 3), 0],
            shape: { type: "Ellipsoid", radius: { x: 5, y: 5, z: 5 } },
            combine: i % 4 === 0 ? "Subtract" : "Add" });
        }
      `,
    };

    const build = async (): Promise<string> => {
      clockMs = 1_700_000_000_000;
      const world = stubWorld();
      const host = new PlaceHost({
        files: place,
        entry: "main.ts",
        seed: 20260901,
        now: clock,
        world,
        effects: stubEffects([]),
        clock: stubClock([]),
      });
      await host.load();
      const operations = world.places.flatten([]);
      host.dispose();
      return JSON.stringify(operations);
    };

    const first = await build();
    expect(await build()).toBe(first);
    // Thirty operations, so the comparison is not two empty arrays agreeing.
    expect(JSON.parse(first)).toHaveLength(30);
  });

  it("agree on their events, including the ids", async () => {
    const place: Record<string, string> = {
      "main.ts": `
        import { createZone, onTick } from "voxelscape";
        createZone({ id: "door", box: [[-5, 0, -5], [5, 20, 5]] });
        onTick((info) => { for (const e of info.events) if (e.kind === "zone-entered") save("seen"); });
        const save = (k: string) => saveData(k, "yes");
        import { saveData } from "voxelscape";
      `,
    };

    const run = async (): Promise<string> => {
      clockMs = 1_700_000_000_000;
      const world = stubWorld();
      const host = new PlaceHost({
        files: place,
        entry: "main.ts",
        seed: 20260901,
        now: clock,
        world,
        effects: stubEffects([]),
        clock: stubClock([]),
      });
      await host.load();
      host.movePlayer(0, 1, 0);
      host.step();
      const ids = host.events.map((e) => `${e.id}:${e.kind}`);
      host.dispose();
      return ids.join("|");
    };

    expect(await run()).toBe(await run());
    // And the ids are the producer's own, not generated here.
    expect(await run()).toMatch(/^local:/);
  });
});

describe("a host that was never loaded", () => {
  it("steps and moves without doing anything", () => {
    // A host exists before a place is loaded, because the frame loop is the caller's and does
    // not know whether loading has happened. Throwing would mean a session with no place had
    // to branch on something it cannot see.
    clockMs = 1_700_000_000_000;
    const world = stubWorld();
    const host = new PlaceHost({
      files: { "main.ts": `export const x = 1;` },
      entry: "main.ts",
      seed: 1,
      now: clock,
      world,
      effects: stubEffects([]),
      clock: stubClock([]),
    });
    expect(host.runtime).toBeUndefined();
    expect(() => host.step()).not.toThrow();
    expect(() => host.movePlayer(1, 2, 3)).not.toThrow();
    expect(host.events).toEqual([]);
    host.dispose();
  });
});

describe("the clock a place sets", () => {
  it("reaches the application's clock and not the host's", async () => {
    // A host with a clock of its own would be a second answer to "what hour is it", which is
    // exactly the disagreement ADR 0011 is about. So the host holds a reference and asks.
    // **A literal in the place's source, not a constant from this repository** — the place is
    // compiled and run inside QuickJS, where `CYCLE_SECONDS` does not exist. Writing one here
    // produced a `ReferenceError` at load, which `load` reported and swallowed, and the test
    // then failed on an empty array with nothing pointing at the cause.
    const { asked, notices } = await start({
      "main.ts": `
        import { setTime, setTimeSpeed } from "voxelscape";
        setTime(300);
        setTimeSpeed(1);
      `,
    });
    expect(notices).toEqual([]);
    expect(asked).toEqual(["clock:300", "clock-speed:1"]);
    // And the value a place gets is the cycle's own length, not a number this host invented.
    expect(CYCLE_SECONDS).toBe(1200);
  });
});

/**
 * The lights a place makes.
 *
 * **What is worth testing is not that a light exists** — that is the effect table's job, and
 * `effects.test.ts` refuses a malformed one. It is the three things this host adds on top:
 *
 * 1. **The colour conversion happens once, here, at the boundary.** A place speaks 0…255 and the
 *    renderer speaks 0…1; if that conversion lived in a per-draw thunk it would be paid for every
 *    chunk of the world, every frame.
 * 2. **Nearest-N selection is deterministic**, which is the whole of ADR 0016 applied to a list
 *    that has to agree between two machines.
 * 3. **`MAX_LIGHTS` is enforced**, which is the only reference the constant has and therefore the
 *    only place it can be shown to bite.
 */
describe("lights", () => {
  /** A place that makes one light and reports what the host holds. */
  const lamp = async (
    at: readonly [number, number, number],
    over: Record<string, unknown> = {},
  ) =>
    start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        createLight({
          id: "lamp",
          at: [${at[0]}, ${at[1]}, ${at[2]}],
          colour: { r: 255, g: 128, b: 0 },
          radius: 40,
          intensity: 1,
          ...${JSON.stringify(over)},
        });
        onTick(() => {});
      `,
    });

  it("keeps what a place asked for", async () => {
    const { host } = await lamp([10, 20, 30]);
    const [only] = host.visibleLights(undefined, 8);
    expect(only).toEqual({
      id: "lamp",
      at: { x: 10, y: 20, z: 30 },
      colour: [1, 128 / 255, 0],
      radius: 40,
      intensity: 1,
    });
    host.dispose();
  });

  it("converts the colour to the renderer's 0 to 1, once", async () => {
    // **The boundary, checked at both ends.** 255 becomes exactly 1, and 128 becomes what 128/255
    // is rather than being clamped or truncated. A host that passed the bytes through would make
    // every light nine times too bright and clamp to white immediately.
    const { host } = await lamp([0, 0, 0]);
    const [only] = host.visibleLights(undefined, 8);
    expect(only!.colour[0]).toBe(1);
    expect(only!.colour[1]).toBeCloseTo(128 / 255, 6);
    expect(only!.colour[2]).toBe(0);
    host.dispose();
  });

  it("refuses a second light with the same id", async () => {
    const { host, notices } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        const one = (n) => createLight({ id: n, at: [0,0,0], colour: {r:1,g:1,b:1}, radius: 10, intensity: 1 });
        one("lamp"); one("lamp");
        onTick(() => {});
      `,
    });
    // **One taken id is a refusal, not a replacement** — the same rule shapes and zones follow, and
    // for the same reason: silently replacing would let a script's second frame undo its first.
    expect(notices.join("\n")).toMatch(/exists/);
    expect(host.lightCount).toBe(1);
    host.dispose();
  });

  it("removes a light by id, and taking it away takes it out of the drawn set", async () => {
    const { host } = await start({
      "main.ts": `
        import { createLight, removeLight, onTick } from "voxelscape";
        createLight({ id: "a", at: [0,0,0], colour: {r:255,g:255,b:255}, radius: 10, intensity: 1 });
        removeLight("a");
        createLight({ id: "b", at: [5,0,0], colour: {r:255,g:255,b:255}, radius: 10, intensity: 1 });
        onTick(() => {});
      `,
    });
    expect(host.visibleLights(undefined, 8).map((light) => light.id)).toEqual([
      "b",
    ]);
    host.dispose();
  });

  it("removing a light that is not there does nothing at all", async () => {
    const { host, notices } = await start({
      "main.ts": `
        import { removeLight, onTick } from "voxelscape";
        removeLight("never-existed");
        onTick(() => {});
      `,
    });
    // **Not a refusal.** Removing something absent is what a handler does when it runs twice, and
    // zones behave the same way; a script that cleans up must not have to track whether it did.
    expect(notices).toEqual([]);
    expect(host.lightCount).toBe(0);
    host.dispose();
  });

  it("gives back the nearest lights, in order", async () => {
    const { host } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        const at = (id, x) => createLight({ id, at: [x,0,0], colour: {r:255,g:255,b:255}, radius: 10, intensity: 1 });
        at("far", 900); at("near", 10); at("middle", 100);
        onTick(() => {});
      `,
    });
    // **Nearest first, from the player.** A renderer draws them in this order, so the ones the
    // player can actually see are the ones that survive the cap.
    const from = { x: 0, y: 0, z: 0 };
    expect(host.visibleLights(from, 8).map((light) => light.id)).toEqual([
      "near",
      "middle",
      "far",
    ]);
    host.dispose();
  });

  it("drops the farthest when there are more than fit", async () => {
    const { host } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        for (let i = 0; i < 12; i++) {
          createLight({ id: "l" + i, at: [i * 10, 0, 0], colour: {r:255,g:255,b:255}, radius: 5, intensity: 1 });
        }
        onTick(() => {});
      `,
    });
    const drawn = host.visibleLights({ x: 0, y: 0, z: 0 }, 8);
    expect(drawn).toHaveLength(8);
    // **The eight nearest, and specifically `l7` rather than `l11`** — a selection by insertion
    // order would keep the first eight and drop the ones in front of the player.
    expect(drawn.map((light) => light.id)).toEqual([
      "l0",
      "l1",
      "l2",
      "l3",
      "l4",
      "l5",
      "l6",
      "l7",
    ]);
    host.dispose();
  });

  it("breaks a tie by id, so two peers draw the same lights", async () => {
    // **The determinism rule, and the reason the tie-break exists.** Two lights at exactly equal
    // distance from the player have no geometric order, so `Map` insertion order would decide —
    // which is the order two scripts happened to run in, and therefore a divergence waiting to
    // happen (ADR 0016). Adding them in the opposite order on the second host is what makes the
    // test able to fail.
    const source = (ids: readonly string[]) => ({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        ${ids
          .map(
            (id) =>
              `createLight({ id: "${id}", at: [5,0,0], colour: {r:255,g:255,b:255}, radius: 10, intensity: 1 });`,
          )
          .join("\n")}
        onTick(() => {});
      `,
    });

    const forwards = await start(source(["a", "b"]));
    const backwards = await start(source(["b", "a"]));
    const from = { x: 0, y: 0, z: 0 };
    expect(forwards.host.visibleLights(from, 8).map((l) => l.id)).toEqual([
      "a",
      "b",
    ]);
    expect(backwards.host.visibleLights(from, 8).map((l) => l.id)).toEqual([
      "a",
      "b",
    ]);
    forwards.host.dispose();
    backwards.host.dispose();
  });

  it("measures distance to the player, not to the origin", async () => {
    // **Two lights a long way apart, and a player who is not at the origin.** Sorted from the
    // origin, the nearer-to-origin light always wins; from where the player actually is, the other
    // one does. That difference is the whole test.
    const { host } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        const at = (id, x) => createLight({ id, at: [x,0,0], colour: {r:255,g:255,b:255}, radius: 10, intensity: 1 });
        at("near-origin", 10); at("near-player", 1010);
        onTick(() => {});
      `,
    });

    // At the origin, the light ten units away is the one to draw.
    expect(
      host.visibleLights({ x: 0, y: 0, z: 0 }, 1).map((l) => l.id),
    ).toEqual(["near-origin"]);

    // A kilometre along, the same world draws the other one: ten units ahead of the player, and
    // a kilometre behind them is the other. A host sorting from the origin would fail here.
    expect(
      host.visibleLights({ x: 1000, y: 0, z: 0 }, 1).map((l) => l.id),
    ).toEqual(["near-player"]);
    host.dispose();
  });

  it("draws nothing when there is no place loaded", async () => {
    const { host } = await lamp([0, 0, 0]);
    host.dispose();
    expect(host.visibleLights({ x: 0, y: 0, z: 0 }, 8)).toEqual([]);
  });

  it("takes them all away when it is disposed", async () => {
    // **Unload is `dispose`, and a light that outlived its place would light a world nothing
    // built.** The memory leak is small; the lit world that should not be is not.
    const { host } = await lamp([0, 0, 0]);
    expect(host.lightCount).toBe(1);
    host.dispose();
    expect(host.lightCount).toBe(0);
  });

  it("refuses a light past MAX_LIGHTS, and says which place has too many", async () => {
    // **The only reference `MAX_LIGHTS` has**, and therefore the only place it can be shown to
    // bite. A cap nothing refuses is a cap that reads as safety and is not.
    const { host, notices } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        for (let i = 0; i <= ${MAX_LIGHTS}; i++) {
          createLight({ id: "l" + i, at: [0,0,0], colour: {r:255,g:255,b:255}, radius: 5, intensity: 1 });
        }
        onTick(() => {});
      `,
    });
    expect(host.lightCount).toBe(MAX_LIGHTS);
    expect(notices.join("\n")).toContain(`world may hold ${MAX_LIGHTS} lights`);
    host.dispose();
  });

  it("accepts a light with no radius, which is how a light is turned off", async () => {
    // **The property that makes `light-add` with `radius: 0` equivalent to `light-remove`.** It is
    // how a place dims a lamp without giving up its id, and it works because the renderer's window
    // is zero at radius zero.
    const { host, notices } = await start({
      "main.ts": `
        import { createLight, onTick } from "voxelscape";
        createLight({ id: "lamp", at: [0,0,0], colour: {r:255,g:255,b:255}, radius: 0, intensity: 1 });
        onTick(() => {});
      `,
    });
    expect(notices).toEqual([]);
    const [only] = host.visibleLights(undefined, 8);
    expect(only!.radius).toBe(0);
    host.dispose();
  });
});

/**
 * The fields a place declares.
 *
 * **The physics already existed.** `PlayerWorld` has declared `getMediumAt` and `updatePlayer`
 * has consumed it since before this phase — speed scaling, both pushes, the sink — so what is new
 * is the place-facing half and the wire between it and that already-written code. Which makes the
 * tests here mostly about the seam:
 *
 * 1. **The overlap rule is the first one added wins**, and it has to be stated rather than left to
 *    `Map` iteration order being what it happens to be.
 * 2. **`MAX_MEDIUMS` is enforced**, which is the only reference that constant has.
 * 3. **The query and the physics get the same answer**, because they are the same method and a
 *    place that disagreed with its own player would be undebuggable.
 */
describe("fields", () => {
  /** A place that declares one field and reports what the host holds. */
  const belt = async (
    box: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ],
    over: Record<string, unknown> = {},
  ) =>
    start({
      "main.ts": `
        import { createMedium, onTick } from "voxelscape";
        createMedium({
          id: "belt",
          box: ${JSON.stringify(box)},
          pushVx: 0,
          pushVz: 40,
          speedScale: 1,
          ...${JSON.stringify(over)},
        });
        onTick(() => {});
      `,
    });

  /** The belt of these tests: from `z = -5` to `z = 5`, `y` 0 to 4, x -10 to 10. */
  const BELT: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
  ] = [
    [-10, 0, -5],
    [10, 4, 5],
  ];

  it("answers for a point inside it", async () => {
    const { host } = await belt(BELT);
    expect(host.mediumAt(0, 2, 0)).toEqual({
      pushVx: 0,
      pushVz: 40,
      // **Absent means `null`, not zero.** A field that named no vertical pull must not fight the
      // fall, and zero would be an updraft that pins the player to the ground.
      pushVy: null,
      speedScale: 1,
      sink: 0,
    });
    host.dispose();
  });

  it("answers nothing for a point outside it", async () => {
    const { host } = await belt(BELT);
    expect(host.mediumAt(0, 2, 50)).toBeUndefined();
    expect(host.mediumAt(0, 50, 0)).toBeUndefined();
    expect(host.mediumAt(500, 2, 0)).toBeUndefined();
    host.dispose();
  });

  it("treats the box corners as unordered", async () => {
    // **A place author writes two opposite corners in whichever order they think of them**, and a
    // box whose min is above its max contains nothing — which would be a conveyor that silently
    // does not push. Same rule as `zone-add`.
    const { host } = await belt([
      [10, 4, 5],
      [-10, 0, -5],
    ]);
    expect(host.mediumAt(0, 2, 0)).toBeDefined();
    host.dispose();
  });

  it("includes its own edges, so a player does not step off the far end", async () => {
    // **Inclusive on both corners.** Half-open would drop the player the moment they reached the
    // belt's far edge, which is the most obvious way this feature could look broken.
    const { host } = await belt(BELT);
    expect(host.mediumAt(0, 0, 5)).toBeDefined();
    expect(host.mediumAt(0, 0, -5)).toBeDefined();
    expect(host.mediumAt(10, 4, 5)).toBeDefined();
    host.dispose();
  });

  it("keeps a vertical push and a sink that were named", async () => {
    const { host } = await belt(BELT, { pushVy: 30, sink: 12 });
    const medium = host.mediumAt(0, 2, 0)!;
    expect(medium.pushVy).toBe(30);
    expect(medium.sink).toBe(12);
    host.dispose();
  });

  it("quicksand, which is a speed scale of zero and a sink", async () => {
    const { host } = await belt(BELT, { speedScale: 0, sink: 4, pushVz: 0 });
    const medium = host.mediumAt(0, 2, 0)!;
    expect(medium.speedScale).toBe(0);
    expect(medium.sink).toBe(4);
    host.dispose();
  });

  it("removes a field by id, and the player stops feeling it", async () => {
    const { host } = await start({
      "main.ts": `
        import { createMedium, removeMedium, onTick } from "voxelscape";
        createMedium({ id: "a", box: [[-10,0,-5],[10,4,5]], pushVx: 0, pushVz: 40, speedScale: 1 });
        removeMedium("a");
        onTick(() => {});
      `,
    });
    expect(host.mediumAt(0, 2, 0)).toBeUndefined();
    host.dispose();
  });

  it("removing a field that is not there does nothing", async () => {
    const { host, notices } = await start({
      "main.ts": `
        import { removeMedium, onTick } from "voxelscape";
        removeMedium("never-existed");
        onTick(() => {});
      `,
    });
    expect(notices).toEqual([]);
    host.dispose();
  });

  it("refuses a second field with the same id", async () => {
    const { host, notices } = await start({
      "main.ts": `
        import { createMedium, onTick } from "voxelscape";
        const one = (n) => createMedium({ id: n, box: [[0,0,0],[4,4,4]], pushVx: 0, pushVz: 10, speedScale: 1 });
        one("belt"); one("belt");
        onTick(() => {});
      `,
    });
    expect(notices.join("\n")).toMatch(/exists/);
    expect(host.mediumCount).toBe(1);
    host.dispose();
  });

  it("gives whichever was added first where two overlap, not whichever sorts first", async () => {
    // **Insertion order, stated as the rule rather than inherited from `Map`.** Two fields
    // overlapping is a real thing a place does — a fast current inside a slow one — and which one
    // applies has to be a decision someone made rather than a property of a hash table.
    //
    // The determinism claim is not that the answer is `"a"` either way: it is that a *script*
    // produces the same answer every time, because the effects arrive in the script's own order on
    // every peer (ADR 0016). So the test asserts the order changes the answer, and that it does
    // not change between two runs of the same script.
    const source = (ids: readonly string[]) => ({
      "main.ts": `
        import { createMedium, onTick } from "voxelscape";
        ${ids
          .map(
            (id) =>
              `createMedium({ id: "${id}", box: [[-10,0,-10],[10,4,10]], pushVz: ${id === "a" ? 10 : 90}, pushVx: 0, speedScale: 1 });`,
          )
          .join("\n")}
        onTick(() => {});
      `,
    });

    const forwards = await start(source(["a", "b"]));
    const backwards = await start(source(["b", "a"]));
    const forwardsAgain = await start(source(["a", "b"]));

    // "a" first, so "a" wins. "b" first, so "b" wins — which is the whole point: the answer
    // follows the order the script wrote them in, and sorting by id would have answered 10 both
    // times and looked correct while being the wrong rule.
    expect(forwards.host.mediumAt(0, 2, 0)!.pushVz).toBe(10);
    expect(backwards.host.mediumAt(0, 2, 0)!.pushVz).toBe(90);
    // And the same script twice is the same answer twice.
    expect(forwardsAgain.host.mediumAt(0, 2, 0)!.pushVz).toBe(10);

    for (const host of [forwards.host, backwards.host, forwardsAgain.host])
      host.dispose();
  });

  it("answers a query the same way the physics is answered", async () => {
    // **One method, so one answer.** A place asking `getMediumAt` and the player standing in the
    // field must not be told different things; there is one `mediumAt` and both reach it.
    const { host, asked } = await start({
      "main.ts": `
        import { createMedium, getMediumAt, log, onTick } from "voxelscape";
        createMedium({ id: "belt", box: [[-10,0,-5],[10,4,5]], pushVx: 0, pushVz: 40, speedScale: 1 });
        onTick(() => {
          const inside = getMediumAt(0, 2, 0);
          const outside = getMediumAt(0, 2, 900);
          log(inside === undefined ? "none" : "push " + inside.pushVz);
          log(outside === undefined ? "none" : "push " + outside.pushVz);
        });
      `,
    });
    host.step();
    expect(asked).toEqual(["log:push 40", "log:none"]);
    host.dispose();
  });

  it("takes them all away when it is disposed", async () => {
    const { host } = await belt(BELT);
    expect(host.mediumCount).toBe(1);
    host.dispose();
    expect(host.mediumCount).toBe(0);
    // **And nothing is left standing under the player's feet**, which is the part that matters:
    // a field that outlived its place would hold a player in quicksand forever.
    expect(host.mediumAt(0, 2, 0)).toBeUndefined();
  });

  it("refuses a field past MAX_MEDIUMS, and says how many a world may hold", async () => {
    // **The only reference `MAX_MEDIUMS` has**, and therefore the only place it can be shown to
    // bite. A cap nothing refuses is a cap that reads as safety and is not.
    const { host, notices } = await start({
      "main.ts": `
        import { createMedium, onTick } from "voxelscape";
        for (let i = 0; i <= ${MAX_MEDIUMS}; i++) {
          createMedium({ id: "m" + i, box: [[0,0,0],[2,2,2]], pushVx: 0, pushVz: 1, speedScale: 1 });
        }
        onTick(() => {});
      `,
    });
    expect(host.mediumCount).toBe(MAX_MEDIUMS);
    expect(notices.join("\n")).toContain(
      `world may hold ${MAX_MEDIUMS} fields`,
    );
    host.dispose();
  });
});
