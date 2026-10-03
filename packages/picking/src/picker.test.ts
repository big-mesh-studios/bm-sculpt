import { describe, expect, it } from "vitest";

import { PerspectiveCamera } from "@random-mesh/rmsl/scene";

import { Field } from "@big-mesh-studios/csg";
import { OperationBVH } from "@big-mesh-studios/csg";
import { makeOperation, type Operation } from "@big-mesh-studios/csg";

import {
  MAX_STEP,
  type PickField,
  pickAlong,
  type Ray,
  rayAt,
  rayThroughScreen,
  toNdc,
} from "./picker";

const sphereAt = (
  centre: readonly [number, number, number],
  radius: number,
): Operation =>
  makeOperation(
    0,
    { x: centre[0], y: centre[1], z: centre[2] },
    { type: "Ellipsoid", radius: { x: radius, y: radius, z: radius } },
    "Add",
  );

/** A field over one sphere, which is the easiest shape to reason about when picking. */
const sphereField = (
  centre: readonly [number, number, number] = [0, 0, 0],
  radius = 100,
): Field => new Field(new OperationBVH([sphereAt(centre, radius)]));

/** A ray from `from` towards `to`, which need not be a unit direction. */
const towards = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): Ray => ({
  origin: { x: from[0], y: from[1], z: from[2] },
  direction: {
    x: to[0] - from[0],
    y: to[1] - from[1],
    z: to[2] - from[2],
  },
});

/**
 * How close the traced point has to be to the sphere for the test to call it a hit.
 *
 * **Ten world units, and previously the landscape's voxel size.** It is a loose safety margin
 * rather than a measurement of the tracer's accuracy — the picker's own epsilon is half a unit,
 * and asserting *that* here would be testing the tracing rather than the finding. Named here
 * because this package no longer has a voxel size to borrow (ADR 0024).
 */
const ON_THE_SURFACE = 10;

/** How far a point is from a sphere's surface, in absolute value. */
const offSurface = (
  point: { x: number; y: number; z: number },
  centre: readonly [number, number, number] = [0, 0, 0],
): number =>
  Math.abs(
    Math.hypot(point.x - centre[0], point.y - centre[1], point.z - centre[2]) -
      100,
  );

describe("picking a surface", () => {
  it("finds a sphere from outside it", () => {
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, 0]));
    expect(hit).toBeDefined();
    expect(offSurface(hit!.point)).toBeLessThan(ON_THE_SURFACE);
  });

  it("lands on the near side, not the far one", () => {
    // A picker that reported the back of the object would put every dab through it.
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, -500]))!;
    expect(hit.point.z).toBeGreaterThan(0);
    expect(hit.distance).toBeCloseTo(400, 0);
  });

  it("misses when the ray passes beside the sphere", () => {
    expect(
      pickAlong(sphereField(), towards([0, 500, 500], [0, 0, -500])),
    ).toBeUndefined();
  });

  it("misses when the surface is beyond the reach", () => {
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, 0]), {
      reach: 50,
    });
    expect(hit).toBeUndefined();
  });

  it("reports a normal pointing away from the sphere's centre", () => {
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, 0]))!;
    const length = Math.hypot(hit.normal.x, hit.normal.y, hit.normal.z);
    expect(length).toBeCloseTo(1, 9);
    // On the near side of a sphere centred at the origin, the outward normal is +z.
    expect(hit.normal.z).toBeGreaterThan(0.9);
  });

  it("turns the normal to face the camera when looking at the inside", () => {
    // The gradient points out of the solid; the user is looking down the ray, so a surface
    // whose outward normal faces away from them is one they are seeing the inside of.
    //
    // Started off the sphere's centre on purpose: a ray from the exact centre has no
    // gradient there at all, and asking for one is asking for an arbitrary direction.
    const hit = pickAlong(sphereField(), towards([0, 0, 50], [0, 0, 500]))!;
    expect(hit.normal.z).toBeLessThan(-0.9);
  });

  it("reports the origin when the camera is already inside", () => {
    // The brush preview and the primitive gizmo both put the camera inside the model, and
    // the surface is against the near plane rather than somewhere behind the user.
    const hit = pickAlong(sphereField(), towards([0, 0, 0], [0, 0, 500]));
    expect(hit).toBeDefined();
    expect(hit!.distance).toBe(0);
  });

  it("normalises the direction rather than trusting it", () => {
    // Every step depends on the direction being unit length, so a caller passing an
    // arbitrary vector must not get steps proportional to its length.
    const field = sphereField();
    const unit = pickAlong(field, towards([0, 0, 500], [0, 0, 0]));
    const long = pickAlong(field, {
      origin: { x: 0, y: 0, z: 500 },
      direction: { x: 0, y: 0, z: -997 },
    });
    expect(offSurface(long!.point)).toBeCloseTo(offSurface(unit!.point), 6);
    expect(long!.distance).toBeCloseTo(unit!.distance, 6);
  });

  it("survives a zero direction without poisoning every sample", () => {
    const hit = pickAlong(sphereField(), {
      origin: { x: 0, y: 0, z: 500 },
      direction: { x: 0, y: 0, z: 0 },
    });
    // It goes nowhere, so it never arrives; what matters is that it terminates.
    expect(hit === undefined || Number.isFinite(hit.distance)).toBe(true);
  });
});

