import { describe, expect, it } from "vitest";

import { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import {
  clampPhi,
  clampRadius,
  DEFAULT_ORBIT_LIMITS,
  initialOrbitState,
  OrbitController,
  orbitOffset,
  panBy,
} from "./orbit-camera";

const limits = DEFAULT_ORBIT_LIMITS;

/**
 * An element that records its listeners, so a gesture can be performed on it.
 *
 * The event wiring had no coverage at all until now, and that is how a pinch could run
 * eighty times too slow without anything objecting: the pure functions were all tested and
 * all correct, and the arithmetic that used them was not tested at all.
 */
const fakeElement = () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const element = {
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.get(type)?.delete(handler);
    },
    setPointerCapture: () => {},
    hasPointerCapture: () => false,
    releasePointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  };

  return {
    element: element as unknown as HTMLElement,
    fire(type: string, event: unknown): void {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    /** Presses, drags by the given delta, and releases, with one button held throughout. */
    drag(
      dx: number,
      dy: number,
      options: { button?: number; shiftKey?: boolean } = {},
    ): void {
      const pointer = (x: number, y: number) => ({
        pointerId: 1,
        clientX: 400 + x,
        clientY: 300 + y,
        button: options.button ?? 0,
        shiftKey: options.shiftKey ?? false,
      });
      this.fire("pointerdown", pointer(0, 0));
      this.fire("pointermove", pointer(dx, dy));
      this.fire("pointerup", pointer(dx, dy));
    },
    /** Lifts two fingers apart by a factor, as a real pinch would. */
    pinch(from: number, to: number): void {
      const pointer = (id: number, x: number, y: number) => ({
        pointerId: id,
        clientX: x,
        clientY: y,
        button: 0,
        shiftKey: false,
      });
      this.fire("pointerdown", pointer(1, 0, 0));
      this.fire("pointerdown", pointer(2, from, 0));
      this.fire("pointermove", pointer(1, 0, 0));
      this.fire("pointermove", pointer(2, to, 0));
    },
    wheel(deltaY: number, ctrlKey = false): void {
      this.fire("wheel", { deltaY, ctrlKey, preventDefault: () => {} });
    },
  };
};

const controller = (radius = 900) => {
  const harness = fakeElement();
  const orbit = new OrbitController(new PerspectiveCamera(), { radius });
  orbit.attach(harness.element);
  return { orbit, harness };
};

/**
 * Drags on a controller of its own and reports which half of the camera moved.
 *
 * Answering "orbit or pan" as a property rather than as angles or target coordinates is the
 * point: the two are arithmetically independent, so a test that checked the numbers would
 * still pass if a drag did both, or neither, and a gesture that does nothing is exactly what
 * a user cannot describe — only what is missing from it.
 */
const dragged = (options: { button: number; shiftKey?: boolean }) => {
  const { orbit, harness } = controller();
  const before = {
    theta: orbit.state.theta,
    phi: orbit.state.phi,
    target: { ...orbit.state.target },
  };

  harness.drag(60, 40, options);

  return {
    orbited:
      orbit.state.theta !== before.theta || orbit.state.phi !== before.phi,
    panned:
      orbit.state.target.x !== before.target.x ||
      orbit.state.target.y !== before.target.y ||
      orbit.state.target.z !== before.target.z,
  };
};

/** The whole table, in the order a user would reach for the buttons. */
const DRAGS: ReadonlyArray<{
  readonly label: string;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly did: "orbited" | "panned";
}> = [
  { label: "a left drag", button: 0, shiftKey: false, did: "orbited" },
  { label: "a shift-left drag", button: 0, shiftKey: true, did: "panned" },
  { label: "a right drag", button: 2, shiftKey: false, did: "orbited" },
  { label: "a shift-right drag", button: 2, shiftKey: true, did: "panned" },
  { label: "a middle drag", button: 1, shiftKey: false, did: "panned" },
];

