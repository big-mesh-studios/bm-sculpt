import { describe, expect, it } from "vitest";

import { neutralInput, type InputSnapshot } from "./input";
import {
  createPlayer,
  updatePlayer,
  type Player,
  type PlayerWorld,
} from "./player";

/** A step of the physics a test drives by hand. */
const STEP = 1 / 60;

/**
 * A world defined by a surface height per column: everything below it is solid,
 * and the ground query reports that surface, which the physics clamps to a step.
 */
const surfaceWorld = (
  surface: (x: number, z: number) => number,
  overrides: Partial<PlayerWorld> = {},
): PlayerWorld => ({
  getGroundHeightAt: (x, _y, z) => surface(x, z),
  getInWaterAt: () => false,
  getSolidAt: (x, y, z) => y < surface(x, z),
  halfExtent: 1e6,
  ...overrides,
});

/** A flat world at `y = 0`, the common case. */
const flatWorld = (overrides: Partial<PlayerWorld> = {}): PlayerWorld =>
  surfaceWorld(() => 0, overrides);

/** Runs the physics for `seconds`, returning the player after the last step. */
const run = (
  player: Player,
  world: PlayerWorld,
  seconds: number,
  input: InputSnapshot = neutralInput(),
): Player => {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) updatePlayer(player, STEP, input, world);
  return player;
};

const input = (overrides: Partial<InputSnapshot>): InputSnapshot => ({
  ...neutralInput(),
  ...overrides,
});

describe("falling and landing", () => {
  it("falls under gravity and rests on the surface", () => {
    const player = createPlayer(0, 50, 0);
    run(player, flatWorld(), 3);

    expect(player.position.y).toBeCloseTo(player.config.halfSize, 3);
    expect(player.onGround).toBe(true);
    expect(player.vy).toBe(0);
  });

  it("holds its height over a column with no surface at all", () => {
    // A void, or blocks that have not streamed in: the player is held rather
    // than dropped out of the world, and falls again once there is ground.
    const player = createPlayer(0, 50, 0);
    run(
      player,
      surfaceWorld(() => -Infinity),
      1,
    );
    expect(player.position.y).toBeCloseTo(50, 6);
    expect(player.onGround).toBe(true);
  });
});

describe("jumping", () => {
  it("leaves the ground on an edge and comes back down", () => {
    const player = createPlayer(0, 5, 0);
    run(player, flatWorld(), 1);
    expect(player.onGround).toBe(true);

    updatePlayer(player, STEP, input({ jump: true }), flatWorld());
    expect(player.vy).toBeGreaterThan(0);

    const peak = run(player, flatWorld(), 0.2).position.y;
    expect(peak).toBeGreaterThan(5);

    run(player, flatWorld(), 3);
    expect(player.position.y).toBeCloseTo(player.config.halfSize, 3);
    expect(player.onGround).toBe(true);
  });
});

describe("walking", () => {
  it("moves along +Z when facing +Z", () => {
    const player = createPlayer(0, 5, 0);
    run(player, flatWorld(), 1, input({ moveY: 1 }));
    expect(player.position.z).toBeGreaterThan(10);
    expect(Math.abs(player.position.x)).toBeLessThan(1e-6);
  });

  it("strafes along -X when facing +Z", () => {
    const player = createPlayer(0, 5, 0);
    run(player, flatWorld(), 1, input({ moveX: 1 }));
    expect(player.position.x).toBeLessThan(-10);
  });

  it("stops flush against a wall", () => {
    const world = surfaceWorld((_x, z) => (z > 40 ? 40 : 0));
    const player = createPlayer(0, 5, 0);
    run(player, world, 2, input({ moveY: 1 }));

    // The collision box is narrow, so the player stops a collision radius short
    // of the wall rather than inside it.
    expect(player.position.z).toBeLessThanOrEqual(40);
    expect(player.position.z).toBeGreaterThan(30);
  });
});

describe("stepping up", () => {
  it("climbs a step within stepHeight", () => {
    const world = surfaceWorld((_x, z) => (z > 20 ? 10 : 0));
    const player = createPlayer(0, 5, 0);
    run(player, world, 2, input({ moveY: 1 }));

    expect(player.position.z).toBeGreaterThan(20);
    expect(player.position.y).toBeCloseTo(10 + player.config.halfSize, 1);
  });
});

describe("look", () => {
  it("turns yaw and clamps pitch", () => {
    const player = createPlayer(0, 5, 0);
    run(player, flatWorld(), 0.1, input({ lookDx: 100, lookDy: -1e6 }));
    expect(player.yaw).toBeLessThan(0);
    expect(player.pitch).toBeCloseTo(player.config.maxPitch, 5);
  });
});
