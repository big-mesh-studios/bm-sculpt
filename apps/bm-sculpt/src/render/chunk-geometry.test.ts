import { describe, expect, it, vi } from "vitest";

import { BufferGeometry, type Material } from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "@big-mesh-studios/meshing";
import {
  countDrawn,
  emptySlotGeometry,
  installChunkMesh,
  releaseSlotGeometry,
  slotDraws,
  toChunkGeometry,
  totalTriangles,
  type SlotGeometry,
} from "./chunk-geometry";

const meshOf = (
  vertices: number,
  triangles = Math.floor(vertices / 3),
): ChunkMesh => ({
  positions: new Float32Array(vertices * 3),
  normalOct: new Int16Array(vertices * 2),
  colours: new Uint8Array(vertices * 4).fill(200),
  indices: new Uint32Array(triangles * 3),
  vertexCount: vertices,
  triangleCount: triangles,
});

const material = {} as Material;

/**
 * A geometry whose disposal is observable.
 *
 * The renderer keys its buffers by geometry object and holds a dropped one for its whole
 * life, so "was this disposed" is the single most consequential thing in this file — and
 * it is invisible from the host, where nothing ever allocates a GPU buffer.
 */
const spyOnDispose = (
  geometry: BufferGeometry,
): { timesDisposed: () => number } => {
  const dispose = vi.spyOn(geometry, "dispose").mockImplementation(() => {});
  return { timesDisposed: () => dispose.mock.calls.length };
};

describe("uploading a chunk mesh", () => {
  it("gives a geometry with the three attributes and an index", () => {
    const geometry = toChunkGeometry(meshOf(12, 4));
    expect(geometry).toBeDefined();
    expect(geometry!.getAttribute("position")?.itemSize).toBe(3);
    expect(geometry!.getAttribute("normalOct")?.itemSize).toBe(2);
    expect(geometry!.getAttribute("colour")?.itemSize).toBe(4);
    expect(geometry!.index?.count).toBe(12);
  });

  it("marks the two packed attributes normalized", () => {
    // Without these the octahedral folds read as whole numbers and every normal points
    // thousands of degrees off, and the colours read as 0 and 255 rather than as
    // fractions. It is the whole risk in the packed layout and it is one flag each.
    const geometry = toChunkGeometry(meshOf(12, 4))!;
    expect(geometry.getAttribute("position")?.normalized).toBe(false);
    expect(geometry.getAttribute("normalOct")?.normalized).toBe(true);
    expect(geometry.getAttribute("colour")?.normalized).toBe(true);
  });

  it("does not copy the arrays it was handed", () => {
    // They arrived from a worker by transfer, so the chunk mesh owns them and nobody
    // else refers to them. Copying four buffers per chunk to save nothing is the wrong
    // trade.
    const mesh = meshOf(12, 4);
    const geometry = toChunkGeometry(mesh)!;
    expect(geometry.getAttribute("position")?.array).toBe(mesh.positions);
    expect(geometry.getAttribute("colour")?.array).toBe(mesh.colours);
    expect(geometry.index?.array).toBe(mesh.indices);
  });

  it("gives no geometry at all for a chunk with no surface", () => {
    // Most chunks in a terrain world. A geometry over zero-length arrays would upload
    // empty buffers to discover they cannot draw anything — and the protocol already
    // reports this as a flag with no buffers, precisely so that nothing is built.
    expect(toChunkGeometry(meshOf(0, 0))).toBeUndefined();
  });
});

