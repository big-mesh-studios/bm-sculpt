/**
 * The canvas, the renderer, the scene, the camera, and a camera controller.
 *
 * ## Why this file exists rather than being shared with the landscape
 *
 * **Because the two applications have no camera in common.** The landscape orbits a
 * point 900 units above an infinite world, with a pitch limit, a pinch threshold and a
 * pan; this orbits a model a person is holding, which needs a radius measured against the
 * model's own size, a target that is the model's centre rather than the origin, and a
 * framing that survives a model changing size. Sharing one controller would mean a
 * `radiusAtZoom` and a `minRadius` in its options, which is the shape of a file that was
 * split for tidiness rather than because it was the same thing.
 *
 * `createViewport` is close to the landscape's and is written out again for the same
 * reason. It is fifty lines, and the alternative is a package whose only export is a
 * camera.
 *
 * ## The sizing rule
 *
 * The canvas backing store is in device pixels and the CSS size is in layout pixels, and
 * those are not the same number on any display worth supporting. Multiplying by the
 * device pixel ratio is half of it; **clamping the ratio is the other half**, because a
 * phone reporting a ratio of 3 with a CSS width of 400 asks for a 1200-wide buffer to
 * draw a model that occupies two hundred pixels of it.
 */
import {
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "@random-mesh/rmsl/scene";

/** The field of view, in degrees. */
export const FOV_Y = 45;

/**
 * The largest backing store either axis is allowed to reach.
 *
 * **A phone held in landscape with a ratio of 3 asks for a very large buffer**, and the
 * cost is fill rate rather than anything the model does. Halving the ratio costs a
 * little sharpness at the far end and saves a great deal of time in the middle.
 */
export const MAX_PIXEL_RATIO = 2;

export interface Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** The ratio the backing store is at, for a readout or an adaptive scaler. */
  readonly pixelRatio: () => number;
  /** Sizes the backing store and the camera's aspect. Call on every resize. */
  readonly resize: () => void;
  readonly render: () => void;
  readonly dispose: () => void;
}

export const createViewport = (canvas: HTMLCanvasElement): Viewport => {
  // The canvas is the renderer's first argument, not an option — this library's
  // `WebGLRenderer` takes it positionally.
  const renderer = new WebGLRenderer(canvas, { antialias: true, depth: true });
  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV_Y, 1, 0.01, 8000);

  let pixelRatio = 1;
  const resize = (): void => {
    // A `ResizeObserver` rather than a window resize listener, because the canvas is
    // sized by whatever box the layout gives it and that box changes for reasons a
    // window resize never hears about — a panel opening, the browser chrome sliding in
    // for a keyboard.
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    // **The backing store is written directly rather than through `setSize`**, because
    // there is no `setPixelRatio` in this library: the canvas *is* the backing store,
    // and its `width`/`height` are device pixels while its CSS size is layout pixels.
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      renderer.setSize(width, height);
    }
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  return {
    renderer,
    scene,
    camera,
    canvas,
    pixelRatio: () => pixelRatio,
    resize,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
  };
};

/** How the camera is looking at the model. */
export interface OrbitState {
  readonly theta: number;
  readonly phi: number;
  readonly radius: number;
  readonly target: { readonly x: number; y: number; z: number };
}

/** The limits a hand sets more easily than a mouse does, all in world units. */
export interface OrbitLimits {
  /** How far in the camera may come. Never inside the model. */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Radians of turn per pixel of drag. */
  readonly rotateSpeed: number;
  /** How much of a radius change a doubling of the finger span makes. */
  readonly pinchSpeed: number;
  /** Below this many units between two fingers, the gesture is two fingers touching. */
  readonly pinchThreshold: number;
}

export const DEFAULT_ORBIT: OrbitLimits = {
  minRadius: 0.4,
  maxRadius: 400,
  // **Faster than the landscape's, because the model is small.** The same number that
  // turns a chunk of terrain a comfortable amount turns a figure's head through 180°,
  // which is the difference between a control that feels precise and one that feels
  // broken.
  rotateSpeed: 0.008,
  pinchSpeed: 1,
  pinchThreshold: 0.2,
};

export interface OrbitController {
  readonly state: () => OrbitState;
  /**
   * Whether the camera answers the pointer.
   *
   * **This is how the move tool and the camera share one canvas.** Both want the same
   * pointer, and there is no event a handle drag can claim exclusively — so the move tool
   * turns the camera off for the duration of a drag and turns it back on when the finger
   * lifts. Early-returns inside the controller rather than an `enabled` flag read at the top
   * of `onMove`, because a flag that is only checked on move still lets the controller take
   * the pointer capture on the way down, and two captures on one element fight.
   */
  readonly setInteractive: (interactive: boolean) => void;
  /** Points the camera at a model of this size, framing it. */
  readonly frame: (
    centre: { x: number; y: number; z: number },
    size: number,
  ) => void;
  readonly attach: (element: HTMLElement) => () => void;
  readonly dispose: () => void;
}

