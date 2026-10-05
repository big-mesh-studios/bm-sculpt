/**
 * The game loop: where the player, the input, the camera and the streamed world
 * meet once a frame.
 *
 * The pieces below are each testable alone — the physics against a sampler, the
 * field against the mesher, the stroke against the document — and this is the
 * seam that wires them, which is the part that is not automatically correct just
 * because each side is. The order in `tick` carries two decisions worth naming.
 *
 * **The player steps before the camera is placed.** The camera is put where the
 * player is, so a frame that drew first would show the previous frame's position
 * — most visible as a one-frame lag on a fast fall.
 *
 * **The window follows the player, not the camera.** Streaming is anchored to the
 * body, so looking around does not scroll the world and a fast pan does not drag
 * the streaming window with it. The field is defined everywhere, so the cost of
 * looking the wrong way is only that the chunk behind the eye is meshed.
 *
 * Nothing here draws. The caller owns the frame loop and the render call, so the
 * same engine can be driven by a browser animation frame, a test, or a headless
 * benchmark.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import {
  add,
  normalize,
  rotateAboutAxis,
  scale,
  sub,
  vec3,
} from "@big-mesh-studios/core";

import type { PickCamera } from "../edit/tool";
import type { InputController, InputSnapshot } from "../player/input";
import {
  clearFall,
  clearVelocity,
  createPlayer,
  DEFAULT_PLAYER_CONFIG,
  placeCamera,
  updatePlayer,
  type Medium,
  type Player,
  type PlayerConfig,
} from "../player/player";
import type { Viewport } from "../render/viewport";
import type { Session } from "../session";
import type { SculptSession } from "../sculpt";
import { GameWorld } from "../world/game-world";
import type { Frame } from "../world/up";
import { pickAlong } from "@big-mesh-studios/picking";

export interface GameOptions {
  /** The streamed world, told where to follow. */
  readonly session: Session;
  /** The model and the aim tool that edits it. */
  readonly sculpt: SculptSession;
  /** The viewport whose camera is driven and whose scene is drawn. */
  readonly viewport: Viewport;
  /** The unified input. The engine consumes it once a frame. */
  readonly input: InputController;
  /** Where the player starts, if not the world's own surface at the origin. */
  readonly spawn?: Vec3;
  /**
   * Where water begins, if the world has any: an altitude for a flat world, a distance from the
   * centre for a spherical one. See `GameWorldOptions.seaRadius`.
   */
  readonly seaRadius?: number;
  /**
   * Where water actually is, when that is not simply "below the sea level": a world's water
   * is meshed against its *landscape*, so a shaft dug through solid ground is dry even
   * though it is below the level. Supplied by a world that has a sea; see
   * `GameWorldOptions.waterAt`.
   */
  readonly waterAt?: (p: Vec3) => boolean;
  /**
   * Which way is up. Defaults to flat, which is the world this application has today.
   */
  readonly frame?: Frame;
  /**
   * For a spherical world, how far out from its centre to probe for the surface.
   *
   * **Required by a spherical world and meaningless to a flat one**, where the probe is the
   * origin. There is no way to guess it: the probe point has to be *inside* the planet for the
   * surface trace to run outward from it, and a probe above the planet finds no surface at all and
   * drops the player into the sky.
   */
  readonly spawnRadius?: number;
  /** Movement settings for this world; anything omitted takes its default. */
  readonly player?: Partial<PlayerConfig>;
  /**
   * The scripted field at a point, for the player's physics — a conveyor, a current, quicksand.
   *
   * **A reader rather than the collection, and the reason is the order things are built in.**
   * `Game` makes its `GameWorld` in its constructor, and the place host that owns the fields does
   * not exist until a person types `/place:load`. So this is a function that reaches into the host
   * when it is asked, and answers "none" while there is no host — which is the state the
   * application spends its whole life in before anyone loads a place.
   */
  readonly mediumAt?: (p: Vec3) => Medium | undefined;
}

