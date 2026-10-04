/**
 * Player movement, and the frame it stands in.
 *
 * ## Every case below runs four times over
 *
 * This file used to test a player on a flat world at the origin, which is one of the four
 * positions that matter and the only one that was ever tested. A physics that reads "down" as a
 * constant is correct there and **wrong everywhere else in a way no assertion about the origin
 * can see** — a gravity that subtracts from world `y` drops a player sideways at any latitude
 * that is not the pole, and a collision box aligned to world axes is standing on its end at the
 * pole itself.
 *
 * So each case runs against four worlds, differing only in which way is up:
 *
 * | World | Local up at the origin | Why |
 * |---|---|---|
 * | `flat` | `+Y` | the world this application has today |
 * | `oblique` | `-X` | no world axis is up, which is the general case |
 * | `pole` | `+Y`, on a sphere | the world axis *is* the local up, so a fixed-axis frame is accidentally right |
 * | `antipode` | `-Y`, on a sphere | a cross product against a fixed axis degenerates here |
 *
 * All four put their surface through the origin, so a spawn point is the same number in each and
 * nothing in the cases below can be passing because it found easier terrain.
 *
 * **The assertions are the same four numbers every time, expressed in the player's own frame** —
 * distances along their `up`, their `forward` and their `right`. Nothing is weakened for the
 * tilted worlds and nothing is special-cased, which is the point: the assertions that would catch
 * a world-axis frame are exactly the ones that read the frame.
 */

import { describe, expect, it } from "vitest";
import type { Vec3 } from "@big-mesh-studios/core";
import { dot, length, scale, sub, vec3 } from "@big-mesh-studios/core";

import { neutralInput, type InputSnapshot } from "./input";
import { flatFrame, sphericalFrame } from "../world/up";
import {
  createPlayer,
  placeCamera,
  playerEye,
  updatePlayer,
  type Player,
  type PlayerWorld,
} from "./player";

/** A step of the physics a test drives by hand. */
const STEP = 1 / 60;

/** The planet's radius in these tests: small enough to be exact arithmetic, large enough to curve. */
const RADIUS = 4000;

/** The surface every world below passes through, at the origin. */
const ORIGIN_SURFACE = vec3(0, 0, 0);

/** A world whose surface is a height `height(x, z)` above the origin. */
const flatSurface = (
  height: (x: number, z: number) => number,
  overrides: Partial<PlayerWorld> = {},
): PlayerWorld => ({
  frame: flatFrame,
  centre: undefined,
  // The surface is a plane, so the distance along any `up` is the height difference.
  getGroundDistanceAt: (feet) => height(feet.x, feet.z) - feet.y,
  getInWaterAt: () => false,
  getSolidAt: (p) => p.y < height(p.x, p.z),
  halfExtent: 1e6,
  ...overrides,
});

/** A world whose surface is `RADIUS + height(direction)` from `centre`. */
const sphereSurface = (
  centre: Vec3,
  height: (direction: Vec3) => number = () => 0,
  overrides: Partial<PlayerWorld> = {},
): PlayerWorld => {
  const frame = sphericalFrame(centre);
  /** The radius of the surface, evaluated for the direction of `p`. */
  const surfaceRadius = (p: Vec3): number => {
    const d = sub(p, centre);
    const l = length(d) || 1;
    return RADIUS + height(scale(d, 1 / l));
  };
  return {
    frame,
    centre,
    // Moving along `up` increases the radius by exactly as much as it moves, so the distance to
    // the surface is the difference of the two radii. No trace and no iteration: the surface is
    // a radial graph and the answer is closed-form, which is what makes it usable as a reference.
    getGroundDistanceAt: (feet) => surfaceRadius(feet) - frame.radiusAt(feet),
    getInWaterAt: () => false,
    getSolidAt: (p) => frame.radiusAt(p) < surfaceRadius(p),
    halfExtent: 1e6,
    ...overrides,
  };
};

/**
 * The four worlds each case runs against.
 *
 * **The centres are chosen so the local up at the origin takes each of the interesting shapes.**
 * A sphere of radius `RADIUS` about `centre` passes through the origin when
 * `|centre| = RADIUS`, and its up there is `-centre/|centre|`. So `centre = (RADIUS,0,0)` gives
 * up `-X` and `centre = (0,RADIUS,0)` gives up `-Y`, and negating either gives `+X` or `+Y`.
 */
const WORLDS: readonly { label: string; world: PlayerWorld }[] = [
  { label: "flat, up +Y", world: flatSurface(() => 0) },
  { label: "sphere, up -X", world: sphereSurface(vec3(RADIUS, 0, 0)) },
  {
    label: "sphere, up +Y at a pole",
    world: sphereSurface(vec3(0, -RADIUS, 0)),
  },
  {
    label: "sphere, up -Y at the antipode",
    world: sphereSurface(vec3(0, RADIUS, 0)),
  },
];

