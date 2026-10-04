/**
 * Player movement over the computed field.
 *
 * Ported from `big-mesh-studios`'s voxel player, with the world it samples
 * narrowed to four questions and the position kept as a plain `Vec3` rather
 * than a renderer type. That is the same trade the CSG makes: the physics is
 * arithmetic over a sampler, so it can be tested without a browser and without
 * a graphics context, and the thing that draws it is a separate layer.
 *
 * The sampler is the field. `getSolidAt` is `distance < 0`, `getGroundDistanceAt`
 * is a trace of the same function the mesher reads — so the ground the player
 * stands on and the ground drawn on screen are the same surface by construction,
 * which is ADR 0009's invariant applied to collision.
 *
 * Everything here is per-second arithmetic stepped by `updatePlayer`, which the
 * engine calls once a frame with the frame's own `dt`.
 *
 * ## Up is a frame, not a constant
 *
 * **This file used to say "down is `-Y`" in about thirty places.** Gravity subtracted from a
 * `vy`, the collision box was an AABB on world axes, the ground under the player was a *height*,
 * the footprint was an x/z disc and "horizontally" meant the x/z plane. Every one of those is
 * false for a world where up varies with position, and all of them now read the `Frame` the
 * world supplies instead:
 *
 * - The player carries a **basis** — `forward`, `right`, `up` — rather than `yaw` and `pitch`.
 *   A yaw/pitch pair is a spherical parameterisation whose pole is a particular world axis, and
 *   on a planet that axis is somewhere different at every point.
 * - Velocity is a **`Vec3`**, and the three numbers the movement code actually reasons about —
 *   "how fast along the ground", "how fast along the right", "how fast up" — are read and
 *   written as *components* of it. Every behaviour the old scalars had, including the ramps and
 *   the floor on a jump's velocity, is expressed on one of those components, so the arithmetic is
 *   the same arithmetic.
 * - The ground under the player is a **distance along the local up**, not a height. "The column
 *   at `(x, z)`" stops being a thing.
 * - The collision box is **oriented to the basis**, and its footprint is a disc in the tangent
 *   plane rather than a rectangle on two world axes.
 *
 * ## The one thing that did not change
 *
 * **`Medium` is untouched, and deliberately.** `pushVx` and `pushVz` read like world-axis
 * components and are not: `places/demo/conveyor.ts` sets `pushVz: 60` and the comment says it is
 * "exactly a walking player's own speed", which is a statement about the *player's* heading. The
 * triple has always been relative to whoever is standing in it, and it was only ever written in
 * world axes because the player's frame used to be the world axes. Turning the frame local makes
 * the existing arithmetic correct rather than changing it. Making the payload a real world-space
 * vector is a wire-format break for every published place, and it belongs with the rest of that
 * change rather than hiding inside this one.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import {
  add,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from "@big-mesh-studios/core";

import { VOXEL_SIZE } from "../constants";
import {
  basisAt,
  basisFrom,
  carryBasis,
  elevationOf,
  flatFrame,
  northOf,
  turn,
  type BodyBasis,
  type Frame,
} from "../world/up";

import type { InputSnapshot } from "./input";

export interface Player {
  /** Cube centre, in world units. */
  position: Vec3;
  /**
   * The orthonormal frame the player is standing in.
   *
   * **Three vectors rather than `yaw` and `pitch`, because a yaw/pitch pair is tied to a world
   * axis.** `up` tracks the surface; `forward` is where they look; `right` is derived as
   * `forward × up`. They are re-derived from each other whenever one of them moves, so they are
   * orthonormal by construction rather than by being kept so.
   */
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** Velocity in world units per second, ramped toward the input's target each frame. */
  velocity: Vec3;
  onGround: boolean;
  /**
   * Whether the player is flying: gravity is off, and forward/back follows the
   * full look direction, so looking up and holding forward climbs.
   */
  flying: boolean;
  /**
   * Whether the player is no-clip: flight control, but solids are passed through
   * rather than collided with.
   */
  noclip: boolean;
  /** This player's own copy of the movement settings. */
  config: PlayerConfig;
}

