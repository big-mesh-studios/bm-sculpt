/**
 * Finding the surface under the pointer.
 *
 * The picker traces the **field**, not the mesh, and that is the decision the whole of
 * phase 5 rests on. The reference implementation's picker walks the voxel grid, which means
 * it can only hit where there are voxels, answers at the resolution the mesh was built at,
 * and — the reason it is worth being explicit about — can disagree with the model the user
 * is looking at. ADR 0007 records a bug of exactly that shape: a query answered from a
 * slot holding another cell's contents put a dab where the mesh said there was nothing.
 *
 * Here the field is a function of position and nothing else, so the picker and the mesher
 * read the same function and cannot disagree about where the surface is. They can differ
 * in resolution — the mesh is coarse far away, the picker is not — which is a different
 * problem with a different answer, and is stated in the consequences below rather than
 * papered over.
 *
 * **Sphere tracing, not marching.** Step by the distance the field reports, which is what
 * makes it a handful of steps rather than hundreds of thousands of samples. The step is
 * `distanceForStepping` and not `distance`, because the field is only a *lower bound* on
 * the true distance where a base field is not itself a distance function (ADR 0002,
 * ADR 0006); stepping by a distance that is too large steps through the surface.
 *
 * **The saturation is what bounds the step count.** The field cannot report more than
 * `FAR_DISTANCE` of "outside", so crossing a thousand units of empty space costs twenty
 * steps rather than one. That is the price of the saturation, and ADR 0006 already pays
 * it deliberately: a picker's reach is a few hundred units anyway.
 */

import { FAR_DISTANCE, type Vec3 } from "@big-mesh-studios/core";

/** What a picker needs from the model. Never the mesh, never the renderer. */
export interface PickField {
  /** Signed distance, negative inside. */
  distance(x: number, y: number, z: number): number;
  /**
   * A distance safe to step by — the value scaled by whatever Lipschitz bound the
   * composition is known to satisfy.
   *
   * Optional, so a field that *is* an exact distance function can say so by omission
   * rather than by implementing an identity.
   */
  distanceForStepping?(x: number, y: number, z: number): number;
  /** The outward normal at a point. */
  gradient(x: number, y: number, z: number): Vec3;
}

export interface Ray {
  readonly origin: Vec3;
  /** Unit length. Normalised here rather than trusted, since every step depends on it. */
  readonly direction: Vec3;
}

/**
 * Where a pick landed.
 *
 * The distance along the ray is kept because a caller that only wants a point does not have
 * to subtract two vectors to get it, and one that wants it — a depth readout, a falloff
 * curve — would otherwise be reaching back into the field for something the trace already
 * knew.
 */
export interface PickHit {
  readonly point: Vec3;
  /** The surface normal there, turned to face the camera. */
  readonly normal: Vec3;
  readonly distance: number;
  /** Field evaluations spent. */
  readonly steps: number;
}

export interface PickResult {
  /** Where the surface is, on it to within a fraction of a voxel. */
  readonly point: Vec3;
  /** How far along the ray that is. */
  readonly distance: number;
  /** The surface normal there, turned to face the camera. */
  readonly normal: Vec3;
  /** Field evaluations spent. For the readout, and for noticing a bad Lipschitz bound. */
  readonly steps: number;
}

export interface PickOptions {
  /** How far along the ray to look. Beyond this, "nothing there" is the honest answer. */
  readonly reach?: number;
  /**
   * How close to the surface counts as hitting it.
   *
   * A fraction of a voxel rather than a fraction of the radius: the mesher cannot resolve
   * anything finer than a voxel either, so a tighter tolerance would report a hit at a
   * precision nothing downstream can use.
   */
  readonly epsilon?: number;
  /** A hard cap on steps, so a bad Lipschitz bound costs time rather than hanging. */
  readonly maxSteps?: number;
}

const DEFAULTS = {
  reach: 4000,
  // **Half a world unit**, and previously written `VOXEL_SIZE * 0.05`. The
  // expression was a chunk-sampling unit that happened to evaluate to this, and
  // how close a trace stops is the tracer's own decision rather than the
  // landscape's voxel size (ADR 0024).
  epsilon: 0.5,
  maxSteps: 512,
} as const;

/**
 * Traces a ray and reports the first surface it meets.
 *
 * Returns `undefined` for a miss rather than a sentinel point, because "there is nothing
 * there" and "the surface is at the origin" are different answers and a caller that has to
 * tell them apart is a caller that will eventually not.
 */
export const pickAlong = (
  field: PickField,
  ray: Ray,
  options: PickOptions = {},
): PickResult | undefined => {
  const reach = options.reach ?? DEFAULTS.reach;
  const epsilon = options.epsilon ?? DEFAULTS.epsilon;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;

  const direction = normalise(ray.direction);
  // Called through the field rather than extracted from it: a method taken off an object
  // loses its receiver, and a `this` of undefined inside the field reads its BVH as
  // undefined. That is a mistake worth making once and writing down.
  const step =
    field.distanceForStepping !== undefined
      ? (x: number, y: number, z: number): number =>
          field.distanceForStepping!(x, y, z)
      : (x: number, y: number, z: number): number => field.distance(x, y, z);

  let travelled = 0;
  let steps = 0;

  while (steps < maxSteps && travelled <= reach) {
    steps++;
    const x = ray.origin.x + direction.x * travelled;
    const y = ray.origin.y + direction.y * travelled;
    const z = ray.origin.z + direction.z * travelled;

    const reported = step(x, y, z);

    if (reported < 0) {
      // Already inside. The camera is inside the model, which the brush preview and the
      // primitive gizmo both put it. Reporting the origin is what a user expects when they
      // are looking at the inside of a surface: the surface is against the near plane, not
      // somewhere further along the ray behind them.
      return hitAt(direction, x, y, z, travelled, steps, field);
    }

    if (reported <= epsilon)
      return hitAt(direction, x, y, z, travelled, steps, field);

    // The saturation caps a single step, so this is also the bound on how fast the ray can
    // cross empty space (ADR 0006).
    travelled += reported;
  }

  return undefined;
};

