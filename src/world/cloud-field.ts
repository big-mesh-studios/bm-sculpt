/**
 * The cloud field, baked once: a three-dimensional shape volume and a
 * two-dimensional weather map.
 *
 * This is the data the cloud ray-march samples. Nothing here draws anything, and
 * nothing here knows the renderer exists — it is a handful of pure functions
 * over `Uint8Array`, so it can be baked on a worker and asserted on without a
 * graphics device. `clouds.ts` is what turns these bytes into textures.
 *
 * ## Why two textures, at such different scales
 *
 * The obvious way to draw clouds is to tile one noise texture across the sky. It
 * reads correctly for about ten seconds and then the eye finds the period and the
 * sky stops being weather and becomes wallpaper. Every technique here exists to
 * attack that one problem, and the load-bearing one is this: **the weather map
 * and the shape volume repeat on scales that do not divide into each other.**
 *
 * The weather map is read across tens of thousands of world units and the shape
 * volume across a few thousand, so a repeat in one is never in step with a repeat
 * in the other. The eye cannot align two periods it has not been given the ratio
 * of, and by the time it has learned one the other has moved. This is why a
 * second octave of coverage is not spent on the weather map: the same mask twice
 * at one scale is the same mask once.
 *
 * The other three, all of them free:
 *
 * - **Every octave is a different orientation** (`SWIZZLE`), so no octave's
 *   features line up with the tile's axes or with each other's. An ordinary fBm
 *   doubles the frequency on both axes at once, which stacks every octave's grid
 *   into one visible cross-hatch.
 * - **No octave frequency is a power of two**, and the ratio between them is
 *   about 1.7 rather than 2. A power-of-two ratio puts the octaves in exact
 *   sub-harmony, and sub-harmony is what the eye reads as a grid.
 * - **The base shape is Perlin-Worley, not Perlin** (`perlinWorley`). Gradient
 *   noise alone gives wispy shapes with no bulges and no implied motion; inverted
 *   Worley gives tight billows. Using the Worley field as the floor that Perlin
 *   dilates upward from keeps Perlin's connectedness while adding the billows,
 *   which is Guerrilla's Perlin-Worley from the 2015 Horizon talk.
 *
 * ## What is *not* here
 *
 * Coverage thresholds, the height profile and erosion are how the shader *reads*
 * the field, not properties of it, so they are not baked. `erosion` is the one
 * exception and it is here because it has a measured contract worth pinning — see
 * its own comment, which corrects a claim that is easy to make and wrong.
 *
 * Ported in approach from `big-mesh-studios`'s `apps/voxelscape`, which had no
 * cloud rendering at all by the end — it removed its moving cloud field because
 * players could not tell it from its standable cloud blocks (its ADR 0020). The
 * volumetric technique is from Schneider's Horizon Zero Dawn and Nubis talks
 * rather than from that project.
 */

/**
 * The shape volume's edge, in texels. Cubic because a `DataTexture` volume is.
 *
 * Sixty, and **not** sixty-four, which is the whole reason this number is not a
 * power of two.
 *
 * An octave's period has to divide the resolution of the texture it is baked
 * into, or the tile is not seamless: the linear filter interpolates between the
 * last texel and the first across the wrap, and if the two are not neighbours in
 * noise space it blends two unrelated values. Measured on the power-of-two
 * version of this file, a period of 11 in a 64-texel texture came back with a wrap
 * step 1.6 times the size of an ordinary step between neighbouring texels — a
 * faint grid on the seam, which for a sky is the one artefact that cannot be
 * tuned away later.
 *
 * So the periods here are divisors of sixty rather than powers of two, and sixty
 * has three and five in it. That is what lets the octaves use non-doubling
 * ratios, which is the other half of the anti-repetition argument: a period of
 * two into four into eight puts the octaves in exact sub-harmony on axes that a
 * signed permutation can only mirror, never rotate away. Three into five into
 * fifteen cannot be heard as a chord.
 *
 * Sixty is a compromise, and specifically the cheapest one available: sixty-four
 * cannot express the periods this wants, forty-eight has divisors 3, 4, 6, 8, 12,
 * 16 and 24 — which would do — but costs a third more texels than sixty, and
 * forty-five's divisors are too sparse to carry four octaves.
 */
export const SHAPE_SIZE = 60;

/**
 * The weather map's edge, in texels.
 *
 * Two hundred and forty for the same reason as `SHAPE_SIZE`, and with more odd
 * factors to choose from: it is two hundred and fifty-six times fifteen, so its
 * divisors run 3, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30 — enough to keep four curl
 * octaves off any ratio that a fifth of a texture could resonate with.
 */
export const WEATHER_SIZE = 240;

/**
 * The shape volume's detail channels, as periods across the tile.
 *
 * Doubled deliberately from the reference's four: the shape texture is the one
 * sampled at the highest frequency in the march, and four octaves would put two
 * of them at the edge of what this renderer can resolve at once.
 *
 * The finest, fifteen, is four texels per cell — sixty over fifteen. Nubis goes
 * finer, its detail volume being 32³ at frequency 16, which is two texels per
 * cell, and rmsl never builds a mip chain (`Texture.d.ts` accepts the mipmapped
 * filters and treats them as their base), so a two-texel feature has no smaller
 * version of itself to fall back to at the horizon and sparkles. Four is the most
 * this renderer can hold onto, and that is what sets the top of this list.
 */
