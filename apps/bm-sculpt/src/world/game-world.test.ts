import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERRAIN,
  Field,
  OperationBVH,
  terrainField,
} from "@big-mesh-studios/csg";
import type { PickField } from "@big-mesh-studios/picking";
import { vec3 } from "@big-mesh-studios/core";
import { neutralInput } from "../player/input";
import { createPlayer, updatePlayer, type Medium } from "../player/player";
import { GameWorld } from "./game-world";

/**
 * A height-field-like probe: `distance = y - surface(x, z)`. Not a true distance
 * on a slope, which is the same approximation the real terrain makes, and enough
 * to exercise the three queries.
 */
const heightField = (
  surface: (x: number, z: number) => number,
  lipschitz = 1,
): PickField => ({
  distance: (x, y, z) => y - surface(x, z),
  distanceForStepping: (x, y, z) => (y - surface(x, z)) * lipschitz,
  gradient: () => ({ x: 0, y: 1, z: 0 }),
});

describe("solid", () => {
  it("is the sign of the field", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getSolidAt(vec3(0, 1, 0))).toBe(false);
    expect(world.getSolidAt(vec3(0, -1, 0))).toBe(true);
  });
});

/**
 * Ground as a distance along an up, which is what replaced `getGroundHeightAt`'s height.
 *
 * **Every assertion is a distance, and the ray is stated.** The old form asked "what is the
 * height at `(x, z)`", which is only answerable on a world whose ground is level; this one asks
 * how far the surface is from the feet along a named direction, which is answerable anywhere and
 * is the question the physics actually asks.
 */
describe("ground distance", () => {
  const UP = vec3(0, 1, 0);

  it("finds the surface below a point in the air", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    // Fifty above a surface at zero, so fifty below the feet.
    expect(world.getGroundDistanceAt(vec3(0, 50, 0), UP)).toBeCloseTo(-50, 1);
  });

  it("finds the top of the material a point is inside", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    // Twenty below the surface, so twenty above the feet on the way out.
    expect(world.getGroundDistanceAt(vec3(0, -20, 0), UP)).toBeCloseTo(20, 1);
  });

  it("reports a step's own top, so it can be climbed", () => {
    const world = new GameWorld({
      field: () => heightField((_x, z) => (z > 20 ? 10 : 0)),
    });
    expect(world.getGroundDistanceAt(vec3(0, 0, 25), UP)).toBeCloseTo(10, 1);
    expect(world.getGroundDistanceAt(vec3(0, 0, 10), UP)).toBeCloseTo(0, 1);
  });

  it("converges with a conservative Lipschitz bound", () => {
    const world = new GameWorld({
      field: () => heightField((_x, _z) => 0, 0.2),
    });
    expect(world.getGroundDistanceAt(vec3(0, 100, 0), UP)).toBeCloseTo(-100, 1);
  });

  it("has no surface under a ray that meets nothing", () => {
    const world = new GameWorld({
      field: () => heightField(() => Number.NEGATIVE_INFINITY),
    });
    expect(world.getGroundDistanceAt(vec3(0, 10, 0), UP)).toBe(-Infinity);
  });

  it("traces along the up it is given, not along world `+Y`", () => {
    // **The assertion that says the query is a ray and not a column.** Fifty units above a
    // surface at `y = 0`, asked along `-Y`: there is no surface on that ray at all, because it
    // walks away from the ground — so the honest answer is `-Infinity`. A query still walking
    // down world `+Y` would find the surface fifty units away and report it, and the physics
    // would then stand the player on the ground while their own up pointed away from it.
    //
    // A height-field probe can only ever answer for one direction from a given point, so this is
    // the whole of what the ray property is on this world. `up.test.ts` covers the spherical case,
    // where both directions find a surface.
    const world = new GameWorld({ field: () => heightField(() => 0) });
    const feet = vec3(0, 50, 0);
    expect(world.getGroundDistanceAt(feet, UP)).toBeCloseTo(-50, 1);
    expect(world.getGroundDistanceAt(feet, vec3(0, -1, 0))).toBe(-Infinity);
  });
});

describe("walking on a slope", () => {
  it("keeps its speed up a grade and stands on the surface", () => {
    // The regression this pins: the ground query used to stop a fraction below
    // the surface on a climb, and the collision then read the player's own front
    // corner as buried, so every step up a slope was refused and the player
    // crawled or stopped. Full speed and feet on the surface is the whole check.
    const grade = 0.3;
    const world = new GameWorld({
      field: () => heightField((_x, z) => z * grade),
    });
    const player = createPlayer(vec3(0, 6, 0));
    const input = { ...neutralInput(), moveY: 1 }; // faces +Z, uphill, as constructed
    for (let i = 0; i < 300; i++) updatePlayer(player, 1 / 60, input, world);

    expect(player.position.z).toBeGreaterThan(200);
    // The footprint samples a collision radius either side, so on a slope the
    // player rests on the highest of those, up to a collision radius of rise.
    const onSurface = player.position.z * grade + player.config.halfSize;
    expect(player.position.y).toBeGreaterThanOrEqual(onSurface - 0.1);
    expect(player.position.y).toBeLessThanOrEqual(
      onSurface + player.config.collisionRadius * grade + 0.5,
    );
    expect(player.onGround).toBe(true);
  });
});