describe("which gesture a drag means", () => {
  for (const { label, button, shiftKey, did } of DRAGS) {
    it(`${label} ${did === "orbited" ? "orbits" : "pans"}`, () => {
      expect(dragged({ button, shiftKey })).toEqual({
        orbited: did === "orbited",
        panned: did === "panned",
      });
    });
  }

  it("gives every button and modifier exactly one gesture, and never none", () => {
    // The bug this table exists for: right-drag was the *pan* button, which is the right
    // answer for a viewer whose left button orbits and the wrong one here, where the left
    // button is a brush. It took the last gesture that turned the model, so a desktop user
    // had no way to orbit at all — and the pure functions were all tested, and all correct.
    // Enumerating the combinations rather than re-asserting the rows above is what stops that
    // coming back as a hole in the table instead of as a failing case.
    for (let button = 0; button <= 2; button++) {
      for (const shiftKey of [false, true]) {
        const what = dragged({ button, shiftKey });
        const gestures = [what.orbited, what.panned].filter(Boolean);
        expect(gestures, `button ${button}, shift ${shiftKey}`).toHaveLength(1);
      }
    }
  });

  it("orbits on a right drag by a turn, not a pan, and leaves the target alone", () => {
    // The size of the turn is a constant rather than a number pinned here, but it has to be
    // the right order of magnitude: a turn of a thousandth of a radian per pixel is a drag
    // that looks broken in the same way an eighty-times-too-slow pinch did.
    const { orbit, harness } = controller();
    const start = orbit.state.theta;
    harness.drag(60, 40, { button: 2 });

    const turn = Math.abs(orbit.state.theta - start);
    expect(turn).toBeCloseTo(60 * DEFAULT_ORBIT_LIMITS.rotateSpeed, 9);
    expect(turn).toBeGreaterThan(0.1);
    expect(orbit.state.target).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("stops on release, so a pointer left hovering cannot keep moving the camera", () => {
    // `button` is the button the drag *began* with, because a pointermove reports no button
    // at all for a mouse being moved with none held. That makes it state a release has to
    // clear, and a stale one is a camera that drifts on its own.
    const { orbit, harness } = controller();
    harness.drag(60, 40, { button: 2 });
    const held = { ...orbit.state, target: { ...orbit.state.target } };

    harness.fire("pointermove", {
      pointerId: 1,
      clientX: 460,
      clientY: 340,
      button: -1,
      shiftKey: false,
    });
    expect(orbit.state).toEqual(held);
  });
});

describe("a tool that has the left button", () => {
  // Both halves of the same arrangement. The tool and the controller listen on the same
  // canvas, so one of them has to stand down for a left drag — and the one that stands down
  // must still be *watching*, or a second finger is invisible and pinch cannot happen at all.

  it("leaves a left drag to the tool, rather than orbiting as well", () => {
    // Both acting at once draws the stroke along the path the camera went, which reads as
    // the brush being wildly inaccurate rather than as two things both happening.
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const before = { ...orbit.state, target: { ...orbit.state.target } };

    harness.drag(60, 40, { button: 0 });

    expect(orbit.state).toEqual(before);
  });

  it("still pinches with a second finger, which is the whole point", () => {
    // The regression. A blanket "stand down" has to stop the controller seeing any pointer,
    // so the second finger never arrives and the gesture is impossible while a brush is
    // down — which is exactly when a user reaches for it.
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const start = orbit.state.radius;

    harness.fire("pointerdown", {
      pointerId: 1,
      clientX: 300,
      clientY: 300,
      button: 0,
      shiftKey: false,
    });
    harness.pinch(100, 200);

    expect(orbit.state.radius).toBeLessThan(start);
  });

  it("does not orbit for the finger that is holding the brush", () => {
    // The two-pointer branch above has to leave the camera's angles alone: a pinch is a
    // dolly, and letting the first finger's drag through as well would turn the view *and*
    // zoom it at once.
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const before = { ...orbit.state, target: { ...orbit.state.target } };

    harness.fire("pointerdown", {
      pointerId: 1,
      clientX: 300,
      clientY: 300,
      button: 0,
      shiftKey: false,
    });
    harness.fire("pointerdown", {
      pointerId: 2,
      clientX: 100,
      clientY: 300,
      button: 0,
      shiftKey: false,
    });
    harness.fire("pointermove", {
      pointerId: 1,
      clientX: 400,
      clientY: 300,
      button: -1,
      shiftKey: false,
    });

    expect(orbit.state.theta).toBe(before.theta);
    expect(orbit.state.phi).toBe(before.phi);
  });

  it("declines the wheel too, so a zoom cannot move the surface out from under the brush", () => {
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const start = orbit.state.radius;

    harness.wheel(-100);

    expect(orbit.state.radius).toBe(start);
  });

  it("gives the camera back when the tool lets go", () => {
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const held = { ...orbit.state, target: { ...orbit.state.target } };

    orbit.setToolOwnsLeft(false);
    harness.drag(60, 40, { button: 0 });

    expect(orbit.state.theta).not.toBe(held.theta);
  });

  it("declines a pan too, so a shift held mid-stroke cannot slide the model away", () => {
    // A blanket stand-down for single-pointer gestures, not just the left orbit. A pan moves
    // the target, the window follows it, and every dab after it lands on a different part
    // of the model than the pointer is over — a stroke that wanders off on its own is a
    // worse bug than a pan that needs the pointer up first.
    const { orbit, harness } = controller();
    orbit.setToolOwnsLeft(true);
    const before = { ...orbit.state, target: { ...orbit.state.target } };

    harness.drag(60, 40, { button: 0, shiftKey: true });

    expect(orbit.state).toEqual(before);
  });

  it("declines every single-pointer gesture, and acts only on a second pointer", () => {
    // The arrangement in one statement: a tool holding the button means the camera waits for
    // company. Whichever button or modifier the single pointer brought, the answer is the
    // same, and the only thing that moves the camera is a second finger. Enumerated rather
    // than asserted one at a time, because the failure this guards against is a *gap* in
    // that set — a combination nobody thought to switch off.
    const movesCamera = (
      gesture: (harness: ReturnType<typeof fakeElement>) => void,
    ): boolean => {
      const { orbit, harness } = controller();
      orbit.setToolOwnsLeft(true);
      const before = JSON.stringify({
        ...orbit.state,
        target: { ...orbit.state.target },
      });

      gesture(harness);

      return (
        JSON.stringify({
          ...orbit.state,
          target: { ...orbit.state.target },
        }) !== before
      );
    };

    for (const button of [0, 1, 2]) {
      for (const shiftKey of [false, true]) {
        expect(
          movesCamera((harness) => harness.drag(60, 40, { button, shiftKey })),
          `button ${button}, shift ${shiftKey}`,
        ).toBe(false);
      }
    }
    // And the one gesture that is supposed to get through.
    expect(movesCamera((harness) => harness.pinch(100, 200))).toBe(true);
  });
});

describe("orbiting angles", () => {
  it("holds phi inside the limits however far a flick overshoots", () => {
    expect(clampPhi(0, limits)).toBe(limits.minPhi);
    expect(clampPhi(Math.PI, limits)).toBe(limits.maxPhi);
    expect(clampPhi(-40, limits)).toBe(limits.minPhi);
    expect(clampPhi(40, limits)).toBe(limits.maxPhi);
    // And leaves a value already inside alone, which is the case that runs
    // thousands of times a session and must not drift.
    expect(clampPhi(1.2, limits)).toBe(1.2);
  });

  it("stops short of the poles, where up and view direction are parallel", () => {
    // The limits themselves are the assertion: at exactly zero the up axis and
    // the view direction are the same line, and the roll that keeps the horizon
    // level has nothing to be level against.
    expect(limits.minPhi).toBeGreaterThan(0);
    expect(limits.maxPhi).toBeLessThan(Math.PI);
  });

  it("holds radius inside the limits", () => {
    expect(clampRadius(-1, limits)).toBe(limits.minRadius);
    expect(clampRadius(1e9, limits)).toBe(limits.maxRadius);
    expect(clampRadius(500, limits)).toBe(500);
  });
});

describe("orbital position", () => {
  it("puts the camera above the target for a small phi", () => {
    const offset = orbitOffset(0, Math.PI * 0.25, 100);
    expect(offset.y).toBeGreaterThan(0);
  });

  it("puts the camera on the radius it was asked for", () => {
    for (const theta of [0, 1, 2.5, 4, 6]) {
      for (const phi of [0.3, 1.5, 2.8]) {
        const offset = orbitOffset(theta, phi, 250);
        expect(Math.hypot(offset.x, offset.y, offset.z)).toBeCloseTo(250, 6);
      }
    }
  });

  it("puts theta 0 on the +Z side, which is where the state starts", () => {
    const offset = orbitOffset(0, Math.PI / 2, 10);
    expect(offset.x).toBeCloseTo(0, 6);
    expect(offset.z).toBeCloseTo(10, 6);
  });
});

describe("panning", () => {
  it("moves the target further at a greater distance, for the same drag", () => {
    // The whole reason a pan scales by radius: a pan of a fixed number of world
    // units is a constant-speed pan, which is unusable across the range of
    // scales an inspector-style view covers.
    const near = { ...initialOrbitState(200), target: { x: 0, y: 0, z: 0 } };
    const far = { ...initialOrbitState(2000), target: { x: 0, y: 0, z: 0 } };

    const nearMove = Math.hypot(...Object.values(panBy(near, 40, 0, limits)));
    const farMove = Math.hypot(...Object.values(panBy(far, 40, 0, limits)));

    expect(farMove / nearMove).toBeCloseTo(10, 4);
  });

  it("leaves the target where it is for no drag at all", () => {
    const state = initialOrbitState(500);
    const moved = panBy(state, 0, 0, limits);
    expect(moved.x).toBeCloseTo(state.target.x, 9);
    expect(moved.y).toBeCloseTo(state.target.y, 9);
    expect(moved.z).toBeCloseTo(state.target.z, 9);
  });

  it("moves opposite the drag, so the model follows the pointer", () => {
    // Dragging right has to carry the model right, which means the target moves
    // left. A sign error here is the kind that makes a whole application feel
    // inverted and is invisible until it is used.
    const state = initialOrbitState(500);
    const moved = panBy(state, 60, 0, limits);
    expect(moved.x).toBeLessThan(state.target.x);
  });

  it("keeps the target on the camera's own axes, not the world's", () => {
    // Two views of the same model at different angles must pan the same screen
    // direction relative to themselves. A pan expressed in world axes would send
    // one of them sideways.
    const state = { ...initialOrbitState(500), target: { x: 3, y: -7, z: 11 } };
    const dragged = panBy(state, 50, 30, limits);
    expect(Number.isFinite(dragged.x)).toBe(true);
    expect(Number.isFinite(dragged.y)).toBe(true);
    expect(Number.isFinite(dragged.z)).toBe(true);
    expect(
      Math.hypot(dragged.x - 3, dragged.y + 7, dragged.z - 11),
    ).toBeGreaterThan(0);
  });
});

describe("zooming with a wheel", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    // The DOM's own convention, pinned here because the sign is easy to get backwards and
    // a wheel that turns the wrong way is the first thing anyone notices: a positive deltaY
    // is content moving down the page, which reads as pushing the world away.
    const { orbit, harness } = controller();
    const start = orbit.state.radius;

    harness.wheel(-100);
    const closer = orbit.state.radius;
    expect(closer).toBeLessThan(start);

    harness.wheel(100);
    expect(orbit.state.radius).toBeGreaterThan(closer);
  });

  it("moves proportionally to the delta, so a notch is a notch", () => {
    // Exponential in the delta, which is what makes a wheel feel the same at any speed:
    // the same total rotation produces the same total zoom however it was delivered.
    const { orbit, harness } = controller();
    const start = orbit.state.radius;
    for (let i = 0; i < 10; i++) harness.wheel(10);
    for (let i = 0; i < 10; i++) harness.wheel(10);
    expect(orbit.state.radius / start).toBeCloseTo(
      Math.exp(200 * DEFAULT_ORBIT_LIMITS.zoomSpeed),
      9,
    );
  });

  it("gives one mouse notch a sensible amount of travel", () => {
    // Around a sixth of the radius: enough to feel deliberate, small enough that reaching
    // across a model takes a handful of notches rather than a scroll.
    const one = Math.exp(100 * DEFAULT_ORBIT_LIMITS.zoomSpeed);
    expect(one).toBeGreaterThan(1.1);
    expect(one).toBeLessThan(1.3);
  });

  it("zooms faster for a trackpad pinch than for a mouse notch", () => {
    // A trackpad reports a pinch as a wheel with the control key held, and its deltas are
    // a small fraction of a notch's. Sharing the mouse's speed made a trackpad pinch feel
    // around twenty times too slow, which is the complaint that produced the constant.
    const { orbit, harness } = controller();
    const start = orbit.state.radius;
    const delta = -2;

    harness.wheel(delta, false);
    const mouse = start / orbit.state.radius;
    orbit.state.radius = start;

    harness.wheel(delta, true);
    const trackpad = start / orbit.state.radius;

    expect(trackpad).toBeGreaterThan(mouse);
    // The speeds compose additively in log space, not as a ratio: the radius is
    // multiplied by `exp(delta * speed)`, so a twice-as-large speed is not twice the
    // movement but twice the exponent. Asserting the ratio was wrong by about a factor of
    // thirteen for these values, and would have looked like a bug in the code.
    expect(Math.log(trackpad) - Math.log(mouse)).toBeCloseTo(
      -delta *
        (DEFAULT_ORBIT_LIMITS.trackpadZoomSpeed -
          DEFAULT_ORBIT_LIMITS.zoomSpeed),
      9,
    );
    // And enough over a whole gesture to be worth doing: a trackpad pinch reports a few
    // units per event across a hundred or so of them.
    const gesture = Math.exp(150 * DEFAULT_ORBIT_LIMITS.trackpadZoomSpeed);
    expect(gesture).toBeGreaterThan(5);
  });
});

