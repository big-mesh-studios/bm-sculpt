/**
 * Reducing a model's colours to what a printer can actually do with them.
 *
 * ## Why there is a limit at all
 *
 * **Because the colours arrive per vertex and a printer has filaments.** `ChunkMesh.colours`
 * is four bytes a vertex, filled from `Field.colourAt` — so a model with two `Paint` operations
 * meeting has a *gradient* across every triangle between them, and every one of those
 * interpolated values is a distinct 24-bit colour. Two hundred and fifty-six vertices in a row
 * can be two hundred and fifty-six different colours, all of them correct, none of them
 * printable: a four-filament machine has four colours.
 *
 * So the reduction is not a compression, it is a translation from "what the field says" to "what
 * the machine can hold", and it has to happen before the file is written rather than being left
 * to the slicer — a slicer handed eight hundred distinct face colours does one of two things
 * with them, and neither is what the modeller drew.
 *
 * ## Which colours are kept
 *
 * **The most-used ones, and the rest are snapped to the nearest kept colour.** Not the first
 * ones found and not a fixed palette: a model's dominant colour is the one it is *mostly*, and
 * a reduction that kept the first eight encountered would depend on vertex order, which is a
 * property of the mesher rather than of the model.
 *
 * The kept colours come back **most-used first**, and the slots name them by position. That is
 * what makes slot zero the model's dominant colour, which matters because the writer sorts a
 * colour group by slot ascending and so gives slot zero group index zero — which is the entry
 * a solid's `pindex="0"` points at, and therefore the colour a corner the reduction gave up on
 * falls back to.
 *
 * **That works because the two orderings agree, and only because of it.** The writer's sort is
 * ascending and this palette's order is by use; they coincide exactly when the slots are dense
 * from zero, which they are — `kept` is drawn from colours that each have at least one corner,
 * so every slot in the palette is one a corner names. A palette that skipped a slot, or a writer
 * that stopped sorting by slot, would break the coincidence and send the fallback to an
 * arbitrary colour. `export-model.test.ts` pins it through the real pipeline rather than leaving
 * it to be true by inspection.
 *
 * ## Why the order is total
 *
 * **Because two exports of the same model have to be the same file.** Usage alone does not
 * order two colours used equally often, so ties break on the channels themselves, lowest first.
 * Without that, a model whose two halves are used exactly equally would pick between them by
 * hash order and the test for it could not be written.
 */
import type { RGBA } from "@big-mesh-studios/core";

/** How many colours a printer has, when nobody says otherwise. */
export const DEFAULT_MAX_COLOURS = 4;

/** A colour as the four bytes a packed vertex carries. */
type Packed = RGBA;

/** What a reduction produced: a palette, and a slot for every corner of every triangle. */
export interface QuantisedColours {
  /**
   * The colours the model now shows, most-used first.
   *
   * **Never empty for a mesh with triangles**, so a slot in `slots` is always an index into
   * something.
   */
  readonly palette: readonly RGBA[];
  /** Three slots a triangle, in the same order as the triangle's corners. */
  readonly slots: Uint8Array;
  /** How many distinct colours the mesh had before the reduction. */
  readonly distinct: number;
}

/** The colour a corner is counted under. */
const colourOf = (colours: Uint8Array, vertex: number): Packed => ({
  r: colours[vertex * 4] as number,
  g: colours[vertex * 4 + 1] as number,
  b: colours[vertex * 4 + 2] as number,
  a: colours[vertex * 4 + 3] as number,
});

/**
 * The packed key two colours are the same under.
 *
 * **A number rather than a string**, because this runs once per corner of a mesh that can be
 * half a million triangles and building a string per corner would be the largest cost in the
 * export. `0xRRGGBBAA` is 32 bits and every channel is a byte already, so it packs exactly.
 */
const keyOf = ({ r, g, b, a }: Packed): number =>
  ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;

/** The colour a packed key stands for. */
const fromKey = (key: number): RGBA => ({
  r: (key >>> 24) & 0xff,
  g: (key >>> 16) & 0xff,
  b: (key >>> 8) & 0xff,
  a: key & 0xff,
});

