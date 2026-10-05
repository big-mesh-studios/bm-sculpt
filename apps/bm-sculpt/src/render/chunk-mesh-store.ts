/**
 * Which slot has which mesh on the GPU, and the scene's membership.
 *
 * This is the class ADR 0007 asked for: *a slot must be marked unfilled by whichever of
 * those invalidates it, and the class should refuse to answer for a slot whose revision
 * does not match what the caller holds.*
 *
 * **The revision is the point.** Every slot carries a counter that moves on every
 * invalidation — stale, repositioned, released, or resized under it. A caller that
 * obtained a mesh holds the revision it was taken at, and handing that mesh back after
 * the slot has moved on is refused. Without it there is a window of frames between a slot
 * being re-pointed at a new cell and its new mesh landing, in which the slot physically
 * holds the previous cell's geometry; installing a late answer then draws one chunk's
 * surface at another's coordinates. Nothing errors, and the artefact is a flicker nobody
 * can reproduce.
 *
 * The pool's own generation check covers the same race for a *reply that arrives late*.
 * This covers the one the pool cannot see: it does not depend on every caller having
 * remembered to abandon the old cell, because the owner of the state enforces the
 * invariant rather than trusting its callers to. Belt, braces, and the braces are what
 * run when the belt's user forgets.
 *
 * ## Two groups, and why the sea is not just another slot mesh
 *
 * **Every opaque surface has to be drawn before every translucent one, and rmsl has no
 * render-order key.** Draw order is scene traversal order (`Scene.render` walks
 * `children` in insertion order and draws each as it goes), so the only way to say "all
 * the ground, then all the sea" is to put them in two groups and add those groups in that
 * order. A sea mesh added per slot alongside its ground mesh would be interleaved with
 * them, and the sea would blend over ground that was drawn after it — which, for ground
 * that is *nearer* than the sea, means a shore drawn through the water.
 *
 * So the two surfaces are two groups, and the group's position in the scene is the whole
 * of the ordering. This replaces a promise the application used to keep by hand: the sea
 * used to be re-added to the scene after the globe resolved, because a globe added later
 * would otherwise blend over the ocean (see `app.tsx`'s comment that this removed).
 *
 * Nothing here knows what a chunk contains, and nothing here asks the window what a slot
 * holds. The window owns cell identity and answerability; this owns GPU resources and the
 * scene's children. The two meet at the callbacks in `ChunkWindowParams`.
 */

import type { Material } from "@random-mesh/rmsl/scene";
import type { Mesh as SceneMesh, Scene } from "@random-mesh/rmsl/scene";
import { Group } from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "@big-mesh-studios/meshing";

import type { MeshedChunk } from "../mesh/protocol";
import {
  type SlotGeometry,
  emptySlotGeometry,
  installChunkMesh,
  releaseSlotGeometry,
  slotDraws,
} from "./chunk-geometry";

/** Why a mesh was refused, which is more useful than a bare false. */
export type Refusal =
  /** The slot has been invalidated since this mesh was requested. */
  | "staleRevision"
  /** The slot is not one this store has. */
  | "unknownSlot";

export interface ApplyOutcome {
  readonly accepted: boolean;
  readonly refusal?: Refusal;
}

const accepted: ApplyOutcome = { accepted: true };
const refused = (reason: Refusal): ApplyOutcome => ({
  accepted: false,
  refusal: reason,
});

/**
 * One surface's worth of per-slot state: the geometry, the mesh, and whether it is drawn.
 *
 * **A pair of these per slot rather than one struct holding two**, because the two
 * surfaces have genuinely independent lives — a chunk of open ocean has a sea and no
 * ground — and folding them into one would mean every path through `markStale` and
 * `resize` had to remember to clear both.
 */
interface Surface {
  readonly slots: SlotGeometry[];
  readonly revisions: number[];
  readonly inScene: (SceneMesh | undefined)[];
  /** The group's scene children, in draw order. See the header. */
  readonly group: Group;
}

export class ChunkMeshStore {
  private readonly ground: Surface;
  private readonly sea: Surface | undefined;

