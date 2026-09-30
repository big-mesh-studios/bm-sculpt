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

import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Color } from "@random-mesh/rmsl/scene";

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

  // Solid 2 replaced `onMount` with `onSettled`, which schedules once after the current
  // activity settles and returns the disposal. One call now covers what used to need two.
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
    let session: Session | undefined;

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
      session = new Session({
        scene: sessionViewport.scene,
        material,
        operations: starterOperations(),
      });
      viewport = sessionViewport;
      orbit = new OrbitController(sessionViewport.camera, { radius: 900 });
      // The window follows what the camera looks at, not where the camera is: panning is
      // how a user moves around a model, and a window that tracked the eye would scroll
      // the whole world sideways on every dolly.
      // Read through `live` because the animation loop below outlives this block's
      // narrowing: `session` is declared as possibly undefined for the spike branch, and
      // a closure over the narrowed local is the only way both branches can share the
      // loop's shape.
      const live = session;
      follow = () => live.follow(orbit.state.target);
      disposeScene = () => {
        live.dispose();
        sessionViewport.dispose();
      };
    }

    const detach = orbit.attach(canvas);
    orbit.apply();

    let lastReadout = 0;
    viewport.renderer.setAnimationLoop((time: number) => {
      orbit.apply();
      follow();
      viewport.render();

      if (!spike() && time - lastReadout > READOUT_INTERVAL_MS) {
        lastReadout = time;
        setStats(session?.stats());
      }
    });

    onCleanup(() => {
      detach();
      disposeScene();
    });
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
          <div class={styles.row}>
            fragment precision:{" "}
            <Show when={precision()} fallback={<>not probed yet</>}>
              {(value) => describePrecision(value())}
            </Show>
          </div>
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
          drag to orbit · shift-drag or right-drag to pan · wheel or pinch to
          dolly{" "}
          <Show when={!spike()}>
            · <a href="?spike">phase 0 spike</a>
          </Show>
        </p>
      </header>
    </div>
  );
}
