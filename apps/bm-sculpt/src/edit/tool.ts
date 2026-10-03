/**
 * Turning pointer and key events into edits.
 *
 * Kept out of `app.tsx` and out of the render loop because it is where the two halves of
 * phase 5 meet, and that seam is where the bugs live: a pointer position has to become a
 * pick, a pick has to become a stroke, and a stroke has to become operations *and* a set of
 * chunks to re-mesh. Getting any step wrong is invisible on screen in a way that reads as
 * "the brush is broken" rather than as the bug it is.
 *
 * Three decisions worth stating.
 *
 * **A stroke samples the field at every pointer move, not every frame.** A pointer move is
 * the user's intent; a frame is a rate the hardware chose. Interpolating between moves is
 * what makes a fast drag a continuous stroke rather than a dotted line, and the brush's own
 * dab spacing turns the samples into dabs.
 *
 * **Editing is blocked while a pointer is down for navigation.** The orbit controller claims
 * the same element, so a left drag both sculpts and navigates unless the two are told apart.
 * The rule is the one every sculpting tool uses, and it is the same rule the camera applies:
 * a bare left is sculpt, right is orbit, and shift or the middle button is pan. Shift is a
 * modifier on *any* button rather than a gesture of its own, which is what keeps a pan one
 * key away instead of one button away. This module only classifies — nothing here acts on
 * the answer — so the two halves cannot drift apart as long as they name the same gestures.
 *
 * **Undo is not a pointer gesture.** It is keys. A sculpting tool that undoes on a
 * right-click undoes the stroke that was ending at that moment, which is not what anybody
 * means.
 */

import type { Vec3 } from "@big-mesh-studios/core";

import type { PickHit } from "@big-mesh-studios/picking";
import type { Bounds } from "./document";
import type { BrushSettings, BrushStroke } from "./brush";

/** What the tool needs from the camera, for a pick. */
export interface PickCamera {
  /**
   * The camera → world matrix, which is what unprojection needs. Deliberately not
   * `matrixWorldInverse`: that is the view matrix, it runs the other way, and a camera at
   * the origin cannot tell the two apart.
   */
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  readonly projectionMatrixInverse: { readonly elements: ArrayLike<number> };
  readonly position: Vec3;
}

/**
 * What the tool does with the results of a pick.
 *
 * History is part of it rather than a separate interface the caller casts to, because the
 * tool always needs it — undo is a method on the tool, not an optional extra — and a
 * narrower interface beside this one would only invite a cast at the call site.
 */
export interface SculptTarget {
  /** Where the surface is under the pointer, if there is one. */
  pick(
    camera: PickCamera,
    clientX: number,
    clientY: number,
    width: number,
    height: number,
  ): PickHit | undefined;
  /** Begins a stroke at a point the pick found. */
  beginStroke(point: Vec3, normal: Vec3): BrushStroke;
  /**
   * The stroke has grown, so whatever shows the model can follow the pointer.
   *
   * Called once per dab rather than once per pointer move, and required to be cheap: it is
   * on the pointer path, and the work of re-sending a model belongs in a frame tick where
   * it can be coalesced. See ADR 0009 for why a dab lands on the surface the stroke began
   * on rather than on the dabs before it.
   */
  preview(stroke: BrushStroke): void;
  /** Applies a finished stroke, and re-meshes whatever it touched. */
  commit(stroke: BrushStroke): void;
  /**
   * A stroke was thrown away without being committed.
   *
   * Takes no stroke, because a caller that has already previewed one knows what it
   * streamed and does not need to be told — and cannot be made to say so reliably, since
   * the order in which a stroke is emptied and reported is the caller's business.
   */
  discardStroke(): void;
  undo(): boolean;
  redo(): boolean;
}

export interface ToolState {
  /** The stroke in progress, if the pointer is down and sculpting. */
  readonly stroke: BrushStroke | undefined;
  /** Where the surface is under the pointer, for the preview. */
  readonly hover: { readonly point: Vec3; readonly normal: Vec3 } | undefined;
  readonly sculpting: boolean;
}

export interface SculptOptions {
  readonly camera: PickCamera;
  readonly target: SculptTarget;
  /** Called when the hover changes, so a preview can be moved or hidden. */
  readonly onHover?: (hover: ToolState["hover"]) => void;
  /** Called when a stroke begins or ends. */
  readonly onStrokeState?: (sculpting: boolean) => void;
}

/** How the pointer is currently being used. */
export type DragKind = "none" | "sculpt" | "orbit" | "pan";

/**
 * The sculpt tool.
 *
 * One instance per session. Holds the stroke and the hover, and nothing else — no model,
 * no camera, no DOM.
 */
export class SculptTool {
  private stroke: BrushStroke | undefined;
  private hover: ToolState["hover"];
  private drag: DragKind = "none";
  /**
   * Whether another pointer has taken the gesture, so this one stands still.
   *
   * Not the same as having no stroke: a suspended stroke is intact and commits normally.
   */
  private suspended = false;

  constructor(private readonly options: SculptOptions) {}