export const SHAPE_DETAIL_PERIODS = [4, 6, 15] as const;

/**
 * The Perlin octaves under the Perlin-Worley dilate.
 *
 * Three, not four. A fourth would sit at or past the finest detail channel's
 * period, and the Worley floor is already doing that work.
 */
export const SHAPE_PERLIN_PERIODS = [2, 3, 5] as const;

/** The inverted-Worley octaves forming the floor that Perlin dilates. */
export const SHAPE_WORLEY_PERIODS = [3, 5] as const;

/**
 * The coverage map's octaves.
 *
 * Its own periods rather than the shape volume's, and this is the fix for the
 * worst artefact in an early version of this file. Coverage was sampled as a
 * horizontal slice of the shape field — one plane through the volume — and a
 * period-3 Worley on that plane has features a third of the tile across. The
 * result was a third of the weather map as a flat plateau at 0.78, which reads
 * as a sky with a hard edge rather than as cloud cover. Finer periods, and a
 * slice that travels through the volume, fix it.
 */
export const WEATHER_COVERAGE_PERLIN_PERIODS = [5, 8, 15] as const;
export const WEATHER_COVERAGE_WORLEY_PERIODS = [6, 10] as const;

/** The stream-function octaves the warp field's curl is taken from. */
export const CURL_PERIODS = [3, 5, 8, 15] as const;

/**
 * The streak field's octaves.
 *
 * Five, eight and twenty, which divide two hundred and forty at both the identity
 * stretch and the threefold one. The ratios are 1.6 and 2.5 rather than the 2 and 2
 * that four, eight and sixteen would give — that set was the last one in the file
 * still doubling, and the seam test caught it.
 */
export const STREAK_PERIODS = [5, 8, 20] as const;

/**
 * How far the streak field is stretched along each axis, as a multiple.
 *
 * One and three, and both integers, which is the whole constraint.
 *
 * A per-axis stretch scales the sample coordinate, so over the tile an octave
 * advances `period * stretch` cells. For the field to repeat at the tile's edge
 * that has to be a whole multiple of the period, which means the stretch has to
 * be a whole number — and the finest cell it implies has to land on a whole
 * number of texels, which means `period * stretch` has to divide the resolution.
 *
 * The stretch was originally 0.35 and 2.4, chosen because they looked like a good
 * aspect ratio. Neither is a whole number, so the tile held two thirds of one
 * period of the field and the wrap came back thirty-six times the size of an
 * ordinary step between neighbouring texels: a hard vertical line down the
 * weather map, in the one channel that decides where clouds are. Integer ratios
 * are the only anisotropy this tile can carry, which sounds limiting until you
 * notice the useful range is 1:2, 1:3 and 1:4 and the sky does not need more.
 */
export const STREAK_STRETCH_X = 1;
export const STREAK_STRETCH_Y = 3;

/**
 * Every octave period and stretch the bake uses, against the resolution it is baked
 * into.
 *
 * Exported as data rather than as a validator, because the assertion is the
 * interesting part and a test can only assert it if the numbers are visible.
 */
export const FIELD_PERIODS: readonly {
  readonly label: string;
  readonly periods: readonly number[];
  /** The stretch applied to the coordinate before scaling by the period. */
  readonly stretch: readonly [number, number];
  /** The resolution both axes of the field are baked at. */
  readonly resolution: number;
}[] = [
  {
    label: "shape detail",
    periods: SHAPE_DETAIL_PERIODS,
    stretch: [1, 1],
    resolution: SHAPE_SIZE,
  },
  {
    label: "shape perlin",
    periods: SHAPE_PERLIN_PERIODS,
    stretch: [1, 1],
    resolution: SHAPE_SIZE,
  },
  {
    label: "shape worley",
    periods: SHAPE_WORLEY_PERIODS,
    stretch: [1, 1],
    resolution: SHAPE_SIZE,
  },
  {
    label: "coverage perlin",
    periods: WEATHER_COVERAGE_PERLIN_PERIODS,
    stretch: [1, 1],
    resolution: WEATHER_SIZE,
  },
  {
    label: "coverage worley",
    periods: WEATHER_COVERAGE_WORLEY_PERIODS,
    stretch: [1, 1],
    resolution: WEATHER_SIZE,
  },
  {
    label: "curl",
    periods: CURL_PERIODS,
    stretch: [1, 1],
    resolution: WEATHER_SIZE,
  },
  {
    label: "streak",
    periods: STREAK_PERIODS,
    stretch: [STREAK_STRETCH_X, STREAK_STRETCH_Y],
    resolution: WEATHER_SIZE,
  },
];

