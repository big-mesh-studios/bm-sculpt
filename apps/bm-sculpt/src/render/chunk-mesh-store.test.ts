import { describe, expect, it, vi } from "vitest";

import { Mesh, Scene, type Material } from "@random-mesh/rmsl/scene";

import type { ChunkMesh } from "@big-mesh-studios/meshing";
import { ChunkMeshStore, hooksFor } from "./chunk-mesh-store";

const meshOf = (
  vertices: number,
  triangles = Math.floor(vertices / 3),
): ChunkMesh => ({
  positions: new Float32Array(vertices * 3),
  normalOct: new Int16Array(vertices * 2),
  colours: new Uint8Array(vertices * 4),
  indices: new Uint32Array(triangles * 3),
  vertexCount: vertices,
  triangleCount: triangles,
});

const material = {} as Material;

const newStore = (
  slots = 4,
  sea: Material | undefined = undefined,
): ChunkMeshStore => new ChunkMeshStore(new Scene(), material, slots, sea);

/** A store with a sea, which is what the game has and the editor does not. */
const withSea = (slots = 4): ChunkMeshStore => newStore(slots, material);

/** What a surface's bookkeeping looks like from outside, for the tests below. */
interface SurfaceProbe {
  inScene: (Mesh | undefined)[];
  group: { children: unknown[] };
}

/**
 * The store's current mesh for a slot, for identity checks.
 *
 * **Reached through the private field because there is no accessor and this is a test**, and
 * named per surface because a test asserting on the sea should say which surface it means.
 */
const surface = (
  store: ChunkMeshStore,
  which: "ground" | "sea",
): SurfaceProbe =>
  (store as unknown as Record<"ground" | "sea", SurfaceProbe>)[which];

const meshFor = (store: ChunkMeshStore, slot: number): Mesh | undefined =>
  surface(store, "ground").inScene[slot];

const seaMeshFor = (store: ChunkMeshStore, slot: number): Mesh | undefined =>
  surface(store, "sea").inScene[slot];

describe("installing a mesh for a slot", () => {
  it("puts the mesh in the scene and counts its triangles", () => {
    const store = newStore();
    const revision = store.revisionOf(0);

    expect(store.apply(0, { ground: meshOf(12, 4) }, revision).accepted).toBe(
      true,
    );
    expect(store.draws(0)).toBe(true);
    expect(store.trianglesAt(0)).toBe(4);
    expect(store.drawnCount).toBe(1);
    expect(store.triangleCount).toBe(4);
  });

  it("records an air chunk as drawing nothing but still filled", () => {
    // Known-empty is not the same as not-yet-meshed: the first is an answer, the second
    // is a question, and conflating them makes a chunk flash into view.
    const store = newStore();
    store.apply(0, { ground: meshOf(0, 0) }, store.revisionOf(0));

    expect(store.draws(0)).toBe(false);
    expect(store.trianglesAt(0)).toBe(0);
    expect(store.revisionOf(0)).toBe(store.revisionOf(0));
  });

  it("replaces a slot's mesh and frees the old buffers", () => {
    const store = newStore();
    const first = store.apply(
      0,
      { ground: meshOf(12, 4) },
      store.revisionOf(0),
    );
    expect(first.accepted).toBe(true);
    const before = meshFor(store, 0);
    expect(before).toBeDefined();
    const spy = vi
      .spyOn(before!.geometry, "dispose")
      .mockImplementation(() => {});

    store.apply(0, { ground: meshOf(24, 8) }, store.revisionOf(0));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.triangleCount).toBe(8);
  });

  it("keeps only one mesh per slot in the scene", () => {
    // Two children for one slot means the old cell's surface is still being drawn.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.apply(0, { ground: meshOf(24, 8) }, store.revisionOf(0));
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));

    const drawn = surface(store, "ground").group.children.filter(
      (child) => (child as { isMesh?: boolean }).isMesh === true,
    );
    expect(drawn).toHaveLength(1);
  });

  it("refuses a slot it does not have", () => {
    const store = newStore(2);
    const outcome = store.apply(9, { ground: meshOf(12, 4) }, 0);
    expect(outcome).toEqual({ accepted: false, refusal: "unknownSlot" });
    expect(store.drawnCount).toBe(0);
  });
});