/** The world as the player's physics sees it: three samplers, a frame and a boundary. */
export interface PlayerWorld {
  /**
   * Which way is up, and where the body's centre is.
   *
   * **On the world rather than the player, because it is a property of the ground and not of
   * whoever is standing on it.** Two players on one world share it, which is also what makes it
   * testable: a test can hand the physics a spherical frame and get a planet out of it.
   */
  frame: Frame;
  /**
   * The surface to stand on below `feet`, as a distance **along `up`**: positive when the
   * surface is above the feet, negative when it is below, and `-Infinity` where that ray meets
   * no solid at all.
   *
   * A distance along a ray rather than a height, because "the column at `(x, z)`" is not a thing
   * on a world whose ground is not level. Called with the player's feet, so a positive reading
   * means the feet are in or below a step's top, and the caller clamps it to `stepHeight` to
   * tell a step from a wall.
   */
  getGroundDistanceAt: (feet: Vec3, up: Vec3) => number;
  /** Whether a point is inside water; asked at the player's feet. */
  getInWaterAt: (p: Vec3) => boolean;
  /** Whether a point blocks movement; water doesn't. */
  getSolidAt: (p: Vec3) => boolean;
  /** Half the playable extent, in world units; movement clamps to it. */
  halfExtent: number;
  /**
   * The body's centre, or `undefined` for a world with none.
   *
   * **What decides how `halfExtent` is applied.** A centre means the extent is a sphere — a
   * player is kept within `halfExtent` of it — and no centre means it is the cube that
   * `getSolidAt`'s old three-number signature implied.
   */
  centre: Vec3 | undefined;
  /**
   * The velocity of the surface holding the player up at their feet, in world units per second,
   * or null where nothing moving is under them.
   */
  getSurfaceVelocityAt?: (feet: Vec3) => Vec3 | null;
  /**
   * The direction a seat is facing at the player's feet, or null where no seat stands there.
   *
   * **A direction rather than a heading angle.** A yaw is a rotation about a particular axis and
   * has no meaning where that axis is not up; this is `getSeatYawAt`'s successor, and nothing
   * implements either yet, so the change costs one declaration.
   */
  getSeatForwardAt?: (feet: Vec3) => Vec3 | null;
  /**
   * The field a script has declared at a point, or null where none sits — a box that pushes the
   * player's velocity toward a target, or a quicksand that slows and sinks them.
   */
  getMediumAt?: (p: Vec3) => Medium | null;
}

/** What a scripted field does to a player inside it, sampled once a frame. */
export interface Medium {
  /**
   * A push field's target velocity along the player's **right**, in units per second.
   *
   * **Along the player's right, not along world X**, which is what it always meant. See the file
   * header.
   */
  pushVx: number;
  /** Along the player's forward. See `pushVx`. */
  pushVz: number;
  /** Along the player's local up, or null when the field says nothing about falling. */
  pushVy: number | null;
  /** What quicksand multiplies a player's walk speed by; 1 when none. */
  speedScale: number;
  /** The fastest quicksand lets a player fall, in units per second; 0 when none. */
  sink: number;
}

export interface PlayerConfig {
  /** Player half-size, in world units. */
  halfSize: number;
  /** Movement speed, in units per second. */
  speed: number;
  /** Horizontal acceleration/deceleration, in units per second squared. */
  acceleration: number;
  /** Gravitational acceleration, in units per second squared. */
  gravity: number;
  /** Initial upward velocity on jumping, in units per second. */
  jumpSpeed: number;
  /** Upward velocity while holding jump underwater, in units per second. */
  swimSpeed: number;
  /**
   * Upward velocity while holding jump against a wall, in units per second.
   * Without it a shaft dug straight down is a trap: its walls are vertical, and
   * a step up only ever clears one voxel.
   */
  climbSpeed: number;
  /** Look sensitivity, in radians per pixel of pointer movement. */
  lookSensitivity: number;
  maxPitch: number;
  /** Chase-camera distance behind the cube centre, in world units. */
  followBack: number;
  /** Chase-camera height above the cube centre when not in first person. */
  followUp: number;
  /** Eye height above the player's feet for the first-person camera. */
  eyeHeight: number;
  /**
   * Tallest rise the player is lifted onto while walking, in world units — by
   * default one level-of-detail-0 voxel. Anything taller is a wall or an
   * overhang's underside rather than a step, and is walked into, not onto.
   */
  stepHeight: number;
  /**
   * Half-width of the box that collides with solids, in world units. Under
   * `halfSize`, so the player is narrower than the box drawn for them, which
   * keeps the first-person camera from ever being pushed inside a wall.
   */
  collisionRadius: number;
}

/**
 * The movement defaults, sized against this project's `VOXEL_SIZE` of ten world
 * units rather than the sibling project's two: the player is about one voxel
 * across, steps one voxel, and crosses the 320-unit chunk in a few seconds.
 */
export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  halfSize: 5,
  speed: 60,
  acceleration: 600,
  gravity: 180,
  jumpSpeed: 56,
  swimSpeed: 40,
  climbSpeed: 40,
  lookSensitivity: 0.005,
  maxPitch: 1.35,
  followBack: 36,
  followUp: 10,
  eyeHeight: 6,
  stepHeight: VOXEL_SIZE,
  collisionRadius: 3,
};