  /**
   * How many times a mesh was refused for being stale.
   *
   * Counted rather than merely avoided, because "this never happens" and "this happens
   * and is handled" are indistinguishable from the outside, and only one of them is
   * trustworthy. A count that climbs while scrolling says the pool's cancellation is not
   * keeping up, which is worth knowing.
   */
  staleRefusals = 0;

  constructor(
    private readonly scene: Scene,
    private readonly material: Material,
    slots: number,
    /**
     * The sea's material, or `undefined` for a world with no sea.
     *
     * **One material for every water mesh, not one per mesh**, which is the same arrangement
     * the ground uses and for the same reason: the day's light, the fog and the place's
     * lights are written into a material once a frame, and a second instance would be a
     * second thing to remember to write to.
     */
    private readonly seaMaterial?: Material,
  ) {
    // **Ground first, then sea, and the sea's group only if there is a sea.** The order these
    // two lines run in is the draw order — it is the only ordering this renderer has, so it
    // is stated by the constructor's own field order rather than left to a reader to infer.
    this.ground = this.makeSurface();
    if (seaMaterial !== undefined) this.sea = this.makeSurface();
    this.resize(slots);
  }

  /** Builds one surface's bookkeeping and puts its group in the scene, in order. */
  private makeSurface(): Surface {
    const group = new Group();
    this.scene.add(group);
    return { slots: [], revisions: [], inScene: [], group };
  }

  /** The revision a slot is currently at. Capture this before requesting a mesh. */
  revisionOf(slot: number): number {
    return this.ground.revisions[slot] ?? 0;
  }

  /** Whether a mesh taken at `revision` has since been overtaken. */
  isStale(slot: number, revision: number): boolean {
    return this.revisionOf(slot) !== revision;
  }

  /**
   * Installs a chunk's surfaces for a slot and puts them in their groups.
   *
   * Refuses a mesh whose revision the slot has moved past, and leaves the slot untouched
   * when it does: a refused mesh must not even replace the geometry that is already
   * right, or a refusal would be a second way to lose the surface.
   *
   * **Either surface may be absent, and absent means "this chunk has none of that".** A
   * chunk of open ocean answers with a sea and no ground, a mountain with the reverse, and
   * both are ordinary — so this replaces what was there, which is the only half that is
   * right: an absent ground is a ground that must go, because the slot has been recycled
   * and whatever the previous cell drew there is no longer wanted.
   */
  apply(slot: number, meshed: MeshedChunk, revision: number): ApplyOutcome {
    const ground = this.ground.slots[slot];
    if (ground === undefined) return refused("unknownSlot");
    if (revision !== this.revisionOf(slot)) {
      this.staleRefusals++;
      return refused("staleRevision");
    }

    for (const surface of this.surfaces) this.takeOut(slot, surface);
    installChunkMesh(ground, meshed.ground ?? EMPTY, this.material);
    // **Only for a world that has a sea.** A world with no sea material has no sea slots,
    // and offering it one would put water in an editor that has no water in it.
    if (this.sea !== undefined)
      installChunkMesh(
        this.sea.slots[slot]!,
        meshed.sea ?? EMPTY,
        this.seaMaterial!,
      );
    for (const surface of this.surfaces) this.addIn(slot, surface);
    return accepted;
  }

  /**
   * Marks a slot stale: frees its buffers and takes them out of the scene.
   *
   * **The one way a slot's geometry is ever discarded.** Everything that leaves a slot
   * holding another cell's surface routes through here, so there is no second path that
   * could remove a mesh and forget to move the revision — and no path that moves the
   * revision without taking the surface out with it, which is the failure ADR 0007 records
   * happening twice in one method.
   *
   * The counterpart to {@link markOutOfDate}, which also moves the revision but keeps the
   * buffers. Between them is every way a slot stops being what the window wants.
   */
  markStale(slot: number): void {
    const ground = this.ground.slots[slot];
    if (ground === undefined) return;
    for (const surface of this.surfaces) {
      this.takeOut(slot, surface);
      releaseSlotGeometry(surface.slots[slot]!);
    }
    this.ground.revisions[slot] = this.revisionOf(slot) + 1;
  }

