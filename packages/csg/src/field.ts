/**
 * The field: what the mesher samples and the picker traces.
 *
 * A field is a signed distance function over space, composed of two parts:
 *
 *     distance(p) = fold( operations, p, baseField?(p) )
 *
 * The operation list is the model. The optional `baseField` is whatever the model
 * is carved out of — absent for a sculpting session, a height field for an
 * infinite world (ADR 0004). This class is the seam between them: adding an
 * infinite world is a new `baseField` and nothing else, because the composition
 * order, the candidate cache, the gradient and colour resolution are all here
 * already.
 *
 * Composition order is fixed and matters. The base field is combined first and the
 * operations after it, so a subtraction carves into terrain exactly as it carves
 * into another operation. The other order would let a brush pass through the
 * ground instead of digging into it.
 *
 * Everything here is a pure function of position, apart from the operation BVH's
 * candidate cache. That is what makes the field safe to hand to a worker: the
 * cache is rebuilt on first use there, and no sample depends on where the samples
 * before it were taken.
 */

import {
  DEFAULT_FIELD_STEP,
  type Bounds,
  type Rgb8,
  type Vec3,
} from "@big-mesh-studios/core";
import { OperationBVH } from "./bvh";
import {
  emptyField,
  foldOperations,
  type Operation,
  type SurfaceColour,
} from "./operations";

/** A field everything else is carved out of. */
export type BaseField = (x: number, y: number, z: number) => number;

/** Somewhere to read a painted colour from, when a point has been painted. */
export interface PaintSource {
  /** The colour at a point, or undefined where none has been painted. */
  at(x: number, y: number, z: number): Rgb8 | undefined;
}

/**
 * What a base field can say about a region without being sampled.
 *
 * Separate from `BaseField` because a base field is a function and a function cannot answer
 * anything, and because the honest answer is a property of the base field alone: a height
 * field can bound its own column range, and an arbitrary one cannot say anything at all.
 * The composition asks; the base field decides.
 */
export interface SurfaceExtent {
  /**
   * Whether a box could hold a surface, judged from the base field alone.
   *
   * Must be conservative in one direction only. Answering `false` for a box that does hold
   * surface puts a hole in the world that nothing will re-mesh, because the mesher that
   * skipped it recorded an answer. Answering `true` costs a chunk's worth of samples and
   * nothing else.
   */
  couldHoldSurface(bounds: Bounds): boolean;
}

/** The colour a surface takes where nothing has been painted. */
export const DEFAULT_COLOUR: Rgb8 = { r: 190, g: 186, b: 176 };

export interface FieldOptions {
  base?: BaseField;
  /**
   * What `base` can say about a region, when it can say anything.
   *
   * A separate option rather than a member of `BaseField` because that is a function type
   * and cannot carry a method, and because a caller that has a height field should not have
   * to wrap it to ask it a question. A terrain satisfies both options with one value, which
   * is what makes it hard to pair them wrongly.
   */
  extent?: SurfaceExtent;
  paint?: PaintSource;
  /**
   * The largest factor by which the base field may over-report a distance, and so
   * the factor every reported distance is scaled down by.
   *
   * A signed distance function must never over-report. A sphere-tracing picker
   * that is told a surface is further away than it is steps past it, and the
   * symptom is a picker that appears to pass through the model.
   *
   * The operations alone are composed from exact distances by `min`, `max` and
   * their smooth versions, so their bound is exactly 1 and this is 1. A height
   * field is not a distance function in any direction but the vertical one, so it
   * must be divided by the largest gradient it has — which is why the property
   * lives on the composition rather than inside a terrain implementation.
   */
  lipschitz?: number;
  /**
   * The normal to report where the field's own gradient is zero, as a function of position.
   *
   * **There is no answer that is right everywhere**, which is why this is an option and the
   * default stands. A zero gradient is a point on a medial axis or in open space; nothing can be
   * shaded from a direction there, and a normal of `(0, 0, 0)` propagates into a vertex buffer as
   * a black triangle. So something finite is returned, and `+Y` is as good as anything *on a
   * height field*.
   *
   * It is **wrong on a sphere** in a way that shows: `+Y` is outward at the equator, sideways at
   * the poles, and inward on the far side, so a planet gets a speck of shading that points into
   * the ground rather than out of it at every medial axis. A planet's field supplies
   * `normalize(p)` and the speck disappears. The symptom without it is small and the cause is
   * invisible, which is the usual combination.
   */
  fallbackNormal?: (x: number, y: number, z: number) => Vec3;
  /**
   * The central-difference step for gradients. Left unset it is a tenth of a
   * voxel, which is the smallest distance the mesher can resolve.
   */
  step?: number;
}

/** The direction a field reports where it has none, unless told otherwise. See `FieldOptions`. */
const UP: Vec3 = { x: 0, y: 1, z: 0 };

export class Field {
  readonly bvh: OperationBVH;
  readonly base: BaseField | undefined;
  readonly paint: PaintSource | undefined;
  /** What the base field can say about a region, if it can say anything. */
  readonly extent: SurfaceExtent | undefined;

  /**
   * A factor at or below one that every distance is scaled by, so that stepping
   * by the result can never overshoot a surface. See `FieldOptions.lipschitz`.
   */
  readonly lipschitz: number;

  /** The central-difference step used by `gradient`. */
  readonly step: number;

  /** Where `gradient` gets a direction when the field has none. See `FieldOptions`. */
  private readonly fallbackNormal: (x: number, y: number, z: number) => Vec3;