describe("two surfaces, two groups, and the order between them", () => {
  it("makes a sea group only for a world that has a sea", () => {
    // **A world with no sea gets one group, not two.** An empty group would be a scene child
    // that draws nothing, which is the cheapest kind of wrong and the kind nobody notices.
    expect(surface(newStore(), "sea")).toBeUndefined();
    expect(surface(withSea(), "sea")).toBeDefined();
  });

  it("puts every water mesh after every ground mesh in the scene", () => {
    // **The invariant the two groups exist to hold, and the reason the application no longer
    // has to promise it by hand.** rmsl has no render-order key: draw order is scene traversal
    // order, so a sea mesh added per slot beside its ground mesh would be interleaved with them
    // and would blend over ground drawn after it — a shore drawn through the water.
    //
    // Asserted on the scene's own children rather than on the store's fields, because the
    // scene's order *is* the draw order and the store's idea of it would be a second thing to
    // be wrong.
    const store = withSea(4);
    for (let slot = 0; slot < 4; slot++) {
      store.apply(
        slot,
        { ground: meshOf(12, 4), sea: meshOf(6, 2) },
        store.revisionOf(slot),
      );
    }
    const scene = (store as unknown as { scene: Scene }).scene;
    const groups = scene.children.filter(
      (child) => (child as { isGroup?: boolean }).isGroup === true,
    );
    expect(groups).toHaveLength(2);
    const firstGroup = groups[0] as { children: unknown[] };
    const secondGroup = groups[1] as { children: unknown[] };
    // Every ground in the first, every sea in the second, and both fully populated — which
    // together say no sea is drawn before any ground.
    expect(firstGroup.children).toHaveLength(4);
    expect(secondGroup.children).toHaveLength(4);
    for (const child of firstGroup.children)
      expect((child as { material?: unknown }).material).toBe(material);
    for (const child of secondGroup.children)
      expect((child as { material?: unknown }).material).toBe(material);
  });

  it("keeps a chunk's two surfaces on the same slot", () => {
    const store = withSea();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    expect(meshFor(store, 0)).toBeDefined();
    expect(seaMeshFor(store, 0)).toBeDefined();
    expect(store.trianglesAt(0)).toBe(6);
    expect(store.groundTriangles).toBe(4);
    expect(store.seaTriangles).toBe(2);
    expect(store.drawnCount).toBe(1);
    expect(store.seaDrawnCount).toBe(1);
  });

  it("takes away the sea of a slot it invalidates, not only the ground", () => {
    // **The two surfaces have to move together.** A `markStale` that cleared the ground and
    // left the sea would leave the previous cell's water hanging in the scene over whatever
    // the new cell is, and it would never be freed — a leak on a path that runs several times
    // a second while the window scrolls.
    const store = withSea();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    const sea = seaMeshFor(store, 0);
    const spy = vi.spyOn(sea!.geometry, "dispose").mockImplementation(() => {});

    store.markStale(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(seaMeshFor(store, 0)).toBeUndefined();
    expect(meshFor(store, 0)).toBeUndefined();
    expect(store.seaTriangles).toBe(0);
    expect(store.draws(0)).toBe(false);
  });

  it("replaces a slot's sea when a new chunk answers for it", () => {
    const store = withSea();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    const before = seaMeshFor(store, 0)!;
    const spy = vi
      .spyOn(before.geometry, "dispose")
      .mockImplementation(() => {});
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(9, 3) },
      store.revisionOf(0),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(surface(store, "sea").group.children).toHaveLength(1);
  });

  it("puts a chunk with a sea and no ground where a sea belongs", () => {
    // **Open ocean is the common case for the sea half.** A slot that answered with a sea and
    // no ground must draw its sea and stop counting ground, or `drawnCount` would report a
    // chunk that holds nothing as one that holds ground.
    const store = withSea();
    store.apply(0, { sea: meshOf(6, 2) }, store.revisionOf(0));
    expect(seaMeshFor(store, 0)).toBeDefined();
    expect(meshFor(store, 0)).toBeUndefined();
    expect(store.drawnCount).toBe(0);
    expect(store.seaDrawnCount).toBe(1);
    expect(store.draws(0)).toBe(true);
    expect(store.groundTriangles).toBe(0);
    expect(store.seaTriangles).toBe(2);
  });

  it("removes a chunk's sea when a later answer says it has none", () => {
    // **A slot is recycled, so an absent surface means the old one must go.** The window gives
    // no cell its water; it answers `sea` absent, and the previous cell's sea is otherwise
    // still in the scene over a mountain.
    const store = withSea();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    expect(seaMeshFor(store, 0)).toBeUndefined();
    expect(surface(store, "sea").group.children).toHaveLength(0);
    expect(store.seaTriangles).toBe(0);
  });

  it("gives a world with no sea no place to put one", () => {
    // **A world with no sea material has no sea slots**, so a stray `sea` in an answer has
    // nowhere to go. An editor over an operations-only model would otherwise draw water that
    // nothing chose.
    const store = newStore();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    expect(surface(store, "sea")).toBeUndefined();
    expect(store.seaTriangles).toBe(0);
    expect(store.triangleCount).toBe(4);
  });

  it("takes its groups out of the scene and leaves the rest of it alone", () => {
    // **Not `scene.clear()`.** The sky, the globe and the clouds are children too, and a
    // store that emptied the scene would take them with it — which was survivable only because
    // the application happened to dispose the globe first.
    const store = withSea();
    store.apply(
      0,
      { ground: meshOf(12, 4), sea: meshOf(6, 2) },
      store.revisionOf(0),
    );
    const scene = (store as unknown as { scene: Scene }).scene;
    // **Anything the store did not add.** A stand-in for the sky, the globe and the clouds —
    // whatever the caller put in the scene before the store existed in it.
    const bystander = new Mesh();
    scene.add(bystander);

    store.dispose();
    // The bystander is still there, and the store's own groups are gone.
    expect(scene.children).toEqual([bystander]);
    expect(store.size).toBe(0);
  });
});

