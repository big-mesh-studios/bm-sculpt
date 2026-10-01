/**
 * The application shell: a canvas, a header, and whichever scene the URL asks for.
 *
 * Two scenes, and the switch is a query parameter rather than a build flag. The spike at
 * `?spike` is the diagnostic that proved the renderer, the packed vertex layout and the
 * octahedral fold; the application draws chunks with the same material and the same
 * layout, so when something looks wrong the first question is which of the two broke it.
 * A spike behind a build flag is a spike that stops being rebuilt.
 *
 * The frame loop is here rather than in either scene, because it is the same loop for
 * both: follow the camera, then draw. All that differs is what "follow" means — the
 * session's chunk window tracks the orbit target, and the spike has nothing to stream.
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
import { SculptSession } from "./sculpt";
import { DEFAULT_BRUSH } from "./edit/brush";
import { buildSpikeScene, type SpikeScene } from "./spike-scene";

import styles from "./app.module.css";

/** How often the header is refreshed. A frame's worth of churn is unreadable. */
const READOUT_INTERVAL_MS = 250;

const isSpike = (): boolean =>
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("spike");

export default function App() {
  let canvas!: HTMLCanvasElement;
  const [precision, setPrecision] = createSignal<PrecisionProbe | undefined>();
  const [stats, setStats] = createSignal<SessionStats | undefined>();
  const [spikeCounts, setSpikeCounts] = createSignal<
    SpikeScene["counts"] | undefined
  >();
  const [spike] = createSignal(isSpike());
  const [history, setHistory] = createSignal({ undo: 0, redo: 0 });

  // A memo rather than a `<Show>` with a narrowed child, because `<Show>` calls its children
  // function with tracking switched off. Reading the narrowed accessor *in the return
  // position* — `{(probe) => describePrecision(probe())}` — therefore reads the signal
  // untracked: a dev-mode STRICT_READ_UNTRACKED warning, and a row that would silently
  // never update if the probe landed after the first render. Every other read of a narrowed
  // accessor here is inside JSX, which compiles to a deferred insert and is tracked; this one
  // was the exception, and the compiler output is what showed it.
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
    // The console too, because "the probe failed" is the answer to a question this
    // application was partly built to settle, and a readout in the corner of a canvas is
    // easy to miss and impossible to copy out of a screenshot.
    if (!measured.ok)
      console.warn("fragment precision probe:", measured.reason);

    let viewport: Viewport;
    let orbit: OrbitController;
    let disposeScene: () => void;
    let follow: () => void;
    /**
     * Streams whatever the stroke in progress has grown, once per frame.
     *
     * A no-op for the spike, which has no model to stream. Separate from `follow` because
     * the two answer different questions — where the window is, and what the model is — and
     * lumping them together would hide a per-frame cost inside a function named for a
     * scroll.
     */
    let streamStroke: () => void = () => {};
    let session: Session | undefined;
    let detachPointer: () => void = () => {};

    if (spike()) {
      const scene = buildSpikeScene(canvas, measured);
      viewport = scene.viewport;
      orbit = scene.orbit;
      setSpikeCounts(scene.counts);
      disposeScene = () => scene.dispose();
      follow = () => {};
    } else {
      const sessionViewport: Viewport = createViewport(canvas, {
        ...(measured.ok ? { precision: measured.precision } : {}),
      });
      sessionViewport.setBackground(new Color(0.07, 0.07, 0.09));

      const material = new SurfaceMaterial();
      // The preview is its own material rather than the surface's, so it reads as a tool
      // and not as part of the model: unlit, and unaffected by anything in the field.
      const previewMaterial = new MeshBasicMaterial({
        color: new Color(1, 0.85, 0.4),
      });

      session = new Session({
        scene: sessionViewport.scene,
        material,
        operations: starterOperations(),
        // The world the operations are carved out of. Passing it to the session and reading
        // it back off `session.terrain` for the picker is deliberate: one source for the
        // four numbers, so the field the brush traces and the field the workers mesh cannot
        // disagree about where the ground is (ADR 0009).
        terrain: DEFAULT_TERRAIN,
      });

      // Seeded from the session's own operations rather than calling `starterOperations`
      // again: the picker traces a field, and a field built from anything other than the
      // model on screen is the exact disagreement this design exists to make impossible.
      const sculpt = new SculptSession({
        session,
        camera: sessionViewport.camera,
        operations: session.operations,
        terrain: session.terrain,
      });

      const preview = new Mesh(
        new SphereGeometry(DEFAULT_BRUSH.radius, 24, 16),
        previewMaterial,
      );
      preview.visible = false;
      sessionViewport.scene.add(preview);

      viewport = sessionViewport;
      orbit = new OrbitController(sessionViewport.camera, { radius: 900 });

      // Read through `live` because the animation loop below outlives this block's
      // narrowing: `session` is declared as possibly undefined for the spike branch, and
      // a closure over the narrowed local is the only way both branches can share the
      // loop's shape.
      const live = session;
      follow = () => {
        // The window follows what the camera looks at, not where the camera is: panning is
        // how a user moves around a model, and a window that tracked the eye would scroll
        // the whole world sideways on every dolly.
        live.follow(orbit.state.target);

        const where = sculpt.preview;
        preview.visible = where.visible;
        if (where.visible) {
          preview.position.set(
            where.position.x,
            where.position.y,
            where.position.z,
          );
        }
        // One sphere of unit radius scaled to the brush, so changing the size costs no
        // geometry and no rebuild.
        preview.scale.setScalar(sculpt.settings.radius / DEFAULT_BRUSH.radius);
      };
      // On the frame rather than on the pointer, so a fast drag's worth of dabs becomes one
      // model send instead of one per dab. Sending a model cancels every mesh in flight, so
      // the difference is not only cost: a per-dab send can cancel a chunk faster than it
      // meshes and leave it blank for as long as the pointer is down.
      streamStroke = () => sculpt.flushPreview();
      disposeScene = () => {
        live.dispose();
        preview.geometry.dispose();
        sessionViewport.dispose();
      };

      // Left drags sculpt. Right-drag, shift-drag and the middle button navigate, so a
      // drag can never do two things at once — and the orbit controller is told that a tool
      // has the left button, since it listens on the same element.
      const pointerOptions = () => ({
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      });

      // Every pointer currently down, so a second finger can be recognised as navigation
      // rather than as a second brush. On a touch screen it arrives as `button === 0`, the
      // same as the first, so nothing about the event itself distinguishes the two.
      const down = new Set<number>();
      /** The pointer whose press began the stroke, and so whose release ends it. */
      let sculptPointer: number | undefined;

      const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || event.shiftKey) return;
        down.add(event.pointerId);
        // The first finger owns the stroke. Later ones are navigation.
        sculptPointer ??= event.pointerId;
        // Every finger is offered to the tool, which ignores a press while a stroke is
        // already down — that invariant is its own, not something to re-derive here.
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

      /**
       * A pointer is no longer down, one way or another.
       *
       * `abandon` covers the two ways a gesture can end without having been finished: the
       * pointer leaving the canvas still held, and the browser cancelling it to do something
       * of its own. Both throw the stroke away, because half a gesture is not what the user
       * meant. An ordinary release commits it.
       *
       * Only the pointer that *began* the stroke can end it. A second finger lifting on its
       * own is the user going back to painting, not finishing — treating that as the end
       * would commit half of what they drew and silently drop the rest.
       */
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

      const onPointerUp = (event: PointerEvent): void => {
        release(event.pointerId, false);
      };
      const onPointerCancel = (event: PointerEvent): void => {
        // The browser has taken the pointer for something else — a scroll, a system gesture
        // — so this gesture is not going to finish and must not be committed as though it
        // had. Without this the pointer stays in `down` for ever and no later stroke can
        // ever end.
        release(event.pointerId, true);
      };
      const onPointerLeave = (event: PointerEvent): void => {
        // **Touch fires this as part of lifting a finger**, immediately after that finger's
        // own `pointerup`. A pointer that is no longer down has already finished, and
        // treating the leave as an abandonment throws away a stroke the user completed —
        // which is why touch sculpting committed nothing at all until this was noticed. A
        // mouse dragged off the canvas is still down, and that gesture really was abandoned.
        if (!down.has(event.pointerId)) return;
        release(event.pointerId, true);
      };
      const onKeyDown = (event: KeyboardEvent): void => {
        // Ctrl or cmd, so the same keys work on either platform and so the shortcut a user
        // reaches for first is the one their browser also uses for undo.
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
      // Bubbles, so it is on the window with the release rather than on the canvas with the
      // leave — a cancelled pointer never reaches the element it was captured on.
      window.addEventListener("pointercancel", onPointerCancel);
      canvas.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("keydown", onKeyDown);
      detachPointer = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerCancel);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        window.removeEventListener("keydown", onKeyDown);
      };
    }

    const detach = orbit.attach(canvas);
    orbit.apply();

    let lastReadout = 0;
    viewport.renderer.setAnimationLoop((time: number) => {
      orbit.apply();
      follow();
      // Before the draw, so a frame shows everything the last frame of pointer movement
      // asked for rather than the frame before it.
      streamStroke();
      viewport.render();

      if (!spike() && time - lastReadout > READOUT_INTERVAL_MS) {
        lastReadout = time;
        setStats(session?.stats());
      }
    });

    return () => {
      detachPointer();
      detach();
      disposeScene();
    };
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />
      <header class={styles.header}>
        <h1 class={styles.title}>bm-sculpt</h1>
        <p class={styles.subtitle}>
          <Show
            when={spike()}
            fallback="Phase 4 — chunked surface nets, streamed in workers"
          >
            Phase 0 spike — renderer, packed vertices, sampler3D
          </Show>
        </p>
        <dl class={styles.readout}>
          <div class={styles.row}>fragment precision: {precisionText()}</div>
          <div class={styles.row}>
            vertex layout: float32x3 + snorm16x2 + unorm8x4 = {VERTEX_BYTES} B
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
                  {value().busy} busy, {value().pending} pending
                </div>
                <Show when={history().undo > 0 || history().redo > 0}>
                  <div class={styles.row}>
                    history: {history().undo} undoable, {history().redo}{" "}
                    redoable
                  </div>
                </Show>
                <Show when={value().staleRefusals > 0 || value().failures > 0}>
                  <div class={styles.row}>
                    refused {value().staleRefusals} stale, {value().failures}{" "}
                    failed
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
                wheel or pinch to dolly · <a href="?spike">phase 0 spike</a>
              </>
            }
          >
            drag to sculpt · right-drag to orbit · shift-drag to pan · ctrl-z
            undo · ctrl-shift-z redo
          </Show>
        </p>
      </header>
    </div>
  );
}
