/**
 * A model written as a 3MF package.
 *
 * ## What a 3MF is
 *
 * A 3MF file is a zip, but not any zip: it is an Open Packaging Conventions archive, which has
 * to say what is inside it in three agreed places before a slicer will look at any of it. The
 * content types say what kind of each part is, the root relationships say which of them is the
 * model, and the model part itself is XML saying what the model is.
 *
 * A 3MF carries a unit and a colour per face, which is what a file meant to be printed rather
 * than edited wants and a triangle soup cannot give it. It is the format rather than STL for
 * exactly those two reasons — STL has no unit and no colour — and it costs being a zip of XML
 * that a person cannot hand-edit, which is what the project file in `../file` is for.
 *
 * ## What this is ported from, and what changed
 *
 * **`big-mesh-studios`' `packages/stacker/src/print/three-mf.ts`**, near enough whole. That
 * writer has no opinion about voxels or about a figure, which is the only reason it could be
 * taken rather than rewritten: it takes triangles and a palette and knows nothing about where
 * they came from. Three things are different here, and each is a consequence of the model
 * rather than a preference:
 *
 * - **A colour per corner rather than per face.** rm-stacker merges each rectangle of a face
 *   from faces showing one colour, so one index a triangle is all it has; this model's colours
 *   come per *vertex* from `Field.colourAt`, so a `Paint` blend is a gradient across a triangle
 *   and collapsing it to one colour throws away what the modeller drew. The 3MF specification
 *   has `p1`, `p2` and `p3` for exactly this, and they were the right thing to use before the
 *   destination was known.
 * - **The palette comes in already reduced.** See `./quantise`. rm-stacker has a fixed palette
 *   of thirty-two slots and a face names one; this model has a vertex colour per vertex and a
 *   printer has four filaments, so the reduction happens before the writer rather than being
 *   the writer's problem.
 * - **One solid, not one per part.** A `Part` here is a step in a CSG fold, not a body: the
 *   default model is a capsule with a subtraction cut into it, and writing those as two objects
 *   would hand a slicer two interpenetrating shells rather than the solid the screen shows.
 *   See ADR 0032.
 *
 * ## What is deliberately *not* here
 *
 * **No `requiredextensions`, though `m` is declared.** It would make a consumer that has never
 * heard of the materials extension refuse the file rather than open it without the colour. A
 * model that prints grey is worth more than one that does not open.
 */
import type { RGBA } from "@big-mesh-studios/core";
import JSZip from "jszip";

/** The namespace the core specification gives the elements of a model part. */
const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

/** The namespace the materials extension gives its colour groups. */
const MATERIAL =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";

/** The namespace this writer qualifies the names of its own with. */
const OWN = "https://big-mesh-studios.io/ns/sdf-modeller";

/** The content type the specification gives the model part. */
const MODEL_CONTENT_TYPE =
  "application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

/** The content type a `.rels` part has, which nothing here overrides. */
const RELATIONSHIPS =
  "application/vnd.openxmlformats-package.relationships+xml";

/** The relationship that names the part a slicer opens. */
const START_PART =
  "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

/** The relationship that names a picture of the model. */
const THUMBNAIL =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail";

/** Where the model part sits in the package. */
export const MODEL_PART = "3D/3dmodel.model";

/** Where a picture of the model sits in the package. */
export const THUMBNAIL_PART = "Metadata/thumbnail.png";

/**
 * How many decimal places a measurement is written to.
 *
 * A millimetre is a thousandth of a metre, so three places is a micron — well under what a
 * printer can hold, and short enough that a corner does not come out as `3.0999999999999996`.
 */
const MILLIMETRES = 3;

/** The colour a face falls back to when the palette holds none for its slot. */
const NOTHING: RGBA = { r: 0, g: 0, b: 0, a: 255 };

/**
 * One solid: triangles in millimetres, and the palette slot each corner shows.
 *
 * **A `name` the specification has nowhere to put.** A 3MF object has no name of its own —
 * naming one belongs to an extension — so the name is written as metadata against the
 * identifier the solid took, which is the only place in the file a consumer can look it up.
 */