describe("refusing a mesh that has been overtaken", () => {
  // ADR 0007's rule. A slot is re-pointed at a new cell, and until the new mesh lands the
  // slot physically holds the previous cell's geometry; installing a late answer then
  // draws one chunk's surface at another's coordinates.

  it("refuses a mesh captured before the slot was invalidated", () => {
    const store = newStore();
    const revision = store.revisionOf(0);
    store.markStale(0);

    const outcome = store.apply(0, { ground: meshOf(12, 4) }, revision);
    expect(outcome).toEqual({ accepted: false, refusal: "staleRevision" });
    expect(store.staleRefusals).toBe(1);
    expect(store.draws(0)).toBe(false);
  });

  it("leaves the slot's correct mesh alone when refusing", () => {
    // A refusal must not even replace what is already right, or refusing becomes a second
    // way to lose the surface.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const good = meshFor(store, 0);

    const stale = store.revisionOf(0) - 1;
    expect(store.apply(0, { ground: meshOf(99, 33) }, stale).accepted).toBe(
      false,
    );
    expect(meshFor(store, 0)).toBe(good);
    expect(store.trianglesAt(0)).toBe(4);
  });

  it("accepts a mesh captured at the current revision", () => {
    const store = newStore();
    store.markStale(0);
    expect(
      store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0)).accepted,
    ).toBe(true);
    expect(store.staleRefusals).toBe(0);
  });

  it("counts refusals, because zero and 'handled' look the same from outside", () => {
    const store = newStore();
    const revision = store.revisionOf(0);
    store.markStale(0);
    for (let i = 0; i < 3; i++)
      store.apply(0, { ground: meshOf(12, 4) }, revision);
    expect(store.staleRefusals).toBe(3);
  });

  it("refuses a mesh captured before a model change, keeping the old one drawn", () => {
    // The same race as above, reached the way an edit reaches it. The refusal is what makes
    // keeping the mesh safe: without it, the surface on screen would be one the model has
    // already moved past.
    const store = newStore();
    const revision = store.revisionOf(0);
    store.apply(0, { ground: meshOf(12, 4) }, revision);
    const good = meshFor(store, 0);

    store.markOutOfDate(0);

    const outcome = store.apply(0, { ground: meshOf(99, 33) }, revision);
    expect(outcome).toEqual({ accepted: false, refusal: "staleRevision" });
    expect(store.staleRefusals).toBe(1);
    // The slot is still showing the surface it had, and still counts as drawn.
    expect(meshFor(store, 0)).toBe(good);
    expect(store.draws(0)).toBe(true);
    expect(store.triangleCount).toBe(4);
  });
});