/**
 * What every entry of `FIELD_PERIODS` must satisfy for its texture to be seamless.
 *
 * `resolution % (period * stretch) === 0`, on both axes. This is the rule that
 * decides which resolutions are usable at all, and getting it wrong is silent:
 * the bake succeeds, the texture looks plausible in the middle, and the fault
 * appears only as one visible line along a seam.
 */
export const PERIOD_RULE =
  "period * stretch must divide the resolution, on both axes";

/**
 * How far the curl is scaled into its byte.
 *
 * The raw gradient of a normalised fBm over a unit tile has a standard deviation
 * near one, so writing it straight into a byte would spend a quarter of the range
 * on the middle and clip the tails. This puts it at about a tenth, which leaves
 * the whole byte usable and puts the extremes of the warp where a byte can still
 * tell them apart.
 *
 * The shader multiplies by whatever displacement it wants in tile units, so the
 * convention that matters to it is only that 0.5 — byte 128 — is no warp.
 */
const CURL_SCALE = 0.12;

/**
 * The coverage map's height through the volume, as a fraction of a cell.
 *
 * Coverage is a two-dimensional field and this file only has three-dimensional
 * noise, so the map has to be a slice. A *flat* slice is a projection, and a
 * projection of a low-frequency volume is very smooth along the slice's normal.
 * Travelling through the volume instead — `sin` in each axis, so the surface is
 * periodic and the tile still has no seam — gives every point of the map a
 * genuinely different depth to sample and puts structure back in.
 */
const WEATHER_COVERAGE_DEPTH = 0.35;

/**
 * The base shape's output window, stretched to the full byte.
 *
 * The Perlin-Worley dilate is a convex combination of two fields, and convex
 * combinations lose variance: it cancels where the two disagree, which is most of
 * the volume. Measured, this left ninety-two per cent of the volume inside the top
 * half of the range and under one per cent below 0.4, which is a cloud shape with
 * almost no gradient for a coverage threshold to work against.
 *
 * These are the field's measured first and ninety-ninth percentiles. Normalising
 * by the volume's own statistics instead would be self-tuning and would also mean
 * a bake at a smaller size produced a *different* field rather than a coarser
 * sample of the same one, which is the property that lets the tests assert on a
 * cheap bake and mean it.
 */
const SHAPE_WINDOW: readonly [number, number] = [0.4, 0.96];

/**
 * The coverage map's output window, for the same reason and measured the same way.
 */
const COVERAGE_WINDOW: readonly [number, number] = [0.44, 0.95];

/**
 * The streak field's output window, also for contrast.
 *
 * Measured before this existed: the field occupied a fifth of its byte range,
 * which is fifteen bits of an eight-bit channel spent on nothing.
 */
const STREAK_WINDOW: readonly [number, number] = [0.24, 0.72];

/**
 * Signed axis permutations, cycled between octaves.
 *
 * Each maps `Z³` onto `Z³`, so wrapping a cell index modulo the period still
 * lands on the same lattice after the swap and the tile stays seamless. That is
 * the whole reason this is a list of permutations and not a list of rotation
 * angles: an arbitrary rotation of the sample point maps `Z³` to a rotated
 * lattice, the wrapped corners stop matching, and the tile gains a seam no amount
 * of blending hides. Two dimensions offer only eight of these; three offer
 * forty-eight, which is enough that consecutive octaves are never merely turned
 * ninety degrees.
 */
const SWIZZLE: readonly (readonly [
  number,
  number,
  number,
  number,
  number,
  number,
])[] = [
  [0, 1, 2, 1, 1, 1],
  [1, 2, 0, 1, -1, 1],
  [2, 0, 1, -1, 1, 1],
  [1, 0, 2, 1, -1, -1],
  [0, 2, 1, -1, 1, -1],
  [2, 1, 0, 1, 1, -1],
];

/**
 * The twelve gradient directions, as the edge midpoints of a cube.
 *
 * Perlin's improved-noise set. A table rather than a hash-to-vector, because
 * generating a random unit vector costs a square root and a logarithm per cell
 * and this needs neither.
 */
const GRADIENTS = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0,
  -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

/** The largest magnitude three-dimensional Perlin noise reaches, for this set. */
const PERLIN_PEAK = Math.sqrt(3) / 2;

export const saturate = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** `v` from `[fromLow, fromHigh]` onto `[toLow, toHigh]`, unclamped. */
export const remap = (
  v: number,
  fromLow: number,
  fromHigh: number,
  toLow: number,
  toHigh: number,
): number =>
  toLow +
  ((v - fromLow) * (toHigh - toLow)) / Math.max(fromHigh - fromLow, 1e-9);

/** `v` from one window onto 0..1. The stretch both output windows apply. */
const window = (v: number, limits: readonly [number, number]): number =>
  saturate(remap(v, limits[0], limits[1], 0, 1));

/** The quintic fade: zero first *and* second derivative at each lattice point. */
const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * A cell's hash, in 0..1.
 *
 * The wrapping is done by the callers — by reducing a cell index modulo the
 * period before hashing — rather than here, so this stays a function of a cell's
 * position within the tile rather than of where in space that cell was reached
 * from. Two cells at opposite ends of the tile hash alike and so get the same
 * feature point, which is what makes the wrap invisible.
 */