describe("the cost of a pick", () => {
  it("takes a handful of steps across empty space, not hundreds of samples", () => {
    // This is the whole reason for sphere tracing: a march would sample every voxel.
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, 0]))!;
    expect(hit.steps).toBeLessThan(20);
  });

  it("takes more steps the further away the surface is", () => {
    const near = pickAlong(
      sphereField([0, 0, 0], 100),
      towards([0, 0, 300], [0, 0, 0]),
    )!;
    const far = pickAlong(
      sphereField([0, 0, 0], 100),
      towards([0, 0, 3000], [0, 0, 0]),
    )!;
    expect(far.steps).toBeGreaterThan(near.steps);
  });

  it("stops at the step cap rather than hanging on a bad bound", () => {
    // A Lipschitz bound that over-reports would otherwise step through the surface and
    // never converge; the cap is what makes that a wrong answer instead of a frozen tab.
    const lying: PickField = {
      distance: () => 1,
      distanceForStepping: () => 1e9,
      gradient: () => ({ x: 0, y: 1, z: 0 }),
    };
    const hit = pickAlong(lying, towards([0, 0, 500], [0, 0, 0]), {
      maxSteps: 20,
    });
    expect(hit).toBeUndefined();
  });

  it("never steps further than the saturation allows", () => {
    // ADR 0006: the field cannot report more than FAR_DISTANCE of "outside", so crossing a
    // thousand units of nothing costs twenty steps rather than one. That is the price of
    // the saturation, paid deliberately.
    const hit = pickAlong(sphereField(), towards([0, 0, 500], [0, 0, 0]))!;
    const empty = pickAlong(
      sphereField([100000, 0, 0], 100),
      towards([0, 0, 500], [0, 0, 0]),
      {
        reach: 3000,
      },
    );
    expect(empty?.steps ?? 0).toBeLessThanOrEqual(3000 / MAX_STEP + 2);
    expect(hit.steps).toBeGreaterThan(0);
  });

  it("uses the stepping distance where one is offered, and plain distance otherwise", () => {
    // A field with a base function that is not a distance function must not be stepped by
    // its raw distance, or the ray goes through the surface.
    let steppingCalls = 0;
    let plainCalls = 0;
    const scale = 4;
    const field: PickField = {
      distance: (x, y, z) => {
        plainCalls++;
        return Math.hypot(x, y, z) - 100;
      },
      distanceForStepping: (x, y, z) => {
        steppingCalls++;
        return (Math.hypot(x, y, z) - 100) / scale;
      },
      gradient: () => ({ x: 0, y: 0, z: 1 }),
    };

    const hit = pickAlong(field, towards([0, 0, 500], [0, 0, 0]));
    expect(hit).toBeDefined();
    expect(steppingCalls).toBeGreaterThan(0);
    expect(plainCalls).toBe(0);

    const withoutStepping: PickField = {
      distance: (x, y, z) => Math.hypot(x, y, z) - 100,
      gradient: () => ({ x: 0, y: 0, z: 1 }),
    };
    expect(
      pickAlong(withoutStepping, towards([0, 0, 500], [0, 0, 0])),
    ).toBeDefined();
  });
});

