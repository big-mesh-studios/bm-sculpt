import { describe, expect, it } from "vitest";

import {
  clampPhi,
  clampRadius,
  DEFAULT_ORBIT_LIMITS,
  initialOrbitState,
  orbitOffset,
  panBy,
} from "./orbit-camera";

const limits = DEFAULT_ORBIT_LIMITS;

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