/**
 * How far apart two colours are.
 *
 * **Over all four channels, alpha included.** A printer has no use for alpha, so the argument
 * for ignoring it is real — but ignoring it merges a translucent part of a model with the
 * opaque part next to it on the strength of a channel nothing can act on, and the cost of
 * keeping them apart is only that they may not both survive the reduction. Alpha is the last
 * tie-break, not the first: it is weighted by the same one as the others, so two colours
 * differing only in alpha are the closest pair there is and merge first.
 */
const distance = (a: Packed, b: RGBA): number => {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const da = a.a - b.a;
  return dr * dr + dg * dg + db * db + da * da;
};

/**
 * The colours a mesh uses, counted, most-used first.
 *
 * **Counted over corners rather than over vertices.** A vertex used by five triangles is a
 * fifth of the colour of one used by one, and a vertex is not what gets printed — a corner is.
 */
const countColours = (
  colours: Uint8Array,
  indices: Uint32Array,
): Map<number, { colour: Packed; uses: number }> => {
  const counted = new Map<number, { colour: Packed; uses: number }>();

  for (const vertex of indices) {
    const colour = colourOf(colours, vertex);
    const key = keyOf(colour);
    const existing = counted.get(key);
    if (existing === undefined) {
      counted.set(key, { colour, uses: 1 });
    } else {
      existing.uses += 1;
    }
  }

  return counted;
};

/** Orders colours by how often they are used, and by their own bytes to break a tie. */
const byUse = (
  counted: Iterable<{ colour: Packed; uses: number }>,
): { colour: Packed; uses: number }[] =>
  [...counted].sort((a, b) => {
    if (a.uses !== b.uses) return b.uses - a.uses;
    return keyOf(a.colour) - keyOf(b.colour);
  });

/**
 * `colours` and `indices` as a palette of at most `maxColours` colours and a slot for every
 * corner.
 *
 * **Nothing is dropped when nothing has to be.** A model of one colour — which is most models,
 * and every model somebody has not painted — is within any limit, so every colour it holds is
 * kept and each corner's slot is its own. `slots` is filled either way, because the writer
 * wants an index per corner rather than a colour, and because a caller cannot tell from the
 * palette whether a reduction happened.
 *
 * @param colours Four bytes a vertex, as `ChunkMesh.colours` holds them.
 * @param indices Three a triangle, as `ChunkMesh.indices` holds them.
 * @param maxColours The most colours the destination can hold. Must be at least one.
 * @throws when `maxColours` is not a count of anything, which is a control wired to nothing.
 */
export const quantiseColours = (
  colours: Uint8Array,
  indices: Uint32Array,
  maxColours: number = DEFAULT_MAX_COLOURS,
): QuantisedColours => {
  if (!Number.isInteger(maxColours) || maxColours < 1) {
    throw new Error("a printed model needs room for at least one colour");
  }

  const counted = countColours(colours, indices);
  const ranked = byUse(counted.values());
  const distinct = ranked.length;

  if (distinct === 0) {
    return { palette: [], slots: new Uint8Array(0), distinct: 0 };
  }

  // **Kept most-used first, so the palette's order is a decision about the model rather than
  // about a hash.** See the header: slot zero is the colour an unnamed corner falls back to.
  const kept = ranked.slice(0, maxColours);
  const palette = kept.map(({ colour }) => fromKey(keyOf(colour)));

  // The slot every colour ends up at. **Built once**, so the search is not a per-corner loop
  // over the palette, and **keyed by packed colour** rather than by object — a key that misses
  // the kept set has to find the nearest kept colour, and comparing two `RGBA` literals by
  // identity would call every one of them a miss.
  const slotByKey = new Map<number, number>();
  kept.forEach(({ colour }, slot) => {
    slotByKey.set(keyOf(colour), slot);
  });

  for (const { colour } of ranked) {
    const key = keyOf(colour);
    if (slotByKey.has(key)) continue;

    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < palette.length; slot++) {
      const away = distance(colour, palette[slot] as RGBA);
      if (away < best) {
        best = away;
        nearest = slot;
      }
    }
    slotByKey.set(key, nearest);
  }

  const slots = new Uint8Array(indices.length);
  for (let t = 0; t < indices.length; t++) {
    slots[t] =
      slotByKey.get(keyOf(colourOf(colours, indices[t] as number))) ?? 0;
  }

  return { palette, slots, distinct };
};
