/**
 * A chunk's mesh, on the GPU.
 *
 * The mesher produces four typed arrays per chunk. This turns them into something the
 * renderer draws, and gets rid of them again. The second half is the interesting half.
 *
 * **A geometry owns GPU buffers for as long as the renderer lives, unless it is
 * disposed.** The renderer's buffers are keyed by geometry *object*, so replacing a
 * chunk's mesh by dropping the geometry leaves the old one — with its buffers and the
 * arrays its attributes point at — held for the rest of the renderer's life. In a world
 * that scrolls, chunks are replaced continuously, so that is a leak on a path that runs
 * several times a second, on the hardware least able to afford it. `dispose` is
 * therefore part of *replacing* a mesh, not a thing to call when the application shuts
 * down.
 *
 * **An air chunk gets no geometry at all.** A mesh of zero vertices is not a mesh to draw;
 * it is the answer "this chunk has no surface", and the mesher protocol already reports
 * it as a flag with no buffers. Making a geometry out of it would upload zero-length
 * buffers to find out they cannot draw anything.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  type Material,
} from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "@big-mesh-studios/meshing";

/**
 * Wraps a chunk mesh in a geometry, using the attribute layout Phase 0 proved.
 *
 * The two `normalized` flags are load-bearing and were the whole risk in the packed
 * layout: without them an `Int16Array` of octahedral folds reads as whole numbers and
 * every normal in the scene points thousands of degrees off, while a `Uint8Array` of
 * colours reads as 0 and 255 rather than as fractions.
 *
 * The arrays are **not copied**. They arrived from a worker by transfer, so the chunk
 * mesh owns them and nobody else refers to them, and copying four buffers per chunk to
 * save nothing would be the wrong trade. What is copied is the *length*: `finish` already
 * trimmed them, so each array here is exactly the data and no capacity behind it.
 *
 * Returns `undefined` for a mesh with no surface, which is the common answer in a terrain
 * world and is not a failure.
 */
export const toChunkGeometry = (
  mesh: ChunkMesh,
): BufferGeometry | undefined => {
  if (mesh.vertexCount === 0) return undefined;

  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(mesh.positions, 3, false, "vertex"),
  );
  geometry.setAttribute(
    "normalOct",
    new BufferAttribute(mesh.normalOct, 2, true, "vertex"),
  );
  geometry.setAttribute(
    "colour",
    new BufferAttribute(mesh.colours, 4, true, "vertex"),
  );
  geometry.setIndex(new BufferAttribute(mesh.indices, 1));
  return geometry;
};

/**
 * What a slot's mesh currently is.
 *
 * Three states, and the difference between the last two is the one that matters: a slot
 * that has been meshed and found to be air is *known* to draw nothing, which is a
 * different thing from a slot that has not been meshed yet, and conflating them makes a
 * chunk flicker into existence when a picker asks about it before its mesh lands.
 */
export type SlotMesh =
  | { readonly kind: "unmeshed" }
  | { readonly kind: "air" }
  | {
      readonly kind: "drawn";
      readonly geometry: BufferGeometry;
      readonly mesh: Mesh;
    };

/** One slot's uploaded mesh, and the bookkeeping that keeps it honest. */
export interface SlotGeometry {
  state: SlotMesh;
  /** Triangles this slot holds, for the readouts and for budgeting. */
  triangles: number;
}

/**
 * Puts a chunk's mesh on the GPU for a slot, replacing whatever was there.
 *
 * Disposes the outgoing geometry *before* installing the new one, so a slot is never
 * holding two sets of buffers even momentarily — and so a failure to build the new one
 * leaves the slot with nothing rather than with something that does not match its
 * revision.
 */
export const installChunkMesh = (
  slot: SlotGeometry,
  mesh: ChunkMesh,
  material: Material,
): void => {
  releaseSlotGeometry(slot);

  const geometry = toChunkGeometry(mesh);
  if (geometry === undefined) {
    slot.state = { kind: "air" };
    slot.triangles = 0;
    return;
  }

  const drawn = new Mesh(geometry, material);
  slot.state = { kind: "drawn", geometry, mesh: drawn };
  slot.triangles = mesh.triangleCount;
};

/**
 * Frees a slot's GPU buffers and forgets its mesh.
 *
 * Marks the slot unmeshed rather than air: the surface may well be there, the mesh just
 * is not on the GPU. A slot whose mesh was released must be re-requested, and only the
 * chunk window knows how.
 */
export const releaseSlotGeometry = (slot: SlotGeometry): void => {
  if (slot.state.kind === "drawn") {
    // The geometry is what owns the buffers; the `Mesh` owns nothing and is dropped
    // with the state. Disposing the geometry alone is correct and sufficient.
    slot.state.geometry.dispose();
  }
  slot.state = { kind: "unmeshed" };
  slot.triangles = 0;
};

/** A slot with nothing on the GPU. */
export const emptySlotGeometry = (): SlotGeometry => ({
  state: { kind: "unmeshed" },
  triangles: 0,
});

/**
 * Whether a slot has something to draw.
 *
 * False for air as well as unmeshed, and that is the point: both draw nothing, and every
 * caller that walks the scene asking this wants the answer rather than the reason.
 */
export const slotDraws = (slot: SlotGeometry): boolean =>
  slot.state.kind === "drawn";

/** How many slots among these hold a drawable mesh. */
export const countDrawn = (slots: readonly SlotGeometry[]): number =>
  slots.reduce((count, slot) => count + (slotDraws(slot) ? 1 : 0), 0);

/** Total triangles across slots, for a readout. */
export const totalTriangles = (slots: readonly SlotGeometry[]): number =>
  slots.reduce((count, slot) => count + slot.triangles, 0);