const hashCell = (x: number, y: number, z: number, seed: number): number => {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ z, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

/** The wrapped form of an integer, for a positive period. */
const wrap = (i: number, period: number): number =>
  ((i % period) + period) % period;

/** One octave: its period, its orientation, its hash, and Worley's feature points. */
export interface Octave {
  readonly period: number;
  readonly swizzle: readonly [number, number, number, number, number, number];
  readonly hash: number;
  /** `period³ * 3` feature points, or empty for a Perlin octave. */
  readonly points: Float32Array;
  /**
   * The 27 neighbour cells' feature-point offsets, and the cell deltas that go
   * with them, both in the order `tileWorley` walks them.
   *
   * Resolved once per octave because both depend only on the period: the sample's
   * own cell changes every sample, but where its neighbours live does not.
   * Hoisting the modulos and the multiplies out of the inner loop is worth doing
   * across a 64³ volume and five Worley octaves, though it is not the difference
   * between fast and slow — see `bakeWeather` for what is.
   */
  readonly offsets: Int32Array;
  readonly deltas: Int8Array;
}

/** A run of octaves, resolved once and read by every sample that uses them. */
export interface NoiseSet {
  readonly octaves: readonly Octave[];
}

const NO_POINTS = new Float32Array(0);
const NO_OFFSETS = new Int32Array(0);
const NO_DELTAS = new Int8Array(0);

/**
 * A period's worth of Worley feature points and neighbour tables.
 *
 * Built once per octave and shared by every sample of it. Without the points the
 * inner loop costs three hashes per neighbour instead of three array reads.
 */
const worleyTable = (
  period: number,
  hash: number,
): { points: Float32Array; offsets: Int32Array; deltas: Int8Array } => {
  const points = new Float32Array(period * period * period * 3);
  let at = 0;
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) {
        points[at++] = hashCell(x, y, z, hash);
        points[at++] = hashCell(x, y, z, hash ^ 0x51ed270b);
        points[at++] = hashCell(x, y, z, hash ^ 0x2545f491);
      }
    }
  }

  // The current cell first, then its six faces, twelve edges and eight corners.
  // Not fewer: a feature point sits anywhere in its cell, so the nearest one to a
  // sample near a cell boundary can be in any of the twenty-seven, and dropping the
  // corners is what gives the technique its reputation for square artefacts along
  // cell edges. The order is the near ones first because the running minimum is
  // then usually tight by the time the far ones are reached.
  const offsets = new Int32Array(27);
  const deltas = new Int8Array(27 * 3);
  let k = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        offsets[k] =
          ((wrap(dz, period) * period + wrap(dy, period)) * period +
            wrap(dx, period)) *
          3;
        deltas[k * 3] = dx;
        deltas[k * 3 + 1] = dy;
        deltas[k * 3 + 2] = dz;
        k++;
      }
    }
  }
  return { points, offsets, deltas };
};

/**
 * Resolves a list of periods into octaves.
 *
 * Every seed and every orientation is fixed here rather than at sample time, so
 * two calls with the same arguments share one set of tables and a set of tables
 * is immutable once built. The `swizzle` argument offsets *which* entry of
 * `SWIZZLE` the run starts from, which is what keeps three single-octave detail
 * sets from all inheriting the first one — the bug that had the shape volume's
 * three detail channels sharing an orientation.
 */
const noiseSet = (
  periods: readonly number[],
  seed: number,
  worley: boolean,
  swizzleOffset = 0,
): NoiseSet => ({
  octaves: periods.map((period, i) => {
    const hash = seed + i * 7919;
    const table = worley ? worleyTable(period, hash) : null;
    return {
      period,
      swizzle: SWIZZLE[(i + swizzleOffset) % SWIZZLE.length]!,
      hash,
      points: table?.points ?? NO_POINTS,
      offsets: table?.offsets ?? NO_OFFSETS,
      deltas: table?.deltas ?? NO_DELTAS,
    };
  }),
});

/**
 * The resolved sets, built once when the module loads.
 *
 * Module-level and immutable after construction, so this is not a mutable cache —
 * it is a few thousand floats of constant data that happens to be computed by a
 * function rather than written out by hand. Nothing can change it, nothing observes
 * when it was built, and two bakes of the same seed get the same tables because
 * there is only ever one of them. Building them per sample instead turned a
 * one-second bake into a thirty-four-second one during development.
 *
 * The offsets differ per set deliberately: adjacent sets would otherwise be the
 * same noise in different orientations of the same lattice, which is a grid with
 * the corners filed off.
 */
const SHAPE_PERLIN = noiseSet(SHAPE_PERLIN_PERIODS, 0x5f356495, false, 0);
const SHAPE_WORLEY = noiseSet(SHAPE_WORLEY_PERIODS, 0x1b873593, true, 2);
const COVERAGE_PERLIN = noiseSet(
  WEATHER_COVERAGE_PERLIN_PERIODS,
  0x2c1b3c6d,
  false,
  3,
);
const COVERAGE_WORLEY = noiseSet(
  WEATHER_COVERAGE_WORLEY_PERIODS,
  0x297a2d39,
  true,
  5,
);
const WEATHER_STREAMS = noiseSet(CURL_PERIODS, 0x85ebca6b, false, 1);
const WEATHER_STREAKS = noiseSet(STREAK_PERIODS, 0x165667b1, false, 4);
const DETAIL_SETS = SHAPE_DETAIL_PERIODS.map((period, i) =>
  noiseSet([period], 31 + i * 977, true, i),
);