  constructor(bvh: OperationBVH, options: FieldOptions = {}) {
    this.bvh = bvh;
    this.base = options.base;
    this.extent = options.extent;
    this.paint = options.paint;
    this.fallbackNormal = options.fallbackNormal ?? (() => UP);

    const bound = options.lipschitz ?? 1;
    // Clamped rather than trusted. A base field that mis-measures its gradient
    // gets a conservative picker, which is slow; the alternative is a factor
    // above one, which claims surfaces are further away than they are and is
    // broken.
    this.lipschitz = bound > 0 && bound <= 1 ? bound : 1;
    this.step = options.step ?? DEFAULT_FIELD_STEP;
  }

  /** Replaces the operation list. The base field and paint source are unaffected. */
  setOperations(operations: readonly Operation[]): void {
    this.bvh.set(operations);
  }

  /** The signed distance at a point, in world units. Negative inside. */
  distance(x: number, y: number, z: number): number {
    const initial = this.base !== undefined ? this.base(x, y, z) : emptyField();
    if (this.bvh.empty) return initial;
    return foldOperations(
      this.bvh.candidatesAt({ x, y, z }),
      { x, y, z },
      initial,
    );
  }

  /**
   * A distance safe to step along by, scaled so following it cannot overshoot.
   *
   * This is what a sphere-tracing picker walks with, and the reason a height
   * field can be one without the picker passing through the ground.
   *
   * It does not make the mesher's job harder: the mesher reads signs and
   * interpolates, and never steps, so it uses `distance` directly.
   */
  distanceForStepping(x: number, y: number, z: number): number {
    return this.distance(x, y, z) * this.lipschitz;
  }

  /**
   * The surface normal at a point, as central differences.
   *
   * Central rather than analytic because the field is a composition. A smooth
   * minimum of several operations has no closed-form derivative, so an analytic
   * gradient would have to be derived per boolean and would still miss the
   * combination. Six evaluations is what `fast-surface-nets` spends on the same
   * job.
   */
  gradient(x: number, y: number, z: number, step = this.step): Vec3 {
    const h = step;
    const dx = this.distance(x + h, y, z) - this.distance(x - h, y, z);
    const dy = this.distance(x, y + h, z) - this.distance(x, y - h, z);
    const dz = this.distance(x, y, z + h) - this.distance(x, y, z - h);
    const length = Math.hypot(dx, dy, dz);
    // A zero gradient is a point with no surface near it, or one exactly on a medial axis where
    // the field has a crease. See `FieldOptions.fallbackNormal` for why this is an option.
    if (length === 0) return this.fallbackNormal(x, y, z);
    return { x: dx / length, y: dy / length, z: dz / length };
  }

  /**
   * The colour of the surface at a point, and how opaque it is.
   *
   * A painted tile wins over an operation. The tile is the direct record of a
   * paint stroke and the operation is the shape it was drawn through, so when both
   * cover a point the stroke is the more recent statement about it — and choosing
   * otherwise would make a hard paint vanish the moment a soft paint covered the
   * same ground.
   *
   * **A tile is opaque, so a tile's answer carries no opacity.** Tiles store three
   * bytes per sample and there is nowhere in that layout for a fourth, so a tile
   * found here is reported at full opacity rather than the layout being widened to
   * carry a value nothing ever wrote.
   */
  colourAt(x: number, y: number, z: number): SurfaceColour {
    const painted = this.paint?.at(x, y, z);
    if (painted !== undefined) return { colour: painted, opacity: 1 };
    return (
      this.bvh.evalPaint(x, y, z) ?? { colour: DEFAULT_COLOUR, opacity: 1 }
    );
  }

  /**
   * Whether a box could hold a surface at all.
   *
   * The mesher's first gate, and the reason a terrain world can be streamed: a chunk
   * entirely above the tallest thing the base field can produce has no sign change
   * anywhere in it and needs no samples at all. In a height-field world most chunks are
   * exactly that — air above the landscape, or solid below it — and skipping them is the
   * difference between streaming at a walking pace and grinding.
   *
   * **The base field is only half the answer, and the half that is easy to get wrong.** A
   * chunk with no terrain in it can still hold a primitive: a sphere floating in the sky is
   * a chunk the base field says is nothing but air. Believing the base field alone would
   * delete every object in the world that is not touching the ground, and nothing would
   * re-mesh them — the mesher that skipped it has recorded an answer. So a base field that
   * says no is only believed once the operation list has been asked too: one box query, and
   * only on the path where the base field has already said no.
   *
   * `true` whenever there is nothing to ask, which is why a field with no base field is
   * unchanged by any of this.
   */
  couldHoldSurface(bounds: Bounds): boolean {
    if (this.extent === undefined) return true;
    if (this.extent.couldHoldSurface(bounds)) return true;
    return this.bvh.query(bounds).length > 0;
  }

  /**
   * Declares a region about to be sampled, so one candidate cache serves all of it, and
   * returns the function that ends it.
   *
   * Delegated to the BVH, which is where the cache lives, because *declaring a region is
   * a statement about sampling* and the mesher should not have to know that the field
   * happens to be built over a tree. A mesher reaching through `field.bvh` for this would
   * be reaching through an implementation detail to get at a property of the field.
   *
   * Optional rather than required: a field with no operation list has nothing to cache,
   * and a caller holding a plain base field should not have to pretend otherwise. The
   * mesher checks before it calls.
   */
  beginRegion(bounds: Bounds): (() => void) | undefined {
    return this.bvh.beginRegion(bounds);
  }
}

export type { Operation };