describe("zooming with a pinch", () => {
  it("moves in the direction the fingers went", () => {
    const { orbit, harness } = controller();
    const start = orbit.state.radius;

    harness.pinch(100, 200);
    expect(orbit.state.radius).toBeLessThan(start);

    orbit.state.radius = start;
    harness.pinch(200, 100);
    expect(orbit.state.radius).toBeGreaterThan(start);
  });

  it("tracks the fingers: spreading them twice as far halves the radius", () => {
    // A speed of one. Anything much below it — the earlier setting reused the wheel's
    // per-pixel constant, giving about 0.012 — and a pinch that doubles the fingers moves
    // the camera by one percent, which reads as a gesture that is not working.
    const { orbit, harness } = controller();
    const start = orbit.state.radius;
    harness.pinch(100, 200);
    expect(orbit.state.radius / start).toBeCloseTo(0.5, 6);
  });

  it("depends on the ratio of separation, not its size", () => {
    // A pinch of ten pixels means something quite different at a hundred pixels of
    // separation and at four hundred, and only the ratio carries what the user meant.
    // This is what makes the gesture behave the same on any screen.
    const small = controller();
    small.harness.pinch(100, 120);
    const large = controller();
    large.harness.pinch(400, 480);

    expect(small.orbit.state.radius / 900).toBeCloseTo(
      large.orbit.state.radius / 900,
      9,
    );
  });

  it("is unaffected by how many separate moves the gesture arrives in", () => {
    // Pointer events arrive at whatever rate the device reports, so a speed expressed per
    // event would make the zoom depend on frame rate — which is the same class of bug as
    // an assertion that measures a clock.
    const stepwise = controller();
    const atOnce = controller();

    const fire = (
      harness: ReturnType<typeof fakeElement>,
      from: number,
      steps: number,
    ) => {
      const pointer = {
        pointerId: 2,
        clientX: from,
        clientY: 0,
        button: 0,
        shiftKey: false,
      };
      harness.fire("pointerdown", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
        shiftKey: false,
      });
      harness.fire("pointerdown", pointer);
      harness.fire("pointermove", {
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        button: 0,
        shiftKey: false,
      });
      for (let i = 1; i <= steps; i++) {
        harness.fire("pointermove", {
          ...pointer,
          clientX: from + ((200 - from) * i) / steps,
        });
      }
    };

    fire(stepwise.harness, 100, 20);
    fire(atOnce.harness, 100, 1);

    expect(stepwise.orbit.state.radius / 900).toBeCloseTo(
      atOnce.orbit.state.radius / 900,
      9,
    );
  });

  it("ignores two fingers barely touching", () => {
    // Below the threshold a pinch is two fingers landing at once, and acting on it would
    // move the model by an amount nobody asked for.
    const { orbit, harness } = controller();
    const start = orbit.state.radius;
    harness.pinch(2, 6);
    expect(orbit.state.radius).toBe(start);
  });

  it("stays inside the radius limits", () => {
    const { orbit, harness } = controller();
    for (let i = 0; i < 40; i++) harness.pinch(100, 400);
    expect(orbit.state.radius).toBeGreaterThanOrEqual(
      DEFAULT_ORBIT_LIMITS.minRadius,
    );
    for (let i = 0; i < 80; i++) harness.pinch(400, 100);
    expect(orbit.state.radius).toBeLessThanOrEqual(
      DEFAULT_ORBIT_LIMITS.maxRadius,
    );
  });
});