describe("turning a screen point into a ray", () => {
  /**
   * A real camera, off-origin and rotated, aimed at `target`.
   *
   * This fixture was hand-written matrices at the origin, and it could not have caught the
   * bug this describe block now exists to guard. With no translation and no rotation the
   * world matrix is the identity — and the identity is its own inverse, so reading
   * `matrixWorldInverse` where the world matrix belonged produced a ray that pointed the
   * right way in that fixture and the wrong way in the application. A real camera is the
   * only version of this setup where the two matrices are different numbers.
   */
  const cameraLookingAt = (
    target: { x: number; y: number; z: number },
    from = { x: 500, y: 300, z: 700 },
  ) => {
    const camera = new PerspectiveCamera(50, 1.5, 1, 10000);
    camera.position.set(from.x, from.y, from.z);
    camera.lookAt(target.x, target.y, target.z);
    // What the renderer does each frame, and what the picker therefore depends on being
    // current: the inverse matrices are only recomputed here.
    camera.updateMatrixWorld(true);
    return camera;
  };

  /** Perpendicular distance from a point to the ray, which is unit length. */
  const distanceToRay = (
    ray: Ray,
    point: { x: number; y: number; z: number },
  ): number => {
    const v = {
      x: point.x - ray.origin.x,
      y: point.y - ray.origin.y,
      z: point.z - ray.origin.z,
    };
    const along =
      v.x * ray.direction.x + v.y * ray.direction.y + v.z * ray.direction.z;
    return Math.hypot(
      v.x - ray.direction.x * along,
      v.y - ray.direction.y * along,
      v.z - ray.direction.z * along,
    );
  };

  /**
   * A camera axis in world space, read off its world matrix.
   *
   * Column-major, like every matrix in this renderer and in `rayThroughScreen` above: column
   * `c` is `elements[4c]`, `elements[4c + 1]`, `elements[4c + 2]`, and the translation is the
   * last column. Reading rows here instead is a silent sign flip rather than an error, which
   * is the same family of mistake as the one this describe block guards.
   */
  const axisOf = (camera: PerspectiveCamera, column: 0 | 1 | 2) => {
    const e = camera.matrixWorld.elements;
    return {
      x: e[4 * column],
      y: e[4 * column + 1],
      z: e[4 * column + 2],
    };
  };
  const dot = (a: { x: number; y: number; z: number }, b: Ray["direction"]) =>
    a.x * b.x + a.y * b.y + a.z * b.z;

  it("sends the centre of the screen at whatever the camera is looking at", () => {
    // The whole content of the unprojection. The centre of the screen *is* the camera's own
    // axis, so the ray through it has to pass through the target. Swapping the world matrix
    // for the view matrix still yields a unit direction leaving the camera, so nothing else
    // about the result gives the mistake away.
    const target = { x: 40, y: -25, z: 10 };
    const ray = rayThroughScreen(cameraLookingAt(target), 0, 0);
    expect(distanceToRay(ray, target)).toBeLessThan(1e-6);
  });

  it("finds the surface the camera is aimed at", () => {
    // The end-to-end version of the same property, through the field the mesher reads. This
    // is the assertion that fails outright when the two matrices are confused: the ray sails
    // past the sphere and the pick reports nothing there, which is a brush that does nothing
    // rather than an error anybody would recognise.
    const camera = cameraLookingAt({ x: 0, y: 0, z: 0 });
    const hit = pickAlong(sphereField(), rayThroughScreen(camera, 0, 0));
    expect(hit).toBeDefined();
    expect(offSurface(hit!.point)).toBeLessThan(ON_THE_SURFACE);
  });

  it("sends the right of the screen along the camera's own right", () => {
    const camera = cameraLookingAt({ x: 0, y: 0, z: 0 });
    const right = axisOf(camera, 0);
    expect(
      dot(right, rayThroughScreen(camera, 1, 0).direction),
    ).toBeGreaterThan(0);
    expect(dot(right, rayThroughScreen(camera, -1, 0).direction)).toBeLessThan(
      0,
    );
  });

  it("sends the top of the screen along the camera's own up", () => {
    // Screen y grows downwards and NDC y upwards, and getting this backwards inverts the
    // vertical axis of every pick — which looks like a brush offset rather than an error.
    const camera = cameraLookingAt({ x: 0, y: 0, z: 0 });
    const up = axisOf(camera, 1);
    expect(dot(up, rayThroughScreen(camera, 0, 1).direction)).toBeGreaterThan(
      0,
    );
    expect(dot(up, rayThroughScreen(camera, 0, -1).direction)).toBeLessThan(0);
  });

  it("starts the ray at the camera, whatever is on screen", () => {
    const camera = cameraLookingAt({ x: 0, y: 0, z: 0 });
    for (const ndc of [
      [0, 0],
      [0.3, 0.4],
      [-0.7, 0.2],
    ]) {
      const ray = rayThroughScreen(camera, ndc[0], ndc[1]);
      expect(ray.origin).toEqual({ x: 500, y: 300, z: 700 });
      expect(
        Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z),
      ).toBeCloseTo(1, 9);
    }
  });
});

describe("screen position to normalised device coordinates", () => {
  it("puts the top-left at -1, 1", () => {
    expect(toNdc(0, 0, 800, 600)).toEqual({ x: -1, y: 1 });
  });

  it("puts the bottom-right at 1, -1", () => {
    expect(toNdc(800, 600, 800, 600)).toEqual({ x: 1, y: -1 });
  });

  it("puts the centre at the origin", () => {
    const ndc = toNdc(400, 300, 800, 600);
    expect(ndc.x).toBeCloseTo(0, 12);
    expect(ndc.y).toBeCloseTo(0, 12);
  });

  it("flips y, because the screen grows downwards", () => {
    expect(toNdc(400, 100, 800, 600).y).toBeGreaterThan(0);
    expect(toNdc(400, 500, 800, 600).y).toBeLessThan(0);
  });
});

describe("a ray stepped by hand", () => {
  it("puts a point the distance along the ray", () => {
    const point = rayAt(towards([0, 0, 500], [0, 0, 0]), 400);
    expect(point.z).toBeCloseTo(100, 9);
  });

  it("is unaffected by how long the direction is written", () => {
    const short = rayAt(towards([0, 0, 500], [0, 0, 0]), 400);
    const long = rayAt(
      { origin: { x: 0, y: 0, z: 500 }, direction: { x: 0, y: 0, z: -100 } },
      400,
    );
    expect(long.z).toBeCloseTo(short.z, 9);
  });
});
