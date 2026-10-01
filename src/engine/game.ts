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

import type { Vec3 } from "../constants";

import type { PickCamera } from "../edit/tool";
import type { InputController, InputSnapshot } from "../player/input";
import {
  createPlayer,
  DEFAULT_PLAYER_CONFIG,
  placeCamera,
  updatePlayer,
  type Player,
  type PlayerConfig,
} from "../player/player";
import type { Viewport } from "../render/viewport";
import type { Session } from "../session";
import type { SculptSession } from "../sculpt";
import { GameWorld } from "../world/game-world";

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
  /** The world y water settles at, if the world has any. */
  readonly seaLevel?: number;
  /** Movement settings for this world; anything omitted takes its default. */
  readonly player?: Partial<PlayerConfig>;
}

export class Game {
  readonly player: Player;
  readonly world: GameWorld;

  private readonly session: Session;
  private readonly sculpt: SculptSession;
  private readonly viewport: Viewport;
  private readonly input: InputController;
  private readonly playerConfig: Partial<PlayerConfig>;
  /** The aim action currently held, so a stroke is begun and ended once. */
  private aim: "dig" | "place" | undefined;

  constructor(options: GameOptions) {
    this.session = options.session;
    this.sculpt = options.sculpt;
    this.viewport = options.viewport;
    this.input = options.input;
    this.playerConfig = options.player ?? {};

    this.world = new GameWorld({
      field: () => this.sculpt.collisionField,
      ...(this.sculpt.terrainHeight !== undefined
        ? { heightAt: this.sculpt.terrainHeight }
        : {}),
      ...(options.seaLevel !== undefined ? { seaLevel: options.seaLevel } : {}),
    });

    const spawn = options.spawn ?? this.spawnAtOrigin();
    this.player = createPlayer(spawn.x, spawn.y, spawn.z, this.playerConfig);
  }

  /** One frame: read input, step the player, place the camera, edit, stream. */
  tick(dt: number): void {
    const input = this.input.consume();

    updatePlayer(this.player, dt, input, this.world);
    placeCamera(this.viewport.camera, this.player, true);
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

  /** Whether the player's eye is under the surface, for an underwater tint. */
  get underwater(): boolean {
    return this.world.getInWaterAt(
      this.player.position.x,
      this.player.position.y,
      this.player.position.z,
    );
  }

  /** The camera as the picker and the aim tool need it. */
  private camera(): PickCamera {
    return this.viewport.camera;
  }

  /** A spawn on the terrain's own surface at the origin, one body above it. */
  private spawnAtOrigin(): Vec3 {
    const halfSize =
      this.playerConfig.halfSize ?? DEFAULT_PLAYER_CONFIG.halfSize;
    const ground = this.world.getHeightAt(0, 0);
    // A column with no surface at all — a world with no terrain — starts the
    // player at the origin and lets gravity do the rest.
    const y = Number.isFinite(ground) ? ground + halfSize + 1 : halfSize + 1;
    return { x: 0, y, z: 0 };
  }
}