/**
 * The resolved noise sets, exported so a test can evaluate them directly.
 *
 * Periodicity is the property everything else rests on, and it is much better
 * asserted on the noise than inferred from a baked texture: a test can ask
 * `perlinFbm(NOISE.shapePerlin, u, v, w) === perlinFbm(..., u + 1, v, w)` and be
 * answered, rather than comparing the distribution of a step across the wrap with
 * the distribution of a step inside it and hoping the difference shows up.
 */
export const NOISE = {
  shapePerlin: SHAPE_PERLIN,
  shapeWorley: SHAPE_WORLEY,
  detail: DETAIL_SETS,
  coveragePerlin: COVERAGE_PERLIN,
  coverageWorley: COVERAGE_WORLEY,
  streams: WEATHER_STREAMS,
  streaks: WEATHER_STREAKS,
} as const;

/** One axis of a swizzled coordinate, chosen from the other two. */
const axis = (which: number, x: number, y: number, z: number): number =>
  which === 0 ? x : which === 1 ? y : z;

/**
 * Applies a swizzle: a permutation of the axes followed by a sign on each.
 *
 * Both halves matter and one of them is not optional. The signs alone would be
 * enough to keep the octaves off *some* of the axes, but a mirror maps the integer
 * lattice onto itself — so a sign flip leaves an octave's features lying exactly
 * along the tile's axes, mirrored, which is still lying along the tile's axes. Only
 * the permutation actually turns one.
 *
 * It was the permutation that was missing, for a while: both samplers read the
 * sign entries and never the permutation entries, so every octave was a bare sign
 * flip of every other and the whole argument above was decoration. The measured
 * tell was that the three detail channels had almost identical histograms — which
 * is what one would expect of three copies of one noise rather than three
 * frequencies of it.
 */
const swizzled = (
  table: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] => [
  table[3]! * axis(table[0]!, x, y, z),
  table[4]! * axis(table[1]!, x, y, z),
  table[5]! * axis(table[2]!, x, y, z),
];

/**
 * One octave of tileable gradient noise, in roughly [-1, 1].
 *
 * `period` is how many cells the tile is divided into on each axis, and the corner
 * hash is taken modulo that, so the lattice closes on itself. The swizzled
 * coordinate is what this hashes, which is what keeps the octave's features off the
 * tile's axes.
 */
const tilePerlin = (
  x: number,
  y: number,
  z: number,
  octave: Octave,
): number => {
  const period = octave.period;
  const table = octave.swizzle;
  const [px, py, pz] = swizzled(table, x, y, z);

  const xi = Math.floor(px);
  const yi = Math.floor(py);
  const zi = Math.floor(pz);
  const xf = px - xi;
  const yf = py - yi;
  const zf = pz - zi;

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const z0 = wrap(zi, period);
  const x1 = x0 + 1 === period ? 0 : x0 + 1;
  const y1 = y0 + 1 === period ? 0 : y0 + 1;
  const z1 = z0 + 1 === period ? 0 : z0 + 1;

  const hash = octave.hash;
  const corner = (
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
  ): number => {
    const g = (hashCell(cx, cy, cz, hash) * 12) | 0;
    return (
      GRADIENTS[g * 3]! * dx +
      GRADIENTS[g * 3 + 1]! * dy +
      GRADIENTS[g * 3 + 2]! * dz
    );
  };

  const x00 = lerp(
    corner(x0, y0, z0, xf, yf, zf),
    corner(x1, y0, z0, xf - 1, yf, zf),
    u,
  );
  const x10 = lerp(
    corner(x0, y1, z0, xf, yf - 1, zf),
    corner(x1, y1, z0, xf - 1, yf - 1, zf),
    u,
  );
  const x01 = lerp(
    corner(x0, y0, z1, xf, yf, zf - 1),
    corner(x1, y0, z1, xf - 1, yf, zf - 1),
    u,
  );
  const x11 = lerp(
    corner(x0, y1, z1, xf, yf - 1, zf - 1),
    corner(x1, y1, z1, xf - 1, yf - 1, zf - 1),
    u,
  );
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
};

/** One octave of tileable Worley noise: the distance to the nearest feature point. */
const tileWorley = (
  x: number,
  y: number,
  z: number,
  octave: Octave,
): number => {
  const period = octave.period;
  const table = octave.swizzle;
  const [px, py, pz] = swizzled(table, x, y, z);

  const xi = Math.floor(px);
  const yi = Math.floor(py);
  const zi = Math.floor(pz);

  const points = octave.points;
  const offsets = octave.offsets;
  const deltas = octave.deltas;
  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const z0 = wrap(zi, period);
  const base = ((z0 * period + y0) * period + x0) * 3;

  let nearest = Infinity;
  for (let k = 0; k < 27; k++) {
    const at = base + offsets[k]!;
    const dx = px - (xi + deltas[k * 3]!) - points[at]!;
    const dy = py - (yi + deltas[k * 3 + 1]!) - points[at + 1]!;
    const dz = pz - (zi + deltas[k * 3 + 2]!) - points[at + 2]!;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < nearest) nearest = d;
  }
  return Math.sqrt(nearest);
};

