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
import type { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import {
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { PRIMITIVE_NAMES } from "@big-mesh-studios/sdf";
import { pointer } from "@big-mesh-studios/ui/pointer";

import { DEFAULT_BUDGET, meshModel, primitiveMesh } from "./model/mesh-model";
import { modelBounds, placedPart, type Part } from "./model/part";
import { createGhost, type Ghost } from "./view/ghost";
import {
  armUnderPointer,
  distanceDragged,
  type Axis,
  type ScreenPoint,
} from "./view/move-handle";
import { createMoveHandles, type MoveHandles } from "./view/move-handles";
import { createModelStore } from "./model/model-store";
import {
  createOrbit,
  createViewport,
  type OrbitController,
} from "./view/viewport";
import { createModelView, type ModelView } from "./view/model-view";
import { PartsPanel } from "./ui/parts-panel";
import { createPalette } from "./ui/palette";
import { TransformPanel } from "./ui/transform-panel";
import styles from "./app.module.css";

/** How long the model has to be still before it is re-meshed, in milliseconds. */
const REBUILD_MS = 90;

/**
 * The direction one arrow lies along, in the model's own axes.
 *
 * **The model's axes and not the part's**, for the reason on `MoveHandles.place`: a move
 * tool that slid a part along its own turn would send a limb on its side travelling the
 * wrong way.
 */
const unitAlong = (axis: Axis): { x: number; y: number; z: number } =>
  axis === "x"
    ? { x: 1, y: 0, z: 0 }
    : axis === "y"
      ? { x: 0, y: 1, z: 0 }
      : { x: 0, y: 0, z: 1 };

export function App() {
  let canvas!: HTMLCanvasElement;

  /**
   * Which tool the pointer is holding.
   *
   * **Two named tools rather than a "handles up" flag**, because the interesting case is
   * coming back. A single toggle answers "are the handles showing" and leaves the question
   * of what the canvas does instead to be inferred; naming the tools says that with the
   * handles down the canvas is picking and with them up it is moving, which is the whole of
   * what the toolbar is for.
   */
  const [tool, setTool] = createSignal<"select" | "move">("select");

  /**
   * Whether a handle drag is running.
   *
   * **A plain boolean rather than a signal**: nothing renders from it, and a signal would
   * mean a write per frame for a value only a pointer handler ever reads.
   */
  let dragging = false;

  const store = createModelStore([
    placedPart(
      "body",
      // **A starting model rather than an empty scene**, because an empty canvas with an
      // empty list tells a first-time visitor nothing about what the application is. One
      // capsule is the smallest figure that reads as a figure.
      { type: "Capsule", len: 2.2, radius: 0.7 },
      { x: 0, y: 1.1, z: 0 },
    ),
  ]);

  /**
   * The colours this model has used, so a colour can be reached again.
   *
   * **Held here rather than in the panel**, because a panel's memory dies with the panel —
   * and on a phone a width query tears the layout down and rebuilds it on every rotation.
   */
  const palette = createPalette([
    { r: 214, g: 96, b: 84, a: 255 },
    { r: 111, g: 207, b: 151, a: 255 },
    { r: 96, g: 150, b: 214, a: 255 },
  ]);

  const [status, setStatus] = createSignal("meshing…");

  /**
   * Which panel the bottom sheet is showing, on a narrow screen.
   *
   * **One at a time, because two panels side by side on a phone is neither of them.**
   * The parts list needs a list's worth of height and the transform needs a form's worth of
   * width, and a screen cannot give both. Tabs are also the reason the two cannot overlap:
   * on a narrow screen the canvas and the sheet are siblings in one flex column, so the
   * sheet takes height from the canvas rather than being laid over it.
   */
  const [sheet, setSheet] = createSignal<"parts" | "shape">("parts");

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
  let handles: MoveHandles | undefined;
  let ghost: Ghost | undefined;
  let camera: PerspectiveCamera | undefined;

  let pending: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0;

  /**
   * Rebuilds the mesh for `parts`.
   *
   * **The parts are an argument rather than read from the store inside.** A Solid 2 effect's
   * second function is the *effect* callback, and reading a reactive value there warns
   * `STRICT_READ_UNTRACKED` and does not update — which for a mesher means the second edit
   * would mesh the first edit's model. The compute function's value is handed in instead,
   * so the only reactive read happens where it is tracked.
   */
  const rebuild = (parts: readonly Part[]): void => {
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
      const result = meshModel(parts, DEFAULT_BUDGET);
      // **Translucent only if something in the model is.** A mesh cannot say so itself, and
      // an always-transparent material with depth writes off makes a solid self-overlap.
      target.install(
        result,
        parts.some((part) => (part.opacity ?? 1) < 1),
      );
      elapsed = performance.now() - started;

      const bounds = modelBounds(parts);
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

      const count = parts.length;
      setStatus(
        result === undefined
          ? "no parts yet — add one below"
          : `${count} part${count === 1 ? "" : "s"} · ${result.triangles} triangles · ${Math.round(result.samples / 1000)}k samples · ${Math.round(elapsed)} ms`,
      );
    }, REBUILD_MS);
  };

  /**
   * Where the handles stand this frame, or nowhere.
   *
   * **Placed inside the render loop rather than in an effect**, because they depend on the
   * camera's distance as well as on the part, and the camera is not a signal — it changes
   * under a finger, with nothing observable to hang an effect off. An effect would place
   * them when the part changed and leave them the size they were when the view was last
   * orbited, which is a handle that shrinks as you zoom out and never catches up.
   */
  const standHandles = (): void => {
    const controller = orbit;
    const arrows = handles;
    const part = untrack(selected);
    if (controller === undefined || arrows === undefined) return;

    const standing = untrack(tool) === "move" && part !== undefined;
    arrows.setVisible(standing);
    if (part !== undefined)
      arrows.place(part.origin, controller.state().radius);
  };

  /**
   * The pointer's position on the canvas, in CSS pixels from its top left.
   *
   * **CSS pixels rather than device pixels**, and both ends of the comparison are: the
   * projection is given the canvas's CSS size, so a threshold written in pixels is the same
   * physical size on every display rather than half the size of the drawn buffer's.
   */
  const pointerOnCanvas = (event: PointerEvent): ScreenPoint => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /**
   * Takes hold of an arrow, or leaves the press to the camera.
   *
   * **The whole model is left alone until the finger lifts.** The part stays where it is and
   * a copy follows the pointer; the store is written once, on pointer-up, which is what
   * makes the drag one undo entry and one rebuild rather than one per frame.
   */
  const grabHandle = async (
    initial: PointerEvent & { currentTarget: HTMLElement },
  ): Promise<void> => {
    const controller = orbit;
    const arrows = handles;
    const copy = ghost;
    const eye = camera;
    const part = untrack(selected);
    if (
      controller === undefined ||
      arrows === undefined ||
      copy === undefined ||
      eye === undefined ||
      untrack(tool) !== "move" ||
      part === undefined ||
      dragging
    ) {
      return;
    }

    // Placed and measured now rather than read off the last frame, so a grab reads the same
    // picture the finger is looking at even if the camera has moved since the last frame.
    arrows.place(part.origin, controller.state().radius);
    const rect = canvas.getBoundingClientRect();
    const arms = arrows.armsOnScreen(eye, {
      width: rect.width,
      height: rect.height,
    });
    const axis = armUnderPointer(pointerOnCanvas(initial), arms);
    if (axis === undefined) return;

    dragging = true;
    controller.setInteractive(false);
    arrows.setHeld(axis);

    // **The primitive on its own, built once.** See `primitiveMesh`: a drag changes where a
    // part is and never what it is shaped like, so every frame after the first would
    // produce identical vertices.
    copy.show(primitiveMesh(part, DEFAULT_BUDGET)?.mesh, part.origin);

    const start = part.origin;
    const arm = arms.find((candidate) => candidate.axis === axis);
    let moved = start;

    try {
      await pointer(initial, ({ totalDelta }) => {
        if (arm === undefined) return;
        // **The distance is read off the arrow's own screen length**, so it is a fraction of
        // the arrow rather than an independent scale — and it is recomputed from the grab
        // every time rather than accumulated, so a drag that returns to its start returns
        // the part to its start.
        const along = distanceDragged(totalDelta, arm, arrows.armLength());
        const direction = unitAlong(axis);
        moved = {
          x: start.x + direction.x * along,
          y: start.y + direction.y * along,
          z: start.z + direction.z * along,
        };
        copy.moveTo(moved);
        // **The arrows follow the copy**, so the handle under the finger is the handle the
        // finger is on.
        arrows.place(moved, controller.state().radius);
      });
    } finally {
      arrows.setHeld(undefined);
      copy.hide();
      controller.setInteractive(true);
      dragging = false;
    }

    // **One write, on the way out.** Everything above was a proposal.
    if (moved.x !== start.x || moved.y !== start.y || moved.z !== start.z) {
      store.transform(part.id, { origin: moved });
    }
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
    (parts) => rebuild(parts),
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
    const madeHandles = createMoveHandles(viewport.scene);
    const madeGhost = createGhost(viewport.scene);
    view = created;
    orbit = controller;
    handles = madeHandles;
    ghost = madeGhost;
    camera = viewport.camera;

    /**
     * Takes a drag off the camera, or leaves it to the camera.
     *
     * **Attached before `controller.attach`, so that it is the first listener to see a
     * pointer-down.** The order matters: the camera's own handler takes the pointer capture
     * the moment it sees a press, and once it has, a handle drag cannot have it. So the
     * question of which of the two wants this press has to be settled first, and the only
     * way to settle it is to be first.
     */
    const onPointerDown = (event: PointerEvent): void => {
      void grabHandle(event as PointerEvent & { currentTarget: HTMLElement });
    };
    canvas.addEventListener("pointerdown", onPointerDown);

    const detach = controller.attach(canvas);
    viewport.renderer.setAnimationLoop(() => {
      standHandles();
      viewport.render();
    });

    // The first mesh, now that there is a scene to put it in. The effect above may have
    // run before this and found nothing to do.
    //
    // **Read through `untrack`, because this is outside the effect that tracks the parts.**
    rebuild(untrack(() => store.parts()));

    return () => {
      if (pending !== undefined) clearTimeout(pending);
      canvas.removeEventListener("pointerdown", onPointerDown);
      detach();
      madeHandles.dispose();
      madeGhost.dispose();
      created.dispose();
      viewport.dispose();
      // Cleared, so a rebuild arriving after teardown cannot reach a disposed renderer.
      view = undefined;
      orbit = undefined;
      handles = undefined;
      ghost = undefined;
      camera = undefined;
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

      {/*
       **Two named tools, as a radio group, because they are one choice with two answers.**
       *
       * A pair of buttons that each toggled something would leave the question of which
       * tool is current to be answered by which button looks pressed — and "looks pressed"
       * is not an answer a screen reader gives you either. `radiogroup` says out loud that
       * exactly one of these is in effect, which is the truth, and `aria-checked` carries
       * it to assistive technology the same way the appearance does.
       *
       * **The move tool is disabled with nothing selected**, because there is nothing for
       * it to move. Rather than arming a tool that would refuse every press, which teaches
       * the button is broken, it says so.
       */}
      <div class={styles.tools} role="radiogroup" aria-label="Tool">
        {(
          [
            [
              "select",
              "Select",
              "Pick parts. Drag the canvas to turn the view.",
            ],
            [
              "move",
              "Move",
              "Arrow handles on the selected part. Drag one to move it.",
            ],
          ] as const
        ).map(([value, label, hint]) => (
          <button
            type="button"
            role="radio"
            class={styles.tool}
            aria-checked={tool() === value ? "true" : "false"}
            title={hint}
            disabled={value === "move" && selected() === undefined}
            onClick={() => {
              setTool(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/*
        **The tab bar is only ever visible on a narrow screen** — a CSS rule, not a media
        query in the component, so that rotating a phone does not tear the tree down and
        rebuild it (ADR 0026's `Activity` exists for exactly that, and here the layout
        handles itself instead).

        `aria-selected` rather than a class, because it is the same attribute a screen
        reader asks about and the styling hangs off it rather than duplicating the state.
      */}
      <div class={styles.tabs} role="tablist" aria-label="Panels">
        {(
          [
            [
              "parts",
              `Parts${store.parts().length > 0 ? ` (${store.parts().length})` : ""}`,
            ],
            ["shape", "Shape"],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            class={styles.tab}
            aria-selected={sheet() === id ? "true" : undefined}
            onClick={() => {
              setSheet(id);
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <Show when={selected()}>
        {(part) => (
          <div
            class={styles.sheet}
            data-hidden={sheet() === "parts" ? "" : undefined}
          >
            <TransformPanel part={part()} store={store} palette={palette} />
          </div>
        )}
      </Show>

      <div
        class={styles.sheet}
        data-hidden={sheet() === "shape" ? "" : undefined}
      >
        <PartsPanel store={store} primitives={PRIMITIVE_NAMES} />
      </div>

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
