/**
 * The zone overlay: the geometry it builds, and the one mesh it puts in the scene.
 *
 * ## What is actually worth testing here
 *
 * A wireframe box is either right or it is subtly wrong, and "subtly wrong" is invisible in a
 * screenshot. A mistyped corner gives twelve well-formed edges, a plausible array, and a box on
 * screen with one corner in the wrong place — and the person who wrote the place concludes their
 * zone is in the wrong place, and moves it, and it is still wrong.
 *
 * So the geometry is checked as **a combinatorial claim rather than a number**: every edge must
 * join two corners of the box, every corner must be used, and no pair may appear twice. That
 * catches a wrong corner, a duplicated edge and a missing one with one property, and it is the
 * property a box actually has.
 *
 * The material's settings are asserted too, because one of them is a bug that only shows up on
 * a particular day: `depthWrite` on would let whichever box drew first win wherever two overlap.
 */

import { Scene } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import { createZoneLines, edgePositions, EDGE_FORMAT } from "./zones";
import type { Zone } from "./host";

/** A zone with a volume, so its corners are all distinct. */
const zone = (
  id: string,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): Zone => ({ id, label: id, min, max });

/** The unit-ish box most of these use: every corner distinct, nothing at zero. */
const BOX = zone("box", [-1, -2, -3], [4, 5, 6]);

/** The eight corners of a zone, as `x,y,z` strings. */
const cornersOf = (z: Zone): string[] => {
  const out: string[] = [];
  for (const x of [z.min[0], z.max[0]])
    for (const y of [z.min[1], z.max[1]])
      for (const w of [z.min[2], z.max[2]]) out.push(`${x},${y},${w}`);
  return out;
};

/** The array as pairs of endpoints, each a `x,y,z` string. */
const edgesOf = (zones: readonly Zone[]): [string, string][] => {
  const flat = Array.from(edgePositions(zones));
  const edges: [string, string][] = [];
  for (let at = 0; at < flat.length; at += EDGE_FORMAT.floatsPerEdge) {
    const a = flat.slice(at, at + 3).join(",");
    const b = flat.slice(at + 3, at + 6).join(",");
    edges.push([a, b]);
  }
  return edges;
};

describe("the wireframe's own shape", () => {
  it("is twelve edges of six floats", () => {
    // **The format, stated once.** Everything below assumes it, so a reader
    // checking the twelve lines of coordinates in `edgePositions` has this to
    // compare against.
    expect(EDGE_FORMAT).toEqual({ floatsPerEdge: 6, edgesPerBox: 12 });
  });

  it("writes twelve edges for one box", () => {
    expect(edgePositions([BOX])).toHaveLength(12 * 6);
  });

  it("writes nothing for no boxes", () => {
    // **Zero rather than one empty edge.** A mesh left holding twelve zeroes is
    // a line from the origin to the origin, drawn at the player's feet, which is
    // the sort of artefact that gets blamed on the terrain.
    expect(edgePositions([])).toHaveLength(0);
  });

  it("writes both of every box it is given", () => {
    expect(edgePositions([BOX, BOX])).toHaveLength(2 * 12 * 6);
  });

  it("keeps the boxes apart in the same order", () => {
    const other = zone("other", [100, 100, 100], [101, 101, 101]);
    const edges = edgesOf([BOX, other]);
    // **Order, not just count.** The array is one buffer, so a zone's edges are
    // wherever they were written — and a test that only counted would pass on a
    // buffer whose second box was the first box twice.
    expect(edges.slice(0, 12).flat()).toContain("4,5,6");
    expect(edges.slice(12).flat()).toContain("101,101,101");
    expect(edges.slice(12).flat()).not.toContain("-1,-2,-3");
  });
});

