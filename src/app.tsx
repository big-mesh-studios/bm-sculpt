/**
 * The application shell: a canvas, a header, and whichever scene the URL asks for.
 *
 * Three scenes now, and the switch is still a query parameter rather than a build
 * flag. The default is the **game**: a first-person player over the terrain who
 * digs and places with the same stroke machinery the sculptor uses. `?edit` keeps
 * the orbit-and-sculpt view the application grew up as, and `?spike` is the phase
 * 0 diagnostic that proved the renderer, the packed vertex layout and the
 * octahedral fold. A spike behind a build flag is a spike that stops being
 * rebuilt; a game that cannot be put back into the editor it came from is a game
 * whose tools are only ever tested from the outside.
 *
 * The frame loop differs by scene, and deliberately so: the game steps a body and
 * follows it, the editor streams toward an orbit target, and the spike streams
 * nothing. What they share is one renderer and one render call.
 */

import { createMemo, createSignal, onSettled, Show } from "solid-js";
import {
  Color,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
} from "@random-mesh/rmsl/scene";

import { Console, createConsole, type ConsoleState } from "./console/console";
import { createCommands, type Commander } from "./console/commands";
import { OrbitController } from "./controls/orbit-camera";
import {
  describePrecision,
  detectFragmentPrecision,
  type PrecisionProbe,
} from "./render/precision";
import { SurfaceMaterial } from "./render/surface-material";
import { createViewport, type Viewport } from "./render/viewport";
import { VERTEX_BYTES } from "./render/spike-geometry";
import {
  GAME_WINDOW,
  Session,
  starterOperations,
  type SessionStats,
} from "./session";
import { DEFAULT_TERRAIN } from "./csg";
import { LOD_OFF, lodIsOff, type LodBands } from "./world";
import { SculptSession } from "./sculpt";
import { DEFAULT_BRUSH } from "./edit/brush";
import { buildSpikeScene, type SpikeScene } from "./spike-scene";
import { createInput } from "./player/input";
import { TouchControls } from "./player/touch-controls";
import { Game } from "./engine/game";
import { createWater, SEA_LEVEL } from "./world/water";
import { createClouds, type Clouds } from "./world/clouds";
import {
  bakeCloudFieldOffThread,
  type CloudBakeSource,
} from "./world/cloud-bake-client";
import { createSky } from "./world/sky";
import { DayNightController } from "./world/day-night-controller";

import styles from "./app.module.css";

/** How often the header is refreshed. A frame's worth of churn is unreadable. */
const READOUT_INTERVAL_MS = 250;

/** The largest step a frame is allowed to advance the world, in seconds. */
const MAX_STEP = 0.05;

const searchHas = (flag: string): boolean =>
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has(flag);

const isSpike = (): boolean => searchHas("spike");
const isEdit = (): boolean => searchHas("edit");
const isGame = (): boolean => !isSpike() && !isEdit();

/** Whether this device points with something coarse, so the touch UI shows. */
const isCoarsePointer = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(any-pointer: coarse)").matches;

/**
 * The level-of-detail bands to run with, overridable from the query string.
 *
 * `?lod=off` switches level of detail off, and `?lod=FULL:COARSE` sets the two bands.
 * The reason this is reachable at runtime rather than only in a test is that it is the
 * one experiment that separates the two possible causes of a crack: with every chunk at
 * full resolution there are no level transitions, so any crack that survives is not one,
 * and any that disappears was one.
 */
const lodBandsFromSearch = (): LodBands | undefined => {
  if (typeof location === "undefined") return undefined;
  const mode = new URLSearchParams(location.search).get("lod");
  if (mode === null) return undefined;
  if (mode === "off") return LOD_OFF;
  const [full, coarse] = mode.split(":").map(Number);
  if (!Number.isFinite(full) || !Number.isFinite(coarse)) return undefined;
  return { full, coarse };
};

