/**
 * An orbit camera, hand-rolled.
 *
 * This library ships no `OrbitControls`, and nothing here is a substitute for
 * one: it is the minimum that makes a surface visible and its octahedral normals
 * checkable by eye — drag to orbit, shift-drag or middle-drag to pan, wheel or
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
import type { Vec3 } from "@big-mesh-studios/core";

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
  /**
   * Log-radius change per pixel of wheel delta.
   *
   * Calibrated against a mouse, where one notch is around a hundred pixels of deltaY, so
   * this gives roughly a sixth of the radius per notch.
   */
  zoomSpeed: number;
  /**
   * Exponent on the ratio of finger separation, for a two-finger pinch.
   *
   * A separate constant because it is a different quantity, and reusing one for both is how
   * the gesture ended up some eighty times too slow. A wheel reports how far a *pixel*
   * moved; a pinch reports how far apart two *fingers* are, and only the ratio of that to
   * the previous frame says what a user meant — ten pixels of pinch means something quite
   * different at a hundred pixels of separation and at four hundred. One means the camera
   * tracks the fingers exactly, and behaves the same on any screen.
   */
  pinchSpeed: number;
  /**
   * Log-radius change per pixel of ctrl+wheel delta, for a trackpad pinch.
   *
   * A trackpad reports a pinch as a wheel event with the control key held, and its deltas
   * are a small fraction of a mouse notch's — a couple of units where a wheel gives a
   * hundred. Sharing the mouse's speed therefore made a trackpad pinch feel about twenty
   * times too slow, which is the complaint that produced this constant.
   */
  trackpadZoomSpeed: number;
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
  pinchSpeed: 1,
  trackpadZoomSpeed: 0.02,
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
  /**
   * Whether a tool has the left button, so a left drag is not also a camera move.
   *
   * Narrower than a blanket "stand down", and deliberately so. A blanket switch has to stop
   * this controller seeing *any* pointer, which makes a second finger invisible to it — and
   * a second finger is how a pinch is spelled, so the gesture could not work at all. This
   * one keeps tracking pointers and only declines to act on a single-pointer gesture, so
   * the two-pointer branch stays reachable while a brush is down.
   */
  private toolOwnsLeft = false;
  private detachers: Array<() => void> = [];

  constructor(
    private readonly camera: PerspectiveCamera,
    options: { radius?: number; limits?: Partial<OrbitLimits> } = {},
  ) {
    this.limits = { ...DEFAULT_ORBIT_LIMITS, ...options.limits };
    this.state = initialOrbitState(options.radius);
  }

  /**
   * Says a tool is using the left button, so this controller leaves single-pointer gestures
   * to it.
   *
   * Stops and resumes without detaching, and without forgetting the pointers: detaching
   * would work too and is worse, since the listeners would have to come back and whatever
   * re-added them would have to know about the tool. Two pointers still pinch, which is the
   * whole point — a user with one finger on the brush and two on the screen is navigating,
   * and the two must be able to be true at once.
   */
  setToolOwnsLeft(owns: boolean): void {
    this.toolOwnsLeft = owns;
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
          // Fingers separating by a factor of `s` moves the camera by `s^-pinchSpeed`, so
          // spreading them twice as far halves the radius at a speed of one.
          const ratio = this.pinchDistance / Math.max(spread, 1);
          this.state.radius = clampRadius(
            this.state.radius * Math.pow(ratio, this.limits.pinchSpeed),
            this.limits,
          );
        }
        this.pinchDistance = spread;
        return;
      }

      // A tool has the left button, so the camera waits. Deliberately *after* the pinch
      // branch above: one finger on the brush and two on the screen is a navigation
      // gesture, and the pointer bookkeeping above has to keep running either way so the
      // deltas are right the moment the tool lets go.
      if (this.toolOwnsLeft) return;

      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      // Shift is the pan modifier whichever button is held, so a pan never costs a trip to
      // the middle button or a second hand, and the middle button pans on its own for the
      // modifier keys nobody has bound. Everything else orbits.
      //
      // The right button is in that "everything else" deliberately. It was the pan button
      // here, which is the conventional choice for a viewer where the left button orbits —
      // and here the left button sculpts, so a pan button that was also the only remaining
      // way to look around left a desktop user with no gesture that orbited at all.
      if (event.shiftKey || this.button === 1) {
        this.state.target = panBy(this.state, dx, dy, this.limits);
      } else if (this.button === 0 || this.button === 2) {
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
        // Dolly is the one camera move a tool cannot have: a zoom mid-stroke moves the
        // surface out from under the brush, and every dab after it lands somewhere the user
        // was not pointing. Two fingers still pinch, because that is a different branch.
        if (this.toolOwnsLeft) return;
        // Not passive, so the gesture can be claimed: a wheel over a model that
        // also scrolls the page is a page that scrolls while the user is trying
        // to zoom.
        event.preventDefault();
        // A trackpad pinch arrives here as a wheel with the control key held. It is the
        // same gesture as a two-finger pinch and nothing like the same numbers, so it gets
        // its own speed rather than a share of the mouse's.
        const speed = event.ctrlKey
          ? this.limits.trackpadZoomSpeed
          : this.limits.zoomSpeed;
        this.state.radius = clampRadius(
          this.state.radius * Math.exp(event.deltaY * speed),
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