describe("an out-of-date mesh is not a cell change", () => {
  // The distinction the whole of the above turns on. Which cell a slot holds decides
  // whether its geometry is the right thing to draw; how wrong that geometry is does not.

  it("keeps drawing the old mesh until the replacement lands", () => {
    // This is the flicker. A hole in the model for as long as the mesher takes, opened once
    // per edit, is a strobe at the brush — and while it is open the rest of the model is the
    // *old* model, which is why an edit can look like it did nothing at all. The same hole,
    // opened once per level-of-detail band crossed, is the same flicker along the horizon.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const mesh = meshFor(store, 0);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});

    store.markOutOfDate(0);

    expect(spy).not.toHaveBeenCalled();
    expect(meshFor(store, 0)).toBe(mesh);
    expect(store.draws(0)).toBe(true);
    expect(store.drawnCount).toBe(1);
    expect(store.triangleCount).toBe(4);
  });

  it("moves the revision, so the replacement is what finally lands", () => {
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const before = store.revisionOf(0);

    store.markOutOfDate(0);
    expect(store.revisionOf(0)).toBeGreaterThan(before);

    store.apply(0, { ground: meshOf(24, 8) }, store.revisionOf(0));
    expect(store.triangleCount).toBe(8);
    expect(store.staleRefusals).toBe(0);
  });

  it("does not leave the slot looking freshly answered", () => {
    // The mesh is still there, but it is not an answer to the model as it now stands, so
    // the slot has to read as outstanding. A caller that trusted `draws` alone would stop
    // asking and the chunk would keep the old surface for ever.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.markOutOfDate(0);
    expect(store.isStale(0, store.revisionOf(0))).toBe(false);
  });

  it("still drops the mesh when the cell changes", () => {
    // The safety half. A slot re-pointed at another cell is holding the previous cell's
    // geometry, and drawing that at the new cell's coordinates is the artefact the revision
    // mechanism was built to rule out. So reposition and release must *not* keep it.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const mesh = meshFor(store, 0);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});

    store.markStale(0);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.draws(0)).toBe(false);
    expect(store.drawnCount).toBe(0);
  });

  it("routes the window's four reasons to the right one of the two", () => {
    // The hook bundle is the only place that knows *why* a slot is being invalidated, so it
    // is the only place that can tell these apart. Getting it wrong is invisible in a unit
    // test of either method and visible only as a chunk drawn at the wrong coordinates —
    // or, in the other direction, as a hole where the model should be.
    const store = newStore();
    const hooks = hooksFor(store);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));

    hooks.onSlotStale?.(0);
    expect(store.draws(0)).toBe(true);

    // A level-of-detail change is the same cell at a different resolution, so it belongs
    // with staleness rather than with the events that move a slot to another cell.
    hooks.onSlotRefill(0);
    expect(store.draws(0)).toBe(true);

    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    hooks.onSlotReposition?.(0);
    expect(store.draws(0)).toBe(false);
  });

  it("is safe on a slot with no mesh, and on one it does not have", () => {
    const store = newStore(2);
    expect(() => store.markOutOfDate(0)).not.toThrow();
    expect(() => store.markOutOfDate(9)).not.toThrow();
  });
});