/**
 * Turns a screen point into a ray through the world.
 *
 * Built from the camera's own matrices rather than from its angles, because the camera is
 * driven by an orbit state rather than positioned directly and re-deriving angles from it
 * would be a second source of truth for where the camera is looking. Two matrix-vector
 * products and a normalise, and no arithmetic that can drift from what is drawn.
 *
 * **The world matrix, not its inverse.** Unprojection runs camera space → world space, and
 * `matrixWorld` is the camera → world one; `matrixWorldInverse` is the view matrix and runs
 * the other way. Reading the inverse here compiles, type-checks, and returns a
 * plausible-looking point, and it is wrong for every camera that is not sitting at the
 * origin with no rotation — which is every camera this application has. That is worth
 * writing down because the mistake is invisible in the one case a test is most likely to
 * use: the identity matrix is its own inverse, so a camera at the origin passes whether the
 * field is named `matrixWorld` or `matrixWorldInverse`. See the regression test that drives
 * a real camera from off-origin.
 */
export const rayThroughScreen = (
  camera: {
    readonly matrixWorld: { readonly elements: ArrayLike<number> };
    readonly projectionMatrixInverse: { readonly elements: ArrayLike<number> };
    readonly position: Vec3;
  },
  /** Normalised device coordinates: -1 to 1, y up. */
  ndcX: number,
  ndcY: number,
): Ray => {
  const inverseProjection = camera.projectionMatrixInverse.elements;
  const world = camera.matrixWorld.elements;

  // Unproject the near plane, which is where the perspective divide would put a point at
  // negative w and needs no division at all.
  const nearX =
    inverseProjection[0] * ndcX +
    inverseProjection[4] * ndcY +
    inverseProjection[8] * -1 +
    inverseProjection[12];
  const nearY =
    inverseProjection[1] * ndcX +
    inverseProjection[5] * ndcY +
    inverseProjection[9] * -1 +
    inverseProjection[13];
  const nearZ =
    inverseProjection[2] * ndcX +
    inverseProjection[6] * ndcY +
    inverseProjection[10] * -1 +
    inverseProjection[14];

  // Camera space to world space, which is what `matrixWorld` is for.
  const worldX =
    world[0] * nearX + world[4] * nearY + world[8] * nearZ + world[12];
  const worldY =
    world[1] * nearX + world[5] * nearY + world[9] * nearZ + world[13];
  const worldZ =
    world[2] * nearX + world[6] * nearY + world[10] * nearZ + world[14];

  return {
    origin: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    direction: normalise({
      x: worldX - camera.position.x,
      y: worldY - camera.position.y,
      z: worldZ - camera.position.z,
    }),
  };
};

/**
 * Screen position to normalised device coordinates.
 *
 * Takes the canvas size rather than a rect, so a caller cannot pass a stale layout: the
 * pointer's position is relative to the viewport and the size is a property of the canvas
 * at the moment of the event.
 */
export const toNdc = (
  clientX: number,
  clientY: number,
  width: number,
  height: number,
): { x: number; y: number } => ({
  x: (clientX / width) * 2 - 1,
  // Screen y grows downwards and NDC y grows upwards.
  y: -((clientY / height) * 2 - 1),
});

const hitAt = (
  direction: Vec3,
  x: number,
  y: number,
  z: number,
  travelled: number,
  steps: number,
  field: PickField,
): PickResult => {
  const gradient = field.gradient(x, y, z);
  const outward = normalise(gradient);
  // The gradient points out of the solid. The user is looking down the ray, so a surface
  // whose outward normal faces *away* from them is one they are seeing the inside of, and
  // the shading normal should follow their eye rather than the field.
  const facing =
    outward.x * -direction.x +
    outward.y * -direction.y +
    outward.z * -direction.z;
  const normal =
    facing < 0 ? { x: -outward.x, y: -outward.y, z: -outward.z } : outward;

  return { point: { x, y, z }, distance: travelled, normal, steps };
};

const normalise = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.y, v.z);
  // A zero vector cannot be normalised, and every step of a trace depends on the direction
  // being unit length, so it becomes a direction that goes nowhere rather than a NaN that
  // poisons every sample after it.
  if (length === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};

/** The largest single step the field can report, for anything budgeting a trace. */
export const MAX_STEP = FAR_DISTANCE;

/** What a picker needs from a ray's own state, for anyone stepping it by hand. */
export const rayAt = (ray: Ray, distance: number): Vec3 => {
  const direction = normalise(ray.direction);
  return {
    x: ray.origin.x + direction.x * distance,
    y: ray.origin.y + direction.y * distance,
    z: ray.origin.z + direction.z * distance,
  };
};
