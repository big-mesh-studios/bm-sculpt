/**
 * An orbit camera, hand-rolled.
 *
 * This library ships no `OrbitControls`, and nothing here is a substitute for
 * one: it is the minimum that makes a surface visible and its octahedral normals
 * checkable by eye — drag to orbit, right-drag or shift-drag to pan, wheel or
 * pinch to dolly. The application's own camera grows out of this file, so the
 * spherical arithmetic is kept separate from the event handling and exported for
 * tests that need no DOM.
 *
 * Angles are stored as the camera's own state rather than written into the
 * matrix each frame, so an incoming value can be clamped before it is applied
 * rather than after. That is what keeps a flick past the pole from flipping the
 * view: `clampPhi` is applied on the way in, so the camera never holds an angle
 * it would have to be rescued from.
 */

import type { PerspectiveCamera } from "@random-mesh/rmsl/scene";
import type { Vec3 } from "../math/octahedral";

export interface OrbitLimits {
  minRadius: number;
  maxRadius: number;
  /**
   * How close the camera may come to directly overhead or directly under. Not
   * zero, because at zero the up axis and the view direction are parallel and
   * the roll that keeps the horizon level becomes undefined.
   */
  minPhi: number;
  maxPhi: number;
  /** Radians of orbit per pixel dragged. */
  rotateSpeed: number;
  /** Fraction of the radius a pan moves per pixel dragged. */
  panSpeed: number;
  /** Multiplicative change in radius per notch of wheel, and per pinch. */
  zoomSpeed: number;
  /** Pixels the pointers must separate by before a pinch counts as a zoom. */
  pinchThreshold: number;
}

export const DEFAULT_ORBIT_LIMITS: OrbitLimits = {
  minRadius: 40,
  maxRadius: 20000,
  minPhi: 0.02,
  maxPhi: Math.PI - 0.02,
  rotateSpeed: 0.006,
  panSpeed: 0.0015,
  zoomSpeed: 0.0015,
  pinchThreshold: 8,
};

export interface OrbitState {
  /** Azimuth, around the up axis from the +Z direction. */
  theta: number;
  /** Polar angle from the up axis. */
  phi: number;
  /** Distance from the target. */
  radius: number;
  /** The point the camera looks at. */
  target: Vec3;
}

export const initialOrbitState = (radius = 900): OrbitState => ({
  theta: 0.6,
  phi: Math.PI * 0.38,
  radius,
  target: { x: 0, y: 0, z: 0 },
});

/** Holds `phi` inside the limits, including when a caller overshoots by miles. */
export const clampPhi = (phi: number, limits: OrbitLimits): number =>
  Math.min(limits.maxPhi, Math.max(limits.minPhi, phi));

/** Holds `radius` inside the limits. */
export const clampRadius = (radius: number, limits: OrbitLimits): number =>
  Math.min(limits.maxRadius, Math.max(limits.minRadius, radius));

/**
 * Where a spherical set of angles puts the camera, relative to the target.
 * Y is the up axis, which is the convention every height field and every mesher
 * in this project also uses.
 */
export const orbitOffset = (
  theta: number,
  phi: number,
  radius: number,
): Vec3 => {
  const sinPhi = Math.sin(phi);
  return {
    x: radius * sinPhi * Math.sin(theta),
    y: radius * Math.cos(phi),
    z: radius * sinPhi * Math.cos(theta),
  };
};

/**
 * Where a drag of `dx` by `dy` pixels should move the target, given the radius
 * it is at.
 *
 * Scaling by the radius is what makes a pan feel the same at every distance. The
 * alternative — a pan of so many pixels moving so many world units — is a
 * constant-speed pan, which is unusable across the range of scales an
 * inspector-style view covers: far too slow pulled back, far too fast up close.
 */
export const panBy = (
  state: OrbitState,
  dx: number,
  dy: number,
  limits: OrbitLimits,
): Vec3 => {
  const offset = orbitOffset(state.theta, state.phi, state.radius);
  const distance = Math.hypot(offset.x, offset.y, offset.z) || 1;
  // The camera's forward direction, and the world up it is level against.
  const forward: Vec3 = {
    x: -offset.x / distance,
    y: -offset.y / distance,
    z: -offset.z / distance,
  };
  // Right is forward crossed with up, which for an up of (0, 1, 0) reduces to
  // negating z and keeping x. Kept as a cross product rather than that
  // simplification so the direction it points is legible.
  const right: Vec3 = {
    x: forward.y * 0 - forward.z * 1,
    y: forward.z * 0 - forward.x * 0,
    z: forward.x * 1 - forward.y * 0,
  };
  const rightLength = Math.hypot(right.x, right.y, right.z) || 1;
  const rx = right.x / rightLength;
  const ry = right.y / rightLength;
  const rz = right.z / rightLength;
  // The camera's up, which is right crossed with forward and is the only
  // direction that moves the target along the screen's vertical.
  const upX = ry * forward.z - rz * forward.y;
  const upY = rz * forward.x - rx * forward.z;
  const upZ = rx * forward.y - ry * forward.x;

  const scale = state.radius * limits.panSpeed;
  const moveX = -(rx * dx - upX * dy) * scale;
  const moveY = -(ry * dx - upY * dy) * scale;
  const moveZ = -(rz * dx - upZ * dy) * scale;
  return {
    x: state.target.x + moveX,
    y: state.target.y + moveY,
    z: state.target.z + moveZ,
  };
};