/** What `Game.raycast` reports, and what a place's guest library receives. */
export interface RayHit {
  /**
   * What was hit.
   *
   * **Always `"terrain"` today, and named as if it might not be.** The field is one signed
   * distance function over the terrain and every operation in every place, so it cannot say
   * which of them it met — the fold is a single surface with no record of what made it. A
   * place that asked could be told "something solid", which is all the field knows and all it
   * is entitled to say. Splitting it later means adding a case here, not changing this type's
   * meaning.
   */
  readonly kind: "terrain";
  readonly point: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly distance: number;
}

/**
 * How high `/player:space` puts the player when no altitude is given.
 *
 * **Twenty thousand, which is well clear of the 4,800-unit atmosphere.** The point of the command is
 * to see the far field without the climb; a default just above the shell would still be in the sky's
 * blue, so this clears it with room to see the planet below.
 */
export const DEFAULT_SPACE_ALTITUDE = 20000;

export class Game {
  readonly player: Player;
  readonly world: GameWorld;

  private readonly session: Session;
  private readonly sculpt: SculptSession;
  private readonly viewport: Viewport;
  private readonly input: InputController;
  private readonly playerConfig: Partial<PlayerConfig>;
  /** Where a spherical world is probed for its surface. See `GameOptions.spawnRadius`. */
  private readonly spawnRadius: number | undefined;
  /** The sea's radius for this world, so `/player:space` can measure an altitude from it. */
  private readonly seaRadius: number | undefined;
  /** The aim action currently held, so a stroke is begun and ended once. */
  private aim: "dig" | "place" | undefined;
  /**
   * Where a place has pointed the camera, and the field of view it asked for.
   *
   * **`undefined` for both is the normal state** — the camera is the player's eye and nothing
   * has claimed it. They are held rather than applied so that a place can set them between
   * frames and they take effect on the next `tick`, which is the only point at which the
   * camera is otherwise written.
   */
  private cameraTarget: Vec3 | undefined;
  private cameraFov: number | undefined;
  /**
   * The field of view the camera had before a place claimed it.
   *
   * **Remembered so clearing can put it *back*, rather than merely stop setting it.** A field
   * of view only changes while a place is asking for one, so "the place has gone" and "the
   * camera is zoomed to 0.5 radians because a place was here" would otherwise be the same
   * state — and the zoom would outlive the place that set it, with nothing to reset it.
   */
  private baseFov: number | undefined;
  /**
   * The player's own movement numbers, captured before anything has changed them.
   *
   * **The base every multiplier scales from, and why it is a snapshot rather than
   * `DEFAULT_PLAYER_CONFIG`.** A world can be built with its own `player: { speed: 30 }`, and
   * scaling from the *default* would silently replace that world's walking speed with the
   * default's — a place that halved the speed of a deliberately slow world would instead make
   * it walk at the default half. Reading the config at construction is the only reading that is
   * true about the world in question.
   *
   * It is a snapshot because every `set` scales from this and every `clear` restores it, which
   * makes the two order-independent: setting a multiplier twice replaces rather than compounds,
   * and clearing twice is the same as clearing once. Compounding would mean a place that ran its
   * setup twice left the player at four times their speed with no way back.
   */
  private readonly baseConfig: PlayerConfig;

