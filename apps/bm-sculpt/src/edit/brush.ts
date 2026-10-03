/**
 * Turning a drag into operations.
 *
 * A stroke is a path of dabs, and each dab becomes one operation in the model. That is
 * ADR 0002's decision, with the cost it names: **the list grows with use.** A long stroke
 * is hundreds of operations, and field evaluation is linear in the operations overlapping
 * the point being sampled. It is affordable while the operations cluster where the user is
 * sculpting, and the record is explicit that this needs measuring before it is not.
 *
 * **Dabs are spaced at a quarter of the radius**, which is the number that decides whether
 * a stroke looks like a stroke. Adjacent equal spheres of radius `r` meeting `s` apart
 * scallop by `r - sqrt(r² - (s/2)²)`, which is about `s² / 8r`. At `s = r / 4` that is
 * `r / 128` — under a tenth of a voxel at any brush size this application offers, so the
 * scalloping is below what the mesher can resolve and the stroke reads as smooth. Closer
 * spacing costs operations for nothing; much closer is what turns a stroke into thousands
 * of them.
 *
 * **The blend band is what makes a soft brush soft.** `MAX_SOFTNESS` caps the band at
 * `4 * softness` world units, a tenth of a voxel, so chained smooth-minimums between
 * neighbouring dabs smooth the join without moving the surface. A soft brush and a hard
 * brush are therefore the same mechanism with a different constant.
 *
 * **A stroke is built up and committed once.** Nothing reaches the document until the
 * pointer is released, so an interrupted stroke leaves nothing behind — a half-added
 * stroke is an edit the user cannot see and cannot undo in one piece.
 */

import type { Vec3 } from "@big-mesh-studios/core";
import { MAX_SOFTNESS, makeOperation } from "@big-mesh-studios/csg";
import type { Combine, Operation } from "@big-mesh-studios/csg";

import type { Bounds, SculptDocument } from "./document";

/** How far apart dabs land, as a fraction of the brush radius. See the note above. */
export const DAB_SPACING = 0.25;

/**
 * How large a leftover gap must be, as a fraction of the spacing, before the stroke adds
 * a final dab at the pointer.
 *
 * A quarter, so the stroke can stop at most a sixteenth of the radius short — under a tenth
 * of a voxel, and invisible. Below it the leftover is pointer jitter rather than intent,
 * and dabbing every jittered frame of a slow drag would put hundreds of redundant
 * operations into one undo step.
 */
export const ENDPOINT_DAB_THRESHOLD = 0.25;

export type BrushMode = "add" | "subtract" | "paint";

export interface BrushSettings {
  /** Radius in world units. */
  readonly radius: number;
  /** 0 to `MAX_SOFTNESS`. */
  readonly softness: number;
  readonly mode: BrushMode;
  /** The colour a paint stroke leaves behind. Ignored by the other modes. */
  readonly colour: { r: number; g: number; b: number };
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 40,
  softness: 0,
  mode: "add",
  colour: { r: 214, g: 96, b: 84 },
};

const combineOf = (mode: BrushMode): Combine =>
  mode === "add" ? "Add" : mode === "subtract" ? "Subtract" : "Paint";

/**
 * A stroke in progress.
 *
 * Holds its own operations and hands them over on `end`. The index comes from the
 * document's current length rather than from a counter, because an operation's index is
 * its position in the fold and has to keep increasing monotonically — a counter that
 * restarted would put a later dab at an index already used, and the colour resolution
 * order would shift under a stroke still in progress.
 */
export class BrushStroke {
  private readonly operations: Operation[] = [];
  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;
  private lastDab: Vec3 | undefined;

  constructor(
    private readonly document: SculptDocument,
    private settings: BrushSettings = DEFAULT_BRUSH,
  ) {
    // Nothing is reserved here. A dab takes its index from the document's fold order
    // when it happens, rather than from a base computed at the start, because a stroke
    // is however long the drag was and the alternative asks every owner to remember to
    // report how far its own reservation went — an owner that forgets silently
    // reissues indices to its own later dabs.
    //
    // Not `document.count` any more, though, which is what this used: a place may
    // already hold indices above this document's length, and the two would collide.
  }

  /** How many operations this stroke has produced so far. */
  get dabCount(): number {
    return this.operations.length;
  }

  /** The world box this stroke has touched. */
  get bounds(): Bounds | undefined {
    if (this.operations.length === 0) return undefined;
    return {
      min: { x: this.minX, y: this.minY, z: this.minZ },
      max: { x: this.maxX, y: this.maxY, z: this.maxZ },
    };
  }

  /**
   * The operations added after the first `count` of them.
   *
   * For a caller streaming the stroke while it is still being drawn, which needs the
   * operations to send *and* the box they touch — the box of the whole stroke would
   * re-mesh every chunk the stroke has already visited, once per frame, for as long as the
   * pointer is down.
   */
  operationsSince(count: number): readonly Operation[] {
    return count >= this.operations.length ? [] : this.operations.slice(count);
  }

  /** Changes the brush mid-stroke, which a tool palette makes easy to do by accident. */
  configure(settings: BrushSettings): void {
    this.settings = settings;
  }