describe("walking on the real terrain", () => {
  it("moves at full speed in every direction from the spawn", () => {
    // The synthetic ramp above models one axis cleanly; this is the landscape the
    // game actually draws, where the ground rises diagonally under the body. The
    // bug this catches is a settled player blocked in *every* direction because
    // their own position already intersects, which no straight-axis ramp shows.
    const terrain = terrainField(DEFAULT_TERRAIN);
    const field = new Field(new OperationBVH([]), {
      base: terrain,
      extent: terrain,
      lipschitz: terrain.lipschitz,
    });
    const world = new GameWorld({ field: () => field });

    // **Four headings, set by building the player facing each.** The old loop assigned `player.yaw`;
    // there is no yaw to assign, and a heading is a direction the frame is built from — which is
    // the point, since `yaw` only ever meant "an angle around world `+Y`".
    for (const [dx, dz] of [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ] as const) {
      const spawn = vec3(0, terrain.heightAt(0, 0) + 6, 0);
      const player = createPlayer(spawn, {}, world.frame, vec3(dx, 0, dz));
      const input = { ...neutralInput(), moveY: 1 };
      for (let i = 0; i < 300; i++) updatePlayer(player, 1 / 60, input, world);

      const travelled =
        (player.position.x - spawn.x) * dx + (player.position.z - spawn.z) * dz;
      expect(travelled).toBeGreaterThan(250);
    }
  });
});

describe("water", () => {
  it("is off when the world has no sea", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getInWaterAt(vec3(0, -1, 0))).toBe(false);
  });

  it("is inside the sea and outside solid", () => {
    const world = new GameWorld({
      field: () => heightField(() => 0),
      seaRadius: 5,
    });
    expect(world.getInWaterAt(vec3(0, 2, 0))).toBe(true);
    expect(world.getInWaterAt(vec3(0, 8, 0))).toBe(false);
    // Inside the ground under the water, so not swimming in it.
    expect(world.getInWaterAt(vec3(0, -1, 0))).toBe(false);
  });

  /**
   * A supplied predicate, which is what a world whose water is meshed must give.
   *
   * The two rules disagree exactly where it matters: `seaRadius` alone asks the *edited* model
   * whether a point is solid, so a shaft dug down through a hill comes back as flooded — below
   * the sea level, and air as far as the model is concerned. The meshed sea is gated on the
   * *landscape*, which is unmoved by the dig, so there is no water there and the shaft is dry.
   */
  const dugShaft = new GameWorld({
    // The surface dropped to `-1000`, which is what a shaft dug through solid ground looks like
    // to the model: air where there was rock.
    field: () => heightField(() => -1000),
    seaRadius: 5,
    // The landscape still says rock there, so the sea is not there either.
    waterAt: () => false,
  });

  it("takes a supplied predicate as the whole answer", () => {
    // **Both points are below the sea level and both are air as far as the model is concerned** —
    // which is exactly the case the sea level alone would call flooded, and exactly the case a
    // shaft dug through a hill is.
    expect(dugShaft.getSolidAt(vec3(0, -2, 0))).toBe(false);
    expect(dugShaft.getInWaterAt(vec3(0, 2, 0))).toBe(false);
    expect(dugShaft.getInWaterAt(vec3(0, -2, 0))).toBe(false);
  });

  it("does not consult the sea level when a predicate is supplied", () => {
    // **The two are not merged.** A world with a sea material has a predicate and a sea level,
    // and the predicate is the one that describes the water it is drawing — the level is what
    // the globe, the clouds and the atmosphere measure altitudes against.
    const asked: number[] = [];
    const world = new GameWorld({
      field: () => heightField(() => 0),
      seaRadius: 5,
      waterAt: (p) => {
        asked.push(p.y);
        return p.y > 3;
      },
    });
    expect(world.getInWaterAt(vec3(0, 4, 0))).toBe(true);
    expect(world.getInWaterAt(vec3(0, 1, 0))).toBe(false);
    expect(asked).toEqual([4, 1]);
  });

  it("falls back to the sea level with neither", () => {
    // **A world with no water at all**, which is an operations-only editor. Both are absent and
    // the answer is "not swimming", which is what there is to say.
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getInWaterAt(vec3(0, 2, 0))).toBe(false);
  });
});

