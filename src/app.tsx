/**
 * The Phase 0 spike scene: three questions, one page.
 *
 * Left is a sphere with smooth per-vertex normals. Its normals travel as two
 * signed 16-bit channels and are unfolded in the vertex shader, so if that fold
 * is wrong the sphere shades lumpy and faceted — a smooth surface is the visual
 * proof that it is right. Right is a box, whose six faces each carry one normal
 * and one colour, which is the other half of the proof: a decode that merely
 * round-trips would make the box shade smooth, and this one must not.
 *
 * Behind both is a 16³ volume addressed in world space through a `sampler3D`.
 * The sphere and the box are cut by it, and what is not covered is darkened
 * toward the volume's own colour, so the volume is visible as a shape in space
 * rather than as a pattern painted onto the surfaces — the difference between a
 * bound `sampler3D` and a bound `sampler2D` on the same bytes.
 *
 * The header reports what the device said about its fragment precision, which
 * is the third question. A `highp` fragment qualifier is dropped silently where
 * it is unsupported, so the only way to know is to ask before drawing.
 */

import { createSignal, onCleanup, onSettled, Show } from "solid-js";
import { Color, Mesh } from "@random-mesh/rmsl/scene";
import { OrbitController } from "./controls/orbit-camera";
import {
  describePrecision,
  detectFragmentPrecision,
  type PrecisionProbe,
} from "./render/precision";
import { SurfaceMaterial } from "./render/surface-material";
import {
  buildBox,
  buildSphere,
  toGeometry,
  VERTEX_BYTES,
} from "./render/spike-geometry";
import { buildSpikeVolume } from "./render/spike-volume";
import { createViewport, type Viewport } from "./render/viewport";
import styles from "./app.module.css";

const SPHERE_SEGMENTS = 64;
const SPHERE_RINGS = 32;

export default function App() {
  let canvas!: HTMLCanvasElement;
  const [precision, setPrecision] = createSignal<PrecisionProbe | undefined>();
  const [geometry] = createSignal(() => {
    const sphere = buildSphere(230, SPHERE_SEGMENTS, SPHERE_RINGS, {
      r: 236,
      g: 214,
      b: 168,
    });
    const box = buildBox({ x: 170, y: 170, z: 170 }, [
      { r: 214, g: 96, b: 84 },
      { r: 158, g: 70, b: 64 },
      { r: 236, g: 152, b: 96 },
      { r: 168, g: 108, b: 72 },
      { r: 132, g: 168, b: 214 },
      { r: 92, g: 126, b: 176 },
    ]);
    return {
      sphere: toGeometry(sphere),
      box: toGeometry(box),
      counts: { sphere: sphere.vertexCount, box: box.vertexCount },
    };
  });

  // Solid 2 replaced `onMount` with `onSettled`, which schedules once after the
  // current activity settles and returns the disposal. One call now covers what
  // used to need two.
  onSettled(() => {
    const measured = detectFragmentPrecision();
    setPrecision(measured);
    // The console too, because "the probe failed" is the answer to a question this
    // scene was built to settle, and a readout in a corner of a canvas is easy to miss
    // and impossible to copy out of a screenshot.
    if (!measured.ok) console.warn("fragment precision probe:", measured.reason);

    const viewport: Viewport = createViewport(canvas, {
      // A failed probe leaves the renderer's own default in place, which is the same
      // outcome the previous `undefined` meant — but the readout now says why.
      ...(measured.ok ? { precision: measured.precision } : {}),
    });
    viewport.setBackground(new Color(0.07, 0.07, 0.09));

    const material = new SurfaceMaterial();
    material.volume = buildSpikeVolume();

    const sphere = new Mesh(geometry().sphere, material);
    sphere.position.set(-330, 0, 0);
    const box = new Mesh(geometry().box, material);
    box.position.set(330, 0, 0);
    viewport.scene.add(sphere, box);

    const orbit = new OrbitController(viewport.camera, { radius: 1150 });
    const detach = orbit.attach(canvas);
    orbit.apply();

    // The loop is driven by the renderer rather than by a bare
    // `requestAnimationFrame`, so stopping it is one call on the object that
    // owns the handle instead of a handle this file has to keep and cancel.
    viewport.renderer.setAnimationLoop(() => {
      orbit.apply();
      viewport.render();
    });

    onCleanup(() => {
      detach();
      sphere.geometry.dispose();
      box.geometry.dispose();
      material.volume?.dispose();
      viewport.dispose();
    });
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />
      <header class={styles.header}>
        <h1 class={styles.title}>bm-sculpt</h1>
        <p class={styles.subtitle}>
          Phase 0 — chunked surface-nets sculpting, in the browser
        </p>
        <dl class={styles.readout}>
          <Show
            when={precision()}
            fallback={<div class={styles.row}>fragment precision: not probed yet</div>}
          >
            {(value) => (
              <div class={styles.row}>fragment precision: {describePrecision(value())}</div>
            )}
          </Show>
          <div class={styles.row}>
            vertex layout: float32x3 + snorm16x2 + unorm8x4 = {VERTEX_BYTES} B
          </div>
          <div class={styles.row}>
            vertices: {geometry().counts.sphere} sphere, {geometry().counts.box}{" "}
            box
          </div>
        </dl>
        <p class={styles.hints}>
          drag to orbit · shift-drag or right-drag to pan · wheel or pinch to
          dolly
        </p>
      </header>
    </div>
  );
}
