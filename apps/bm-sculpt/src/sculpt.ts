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

import type { Vec3 } from "@big-mesh-studios/core";
import { Field, OperationBVH, baseFieldFor } from "@big-mesh-studios/csg";
import type {
  BaseFieldSpec,
  BuiltBaseField,
  Operation,
} from "@big-mesh-studios/csg";

import {
  type PickHit,
  pickAlong,
  rayThroughScreen,
  toNdc,
  type Ray,
} from "@big-mesh-studios/picking";
import { SculptTool, type PickCamera, type SculptTarget } from "./edit/tool";
import {
  type BrushMode,
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
import { PlaceRegistry } from "./places/place-registry";

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
  /**
   * The landscape the streamed model has behind it, as the session's own parameters.
   *
   * Taken from `session.terrain` rather than configured separately, because the field this
   * builds is the one the picker traces and it has to be the model on screen. Two
   * independently configured terrains would put dabs in the air above the ground the mesher
   * drew, which is the one disagreement this whole design exists to rule out (ADR 0009).
   */
  readonly baseField?: BaseFieldSpec;
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
  /**
   * The named groups of operations that fold in after the document's.
   *
   * Built here over *this session's* `document.order` rather than passed in, because the
   * two must allocate from one counter and only the session has the document. Which
   * makes the session the owner of the registry: a script host adds to
   * `session.places` rather than holding a registry of its own, which is what stops two
   * registries existing and drifting.
   *
   * Empty until something creates a place, and flattening it costs one array copy of the
   * document's own list, so the editor and the game pay nothing for having it.
   */
  readonly places: PlaceRegistry;
  /** The tool the pointer talks to. */
  readonly tool: SculptTool;

  private field: Field;
  /**
   * The landscape, held so every rebuild of the field uses the same one. Not rebuilt per
   * edit: a base field is four numbers and a permutation table, and rebuilding it per dab would
   * put a 256-entry shuffle on the pointer path for no benefit.
   */
  private readonly base: BuiltBaseField | undefined;
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

  /**
   * The target behind both the pointer tool and the aim tool.
   *
   * One instance rather than two, so a gameplay dig and an editor sculpt share
   * the document, the streaming and the history by construction — there is no
   * second path that could edit the model without invalidating what is on
   * screen.
   */
  private readonly targetImpl: SculptTarget;

  /** The stroke an aim is currently laying, and the mode it was begun in. */
  private aimStroke: BrushStroke | undefined;
  private aimMode: BrushMode | undefined;

  constructor(private readonly options: SculptSessionOptions) {
    // The document is where the model lives, and it starts empty. Seeding it here is what
    // makes a stroke an *edit* rather than a replacement: every rebuild reads the whole
    // model, so a document that did not already hold the operations would have the first
    // stroke fold the world down to that stroke alone — the picker, which traces the
    // starter operations, would then be tracing a model that was no longer on screen.
    //
    // The history is dropped afterwards because the model it starts with is not something
    // the user did, and "undo" at the start of a session should not be able to delete it.
    //
    // The registry is built first because it shares the document's fold order, and the
    // document's `add` is what moves that order past the seeded operations.
    this.places = new PlaceRegistry(this.document.order);
    this.document.add(options.operations ?? []);
    this.document.resetHistory();
    this.base = baseFieldFor(options.baseField);
    this.field = this.buildField();
    this.targetImpl = this.target();
    this.tool = new SculptTool({
      camera: options.camera,
      target: this.targetImpl,
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

  /**
   * The field as it stands, for a caller that must read the same surface the
   * picker traces and the workers mesh.
   *
   * The player's collision samples through this rather than holding a field of
   * its own, so a dug hole is walked into on the next frame and cannot be missed
   * by a copy that was built when the session started.
   */
  get collisionField(): Field {
    return this.field;
  }

  /**
   * The landscape's surface height at a column, when the world has a height field.
   *
   * **`undefined` for a planet, and correctly so.** "The height of the surface above `(x, z)`" is
   * a question about a height field; on a sphere the surface above a column is the column's whole
   * length, and there is no such number. A place script asking gets the host's existing
   * `?? 0` fallback rather than a plausible wrong answer, and asking the physics instead is the
   * route that would work — see `PlayerWorld.getGroundDistanceAt`.
   */
  get terrainHeight(): ((x: number, z: number) => number) | undefined {
    const base = this.base;
    if (base === undefined) return undefined;
    // `BuiltBaseField` is the union of what `terrainField` and `planetField` return, and only one
    // of those two has a surface height. The narrowing is a type guard rather than a cast, so a
    // third kind of base field without a height cannot quietly satisfy it.
    return "heightAt" in base
      ? (base.heightAt as (x: number, z: number) => number)
      : undefined;
  }

  /** The brush settings, and a way to change them. */
  get settings(): BrushSettings {
    return this.brush;
  }

  configure(settings: Partial<BrushSettings>): void {
    this.brush = { ...this.brush, ...settings };
  }

  /**
   * Starts a stroke at the crosshair, for a gameplay dig or place.
   *
   * The same stroke machinery the pointer tool drives, aimed at the centre of
   * the screen instead of at a pointer position — so a dig from a crosshair and a
   * sculpt from a cursor are the same edit, and there is no second code path that
   * could touch the model without going through the document's history.
   *
   * @returns whether the ray met a surface. A miss leaves no stroke open, so the
   * caller simply tries again next frame as the player turns.
   */
  beginAim(camera: PickCamera, mode: BrushMode, ndcX = 0, ndcY = 0): boolean {
    const hit = this.pickNdc(camera, ndcX, ndcY);
    if (hit === undefined) return false;
    this.forgetStroke();
    // The brush reads its mode at `beginStroke`, so it is set before the stroke
    // starts and stays for the life of the stroke.
    this.configure({ mode });
    this.aimMode = mode;
    this.aimStroke = this.targetImpl.beginStroke(hit.point, hit.normal);
    // A click that never moves still marks: the first dab lands at the aim.
    this.aimStroke.extendTo(this.dabPoint(hit, mode));
    this.targetImpl.preview(this.aimStroke);
    return true;
  }

  /** Re-picks the crosshair and extends the open aim stroke toward it. */
  updateAim(camera: PickCamera, ndcX = 0, ndcY = 0): void {
    const stroke = this.aimStroke;
    if (stroke === undefined) return;
    const hit = this.pickNdc(camera, ndcX, ndcY);
    if (hit === undefined) return;
    if (stroke.extendTo(this.dabPoint(hit, this.aimMode)) > 0) {
      this.targetImpl.preview(stroke);
    }
  }

  /** Commits the open aim stroke, if it laid anything. */
  endAim(): void {
    const stroke = this.aimStroke;
    this.aimStroke = undefined;
    this.aimMode = undefined;
    if (stroke === undefined) return;
    if (stroke.dabCount === 0) {
      this.targetImpl.discardStroke();
      stroke.discard();
      return;
    }
    this.targetImpl.commit(stroke);
  }

  /** Throws the open aim stroke away without committing it. */
  cancelAim(): void {
    const stroke = this.aimStroke;
    this.aimStroke = undefined;
    this.aimMode = undefined;
    if (stroke === undefined) return;
    this.targetImpl.discardStroke();
    stroke.discard();
  }

  /**
   * Where an aim's dab lands.
   *
   * A dig removes material at the surface. A place adds it, and is pushed out
   * along the surface normal by half the brush radius so the new material sits on
   * top of the surface rather than being half-buried in it.
   */
  private dabPoint(hit: PickHit, mode: BrushMode | undefined): Vec3 {
    if (mode !== "add") return hit.point;
    const offset = this.brush.radius * 0.5;
    return {
      x: hit.point.x + hit.normal.x * offset,
      y: hit.point.y + hit.normal.y * offset,
      z: hit.point.z + hit.normal.z * offset,
    };
  }

  /** Traces a ray through a screen point, in normalised device coordinates. */
  private pickNdc(
    camera: PickCamera,
    ndcX: number,
    ndcY: number,
  ): PickHit | undefined {
    const ray: Ray = rayThroughScreen(camera, ndcX, ndcY);
    return pickAlong(this.field, ray);
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
    this.field = this.buildField();
    this.options.session.setOperations(this.model(), change?.bounds);
  }

  /**
   * The one operation list this session's world is built from.
   *
   * **Every reader of the operation list goes through here**, which is the whole point:
   * the field the picker traces, the model the workers mesh and the live preview are
   * three separate readers, and each of them deciding the fold order for itself is three
   * chances for the picker to trace a different field from the one on screen (ADR 0009).
   * A place's operations are in here, so `PlaceRegistry.flatten` is the answer.
   */
  private model(): readonly Operation[] {
    return this.places.flatten(this.document.list);
  }

  /**
   * The field this thread samples, over the committed operations and the landscape.
   *
   * One place, so the base field, the region it can answer for and the Lipschitz bound
   * that makes its distances safe to step by are always the *same* terrain's. Split across
   * call sites, a caller could pair one terrain's distances with another's bound and the
   * picker would walk through the ground.
   */
  private buildField(): Field {
    return new Field(new OperationBVH(this.model()), {
      base: this.base,
      extent: this.base,
      lipschitz: this.base?.lipschitz,
      // The same answer the worker gives, for the reason given in `BuiltBaseField`: a zero
      // gradient on a planet means the centre, and `+Y` is not outward from anywhere in
      // particular there.
      fallbackNormal: this.base?.fallbackNormal,
    });
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
      [...this.model(), ...stroke.operationsSince(0)],
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
          this.field = this.buildField();
          this.options.session.setOperations(this.model(), streamed);
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

  /**
   * Re-reads the model after something other than a stroke changed it.
   *
   * **The way a place's geometry reaches the meshes.** A place writes into
   * `this.places`, not through `document.add`, so nothing here would otherwise notice — and the
   * symptom is a bridge that is in the collision field and in no mesh, so the player stands on
   * something nobody can see. This is what `PlaceHost`'s `geometryChanged` calls.
   *
   * **The stroke in progress is abandoned rather than kept.** A stroke's operations live in the
   * stroke rather than the document until it is committed, and the field is *not* rebuilt while
   * one is in progress — that is what stops a drag towering (ADR 0009). A place changing the
   * world under a stroke the user is halfway through is the same situation: the honest thing is
   * to discard the stroke, which the user sees as their drag ending, rather than to commit it or
   * to fold it into a field the preview no longer matches.
   *
   * `bounds` is the box that changed, in the same contract as `Change.bounds`, so the caller
   * does not have to work out which chunks to re-mesh.
   */
  refreshPlaces(bounds?: Bounds): void {
    this.forgetStroke();
    this.applyChange({ kind: "add", bounds, count: 0 });
  }
}

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