  constructor(options: GameOptions) {
    this.session = options.session;
    this.sculpt = options.sculpt;
    this.viewport = options.viewport;
    this.input = options.input;
    this.playerConfig = options.player ?? {};
    this.spawnRadius = options.spawnRadius;
    this.seaRadius = options.seaRadius;

    this.world = new GameWorld({
      field: () => this.sculpt.collisionField,
      // **Only when the caller has one.** Passing a reader that always said "none" would make
      // `getMediumAt` defined on every world and cost the physics an optional call per frame for
      // the privilege of telling it nothing.
      ...(options.mediumAt === undefined ? {} : { mediumAt: options.mediumAt }),
      ...(options.frame === undefined ? {} : { frame: options.frame }),
      ...(options.seaRadius !== undefined
        ? { seaRadius: options.seaRadius }
        : {}),
      // **Forwarded as its own optional, for the reason `mediumAt` has one above**: a
      // reader that always answered a thing would make every world's `waterAt` defined and
      // pay a branch per frame to say nothing.
      ...(options.waterAt !== undefined ? { waterAt: options.waterAt } : {}),
    });

    const spawn = options.spawn ?? this.spawnOnTheSurface();
    // **The world's frame, not a default.** A player built without it would stand with their up
    // along world `+Y` on a planet — lying on their side at the equator, upside down at the pole —
    // and the first thing the physics does is add gravity along `up`.
    this.player = createPlayer(spawn, this.playerConfig, this.world.frame);
    // After construction, because `createPlayer` is what fills in the defaults — a
    // snapshot taken before it would capture `halfSize: undefined` and every
    // multiplier would scale from nothing.
    this.baseConfig = { ...this.player.config };
  }

  /** One frame: read input, step the player, place the camera, edit, stream. */
  tick(dt: number): void {
    const input = this.input.consume();

    updatePlayer(this.player, dt, input, this.world);
    placeCamera(this.viewport.camera, this.player, true);
    // **After `placeCamera`, never before.** That call is the player's own answer for where the
    // camera is, and it runs every frame; anything written before it would be overwritten by
    // the player's eye before a single pixel was drawn. So a place's `lookAt` is applied here,
    // on top, and `clearCameraLook` is a single `undefined` that lets the next frame stand
    // alone.
    if (this.cameraTarget !== undefined) {
      const camera = this.viewport.camera;
      camera.lookAt(
        this.cameraTarget.x,
        this.cameraTarget.y,
        this.cameraTarget.z,
      );
      if (this.cameraFov !== undefined) camera.fov = this.cameraFov;
    }
    // The aim traces the camera's matrices, and those are otherwise only brought
    // up to date at draw time — so it would aim with the previous frame's view.
    this.viewport.camera.updateMatrixWorld();

    // The window follows the body, so looking around does not stream.
    this.session.follow(this.player.position);

    this.updateAim(input);
    // On the frame, not per dab, so a fast drag sends one model rather than one
    // per dab and cannot cancel its own mesh in flight.
    this.sculpt.flushPreview();
  }

  /**
   * Digs while the primary action is held and places while the secondary is.
   *
   * A held action is one stroke from press to release, which is what makes a
   * drag carve a trench rather than a row of holes and puts the whole drag on one
   * undo step. The mode is switched only on a change, so releasing and pressing
   * again starts a new stroke rather than extending the last.
   */
  private updateAim(input: InputSnapshot): void {
    const wanted: "dig" | "place" | undefined = input.primaryHeld
      ? "dig"
      : input.secondaryHeld
        ? "place"
        : undefined;

    if (wanted !== this.aim) {
      if (this.aim !== undefined) this.sculpt.endAim();
      this.aim = undefined;
      if (wanted !== undefined) {
        const mode = wanted === "dig" ? "subtract" : "add";
        if (this.sculpt.beginAim(this.camera(), mode)) this.aim = wanted;
      }
      return;
    }

    if (this.aim !== undefined) this.sculpt.updateAim(this.camera());
  }

  /* ------------------------------------------------- what a place can ask for */

  /**
   * Puts the player somewhere, facing a direction.
   *
   * **Zeroes the fall, the way `/player:fly` does**, because a place that builds a platform
   * and puts a player on it should not have to know that arriving there with a downward
   * velocity means the platform is a suggestion. The velocity is discarded rather than
   * cancelled so the next frame starts from rest either way.
   */
  teleportPlayer(at: Vec3, heading?: number): void {
    const player = this.player;
    player.position = at;
    if (heading !== undefined) {
      // **A heading angle about the player's own up, not about world Y.**
      //
      // The parameter is still a number because the guest library's `movePlayer(x, y, z, yaw)`
      // passes one, and changing that signature is a wire-format break for every published place
      // which belongs with the rest of the places work rather than inside this one. On a flat world
      // the two readings are identical. On a sphere this one is the only one that means anything,
      // and a place that wants a world-space direction should say so in the vocabulary change.
      const up = this.world.frame.upAt(at);
      const angle = -heading;
      player.right = rotateAboutAxis(player.right, up, angle);
      player.forward = rotateAboutAxis(player.forward, up, angle);
    }
    clearVelocity(player);
  }