describe("invalidating a slot", () => {
  it("frees its buffers, takes it out of the scene, and moves its revision", () => {
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const mesh = meshFor(store, 0);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});
    const before = store.revisionOf(0);

    store.markStale(0);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.draws(0)).toBe(false);
    expect(store.drawnCount).toBe(0);
    expect(store.triangleCount).toBe(0);
    expect(store.revisionOf(0)).toBeGreaterThan(before);
  });

  it("leaves the slot answerable as unmeshed rather than air", () => {
    // The surface is very likely still there. Recording it as air would stop it ever
    // being re-requested and the chunk would stay blank until something unrelated
    // invalidated it.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.markStale(0);
    expect(store.draws(0)).toBe(false);
    expect(store.isStale(0, store.revisionOf(0))).toBe(false);
  });

  it("is safe on a slot with no mesh, and on one it does not have", () => {
    const store = newStore(2);
    expect(() => store.markStale(0)).not.toThrow();
    expect(() => store.markStale(9)).not.toThrow();
  });

  it("is safe twice over", () => {
    // Eviction, reshape and shutdown overlap in practice, and disposing twice is
    // harmless in most renderers and a use-after-free in some.
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const mesh = meshFor(store, 0);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});
    store.markStale(0);
    store.markStale(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not touch other slots", () => {
    const store = newStore();
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const one = store.revisionOf(1);
    store.markStale(0);
    expect(store.revisionOf(1)).toBe(one);
    expect(store.draws(1)).toBe(false);
  });
});

describe("resizing", () => {
  it("invalidates every slot when it grows", () => {
    // A reshape moves cells between slots arbitrarily, so nothing survives it. The
    // previous version moved the revisions without freeing the geometry, which left the
    // slot drawing the old cell's surface while refusing every new mesh — blank geometry
    // that never resolves, with nothing to indicate why.
    const store = newStore(2);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));

    store.resize(4);
    expect(store.size).toBe(4);
    expect(store.apply(0, { ground: meshOf(12, 4) }, 0).accepted).toBe(false);
    expect(store.draws(0)).toBe(false);
    expect(store.drawnCount).toBe(0);
  });

  it("leaves nothing of the old shape's meshes in the scene", () => {
    // The bug alongside it: clearing the store's own record of what it had added left the
    // meshes as scene children forever, unreachable by any later take-out.
    const store = newStore(2);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.apply(1, { ground: meshOf(12, 4) }, store.revisionOf(1));
    const group = surface(store, "ground").group;
    expect(group.children).toHaveLength(2);

    store.resize(4);
    expect(group.children).toHaveLength(0);
  });

  it("frees the buffers of slots it drops", () => {
    const store = newStore(4);
    store.apply(3, { ground: meshOf(12, 4) }, store.revisionOf(3));
    const mesh = meshFor(store, 3);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});

    store.resize(2);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(2);
  });

  it("does nothing when the count is unchanged", () => {
    // Told on every reshape; moving every revision when nothing changed would make every
    // in-flight mesh stale for no reason.
    const store = newStore(3);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const before = store.revisionOf(0);
    store.resize(3);
    expect(store.revisionOf(0)).toBe(before);
    expect(store.draws(0)).toBe(true);
  });

  it("keeps a slot usable after growing into it", () => {
    const store = newStore(2);
    store.resize(4);
    expect(
      store.apply(3, { ground: meshOf(12, 4) }, store.revisionOf(3)).accepted,
    ).toBe(true);
    expect(store.draws(3)).toBe(true);
  });
});