/**
 * A player standing at `position`, facing `heading` in the tangent plane of `frame`.
 *
 * **The frame is taken rather than assumed**, so a caller building a world on a sphere gets a
 * player who is standing up rather than one lying on their side, and the default keeps the flat
 * world working with nothing said about it.
 */
export const createPlayer = (
  position: Vec3,
  config: Partial<PlayerConfig> = {},
  frame: Frame = FLAT_FRAME,
  heading: Vec3 = vec3(0, 0, 1),
): Player => {
  const basis = basisAt(frame, position, heading);
  return {
    position,
    forward: basis.forward,
    right: basis.right,
    up: basis.up,
    velocity: vec3(0, 0, 0),
    onGround: false,
    flying: false,
    noclip: false,
    config: { ...DEFAULT_PLAYER_CONFIG, ...config },
  };
};

/**
 * The flat frame, re-exported so a caller building a player does not need a second import for
 * the one argument it almost always wants to leave at its default.
 */
export const FLAT_FRAME: Frame = flatFrame;

/** Steps `current` toward `target` by at most `maxDelta`. */
const moveTowards = (
  current: number,
  target: number,
  maxDelta: number,
): number => {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) {
    return target;
  }
  return current + Math.sign(diff) * maxDelta;
};

/** Keeps a number inside `[lo, hi]`. */
const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/** The player's three axes, as the `BodyBasis` the frame code speaks. */
const basisOf = (player: Player): BodyBasis => ({
  forward: player.forward,
  right: player.right,
  up: player.up,
});

/** Writes a basis back onto the player. */
const applyBasis = (player: Player, basis: BodyBasis): void => {
  player.forward = basis.forward;
  player.right = basis.right;
  player.up = basis.up;
};

/**
 * The player's speed along their own up, which is what every vertical number in this file used
 * to be a component of `vy`.
 */
const upSpeed = (player: Player): number => dot(player.velocity, player.up);

/**
 * Sets the player's speed along their own up, leaving the horizontal motion alone.
 *
 * Every vertical behaviour — jumping, swimming, quicksand, the climb out of a shaft, and
 * cancelling a fall on landing — is one call to this, and all of them are expressed as a
 * signed scalar along `up` exactly as they were expressed along `vy`.
 */
const setUpSpeed = (player: Player, speed: number): void => {
  const delta = speed - upSpeed(player);
  player.velocity = add(player.velocity, scale(player.up, delta));
};

/**
 * Ramps the player's ground speed toward a target in the tangent plane, leaving the up
 * component untouched.
 *
 * **Two components and a reconstruction, rather than three numbers kept alongside each other.**
 * The old code ramped `vx` and `vz` and left `vy` alone; this ramps the components along `right`
 * and the forward axis and puts the up component back afterwards. Same arithmetic, and the
 * velocity cannot drift out of the basis it was ramped in.
 */
const rampTangentSpeed = (
  player: Player,
  right: Vec3,
  north: Vec3,
  targetRight: number,
  targetNorth: number,
  maxDelta: number,
): void => {
  const currentRight = dot(player.velocity, right);
  const currentNorth = dot(player.velocity, north);
  const nextRight = moveTowards(currentRight, targetRight, maxDelta);
  const nextNorth = moveTowards(currentNorth, targetNorth, maxDelta);
  const up = upSpeed(player);
  player.velocity = add(
    add(scale(right, nextRight), scale(north, nextNorth)),
    scale(player.up, up),
  );
};

/**
 * Discards the player's fall, keeping whatever horizontal momentum they had.
 *
 * **The whole velocity is not cleared, and the distinction matters.** `/player:fly` used to set
 * `vy = 0` and nothing else, so a player who turned it on mid-sprint kept their speed and their
 * velocity ramped up from there. Zeroing all three would quietly also stop them dead, which is a
 * different command.
 */
export const clearFall = (player: Player): void => {
  setUpSpeed(player, 0);
};

/** Brings the player to a dead stop. */
export const clearVelocity = (player: Player): void => {
  player.velocity = vec3(0, 0, 0);
};

/**
 * Where the ground is sampled, as unit offsets across the collision box: the centre itself
 * plus the four sides **and the four corners**, so what holds the player up is read across the
 * same extent the box itself collides over.
 *
 * **The corners are not optional.** The box tests its eight corners against solid, and on a slope
 * the *diagonal* one is often the highest ground under the body. Sampled only at the centre and
 * the four sides, that corner is invisible to the step-up, which then lifts the player to a height
 * where the diagonal corner is still buried — so every step up a slope is refused, and a settled
 * player is blocked in every direction because the position they are already in collides.
 *
 * The offsets are symmetric in both components, so which tangent axis is which does not change
 * the set of nine points. That is why the old world-axis disc could be re-expressed this way
 * without the corners moving relative to the sides.
 */