  /**
   * Overrides how fast this player walks, until something clears it.
   *
   * **A multiplier on this world's own walking speed, not a replacement for it**, so a place
   * that halves it does not also change how fast the player turns or jumps. Scaling from
   * `baseConfig` means a second call replaces the first rather than compounding with it.
   */
  setPlayerSpeed(multiplier: number): void {
    this.player.config.speed = this.baseConfig.speed * multiplier;
  }

  /** Puts the walking speed back to this world's own. */
  clearPlayerSpeed(): void {
    this.player.config.speed = this.baseConfig.speed;
  }

  /** As `setPlayerSpeed`, for the jump. */
  setPlayerJump(multiplier: number): void {
    this.player.config.jumpSpeed = this.baseConfig.jumpSpeed * multiplier;
  }

  /** Puts the jump back to this world's own. */
  clearPlayerJump(): void {
    this.player.config.jumpSpeed = this.baseConfig.jumpSpeed;
  }

  /**
   * Points the camera at a place in the world, until `clearCameraLook`.
   *
   * **A look target rather than a camera position**, so the camera keeps following the player
   * and a place cannot leave it inside geometry. The camera *is* the player's eye, and moving
   * it away from the eye would mean a script could put the camera somewhere the player is not
   * — which is a nicer thing for a title sequence than for a level.
   */
  lookAt(at: { x: number; y: number; z: number }, fov?: number): void {
    // **Captured on the first claim, not on every call.** A place that re-aims its
    // camera every tick must not recapture the zoom it is currently applying —
    // that would make clearing restore the place's own fov and leave the player
    // looking through a lens they never chose.
    if (this.cameraTarget === undefined)
      this.baseFov = this.viewport.camera.fov;
    this.cameraTarget = { x: at.x, y: at.y, z: at.z };
    if (fov !== undefined) this.cameraFov = fov;
  }

  /** Gives the camera back to the player, lens and all. */
  clearCameraLook(): void {
    this.cameraTarget = undefined;
    this.cameraFov = undefined;
    if (this.baseFov !== undefined) {
      this.viewport.camera.fov = this.baseFov;
      this.baseFov = undefined;
    }
  }

  /**
   * Traces a ray against the world, for a place's `raycast`.
   *
   * **The same field the picker traces and the player collides with**, because
   * `GameWorld.getSolidAt` is `field().distance(x, y, z) < 0` and there is one field
   * (ADR 0009). A place asking "what is over there" and the player looking at it must be
   * answered by the same surface, or a place that builds a bridge in response to a ray would
   * be building it against something nobody can see.
   *
   * Sphere-traced rather than a DDA: there is no grid here, so there is nothing to step
   * through, and a surface is found by the sign of a distance function.
   */
  raycast(
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    maxDistance: number,
  ): RayHit | undefined {
    if (maxDistance <= 0) return undefined;
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    // A zero-length direction has no direction in it, and normalising it would divide by
    // zero. "Nothing there" is the honest answer and is what the guest library turns into
    // `undefined` rather than a hit at the origin.
    if (length === 0) return undefined;

    const hit = pickAlong(
      this.sculpt.collisionField,
      {
        origin: { x: origin[0], y: origin[1], z: origin[2] },
        direction: {
          x: direction[0] / length,
          y: direction[1] / length,
          z: direction[2] / length,
        },
      },
      // `reach` rather than a step count: "how far to look" is a place author's question,
      // and `pickAlong` already turns it into a budget.
      { reach: maxDistance },
    );
    if (hit === undefined) return undefined;
    return {
      kind: "terrain",
      point: [hit.point.x, hit.point.y, hit.point.z],
      normal: [hit.normal.x, hit.normal.y, hit.normal.z],
      distance: hit.distance,
    };
  }