/** What the header says about level of detail, so the mode is never a guess. */
const describeBands = (bands: LodBands): string =>
  lodIsOff(bands)
    ? "off (every chunk full resolution)"
    : `full within ${bands.full} chunks, coarse within ${bands.coarse}`;

/**
 * Where the cloud layer is, as the header says it.
 *
 * **The one asynchronous thing in the scene, and therefore the only one that can fail
 * silently.** The field is baked on a worker, so for the first second or two there is
 * no cloud layer at all, and a player looking up sees clear sky — which is exactly what
 * a broken sky looks like. So the state is on screen rather than in a log, and it names
 * the failure rather than only the absence.
 */
type CloudStatus =
  | { readonly state: "baking" }
  | {
      readonly state: "ready";
      readonly field: Extract<CloudBakeSource, "worker" | "main thread">;
    }
  | { readonly state: "failed"; readonly reason: string };

const describeCloudStatus = (status: CloudStatus): string => {
  switch (status.state) {
    case "baking":
      return "baking the field…";
    case "ready":
      return `ready (baked on the ${status.field})`;
    case "failed":
      return `NOT BUILT — ${status.reason}`;
  }
};

export default function App() {
  let canvas!: HTMLCanvasElement;
  const [precision, setPrecision] = createSignal<PrecisionProbe | undefined>();
  const [stats, setStats] = createSignal<SessionStats | undefined>();
  const [spikeCounts, setSpikeCounts] = createSignal<
    SpikeScene["counts"] | undefined
  >();
  const [spike] = createSignal(isSpike());
  const [edit] = createSignal(isEdit());
  const [bands] = createSignal(lodBandsFromSearch());
  const [history, setHistory] = createSignal({ undo: 0, redo: 0 });
  const [locked, setLocked] = createSignal(false);
  const [underwater, setUnderwater] = createSignal(false);
  const [coarse] = createSignal(isCoarsePointer());
  const [suspended, setSuspended] = createSignal(false);
  const [cloudStatus, setCloudStatus] = createSignal<CloudStatus>({
    state: "baking",
  });

  // Created here rather than in the settled effect so the touch UI can bind to it
  // and the effect can attach it to the canvas. It listens to nothing until it is
  // attached, so an editor or spike session simply leaves it inert.
  const input = createInput();

  /**
   * The command table the console runs against, held outside the settled effect
   * because it can only be built once there is a `Game` to ask, and the console
   * has to be able to read it — for its completions — from the component body.
   * `null` until the game scene exists, which is also the answer the console
   * gives for a command run before then.
   */
  const [commander, setCommander] = createSignal<Commander | null>(null);

  /**
   * The console's scrollback and command handling, built here rather than in the
   * game branch so that closing and reopening the panel keeps its history. See
   * `docs/adr/0010-suspend-the-pointer-lock-not-the-input.md` for the other
   * thing the console has to own above the frame loop.
   */
  const terminal: ConsoleState = createConsole({
    onCommand: (line) =>
      commander()?.run(line) ??
      "the world is still loading — try again shortly",
    commands: () => commander()?.help() ?? [],
  });

  // A memo rather than a `<Show>` with a narrowed child, because `<Show>` calls its children
  // function with tracking switched off. Reading the narrowed accessor *in the return
  // position* reads the signal untracked: a dev-mode STRICT_READ_UNTRACKED warning, and a row
  // that would silently never update if the probe landed after the first render.
  const precisionText = createMemo(() => {
    const measured = precision();
    return measured === undefined
      ? "not probed yet"
      : describePrecision(measured);
  });

  // Solid 2 replaced `onMount` with `onSettled`, which fires once after the current
  // activity settles. It does *not* return a disposal — the callback returns the teardown,
  // and `onCleanup` inside one is a dev-mode error that halts the reactive system. So the
  // two halves of the lifecycle live in one block, and the block's last statement is its
  // own undo.
  onSettled(() => {
    const measured = detectFragmentPrecision();
    setPrecision(measured);
    if (!measured.ok)
      console.warn("fragment precision probe:", measured.reason);

    // ---- Phase 0 spike ----
    if (spike()) {
      const scene = buildSpikeScene(canvas, measured);
      setSpikeCounts(scene.counts);
      const detach = scene.orbit.attach(canvas);
      scene.orbit.apply();

      scene.viewport.renderer.setAnimationLoop(() => {
        scene.orbit.apply();
        scene.viewport.render();
      });

      return () => {
        detach();
        scene.dispose();
      };
    }

    // ---- The shared streamed scene ----
    const viewport: Viewport = createViewport(canvas, {
      ...(measured.ok ? { precision: measured.precision } : {}),
    });
    viewport.setBackground(new Color(0.07, 0.07, 0.09));

    // The sky, added before anything else in the scene. rmsl has no render-order
    // key — draw order is scene traversal order — and the dome neither tests nor
    // writes depth, so it has to be first for the terrain, water and clouds to land on
    // top of it. Only the game gets one: the editor's near-black is deliberate, for
    // reading a model's silhouette against.
    const sky = isGame() ? createSky(viewport.scene) : null;

    const material = new SurfaceMaterial();
    const previewMaterial = new MeshBasicMaterial({
      color: new Color(1, 0.85, 0.4),
    });

    const chosen = bands();
    // The game starts on bare terrain. The editor's starter primitives sit
    // around the origin, and a body spawned into a ninety-unit sphere is a body
    // spawned inside the ground.
    const initialOperations = isGame() ? [] : starterOperations();
    const session = new Session({
      scene: viewport.scene,
      material,
      operations: initialOperations,
      terrain: DEFAULT_TERRAIN,
      // A wider and flatter window than the editor's — see `GAME_WINDOW`, which the
      // fog's own test reads so that these two cannot drift apart.
      ...(isGame() ? GAME_WINDOW : {}),
      ...(chosen !== undefined ? { bands: chosen } : {}),
    });

    const sculpt = new SculptSession({
      session,
      camera: viewport.camera,
      operations: session.operations,
      terrain: session.terrain,
    });

    // ---- The editor: orbit and sculpt by pointer ----
    if (edit()) {
      const orbit = new OrbitController(viewport.camera, { radius: 900 });
      const preview = new Mesh(
        new SphereGeometry(DEFAULT_BRUSH.radius, 24, 16),
        previewMaterial,
      );
      preview.visible = false;
      viewport.scene.add(preview);

      const follow = (): void => {
        session.follow(orbit.state.target);
        const where = sculpt.preview;
        preview.visible = where.visible;
        if (where.visible) {
          preview.position.set(
            where.position.x,
            where.position.y,
            where.position.z,
          );
        }
        preview.scale.setScalar(sculpt.settings.radius / DEFAULT_BRUSH.radius);
      };
      const streamStroke = (): void => sculpt.flushPreview();

      const pointerOptions = () => ({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });
      const down = new Set<number>();
      let sculptPointer: number | undefined;

      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || event.shiftKey) return;
        down.add(event.pointerId);
        sculptPointer ??= event.pointerId;
        sculpt.tool.pointerDown(
          event,
          pointerOptions().width,
          pointerOptions().height,
        );
        sculpt.tool.setSuspended(down.size > 1);
        orbit.setToolOwnsLeft(true);
      };
      const onPointerMove = (event: PointerEvent): void => {
        sculpt.tool.pointerMove(
          event,
          pointerOptions().width,
          pointerOptions().height,
        );
      };
      const release = (pointerId: number, abandon: boolean): void => {
        down.delete(pointerId);
        if (pointerId !== sculptPointer) {
          sculpt.tool.setSuspended(down.size > 1);
          return;
        }
        sculptPointer = undefined;
        sculpt.tool.setSuspended(false);
        if (abandon) sculpt.tool.pointerLeave();
        else sculpt.tool.pointerUp();
        orbit.setToolOwnsLeft(false);
        setHistory({ undo: sculpt.undoDepth, redo: sculpt.redoDepth });
      };
      const onPointerUp = (event: PointerEvent): void =>
        release(event.pointerId, false);
      const onPointerCancel = (event: PointerEvent): void =>
        release(event.pointerId, true);
      const onPointerLeave = (event: PointerEvent): void => {
        if (!down.has(event.pointerId)) return;
        release(event.pointerId, true);
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        if (!event.ctrlKey && !event.metaKey) return;
        const shift = event.shiftKey;
        if (event.key === "z" && !shift) sculpt.tool.undo();
        else if ((event.key === "z" && shift) || event.key === "y")
          sculpt.tool.redo();
        else return;
        event.preventDefault();
        setHistory({ undo: sculpt.undoDepth, redo: sculpt.redoDepth });
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("keydown", onKeyDown);

      const detachOrbit = orbit.attach(canvas);
      orbit.apply();

      let lastReadout = 0;
      viewport.renderer.setAnimationLoop((time: number) => {
        orbit.apply();
        follow();
        streamStroke();
        viewport.render();

        if (time - lastReadout > READOUT_INTERVAL_MS) {
          lastReadout = time;
          setStats(session.stats());
        }
      });

      return () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        window.removeEventListener("keydown", onKeyDown);
        detachOrbit();
        preview.geometry.dispose();
        session.dispose();
        viewport.dispose();
      };
    }

    // ---- The game: a first-person player over the terrain ----
    // A sky colour rather than the editor's near-black, so water and cloud meet
    // the horizon rather than a void. The day-night cycle writes over it every
    // frame; this is only what the very first one is drawn with.
    const skyColour = new Color(0.53, 0.81, 0.92);
    viewport.setBackground(skyColour);
    const game = new Game({
      session,
      sculpt,
      viewport,
      input,
      seaLevel: SEA_LEVEL,
    });
    const water = createWater(viewport.scene, SEA_LEVEL);
    // The clouds, built once their field has been baked — on a worker, because the bake
    // is two and a half seconds of arithmetic and the only reason to move it is that it
    // was happening on the thread that draws. The layer is null until the field lands,
    // and the frame loop's optional call is the whole of the handling: the first second
    // or so has a sky, a terrain and a sea, and no weather yet.
    const cloudBake = bakeCloudFieldOffThread(DEFAULT_TERRAIN.seed);
    let layer: Clouds | null = null;
    let cloudsDisposed = false;

    void cloudBake.field.then(
      (field) => {
        // Between the field being baked and this running, the scene can have been torn
        // down — and a mesh added to a disposed scene is a leak with no owner.
        if (cloudsDisposed) return;
        try {
          layer = createClouds(viewport.scene, DEFAULT_TERRAIN.seed, field);
          const source = cloudBake.source();
          setCloudStatus({
            state: "ready",
            field: source === "main thread" ? "main thread" : "worker",
          });
        } catch (reason) {
          // A material that throws on its first draw is the same fault as no layer at
          // all, and it used to be invisible: the promise's callback threw, the
          // rejection went to a handler nobody had, and the sky was empty with nothing
          // in the header to say why.
          console.warn("cloud layer could not be built:", reason);
          setCloudStatus({
            state: "failed",
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        }
      },
      (reason: unknown) => {
        setCloudStatus({
          state: "failed",
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      },
    );
    const detachInput = input.attach(canvas);
    const stopLock = input.onPointerLockChange(setLocked);
    const stopSuspension = input.onPointerLockSuspensionChange(setSuspended);
    // The clock, which `/clock:` drives. It holds three numbers and no reference to
    // anything that draws, so `app.tsx` is where the two meet: the state comes out of
    // `tick` below and the five materials take it here.
    const clock = new DayNightController();
    // The console's commands are the game's own methods by another name, so the
    // game is what they are built over. It exists here, and nowhere earlier,
    // which is why the table can only be built now.
    setCommander(
      createCommands({
        setFlying: (flying) => game.setFlying(flying),
        setNoClip: (noclip) => game.setNoClip(noclip),
        clock,
        // The two cloud knobs, adapted rather than passed as an object, because the
        // layer does not exist yet and only this scope knows that. `state()` says so
        // rather than reporting zeroes, which is what a null layer would otherwise look
        // like.
        cloud: {
          coverage: (value) => {
            if (layer === null)
              return "no cloud layer yet — the field is still baking";
            const material = layer.material;
            if (value !== undefined) material.coverage = value;
            return `coverage ${material.coverage.toFixed(3)}`;
          },
          density: (value) => {
            if (layer === null)
              return "no cloud layer yet — the field is still baking";
            const material = layer.material;
            if (value !== undefined) material.density = value;
            return `density ${material.density.toFixed(3)}`;
          },
          state: () =>
            layer === null
              ? `no cloud layer yet — ${describeCloudStatus(cloudStatus())}`
              : `built | coverage ${layer.material.coverage.toFixed(3)} | density ${layer.material.density.toFixed(3)} | ${describeCloudStatus(cloudStatus())}`,
        },
      }),
    );

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      const shift = event.shiftKey;
      if (event.key === "z" && !shift) sculpt.tool.undo();
      else if ((event.key === "z" && shift) || event.key === "y")
        sculpt.tool.redo();
      else return;
      event.preventDefault();
      setHistory({ undo: sculpt.undoDepth, redo: sculpt.redoDepth });
    };
    window.addEventListener("keydown", onKeyDown);

    let lastTime = 0;
    let lastReadout = 0;
    viewport.renderer.setAnimationLoop((time: number) => {
      const dt =
        lastTime === 0 ? 1 / 60 : Math.min((time - lastTime) / 1000, MAX_STEP);
      lastTime = time;
      game.tick(dt);

      // The clock, on the frame's own dt, and the one place the day's lighting is
      // derived. Everything downstream reads this single object: the sky, the clouds,
      // the terrain, the water and the clear colour. They cannot disagree about what
      // hour it is because there is only one answer to ask.
      const light = clock.tick(dt);

      // The clear colour is the sky's horizon colour, which is what the terrain's fog
      // fades to and what the water reflects. One colour, set once, rather than three
      // places that each hold a copy and are each right on a different afternoon.
      skyColour.set(light.skyColor[0], light.skyColor[1], light.skyColor[2]);
      material.sky.lighting = light;
      material.fog.colour = light.skyColor;
      water.material.sky.lighting = light;
      water.material.fog.colour = light.skyColor;

      // A star is sized in CSS pixels, so the dome needs the ratio the canvas is
      // actually drawing at — which the viewport owns and changes on a resize.
      if (sky !== null) sky.material.pixelScale = viewport.pixelRatio;
      sky?.update(game.player.position, light);
      water.update(game.player.position);
      layer?.update(game.player.position, light);
      if (game.underwater !== underwater()) setUnderwater(game.underwater);
      viewport.render();

      if (time - lastReadout > READOUT_INTERVAL_MS) {
        lastReadout = time;
        setStats(session.stats());
        setHistory({ undo: sculpt.undoDepth, redo: sculpt.redoDepth });
      }
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      setCommander(null);
      stopLock();
      stopSuspension();
      detachInput();
      sky?.dispose();
      water.dispose();
      cloudsDisposed = true;
      cloudBake.dispose();
      layer?.dispose();
      session.dispose();
      viewport.dispose();
    };
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />
      {/* Not while the pointer lock is merely suspended — the console has taken
          it, so "click to play" would be inviting a click at a moment when the
          world is already being played. */}
      <Show when={isGame() && !coarse() && !locked() && !suspended()}>
        <div
          style={{
            position: "absolute",
            inset: "0",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            color: "rgba(255,255,255,0.85)",
            "font-size": "18px",
            "pointer-events": "none",
            "text-shadow": "0 1px 4px rgba(0,0,0,0.8)",
          }}
        >
          Click to play — left digs, right places
        </div>
      </Show>
      <Show when={isGame()}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: "14px",
            height: "14px",
            margin: "-7px 0 0 -7px",
            "pointer-events": "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: "6px",
              top: "0",
              width: "2px",
              height: "14px",
              background: "rgba(255,255,255,0.8)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "0",
              top: "6px",
              width: "14px",
              height: "2px",
              background: "rgba(255,255,255,0.8)",
            }}
          />
        </div>
        <Show when={underwater()}>
          <div
            style={{
              position: "absolute",
              inset: "0",
              background: "rgba(26, 89, 140, 0.45)",
              "pointer-events": "none",
            }}
          />
        </Show>
        <Show when={coarse()}>
          <TouchControls input={input} />
        </Show>
      </Show>
      <header class={styles.header}>
        <h1 class={styles.title}>bm-sculpt</h1>
        <p class={styles.subtitle}>
          <Show
            when={spike()}
            fallback={
              <Show
                when={edit()}
                fallback="Game — first-person mountains, dig and place"
              >
                Phase 4 — chunked surface nets, streamed in workers
              </Show>
            }
          >
            Phase 0 spike — renderer, packed vertices, sampler3D
          </Show>
        </p>
        <dl class={styles.readout}>
          <div class={styles.row}>fragment precision: {precisionText()}</div>
          <div class={styles.row}>
            vertex layout: float32x3 + snorm16x2 + unorm8x4 = {VERTEX_BYTES} B
          </div>
          <div class={styles.row}>
            level of detail:{" "}
            {bands() === undefined
              ? "default (full within 1 chunk, coarse within 2)"
              : describeBands(bands() as LodBands)}
          </div>
          <Show when={isGame()}>
            <div class={styles.row}>
              clouds: {describeCloudStatus(cloudStatus())}
            </div>
          </Show>

          <Show when={spikeCounts()}>
            {(counts) => (
              <div class={styles.row}>
                vertices: {counts().sphere} sphere, {counts().box} box
              </div>
            )}
          </Show>

          <Show when={stats()}>
            {(value) => (
              <>
                <div class={styles.row}>
                  chunks: {value().filled}/{value().chunks} filled,{" "}
                  {value().drawn} drawn
                </div>
                <div class={styles.row}>
                  triangles: {value().triangles.toLocaleString()} · workers:{" "}
                  {value().busy} busy, {value().pending} pending,{" "}
                  {value().queued} queued
                </div>
                <Show when={history().undo > 0 || history().redo > 0}>
                  <div class={styles.row}>
                    history: {history().undo} undoable, {history().redo}{" "}
                    redoable
                  </div>
                </Show>
              </>
            )}
          </Show>
        </dl>
        <p class={styles.hints}>
          <Show
            when={!spike()}
            fallback={
              <>
                drag or right-drag to orbit · shift-drag or middle-drag to pan ·
                wheel or pinch to dolly · <a href="?">game</a>
              </>
            }
          >
            <Show
              when={edit()}
              fallback={
                <>
                  WASD move · mouse look · space jump · left digs · right places
                  · ctrl-z undo · / for commands · <a href="?edit">editor</a> ·{" "}
                  <a href="?spike">spike</a>
                </>
              }
            >
              drag to sculpt · right-drag to orbit · shift-drag to pan · ctrl-z
              undo · <a href="?">game</a> · <a href="?spike">spike</a>
            </Show>
          </Show>
        </p>
      </header>
      {/* Last, so it paints over the crosshair and the click-to-play prompt
          without either needing a z-index of its own. The game scene only: its
          commands are the player's, and an editor with no player to fly would
          be a console of usage errors. */}
      <Show when={isGame()}>
        <Console terminal={terminal} input={input} />
      </Show>
    </div>
  );
}