describe("each box's edges", () => {
  it("join two corners of that box and nothing else", () => {
    const corners = new Set(cornersOf(BOX));
    for (const [a, b] of edgesOf([BOX])) {
      expect(corners.has(a)).toBe(true);
      expect(corners.has(b)).toBe(true);
    }
  });

  it("use all eight corners, so the box is closed", () => {
    // **Eight, not seven.** The one missing corner is the bug a person spends an
    // afternoon on: seven edges are drawn, it looks like a box, and there is a
    // diagonal gap that only shows against a bright sky.
    const used = new Set(edgesOf([BOX]).flat());
    expect(used).toEqual(new Set(cornersOf(BOX)));
  });

  it("appear once each, with no edge drawn twice", () => {
    // **Undirected pairs, so direction is not the property.** A box drawn with
    // each edge twice looks identical and costs twice as much; a box with one
    // edge missing looks like a box with a hole in it at a particular angle.
    const keys = edgesOf([BOX]).map(([a, b]) => [a, b].sort().join(" → "));
    expect(new Set(keys).size).toBe(EDGE_FORMAT.edgesPerBox);
  });

  it("are all along exactly one axis", () => {
    // **The property that says "box" rather than "twelve segments".** An edge
    // that changes two coordinates at once is a diagonal, which means a
    // transcription error, and a diagonal in a wireframe reads as a design choice
    // rather than a mistake.
    for (const [a, b] of edgesOf([BOX])) {
      const pa = a.split(",").map(Number);
      const pb = b.split(",").map(Number);
      const moved = pa.filter((value, axis) => value !== pb[axis]).length;
      expect(moved).toBe(1);
    }
  });

  it("each run the full length of the box on that axis", () => {
    // **End to end, not part way.** An edge that stops short — a corner pasted
    // from a differently-sized box — is the single most likely transcription
    // error here and the hardest to see.
    for (const [a, b] of edgesOf([BOX])) {
      const pa = a.split(",").map(Number);
      const pb = b.split(",").map(Number);
      const axis = pa.findIndex((value, at) => value !== pb[at]);
      const ends = [pa[axis], pb[axis]].sort((l, r) => l - r);
      expect(ends).toEqual(
        [BOX.min[axis], BOX.max[axis]].sort((l, r) => l - r),
      );
    }
  });

  it("hold for a box far from the origin, which is where a paste goes wrong", () => {
    // **The same eight-corner property, checked again elsewhere.** An edge list
    // written for one box and pasted for another is only wrong if the second box
    // differs, so the property has to be checked on a box that differs.
    const far = zone("far", [980, 12, -430], [1020, 60, -400]);
    expect(new Set(edgesOf([far]).flat())).toEqual(new Set(cornersOf(far)));
  });
});

describe("the overlay in a scene", () => {
  it("adds one mesh, not one per zone", () => {
    // **One draw call is the whole reason it is one mesh** (see the header): at
    // `MAX_ZONES` zones, a mesh each would be 256 draws for boxes a player can
    // count on their fingers.
    const scene = new Scene();
    createZoneLines(scene);
    const second = createZoneLines(scene);
    expect(scene.children.length).toBe(2);
    second.dispose();
  });

  it("counts the boxes it has been given", () => {
    const lines = createZoneLines(new Scene());
    lines.update([BOX, zone("b", [0, 0, 0], [1, 1, 1])]);
    expect(lines.count).toBe(2);
    lines.update([]);
    expect(lines.count).toBe(0);
  });

  it("draws through geometry but does not let one box win over another", () => {
    // **Depth test on, depth write off.** The two settings are one decision, not
    // two: without the test a zone would be visible through a wall, and without
    // the write two overlapping boxes would have whichever drew first painted over
    // the other — which only shows up on the specific pair that overlaps.
    const scene = new Scene();
    const lines = createZoneLines(scene);
    const drawn = scene.children.at(-1)! as unknown as {
      material: { depthTest: boolean; depthWrite: boolean };
    };
    expect(drawn.material.depthTest).toBe(true);
    expect(drawn.material.depthWrite).toBe(false);
    lines.dispose();
  });

  it("is transparent, because an opaque overlay hides the thing it is outlining", () => {
    const scene = new Scene();
    const lines = createZoneLines(scene);
    const drawn = scene.children.at(-1)! as unknown as {
      material: { transparent: boolean; opacity: number };
    };
    expect(drawn.material.transparent).toBe(true);
    // **Not fully opaque, and not invisible.** A wireframe at 1.0 competes with
    // the terrain's own lighting; one below about half stops being readable
    // against a bright sky.
    expect(drawn.material.opacity).toBeGreaterThan(0.5);
    expect(drawn.material.opacity).toBeLessThan(1);
    lines.dispose();
  });

  it("comes out of the scene when it is disposed", () => {
    // **Out of the scene, not merely hidden.** A disposed overlay still in the
    // scene graph is drawn from a geometry whose buffers are gone, which on some
    // drivers is a warning and on others is a lost context.
    const scene = new Scene();
    const lines = createZoneLines(scene);
    expect(scene.children.length).toBe(1);
    lines.dispose();
    expect(scene.children.length).toBe(0);
  });

  it("can be disposed twice, because a remount does", () => {
    // **Twice, not once.** Unloading a place and loading another disposes the
    // first overlay; a scene that is torn down and rebuilt disposes it again, and
    // an error on the second call turns a reload into a crash.
    const lines = createZoneLines(new Scene());
    lines.dispose();
    expect(() => lines.dispose()).not.toThrow();
  });

  it("accepts an update after it has been disposed without throwing", () => {
    // **Without throwing, but harmlessly.** The frame loop's `update` is called
    // every frame with whatever zones there are, and it runs after a `dropPlace`
    // that has already disposed the previous place's overlay — so this ordering
    // happens on every single unload.
    const lines = createZoneLines(new Scene());
    lines.dispose();
    expect(() => lines.update([BOX])).not.toThrow();
  });
});