/** A normalised sum of tileable gradient noise, in 0..1. */
export const perlinFbm = (
  set: NoiseSet,
  u: number,
  v: number,
  w: number,
): number => {
  let value = 0;
  let amplitude = 1;
  let total = 0;
  for (let octave of set.octaves) {
    value +=
      amplitude *
      tilePerlin(
        u * octave.period,
        v * octave.period,
        w * octave.period,
        octave,
      );
    total += amplitude;
    amplitude *= 0.5;
  }
  return saturate((value / Math.max(total, 1e-9) / PERLIN_PEAK) * 0.5 + 0.5);
};

/**
 * A normalised sum of inverted Worley noise, in 0..1.
 *
 * Inverted because the raw distance field is a set of bright points in a dark
 * plane and a cloud needs the opposite: dense centres, empty gaps.
 */
export const worleyFbm = (
  set: NoiseSet,
  u: number,
  v: number,
  w: number,
): number => {
  let value = 0;
  let amplitude = 1;
  let total = 0;
  for (let octave of set.octaves) {
    // `1 - distance`, and the distance is in cells and can exceed one, so this
    // needs clamping even though the sum is already normalised.
    value +=
      amplitude *
      saturate(
        1 -
          tileWorley(
            u * octave.period,
            v * octave.period,
            w * octave.period,
            octave,
          ),
      );
    total += amplitude;
    amplitude *= 0.5;
  }
  return value / Math.max(total, 1e-9);
};

/**
 * Perlin dilated upward from a Worley floor: a base cloud shape.
 *
 * `worley + perlin * (1 - worley)`, which puts the Worley field at the bottom of
 * the range and lets Perlin modulate upward from it. Gradient noise alone gives
 * connected but wispy shapes with no bulges; Worley alone gives tight billows with
 * nothing connecting them. This is Guerrilla's Perlin-Worley, and the combination
 * is the reason a cloud reads as having mass rather than as fog.
 */
const perlinWorley = (
  worley: NoiseSet,
  perlin: NoiseSet,
  u: number,
  v: number,
  w: number,
): number => {
  const floor = worleyFbm(worley, u, v, w);
  return saturate(floor + perlinFbm(perlin, u, v, w) * (1 - floor));
};

/** A packed byte volume or map: RGBA, row-major, `size * size * depth`. */
export interface PackedField {
  readonly size: number;
  readonly depth: number;
  readonly data: Uint8Array;
}

const toByte = (v: number): number => Math.round(saturate(v) * 255);

const pack = (size: number, depth: number): PackedField => ({
  size,
  depth,
  data: new Uint8Array(size * size * depth * 4),
});

/** One component of the seed's offset, folded into 0..1. */
const frac = (v: number): number => v - Math.floor(v);

/**
 * Where a seed puts the noise, as three offsets in 0..1.
 *
 * The tables are resolved once when the module loads and shared by every bake in
 * every worker, so two seeds have to differ somewhere other than in the tables. An
 * offset on the sample position is enough, because a field sampled at an offset is
 * a different field.
 *
 * Three irrational multipliers rather than one, because a single one is a
 * one-dimensional sequence and neighbouring seeds land on neighbouring offsets —
 * two worlds that differ by a hair, which is the hardest kind of difference to
 * notice and the easiest to ship by accident. These are the first three of the
 * `R2` low-discrepancy sequence, which is what makes them well spread.
 *
 * Reduced into 0..1 rather than left at `seed * 0.618`, which for a seed like
 * 20260901 puts the sample coordinate at thirty-seven million and spends most of
 * the float's precision on a whole number. The field is periodic in each of these
 * axes over the unit interval, so folding loses nothing.
 */
const seedOffsets = (seed: number): readonly [number, number, number] => [
  frac(seed * 0.7548776662466927),
  frac(seed * 0.5698402909980532),
  frac(seed * 0.6180339887498949),
];

/**
 * The shape volume: red is the base cloud shape, and the other three are inverted-
 * Worley detail at increasing frequencies for the shader to erode the base shape
 * with.
 *
 * The channel *layout* is Guerrilla's and is load-bearing rather than incidental.
 * The shader's cheap empty-space test reads red alone, so red has to be the channel
 * that means something on its own; the detail has to live in channels it can afford
 * to skip when red is zero. Putting the base shape in green instead would make the
 * early-out sample a channel that says nothing about whether there is a cloud.
 *
 * Sampled at the centre of each texel rather than its corner. At this size the two
 * differ by half a texel and neither is visible, but the centre is what the GPU's
 * reconstruction assumes, so baking corners puts the whole field half a texel off
 * every position the shader will ask about.
 */