/** Runs one case against every world, with the world's label in the assertion messages. */
const forEachWorld = (
  name: string,
  body: (world: PlayerWorld, label: string) => void,
): void => {
  for (const { label, world } of WORLDS) {
    it(`${name} — ${label}`, () => body(world, label));
  }
};

/** A player dropped `lift` above the origin, standing in the world's own frame. */
const dropped = (world: PlayerWorld, lift: number): Player =>
  createPlayer(
    add3(ORIGIN_SURFACE, world.frame.upAt(ORIGIN_SURFACE), lift),
    {},
    world.frame,
  );

const add3 = (p: Vec3, dir: Vec3, k: number): Vec3 => ({
  x: p.x + dir.x * k,
  y: p.y + dir.y * k,
  z: p.z + dir.z * k,
});

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

/**
 * How far a player's **feet** are above the surface along their own up: zero when they are
 * standing on it.
 *
 * Measured at the feet and not at the centre, because the centre is a half-size up by
 * construction and subtracting it here would double-count it.
 */
const aboveSurface = (player: Player, world: PlayerWorld): number =>
  world.getGroundDistanceAt(
    add3(player.position, scale(player.up, -1), player.config.halfSize),
    player.up,
  );

/** The player's heading projected into their tangent plane, as a unit vector. */
const headingOf = (player: Player): Vec3 => {
  const t = sub(
    player.forward,
    scale(player.up, dot(player.forward, player.up)),
  );
  const l = length(t);
  return l === 0 ? t : scale(t, 1 / l);
};

describe("standing", () => {
  forEachWorld("comes to rest on the surface", (world, label) => {
    const player = dropped(world, 50);
    run(player, world, 3);

    // **The surface distance is the assertion, and it is read in the player's own frame.**
    // The old one was `position.y === halfSize`, which on a tilted frame is not a statement
    // about the player at all — it is a statement about the world axis.
    //
    // The bound is three thousandths of a unit rather than the flat world's exact zero, because
    // **the collision box is a flat disc standing on a round ground.** Its footprint reaches
    // `collisionRadius · √2` out from the centre, and a sphere of radius 4000 is that far
    // `r²/2R` — a quarter of three thousandths — *below* the tangent plane the feet are on. That
    // is the sagitta of the player's own box, not an error in the physics.
    const sagitta = (3 * Math.SQRT2 * 3) ** 2 / (2 * RADIUS);
    expect(Math.abs(aboveSurface(player, world)), label).toBeLessThan(
      0.005 + sagitta,
    );
    expect(player.onGround, label).toBe(true);
    expect(dot(player.velocity, player.up), label).toBeCloseTo(0, 6);
  });

  forEachWorld(
    "holds its height over a column with no surface",
    (world, label) => {
      // A void, or blocks that have not streamed in: the player is held rather than dropped out
      // of the world, and falls again once there is ground under them.
      const player = dropped(world, 50);
      run(player, world, 2);
      const before = dot(player.position, player.up);

      // A world with no surface at all. The distance is `-Infinity` for the same reason a
      // height-field world has no surface there: nothing for the ray to meet.
      const void_ = { ...world, getGroundDistanceAt: () => -Infinity };
      run(player, void_, 1);
      expect(dot(player.position, player.up), label).toBeCloseTo(before, 4);
      expect(player.onGround, label).toBe(true);
    },
  );
});

describe("jumping", () => {
  forEachWorld("leaves the ground and comes back down", (world, label) => {
    const player = dropped(world, 5);
    run(player, world, 1);
    expect(player.onGround, label).toBe(true);

    const resting = dot(player.position, player.up);
    updatePlayer(player, STEP, input({ jump: true }), world);
    expect(dot(player.velocity, player.up), label).toBeGreaterThan(0);

    const peak = dot(run(player, world, 0.2).position, player.up);
    expect(peak, label).toBeGreaterThan(resting + 1);

    run(player, world, 3);
    expect(player.onGround, label).toBe(true);
    expect(dot(player.velocity, player.up), label).toBeCloseTo(0, 6);
  });
});

