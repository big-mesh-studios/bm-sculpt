/**
 * The arrows as geometry, projected.
 *
 * **rmsl's `Scene`, `PerspectiveCamera` and the geometry classes are arithmetic and need no
 * WebGL context**, so the one claim about the handles that is easy to get wrong and
 * impossible to check by looking — that they are the same size on screen at any distance —
 * can be checked here against numbers.
 */
import { describe, expect, it } from "vitest";
import {
  PerspectiveCamera,
  Scene,
  type Object3D,
} from "@random-mesh/rmsl/scene";

import { createMoveHandles } from "./move-handles";
import { TOO_FORESHORTENED, VIEW_SHARE } from "./move-handle";

/** A camera at `radius`, looking at the origin, with a canvas of the given size. */
const lookingAt = (
  radius: number,
  size = { width: 800, height: 600 },
): { camera: PerspectiveCamera; scene: Scene } => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(
    45,
    size.width / size.height,
    0.01,
    8000,
  );
  camera.position.set(0, 0, radius);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return { camera, scene };
};

/** The length of an arrow in screen pixels. */
const screenLength = (arm: {
  from: { x: number; y: number };
  to: { x: number; y: number };
}): number => Math.hypot(arm.to.x - arm.from.x, arm.to.y - arm.from.y);

describe("move handles", () => {
  it("stands three arrows, one per axis", () => {
    const { camera, scene } = lookingAt(10);
    const handles = createMoveHandles(scene);
    handles.place({ x: 0, y: 0, z: 0 }, 10);

    const arms = handles.armsOnScreen(camera, { width: 800, height: 600 });
    expect(arms.map((arm) => arm.axis)).toEqual(["x", "y", "z"]);
  });

  it("puts the hub where the part is", () => {
    const { camera, scene } = lookingAt(10);
    const handles = createMoveHandles(scene);
    handles.place({ x: 1, y: 2, z: 0 }, 10);

    const [arm] = handles.armsOnScreen(camera, { width: 800, height: 600 });
    // The camera is at the origin looking down -Z, so world (1, 2, 0) projects right of
    // centre and above it: canvas x greater than the middle, canvas y *less*, because the
    // canvas counts downwards.
    expect(arm?.from.x).toBeGreaterThan(400);
    expect(arm?.from.y).toBeLessThan(300);
  });

  it("keeps the same size on screen however far the camera has been pulled back", () => {
    // **The whole reason the arrows are scaled rather than sized.** A fixed world length is
    // a hairline on a figure seen whole and a fence post up close; an arrow of
    // `VIEW_SHARE × distance` covers the same fraction of the canvas height at any distance.
    const lengths = [4, 10, 40].map((radius) => {
      const { camera, scene } = lookingAt(radius);
      const handles = createMoveHandles(scene);
      handles.place({ x: 0, y: 0, z: 0 }, radius);
      // The x arrow lies across the middle of the frame, where the projection is least
      // distorted, and is the longest of the three on screen.
      const arms = handles.armsOnScreen(camera, { width: 800, height: 600 });
      const x = arms.find((arm) => arm.axis === "x");
      return { radius, length: x === undefined ? 0 : screenLength(x) };
    });

    for (const { radius, length } of lengths) {
      expect(
        length,
        `at radius ${radius} the arrow covered ${length}px`,
      ).toBeGreaterThan(0);
    }
    // **Two pixels of slack**, for the perspective divide differing slightly between a near
    // and a far distance. The claim is "the same size", not "the same number".
    const spread =
      Math.max(...lengths.map((entry) => entry.length)) -
      Math.min(...lengths.map((entry) => entry.length));
    expect(spread, `arrow size varied by ${spread}px`).toBeLessThan(2);
  });

  it("scales its world length with the camera's distance", () => {
    const { scene } = lookingAt(10);
    const handles = createMoveHandles(scene);
    handles.place({ x: 0, y: 0, z: 0 }, 8);
    expect(handles.armLength()).toBe(VIEW_SHARE * 8);
    handles.place({ x: 0, y: 0, z: 0 }, 20);
    expect(handles.armLength()).toBe(VIEW_SHARE * 20);
  });

  it("gives every arrow enough screen length to be worth grabbing", () => {
    // **A handle that is drawn too short to hit is a handle that is not there.** Checked at
    // a distance where the model is small on screen, which is where it is worst.
    const { camera, scene } = lookingAt(40);
    const handles = createMoveHandles(scene);
    handles.place({ x: 0, y: 0, z: 0 }, 40);

    for (const arm of handles.armsOnScreen(camera, {
      width: 390,
      height: 844,
    })) {
      // One arrow points at the camera and is legitimately degenerate; the other two are
      // at least long enough that the grab radius is not wider than the arrow itself.
      if (arm.axis === "z") continue;
      expect(
        screenLength(arm),
        `the ${arm.axis} arrow was ${screenLength(arm)}px long`,
      ).toBeGreaterThan(TOO_FORESHORTENED);
    }
  });

  it("draws no arrows at all when hidden", () => {
    // Visibility is the tool's switch, so an invisible arrow that is still hit-testable
    // would let a drag start on a handle nobody can see.
    const { camera, scene } = lookingAt(10);
    const handles = createMoveHandles(scene);
    handles.place({ x: 0, y: 0, z: 0 }, 10);
    handles.setVisible(false);
    expect(handles.group.visible).toBe(false);
    // The measurement is deliberately independent of visibility — see the note in
    // `armsOnScreen` — so the *caller* is what has to check the tool, which `grabHandle`
    // does before it ever projects anything.
    expect(camera.position.z).toBe(10);
  });

  it("leaves the scene when disposed", () => {
    const { scene } = lookingAt(10);
    const handles = createMoveHandles(scene);
    handles.dispose();
    // Walking to the root must not find a detached group still parented to the scene.
    // Typed as the parent type, since `parent` is an `Object3D` and a `Group` is one.
    let node: Object3D = handles.group;
    while (node.parent !== null) node = node.parent;
    expect(node).not.toBe(scene);
  });
});

describe("a camera behind the handles", () => {
  it("reports no arrows at all, rather than arrows in the middle of the picture", () => {
    // **The reason `projectToScreen` can answer undefined, exercised where it matters.**
    // A point behind the camera comes back from the projection inside the frame, mirrored,
    // where it reads as an ordinary position — so a handle on the far side of a figure would
    // be drawn as though it pointed at the viewer and would be grabbed when the person
    // reached for the near side.
    const scene = new Scene();
    // Looking away from the origin, so the handles at the origin are behind it.
    const camera = new PerspectiveCamera(45, 1, 0.01, 8000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 20);
    camera.updateMatrixWorld();

    const handles = createMoveHandles(scene);
    handles.place({ x: 0, y: 0, z: 0 }, 10);

    expect(handles.armsOnScreen(camera, { width: 800, height: 600 })).toEqual(
      [],
    );
  });
});