  /**
   * Marks a slot's meshes out of date while the slot keeps its cell.
   *
   * The meshes stay in the scene until their replacements land, and the revision still
   * moves, so a late answer is refused exactly as before. Both halves are load-bearing:
   * keeping them is what stops an edit from punching a hole in the model for as long as
   * the mesher takes, and moving the revision is what stops the meshes that eventually
   * arrive from being ones the model has already moved past.
   *
   * Sound for one reason only, and the method exists to say it out loud: **the cell has
   * not changed.** Everything already on the GPU for this slot is therefore a surface of
   * the cell the slot still stands for, at the coordinates it occupies — whether it is the
   * previous model of that cell, or the previous level of detail of it. How wrong it is
   * does not matter; *which cell it belongs to* is the whole question, and drawing one
   * cell's geometry at another's position is the artefact the revision mechanism exists to
   * prevent. So reposition and release go through `markStale` and drop the buffers, and
   * only the paths that leave the cell alone come here.
   */
  markOutOfDate(slot: number): void {
    if (this.ground.slots[slot] === undefined) return;
    this.ground.revisions[slot] = this.revisionOf(slot) + 1;
  }

  /** Whether a slot currently has something to draw, on either surface. */
  draws(slot: number): boolean {
    return this.surfaces.some((surface) =>
      slotDraws(surface.slots[slot] ?? emptySlotGeometry()),
    );
  }

  /** Triangles a slot holds, on either surface. */
  trianglesAt(slot: number): number {
    return this.surfaces.reduce(
      (count, surface) => count + (surface.slots[slot]?.triangles ?? 0),
      0,
    );
  }

  /** Triangles of sea surface on the GPU, across every slot, for the readouts. */
  get seaTriangles(): number {
    const sea = this.sea;
    if (sea === undefined) return 0;
    return sea.slots.reduce((count, slot) => count + slot.triangles, 0);
  }

  /** How many slots hold a drawable sea surface. */
  get seaDrawnCount(): number {
    const sea = this.sea;
    if (sea === undefined) return 0;
    return sea.slots.reduce(
      (count, slot) => count + (slotDraws(slot) ? 1 : 0),
      0,
    );
  }

  /** How many slots hold ground on the GPU. */
  get drawnCount(): number {
    return this.ground.slots.reduce(
      (count, slot) => count + (slotDraws(slot) ? 1 : 0),
      0,
    );
  }

  /** Triangles across every slot and both surfaces, for a readout. */
  get triangleCount(): number {
    return this.groundTriangles + this.seaTriangles;
  }

  /** Both surfaces, sea last, for the paths that clear every one of them. */
  private get surfaces(): readonly Surface[] {
    return this.sea === undefined ? [this.ground] : [this.ground, this.sea];
  }

  /** Triangles of ground on the GPU, across every slot, for a readout. */
  get groundTriangles(): number {
    return this.ground.slots.reduce((count, slot) => count + slot.triangles, 0);
  }

  /**
   * Grows or shrinks to a new slot count, invalidating every slot.
   *
   * A reshape moves cells between slots arbitrarily, so a mesh captured against the old
   * shape is a mesh for a cell its slot no longer holds — which is the whole hazard of
   * slot identity (ADR 0005) and exactly what the previous version got wrong twice over:
   * it moved the revisions without freeing the geometry, so the slot went on drawing the
   * old cell's surface while refusing every new mesh; and it cleared its own record of
   * which meshes were in the scene, so nothing could ever take them out again.
   *
   * Everything routes through `markStale`, which is ADR 0007's rule: there is exactly one
   * way a slot is invalidated and this is it.
   */
  resize(slots: number): void {
    if (slots === this.ground.slots.length) return;

    for (let slot = 0; slot < this.ground.slots.length; slot++)
      this.markStale(slot);

    for (const surface of this.surfaces) {
      while (surface.slots.length < slots) {
        surface.slots.push(emptySlotGeometry());
        surface.revisions.push(0);
        surface.inScene.push(undefined);
      }
      surface.slots.length = slots;
      surface.revisions.length = slots;
      surface.inScene.length = slots;
    }
  }

