/**
 * The canvas, the renderer, the scene and the camera, and the size bookkeeping
 * that keeps them agreeing with each other.
 *
 * Two things here are worth knowing about this library. There is no
 * `setPixelRatio`: the canvas is sized by writing `width` and `height`, which
 * this does once per resize rather than per frame. And `render()` does not drive
 * a loop — `setAnimationLoop` is available and is a thin re-arm of
 * `requestAnimationFrame`, which this uses so the browser is the only thing
 * deciding when a frame happens.
 *
 * The sizing rule is the one every renderer of this kind wants and most get
 * wrong: the canvas backing store is in device pixels and the CSS size is in
 * layout pixels, and the two are not the same number on any display worth
 * supporting. Multiplying by the ratio is only half of it — clamping the ratio
 * is the other half, because a 3x phone reporting a device pixel ratio of 3 and
 * a CSS width of 400 asks for a 1200-wide buffer to draw a model that occupies
 * two hundred pixels of it, and the adaptive scaler downstream is then handed a
 * frame time inflated by drawing resolution nothing will ever see.
 */

import {
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Color,
} from "@random-mesh/rmsl/scene";
import type { Precision } from "./precision";

/** The field of view, in degrees. Matches what the application being replaced used. */
export const FOV_Y = 50;

export interface Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /**
   * The ratio the canvas backing store is at relative to its CSS size. The
   * adaptive scaler multiplies this rather than replacing it.
   */
  pixelRatio: number;
  /** Points the camera at, and the frame it is drawn in. */
  setBackground(colour: Color | number): void;
  /** Draws one frame. */
  render(): void;
  /** Puts the canvas back the way it was found. */
  dispose(): void;
}

export interface ViewportOptions {
  precision?: Precision;
  /**
   * Whether to ask for a multisampled drawing buffer. Off by default: the
   * adaptive scaler exists to spend resolution where it shows, and an
   * antialiased buffer spends it on edges of geometry this project is about to
   * change anyway.
   */
  antialias?: boolean;
  /**
   * The largest device pixel ratio to render at. Two rather than three because
   * this project's target is a laptop several years old, where a 3x buffer
   * costs two and a half times the fill rate of a 2x one for detail the scaler
   * has already decided is not worth drawing.
   */
  maxPixelRatio?: number;
}

export const createViewport = (
  canvas: HTMLCanvasElement,
  options: ViewportOptions = {},
): Viewport => {
  const renderer = new WebGLRenderer(canvas, {
    antialias: options.antialias ?? false,
    depth: true,
    ...(options.precision !== undefined
      ? { precision: options.precision }
      : {}),
  });

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV_Y, 1, 1, 400000);
  camera.position.set(0, 0, 900);

  const maxPixelRatio = options.maxPixelRatio ?? 2;
  const viewport: Viewport = {
    renderer,
    scene,
    camera,
    pixelRatio: 1,
    setBackground(colour) {
      // `Scene.background` is declared by this library's Scene and then never
      // read by its renderer: `render()` clears from the colour given to
      // `setClearColor` and nothing else. Setting the scene's field would
      // therefore clear to whatever the renderer was last told, which is the
      // kind of thing that looks like a bug in the caller.
      renderer.setClearColor(colour, 1);
    },
    render() {
      renderer.render(scene, camera);
    },
    dispose() {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
    },
  };

  // The observer rather than a window resize listener: the canvas is sized by
  // whatever box the layout gives it, and that box changes for reasons a window
  // resize never hears about — a panel opening, the browser chrome sliding in on
  // a mobile keyboard, a container being dragged.
  const sizeTo = (): void => {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    viewport.pixelRatio = ratio;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      renderer.setSize(width, height);
    }
    if (rect.height > 0) {
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    }
  };

  const observer = new ResizeObserver(sizeTo);
  observer.observe(canvas);
  sizeTo();

  return viewport;
};