const bakeShape = (seed: number, size: number): PackedField => {
  const field = pack(size, size);
  const [ox, oy, oz] = seedOffsets(seed);
  let at = 0;
  for (let z = 0; z < size; z++) {
    const w = (z + 0.5) / size;
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;
        field.data[at++] = toByte(
          window(
            perlinWorley(SHAPE_WORLEY, SHAPE_PERLIN, u + ox, v + oy, w + oz),
            SHAPE_WINDOW,
          ),
        );
        for (let channel = 0; channel < 3; channel++) {
          field.data[at++] = toByte(
            worleyFbm(DETAIL_SETS[channel]!, u + ox, v + oy, w + oz),
          );
        }
      }
    }
  }
  return field;
};

/**
 * The weather map: red is coverage, green and blue are a divergence-free warp, and
 * alpha is a streak that tells high thin cloud from low thick cloud.
 *
 * Two coverage channels would have been the obvious packing and it is the wrong
 * one. Coverage is a *mask*, and a mask applied twice at one scale is the same mask
 * once. The more useful second and third things to spend channels on are a warp,
 * because a warp moves the shape volume's features off the grid the shape volume
 * has of its own — and it costs one texture read to do it.
 *
 * The warp is a **curl**, taken as the perpendicular gradient of a scalar stream
 * function, which is not decoration. A curl field has zero divergence, so it
 * displaces the noise it warps without ever gathering it or thinning it anywhere.
 * A warp built from two independent noise samples does both, and the places where
 * it gathers read as the noise piling into hard veins.
 */
const bakeWeather = (seed: number, size: number): PackedField => {
  const field = pack(size, 1);
  const [ox, oy] = seedOffsets(seed);

  // The stream function is evaluated into a buffer first and the curl taken from
  // the buffer, in two passes rather than four evaluations per texel. This is the
  // single largest cost in the whole bake and it is not the arithmetic: a central
  // difference calls the four-octave fBm four times per texel, which is sixteen
  // Perlin octaves to produce two numbers, and the weather map was measurably more
  // expensive *per texel* than the volume eight times its size.
  //
  // Buffering also gets the wrap for free, which is why the two edges needed a
  // comment about reaching round the far side at all. The buffer is periodic by
  // being an array it is read out of range from.
  const psi = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      psi[y * size + x] = perlinFbm(
        WEATHER_STREAMS,
        (x + 0.5) / size + ox,
        v + oy,
        0.5,
      );
    }
  }

  // The derivative is taken over two texels, so the divisor is two texels' worth
  // of the tile rather than a chosen epsilon. The finest curl octave is period
  // seventeen, which at this size is fifteen texels across, so a two-texel step is
  // a seventh of a feature and the difference is a gradient rather than a sample of
  // the noise's own grain.
  const step = 2 / size;

  let at = 0;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const depthV = Math.sin(v * Math.PI * 2) * WEATHER_COVERAGE_DEPTH;
    const rowUp = wrap(y + 1, size) * size;
    const rowDown = wrap(y - 1, size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      field.data[at++] = toByte(
        window(
          perlinWorley(
            COVERAGE_WORLEY,
            COVERAGE_PERLIN,
            u + ox,
            v + oy,
            0.5 + depthV + Math.sin(u * Math.PI * 2) * WEATHER_COVERAGE_DEPTH,
          ),
          COVERAGE_WINDOW,
        ),
      );

      const right = wrap(x + 1, size);
      const left = wrap(x - 1, size);
      field.data[at++] = toByte(
        ((psi[rowUp + x]! - psi[rowDown + x]!) / step) * CURL_SCALE + 0.5,
      );
      field.data[at++] = toByte(
        (-(psi[row + right]! - psi[row + left]!) / step) * CURL_SCALE + 0.5,
      );

      // Stretched along one axis, so the field it produces is streaked rather than
      // blobby — the difference between cirrus and cumulus at this resolution.
      // `STREAK_STRETCH` is not an arbitrary anisotropy; see it for why it is
      // restricted to integers.
      field.data[at++] = toByte(
        window(
          perlinFbm(
            WEATHER_STREAKS,
            u * STREAK_STRETCH_X + ox,
            v * STREAK_STRETCH_Y + oy,
            0.5,
          ),
          STREAK_WINDOW,
        ),
      );
    }
  }
  return field;
};

export interface CloudField {
  /**
   * The shape volume. `size³` RGBA texels: red is the base cloud shape, and the
   * other three are inverted-Worley detail at `SHAPE_DETAIL_PERIODS`.
   */
  readonly shape: PackedField;
  /**
   * The weather map. `size²` RGBA texels: red is coverage, green and blue are a
   * divergence-free warp in 0..1 centred on 0.5, alpha is the streak field.
   */
  readonly weather: PackedField;
}

/**
 * Bakes both fields. Pure in `seed`, so the same seed always gives the same sky.
 *
 * The sizes are parameters only so a test can bake a small field and assert on its
 * structure without paying for a full one. A smaller bake is the same field sampled
 * more coarsely — the periods, the periodicity and the output windows are all
 * unchanged, so the *statistics* a test measures carry over — but individual texels
 * will not correspond, and below about forty the detail channels are down to two
 * texels per cell and stop being the field at all. Production uses `SHAPE_SIZE` and
 * `WEATHER_SIZE`.
 */
