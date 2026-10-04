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

import { PerspectiveCamera } from "@random-mesh/rmsl/scene";
import {
  DEFAULT_TERRAIN,
  Field,
  OperationBVH,
  makeOperation,
  terrainField,
} from "@big-mesh-studios/csg";

import type { InputController } from "../player/input";
import type { Session } from "../session";
import type { SculptSession } from "../sculpt";
import type { Viewport } from "../render/viewport";
import { DEFAULT_SPACE_ALTITUDE, Game, type GameOptions } from "./game";
import type { Player } from "../player/player";
import { dot } from "@big-mesh-studios/core";

/**
 * A player's fall, as the one number the flight and no-clip tests care about.
 *
 * **The velocity's component along their own up**, which is what `vy` used to be outright. Read
 * through the frame rather than off a field, so the tests say the same thing on a planet.
 */
const fallOf = (player: Player): number => dot(player.velocity, player.up);

/** Sets a player's fall, leaving any horizontal motion alone. */
const setFall = (player: Player, speed: number): void => {
  const delta = speed - fallOf(player);
  player.velocity = {
    x: player.velocity.x + player.up.x * delta,
    y: player.velocity.y + player.up.y * delta,
    z: player.velocity.z + player.up.z * delta,
  };
};

/**
 * A player's heading, as the signed angle about their own up that world `+Z` is zero of.
 *
 * **Not derived from `right`, which cannot be.** `right` is defined as `forward × up`, so it is
 * perpendicular to the look direction by construction and carries no information about which way
 * round the player is facing. The angle comes from the look direction's own components against
 * the tangent-plane projections of the world axes — which is exactly the pair the old `yaw` was,
 * and the reason `yaw` was a world-axis quantity in the first place.
 *
 * On a flat frame with the player facing world `+Z` this is 0, and a positive angle is a turn
 * toward world `+X`, which is the sign the old `yaw` had.
 */
const facingOf = (player: Player): number => {
  const up = player.up;
  const inPlane = (v: {
    x: number;
    y: number;
    z: number;
  }): { x: number; y: number; z: number } => {
    const k = v.x * up.x + v.y * up.y + v.z * up.z;
    const t = { x: v.x - up.x * k, y: v.y - up.y * k, z: v.z - up.z * k };
    const l = Math.hypot(t.x, t.y, t.z) || 1;
    return { x: t.x / l, y: t.y / l, z: t.z / l };
  };
  const heading = inPlane(player.forward);
  const towardX = inPlane({ x: 1, y: 0, z: 0 });
  const towardZ = inPlane({ x: 0, y: 0, z: 1 });
  const across =
    heading.x * towardX.x + heading.y * towardX.y + heading.z * towardX.z;
  const along =
    heading.x * towardZ.x + heading.y * towardZ.y + heading.z * towardZ.z;
  return Math.atan2(-across, along);
};

/** A game whose player spawns on flat ground, over collaborators nothing reads. */
/**
 * A field whose surface is `y = 0`, which is what the spawn query now reads.
 *
 * **A real field rather than a stub, because the spawn asks it a question.** The spawn used to
 * take the terrain's analytic height and never touched the field, so a mock could hand `Game` an
 * empty object and the tests only exercised the flight and teleport paths. `spawnOnTheSurface`
 * asks the world the same question the physics asks — a distance along the local up to the
 * surface — so the mock has to be able to answer it, and a stub that cannot would fail every
 * test in this file for a reason that has nothing to do with any of them.
 */
const flatCollisionField = (): SculptSession["collisionField"] =>
  new Field(new OperationBVH([]), {
    base: terrainField(DEFAULT_TERRAIN),
    extent: terrainField(DEFAULT_TERRAIN),
  });

