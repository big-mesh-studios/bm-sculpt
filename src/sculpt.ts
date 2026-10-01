/**
 * The sculpting session: the document, the field, and the tool that connects them.
 *
 * `Session` (Phase 4) streams chunks. This adds the things that *change* what is streamed —
 * a model the user edits, and a pointer that decides where.
 *
 * It owns the main thread's own field, because the picker needs one and a worker cannot be
 * asked a question. That is the one piece of duplication this design pays for: the main
 * thread holds a field, and so does every worker. They are built from the same operation
 * list and sent on every change, so they agree — and the field here is rebuilt by the same
 * path that pushes the operations out, rather than by a listener the app has to remember to
 * subscribe. A field that can silently go stale is worse than a duplicated one.
 */

import type { Vec3 } from "./constants";
import { Field, OperationBVH, type Operation } from "./csg";

import {
  type PickHit,
  pickAlong,
  rayThroughScreen,
  toNdc,
  type Ray,
} from "./pick";
import { SculptTool, type PickCamera, type SculptTarget } from "./edit/tool";
import {
  type BrushSettings,
  type BrushStroke,
  DEFAULT_BRUSH,
  beginStroke,
} from "./edit/brush";
import {
  SculptDocument,
  type Bounds,
  boundsOf,
  type Change,
} from "./edit/document";

export interface SculptSessionOptions {
  /**
   * Whatever streams the model, narrowed to the one thing a stroke has to say to it.
   *
   * Not the concrete `Session`: a `SculptSession` that cannot be built without a WebGL
   * context is a `SculptSession` whose seeding and fold-rebuild cannot be tested, and the
   * bug below lived in exactly that untested corner for want of a seam.
   */
  readonly session: SculptModelSink;
  readonly camera: PickCamera;
  readonly operations?: readonly Operation[];
}

/** The part of `Session` an edit talks to: told the model, and what it touched. */
export interface SculptModelSink {
  setOperations(operations: readonly Operation[], touched?: Bounds): void;
  /** Whether the mesher is free, which a preview waits for rather than interrupting. */
  readonly idle: boolean;
}

/** Where the preview sits, for the app to read each frame. */
export interface Preview {
  visible: boolean;
  position: Vec3;
}

export class SculptSession {
  /** The model, and its history. */
  readonly document = new SculptDocument();
  /** The tool the pointer talks to. */
  readonly tool: SculptTool;

  private field: Field;
  private brush: BrushSettings = DEFAULT_BRUSH;
  private readonly previewState: Preview = {
    visible: false,
    position: { x: 0, y: 0, z: 0 },
  };

  /**
   * The stroke being drawn, how much of it has been streamed, and what it has touched.
   *
   * The stroke is kept as a reference rather than a copy of its operations, because it is
   * the only thing that knows the order its own dabs went down in and a copy would have to
   * be kept in step with it.
   */
  private drawing: BrushStroke | undefined;
  private streamedDabs = 0;
  private streamedBounds: Bounds | undefined;

  constructor(private readonly options: SculptSessionOptions) {
    // The document is where the model lives, and it starts empty. Seeding it here is what
    // makes a stroke an *edit* rather than a replacement: every rebuild reads
    // `document.list`, so a document that did not already hold the model would have the
    // first stroke fold the model down to that stroke alone — the picker, which traces the
    // starter operations, would then be tracing a model that was no longer on screen.
    //
    // The history is dropped afterwards because the model it starts with is not something
    // the user did, and "undo" at the start of a session should not be able to delete it.
    this.document.add(options.operations ?? []);
    this.document.resetHistory();
    this.field = buildField(this.document.list);
    this.tool = new SculptTool({
      camera: options.camera,
      target: this.target(),
      onHover: (hover) => {
        this.previewState.visible = hover !== undefined;
        if (hover !== undefined) {
          this.previewState.position = { ...hover.point };
        }
      },
    });
  }

  /** Where the pointer is, for the app to move a preview with. */
  get preview(): Preview {
    return this.previewState;
  }

  /** The brush settings, and a way to change them. */
  get settings(): BrushSettings {
    return this.brush;
  }

  configure(settings: Partial<BrushSettings>): void {
    this.brush = { ...this.brush, ...settings };
  }

  /** How many commands are undoable, and how many can be redone. For a readout. */
  get undoDepth(): number {
    return this.document.undoDepth;
  }

  get redoDepth(): number {
    return this.document.canRedo ? 1 : 0;
  }

  /**
   * Rebuilds the field from the committed operations and tells the session what changed.
   *
   * Every committed edit goes through here, so the field the picker traces and the model the
   * workers mesh are the same model by construction rather than by a subscription somebody
   * has to remember to make. A stroke in progress deliberately does *not* come through
   * here — see `flushPreview`.
   */
  private applyChange(change: Change | undefined): void {
    this.field = buildField(this.document.list);
    this.options.session.setOperations(this.document.list, change?.bounds);
  }

