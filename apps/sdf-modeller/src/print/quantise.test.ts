import { describe, expect, it } from "vitest";
import type { RGBA } from "@big-mesh-studios/core";

import { quantiseColours, type QuantisedColours } from "./quantise";

/** A mesh of `vertices` vertices and `triangles` triangles, one colour per vertex. */
const meshOf = (
  colours: readonly (readonly [number, number, number, number])[],
  triangles: readonly (readonly [number, number, number])[],
): { colours: Uint8Array; indices: Uint32Array } => {
  const packed = new Uint8Array(colours.length * 4);
  colours.forEach(([r, g, b, a], v) => {
    packed[v * 4] = r;
    packed[v * 4 + 1] = g;
    packed[v * 4 + 2] = b;
    packed[v * 4 + 3] = a;
  });

  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach(([a, b, c], t) => {
    indices[t * 3] = a;
    indices[t * 3 + 1] = b;
    indices[t * 3 + 2] = c;
  });

  return { colours: packed, indices };
};

/** One triangle over three vertices, all named. */
const oneTriangle = (
  colours: readonly (readonly [number, number, number, number])[],
) => meshOf(colours, [[0, 1, 2]]);

const RED: RGBA = { r: 255, g: 0, b: 0, a: 255 };
const GREEN: RGBA = { r: 0, g: 255, b: 0, a: 255 };
const BLUE: RGBA = { r: 0, g: 0, b: 255, a: 255 };
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 255 };

/**
 * What colour each corner of each triangle came out as, read back through the palette.
 *
 * **The end-to-end reading of the two halves together**, and therefore the assertion that
 * matters: a slot is only a number, and what the writer will write is what that number means.
 */
const slotsShow = (
  reduced: QuantisedColours,
  mesh: { colours: Uint8Array; indices: Uint32Array },
  expected: readonly (readonly [number, number, number, number])[],
): (readonly [number, number, number, number])[] => {
  const shown: (readonly [number, number, number, number])[] = [];
  for (let t = 0; t < mesh.indices.length; t++) {
    const vertex = mesh.indices[t] as number;
    const colour = reduced.palette[reduced.slots[t] as number] as RGBA;
    shown.push([colour.r, colour.g, colour.b, colour.a]);
    // **The slot and the vertex it came from have to agree**, or the comparison the caller is
    // making is vacuous: read `mesh.colours` back so the check is against the source.
    const from = mesh.colours;
    expect([
      from[vertex * 4],
      from[vertex * 4 + 1],
      from[vertex * 4 + 2],
      from[vertex * 4 + 3],
    ]).toEqual(expected[vertex]);
  }
  return shown;
};

