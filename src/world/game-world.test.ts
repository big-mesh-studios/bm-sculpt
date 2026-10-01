import { describe, expect, it } from "vitest";

import { DEFAULT_TERRAIN, Field, OperationBVH, terrainField } from "../csg";
import type { PickField } from "../pick";
import { neutralInput } from "../player/input";
import { createPlayer, updatePlayer } from "../player/player";
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
    expect(world.getSolidAt(0, 1, 0)).toBe(false);
    expect(world.getSolidAt(0, -1, 0)).toBe(true);
  });
});

describe("ground height", () => {
  it("finds the surface below a point in the air", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getGroundHeightAt(0, 50, 0)).toBeCloseTo(0, 1);
  });

  it("finds the top of the material a point is inside", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getGroundHeightAt(0, -20, 0)).toBeCloseTo(0, 1);
  });

  it("reports a step's own top, so it can be climbed", () => {
    const world = new GameWorld({
      field: () => heightField((_x, z) => (z > 20 ? 10 : 0)),
    });
    expect(world.getGroundHeightAt(0, 0, 25)).toBeCloseTo(10, 1);
    expect(world.getGroundHeightAt(0, 0, 10)).toBeCloseTo(0, 1);
  });

  it("converges with a conservative Lipschitz bound", () => {
    const world = new GameWorld({
      field: () => heightField((_x, _z) => 0, 0.2),
    });
    expect(world.getGroundHeightAt(0, 100, 0)).toBeCloseTo(0, 1);
  });

  it("has no surface under a column of nothing", () => {
    const world = new GameWorld({
      field: () => heightField(() => Number.NEGATIVE_INFINITY),
    });
    expect(world.getGroundHeightAt(0, 10, 0)).toBe(-Infinity);
  });
});

describe("terrain height", () => {
  it("reads the analytic height when it has one", () => {
    const world = new GameWorld({
      field: () => heightField(() => 0),
      heightAt: (x, z) => x + z,
    });
    expect(world.getHeightAt(3, 4)).toBe(7);
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
    const player = createPlayer(0, 6, 0);
    player.yaw = 0; // faces uphill, +Z
    const input = { ...neutralInput(), moveY: 1 };
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
    const world = new GameWorld({
      field: () => field,
      heightAt: terrain.heightAt,
    });

    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const player = createPlayer(0, terrain.heightAt(0, 0) + 6, 0);
      player.yaw = yaw;
      const input = { ...neutralInput(), moveY: 1 };
      for (let i = 0; i < 300; i++) updatePlayer(player, 1 / 60, input, world);

      const travelled =
        player.position.x * Math.sin(yaw) + player.position.z * Math.cos(yaw);
      expect(travelled).toBeGreaterThan(250);
      expect(player.onGround).toBe(true);
    }
  });
});

describe("water", () => {
  it("is off when the world has no sea level", () => {
    const world = new GameWorld({ field: () => heightField(() => 0) });
    expect(world.getInWaterAt(0, -1, 0)).toBe(false);
  });

  it("is below the sea level and outside solid", () => {
    const world = new GameWorld({
      field: () => heightField(() => 0),
      seaLevel: 5,
    });
    expect(world.getInWaterAt(0, 2, 0)).toBe(true);
    expect(world.getInWaterAt(0, 8, 0)).toBe(false);
    // Inside the ground under the water, so not swimming in it.
    expect(world.getInWaterAt(0, -1, 0)).toBe(false);
  });
});
