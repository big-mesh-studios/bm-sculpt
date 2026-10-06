/**
 * The crosshair's aim, end to end: a held primary digs and a held secondary places on the
 * surface under the crosshair, not in the player.
 *
 * **The regression this guards.** `pickAlong` decided a hit from `distanceForStepping` — the
 * true distance scaled down by the field's Lipschitz bound — rather than from the true
 * distance. The landscape's bound is about `0.037`, so the scaled value at the player's eye
 * (about eleven units above the ground) fell under the tracer's half-unit epsilon: the very
 * first sample of a crosshair pick reported a hit at the ray's own origin, and the dab landed
 * in the player. The picker now reads the true distance for the hit test and the scaled
 * distance only for the step; this is the application-level proof.
 */

import { describe, expect, it } from "vitest";

import { PerspectiveCamera } from "@random-mesh/rmsl/scene";
import { DEFAULT_PLANET } from "@big-mesh-studios/csg";

import { Game } from "./game";
import type { InputSnapshot } from "../player/input";
import type { Viewport } from "../render/viewport";
import { SculptSession } from "../sculpt";
import type { Session } from "../session";
import { sphericalFrame } from "../world/up";

/** The planet's sea radius, which is also where the spawn probe and the game's sea sit. */
const GAME_SEA = DEFAULT_PLANET.radius;

const snapshot = (over: Partial<InputSnapshot> = {}): InputSnapshot => ({
  moveX: 0,
  moveY: 0,
  jump: false,
  jumpHeld: false,
  lookDx: 0,
  lookDy: 0,
  primaryHeld: false,
  secondaryHeld: false,
  ...over,
});

/**
 * A game on the real planet with a real sculpt session, and an input the test drives.
 *
 * The field, the physics and the aim are all real; only the streaming sink and the renderer
 * are stubs, because nothing here draws and `setOperations` is the one message an edit sends.
 */
const build = () => {
  const sculpt = new SculptSession({
    session: { setOperations: () => {}, idle: true } as never,
    camera: {} as never,
    baseField: { kind: "planet", params: DEFAULT_PLANET },
  });
  const camera = new PerspectiveCamera(50, 1, 1, 400000);
  let held = snapshot();
  const game = new Game({
    session: { follow: () => {} } as unknown as Session,
    sculpt,
    viewport: { camera, render: () => {} } as unknown as Viewport,
    input: { consume: () => held } as never,
    frame: sphericalFrame({ x: 0, y: 0, z: 0 }),
    seaRadius: GAME_SEA,
    spawnRadius: GAME_SEA - 200,
  });

  /** Lets the player fall to the ground and settle, so the eye is at its real height. */
  const settle = (): void => {
    for (let i = 0; i < 120; i++) game.tick(1 / 60);
  };

  /** Holds one action for a frame, then releases it on the next, committing the stroke. */
  const hold = (action: Partial<InputSnapshot>): void => {
    held = snapshot(action);
    game.tick(1 / 60);
    held = snapshot();
    game.tick(1 / 60);
  };

  return { game, sculpt, settle, hold };
};

describe("the crosshair's aim", () => {
  it("digs on the surface under the crosshair, not in the player", () => {
    const { game, sculpt, settle, hold } = build();
    settle();
    const player = { ...game.player.position };

    hold({ primaryHeld: true });

    const operations = sculpt.document.list;
    expect(operations).toHaveLength(1);
    const dab = operations[0]!;
    const away = Math.hypot(
      dab.origin.x - player.x,
      dab.origin.y - player.y,
      dab.origin.z - player.z,
    );
    // A brush's reach ahead of the player, not the ray's origin at their eye.
    expect(away).toBeGreaterThan(10);
  });

  it("places on the surface under the crosshair, not in the player", () => {
    const { game, sculpt, settle, hold } = build();
    settle();
    const player = { ...game.player.position };

    hold({ secondaryHeld: true });

    const operations = sculpt.document.list;
    expect(operations).toHaveLength(1);
    const dab = operations[0]!;
    const away = Math.hypot(
      dab.origin.x - player.x,
      dab.origin.y - player.y,
      dab.origin.z - player.z,
    );
    expect(away).toBeGreaterThan(10);
  });
});
