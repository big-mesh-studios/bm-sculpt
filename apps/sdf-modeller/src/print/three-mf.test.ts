import { describe, expect, it } from "vitest";
import type { RGBA } from "@big-mesh-studios/core";
import JSZip from "jszip";

import { boxMesh, boundsAbout } from "./fixtures";
import { standOnBed } from "./stand";
import { encodeThreeMf, MODEL_PART, type PrintSolid } from "./three-mf";

/** The colours a writer can be handed, as slots. */
const PALETTE: RGBA[] = [
  { r: 1, g: 1, b: 1, a: 255 },
  { r: 9, g: 9, b: 9, a: 255 },
  { r: 5, g: 5, b: 5, a: 255 },
];

/**
 * A solid box `size` world units to a side, stood on the bed at `heightMm` and painted
 * `colour` in every corner.
 *
 * **Stood by the real function rather than written out**, so a writer test and a stand test
 * cannot both be right about a mesh that is not the one a printer would get.
 */
const solidOf = (
  size: number,
  { heightMm = 20, colour = 2, at = { x: 0, y: 0, z: 0 } } = {},
): PrintSolid => {
  const mesh = boxMesh({
    min: { x: at.x - size / 2, y: at.y, z: at.z - size / 2 },
    max: { x: at.x + size / 2, y: at.y + size, z: at.z + size / 2 },
  });
  const slots = new Uint8Array(mesh.indices.length).fill(colour);

  return {
    name: "body",
    vertices: standOnBed(mesh.positions, mesh.vertexCount, heightMm),
    indices: mesh.indices,
    colours: slots,
  };
};

/** Every part of the package, and the model part's markup. */
const readBack = async (blob: Blob) => {
  const zip = await JSZip.loadAsync(blob);
  const files = Object.keys(zip.files);
  const text = async (path: string) =>
    (await zip.file(path)?.async("string")) ?? "";

  return {
    files,
    contentTypes: await text("[Content_Types].xml"),
    rels: await text("_rels/.rels"),
    model: await text(MODEL_PART),
  };
};

/** The `attribute="value"` of every tag in `markup` carrying that attribute. */
const attributesOf = (markup: string, tag: string, attribute: string) =>
  [
    ...markup.matchAll(new RegExp(`<${tag} [^>]*?${attribute}="([^"]*)"`, "g")),
  ].map((match) => match[1]);