  /** Whether the player's eye is under the surface, for an underwater tint. */
  get underwater(): boolean {
    return this.world.getInWaterAt(this.player.position);
  }

  /**
   * Turns flight on or off, toggling when `flying` is omitted: no gravity, and
   * forward/back follows the full look direction.
   *
   * Turning it **on** discards the fall the player was in. Their velocity
   * ramps toward the flight target from wherever the last walk left it, and a
   * hundred units a second downward would carry them through the floor they
   * were aiming at before the ramp could act on it.
   */
  setFlying(flying?: boolean): string {
    const next = flying ?? !this.player.flying;
    this.player.flying = next;
    if (next) {
      clearFall(this.player);
      this.player.onGround = false;
    }
    return next ? "flying" : "walking";
  }

  /**
   * Turns no-clip on or off, toggling when `noclip` is omitted: flight control
   * with collision off, so the player passes through solid voxels.
   *
   * The fall is discarded on the way on for the same reason as `setFlying` —
   * no-clip's integrator never settles a velocity itself.
   */
  setNoClip(noclip?: boolean): string {
    const next = noclip ?? !this.player.noclip;
    this.player.noclip = next;
    if (next) {
      clearFall(this.player);
      this.player.onGround = false;
    }
    return next ? "no-clip" : "collisions on";
  }

  /**
   * Puts the player in space above their current ground, for debugging the far field.
   *
   * **A teleport, not a spawn**, so it works mid-session and keeps the player over the ground they
   * were on. On a spherical world the altitude is measured from the sea radius along the direction
   * from the centre, which is the same measurement the globe's fade and the atmosphere use; a flat
   * world has no centre, so the altitude is a world `y`. Flight is switched on, because a player
   * dropped in space with gravity on is a projectile rather than an observer.
   */
  placeInSpace(altitude = DEFAULT_SPACE_ALTITUDE): string {
    const player = this.player;
    const centre = this.world.centre;
    let at: Vec3;
    if (centre === undefined) {
      at = vec3(player.position.x, altitude, player.position.z);
    } else {
      const away = sub(player.position, centre);
      const radius = Math.hypot(away.x, away.y, away.z);
      const dir = radius > 1e-6 ? normalize(away) : vec3(0, 1, 0);
      // The sea is the zero of altitude; the player's own radius is the fallback for a spherical
      // world that somehow has no sea.
      at = add(centre, scale(dir, (this.seaRadius ?? radius) + altitude));
    }
    this.teleportPlayer(at);
    this.setFlying(true);
    return `in space at ${altitude} units above the sea; flight on`;
  }

  /** The camera as the picker and the aim tool need it. */
  private camera(): PickCamera {
    return this.viewport.camera;
  }

  /**
   * A spawn on the terrain's own surface above the world's reference point, one body clear of it.
   *
   * **Asks the world the question the physics asks** — a distance along the local up to the
   * surface — rather than reading a height from somewhere else. That is what lets it work on a
   * planet unchanged: there is no `heightAt(0, 0)` on a sphere, and no reason to want one.
   */
  private spawnOnTheSurface(): Vec3 {
    const halfSize =
      this.playerConfig.halfSize ?? DEFAULT_PLAYER_CONFIG.halfSize;
    const frame = this.world.frame;
    // Flat worlds spawn above the origin; a spherical one above a point on its surface, placed
    // from the body's own centre so the spawn is on the planet rather than inside it.
    const centre = this.world.centre;
    const above: Vec3 =
      centre === undefined || this.spawnRadius === undefined
        ? vec3(0, 0, 0)
        : add(centre, scale(vec3(0, 1, 0), this.spawnRadius));
    const up = frame.upAt(above);
    const ground = this.world.getGroundDistanceAt(above, up);
    // A world with no terrain at all starts the player where they are and lets gravity do the
    // rest, which is the honest answer: there is nothing to stand on yet.
    return Number.isFinite(ground)
      ? add(above, scale(up, ground + halfSize + 1))
      : above;
  }
}