  /**
   * Extends the stroke to a point, adding dabs from wherever the last one landed.
   *
   * The distance is measured from the last *dab* rather than the last point handed in, so
   * that a fast drag produces dabs at even spacing instead of clumping wherever the
   * pointer happened to be when a frame arrived. Without that, a stroke drawn quickly has
   * gaps and one drawn slowly has hundreds of redundant operations.
   */
  extendTo(point: Vec3): number {
    const radius = Math.max(this.settings.radius, 1e-3);
    const spacing = Math.max(radius * DAB_SPACING, 1e-3);

    let from = this.lastDab ?? point;
    // One dab on the first call, so a click rather than a drag still marks.
    if (this.lastDab === undefined) {
      this.dab(point);
      return 1;
    }

    let added = 0;
    // Bounded, so a pointer jump of a hundred thousand units cannot spin here.
    for (let guard = 0; guard < 4096; guard++) {
      const distance = Math.hypot(
        point.x - from.x,
        point.y - from.y,
        point.z - from.z,
      );
      if (distance < spacing) break;
      const t = spacing / distance;
      const next = {
        x: from.x + (point.x - from.x) * t,
        y: from.y + (point.y - from.y) * t,
        z: from.z + (point.z - from.z) * t,
      };
      this.dab(next);
      from = next;
      added++;
    }

    // One dab at the pointer itself, so the stroke ends where the user lifted. Evenly spaced
    // dabs leave a remainder of up to one spacing — a quarter of the radius, which at a
    // brush this size is plainly visible as the stroke stopping short of the cursor.
    //
    // Only when the remainder is worth a whole dab. Below that it is pointer jitter, and a
    // dab for every jittered frame of a slow drag is hundreds of redundant operations and a
    // history that undoes in pieces. The threshold leaves the stroke stopping at most a
    // quarter of a spacing short, which at this spacing is a sixteenth of the radius —
    // well under a tenth of a voxel.
    const remainder = Math.hypot(
      point.x - from.x,
      point.y - from.y,
      point.z - from.z,
    );
    if (remainder > spacing * ENDPOINT_DAB_THRESHOLD) {
      this.dab(point);
      added++;
    }
    return added;
  }

  /**
   * Adds one operation.
   *
   * Public because a tool that places a single primitive — a gizmo, a stamp — wants the
   * same accounting and the same history behaviour as a stroke, and duplicating that here
   * would be the alternative.
   */
  dab(point: Vec3): Operation {
    const radius = Math.max(this.settings.radius, 1e-3);
    const softness = Math.min(
      Math.max(this.settings.softness, 0),
      MAX_SOFTNESS,
    );

    const operation = makeOperation(
      this.document.order.allocate(),
      { x: point.x, y: point.y, z: point.z },
      { type: "Ellipsoid", radius: { x: radius, y: radius, z: radius } },
      combineOf(this.settings.mode),
      {
        softness,
        // **The colour only on a paint stroke, and that is now load-bearing rather
        // than tidiness.** An operation's colour is what decides the colour of the
        // surface there, whatever the operation does to the geometry — so an `Add`
        // carrying this would paint the terrain with whichever colour the palette
        // happened to be on. This was harmless while a colour was only read off a
        // `Paint`, and it is a full-terrain repaint the moment that stops being true.
        ...(this.settings.mode === "paint"
          ? {
              colour: {
                r: clampByte(this.settings.colour.r),
                g: clampByte(this.settings.colour.g),
                b: clampByte(this.settings.colour.b),
              },
            }
          : {}),
      },
    );

    this.operations.push(operation);
    this.lastDab = { x: point.x, y: point.y, z: point.z };

    // The blend band reaches a little past the sphere, and an invalidation box that stopped
    // at the surface would leave the join outside the re-meshed chunks.
    const reach = radius + 4 * softness;
    this.minX = Math.min(this.minX, point.x - reach);
    this.minY = Math.min(this.minY, point.y - reach);
    this.minZ = Math.min(this.minZ, point.z - reach);
    this.maxX = Math.max(this.maxX, point.x + reach);
    this.maxY = Math.max(this.maxY, point.y + reach);
    this.maxZ = Math.max(this.maxZ, point.z + reach);

    return operation;
  }

  /**
   * Commits the stroke to the document as one command.
   *
   * Returns whether anything was added, so a click that landed on nothing — a stroke begun
   * and released without moving — does not put an empty command on the undo stack.
   */
  end(): boolean {
    return this.document.add(this.operations, this.bounds);
  }

  /** Throws the stroke away. For a pointer released without ever landing. */
  discard(): void {
    this.operations.length = 0;
    this.lastDab = undefined;
  }
}

/** Begins a stroke against a document. */
export const beginStroke = (
  document: SculptDocument,
  settings: BrushSettings = DEFAULT_BRUSH,
): BrushStroke => new BrushStroke(document, settings);

/** Keeps a colour inside a byte, because a palette can hand over anything. */
const clampByte = (value: number): number =>
  Math.max(0, Math.min(255, Math.round(value)));