describe("encodeThreeMf", () => {
  it("carries a model part, a content type for it, and a relationship to it", async () => {
    const { files, contentTypes, rels } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    // The three places an Open Packaging Conventions archive has to agree with itself before a
    // slicer will read any of it. The folders the paths imply are not parts, and are not
    // written.
    expect(files).toEqual(["[Content_Types].xml", "_rels/.rels", MODEL_PART]);
    expect(contentTypes).toContain(
      `PartName="/${MODEL_PART}" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"`,
    );
    expect(rels).toContain(
      `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"`,
    );
    expect(rels).toContain(`Target="/${MODEL_PART}"`);
  });

  it("says what the model's measurements are in", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    expect(model).toContain('unit="millimeter"');
  });

  it("declares the colour extension without requiring it", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    // Declared, so a consumer that knows colour reads it; not required, so one that does not
    // takes the shape and leaves the paint.
    expect(model).toContain(
      'xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"',
    );
    expect(model).not.toContain("requiredextensions");
  });

  it("writes a solid's corners and faces as its triangles", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    // **Eight corners, not twenty-four.** A box mesh is indexed — the six faces share their
    // corners — so the writer writes what the mesh has rather than a corner per face. rm-stacker
    // writes twenty-four because its mesher merges each face into a standalone rectangle; this
    // one has a real index buffer and duplicating a corner would be a bigger file for nothing.
    expect(attributesOf(model, "vertex", "x")).toHaveLength(8);
    expect(attributesOf(model, "vertex", "y")).toHaveLength(8);
    expect(attributesOf(model, "vertex", "z")).toHaveLength(8);
    expect(attributesOf(model, "triangle", "v1")).toHaveLength(12);
  });

  it("writes every measurement to the precision a printer can hold", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    for (const measurement of attributesOf(model, "vertex", "x")) {
      expect(measurement).toMatch(/^-?\d+(\.\d{1,3})?$/);
    }
  });

  it("points each corner of a face at the colour it shows", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2, { colour: 2 })], PALETTE),
    );

    // One colour in the group, and every corner of a part painted one colour naming the same
    // one, whatever palette slot it was.
    expect(attributesOf(model, "m:color", "color")).toEqual(["#050505FF"]);
    expect(attributesOf(model, "triangle", "p1")).toEqual(
      Array.from({ length: 12 }, () => "0"),
    );
    expect(attributesOf(model, "triangle", "p2")).toHaveLength(12);
    expect(attributesOf(model, "triangle", "p3")).toHaveLength(12);
  });

  it("gives each corner of a face its own colour", async () => {
    // **The reason this writer is not the reference one.** rm-stacker writes `p1` alone,
    // because a rectangle it merges is one colour by construction; here a `Paint` blend is a
    // gradient across a triangle, and a triangle with three different corners has to be able to
    // say so. Slot 0 is blue, slot 1 is red.
    const solid = solidOf(2, { colour: 0 });
    // Triangle zero's three corners: the second colour, the first, the second again.
    solid.colours.set([1, 0, 1], 0);

    const { model } = await readBack(await encodeThreeMf([solid], PALETTE));

    expect(attributesOf(model, "m:color", "color")).toEqual([
      "#010101FF",
      "#090909FF",
    ]);
    expect(attributesOf(model, "triangle", "p1")[0]).toBe("1");
    expect(attributesOf(model, "triangle", "p2")[0]).toBe("0");
    expect(attributesOf(model, "triangle", "p3")[0]).toBe("1");
    // The other eleven triangles are untouched, so the group has both colours and only the
    // one triangle is a blend.
    expect(new Set(attributesOf(model, "triangle", "p1"))).toEqual(
      new Set(["0", "1"]),
    );
  });

  it("writes one colour for each of the colours a model shows", async () => {
    const solid = solidOf(2, { colour: 0 });
    // **Two palette slots in the group and three in the palette**, so the group cannot be the
    // palette wholesale — which is what makes this different from writing all of them.
    solid.colours.set([0, 1, 0], 0);

    const { model } = await readBack(await encodeThreeMf([solid], PALETTE));

    // **Sorted by slot, not by use.** The group is an index space and nothing in the file says
    // which slot is which, so the order has to be derived from the slot numbers alone.
    expect(attributesOf(model, "m:color", "color")).toEqual([
      "#010101FF",
      "#090909FF",
    ]);
    expect(attributesOf(model, "triangle", "p2")[0]).toBe("1");
  });

  it("leaves out the corner attribute a colour the palette cannot name", async () => {
    // **A missing `p` rather than a wrong index.** A corner naming a slot nothing holds takes
    // the solid's own colour, and the group is not left empty for that colour to point at.
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2, { colour: 2 })], PALETTE.slice(0, 2)),
    );

    expect(attributesOf(model, "m:color", "color")).toEqual(["#000000FF"]);
    expect(attributesOf(model, "triangle", "p1")).toEqual([]);
    expect(attributesOf(model, "triangle", "p2")).toEqual([]);
    expect(attributesOf(model, "triangle", "p3")).toEqual([]);
    expect(model).toContain('pindex="0"');
  });

  it("leaves out only the corners the palette cannot name", async () => {
    // **One attribute absent and two present on the same triangle**, which is what a boundary
    // between a kept colour and a dropped one produces. The template that always wrote three
    // could not express this.
    const solid = solidOf(2, { colour: 0 });
    // **Every** triangle's middle corner named a slot nothing holds, so `p2` is absent from the
    // file altogether while `p1` and `p3` are on every triangle. Writing all three or none of
    // them would both be wrong here.
    for (let t = 0; t < solid.colours.length; t += 3) {
      solid.colours[t + 1] = 7;
    }

    const { model } = await readBack(await encodeThreeMf([solid], PALETTE));

    expect(attributesOf(model, "triangle", "p1")).toHaveLength(12);
    expect(attributesOf(model, "triangle", "p2")).toHaveLength(0);
    expect(attributesOf(model, "triangle", "p3")).toHaveLength(12);
  });

  it("gives the colour group the first identifier so it cannot be a solid", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    expect(attributesOf(model, "m:colorgroup", "id")).toEqual(["1"]);
    expect(attributesOf(model, "object", "id")).toEqual(["2"]);
    expect(attributesOf(model, "item", "objectid")).toEqual(["2"]);
  });

  it("names a solid against the identifier it took", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    // The specification has no name on a solid of its own, so the name is said as metadata
    // against the identifier it became, which is the only place a consumer can look it up.
    expect(model).toContain('<metadata name="s:solid:2">body</metadata>');
  });

  it("escapes a name that would otherwise end a markup token", async () => {
    const solid = { ...solidOf(2), name: 'a & b <c> "d"' };

    const { model } = await readBack(await encodeThreeMf([solid], PALETTE));

    expect(model).toContain(
      '<metadata name="s:solid:2">a &amp; b &lt;c&gt; &quot;d&quot;</metadata>',
    );
  });

  it("writes a title only when there is one", async () => {
    const named = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE, { title: "my monster" }),
    );
    const anonymous = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE, { title: "" }),
    );

    expect(named.model).toContain(
      '<metadata name="Title">my monster</metadata>',
    );
    expect(anonymous.model).not.toContain('name="Title"');
  });

  it("says which application wrote the file", async () => {
    const { model } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    expect(model).toContain(
      '<metadata name="Application">sdf-modeller</metadata>',
    );
  });

  it("carries a picture of the model when it is given one", async () => {
    const picture = new Uint8Array([137, 80, 78, 71]);
    const { files, rels, contentTypes } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE, { thumbnail: picture }),
    );

    expect(files).toContain("Metadata/thumbnail.png");
    expect(contentTypes).toContain('Extension="png" ContentType="image/png"');
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"',
    );
    expect(rels).toContain('Target="/Metadata/thumbnail.png"');
  });

  it("leaves the picture out when it is given none", async () => {
    const { files, rels } = await readBack(
      await encodeThreeMf([solidOf(2)], PALETTE),
    );

    expect(files).toContain("[Content_Types].xml");
    expect(rels).not.toContain("thumbnail");
  });

  it("refuses a model with nothing in it", async () => {
    await expect(encodeThreeMf([], PALETTE)).rejects.toThrow(
      /nothing in this model/,
    );
  });

  it("writes a solid that is not on the bed as the coordinates it was given", async () => {
    // **The writer does no arithmetic.** Standing a model up is `standOnBed`'s job, and a
    // writer that also shifted and scaled would be a second place for the turn to be wrong in
    // a way nothing tests. Negative coordinates here are the caller's business.
    const mesh = boxMesh(boundsAbout(2));
    const { model } = await readBack(
      await encodeThreeMf(
        [
          {
            name: "body",
            vertices: mesh.positions,
            indices: mesh.indices,
            colours: new Uint8Array(mesh.indices.length),
          },
        ],
        PALETTE,
      ),
    );

    expect(attributesOf(model, "vertex", "x")).toContain("-1");
    expect(attributesOf(model, "vertex", "z")).toContain("-1");
  });
});