describe("walking", () => {
  forEachWorld("moves along its heading and not sideways", (world, label) => {
    const player = dropped(world, 5);
    const start = player.position;
    // **The frame the walk starts in, not the one it ends in.** On a sphere the tangent frame
    // rotates under the player as they walk — by a fifth of a degree over a second at this
    // radius — and measuring the path against the *final* frame reports that curvature as
    // sideways drift, which is not sideways drift. The walk is a straight line in the frame it
    // began in, and that is what a world-axis frame would break.
    const heading0 = headingOf(player);
    const right0 = player.right;
    run(player, world, 1, input({ moveY: 1 }));

    const moved = sub(player.position, start);
    const sideways = dot(moved, right0);
    const rose = dot(moved, player.up);

    // **Sideways is the assertion that matters.** On a tilted frame a physics still adding
    // world-x and world-z velocity would carry the player visibly sideways as well as forwards,
    // and only this catches it.
    expect(Math.abs(sideways), label).toBeLessThan(1e-3);
    expect(dot(moved, heading0), label).toBeGreaterThan(10);

    // **And the rise is the sagitta of a great circle, which is the other half.**
    //
    // A straight walk along a sphere follows a great circle, and the chord across an arc of
    // length `s` falls `R(1 − cos(s/R))` below the tangent plane at the start — so the player
    // ends up that much further "up" than a flat world would have them, however carefully the
    // frame is carried. An earlier version of this test asserted the walk stayed in the initial
    // tangent plane, which is not a thing a sphere allows.
    //
    // Asserting the sagitta instead makes this a check that the frame **is** following the
    // ground: a frame that had not followed would leave the player flying off tangent to the
    // start and never landing at all, and a physics still treating up as a constant would leave
    // them at the ground's height while walking straight over the curve.
    const arc = dot(moved, heading0);
    const sagitta = RADIUS * (1 - Math.cos(arc / RADIUS));
    if (world.frame.spherical) {
      expect(rose, label).toBeGreaterThan(0.5 * sagitta);
      expect(rose, label).toBeLessThan(2 * sagitta);
    } else {
      // A flat world has no curve to fall below, so the walk rises by nothing at all — which is
      // the whole of what the flat case can say about this.
      expect(rose, label).toBeCloseTo(0, 6);
      expect(sagitta, label).toBeGreaterThan(0);
    }
  });

  forEachWorld(
    "strafes along its right axis and not forward",
    (world, label) => {
      const player = dropped(world, 5);
      const start = player.position;
      run(player, world, 1, input({ moveX: 1 }));

      const moved = sub(player.position, start);
      // **Along `+right`, which on a flat world is world `-X`.** The old assertion was
      // `position.x < -10`, which reads the world axis; this reads the frame, and on the flat world
      // it comes out the same number for the same reason it always did.
      expect(dot(moved, player.right), label).toBeGreaterThan(10);
      expect(dot(moved, headingOf(player)), label).toBeLessThan(1e-3);
    },
  );

  forEachWorld("stops flush against a wall", (world, label) => {
    // A wall 40 units ahead **along the player's own heading**, which on a tilted frame is not
    // 40 units of world `z`.
    const heading = headingOf(playerAt(world));
    // **Forty units of rise, forty units in.** `withWallAhead`'s two numbers are how far the
    // surface rises and how far ahead it starts rising; a rise within `stepHeight` is a step the
    // player climbs rather than a wall, and the two cases below are distinguished only by which
    // of those two numbers is inside it.
    const withWall = withWallAhead(world, 40, heading, 40);
    const player = dropped(world, 5);
    run(player, withWall, 2, input({ moveY: 1 }));

    // The collision box is narrow, so the player stops a collision radius short of the wall
    // rather than inside it.
    const along = dot(sub(player.position, ORIGIN_SURFACE), heading);
    expect(along, label).toBeLessThanOrEqual(40);
    expect(along, label).toBeGreaterThan(30);
  });
});

describe("stepping up", () => {
  forEachWorld("climbs a step within stepHeight", (world, label) => {
    const heading = headingOf(playerAt(world));
    const stepped = withWallAhead(world, 20, heading, 10);
    const player = dropped(world, 5);
    run(player, stepped, 2, input({ moveY: 1 }));

    const along = dot(sub(player.position, ORIGIN_SURFACE), heading);
    expect(along, label).toBeGreaterThan(20);
    expect(player.onGround, label).toBe(true);
    // Standing on the step rather than against it.
    expect(Math.abs(aboveSurface(player, stepped)), label).toBeLessThan(0.05);
    // **And the step really did lift them**: probing from fifteen units below their centre — which
    // is the ground they started on, a step-height below their feet plus a half-size of body —
    // finds the surface ten units further out. Read through the frame, so it is the same
    // statement on a tilted world; a `position.y` here would be measuring which way the planet
    // happens to be pointing.
    const probe = add3(player.position, player.up, -3 * player.config.halfSize);
    expect(stepped.getGroundDistanceAt(probe, player.up), label).toBeCloseTo(
      10,
      1,
    );
  });
});