/** Wires pointer and wheel events onto an orbit state, and onto a camera. */
export class OrbitController {
  readonly state: OrbitState;
  readonly limits: OrbitLimits;

  /** Live pointers, by identifier, so a second finger can be found for a pinch. */
  private readonly pointers = new Map<number, { x: number; y: number }>();
  /** The distance the two nearest pointers were last seen at, for the pinch. */
  private pinchDistance = 0;
  /** Set while a pointer is down, to keep a release from ending a drag early. */
  private button = -1;
  private detachers: Array<() => void> = [];

  constructor(
    private readonly camera: PerspectiveCamera,
    options: { radius?: number; limits?: Partial<OrbitLimits> } = {},
  ) {
    this.limits = { ...DEFAULT_ORBIT_LIMITS, ...options.limits };
    this.state = initialOrbitState(options.radius);
  }

  /** Starts listening. Returns a function that stops, and is safe twice. */
  attach(element: HTMLElement): () => void {
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      element.addEventListener(type, handler as EventListener, options);
      this.detachers.push(() =>
        element.removeEventListener(type, handler as EventListener, options),
      );
    };

    const local = (event: PointerEvent): { x: number; y: number } => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    on("pointerdown", (event) => {
      element.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, local(event));
      // A second finger turns the gesture into a pinch whatever button it
      // arrived with, and clears the drag the first finger had begun.
      this.button = this.pointers.size === 1 ? event.button : -1;
      this.pinchDistance = this.spread();
    });

    on("pointermove", (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (previous === undefined) return;
      const current = local(event);
      this.pointers.set(event.pointerId, current);

      if (this.pointers.size >= 2) {
        const spread = this.spread();
        // Below the threshold a pinch is two fingers touching by accident, and
        // acting on it would move the model by an amount nobody asked for.
        if (this.pinchDistance > this.limits.pinchThreshold) {
          const ratio = this.pinchDistance / Math.max(spread, 1);
          this.state.radius = clampRadius(
            this.state.radius * Math.pow(ratio, this.limits.zoomSpeed * 8),
            this.limits,
          );
        }
        this.pinchDistance = spread;
        return;
      }

      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      if (this.button === 2 || event.shiftKey) {
        this.state.target = panBy(this.state, dx, dy, this.limits);
      } else if (this.button === 0) {
        this.state.theta -= dx * this.limits.rotateSpeed;
        this.state.phi = clampPhi(
          this.state.phi - dy * this.limits.rotateSpeed,
          this.limits,
        );
      }
    });

    // A pointer that leaves the element, or whose capture is taken away, ends its
    // gesture. Without this a drag that started inside a canvas and finished
    // outside it leaves the camera orbiting against nothing.
    const release = (event: PointerEvent): void => {
      this.pointers.delete(event.pointerId);
      this.button = -1;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
    };
    on("pointerup", release);
    on("pointercancel", release);

    on(
      "wheel",
      (event) => {
        // Not passive, so the gesture can be claimed: a wheel over a model that
        // also scrolls the page is a page that scrolls while the user is trying
        // to zoom.
        event.preventDefault();
        this.state.radius = clampRadius(
          this.state.radius * Math.exp(event.deltaY * this.limits.zoomSpeed),
          this.limits,
        );
      },
      { passive: false },
    );

    on("contextmenu", (event) => event.preventDefault());

    return () => this.dispose();
  }

  /** The distance between the two pointers closest together, or zero. */
  private spread(): number {
    if (this.pointers.size < 2) return 0;
    const points = [...this.pointers.values()];
    let best = Infinity;
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const distance = Math.hypot(
          points[a].x - points[b].x,
          points[a].y - points[b].y,
        );
        if (distance < best) best = distance;
      }
    }
    return Number.isFinite(best) ? best : 0;
  }

  /** Writes the current state onto the camera. */
  apply(): void {
    const offset = orbitOffset(
      this.state.theta,
      this.state.phi,
      this.state.radius,
    );
    this.camera.position.set(
      this.state.target.x + offset.x,
      this.state.target.y + offset.y,
      this.state.target.z + offset.z,
    );
    this.camera.lookAt(
      this.state.target.x,
      this.state.target.y,
      this.state.target.z,
    );
  }

  /** True once a pointer is down, which the UI uses to hide its own hints. */
  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  dispose(): void {
    for (const detach of this.detachers) detach();
    this.detachers = [];
    this.pointers.clear();
  }
}