export interface PrintSolid {
  readonly name: string;
  /** Three floats a vertex, in millimetres from the corner of the bed. */
  readonly vertices: Float32Array;
  /** Three of them a triangle, counting from the start of `vertices`. */
  readonly indices: Uint32Array;
  /**
   * The palette slot each corner of each face shows — three a triangle, in the same order.
   *
   * **Per corner rather than per face**, because a slot here is an index into the palette the
   * caller reduced the model's colours into and the model's colours are per vertex. A slot the
   * palette does not hold is a corner that takes the solid's own colour, which is a wrong colour
   * rather than a file a slicer rejects.
   */
  readonly colours: Uint8Array;
}

/** What a 3MF file says about the model beyond its geometry. */
export interface ThreeMfOptions {
  /** The name a slicer shows the file under. */
  readonly title?: string;
  /** A picture of the model as a PNG, for somebody choosing between files. */
  readonly thumbnail?: Uint8Array;
}

/**
 * `solids` as the bytes of a 3MF file.
 *
 * @throws when there are no solids, because a model part with nothing in it is not a model,
 * and a slicer will say so by refusing the file.
 */
export async function encodeThreeMf(
  solids: readonly PrintSolid[],
  palette: readonly RGBA[],
  options: ThreeMfOptions = {},
): Promise<Blob> {
  if (solids.length === 0) {
    throw new Error("there is nothing in this model to print");
  }

  const zip = new JSZip();
  // A package names its parts and nothing else, so the folders the paths imply are not written
  // as parts of their own. In this order too, because the content types are what a consumer
  // reads first and an archive that buries them is one some consumers will not find.
  const add = (path: string, data: string | Uint8Array) =>
    zip.file(path, data, { createFolders: false });

  add("[Content_Types].xml", contentTypes());
  add("_rels/.rels", rootRels(options.thumbnail !== undefined));

  if (options.thumbnail !== undefined) {
    add(THUMBNAIL_PART, options.thumbnail);
  }

  add(MODEL_PART, modelXml(solids, palette, options));

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
  });
}

/** What every part of the package is, so a consumer knows how to read it. */
function contentTypes(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    `  <Default Extension="rels" ContentType="${RELATIONSHIPS}" />`,
    '  <Default Extension="png" ContentType="image/png" />',
    `  <Override PartName="/${MODEL_PART}" ContentType="${MODEL_CONTENT_TYPE}" />`,
    "</Types>",
    "",
  ].join("\n");
}

/** Which parts of the package are reachable, and what they are for. */
function rootRels(thumbnail: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    `  <Relationship Id="rel-1" Type="${START_PART}" Target="/${MODEL_PART}" />`,
    ...(thumbnail
      ? [
          `  <Relationship Id="rel-2" Type="${THUMBNAIL}" Target="/${THUMBNAIL_PART}" />`,
        ]
      : []),
    "</Relationships>",
    "",
  ].join("\n");
}