describe("look", () => {
  forEachWorld(
    "turns about its own up and clamps its pitch",
    (world, label) => {
      const player = dropped(world, 5);
      const before = headingOf(player);
      run(player, world, 0.1, input({ lookDx: 100, lookDy: -1e6 }));

      const after = headingOf(player);
      const turned = length(sub(after, before));
      expect(turned, label).toBeGreaterThan(0.1);

      // **Pitch clamped against the local up**, so the angle off the tangent plane is `maxPitch`
      // wherever the player is standing. Measured as the forward's up component, which is what
      // `maxPitch` means and the only reading that survives a tilted frame.
      expect(dot(player.forward, player.up), label).toBeCloseTo(
        Math.sin(player.config.maxPitch),
        3,
      );
      // The frame survived a clamp still orthonormal, which is what keeps the collision box a box.
      expect(length(player.up), label).toBeCloseTo(1, 6);
      expect(length(player.right), label).toBeCloseTo(1, 6);
      expect(length(player.forward), label).toBeCloseTo(1, 6);
      expect(dot(player.right, player.up), label).toBeCloseTo(0, 6);
    },
  );
});

describe("the camera", () => {
  forEachWorld(
    "sits at the eye looking along the forward axis, with the player's up",
    (world, label) => {
      const player = dropped(world, 20);
      const seen = {
        position: vec3(0, 0, 0),
        up: vec3(0, 0, 0),
        look: vec3(0, 0, 0),
      };
      const camera = {
        position: {
          set: (x: number, y: number, z: number) => {
            seen.position = vec3(x, y, z);
          },
        },
        up: {
          set: (x: number, y: number, z: number) => {
            seen.up = vec3(x, y, z);
          },
        },
        lookAt: (x: number, y: number, z: number) => {
          seen.look = vec3(x, y, z);
        },
      };
      placeCamera(camera, player, true);

      // **The camera's up is the player's up.** A renderer's `lookAt` reads the up from the
      // object rather than taking it as an argument, so a camera left with the up it was built
      // with shows a planet's landscape rolled by wherever on the planet the player is standing.
      expect(seen.up, label).toEqual(player.up);
      expect(seen.position, label).toEqual(playerEye(player));
      const dir = sub(seen.look, seen.position);
      const l = length(dir);
      expect(l, label).toBeCloseTo(1, 9);
      expect(dot(scale(dir, 1 / l), player.forward), label).toBeCloseTo(1, 9);
    },
  );
});

describe("a player dropped on a sphere keeps standing up", () => {
  it("stands on the surface at four points round the planet", () => {
    // The same assertion at four places on one body, which is the thing a world-axis frame
    // cannot do: at the first the up is a world axis, at the last it is the negative of one,
    // and in between it is neither.
    const centre = vec3(0, 0, 0);
    const world = sphereSurface(centre);
    for (const direction of [
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
      vec3(-0.577, -0.577, -0.577),
    ]) {
      const n = (() => {
        const l = length(direction);
        return scale(direction, 1 / l);
      })();
      const start = scale(n, RADIUS + 50);
      const player = createPlayer(start, {}, world.frame);
      run(player, world, 3);

      expect(dot(player.up, n), JSON.stringify(direction)).toBeCloseTo(1, 6);
      expect(player.onGround, JSON.stringify(direction)).toBe(true);
      expect(
        length(sub(player.position, scale(n, RADIUS + player.config.halfSize))),
        JSON.stringify(direction),
      ).toBeLessThan(0.5);
    }
  });
});

/** A player built at the world's surface, for reading a frame without running any physics. */
const playerAt = (world: PlayerWorld): Player =>
  createPlayer(ORIGIN_SURFACE, {}, world.frame);

/**
 * The same world with a step or wall `at` units along `heading`.
 *
 * **A surface height as a function of the world point, projected onto `heading`.** For a flat
 * world that is a plane perpendicular to the heading, which is a wall; for a spherical one it is
 * a band of the sphere's surface, which is a ridge. Both are the thing the test needs: something
 * ahead of the player at a known distance.
 */
const withWallAhead = (
  world: PlayerWorld,
  at: number,
  heading: Vec3,
  height = 0,
): PlayerWorld => {
  if (!world.frame.spherical) {
    return flatSurface((x, z) => {
      const alongPoint =
        (x - ORIGIN_SURFACE.x) * heading.x + (z - ORIGIN_SURFACE.z) * heading.z;
      return alongPoint > at ? height : 0;
    });
  }
  return sphereSurface(world.centre as Vec3, (d) =>
    dot(d, heading) * RADIUS > at ? height : 0,
  );
};
