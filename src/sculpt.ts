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
import { SculptDocument, type Change } from "./edit/document";

import { Session } from "./session";

export interface SculptSessionOptions {
  readonly session: Session;
  readonly camera: PickCamera;
  readonly operations?: readonly Operation[];
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

  constructor(private readonly options: SculptSessionOptions) {
    this.field = buildField(options.operations ?? []);
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
   * Rebuilds the field from the current operations and tells the session what changed.
   *
   * Every edit goes through here, so the field the picker traces and the model the workers
   * mesh are the same model by construction rather than by a subscription somebody has to
   * remember to make.
   */
  private applyChange(change: Change | undefined): void {
    this.field = buildField(this.document.list);
    this.options.session.setOperations(this.document.list, change?.bounds);
  }

  private target(): SculptTarget {
    return {
      pick: (camera, clientX, clientY, width, height): PickHit | undefined =>
        this.pickWith(camera, clientX, clientY, width, height),

      // The normal is not used. A dab is a sphere, and a sphere's orientation is not a
      // thing — so this is here for a tool that will care, and dropping it now would mean
      // every call site had to be revisited when something does.
      beginStroke: (): BrushStroke => beginStroke(this.document, this.brush),

      commit: (stroke: BrushStroke): void => {
        const bounds = stroke.bounds;
        if (!stroke.end()) return;
        this.applyChange({ kind: "add", bounds, count: stroke.dabCount });
      },

      undo: (): boolean => {
        const change = this.document.undo();
        if (change === undefined) return false;
        this.applyChange(change);
        return true;
      },

      redo: (): boolean => {
        const change = this.document.redo();
        if (change === undefined) return false;
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
    this.document.clear();
    if (operations.length > 0) this.document.add(operations);
    this.document.resetHistory();
    this.applyChange(undefined);
  }
}

/** A field over an operation list, on this thread. */
const buildField = (operations: readonly Operation[]): Field =>
  new Field(new OperationBVH(operations));