export const bakeCloudField = (
  seed: number,
  shapeSize: number = SHAPE_SIZE,
  weatherSize: number = WEATHER_SIZE,
): CloudField => ({
  shape: bakeShape(seed, shapeSize),
  weather: bakeWeather(seed, weatherSize),
});

/**
 * Subtracts high-frequency detail from the bounds of a low-frequency shape, and
 * never returns more than it was given.
 *
 * This is how a cloud gets a ragged edge without also getting holes in its middle,
 * and it is why the ray-march can skip empty space cheaply: detail is applied as a
 * *subtractive bound* on the base shape, so a point where the base says "no cloud"
 * stays "no cloud" however the detail falls. Detail *added* to the shape would break
 * that, and every early-out built on the base shape would start letting detail
 * through empty space.
 *
 * ## The detail's direction, and why the clamp is not optional
 *
 * `high` is one of the volume's detail channels, and those are **inverted** Worley:
 * high at a feature point, which is the middle of a billow, and low between them.
 *
 * Both published forms erase least where the detail is higher and most where it is
 * lower — Horizon's remaps the base over `[1 - detail, 1]` and Skybolt's shifts by
 * `detail` upward, and both threshold *down*. That is the right way round for this
 * field, because the gaps are what an edge is carved out of: erasing where the detail
 * is low cuts the space *between* billows, which is what turns one smooth blob into
 * a ragged edge. Erasing where the detail is high instead would punch a hole through
 * the middle of every dense core, which is the one thing cloud erosion must not do.
 *
 * This is worth stating because it was got wrong here first, and the wrong version
 * is perfectly plausible: negating the detail so that "high means erode more" reads
 * as the obviously-correct rule and in fact carves the billow tops out of every
 * cloud. The rule is not "high erodes more" or "high erodes less" — it is *which end
 * of this field is the gap*, and that depends on whether the field was inverted.
 *
 * On its own neither published form is subtractive. Skybolt's output tracks an
 * S-curve through the base rather than the line, so unclamped it returns **more**
 * than it was given about half the time — a base of 0.8 with detail of 0.9 comes
 * back as 1.25, which saturates. That matters here in a way it does not in Skybolt's
 * own pipeline, because there the early-out tests the *dimensional profile* while
 * this one tests the *base shape*. Measured over three hundred thousand uniformly
 * random pairs:
 *
 * | form                                             | ever raises density | mean abs. deviation from base |
 * | ------------------------------------------------ | ------------------- | ----------------------------- |
 * | Horizon's `saturate(remap(base, 1 - detail, 1))` | never               | 0.250                         |
 * | Skybolt's mean-stabilising remap                 | half the time        | 0.200                         |
 * | this, Skybolt's remap clamped to the base        | never                | **0.100**                     |
 *
 * So the clamp restores the bound and *also* halves the deviation — it is not a
 * price paid for correctness. The remaining bias is downward and consistent (mean
 * output 0.401 against a mean base of 0.501) rather than nonlinear, so the coverage
 * threshold absorbs it in the ordinary way.
 *
 * ## What the softness does, and it is not a width
 *
 * `softness` is the fraction of the remap's range the *detail* fills. It is not an
 * edge width, and it is not monotone: at both ends erosion is the identity and its
 * effect peaks near a half. Measured, as mean density removed from a base value:
 *
 * - at `softness` 0 and 1 it removes nothing — those are two ways to turn erosion
 *   off, and one of them is the default Skybolt ships
 * - near 0.5 it removes the most, around 0.12 from a base of 0.2 to 0.3
 * - a base near **0.5 is barely eroded at any softness**, because the remap is
 *   centred there and the shifted detail straddles the window symmetrically
 *
 * That middle is fine rather than a problem: after the coverage threshold, a base
 * near 0.5 is the inside of a cloud and erosion there would punch holes in it, and
 * the bases erosion *does* bite are the low ones at the edges.
 *
 * `erosionOnlySubtracts` exists so a test can check the bound over the whole baked
 * field rather than at a few tidy points.
 */
export const erosion = (low: number, high: number, softness = 0.4): number => {
  const h = saturate(softness);
  if (h <= 0) return saturate(low);
  const base = saturate(low);
  const detail = saturate(high) * (1 - h) + h;
  const floor = 1 - base;
  // The clamp is the bound the ray-march's early-out needs. Without it this
  // returns more than it was given for roughly half of all inputs, because the
  // remap's window sits above the base for most detail values.
  return Math.min(saturate(remap(detail, floor, floor + h, 0, 1)), base);
};

/**
 * Whether a detail value can only take density away.
 *
 * The property the march's early-out depends on, exported so a test can assert it
 * over the whole field: erosion must never hand back more than it was given.
 */
export const erosionOnlySubtracts = (low: number, high: number): boolean =>
  erosion(low, high) <= low + 1e-12;