const game = (): Game =>
  new Game({
    session: {} as Session,
    sculpt: {
      collisionField: flatCollisionField(),
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
    setFall(subject.player, -180);
    subject.player.onGround = true;

    subject.setFlying(true);
    expect(fallOf(subject.player)).toBe(0);
    expect(subject.player.onGround).toBe(false);
  });

  it("leaves the fall alone on the way off, since the walk resumes it", () => {
    const subject = game();
    subject.setFlying(true);
    setFall(subject.player, 12);
    subject.player.onGround = false;

    subject.setFlying(false);
    expect(fallOf(subject.player)).toBe(12);
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
    setFall(subject.player, -180);
    subject.player.onGround = true;

    subject.setNoClip(true);
    expect(fallOf(subject.player)).toBe(0);
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

/**
 * What a loaded place can ask the game to do.
 *
 * These are reached only from `HostEffects`, which is why they are tested here rather than in
 * `places/host.test.ts`: that file stands a stub in for the game, and so it can only prove the
 * request *arrives*. Everything below is about what actually happens to the player, which is
 * the half a person standing in a place would notice.
 *
 * `Game` is still built over collaborators nothing here touches — the same seam as the rest of
 * this file — except where a test genuinely needs one, which is `raycast` and `tick`.
 */
describe("teleporting the player", () => {
  it("puts them where they were sent", () => {
    const subject = game();
    subject.teleportPlayer({ x: 120, y: 40, z: -30 });
    expect(subject.player.position.x).toBe(120);
    expect(subject.player.position.y).toBe(40);
    expect(subject.player.position.z).toBe(-30);
  });

  it("faces them where they were told to face", () => {
    const subject = game();
    subject.teleportPlayer({ x: 0, y: 0, z: 0 }, 1.5);
    // **A heading angle about the player's own up, measured as a direction.** There is no `yaw`
    // any more — it was a rotation about a world axis — so the assertion turns the angle back
    // into the direction the player should be facing and compares that.
    expect(facingOf(subject.player)).toBeCloseTo(1.5, 6);
  });

  it("leaves the facing alone when none was given", () => {
    // **Unspecified is not zero.** A place that moves the player to the middle of
    // its bridge and says nothing about facing would otherwise snap them to
    // north, which is the one direction a bridge never goes.
    const subject = game();
    subject.teleportPlayer({ x: 0, y: 0, z: 0 }, 2.5);
    const before = subject.player.forward;
    subject.teleportPlayer({ x: 10, y: 10, z: 10 });
    expect(subject.player.forward).toEqual(before);
  });

  it("discards the fall, so arriving on a platform is not a suggestion", () => {
    const subject = game();
    subject.player.velocity = { x: 40, y: -180, z: -12 };

    subject.teleportPlayer({ x: 0, y: 30, z: 0 });
    // **The whole velocity, not just the fall.** Arriving with a sideways
    // velocity slides the player off the thing they were just placed on, and a
    // place cannot know that its own platform has an edge.
    expect(subject.player.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("a place scaling the player's movement", () => {
  it("scales the walking speed", () => {
    const subject = game();
    const base = subject.player.config.speed;
    subject.setPlayerSpeed(0.5);
    expect(subject.player.config.speed).toBe(base * 0.5);
  });

  it("scales the jump", () => {
    const subject = game();
    const base = subject.player.config.jumpSpeed;
    subject.setPlayerJump(2);
    expect(subject.player.config.jumpSpeed).toBe(base * 2);
  });

  it("leaves turning and swimming alone", () => {
    // **One number each.** Speed is not "movement": a place that doubles the walk
    // has not doubled how fast the player looks around or swims, and making it
    // do so would make a slow place unreadable rather than slow.
    const subject = game();
    const sensitivity = subject.player.config.lookSensitivity;
    const swim = subject.player.config.swimSpeed;
    subject.setPlayerSpeed(4);
    subject.setPlayerJump(4);
    expect(subject.player.config.lookSensitivity).toBe(sensitivity);
    expect(subject.player.config.swimSpeed).toBe(swim);
  });

  it("replaces rather than compounds, so running a setup twice is not four times", () => {
    // **The order-independence the base snapshot buys.** Compounding is the
    // default failure of any "multiply the current value" implementation, and it
    // leaves a player who has loaded a place twice walking at four times their
    // speed with no way back to one.
    const subject = game();
    const base = subject.player.config.speed;
    subject.setPlayerSpeed(2);
    subject.setPlayerSpeed(2);
    expect(subject.player.config.speed).toBe(base * 2);
  });

  it("puts the speed back", () => {
    const subject = game();
    const base = subject.player.config.speed;
    subject.setPlayerSpeed(0.1);
    subject.clearPlayerSpeed();
    expect(subject.player.config.speed).toBe(base);
  });

  it("puts the jump back", () => {
    const subject = game();
    const base = subject.player.config.jumpSpeed;
    subject.setPlayerJump(8);
    subject.clearPlayerJump();
    expect(subject.player.config.jumpSpeed).toBe(base);
  });

  it("scales from the world's own speed, not the default's", () => {
    // **A world may be built slower on purpose.** Scaling from `DEFAULT_PLAYER_CONFIG`
    // would replace that with the default, so halving the speed of a deliberately
    // slow world would make it walk at the default half — the opposite of asked.
    const subject = new Game({
      session: {} as Session,
      // A real field, for the same reason as `game()` above: the spawn asks it for the surface.
      sculpt: {
        collisionField: flatCollisionField(),
      } as unknown as SculptSession,
      viewport: {} as Viewport,
      input: {} as InputController,
      player: { speed: 30 },
    });
    subject.setPlayerSpeed(2);
    expect(subject.player.config.speed).toBe(60);
  });

  it("unscales back to the world's own speed, not the default's", () => {
    const subject = new Game({
      session: {} as Session,
      // A real field, for the same reason as `game()` above: the spawn asks it for the surface.
      sculpt: {
        collisionField: flatCollisionField(),
      } as unknown as SculptSession,
      viewport: {} as Viewport,
      input: {} as InputController,
      player: { speed: 30 },
    });
    subject.setPlayerSpeed(0.25);
    subject.clearPlayerSpeed();
    expect(subject.player.config.speed).toBe(30);
  });

  it("restores an unsupplied speed to the default, having started at the default", () => {
    const subject = game();
    const base = subject.player.config.speed;
    expect(base).toBe(60);
    subject.setPlayerSpeed(3);
    subject.clearPlayerSpeed();
    expect(subject.player.config.speed).toBe(60);
  });
});

/**
 * `tick`, and the two things a place does that only `tick` can show.
 *
 * **The collaborators are real where they have to be.** A `PerspectiveCamera` because the claim
 * under test is about where a camera ends up pointing, and a stub camera cannot be wrong in the
 * interesting way; an empty `Field` because `updatePlayer` samples one and a stubbed sample would
 * make a fall-through test meaningless. Everything else is still a stub — nothing here reaches a
 * renderer, and the camera's own matrices are updated explicitly rather than by a draw.
 */
const ticking = (options: { world?: Partial<GameOptions> } = {}) => {
  const camera = new PerspectiveCamera(1.05, 1, 1, 100000);
  const field = new Field(new OperationBVH([]));
  const subject = new Game({
    session: { follow: () => {} } as unknown as Session,
    sculpt: {
      collisionField: field,
      terrainHeight: () => 0,
      flushPreview: () => {},
    } as unknown as SculptSession,
    viewport: { camera, render: () => {} } as unknown as Viewport,
    input: {
      consume: () => ({
        moveX: 0,
        moveY: 0,
        jump: false,
        jumpHeld: false,
        lookDx: 0,
        lookDy: 0,
        primaryHeld: false,
        secondaryHeld: false,
      }),
    } as unknown as InputController,
    ...(options.world ?? {}),
  });
  return { subject, camera };
};

/** The camera's own answer to "which way am I looking", from where it stands. */
const facing = (camera: PerspectiveCamera): [number, number, number] => {
  // Read off the view matrix's third row, which is the direction basis: the
  // camera's own `lookAt` wrote it, so this asks the camera rather than
  // re-deriving what it was told.
  const e = camera.matrixWorldInverse.elements;
  return [-e[2], -e[6], -e[10]];
};

describe("a place pointing the camera", () => {
  it("leaves the camera on the player when no place has asked", () => {
    const { subject, camera } = ticking();
    subject.tick(1 / 60);
    // The player's eye, looking along their yaw: the crosshair lines up with
    // where an edit picks, and nothing may quietly change that.
    expect(camera.position.y).toBeGreaterThan(0);
  });

  it("looks where it was told, on the same frame", () => {
    const { subject, camera } = ticking();
    // **Straight down, so the answer is unambiguous.** Any target off-axis
    // makes this a trigonometry test.
    subject.lookAt({ x: 0, y: -1000, z: 0 });
    subject.tick(1 / 60);
    const [x, y, z] = facing(camera);
    expect(y).toBeLessThan(-0.99);
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(Math.abs(z)).toBeLessThan(0.01);
  });

  it("survives the player's own camera placement", () => {
    // **The whole of the `tick` ordering.** `placeCamera` runs every frame and
    // would overwrite anything written before it; the claim is that a place's
    // look is applied *after*, and a single tick is what proves it.
    const { subject, camera } = ticking();
    subject.lookAt({ x: 0, y: -1000, z: 0 });
    subject.tick(1 / 60);
    subject.tick(1 / 60);
    expect(facing(camera)[1]).toBeLessThan(-0.99);
  });

  it("takes the field of view it was given", () => {
    const { subject, camera } = ticking();
    const before = camera.fov;
    subject.lookAt({ x: 0, y: 0, z: 1 }, 0.5);
    subject.tick(1 / 60);
    expect(camera.fov).toBe(0.5);
    expect(camera.fov).not.toBe(before);
  });

  it("leaves the field of view alone when none was given", () => {
    // **Unspecified is not the default.** A place pointing the camera at
    // something without an opinion on the lens has said nothing about the lens,
    // and resetting it would zoom the player out for the rest of the session.
    const { subject, camera } = ticking();
    const before = camera.fov;
    subject.lookAt({ x: 0, y: 0, z: 1 });
    subject.tick(1 / 60);
    expect(camera.fov).toBe(before);
  });

  it("gives the camera back", () => {
    const { subject, camera } = ticking();
    subject.lookAt({ x: 0, y: -1000, z: 0 });
    subject.tick(1 / 60);
    subject.clearCameraLook();
    subject.tick(1 / 60);
    // **The player's eye again, not merely "not straight down".** The next tick
    // standing alone is what makes the effect's contract honest: a place that
    // cleared its camera has restored the thing it borrowed.
    expect(facing(camera)[1]).toBeGreaterThan(-0.99);
  });

  it("restores the field of view too", () => {
    const { subject, camera } = ticking();
    const before = camera.fov;
    subject.lookAt({ x: 0, y: 0, z: 1 }, 0.5);
    subject.tick(1 / 60);
    subject.clearCameraLook();
    subject.tick(1 / 60);
    expect(camera.fov).toBe(before);
  });
});

describe("a place casting a ray", () => {
  /** A world with one flat slab in it, so there is a surface to find. */
  const withSlab = () =>
    ticking({
      world: {
        sculpt: {
          collisionField: new Field(
            new OperationBVH([
              makeOperation(
                0,
                { x: 0, y: 0, z: 0 },
                { type: "Box", len: { x: 40, y: 2, z: 40 } },
                "Add",
              ),
            ]),
          ),
          terrainHeight: () => 0,
          flushPreview: () => {},
        } as unknown as SculptSession,
      },
    });

  it("reports nothing when there is nothing there", () => {
    const { subject } = ticking();
    expect(subject.raycast([0, 100, 0], [0, -1, 0], 1000)).toBeUndefined();
  });

  it("says there is nothing for a zero-length direction, rather than dividing by zero", () => {
    const { subject } = withSlab();
    // **The honest answer.** Normalising `[0, 0, 0]` produces NaN, and a NaN
    // point handed to a place reads as "the surface is at the origin".
    expect(subject.raycast([0, 100, 0], [0, 0, 0], 1000)).toBeUndefined();
  });

  it("says there is nothing when asked to look no distance at all", () => {
    const { subject } = withSlab();
    expect(subject.raycast([0, 100, 0], [0, -1, 0], 0)).toBeUndefined();
    expect(subject.raycast([0, 100, 0], [0, -1, 0], -5)).toBeUndefined();
  });

  it("finds the surface it was pointed at", () => {
    const { subject } = withSlab();
    const hit = subject.raycast([0, 100, 0], [0, -1, 0], 1000);
    expect(hit).toBeDefined();
    // **Down at the slab's top, which is y = 2.** Not "somewhere on the way" —
    // a raycast that reported a point inside the slab would let a place build a
    // bridge to a surface nobody can see.
    expect(hit!.point[1]).toBeCloseTo(2, 0);
    expect(hit!.distance).toBeCloseTo(98, 0);
  });

  it("says which way the surface faces there", () => {
    const { subject } = withSlab();
    const hit = subject.raycast([0, 100, 0], [0, -1, 0], 1000);
    // **An upward normal for a slab cast at from above.** A normal pointing the
    // wrong way is the difference between a place that builds a bridge above the
    // ground and one that buries it.
    expect(hit!.normal[1]).toBeGreaterThan(0.9);
  });

  it("calls it terrain, because the fold is one surface with no record of what made it", () => {
    const { subject } = withSlab();
    // **The honest kind, not a convenient one.** The field is a single signed
    // distance function over the terrain and every operation in every place, so it
    // cannot say whether it met the ground or a shape. Naming the type `terrain`
    // says so before a place is written against a promise the field cannot keep.
    expect(subject.raycast([0, 100, 0], [0, -1, 0], 1000)!.kind).toBe(
      "terrain",
    );
  });

  it("does not depend on the direction's length", () => {
    const { subject } = withSlab();
    const near = subject.raycast([0, 100, 0], [0, -1, 0], 1000);
    const far = subject.raycast([0, 100, 0], [0, -100, 0], 1000);
    // **Normalised, because every step depends on it.** An unnormalised
    // direction walks the tracer a hundred units in one step and overshoots the
    // slab entirely, which reads as "no surface" for every vertical ray.
    expect(far!.distance).toBeCloseTo(near!.distance, 0);
  });
});

describe("placing the player in space", () => {
  it("puts them at the altitude with flight on and no leftover fall", () => {
    // The debug command's whole job: a player in space fast, without the climb. On a flat world the
    // altitude is a world `y`, which is the branch this harness exercises.
    const subject = game();
    subject.player.velocity = { x: 4, y: -9, z: 2 };
    const line = subject.placeInSpace(3000);
    expect(subject.player.position.y).toBeCloseTo(3000, 6);
    expect(subject.player.flying).toBe(true);
    expect(subject.player.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(line).toContain("3000");
  });

  it("uses the game's default when given no altitude, so the number lives in one place", () => {
    const subject = game();
    expect(subject.placeInSpace()).toContain(String(DEFAULT_SPACE_ALTITUDE));
    expect(subject.player.position.y).toBeCloseTo(DEFAULT_SPACE_ALTITUDE, 6);
  });
});