const PITCH_LIMIT = Math.PI / 2 - 0.01;

export const createOrbit = (
  camera: PerspectiveCamera,
  limits: OrbitLimits = DEFAULT_ORBIT,
): OrbitController => {
  let state: OrbitState = {
    theta: 0.6,
    phi: 1.1,
    radius: 6,
    target: { x: 0, y: 0, z: 0 },
  };
  let interactive = true;

  const apply = (): void => {
    const sinPhi = Math.sin(state.phi);
    camera.position.set(
      state.target.x + state.radius * sinPhi * Math.sin(state.theta),
      state.target.y + state.radius * Math.cos(state.phi),
      state.target.z + state.radius * sinPhi * Math.cos(state.theta),
    );
    camera.lookAt(state.target.x, state.target.y, state.target.z);
  };

  const controller: OrbitController = {
    state: () => state,

    setInteractive: (on) => {
      interactive = on;
    },

    frame: (centre, size) => {
      const reach = Math.max(size, limits.minRadius * 4);
      state = {
        ...state,
        target: { ...centre },
        // **Framed by the model's own size, not a fixed radius.** A fixed distance shows a
        // sphere of one unit as a speck and a figure of forty as a wall, and a modeller
        // works with both. `1.8` is a little air on each side at a 45° field of view.
        radius: Math.min(
          limits.maxRadius,
          Math.max(limits.minRadius, reach * 1.8),
        ),
      };
      apply();
    },

    attach: (element) => {
      // **Its own map of pointer ids to element-local positions.** A pinch needs the span
      // between two fingers measured in the canvas's own coordinates, and the shared
      // `pointer()` helper follows exactly one pointer per call and reports client
      // coordinates — so this is deliberately not that helper. See ADR 0026.
      const pointers = new Map<number, { x: number; y: number }>();
      let pinch = 0;
      let detached = false;

      const local = (event: PointerEvent): { x: number; y: number } => {
        const rect = element.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      };
      const spread = (): number => {
        const [a, b] = [...pointers.values()];
        return a === undefined || b === undefined
          ? 0
          : Math.hypot(a.x - b.x, a.y - b.y);
      };

      const onDown = (event: PointerEvent): void => {
        if (!interactive) return;
        element.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, local(event));
        pinch = spread();
      };

      const onMove = (event: PointerEvent): void => {
        if (!interactive) return;
        const previous = pointers.get(event.pointerId);
        if (previous === undefined) return;
        const current = local(event);
        pointers.set(event.pointerId, current);

        if (pointers.size >= 2) {
          const now = spread();
          // Two fingers that are merely touching should not move the camera. The
          // threshold is in world units because the fingers are not.
          if (pinch > limits.pinchThreshold) {
            state = {
              ...state,
              // Spreading the fingers pulls the camera in, so the radius scales by the
              // inverse of the ratio of spans.
              radius: Math.min(
                limits.maxRadius,
                Math.max(
                  limits.minRadius,
                  (state.radius * pinch) / Math.max(now, 1e-6),
                ),
              ),
            };
          }
          pinch = now;
          apply();
          return;
        }

        const dx = current.x - previous.x;
        const dy = current.y - previous.y;
        state = {
          ...state,
          theta: state.theta - dx * limits.rotateSpeed,
          phi: Math.max(
            -PITCH_LIMIT,
            Math.min(PITCH_LIMIT, state.phi - dy * limits.rotateSpeed),
          ),
        };
        apply();
      };

      const release = (event: PointerEvent): void => {
        pointers.delete(event.pointerId);
        if (element.hasPointerCapture(event.pointerId)) {
          element.releasePointerCapture(event.pointerId);
        }
      };

      element.addEventListener("pointerdown", onDown);
      element.addEventListener("pointermove", onMove);
      element.addEventListener("pointerup", release);
      element.addEventListener("pointercancel", release);

      return () => {
        if (detached) return;
        detached = true;
        element.removeEventListener("pointerdown", onDown);
        element.removeEventListener("pointermove", onMove);
        element.removeEventListener("pointerup", release);
        element.removeEventListener("pointercancel", release);
      };
    },

    dispose: () => {
      // Nothing of its own to free: the listeners are removed by the detach the caller
      // holds, and the camera belongs to the viewport.
    },
  };

  apply();
  return controller;
};