const FOOTPRINT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * A point across the collision box from its centre, in the tangent plane.
 *
 * `a` is along `right` and `b` along the forward axis, matching the order of `CORNER_OFFSETS`.
 */
const footprintPoint = (
  centre: Vec3,
  right: Vec3,
  north: Vec3,
  reach: number,
  a: number,
  b: number,
): Vec3 => add(add(centre, scale(right, a * reach)), scale(north, b * reach));

/**
 * Samples the ground surface across a small footprint under the player instead of a single
 * point, and returns whichever candidate is closest to their feet — not simply the highest or
 * the centre one. Candidates more than a step above the feet are discarded as walls.
 *
 * **`centre` is the feet, not the body.** The reading is a distance along `up` from wherever it
 * is taken, so taking it at the body centre returns every candidate a half-size too high and the
 * snap then lifts the player a further half-size on every frame they are on the ground. The old
 * signature said so by passing `y - halfSize` as the reference height; this one says it by name,
 * which is the improvement.
 *
 * In a passage only one voxel wide the exact centre point can drift onto the wall's column
 * instead of the tunnel's own open one, and taking that reading uncritically would stand the
 * player on whatever surface the wall offers. Preferring the reading closest to where their feet
 * already are favours the floor they are walking along over a stray wall reading.
 */