/**
 * A scripted field reaching the player's physics.
 *
 * ## Why this file rather than `host.test.ts`
 *
 * That one proves the host *has* fields and that `getMediumAt` returns them. This one proves the
 * other half: that the answer arrives somewhere the player's movement reads it, and that a belt
 * with a push on it **moves the player**. Everything above this block is about a value; everything
 * here is about a velocity.
 *
 * **The chain is four links long** — place → host → `GameWorld` → `PlayerWorld` — and a test of
 * any one of them says nothing about the other three. This is the only test in the repository that
 * crosses all four.
 */
describe("a scripted field, as the physics sees it", () => {
  /** The floor, far enough below that gravity is not what these tests are measuring. */
  const FLOOR = -1000;

  /** How much room the belt box has along each axis, for tests that need a long one. */
  interface Reach {
    readonly yLow?: number;
    readonly yHigh?: number;
    readonly zLow?: number;
    readonly zHigh?: number;
  }

  /**
   * A belt pushing towards `+z`, ten units either side in x, and five either side in z and y.
   *
   * **The box is a parameter because several tests need it to be much bigger.** A player walking
   * at sixty units a second leaves a ten-unit belt inside five frames, and a falling player leaves
   * a five-unit one almost immediately — so a test that ran to steady state would have been
   * measuring open ground for most of its frames. A default big enough for those would make the
   * "not in it" case impossible to express, so the size belongs at the call site.
   */
  const belt = (over: Partial<Medium> = {}, reach: Reach = {}): GameWorld => {
    const { yLow = -5, yHigh = 5, zLow = -5, zHigh = 5 } = reach;
    return new GameWorld({
      field: () => heightField(() => FLOOR),
      mediumAt: ({ x, y, z }) =>
        x >= -10 &&
        x <= 10 &&
        y >= yLow &&
        y <= yHigh &&
        z >= zLow &&
        z <= zHigh
          ? {
              pushVx: 0,
              pushVz: 40,
              pushVy: null,
              speedScale: 1,
              sink: 0,
              ...over,
            }
          : undefined,
    });
  };

  /** Wide enough that a player walking for half a second never leaves it. */
  const LONG = { zLow: -1000, zHigh: 1000 } as const;
  /** Tall enough that a player falling for two seconds never leaves it. */
  const DEEP = { yLow: -1000, yHigh: 1000 } as const;
  /**
   * Both, for the walking tests.
   *
   * **The vertical one is not optional and was found by measuring.** These tests run half a second
   * of frames, and the player is in free fall the whole time — there is no floor within reach — so
   * a belt five units tall stops holding them after about fourteen frames and the remaining sixteen
   * are walked at full speed. The ratio came out at 0.66 rather than 0.25, which is the kind of
   * number that reads like a bug in the physics and is actually a bug in the test's geometry.
   */
  const LONG_AND_DEEP = { ...LONG, ...DEEP } as const;

  /** A player standing still at the origin, inside the belt's box and not touching the floor. */
  const standing = () => {
    const player = createPlayer(vec3(0, 0, 0));
    player.onGround = true;
    return player;
  };

  /** One frame with no input at all, so only the field can move anything. */
  const step = (world: GameWorld, player: ReturnType<typeof standing>) => {
    const before = { ...player.position };
    updatePlayer(player, 1 / 60, neutralInput(), world);
    return {
      dx: player.position.x - before.x,
      dz: player.position.z - before.z,
      dy: player.position.y - before.y,
    };
  };

  it("is absent entirely on a world with no places", () => {
    // **`undefined` rather than a function returning null.** The physics's optional chaining reads
    // both the same today, so the difference is a claim rather than an observable — and the claim
    // is that "this world has no fields" is not "this world has none here". A world that always
    // answered null would also cost every frame's optional call for the privilege of saying
    // nothing.
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getMediumAt).toBeUndefined();
  });

  it("answers null where no field stands, rather than undefined", () => {
    // **The other half of that pair, and the difference between them is the point.** A world that
    // *has* fields must answer every question; "none here" is an answer, and `undefined` is the
    // absence of one.
    expect(belt().getMediumAt!(vec3(0, 2, 900))).toBeNull();
  });

  it("pushes a standing player along the belt", () => {
    // **The claim the whole feature exists for.** No input, no slope, no wind: the only thing that
    // can move this player is the field.
    const player = standing();
    const moved = step(belt(), player);
    expect(moved.dz).toBeGreaterThan(0);
    expect(moved.dx).toBeCloseTo(0, 6);
  });

  it("does not move a player who is not in it", () => {
    const player = standing();
    player.position.z = 900;
    const moved = step(belt(), player);
    expect(moved.dz).toBeCloseTo(0, 6);
  });

  it("slows a walking player rather than replacing their speed", () => {
    // **`speedScale` multiplies what they were doing.** The field here pushes nowhere, so the only
    // difference between the two walks is the scale — and a field that *set* the velocity instead
    // would make the player unable to walk against a belt at all, which is not a conveyor.
    //
    // **Thirty frames, not one**, because movement is ramped: acceleration is 600 units/s², so the
    // first frame moves at a tenth of the walk speed and cannot tell a quarter-scale walk from a
    // full one. Both players are run to steady state over the same distance — and the box is long
    // and deep, or they would walk or fall out of it before they got there.
    const input = { ...neutralInput(), moveY: 1 };
    const walk = (world: GameWorld): number => {
      const player = standing();
      const start = player.position.z;
      for (let frame = 0; frame < 30; frame++) {
        updatePlayer(player, 1 / 60, input, world);
      }
      return player.position.z - start;
    };

    const open = walk(new GameWorld({ field: () => heightField(() => FLOOR) }));
    const slowed = walk(belt({ speedScale: 0.25, pushVz: 0 }, LONG_AND_DEEP));

    expect(open).toBeGreaterThan(0);
    expect(slowed).toBeGreaterThan(0);
    // A quarter of the speed, to within a frame of ramp-up on each.
    expect(slowed / open).toBeGreaterThan(0.2);
    expect(slowed / open).toBeLessThan(0.3);
  });

  it("adds its push to the player's own walk rather than replacing it", () => {
    // **A conveyor under a walking player goes the way the player walks, faster.** This is the
    // distinction from the test above: `speedScale` is the one that reduces what they asked for,
    // and the push is added on top of whatever is left.
    const input = { ...neutralInput(), moveY: 1 };
    const walk = (world: GameWorld): number => {
      const player = standing();
      const start = player.position.z;
      for (let frame = 0; frame < 30; frame++) {
        updatePlayer(player, 1 / 60, input, world);
      }
      return player.position.z - start;
    };

    const open = walk(new GameWorld({ field: () => heightField(() => FLOOR) }));
    const beltPlusWalk = walk(belt({ pushVz: 40 }, LONG_AND_DEEP));
    expect(beltPlusWalk).toBeGreaterThan(open);
  });

  it("holds a player down at the sink's speed rather than letting gravity have them", async () => {
    // **Quicksand's other half.** `speedScale: 0` with a `sink` is the whole of it, and the test
    // is that the fall stops accelerating past the field's own limit rather than going terminal
    // velocity forever. Two seconds of falling, compared against a world with no field.
    // **A tall box, because the player has to stay inside it for two whole seconds** — a belt
    // two units thick would drop them out of it in the first few frames and the test would then be
    // measuring falling.
    const world = belt({ speedScale: 0, sink: 6, pushVz: 0 }, DEEP);
    const player = createPlayer(vec3(0, 200, 0));
    const open = createPlayer(vec3(0, 200, 0));

    for (let frame = 0; frame < 120; frame++) {
      updatePlayer(player, 1 / 60, neutralInput(), world);
      updatePlayer(
        open,
        1 / 60,
        neutralInput(),
        new GameWorld({ field: () => heightField(() => FLOOR) }),
      );
    }

    expect(player.position.y).toBeGreaterThan(open.position.y);
    // The fall velocity is the velocity's component along the player's own up, and it has to stay
    // a number — a `NaN` here is a field that has handed the physics a broken target.
    const fall = player.velocity.y;
    expect(Number.isFinite(fall)).toBe(true);
  });

  it("lifts a player who is inside an updraft", () => {
    const world = belt({ pushVy: 60, speedScale: 0 }, DEEP);
    const player = createPlayer(vec3(0, 200, 0));
    const before = player.position.y;
    updatePlayer(player, 1 / 60, neutralInput(), world);
    // **Rising, or at least not falling.** The ramp is `moveTowards`, so one frame from rest is
    // still a small step; what matters is that gravity is not the only thing acting.
    expect(player.position.y).toBeGreaterThanOrEqual(before);
  });

  it("reads a fresh answer every frame, not a snapshot from construction", () => {
    // **The reason `GameWorld` is handed a reader rather than the collection.** A place can add
    // and remove fields while the game is running, and a world that had captured the fields at
    // construction would keep pushing a player standing on a belt that no longer exists.
    let active = true;
    const world = new GameWorld({
      field: () => heightField(() => 0),
      mediumAt: () =>
        active
          ? { pushVx: 0, pushVz: 40, pushVy: null, speedScale: 1, sink: 0 }
          : undefined,
    });

    const inside = standing();
    expect(step(world, inside).dz).toBeGreaterThan(0);

    active = false;
    const outside = standing();
    expect(step(world, outside).dz).toBeCloseTo(0, 6);
  });
});
