/**
 * The application shell: a canvas, a parts list, a primitive picker, and the selected
 * part's transform.
 *
 * ## Why the mesh is rebuilt on a timer rather than on every edit
 *
 * **Because meshing a model is tens of milliseconds and a drag sends a change a frame.**
 * The rebuild is debounced, so a drag that moves a part continuously shows the model
 * updating a few times a second rather than re-meshing on every pointer move. On a phone
 * that is the difference between a control that follows a finger and one that does not.
 *
 * The mesh is the *result* of the model and never the model itself, so a mesh a few tens
 * of milliseconds behind is a picture that is briefly late rather than a state that
 * disagrees with itself.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  Show,
} from "solid-js";
import { PRIMITIVE_NAMES } from "@big-mesh-studios/sdf";

import { DEFAULT_BUDGET, meshModel } from "./model/mesh-model";
import { modelBounds } from "./model/part";
import { createModelStore } from "./model/model-store";
import {
  createOrbit,
  createViewport,
  type OrbitController,
} from "./view/viewport";
import { createModelView, type ModelView } from "./view/model-view";
import { PartsPanel } from "./ui/parts-panel";
import { TransformPanel } from "./ui/transform-panel";
import styles from "./app.module.css";

/** How long the model has to be still before it is re-meshed, in milliseconds. */
const REBUILD_MS = 90;

export function App() {
  let canvas!: HTMLCanvasElement;

  const store = createModelStore([
    {
      // **A starting model rather than an empty scene**, because an empty canvas with an
      // empty list tells a first-time visitor nothing about what the application is. One
      // capsule is the smallest figure that reads as a figure.
      id: "body",
      shape: { type: "Capsule", len: 2.2, radius: 0.7 },
      origin: { x: 0, y: 1.1, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
  ]);

  const [status, setStatus] = createSignal("meshing…");

  // **Assigned inside `onSettled` and read outside it, which is the shape this needs.**
  //
  // The renderer cannot be built in the component body, because `ref={canvas}` is
  // assigned *after* the body runs: at that point `canvas` is still `undefined`, and
  // `createViewport` hands it straight to `ResizeObserver.observe`, which throws
  // "parameter 1 is not of type 'Element'". So everything that needs the canvas waits
  // for the DOM.
  //
  // The rebuild reads them from outside, which is why they are declared here and
  // assigned later — and why `rebuild` has to cope with them not existing yet.
  let view: ModelView | undefined;
  let orbit: OrbitController | undefined;

  let pending: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0;

  const rebuild = (): void => {
    // The canvas may not be up yet, in which case the effect that drives this fires
    // before there is anything to mesh into. `onSettled` triggers the first rebuild
    // itself once there is.
    //
    // **Taken into locals rather than read through the outer `let`s inside the timeout.**
    // The guard narrows `view` and `orbit` here, but the narrowing does not reach a
    // closure — and reading the outer variables inside the callback would also mean a
    // rebuild that lands after teardown installs into a disposed renderer.
    const target = view;
    const camera = orbit;
    if (target === undefined || camera === undefined) return;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      const started = performance.now();
      const result = meshModel(store.parts(), DEFAULT_BUDGET);
      target.install(result);
      elapsed = performance.now() - started;

      const bounds = modelBounds(store.parts());
      if (bounds !== undefined) {
        const size = Math.max(
          bounds.max.x - bounds.min.x,
          bounds.max.y - bounds.min.y,
          bounds.max.z - bounds.min.z,
        );
        camera.frame(
          {
            x: (bounds.min.x + bounds.max.x) / 2,
            y: (bounds.min.y + bounds.max.y) / 2,
            z: (bounds.min.z + bounds.max.z) / 2,
          },
          size,
        );
      }

      const count = store.parts().length;
      setStatus(
        result === undefined
          ? "no parts yet — add one below"
          : `${count} part${count === 1 ? "" : "s"} · ${result.triangles} triangles · ${Math.round(result.samples / 1000)}k samples · ${Math.round(elapsed)} ms`,
      );
    }, REBUILD_MS);
  };

  // **Two functions, because Solid 2's `createEffect` takes a compute and an effect.**
  // The single-function form is Solid 1 and throws `MISSING_EFFECT_FN` at runtime while
  // type-checking perfectly, because the type is a pair of optional-looking arguments.
  //
  // Splitting them is also the clearer shape here: the first says *what to watch* and the
  // second says *what to do about it*. Under Solid 1's form both were in one closure, and
  // the dependency was invisible — a reader could not tell that reading `store.parts()`
  // and discarding the result was the entire mechanism.
  createEffect(
    () => store.parts(),
    () => rebuild(),
  );

  // **Solid 2 replaced `onMount` with `onSettled`**, which fires once after the current
  // activity settles rather than on mount, and which does *not* return a disposal: the
  // callback returns the teardown itself. `onCleanup` *inside* one is a dev-mode error
  // that halts the reactive system, so the two halves of the lifecycle live in this one
  // block and the block's last statement is its own undo.
  onSettled(() => {
    const viewport = createViewport(canvas);
    const created = createModelView(viewport.scene);
    const controller = createOrbit(viewport.camera);
    view = created;
    orbit = controller;

    const detach = controller.attach(canvas);
    viewport.renderer.setAnimationLoop(() => viewport.render());

    // The first mesh, now that there is a scene to put it in. The effect above may have
    // run before this and found nothing to do.
    rebuild();

    return () => {
      if (pending !== undefined) clearTimeout(pending);
      detach();
      created.dispose();
      viewport.dispose();
      // Cleared, so a rebuild arriving after teardown cannot reach a disposed renderer.
      view = undefined;
      orbit = undefined;
    };
  });

  const selected = createMemo(() => {
    const id = store.selected();
    return id === undefined ? undefined : store.part(id);
  });

  return (
    <div class={styles.root}>
      <canvas ref={canvas} class={styles.canvas} />

      <header class={styles.header}>
        <h1 class={styles.title}>sdf-modeller</h1>
        <p class={styles.status}>{status()}</p>
      </header>

      <Show when={selected()}>
        {(part) => <TransformPanel part={part()} store={store} />}
      </Show>

      <PartsPanel store={store} primitives={PRIMITIVE_NAMES} />

      <footer class={styles.footer}>
        <button
          type="button"
          class={styles.action}
          disabled={!store.canUndo()}
          onClick={() => {
            store.undo();
          }}
        >
          Undo
        </button>
        <button
          type="button"
          class={styles.action}
          disabled={!store.canRedo()}
          onClick={() => {
            store.redo();
          }}
        >
          Redo
        </button>
        <span class={styles.hint}>drag to orbit · pinch to zoom</span>
      </footer>
    </div>
  );
}