const sampleGroundDistance = (
  config: PlayerConfig,
  world: PlayerWorld,
  centre: Vec3,
  right: Vec3,
  north: Vec3,
  up: Vec3,
): number => {
  let best = -Infinity;
  let bestDist = Infinity;
  for (const [a, b] of FOOTPRINT_OFFSETS) {
    const d = world.getGroundDistanceAt(
      footprintPoint(centre, right, north, config.collisionRadius, a, b),
      up,
    );
    if (!Number.isFinite(d) || d > config.stepHeight) {
      continue;
    }
    const dist = Math.abs(d);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
};

/**
 * The highest surface under the footprint that is still within a step of the feet — what the
 * player would be climbing onto here.
 *
 * Deliberately the opposite rule to `sampleGroundDistance`, which prefers the reading closest to
 * the feet: standing, the closest reading keeps a sample that strayed into a wall from lifting
 * the player up it, but a player deciding whether to step has to look at the highest thing under
 * them or they would never climb off the floor they are already standing on.
 */
const highestStandableSurface = (
  config: PlayerConfig,
  world: PlayerWorld,
  centre: Vec3,
  right: Vec3,
  north: Vec3,
  up: Vec3,
): number => {
  let best = -Infinity;
  for (const [a, b] of FOOTPRINT_OFFSETS) {
    const d = world.getGroundDistanceAt(
      footprintPoint(centre, right, north, config.collisionRadius, a, b),
      up,
    );
    if (Number.isFinite(d) && d <= config.stepHeight && d > best) {
      best = d;
    }
  }
  return best;
};

/** The corners of the player's collision box, as unit offsets in the tangent plane. */
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * How many times a blocked move is halved to find where the player touches the
 * wall. Six brings a frame of travel at full speed down to under a hundredth of
 * a unit — far below anything visible.
 */
const CONTACT_REFINEMENTS = 6;

/**
 * Keeps a sample off an exact surface boundary, in world units: standing on a
 * floor puts the player's feet precisely on one, and a rounding error either way
 * would otherwise read the floor itself as a wall the player is buried in.
 */
const SKIN = 1e-3;

/**
 * Whether the player's collision box, oriented to their basis, overlaps any solid.
 *
 * The box is exactly as tall as a voxel and narrower than one, so every voxel it overlaps
 * contains one of its own top or bottom corners — testing the eight corners is enough, with no
 * need to walk the voxels in between.
 *
 * **Oriented, because the box has to be.** On a sphere the eight corners are offset along `right`
 * and the forward axis rather than along two world axes, and a world-axis box at a pole is
 * standing on its end.
 */
const boxHitsSolid = (
  config: PlayerConfig,
  getSolidAt: (p: Vec3) => boolean,
  centre: Vec3,
  right: Vec3,
  north: Vec3,
  up: Vec3,
): boolean => {
  const inset = config.halfSize - SKIN;
  for (const [a, b] of CORNER_OFFSETS) {
    const corner = footprintPoint(
      centre,
      right,
      north,
      config.collisionRadius,
      a,
      b,
    );
    if (
      getSolidAt(add(corner, scale(up, -inset))) ||
      getSolidAt(add(corner, scale(up, inset)))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Keeps a point inside the playable world.
 *
 * **A sphere when the world has a centre and a cube when it does not**, because those are the
 * two worlds there are. The old code clamped each axis independently, which is only meaningful
 * for the cube; on a planet a per-axis clamp lets a player walk past the pole and off the far
 * side.
 */
const clampToWorld = (world: PlayerWorld, p: Vec3): Vec3 => {
  const reach = world.halfExtent;
  if (world.centre === undefined) {
    return vec3(
      clamp(p.x, -reach, reach),
      clamp(p.y, -reach, reach),
      clamp(p.z, -reach, reach),
    );
  }
  const d = sub(p, world.centre);
  const l = length(d);
  return l <= reach ? p : add(world.centre, scale(d, reach / l));
};

/**
 * Moves the player along a direction in the tangent plane, stopping dead at walls and giving a
 * blocked move one chance as a step up.
 *
 * The step-up is the old behaviour with its reasoning intact: the ground scan cannot see past
 * the voxel the feet are in, so a knee-high step and a cliff face both report a surface within
 * a step of the feet, and only re-testing the whole box at the raised height tells them apart —
 * the cliff still has material where the player's body would go, a step does not.
 *
 * The contact refinement halves in on the last position known to be clear, so the player rests
 * against the wall rather than a frame's travel short of it.
 *
 * @returns Whether a wall stopped the player, who is now up against it.
 */
const moveAlong = (
  player: Player,
  world: PlayerWorld,
  direction: Vec3,
  delta: number,
  stepUp: boolean,
): boolean => {
  if (delta === 0) return false;
  const config = player.config;
  const from = player.position;
  const right = player.right;
  const north = northOf(basisOf(player));
  const up = player.up;

  player.position = clampToWorld(world, add(from, scale(direction, delta)));
  if (
    !boxHitsSolid(config, world.getSolidAt, player.position, right, north, up)
  ) {
    return false;
  }

  if (stepUp) {
    // `standable` is measured from the feet, so the raised position is the blocked one moved
    // that far along `up`. A candidate at or below where the player already stands is not a
    // step — that is the case the block handles itself.
    const standable = highestStandableSurface(
      config,
      world,
      add(player.position, scale(up, -config.halfSize)),
      right,
      north,
      up,
    );
    const raised = add(player.position, scale(up, standable));
    if (
      Number.isFinite(standable) &&
      standable > 0 &&
      !boxHitsSolid(config, world.getSolidAt, raised, right, north, up)
    ) {
      player.position = clampToWorld(world, raised);
      return false;
    }
  }

  // Neither passable nor climbable, so give back the move — but not all of it, or the player
  // would come to rest up to a frame's travel short of the wall, further out the faster they
  // were going.
  let clear = 0;
  let blocked = 1;
  for (let i = 0; i < CONTACT_REFINEMENTS; i++) {
    const t = (clear + blocked) / 2;
    player.position = add(from, scale(direction, delta * t));
    if (
      boxHitsSolid(config, world.getSolidAt, player.position, right, north, up)
    ) {
      blocked = t;
    } else {
      clear = t;
    }
  }
  player.position = add(from, scale(direction, delta * clear));
  return true;
};

/**
 * Moves the player along one direction with collision, for walking. Distinct from
 * `moveAlong`'s step-up only in that flag, kept as a named wrapper because "may step up" and
 * "must not" read differently at the call site than `true` and `false` do.
 */
const moveAcross = (
  player: Player,
  world: PlayerWorld,
  direction: Vec3,
  delta: number,
): boolean => moveAlong(player, world, direction, delta, true);

/** Moves the player along one direction without the grounded step-up, for flight. */
const moveFree = (
  player: Player,
  world: PlayerWorld,
  direction: Vec3,
  delta: number,
): boolean => moveAlong(player, world, direction, delta, false);

/**
 * The velocity flight control settles on for `input`: forward/back along the full look
 * direction, strafe horizontal, both ramped toward the configured speed by the acceleration.
 */
const rampFlightVelocity = (
  player: Player,
  input: InputSnapshot,
  dt: number,
): void => {
  const config = player.config;
  const basis = basisOf(player);
  const right = basis.right;
  const up = basis.up;
  const north = northOf(basis);
  const look = player.forward;

  let targetRight = 0;
  let targetNorth = 0;
  let targetUp = 0;
  if (input.moveX !== 0 || input.moveY !== 0) {
    const len = Math.hypot(input.moveX, input.moveY);
    const nx = input.moveX / len;
    const ny = input.moveY / len;
    // Forward/back follows the *full* look direction, so looking up and holding forward
    // climbs; strafing stays in the tangent plane. Two scalars rather than a target vector,
    // because these are what the ramp is defined over.
    targetUp = dot(look, up) * ny * config.speed;
    targetRight = (dot(look, right) * ny + nx) * config.speed;
    targetNorth = dot(look, north) * ny * config.speed;
  }
  const maxDelta = config.acceleration * dt;
  rampTangentSpeed(player, right, north, targetRight, targetNorth, maxDelta);
  setUpSpeed(player, moveTowards(upSpeed(player), targetUp, maxDelta));
};

/**
 * The flight integrator: gravity is off, and forward/back follows the full look direction, so
 * holding forward while looking up climbs and looking down dives. Each direction is clamped
 * separately against solids, and the player never snaps to the ground.
 */
const updateFlying = (
  player: Player,
  input: InputSnapshot,
  world: PlayerWorld,
  dt: number,
): void => {
  rampFlightVelocity(player, input, dt);

  const right = player.right;
  const up = player.up;
  const north = northOf(basisOf(player));
  moveFree(player, world, right, dot(player.velocity, right) * dt);
  moveFree(player, world, up, upSpeed(player) * dt);
  moveFree(player, world, north, dot(player.velocity, north) * dt);
  player.onGround = false;
};

/**
 * The no-clip integrator: flight control with the collision step dropped, so the player passes
 * through solids. Positions move the whole frame's travel, clamped only to the world boundary.
 */
const updateNoClip = (
  player: Player,
  input: InputSnapshot,
  world: PlayerWorld,
  dt: number,
): void => {
  rampFlightVelocity(player, input, dt);
  player.position = clampToWorld(
    world,
    add(player.position, scale(player.velocity, dt)),
  );
  player.onGround = false;
};

/**
 * Turns the player's head, clamped so they cannot look along their own up.
 *
 * **The clamp is on elevation, not on a pitch number, because a pitch number is a world-axis
 * quantity.** `maxPitch` still means the same thing — the angle between the look direction and
 * the tangent plane — but it is measured against the local up, so it holds identically at a
 * planet's pole where no world axis is up at all. The clamp also means `forward` is never
 * parallel to `up`, which is what keeps `right = forward × up` from degenerating.
 */
const applyLook = (
  player: Player,
  input: InputSnapshot,
  config: PlayerConfig,
): void => {
  let basis = basisOf(player);

  const yaw = -input.lookDx * config.lookSensitivity;
  if (yaw !== 0) {
    basis = turn(basis, basis.up, yaw);
    applyBasis(player, basis);
  }

  const wanted = -input.lookDy * config.lookSensitivity;
  if (wanted === 0) return;
  // The clamp is on the elevation above the tangent plane, in both directions, so it means the
  // same thing at a planet's pole as it does on a flat field.
  const elevation = elevationOf(basis);
  const next = clamp(elevation + wanted, -config.maxPitch, config.maxPitch);
  if (next === elevation) return;
  // Positive about `right` raises the elevation, because `right = forward × up` and so
  // `right × forward` has a positive up component for any forward not along up.
  //
  // **Only `forward` moves.** `up` is the surface normal and a glance at the sky must not roll
  // it; and `right` is re-derived rather than rotated, because it is *defined* as
  // `forward × up`. An earlier version rotated all three axes, which rolled the player's idea of
  // vertical over with every pitch — so looking up left them unable to tell which way was down.
  applyBasis(player, turn(basis, basis.right, next - elevation));
};

export const updatePlayer = (
  player: Player,
  dt: number,
  input: InputSnapshot,
  world: PlayerWorld,
): void => {
  const config = player.config;

  // **The frame is re-derived from the ground before anything else uses it.**
  //
  // `createPlayer` sets `up` once and nothing has changed it since, which on a flat world is
  // indistinguishable from correct — the surface does not move. On a sphere it is not: walking
  // `s` units turns the surface normal by about `s/R`, and a frame that has not followed diverges
  // from the ground by `s²/2R` — a fifth of a unit after one second of walking at a radius of
  // 4000, growing with every step. Gravity would pull the player back down and the walk would
  // skim along the surface in a series of tiny bounces.
  //
  // `carryBasis` rather than `basisAt`, because the heading has to survive: re-deriving the frame
  // from scratch gives tangent axes with no memory of which way the player was facing, so their
  // heading would be decided by the construction rather than by them.
  applyBasis(player, carryBasis(basisOf(player), world.frame, player.position));

  applyLook(player, input, config);

  if (player.noclip) {
    updateNoClip(player, input, world, dt);
    return;
  }

  if (player.flying) {
    updateFlying(player, input, world, dt);
    return;
  }

  // Movement relative to the heading, in the tangent plane.
  let basis = basisOf(player);
  const right = basis.right;
  const north = northOf(basis);
  // The heading on the ground: the look direction with its climb taken off. Looking up while
  // walking must not slow the walk down, which is what using the full look vector here would
  // do.
  const heading = normalize(
    sub(basis.forward, scale(basis.up, dot(basis.forward, basis.up))),
  );

  // ramp ground speed toward the input's target each frame rather than snapping to it, so
  // starting and stopping isn't instantaneous
  const mx = input.moveX;
  const my = input.moveY;
  // The field standing at the player's centre, read once so the horizontal and vertical
  // branches of this frame agree on what is acting on them.
  const medium = world.getMediumAt?.(player.position) ?? null;

  let targetRight = 0;
  let targetNorth = 0;
  if (mx !== 0 || my !== 0) {
    const len = Math.hypot(mx, my);
    const nx = mx / len;
    const ny = my / len;
    targetRight = (dot(heading, right) * ny + nx) * config.speed;
    targetNorth = dot(heading, north) * ny * config.speed;
  }
  if (medium !== null) {
    if (medium.speedScale !== 1) {
      targetRight *= medium.speedScale;
      targetNorth *= medium.speedScale;
    }
    if (medium.pushVx !== 0 || medium.pushVz !== 0) {
      targetRight += medium.pushVx;
      targetNorth += medium.pushVz;
    }
  }
  const maxDelta = config.acceleration * dt;
  rampTangentSpeed(player, right, north, targetRight, targetNorth, maxDelta);
  const dRight = dot(player.velocity, right) * dt;
  const dNorth = dot(player.velocity, north) * dt;

  // gravity + jump; underwater the gravity is weak and holding jump swims up
  const feet = add(player.position, scale(player.up, -config.halfSize));
  const inWater = world.getInWaterAt(add(feet, scale(player.up, SKIN)));
  if (inWater) {
    setUpSpeed(player, upSpeed(player) - config.gravity * 0.15 * dt);
    if (input.jumpHeld) {
      setUpSpeed(player, config.swimSpeed);
    } else {
      // gentle drag so an idle player sinks slowly instead of dropping like a stone; holding
      // jump (swim) overrides it
      setUpSpeed(player, upSpeed(player) * Math.max(0, 1 - 3 * dt));
    }
  } else {
    setUpSpeed(player, upSpeed(player) - config.gravity * dt);
    if (medium !== null) {
      // An updraft or downdraft ramps the fall velocity toward the field's target the way
      // horizontal movement ramps toward its input's; a quicksand clamps how fast the player
      // may sink at all.
      if (medium.pushVy !== null) {
        setUpSpeed(
          player,
          moveTowards(upSpeed(player), medium.pushVy, maxDelta),
        );
      }
      if (medium.sink > 0) {
        setUpSpeed(player, Math.max(upSpeed(player), -medium.sink));
      }
    }
  }
  if (!inWater && player.onGround && input.jump) {
    setUpSpeed(player, config.jumpSpeed);
  }

  // one direction at a time, so a wall that stops one of them still lets the player slide
  // along it with the other
  const blockedRight = moveAcross(player, world, right, dRight);
  // The ground moved the player up during that step, so the heading is rebuilt before the
  // second move: the basis tracks the surface, and a move taken in a stale frame would be in a
  // tangent plane the player is no longer in.
  basis = basisOf(player);
  const blockedNorth = moveAcross(player, world, northOf(basis), dNorth);
  const stoppedByWall = blockedRight || blockedNorth;

  // A platform the player was standing on last frame carries them: its velocity for this frame
  // is added, so they ride it rather than slide off the back.
  if (player.onGround && world.getSurfaceVelocityAt !== undefined) {
    const support = world.getSurfaceVelocityAt(feet);
    if (support !== null) {
      player.position = add(player.position, scale(support, dt));
    }
  }

  // A seat turns its rider to the seat's own facing.
  if (player.onGround && world.getSeatForwardAt !== undefined) {
    const seat = world.getSeatForwardAt(feet);
    if (seat !== null) {
      applyBasis(player, basisFrom(player.up, seat));
    }
  }

  // Holding jump while walking into a wall climbs it, which is how a player gets back out of a
  // shaft they dug straight down. Never lower than the velocity already there, so climbing
  // away from a jump does not cut it short.
  if (stoppedByWall && input.jumpHeld && !inWater) {
    setUpSpeed(player, Math.max(upSpeed(player), config.climbSpeed));
  }

  // The distance the ground is judged from is the one the player enters this frame's fall at
  // (after any step up), not where the fall ends: scanning down from there catches every surface
  // crossed on the way, so a fast fall lands on the floor it passed through instead of the next
  // one below it.
  basis = basisOf(player);
  // Captured before the fall, because the void branch below has to put the player back where
  // they entered this frame rather than a half-size lower — the feet, not the body.
  const entered = player.position;
  const enteredFeet = add(entered, scale(basis.up, -config.halfSize));
  const travelledUp = upSpeed(player) * dt;
  const risen = add(entered, scale(basis.up, travelledUp));
  if (
    upSpeed(player) > 0 &&
    boxHitsSolid(
      config,
      world.getSolidAt,
      risen,
      basis.right,
      northOf(basis),
      basis.up,
    )
  ) {
    // head against a ceiling — drop the climb rather than pushing into it
    setUpSpeed(player, 0);
  } else {
    player.position = risen;
  }

  // snap to the terrain surface
  basis = basisOf(player);
  const standable = sampleGroundDistance(
    config,
    world,
    enteredFeet,
    basis.right,
    northOf(basis),
    basis.up,
  );
  if (!Number.isFinite(standable)) {
    // No surface anywhere under the footprint: the player is over a hole clear through the
    // world, or over blocks that have not streamed in yet. Rather than drop them out of the
    // world, hold the height they came in at; they resume falling as soon as there's ground.
    // **`entered`, not `feetBefore`** — the feet are a half-size below the body, and restoring
    // them would sink the player a little further every frame they stood over nothing.
    player.position = entered;
    setUpSpeed(player, 0);
    player.onGround = true;
    return;
  }
  // **The player is on the ground when their feet are at or below the surface**, which is a
  // comparison of two positions and not a sign test on `standable`.
  //
  // That distinction is the whole fix, and getting it wrong means nobody ever lands. The trace
  // steps by the distance to the surface and stops the moment the field reads solid, so it
  // finishes a hair *past* the surface and `standable` is a small negative number for a player
  // standing exactly on the ground. Testing `standable >= 0` therefore reports a player walking
  // along a surface as airborne every frame — which is what happened the first time.
  const surface = add(enteredFeet, scale(basis.up, standable));
  if (travelledUp <= standable) {
    player.position = add(surface, scale(basis.up, config.halfSize));
    if (upSpeed(player) < 0) {
      setUpSpeed(player, 0);
    }
    player.onGround = true;
  } else {
    player.onGround = false;
  }
};

/** The look direction of the player's view, as a unit vector. */
export const lookDirection = (player: Player): Vec3 => player.forward;

/**
 * The point the player's view radiates from: the eye, `eyeHeight` above the cube's centre along
 * their own up. Every reach the player has — a block they dig, a surface they place on — is
 * measured from here, so it stays the eye whichever view the camera is drawing.
 */
export const playerEye = (player: Player): Vec3 =>
  add(player.position, scale(player.up, player.config.eyeHeight));

/** The camera contract `placeCamera` needs, so physics carries no renderer type. */
export interface Camera3D {
  position: { set(x: number, y: number, z: number): void };
  /**
   * The camera's own up, which a world whose up varies needs.
   *
   * **Set every frame, before `lookAt`.** A renderer's `lookAt` takes its up from the object
   * rather than as an argument, so a camera left with the up it was constructed with is looking
   * at a planet's landscape from the wrong orientation — which on a sphere means rolled by
   * wherever on the planet the player is standing.
   */
  up: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
}

/**
 * Places the camera. In first person (the default) it sits at the player's eye looking along
 * their forward, so the crosshair lines up with where the player aims — and where an edit picks.
 * In third person it hovers behind and above the cube, looking at it; where the camera stands
 * does not move what the player can reach, which is measured from their eye either way.
 *
 * **The camera's up is the player's up in both cases**, and the third-person offsets are along
 * the player's own axes — `followUp` is their up and `followBack` is behind their heading, not
 * the world's.
 */
export const placeCamera = (
  camera: Camera3D,
  player: Player,
  firstPerson: boolean = true,
): void => {
  const config = player.config;
  const basis = basisOf(player);
  if (firstPerson) {
    const eye = playerEye(player);
    camera.up.set(basis.up.x, basis.up.y, basis.up.z);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(
      eye.x + basis.forward.x,
      eye.y + basis.forward.y,
      eye.z + basis.forward.z,
    );
    return;
  }
  const heading = normalize(
    sub(basis.forward, scale(basis.up, dot(basis.forward, basis.up))),
  );
  camera.up.set(basis.up.x, basis.up.y, basis.up.z);
  camera.position.set(
    player.position.x -
      heading.x * config.followBack +
      basis.up.x * config.followUp,
    player.position.y -
      heading.y * config.followBack +
      basis.up.y * config.followUp,
    player.position.z -
      heading.z * config.followBack +
      basis.up.z * config.followUp,
  );
  // The look point lifts along `up` by how far the player is looking off the horizon, so
  // vertical drag still tilts the view. A projection of the look direction rather than a
  // `sin(pitch)` constant, because there is no pitch angle to take a sine of any more.
  const elevation = dot(basis.forward, basis.up);
  const look = add(
    player.position,
    scale(basis.up, elevation * config.followBack),
  );
  camera.lookAt(look.x, look.y, look.z);
};
