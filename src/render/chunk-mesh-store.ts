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
 * Nothing here knows what a chunk contains, and nothing here asks the window what a slot
 * holds. The window owns cell identity and answerability; this owns GPU resources and the
 * scene's children. The two meet at the callbacks in `ChunkWindowParams`.
 */

import type { Material } from "@random-mesh/rmsl/scene";
import type { Mesh as SceneMesh, Scene } from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "../mesh";

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

export class ChunkMeshStore {
  private readonly slots: SlotGeometry[] = [];
  /** One per slot, moved on by every invalidation. What makes a late answer detectable. */
  private readonly revisions: number[] = [];
  /** The meshes currently in the scene, so release can take them out again. */
  private readonly inScene: (SceneMesh | undefined)[] = [];

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
  ) {
    this.resize(slots);
  }

  /** The revision a slot is currently at. Capture this before requesting a mesh. */
  revisionOf(slot: number): number {
    return this.revisions[slot] ?? 0;
  }

  /** Whether a mesh taken at `revision` has since been overtaken. */
  isStale(slot: number, revision: number): boolean {
    return this.revisionOf(slot) !== revision;
  }

  /**
   * Installs a chunk's mesh for a slot and puts it in the scene.
   *
   * Refuses a mesh whose revision the slot has moved past, and leaves the slot untouched
   * when it does: a refused mesh must not even replace the geometry that is already
   * right, or a refusal would be a second way to lose the surface.
   */
  apply(slot: number, mesh: ChunkMesh, revision: number): ApplyOutcome {
    const entry = this.slots[slot];
    if (entry === undefined) return refused("unknownSlot");
    if (revision !== this.revisionOf(slot)) {
      this.staleRefusals++;
      return refused("staleRevision");
    }

    // Out first, so the slot never holds two sets of buffers even momentarily.
    this.takeOut(slot);
    installChunkMesh(entry, mesh, this.material);
    if (entry.state.kind === "drawn") this.addIn(slot, entry.state.mesh);
    return accepted;
  }

  /**
   * Marks a slot stale: frees its buffers and takes it out of the scene.
   *
   * The one way a slot becomes unfilled, which is ADR 0007's invariant. Everything that
   * invalidates a slot routes through here, so there is no second path that forgets.
   */
  markStale(slot: number): void {
    const entry = this.slots[slot];
    if (entry === undefined) return;
    this.takeOut(slot);
    releaseSlotGeometry(entry);
    this.revisions[slot] = this.revisionOf(slot) + 1;
  }

  /** Whether a slot currently has something to draw. */
  draws(slot: number): boolean {
    return slotDraws(this.slots[slot] ?? emptySlotGeometry());
  }

  /** Triangles a slot holds. */
  trianglesAt(slot: number): number {
    return this.slots[slot]?.triangles ?? 0;
  }

  /** How many slots have geometry on the GPU. */
  get drawnCount(): number {
    return this.slots.reduce(
      (count, slot) => count + (slotDraws(slot) ? 1 : 0),
      0,
    );
  }

  /** Triangles across every slot, for a readout. */
  get triangleCount(): number {
    return this.slots.reduce((count, slot) => count + slot.triangles, 0);
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
    if (slots === this.slots.length) return;

    for (let slot = 0; slot < this.slots.length; slot++) this.markStale(slot);

    while (this.slots.length < slots) {
      this.slots.push(emptySlotGeometry());
      this.revisions.push(0);
      this.inScene.push(undefined);
    }
    this.slots.length = slots;
    this.revisions.length = slots;
    this.inScene.length = slots;
  }

  /** Frees every buffer and empties the scene of chunk meshes. */
  dispose(): void {
    for (let slot = 0; slot < this.slots.length; slot++) this.markStale(slot);
    this.scene.clear();
  }

  /** How many slots the store covers. */
  get size(): number {
    return this.slots.length;
  }

  private addIn(slot: number, mesh: SceneMesh): void {
    this.inScene[slot] = mesh;
    this.scene.add(mesh);
  }

  /**
   * Takes a slot's mesh out of the scene and frees its buffers.
   *
   * Both halves matter and they are separate concerns: a mesh left in the scene keeps
   * being drawn, and a geometry left undisposed keeps its buffers alive even after it has
   * been removed. Only `releaseSlotGeometry` does the second, and only the scene does the
   * first.
   */
  private takeOut(slot: number): void {
    const mesh = this.inScene[slot];
    if (mesh === undefined) return;
    this.scene.remove(mesh);
    this.inScene[slot] = undefined;
    const entry = this.slots[slot];
    if (entry !== undefined && entry.state.kind === "drawn") {
      entry.state.geometry.dispose();
      entry.state = { kind: "unmeshed" };
      entry.triangles = 0;
    }
  }
}

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
  onSlotCountChanged: (count: number) => void;
}

/**
 * Wires a store to a window's callbacks.
 *
 * Reposition, release and staleness all invalidate, and the effect on the store is the same
 * for all three: this cell's mesh is no longer this slot's, so its buffers go and its
 * revision moves. They differ in *why* — a released slot has gone, a repositioned one has
 * not, a stale one is still there and simply has a different model — and that distinction
 * belongs to whoever asks for a replacement, not to whoever owns the bytes.
 */
export const hooksFor = (store: ChunkMeshStore): StoreHooks => ({
  onSlotReposition: (slot: number) => store.markStale(slot),
  onSlotRelease: (slot: number) => store.markStale(slot),
  onSlotStale: (slot: number) => store.markStale(slot),
  onSlotCountChanged: (count: number) => store.resize(count),
});