  /**
   * Stops the tool responding, without ending its gesture.
   *
   * For a second finger landing mid-stroke. The user has stopped painting and started
   * navigating, and the two must not happen at once — a pick taken under a moving camera
   * lands the dab somewhere they were not looking, which is the one error a brush cannot
   * be wrong about. The stroke and its dabs are kept, so lifting the extra pointer resumes
   * exactly where it stopped, and releasing the pointer that owns the stroke still commits
   * what was laid before the interruption.
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    // A preview left sitting where it was is now pointing at nothing the user can see: the
    // camera is about to move and the preview will not move with it. Cleared here rather
    // than on the next move, so it goes the moment the second finger lands rather than
    // whenever the pointer next happens to move.
    if (suspended) this.setHover(undefined);
  }

  /** What the tool is doing, for a readout. */
  get state(): ToolState {
    return {
      stroke: this.stroke,
      hover: this.hover,
      sculpting: this.stroke !== undefined,
    };
  }

  /** The pointer went down. Decides between sculpting and navigating. */
  pointerDown(
    event: {
      button: number;
      shiftKey: boolean;
      clientX: number;
      clientY: number;
    },
    width: number,
    height: number,
  ): DragKind {
    // A second pointer is not a second brush. On a touch screen it arrives as
    // `button === 0`, the same as the first, so a caller that forwards every press would
    // otherwise begin a second stroke over the first and silently throw the first away.
    // One stroke at a time is this class's invariant; *which* pointer is allowed to own it
    // is the caller's problem, and answering it here would be answering it twice.
    if (this.stroke !== undefined) return this.drag;

    // A bare left drag sculpts. Everything else is navigation, whatever else is true, so a
    // drag can never do two things at once.
    if (event.button === 0 && !event.shiftKey) {
      this.drag = "sculpt";
      const hit = this.pickNow(event.clientX, event.clientY, width, height);
      if (hit !== undefined) {
        this.stroke = this.options.target.beginStroke(hit.point, hit.normal);
        this.options.onStrokeState?.(true);
      }
      return "sculpt";
    }

    // Shift pans on any button and the middle button pans alone, so what is left to orbit
    // is the right — here, where the left one is a brush.
    this.drag = event.shiftKey || event.button === 1 ? "pan" : "orbit";
    return this.drag;
  }

  /** The pointer moved. Sculpts, previews, or does nothing. */
  pointerMove(
    event: { clientX: number; clientY: number },
    width: number,
    height: number,
  ): void {
    // Suspended means another pointer owns the gesture. Not even the hover moves: a preview
    // that chases a finger the user is using to pan is worse than no preview at all, and a
    // hover is a pick, and a pick under a moving camera is a dab in the wrong place.
    if (this.suspended) return;

    const hit = this.pickNow(event.clientX, event.clientY, width, height);

    if (this.drag === "sculpt") {
      if (this.stroke === undefined) return;
      // A move that finds nothing is a move off the edge of the model. The stroke is left
      // open rather than ended, so coming back onto the surface continues the same stroke
      // — which is what a user dragging across a gap expects.
      if (hit === undefined) return;
      // Only when a dab actually landed. A move that adds nothing has nothing new to
      // stream, and saying so anyway would dirty the model on every frame of a slow drag.
      if (this.stroke.extendTo(hit.point) > 0) {
        this.options.target.preview(this.stroke);
      }
      return;
    }

    if (this.drag !== "none") return;

    this.setHover(
      hit === undefined ? undefined : { point: hit.point, normal: hit.normal },
    );
  }

  /** The pointer was released, ending any stroke. */
  pointerUp(): void {
    this.drag = "none";
    const stroke = this.stroke;
    this.stroke = undefined;
    if (stroke === undefined) return;
    this.options.onStrokeState?.(false);

    // A stroke that never landed — pressed on nothing, released on nothing — is discarded
    // rather than committed, so the undo stack does not fill with empty commands. Discarded
    // rather than simply dropped, because a stroke that was previewed has already been
    // streamed and something has to take it back.
    if (stroke.dabCount === 0) {
      this.options.target.discardStroke();
      stroke.discard();
      return;
    }
    this.options.target.commit(stroke);
  }

  /** The pointer left the canvas entirely. */
  pointerLeave(): void {
    this.drag = "none";
    const stroke = this.stroke;
    this.stroke = undefined;
    if (stroke !== undefined) {
      this.options.target.discardStroke();
      stroke.discard();
    }
    this.options.onStrokeState?.(false);
    this.setHover(undefined);
  }

  /** Undoes one command. */
  undo(): boolean {
    return this.options.target.undo();
  }

  /** Redoes one command. */
  redo(): boolean {
    return this.options.target.redo();
  }

  /** What the last committed stroke touched, for a caller that wants to re-mesh. */
  static boundsOf(stroke: BrushStroke): Bounds | undefined {
    return stroke.bounds;
  }

  private pickNow(
    clientX: number,
    clientY: number,
    width: number,
    height: number,
  ): { point: Vec3; normal: Vec3; distance: number } | undefined {
    const hit = this.options.target.pick(
      this.options.camera,
      clientX,
      clientY,
      width,
      height,
    );
    return hit;
  }

  private setHover(hover: ToolState["hover"]): void {
    const same =
      hover === undefined || this.hover === undefined
        ? hover === this.hover
        : hover.point.x === this.hover.point.x &&
          hover.point.y === this.hover.point.y &&
          hover.point.z === this.hover.point.z;
    if (same) return;
    this.hover = hover;
    this.options.onHover?.(hover);
  }
}
export type { BrushSettings };
