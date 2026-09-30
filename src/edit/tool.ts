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
 * left-drag, so a left drag both orbits and sculpts unless the two are told apart. The rule
 * is the one every sculpting tool uses: left is sculpt, right or shift-drag is orbit, middle
 * is pan.
 *
 * **Undo is not a pointer gesture.** It is keys. A sculpting tool that undoes on a
 * right-click undoes the stroke that was ending at that moment, which is not what anybody
 * means.
 */

import type { Vec3 } from "../constants";

import type { PickHit } from "../pick";
import type { Bounds } from "./document";
import type { BrushSettings, BrushStroke } from "./brush";

/** What the tool needs from the camera, for a pick. */
export interface PickCamera {
  readonly matrixWorldInverse: { readonly elements: ArrayLike<number> };
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
  /** Applies a finished stroke, and re-meshes whatever it touched. */
  commit(stroke: BrushStroke): void;
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

  constructor(private readonly options: SculptOptions) {}

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
    // Right or shift is navigation whatever else is true, and a middle button pans. Left is
    // the only one that sculpts, so a drag can never do both.
    if (event.button === 0 && !event.shiftKey) {
      this.drag = "sculpt";
      const hit = this.pickNow(event.clientX, event.clientY, width, height);
      if (hit !== undefined) {
        this.stroke = this.options.target.beginStroke(hit.point, hit.normal);
        this.options.onStrokeState?.(true);
      }
      return "sculpt";
    }

    this.drag = event.button === 1 ? "pan" : "orbit";
    return this.drag;
  }

  /** The pointer moved. Sculpts, previews, or does nothing. */
  pointerMove(
    event: { clientX: number; clientY: number },
    width: number,
    height: number,
  ): void {
    const hit = this.pickNow(event.clientX, event.clientY, width, height);

    if (this.drag === "sculpt") {
      if (this.stroke === undefined) return;
      // A move that finds nothing is a move off the edge of the model. The stroke is left
      // open rather than ended, so coming back onto the surface continues the same stroke
      // — which is what a user dragging across a gap expects.
      if (hit === undefined) return;
      this.stroke.extendTo(hit.point);
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
    // rather than committed, so the undo stack does not fill with empty commands.
    if (stroke.dabCount === 0) {
      stroke.discard();
      return;
    }
    this.options.target.commit(stroke);
  }

  /** The pointer left the canvas entirely. */
  pointerLeave(): void {
    this.drag = "none";
    this.stroke?.discard();
    this.stroke = undefined;
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