describe("a slot's geometry", () => {
  it("starts unmeshed rather than air", () => {
    // The difference that matters: unmeshed means "ask the pool", air means "known to
    // draw nothing". Conflating them makes a chunk flash into view for a picker that
    // asked before its mesh landed.
    expect(emptySlotGeometry().state).toEqual({ kind: "unmeshed" });
    expect(emptySlotGeometry().triangles).toBe(0);
  });

  it("becomes drawn with a mesh that shares the material", () => {
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);

    expect(slot.state.kind).toBe("drawn");
    if (slot.state.kind !== "drawn") throw new Error("expected a drawn slot");
    expect(slot.state.mesh.geometry).toBe(slot.state.geometry);
    expect(slot.triangles).toBe(4);
  });

  it("records an air chunk as air rather than unmeshed", () => {
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(0, 0), material);
    expect(slot.state.kind).toBe("air");
    expect(slot.triangles).toBe(0);
  });

  it("disposes the outgoing geometry when a chunk is replaced", () => {
    // The failure this exists for: in a scrolling world chunks are replaced several times
    // a second, the renderer holds a dropped geometry for its whole life, and nothing
    // errors — the memory simply goes.
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    const first = slot.state.kind === "drawn" ? slot.state.geometry : undefined;
    expect(first).toBeDefined();
    const spy = spyOnDispose(first!);

    installChunkMesh(slot, meshOf(24, 8), material);
    expect(spy.timesDisposed()).toBe(1);
    expect(slot.triangles).toBe(8);
  });

  it("disposes a replaced chunk's geometry even when the new one is air", () => {
    // Sculpting deletes things. A chunk that had a surface and now has none is the most
    // ordinary replacement there is, and it is exactly the case where forgetting to
    // dispose would leak on every deletion.
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    const first = slot.state.kind === "drawn" ? slot.state.geometry : undefined;
    const spy = spyOnDispose(first!);

    installChunkMesh(slot, meshOf(0, 0), material);
    expect(spy.timesDisposed()).toBe(1);
    expect(slot.state.kind).toBe("air");
  });

  it("disposes exactly once when a slot is released", () => {
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    const geometry =
      slot.state.kind === "drawn" ? slot.state.geometry : undefined;
    const spy = geometry === undefined ? undefined : spyOnDispose(geometry);

    releaseSlotGeometry(slot);
    expect(spy!.timesDisposed()).toBe(1);
    expect(slot.state.kind).toBe("unmeshed");
  });

  it("is safe to release a slot twice", () => {
    // Releasing happens on eviction, on a window reshape and on shutdown, and those can
    // overlap. Disposing twice would be harmless in most renderers and a use-after-free
    // in some.
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    releaseSlotGeometry(slot);
    expect(() => releaseSlotGeometry(slot)).not.toThrow();
    expect(slot.state.kind).toBe("unmeshed");
  });

  it("leaves an air slot alone when released", () => {
    // There are no buffers to free, and calling dispose on nothing is the sort of thing
    // that throws in a version of the library nobody tested against.
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(0, 0), material);
    expect(() => releaseSlotGeometry(slot)).not.toThrow();
  });

  it("marks a released slot unmeshed rather than air", () => {
    // The surface is very likely still there; only its mesh has left the GPU. Recording
    // it as air would stop it ever being re-requested, and the chunk would stay blank
    // until something else happened to invalidate it.
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    releaseSlotGeometry(slot);
    expect(slot.state.kind).not.toBe("air");
    expect(slot.state.kind).toBe("unmeshed");
  });
});

describe("counting what will be drawn", () => {
  it("counts drawn slots and ignores air and unmeshed ones alike", () => {
    // Every caller that walks the scene asking this wants the answer, not the reason —
    // both draw nothing.
    const slots: SlotGeometry[] = [
      emptySlotGeometry(),
      emptySlotGeometry(),
      emptySlotGeometry(),
    ];
    installChunkMesh(slots[0], meshOf(12, 4), material);
    installChunkMesh(slots[1], meshOf(0, 0), material);

    expect(countDrawn(slots)).toBe(1);
    expect(slots.map(slotDraws)).toEqual([true, false, false]);
    expect(totalTriangles(slots)).toBe(4);
  });

  it("reports nothing for an empty window", () => {
    expect(countDrawn([])).toBe(0);
    expect(totalTriangles([])).toBe(0);
  });

  it("counts a released slot as nothing", () => {
    const slot = emptySlotGeometry();
    installChunkMesh(slot, meshOf(12, 4), material);
    releaseSlotGeometry(slot);
    expect(countDrawn([slot])).toBe(0);
    expect(totalTriangles([slot])).toBe(0);
  });
});
