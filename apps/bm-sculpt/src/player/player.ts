/**
 * Player movement over the computed field.
 *
 * Ported from `big-mesh-studios`'s voxel player, with the world it samples
 * narrowed to four questions and the position kept as a plain `Vec3` rather
 * than a renderer type. That is the same trade the CSG makes: the physics is
 * arithmetic over a sampler, so it can be tested without a browser and without
 * a graphics context, and the thing that draws it is a separate layer.
 *
 * The sampler is the field. `getSolidAt` is `distance < 0`, `getGroundHeightAt`
 * is a downward trace of the same function the mesher reads — so the ground the
 * player stands on and the ground drawn on screen are the same surface by
 * construction, which is ADR 0009's invariant applied to collision.
 *
 * Everything here is per-second arithmetic stepped by `updatePlayer`, which the
 * engine calls once a frame with the frame's own `dt`.
 */

import type { Vec3 } from "@big-mesh-studios/core";

import { VOXEL_SIZE } from "../constants";

import type { InputSnapshot } from "./input";

export interface Player {
  /** Cube centre, in world units. */
  position: Vec3;
  /** Heading, in radians; 0 faces +Z. */
  yaw: number;
  pitch: number;
  /** Horizontal velocity, in world units per second, ramped toward the input's target each frame. */
  vx: number;
  vz: number;
  vy: number;
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

/** The world as the player's physics sees it: three samplers and a boundary. */
export interface PlayerWorld {
  /**
   * The surface to stand on at (`x`, `z`) nearest `y`, in world units, or
   * `-Infinity` where that column has no solid at all. Called with the player's
   * feet, so a reading above them is the top of the material their feet are
   * already inside — and the caller clamps it to `stepHeight` to tell a step
   * from a wall.
   */
  getGroundHeightAt: (x: number, y: number, z: number) => number;
  /** Whether (`x`, `y`, `z`) is inside water; asked at the player's feet. */
  getInWaterAt: (x: number, y: number, z: number) => boolean;
  /** Whether the point (`x`, `y`, `z`) blocks movement; water doesn't. */
  getSolidAt: (x: number, y: number, z: number) => boolean;
  /** Half the playable extent, in world units; horizontal movement clamps to it. */
  halfExtent: number;
  /**
   * The velocity of the surface holding the player up at (`x`, `feetY`, `z`),
   * in world units per second, or null where nothing moving is under them.
   */
  getSurfaceVelocityAt?: (
    x: number,
    y: number,
    z: number,
  ) => [number, number, number] | null;
  /**
   * The heading of the seat holding the player up at (`x`, `feetY`, `z`), or
   * null where no seat stands there.
   */
  getSeatYawAt?: (x: number, y: number, z: number) => number | null;
  /**
   * The field a script has declared at (`x`, `y`, `z`), or null where none
   * sits — a box that pushes the player's velocity toward a target, or a
   * quicksand that slows and sinks them.
   */
  getMediumAt?: (x: number, y: number, z: number) => Medium | null;
}

/** What a scripted field does to a player inside it, sampled once a frame. */
export interface Medium {
  /** A push field's horizontal target-velocity pull, in units per second. */
  pushVx: number;
  pushVz: number;
  /** A push field's vertical target-velocity pull (up positive), or null when none. */
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

export const createPlayer = (
  x: number,
  y: number,
  z: number,
  config: Partial<PlayerConfig> = {},
): Player => ({
  position: { x, y, z },
  yaw: 0,
  pitch: 0,
  vx: 0,
  vz: 0,
  vy: 0,
  onGround: false,
  flying: false,
  noclip: false,
  config: { ...DEFAULT_PLAYER_CONFIG, ...config },
});

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

/**
 * Where the ground is sampled, as unit offsets from the player's centre: the
 * centre itself plus the four sides **and the four corners** of the collision
 * box, so what holds them up is read across the same x/z extent the box itself
 * collides over.
 *
 * The corners are not optional. The box tests its eight corners against solid,
 * and on a slope the *diagonal* one is often the highest ground under the body.
 * Sampled only at the centre and the four sides, that corner is invisible to the
 * step-up, which then lifts the player to a height where the diagonal corner is
 * still buried — so every step up a slope is refused, and a settled player is
 * blocked in every direction because the position they are already in collides.
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
 * Samples the ground surface across a small footprint under the player instead
 * of a single point, and returns whichever candidate is closest to their feet —
 * not simply the highest or the centre one. Candidates more than a step above
 * the feet are discarded as walls.
 *
 * In a passage only one voxel wide the exact centre point can drift onto the
 * wall's column instead of the tunnel's own open one, and taking that reading
 * uncritically would stand the player on whatever surface the wall offers.
 * Preferring the reading closest to where their feet already are favors the
 * floor they are walking along over a stray wall reading.
 */
const sampleGroundHeight = (
  config: PlayerConfig,
  getGroundHeightAt: (x: number, y: number, z: number) => number,
  x: number,
  feetY: number,
  z: number,
): number => {
  const highestStandable = feetY + config.stepHeight;
  let best = -Infinity;
  let bestDist = Infinity;
  for (const [ox, oz] of FOOTPRINT_OFFSETS) {
    const h = getGroundHeightAt(
      x + ox * config.collisionRadius,
      feetY,
      z + oz * config.collisionRadius,
    );
    if (!Number.isFinite(h) || h > highestStandable) {
      continue;
    }
    const dist = Math.abs(h - feetY);
    if (dist < bestDist) {
      bestDist = dist;
      best = h;
    }
  }
  return best;
};

/**
 * The highest surface under the footprint at (`x`, `z`) that is still within a
 * step of `feetY` — what the player would be climbing onto here.
 *
 * Deliberately the opposite rule to `sampleGroundHeight`, which prefers the
 * reading closest to the feet: standing, the closest reading keeps a sample
 * that strayed into a wall from lifting the player up it, but a player deciding
 * whether to step has to look at the highest thing under them or they would
 * never climb off the floor they are already standing on.
 */
const highestStandableSurface = (
  config: PlayerConfig,
  getGroundHeightAt: (x: number, y: number, z: number) => number,
  x: number,
  feetY: number,
  z: number,
): number => {
  const limit = feetY + config.stepHeight;
  let best = -Infinity;
  for (const [ox, oz] of FOOTPRINT_OFFSETS) {
    const h = getGroundHeightAt(
      x + ox * config.collisionRadius,
      feetY,
      z + oz * config.collisionRadius,
    );
    if (Number.isFinite(h) && h <= limit && h > best) {
      best = h;
    }
  }
  return best;
};

/** Horizontal corners of the player's collision box, as unit offsets. */
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
 * Whether the player's collision box, centred at (`x`, `y`, `z`), overlaps any
 * solid.
 *
 * The box is exactly as tall as a voxel and narrower than one, so every voxel it
 * overlaps contains one of its own top or bottom corners — testing the eight
 * corners is enough, with no need to walk the voxels in between.
 */
const boxHitsSolid = (
  config: PlayerConfig,
  getSolidAt: (x: number, y: number, z: number) => boolean,
  x: number,
  y: number,
  z: number,
): boolean => {
  const low = y - config.halfSize + SKIN;
  const high = y + config.halfSize - SKIN;
  for (const [ox, oz] of CORNER_OFFSETS) {
    const cx = x + ox * config.collisionRadius;
    const cz = z + oz * config.collisionRadius;
    if (getSolidAt(cx, low, cz) || getSolidAt(cx, high, cz)) {
      return true;
    }
  }
  return false;
};

/**
 * Moves the player along one horizontal axis, stopping dead at walls.
 *
 * A blocked move gets one more chance as a step up: the ground scan cannot see
 * past the voxel the feet are in, so a knee-high step and a cliff face both
 * report a surface within a step of the feet, and only re-testing the whole box
 * at the raised height tells them apart — the cliff still has material where the
 * player's body would go, a step doesn't.
 *
 * @returns Whether a wall stopped the player, who is now up against it.
 */
const moveHorizontally = (
  player: Player,
  world: PlayerWorld,
  axis: "x" | "z",
  delta: number,
): boolean => {
  if (delta === 0) {
    return false;
  }
  const config = player.config;
  const from = player.position[axis];
  player.position[axis] = Math.max(
    -world.halfExtent,
    Math.min(world.halfExtent, from + delta),
  );
  const { x, y, z } = player.position;
  if (!boxHitsSolid(config, world.getSolidAt, x, y, z)) {
    return false;
  }
  const surface = highestStandableSurface(
    config,
    world.getGroundHeightAt,
    x,
    y - config.halfSize,
    z,
  );
  const stepped = surface + config.halfSize;
  if (
    Number.isFinite(surface) &&
    stepped > y &&
    !boxHitsSolid(config, world.getSolidAt, x, stepped, z)
  ) {
    player.position.y = stepped;
    return false;
  }
  // Neither passable nor climbable, so give back the move — but not all of it,
  // or the player would come to rest up to a frame's travel short of the wall,
  // further out the faster they were going. Halving in on the last position
  // known to be clear puts them against it instead.
  let clear = from;
  let blocked = player.position[axis];
  for (let i = 0; i < CONTACT_REFINEMENTS; i++) {
    const mid = (clear + blocked) / 2;
    player.position[axis] = mid;
    if (
      boxHitsSolid(
        config,
        world.getSolidAt,
        player.position.x,
        y,
        player.position.z,
      )
    ) {
      blocked = mid;
    } else {
      clear = mid;
    }
  }
  player.position[axis] = clear;
  return true;
};

/**
 * Moves the player one axis, stopping flush against solids, without the
 * grounded step-up behaviour of `moveHorizontally`. Used for all three axes
 * while flying, where a surface a step up is a wall to be flown around, not a
 * ledge to climb.
 */
const moveAxis = (
  player: Player,
  world: PlayerWorld,
  axis: "x" | "y" | "z",
  delta: number,
): boolean => {
  if (delta === 0) {
    return false;
  }
  const config = player.config;
  const from = player.position[axis];
  player.position[axis] = Math.max(
    -world.halfExtent,
    Math.min(world.halfExtent, from + delta),
  );
  if (
    !boxHitsSolid(
      config,
      world.getSolidAt,
      player.position.x,
      player.position.y,
      player.position.z,
    )
  ) {
    return false;
  }
  // Half the move back toward the last clear position, so the player rests
  // against the voxel rather than a frame's travel short of it.
  let clear = from;
  let blocked = player.position[axis];
  for (let i = 0; i < CONTACT_REFINEMENTS; i++) {
    const mid = (clear + blocked) / 2;
    player.position[axis] = mid;
    if (
      boxHitsSolid(
        config,
        world.getSolidAt,
        player.position.x,
        player.position.y,
        player.position.z,
      )
    ) {
      blocked = mid;
    } else {
      clear = mid;
    }
  }
  player.position[axis] = clear;
  return true;
};

/**
 * The velocity flight control settles on for `input`: forward/back along the
 * full look direction, strafe horizontal, both ramped toward the configured
 * speed by the acceleration.
 */
const rampFlightVelocity = (
  player: Player,
  input: InputSnapshot,
  dt: number,
): void => {
  const config = player.config;
  const [dirX, dirY, dirZ] = lookDirection(player);
  const rightX = -Math.cos(player.yaw);
  const rightZ = Math.sin(player.yaw);
  let targetVx = 0;
  let targetVy = 0;
  let targetVz = 0;
  if (input.moveX !== 0 || input.moveY !== 0) {
    const len = Math.hypot(input.moveX, input.moveY);
    const nx = input.moveX / len;
    const ny = input.moveY / len;
    targetVx = (dirX * ny + rightX * nx) * config.speed;
    targetVy = dirY * ny * config.speed;
    targetVz = (dirZ * ny + rightZ * nx) * config.speed;
  }
  const maxDelta = config.acceleration * dt;
  player.vx = moveTowards(player.vx, targetVx, maxDelta);
  player.vy = moveTowards(player.vy, targetVy, maxDelta);
  player.vz = moveTowards(player.vz, targetVz, maxDelta);
};

/**
 * The flight integrator: gravity is off, and forward/back follows the full look
 * direction, so holding forward while looking up climbs and looking down dives;
 * strafing stays horizontal. Each axis is clamped separately against solids, and
 * the player never snaps to the ground.
 */
const updateFlying = (
  player: Player,
  input: InputSnapshot,
  world: PlayerWorld,
  dt: number,
): void => {
  rampFlightVelocity(player, input, dt);

  moveAxis(player, world, "x", player.vx * dt);
  moveAxis(player, world, "y", player.vy * dt);
  moveAxis(player, world, "z", player.vz * dt);
  player.onGround = false;
};

/**
 * The no-clip integrator: flight control with the collision step dropped, so the
 * player passes through solids. Positions move the whole frame's travel,
 * clamped only to the world boundary.
 */
const updateNoClip = (
  player: Player,
  input: InputSnapshot,
  world: PlayerWorld,
  dt: number,
): void => {
  rampFlightVelocity(player, input, dt);
  player.position.x = Math.max(
    -world.halfExtent,
    Math.min(world.halfExtent, player.position.x + player.vx * dt),
  );
  player.position.y = Math.max(
    -world.halfExtent,
    Math.min(world.halfExtent, player.position.y + player.vy * dt),
  );
  player.position.z = Math.max(
    -world.halfExtent,
    Math.min(world.halfExtent, player.position.z + player.vz * dt),
  );
  player.onGround = false;
};

export const updatePlayer = (
  player: Player,
  dt: number,
  input: InputSnapshot,
  world: PlayerWorld,
): void => {
  const config = player.config;
  // drag-to-look
  player.yaw -= input.lookDx * config.lookSensitivity;
  player.pitch = Math.max(
    -config.maxPitch,
    Math.min(
      config.maxPitch,
      player.pitch - input.lookDy * config.lookSensitivity,
    ),
  );

  if (player.noclip) {
    updateNoClip(player, input, world, dt);
    return;
  }

  if (player.flying) {
    updateFlying(player, input, world, dt);
    return;
  }

  // movement relative to the heading
  const sinYaw = Math.sin(player.yaw);
  const cosYaw = Math.cos(player.yaw);
  const forwardX = sinYaw;
  const forwardZ = cosYaw;
  // screen-right = cross(forward, up)
  const rightX = -cosYaw;
  const rightZ = sinYaw;

  // ramp horizontal velocity toward the input's target speed each frame rather
  // than snapping to it, so starting and stopping isn't instantaneous
  const mx = input.moveX;
  const my = input.moveY;
  // The field standing at the player's centre, read once so the horizontal and
  // vertical branches of this frame agree on what is acting on them.
  const medium =
    world.getMediumAt?.(
      player.position.x,
      player.position.y,
      player.position.z,
    ) ?? null;
  let targetVx = 0;
  let targetVz = 0;
  if (mx !== 0 || my !== 0) {
    const len = Math.hypot(mx, my);
    const nx = mx / len;
    const ny = my / len;
    targetVx = (forwardX * ny + rightX * nx) * config.speed;
    targetVz = (forwardZ * ny + rightZ * nx) * config.speed;
  }
  if (medium !== null) {
    if (medium.speedScale !== 1) {
      targetVx *= medium.speedScale;
      targetVz *= medium.speedScale;
    }
    if (medium.pushVx !== 0 || medium.pushVz !== 0) {
      targetVx += medium.pushVx;
      targetVz += medium.pushVz;
    }
  }
  const maxDelta = config.acceleration * dt;
  player.vx = moveTowards(player.vx, targetVx, maxDelta);
  player.vz = moveTowards(player.vz, targetVz, maxDelta);
  const dx = player.vx * dt;
  const dz = player.vz * dt;

  // gravity + jump; underwater the gravity is weak and holding jump swims up
  const inWater = world.getInWaterAt(
    player.position.x,
    player.position.y - config.halfSize + SKIN,
    player.position.z,
  );
  if (inWater) {
    player.vy -= config.gravity * 0.15 * dt;
    if (input.jumpHeld) {
      player.vy = config.swimSpeed;
    } else {
      // gentle drag so an idle player sinks slowly instead of dropping like a
      // stone; holding jump (swim) overrides it
      player.vy *= Math.max(0, 1 - 3 * dt);
    }
  } else {
    player.vy -= config.gravity * dt;
    if (medium !== null) {
      // An updraft or downdraft ramps the fall velocity toward the field's
      // target the way horizontal movement ramps toward its input's; a
      // quicksand clamps how fast the player may sink at all.
      if (medium.pushVy !== null) {
        player.vy = moveTowards(player.vy, medium.pushVy, maxDelta);
      }
      if (medium.sink > 0) {
        player.vy = Math.max(player.vy, -medium.sink);
      }
    }
  }
  if (!inWater && player.onGround && input.jump) {
    player.vy = config.jumpSpeed;
  }

  // one axis at a time, so a wall that stops one of them still lets the player
  // slide along it with the other
  const blockedX = moveHorizontally(player, world, "x", dx);
  const blockedZ = moveHorizontally(player, world, "z", dz);
  const stoppedByWall = blockedX || blockedZ;

  // A platform the player was standing on last frame carries them: its velocity
  // for this frame is added, so they ride it rather than slide off the back.
  if (player.onGround && world.getSurfaceVelocityAt !== undefined) {
    const support = world.getSurfaceVelocityAt(
      player.position.x,
      player.position.y - config.halfSize,
      player.position.z,
    );
    if (support !== null) {
      player.position.x += support[0] * dt;
      player.position.y += support[1] * dt;
      player.position.z += support[2] * dt;
    }
  }

  // A seat turns its rider to the seat's own heading.
  if (player.onGround && world.getSeatYawAt !== undefined) {
    const seatYaw = world.getSeatYawAt(
      player.position.x,
      player.position.y - config.halfSize,
      player.position.z,
    );
    if (seatYaw !== null) {
      player.yaw = seatYaw;
    }
  }

  // Holding jump while walking into a wall climbs it, which is how a player
  // gets back out of a shaft they dug straight down. Never lower than the
  // velocity already there, so climbing away from a jump doesn't cut it short.
  if (stoppedByWall && input.jumpHeld && !inWater) {
    player.vy = Math.max(player.vy, config.climbSpeed);
  }

  // The height the ground is judged from is the one the player enters this
  // frame's fall at (after any step up), not where the fall ends: scanning down
  // from there catches every surface crossed on the way, so a fast fall lands on
  // the floor it passed through instead of the next one below it.
  const feetBefore = player.position.y - config.halfSize;
  const risenY = player.position.y + player.vy * dt;
  if (
    player.vy > 0 &&
    boxHitsSolid(
      config,
      world.getSolidAt,
      player.position.x,
      risenY,
      player.position.z,
    )
  ) {
    // head against a ceiling — drop the climb rather than pushing into it
    player.vy = 0;
  } else {
    player.position.y = risenY;
  }

  // snap to the terrain surface
  const ground = sampleGroundHeight(
    config,
    world.getGroundHeightAt,
    player.position.x,
    feetBefore,
    player.position.z,
  );
  if (!Number.isFinite(ground)) {
    // No surface anywhere under the footprint: the player is over a hole clear
    // through the world, or over blocks that haven't streamed in yet. Rather
    // than drop them out of the world, hold the height they came in at; they
    // resume falling as soon as there's ground to fall toward.
    player.position.y = feetBefore + config.halfSize;
    player.vy = 0;
    player.onGround = true;
    return;
  }
  const minY = ground + config.halfSize;
  if (player.position.y <= minY) {
    player.position.y = minY;
    if (player.vy < 0) {
      player.vy = 0;
    }
    player.onGround = true;
  } else {
    player.onGround = false;
  }
};

/** The look direction of the player's view from yaw/pitch, as a unit vector. */
export const lookDirection = (player: Player): [number, number, number] => {
  const cp = Math.cos(player.pitch);
  return [
    cp * Math.sin(player.yaw),
    Math.sin(player.pitch),
    cp * Math.cos(player.yaw),
  ];
};

/**
 * The point the player's view radiates from: the eye, `eyeHeight` above the
 * cube's centre. Every reach the player has — a block they dig, a surface they
 * place on — is measured from here, so it stays the eye whichever view the
 * camera is drawing.
 */
export const playerEye = (player: Player): [number, number, number] => [
  player.position.x,
  player.position.y + player.config.eyeHeight,
  player.position.z,
];

/** The camera contract `placeCamera` needs, so physics carries no renderer type. */
export interface Camera3D {
  position: { set(x: number, y: number, z: number): void };
  lookAt(x: number, y: number, z: number): void;
}

/**
 * Places the camera. In first person (the default) it sits at the player's eye
 * looking along the player's yaw/pitch, so the crosshair lines up with where the
 * player aims — and where an edit picks. In third person it hovers behind and
 * above the cube, looking at it; where the camera stands does not move what the
 * player can reach, which is measured from their eye either way.
 */
export const placeCamera = (
  camera: Camera3D,
  player: Player,
  firstPerson: boolean = true,
): void => {
  const config = player.config;
  if (firstPerson) {
    const [x, y, z] = playerEye(player);
    camera.position.set(x, y, z);
    const [dx, dy, dz] = lookDirection(player);
    camera.lookAt(x + dx, y + dy, z + dz);
    return;
  }
  const sinYaw = Math.sin(player.yaw);
  const cosYaw = Math.cos(player.yaw);
  camera.position.set(
    player.position.x - sinYaw * config.followBack,
    player.position.y + config.followUp,
    player.position.z - cosYaw * config.followBack,
  );
  // pitch lifts/lowers the look point a little so vertical drag still tilts
  const ty = player.position.y + Math.sin(player.pitch) * 3.0;
  camera.lookAt(player.position.x, ty, player.position.z);
};
