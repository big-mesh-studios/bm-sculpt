/**
 * The two switches the console's player commands reach for.
 *
 * `Game` is a seam that ties a session, a viewport and an input together, none
 * of which these two methods touch: both reach nothing but `this.player`. So
 * they are built here over stubs for the rest, which is the point — if either
 * ever grows a dependency on the renderer or the streaming window, this file is
 * what stops compiling.
 */

import { describe, expect, it } from "vitest";

import type { InputController } from "../player/input";
import type { Session } from "../session";
import type { SculptSession } from "../sculpt";
import type { Viewport } from "../render/viewport";
import { Game } from "./game";

/** A game whose player spawns on flat ground, over collaborators nothing reads. */
const game = (): Game =>
  new Game({
    session: {} as Session,
    sculpt: {
      // Never read: the analytic height answers the spawn query instead, so the
      // field is not sampled and its shape does not matter here.
      collisionField: {} as SculptSession["collisionField"],
      terrainHeight: () => 0,
    } as unknown as SculptSession,
    viewport: {} as Viewport,
    input: {} as InputController,
  });

describe("flight", () => {
  it("flips when given nothing to go on", () => {
    const subject = game();
    expect(subject.player.flying).toBe(false);
    expect(subject.setFlying()).toBe("flying");
    expect(subject.player.flying).toBe(true);
    expect(subject.setFlying()).toBe("walking");
    expect(subject.player.flying).toBe(false);
  });

  it("takes the direction it is given", () => {
    const subject = game();
    expect(subject.setFlying(true)).toBe("flying");
    expect(subject.setFlying(true)).toBe("flying");
    expect(subject.setFlying(false)).toBe("walking");
    expect(subject.setFlying(false)).toBe("walking");
  });

  it("discards a fall in progress on the way on", () => {
    // The flight integrator ramps velocity toward its target from wherever the
    // walk left it, so a fall still in the first frame would carry the player
    // through whatever they were aiming at.
    const subject = game();
    subject.player.vy = -180;
    subject.player.onGround = true;

    subject.setFlying(true);
    expect(subject.player.vy).toBe(0);
    expect(subject.player.onGround).toBe(false);
  });

  it("leaves the fall alone on the way off, since the walk resumes it", () => {
    const subject = game();
    subject.setFlying(true);
    subject.player.vy = 12;
    subject.player.onGround = false;

    subject.setFlying(false);
    expect(subject.player.vy).toBe(12);
  });
});

describe("no-clip", () => {
  it("flips when given nothing to go on", () => {
    const subject = game();
    expect(subject.player.noclip).toBe(false);
    expect(subject.setNoClip()).toBe("no-clip");
    expect(subject.player.noclip).toBe(true);
    expect(subject.setNoClip()).toBe("collisions on");
    expect(subject.player.noclip).toBe(false);
  });

  it("takes the direction it is given", () => {
    const subject = game();
    expect(subject.setNoClip(true)).toBe("no-clip");
    expect(subject.setNoClip(false)).toBe("collisions on");
  });

  it("discards a fall in progress on the way on", () => {
    // Same reason as flight: no-clip never settles a velocity itself, so the
    // one it inherits is the walk's.
    const subject = game();
    subject.player.vy = -180;
    subject.player.onGround = true;

    subject.setNoClip(true);
    expect(subject.player.vy).toBe(0);
    expect(subject.player.onGround).toBe(false);
  });

  it("is independent of flight, so both can be on at once", () => {
    // No-clip wins in `updatePlayer`, but a player who asked for both has said
    // something coherent, and the two flags are not one another's business.
    const subject = game();
    subject.setFlying(true);
    subject.setNoClip(true);
    expect(subject.player.flying).toBe(true);
    expect(subject.player.noclip).toBe(true);

    subject.setNoClip(false);
    expect(subject.player.flying).toBe(true);
    expect(subject.player.noclip).toBe(false);
  });
});