describe("quantiseColours", () => {
  it("keeps every colour of a model that has fewer than it can hold", () => {
    const mesh = oneTriangle([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 4);

    expect(reduced.distinct).toBe(3);
    // **The property rather than the order.** Nothing was dropped, so each corner's slot has to
    // name that corner's own colour — which is what the writer relies on, and it holds whatever
    // order the palette came out in.
    const wanted: readonly (readonly [number, number, number, number])[] = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ];
    expect(slotsShow(reduced, mesh, wanted)).toEqual(wanted);
  });

  it("counts colours over corners rather than over vertices", () => {
    // **The distinction decides what survives.** There is one red vertex and three blue ones, so
    // a count per vertex would rank them one to three; a count per corner ranks blue six to
    // red's two, because a vertex is not what gets printed — a corner is. Blue is what a
    // one-colour printer gets.
    const mesh = meshOf(
      [
        [255, 0, 0, 255],
        [0, 0, 255, 255],
        [0, 0, 255, 255],
        [0, 0, 255, 255],
      ],
      [
        [0, 1, 2],
        [0, 1, 3],
        [0, 2, 3],
      ],
    );
    const reduced = quantiseColours(mesh.colours, mesh.indices, 1);

    expect(reduced.palette).toEqual([BLUE]);
  });

  it("keeps the most-used colours and snaps the rest to the nearest of them", () => {
    // Red in every triangle, green in two, and a violet halfway between red and blue in one.
    const mesh = meshOf(
      [
        [255, 0, 0, 255],
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 255, 0, 255],
        [128, 0, 128, 255],
        [255, 0, 0, 255],
      ],
      [
        [0, 5, 1],
        [0, 1, 2],
        [0, 2, 3],
        [0, 4, 3],
      ],
    );
    const reduced = quantiseColours(mesh.colours, mesh.indices, 2);

    // Red wins on use — seven corners to green's four — and green is second, so both are kept
    // and the violet has no slot left. Of the two kept, red is much the nearer, so it becomes
    // red. The twelve entries are the four triangles' corners in order.
    expect(reduced.palette).toEqual([RED, GREEN]);
    expect(Array.from(reduced.slots)).toEqual([
      0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 1,
    ]);
  });

  it("orders the palette by use, so slot zero is the model's own colour", () => {
    // **Not incidental.** The writer points a solid's `pindex="0"` at the first colour in the
    // group, and a corner the reduction gave up on falls back to it — so the dominant colour is
    // the right one to have there.
    const mesh = meshOf(
      [
        [255, 0, 0, 255],
        [0, 0, 255, 255],
        [0, 0, 255, 255],
        [0, 0, 255, 255],
      ],
      [
        [0, 1, 2],
        [0, 1, 3],
      ],
    );
    const reduced = quantiseColours(mesh.colours, mesh.indices, 2);

    expect(reduced.palette).toEqual([BLUE, RED]);
    expect(reduced.slots[0]).toBe(1);
  });

  it("breaks a tie on the colour's own bytes, so two exports agree", () => {
    // **Two colours used exactly equally often have no order between them by use alone**, and
    // picking between them by anything else would make the export depend on the mesher's
    // vertex order rather than on the model.
    const mesh = oneTriangle([
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 2);

    expect(reduced.palette).toEqual([BLUE, RED]);
  });

  it("gives two exports of the same model the same file", () => {
    const mesh = meshOf(
      [
        [0, 255, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
        [0, 255, 0, 255],
        [255, 0, 0, 255],
        [0, 0, 255, 255],
      ],
      [
        [0, 1, 2],
        [3, 4, 5],
      ],
    );

    const once = quantiseColours(mesh.colours, mesh.indices, 2);
    const twice = quantiseColours(mesh.colours, mesh.indices, 2);

    expect(once.palette).toEqual(twice.palette);
    expect(Array.from(once.slots)).toEqual(Array.from(twice.slots));
    // All three are used twice, so use says nothing about them and the channels decide: blue's
    // packed key is the lowest of the three, then green's.
    expect(once.palette).toEqual([BLUE, GREEN]);
  });

  it("counts a translucent colour as its own colour while there is room", () => {
    // **Alpha is in the distance, not out of it.** A printer has no use for alpha, so the
    // argument for ignoring it is real — but ignoring it merges a translucent part of a model
    // with the opaque part beside it on the strength of a channel nothing can act on.
    const mesh = oneTriangle([
      [255, 0, 0, 255],
      [255, 0, 0, 128],
      [255, 0, 0, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 2);

    expect(reduced.palette).toEqual([RED, { r: 255, g: 0, b: 0, a: 128 }]);
  });

  it("merges colours only when the limit leaves it no choice", () => {
    const mesh = oneTriangle([
      [255, 0, 0, 255],
      [0, 255, 0, 128],
      [0, 0, 255, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 1);

    // Three colours, each used once, and room for one: none of them has an edge on use, so the
    // channels decide and blue — the lowest packed key — is what is kept. Every corner then
    // takes it, which is the whole of what a reduction is.
    expect(reduced.palette).toEqual([BLUE]);
    expect(Array.from(reduced.slots)).toEqual([0, 0, 0]);
  });

  it("emits three slots a triangle, in the corners' order", () => {
    // **The writer reads these positionally**, so a triangle whose corners are blue, red, blue
    // has to come back as two blue slots around one red — which is what a `Paint` boundary
    // looks like.
    const mesh = oneTriangle([
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 2);

    expect(Array.from(reduced.slots)).toEqual([0, 1, 0]);
  });

  it("names every slot a slot of the palette it returns", () => {
    // **The invariant that makes the two halves usable apart.** The solid carries slots and the
    // writer carries colours, and nothing checks that they agree except a slicer.
    const mesh = meshOf(
      Array.from(
        { length: 9 },
        (_, i) =>
          [(i * 37) % 256, (i * 91) % 256, (i * 53) % 256, 255] as const,
      ),
      [
        [0, 1, 2],
        [3, 4, 5],
        [6, 7, 8],
        [0, 4, 8],
      ],
    );

    for (const max of [1, 2, 4, 8, 16]) {
      const reduced = quantiseColours(mesh.colours, mesh.indices, max);

      expect(reduced.palette.length).toBeLessThanOrEqual(max);
      for (const slot of reduced.slots) {
        expect(slot).toBeLessThan(reduced.palette.length);
      }
    }
  });

  it("says a mesh with no triangles has no colours rather than one of its own", () => {
    // **Not a black.** A palette of one for a mesh with nothing in it would put a colour in the
    // file that the model does not have anywhere.
    const reduced = quantiseColours(new Uint8Array(0), new Uint32Array(0), 4);

    expect(reduced.palette).toEqual([]);
    expect(reduced.slots).toHaveLength(0);
    expect(reduced.distinct).toBe(0);
  });

  it("refuses a limit that is not a count of anything", () => {
    const mesh = oneTriangle([
      [255, 0, 0, 255],
      [255, 0, 0, 255],
      [255, 0, 0, 255],
    ]);

    for (const max of [0, -1, 2.5, Number.NaN]) {
      expect(() => quantiseColours(mesh.colours, mesh.indices, max)).toThrow(
        /at least one colour/,
      );
    }
  });

  it("keeps a model of one colour as one colour, whatever the limit", () => {
    // **The common case, and the one that must not go through a nearest-colour search.** A
    // model nobody has painted is one colour, and every corner of it is that colour.
    const mesh = oneTriangle([
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    const reduced = quantiseColours(mesh.colours, mesh.indices, 4);

    expect(reduced.palette).toEqual([BLACK]);
    expect(Array.from(reduced.slots)).toEqual([0, 0, 0]);
  });
});