  /**
   * Frees every buffer and empties the scene of chunk meshes.
   *
   * **The groups come out; the scene does not.** An earlier version called
   * `scene.clear()`, which empties every child — and the sky, the globe and the clouds are
   * children too. It was survivable only because the application happened to dispose the
   * globe first, which is a coincidence in a caller rather than a rule anyone could read.
   */
  dispose(): void {
    for (let slot = 0; slot < this.ground.slots.length; slot++)
      this.markStale(slot);
    for (const surface of this.surfaces) {
      this.scene.remove(surface.group);
      surface.slots.length = 0;
      surface.revisions.length = 0;
      surface.inScene.length = 0;
    }
  }

  /** How many slots the store covers. */
  get size(): number {
    return this.ground.slots.length;
  }

  private addIn(slot: number, surface: Surface): void {
    const state = surface.slots[slot]!.state;
    if (state.kind !== "drawn") return;
    surface.inScene[slot] = state.mesh;
    surface.group.add(state.mesh);
  }

  /**
   * Takes a slot's mesh out of its group and frees its buffers.
   *
   * Both halves matter and they are separate concerns: a mesh left in the scene keeps
   * being drawn, and a geometry left undisposed keeps its buffers alive even after it has
   * been removed. Only `releaseSlotGeometry` does the second, and only the group does the
   * first.
   */
  private takeOut(slot: number, surface: Surface): void {
    const mesh = surface.inScene[slot];
    if (mesh === undefined) return;
    surface.group.remove(mesh);
    surface.inScene[slot] = undefined;
    const entry = surface.slots[slot];
    if (entry !== undefined && entry.state.kind === "drawn") {
      entry.state.geometry.dispose();
      entry.state = { kind: "unmeshed" };
      entry.triangles = 0;
    }
  }
}

/** A mesh with nothing in it, which `installChunkMesh` records as air. */
const EMPTY: ChunkMesh = {
  positions: new Float32Array(0),
  normalOct: new Int16Array(0),
  colours: new Uint8Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
};

/**
 * The window callbacks that keep a store in step with its window.
 *
 * Returned rather than wired inside the store, because the store does not construct the
 * window and must not reach back into it — the window owns cell identity, and the store
 * owns GPU resources, and the only thing between them is this bundle of four functions.
 */
export interface StoreHooks {
  /**
   * Takes the slot and nothing else.
   *
   * The window's own callback also receives the cell, and deliberately so — dropping it
   * would be a good way to make the store's signature look compatible with the window's
   * so the hooks could be spread straight in. They cannot, and should not: the store does
   * not know what cells are, and an argument it ignores is an argument that will be read
   * one day as if it meant something.
   */
  onSlotReposition: (slot: number) => void;
  onSlotRelease: (slot: number) => void;
  onSlotStale: (slot: number) => void;
  onSlotRefill: (slot: number) => void;
  onSlotCountChanged: (count: number) => void;
}

/**
 * Wires a store to a window's callbacks.
 *
 * The routing is one question — *which cell does this slot hold?* — with two answers.
 *
 * Reposition and release change the cell, so this cell's mesh is no longer this slot's: it
 * belongs somewhere else on the GPU entirely, its buffers go, and its revision moves.
 * Staleness and refill do not: the slot still stands for the same cell, and what it holds
 * is a surface of that cell — the previous model of it, or the previous level of detail —
 * which is the right thing to draw right up until the replacement lands. Those two keep
 * their geometry and move their revision instead.
 *
 * They differ in *why* — a stale one has a new model, a refilled one a new resolution —
 * and that distinction belongs to whoever asks for a replacement, not to whoever owns the
 * bytes. Both land on `markOutOfDate` because the store cannot act on the difference and
 * should not have to know it exists.
 */
export const hooksFor = (store: ChunkMeshStore): StoreHooks => ({
  onSlotReposition: (slot) => store.markStale(slot),
  onSlotRelease: (slot) => store.markStale(slot),
  // The two that keep the mesh, because the slot still holds this cell. Reposition and
  // release are the ones where the cell itself has changed, and there the old geometry
  // belongs somewhere else on the GPU entirely.
  onSlotStale: (slot) => store.markOutOfDate(slot),
  onSlotRefill: (slot) => store.markOutOfDate(slot),
  onSlotCountChanged: (count) => store.resize(count),
});