/** The model part: one solid per body, the colours they show, and what to build. */
function modelXml(
  solids: readonly PrintSolid[],
  palette: readonly RGBA[],
  options: ThreeMfOptions,
): string {
  const colours = colourGroup(solids, palette);
  // The colour group takes the first resource identifier, so the solids start after it and the
  // two can never be confused for one another.
  const idOf = (index: number) => index + 2;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // `requiredextensions` is deliberately absent, though `m` is declared — see the header.
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:m="${MATERIAL}" xmlns:s="${OWN}">`,
    '  <metadata name="Application">sdf-modeller</metadata>',
    ...(options.title === undefined || options.title === ""
      ? []
      : [`  <metadata name="Title">${escapeXml(options.title)}</metadata>`]),
    ...solids.flatMap((solid, index) => [
      `  <metadata name="s:solid:${idOf(index)}">${escapeXml(solid.name)}</metadata>`,
    ]),
    "  <resources>",
    '    <m:colorgroup id="1">',
    ...colours.entries.map((entry) => `      <m:color color="${entry}" />`),
    "    </m:colorgroup>",
    ...solids.flatMap((solid, index) => body(solid, idOf(index), colours)),
    "  </resources>",
    "  <build>",
    ...solids.map((_solid, index) => `    <item objectid="${idOf(index)}" />`),
    "  </build>",
    "</model>",
    "",
  ].join("\n");
}

/**
 * The colours the model shows, and which palette slot each became in the group.
 *
 * A corner names its colour by its position in this group, so the group holds the slots the
 * model actually shows rather than every slot the palette has. A slot the palette has no colour
 * for is left out, and a corner naming one takes the solid's own colour instead, which is a
 * wrong colour rather than a file a slicer rejects.
 *
 * The group is never empty, because a solid's own colour is the first of it and an empty group
 * would leave that pointing at a colour that is not there.
 */
function colourGroup(
  solids: readonly PrintSolid[],
  palette: readonly RGBA[],
): { entries: string[]; groupIndexOf: Map<number, number> } {
  const shown = new Set<number>();
  for (const solid of solids) {
    for (const slot of solid.colours) {
      shown.add(slot);
    }
  }

  const entries: string[] = [];
  const groupIndexOf = new Map<number, number>();

  for (const slot of [...shown].sort((a, b) => a - b)) {
    const colour = palette[slot];
    if (colour === undefined) {
      continue;
    }
    groupIndexOf.set(slot, entries.length);
    entries.push(`#${hex(colour)}`);
  }

  if (entries.length === 0) {
    entries.push(`#${hex(NOTHING)}`);
  }

  return { entries, groupIndexOf };
}

/**
 * One solid: its corners, its triangles, and the colour of each corner.
 *
 * **The three colour attributes are written independently, and any of them may be absent.** The
 * specification allows `p1`, `p2` and `p3` on a triangle and each is optional, so a corner
 * whose colour the group does not hold simply does not name one and falls back to `pindex`.
 * That is the case a blend produces at its edges, where two kept colours meet.
 */
function body(
  solid: PrintSolid,
  id: number,
  colours: ReturnType<typeof colourGroup>,
): string {
  const lines = [
    // `pindex` is the colour a face takes when it does not name one of its own, which is the
    // first colour in the group.
    `    <object id="${id}" type="model" pid="1" pindex="0">`,
    "      <mesh>",
    "        <vertices>",
  ];

  for (let v = 0; v < solid.vertices.length; v += 3) {
    lines.push(
      `          <vertex x="${millimetres(solid.vertices[v])}" y="${millimetres(
        solid.vertices[v + 1],
      )}" z="${millimetres(solid.vertices[v + 2])}" />`,
    );
  }

  lines.push("        </vertices>", "        <triangles>");

  for (let t = 0; t < solid.indices.length; t += 3) {
    // **Built up rather than formatted in one go**, because how many of the three colour
    // attributes a triangle carries is decided per corner. A template with three holes and
    // three arguments cannot express "the middle one is absent".
    const corners = [
      `v1="${solid.indices[t]}"`,
      `v2="${solid.indices[t + 1]}"`,
      `v3="${solid.indices[t + 2]}"`,
    ];
    for (let corner = 0; corner < 3; corner++) {
      const shown = colours.groupIndexOf.get(solid.colours[t + corner]);
      if (shown !== undefined) {
        corners.push(`p${corner + 1}="${shown}"`);
      }
    }
    lines.push(`          <triangle ${corners.join(" ")} />`);
  }

  lines.push("        </triangles>", "      </mesh>", "    </object>");

  return lines.join("\n");
}

/** A length in millimetres, written to the precision a printer can hold. */
function millimetres(value: number): string {
  return `${Number.parseFloat(value.toFixed(MILLIMETRES))}`;
}

/** A colour as the eight hex digits 3MF writes, which is `#RRGGBBAA`. */
function hex({ r, g, b, a }: RGBA): string {
  return [r, g, b, a]
    .map((channel) =>
      Math.max(0, Math.min(255, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();
}

/** `text` with the five characters that would otherwise end a markup token. */
function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}
