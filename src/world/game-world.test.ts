import { describe, expect, it } from "vitest";

import type { PickField } from "../pick";
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