  /**
   * Streams whatever the stroke in progress has grown, once per frame, when the mesher is
   * free.
   *
   * Called from the frame loop rather than from the pointer, so the cost is bounded by the
   * frame and not by how fast the pointer moves: a fast drag can lay a dozen dabs between
   * two frames, and this sends one model rather than twelve.
   *
   * **It waits for the workers rather than interrupting them.** Sending a model cancels
   * every mesh in flight, so a send per frame would cancel the very mesh that would show
   * the dab — the chunk under the brush would never land, and the edit would appear to do
   * nothing until the pointer stopped. Nothing is lost by waiting: the dabs stay
   * unstreamed and go out together on the next frame the mesher is free, so the update
   * rate becomes the mesher's real throughput and each one is a complete, settled model.
   *
   * **The field is not rebuilt here, and that is the point.** The picker keeps tracing the
   * committed model for the whole stroke, so a stroke's dabs land on the surface the stroke
   * began on rather than on the dabs before them. A field that followed the live model
   * would be self-feeding: each pick would climb the blob the last dab made, and a drag
   * would tower instead of drawing a ridge. The preview is an overlay on the committed
   * model, and the two are the same model again the moment the stroke is committed.
   *
   * Only the new dabs' own box is invalidated. The whole stroke's box would re-mesh every
   * chunk it has already visited, once the mesher is next free, for as long as the pointer
   * is down — and a chunk needs re-meshing only where the surface actually changed, which
   * is where the newest dabs are.
   */
  flushPreview(): void {
    const stroke = this.drawing;
    if (stroke === undefined) return;

    const undelivered = stroke.operationsSince(this.streamedDabs);
    if (undelivered.length === 0) return;
    const bounds = boundsOf(undelivered);
    if (bounds === undefined) return;

    if (!this.options.session.idle) return;

    // Advanced only now, so dabs skipped by the wait above are still pending next frame.
    this.streamedDabs = stroke.dabCount;
    this.streamedBounds = unionOf(this.streamedBounds, bounds);

    // The whole stroke, not just this frame's dabs. A dab streamed by an earlier flush lives
    // in the stroke rather than in the document until the stroke is committed, so a model
    // built from the new ones alone silently drops the rest: the live mesh then shows the
    // tail of the stroke rather than the path drawn so far, and only looks right because
    // the commit finally puts every dab in the document at once. The invalidation box stays
    // the new dabs' own, so a chunk the stroke has already passed is not re-meshed again.
    this.options.session.setOperations(
      [...this.document.list, ...stroke.operationsSince(0)],
      bounds,
    );
  }

  /** Forgets the stroke in progress, and anything streamed for it. */
  private forgetStroke(): void {
    this.drawing = undefined;
    this.streamedDabs = 0;
    this.streamedBounds = undefined;
  }

  private target(): SculptTarget {
    return {
      pick: (camera, clientX, clientY, width, height): PickHit | undefined =>
        this.pickWith(camera, clientX, clientY, width, height),

      // The normal is not used. A dab is a sphere, and a sphere's orientation is not a
      // thing — so this is here for a tool that will care, and dropping it now would mean
      // every call site had to be revisited when something does.
      beginStroke: (): BrushStroke => beginStroke(this.document, this.brush),

      // Cheap on purpose: the frame tick above does the work, and this only records which
      // stroke is in progress so that tick knows whose dabs to look at.
      preview: (stroke: BrushStroke): void => {
        if (this.drawing === stroke) return;
        this.forgetStroke();
        this.drawing = stroke;
      },

      commit: (stroke: BrushStroke): void => {
        const bounds = stroke.bounds;
        const added = stroke.end();
        this.forgetStroke();
        if (!added) return;
        this.applyChange({ kind: "add", bounds, count: stroke.dabCount });
      },

      discardStroke: (): void => {
        // A stroke the document never accepted has to be taken back off the model, or the
        // mesh keeps material that no command accounts for and no undo can remove.
        const streamed = this.streamedBounds;
        this.forgetStroke();
        if (streamed !== undefined) {
          this.field = buildField(this.document.list);
          this.options.session.setOperations(this.document.list, streamed);
        }
      },

      undo: (): boolean => {
        const change = this.document.undo();
        if (change === undefined) return false;
        this.forgetStroke();
        this.applyChange(change);
        return true;
      },

      redo: (): boolean => {
        const change = this.document.redo();
        if (change === undefined) return false;
        this.forgetStroke();
        this.applyChange(change);
        return true;
      },
    };
  }

  /**
   * Traces the pointer's ray against the main thread's field.
   *
   * The camera is read rather than stored, so the camera handed over is the one the renderer
   * is using this frame — there is no second copy to fall a frame behind.
   */
  private pickWith(
    camera: PickCamera,
    clientX: number,
    clientY: number,
    width: number,
    height: number,
  ): PickHit | undefined {
    if (width <= 0 || height <= 0) return undefined;
    const ndc = toNdc(clientX, clientY, width, height);
    const ray: Ray = rayThroughScreen(camera, ndc.x, ndc.y);
    return pickAlong(this.field, ray);
  }

  /** Puts the model back to something else, and forgets the history. */
  reset(operations: readonly Operation[] = []): void {
    this.forgetStroke();
    this.document.clear();
    if (operations.length > 0) this.document.add(operations);
    this.document.resetHistory();
    this.applyChange(undefined);
  }
}

/** A field over an operation list, on this thread. */
const buildField = (operations: readonly Operation[]): Field =>
  new Field(new OperationBVH(operations));

/** The smallest box holding both, for accumulating what a stroke has streamed. */
const unionOf = (
  a: Bounds | undefined,
  b: Bounds | undefined,
): Bounds | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return {
    min: {
      x: Math.min(a.min.x, b.min.x),
      y: Math.min(a.min.y, b.min.y),
      z: Math.min(a.min.z, b.min.z),
    },
    max: {
      x: Math.max(a.max.x, b.max.x),
      y: Math.max(a.max.y, b.max.y),
      z: Math.max(a.max.z, b.max.z),
    },
  };
};