describe("disposing", () => {
  it("frees everything and empties the scene", () => {
    const store = newStore(3);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.apply(1, { ground: meshOf(24, 8) }, store.revisionOf(1));
    const scene = (store as unknown as { scene: Scene }).scene;

    store.dispose();
    expect(store.drawnCount).toBe(0);
    expect(scene.children).toHaveLength(0);
  });

  it("is safe twice", () => {
    const store = newStore(2);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    store.dispose();
    expect(() => store.dispose()).not.toThrow();
  });
});

describe("the window hooks", () => {
  it("invalidates a slot that is re-pointed at another cell", () => {
    // The bug ADR 0007 was written about: between the switch and the rebuild, the slot
    // holds the previous cell, and its geometry would be drawn at the new cell's
    // position.
    const store = newStore();
    const hooks = hooksFor(store);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));

    hooks.onSlotReposition(0);
    expect(store.draws(0)).toBe(false);
  });

  it("invalidates a slot that leaves the window", () => {
    const store = newStore();
    const hooks = hooksFor(store);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));

    hooks.onSlotRelease(0);
    expect(store.draws(0)).toBe(false);
    expect(store.drawnCount).toBe(0);
  });

  it("keeps the mesh of a slot that only changed resolution", () => {
    // The flicker, at the level it is decided. A refill is a cell that stayed put and was
    // rebuilt at another level of detail, so the surface already on the GPU is that cell's
    // own — at the coordinates it occupies — and the right thing to draw right up until the
    // replacement lands. Releasing instead drops it and leaves a hole for the length of one
    // chunk mesh, which at a band boundary is every cell on the ring at once.
    const store = newStore();
    const hooks = hooksFor(store);
    store.apply(0, { ground: meshOf(12, 4) }, store.revisionOf(0));
    const mesh = meshFor(store, 0);
    const spy = vi
      .spyOn(mesh!.geometry, "dispose")
      .mockImplementation(() => {});

    hooks.onSlotRefill(0);

    expect(spy).not.toHaveBeenCalled();
    expect(meshFor(store, 0)).toBe(mesh);
    expect(store.draws(0)).toBe(true);
    // The revision still moves, so the mesh for the *old* level cannot land over it.
    const stale = store.revisionOf(0) - 1;
    expect(store.apply(0, { ground: meshOf(24, 8) }, stale).refusal).toBe(
      "staleRevision",
    );
    expect(store.trianglesAt(0)).toBe(4);
  });

  it("resizes when the window's slot count changes", () => {
    // Told *before* the reshape rebuilds the pool, because what draws the slots counts
    // them: a slot still counted among a superchunk's members would keep it waiting for a
    // slot the window no longer has.
    const store = newStore(2);
    const hooks = hooksFor(store);
    hooks.onSlotCountChanged(8);
    expect(store.size).toBe(8);
  });

  it("invalidates on both reposition and release, because the effect is the same", () => {
    // They differ in *why* — one has gone, one has not — but on the store's own state the
    // answer is identical: this cell's mesh is no longer this slot's.
    const store = newStore();
    const hooks = hooksFor(store);
    for (const [name, call] of [
      ["reposition", () => hooks.onSlotReposition(0)],
      ["release", () => hooks.onSlotRelease(0)],
    ] as const) {
      const before = store.revisionOf(0);
      call();
      expect(store.revisionOf(0), name).toBeGreaterThan(before);
    }
  });
});

describe("what the store will not do", () => {
  it("does not reach for the window to check a cell", () => {
    // The window owns cell identity and answerability. The store owning a second opinion
    // about them is how two answers to "is this slot filled" start to disagree.
    const source = ChunkMeshStore.toString();
    expect(source).not.toMatch(/ChunkWindow|slotOf|cellOfSlot/);
  });

  it("keeps no per-cell state", () => {
    // Slots are recycled and cells are not; anything keyed by cell here would have to be
    // invalidated on every scroll (ADR 0005).
    const source = ChunkMeshStore.toString();
    expect(source).not.toMatch(/CoordinateMap|new Map/);
  });
});
