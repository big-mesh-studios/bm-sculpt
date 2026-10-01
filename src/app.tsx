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

import { OrbitController } from "./controls/orbit-camera";
import {
  describePrecision,
  detectFragmentPrecision,
  type PrecisionProbe,
} from "./render/precision";
import { SurfaceMaterial } from "./render/surface-material";
import { createViewport, type Viewport } from "./render/viewport";
import { VERTEX_BYTES } from "./render/spike-geometry";
import { Session, starterOperations, type SessionStats } from "./session";
import { DEFAULT_TERRAIN } from "./csg";
import { LOD_OFF, lodIsOff, type LodBands } from "./world";
import { SculptSession } from "./sculpt";
import { DEFAULT_BRUSH } from "./edit/brush";
import { buildSpikeScene, type SpikeScene } from "./spike-scene";
import { createInput } from "./player/input";
import { TouchControls } from "./player/touch-controls";
import { Game } from "./engine/game";
import { createWater, SEA_LEVEL } from "./world/water";
import { createClouds } from "./world/clouds";

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

  // Created here rather than in the settled effect so the touch UI can bind to it
  // and the effect can attach it to the canvas. It listens to nothing until it is
  // attached, so an editor or spike session simply leaves it inert.
  const input = createInput();

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
      // A flatter window than the editor's: a walking player wants ground ahead
      // and a little above, not a ball of sky.
      ...(isGame() ? { radius: 5, yRadius: 2 } : {}),
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
    // the horizon rather than a void.
    viewport.setBackground(new Color(0.45, 0.62, 0.9));
    const game = new Game({
      session,
      sculpt,
      viewport,
      input,
      seaLevel: SEA_LEVEL,
    });
    const water = createWater(viewport.scene, SEA_LEVEL);
    const clouds = createClouds(viewport.scene, DEFAULT_TERRAIN.seed);
    const detachInput = input.attach(canvas);
    const stopLock = input.onPointerLockChange(setLocked);

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
      water.update(game.player.position);
      clouds.update(game.player.position, time / 1000);
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
      stopLock();
      detachInput();
      water.dispose();
      clouds.dispose();
      session.dispose();
      viewport.dispose();
    };
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />
      <Show when={isGame() && !coarse() && !locked()}>
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
                  · ctrl-z undo · <a href="?edit">editor</a> ·{" "}
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
    </div>
  );
}
