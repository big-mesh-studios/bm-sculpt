import { describe, expect, it } from "vitest";

import {
  CURL_PERIODS,
  erosion,
  erosionOnlySubtracts,
  FIELD_PERIODS,
  NOISE,
  PERIOD_RULE,
  SHAPE_DETAIL_PERIODS,
  SHAPE_SIZE,
  STREAK_STRETCH_X,
  STREAK_STRETCH_Y,
  WEATHER_SIZE,
  bakeCloudField,
  perlinFbm,
  saturate,
  worleyFbm,
  type CloudField,
  type NoiseSet,
  type PackedField,
} from "./cloud-field";

/**
 * Nothing here needs a graphics device.
 *
 * The field is a handful of pure functions over `Uint8Array`, so every claim about
 * it is answerable here rather than by looking at a sky. What a unit test *cannot*
 * see is whether the sky built on top of it looks like weather, and that is what
 * the browser is for.
 *
 * The one thing worth saying about how these are written: most of them are here
 * because something in this file's development was wrong in a way that a
 * screenshot would have shown as "the clouds look a bit off" and no screenshot
 * would have explained. The period rule, the periodicity, the channel decorrelation
 * and the erosion bound are all regression guards for specific, already-fixed faults
 * whose symptom was one of: a hard line down the weather map, three identical
 * detail channels, a third of the sky a flat plateau, or detail adding density
 * where there was none.
 */

const SEED = 20260901;

/** One full bake, shared: this is a couple of seconds and every test wants it. */
const field: CloudField = bakeCloudField(SEED);

const channelOf = (packed: PackedField, channel: number): Uint8Array => {
  const texels = (packed.data.length / 4) | 0;
  const out = new Uint8Array(texels);
  for (let i = 0; i < texels; i++) out[i] = packed.data[i * 4 + channel]!;
  return out;
};

const mean = (v: Uint8Array): number => {
  let sum = 0;
  for (const b of v) sum += b;
  return sum / v.length;
};

const percentile = (v: Uint8Array, p: number): number => {
  const sorted = Array.from(v).sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))]!;
};

/** Pearson correlation between two equally long byte channels. */
const correlation = (a: Uint8Array, b: Uint8Array): number => {
  const n = Math.min(a.length, b.length);
  let sa = 0;
  let sb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
    sab += a[i]! * b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  const va = sa / n - ma * ma;
  const vb = sb / n - mb * mb;
  return (sab / n - ma * mb) / Math.sqrt(Math.max(va * vb, 1e-9));
};

/** How many of the ten deciles of the byte range hold at least a per cent of the field. */
const populatedDeciles = (v: Uint8Array): number => {
  const bins = new Array(10).fill(0);
  for (const b of v) bins[Math.min(9, (b / 25.6) | 0)]!++;
  return bins.filter((c) => c / v.length >= 0.01).length;
};

describe("the seam rule", () => {
  it(`holds for every period: ${PERIOD_RULE}`, () => {
    // The single rule the whole tile depends on, and the one this file got wrong
    // twice. A period that does not divide its resolution looks perfectly fine in
    // the middle of the texture and shows up only as one visible line at the wrap,
    // because that is the one place the linear filter blends two texels that are
    // not neighbours in noise space.
    for (const fieldSpec of FIELD_PERIODS) {
      for (const period of fieldSpec.periods) {
        for (const stretch of fieldSpec.stretch) {
          const cells = period * stretch;
          expect(
            fieldSpec.resolution % cells,
            `${fieldSpec.label}: period ${period} stretch ${stretch} into ${fieldSpec.resolution}`,
          ).toBe(0);
        }
      }
    }
  });

  it("leaves every octave at least four texels per cell", () => {
    // rmsl never builds a mip chain, so a feature narrower than a texel has no
    // smaller version of itself to fall back to at the horizon.
    for (const fieldSpec of FIELD_PERIODS) {
      for (const period of fieldSpec.periods) {
        for (const stretch of fieldSpec.stretch) {
          const texels = fieldSpec.resolution / (period * stretch);
          expect(
            texels,
            `${fieldSpec.label}: period ${period}`,
          ).toBeGreaterThanOrEqual(4);
        }
      }
    }
  });

  it("uses resolutions with a factor of three or five in them", () => {
    // Otherwise every period is a power of two, and the octaves land in exact
    // sub-harmony — which the eye reads as the grid the noise was meant to avoid.
    // This is the reason `SHAPE_SIZE` is sixty and not sixty-four.
    expect(SHAPE_SIZE % 2).toBe(0);
    expect(SHAPE_SIZE % 3 === 0 || SHAPE_SIZE % 5 === 0).toBe(true);
    expect(WEATHER_SIZE % 2).toBe(0);
    expect(WEATHER_SIZE % 3 === 0 || WEATHER_SIZE % 5 === 0).toBe(true);
  });

  it("has no octave ratio that is a power of two", () => {
    const ratios: number[] = [];
    for (const fieldSpec of FIELD_PERIODS) {
      for (let i = 1; i < fieldSpec.periods.length; i++) {
        ratios.push(fieldSpec.periods[i]! / fieldSpec.periods[i - 1]!);
      }
    }
    expect(ratios.length).toBeGreaterThan(10);
    for (const ratio of ratios) {
      expect(ratio === 1 || ratio === 2 || ratio === 4 || ratio === 8).toBe(
        false,
      );
    }
  });
});

describe("the noise is exactly periodic", () => {
  const sets: [
    string,
    NoiseSet,
    (s: NoiseSet, u: number, v: number, w: number) => number,
  ][] = [
    ["shape perlin", NOISE.shapePerlin, perlinFbm],
    ["shape worley", NOISE.shapeWorley, worleyFbm],
    ["detail 0", NOISE.detail[0]!, worleyFbm],
    ["detail 1", NOISE.detail[1]!, worleyFbm],
    ["detail 2", NOISE.detail[2]!, worleyFbm],
    ["coverage perlin", NOISE.coveragePerlin, perlinFbm],
    ["coverage worley", NOISE.coverageWorley, worleyFbm],
    ["curl stream", NOISE.streams, perlinFbm],
    ["streak", NOISE.streaks, perlinFbm],
  ];

  for (const [label, set, sample] of sets) {
    it(`repeats over the unit interval on every axis: ${label}`, () => {
      // Asserted on the noise rather than inferred from a baked texture. A
      // statistical comparison of the wrap step against an ordinary step gave a
      // false alarm here: it was comparing a step across a Worley feature point
      // with steps that mostly fell between them. This asks the question directly.
      let worst = 0;
      for (let i = 0; i < 600; i++) {
        // On a fractional offset, because the bake never samples at an integer.
        const u = i / 600 + 0.6180339887498949;
        const v = i / 400 + 0.317;
        const w = i / 300 + 0.721;
        const here = sample(set, u, v, w);
        worst = Math.max(
          worst,
          Math.abs(here - sample(set, u + 1, v, w)),
          Math.abs(here - sample(set, u, v + 1, w)),
          Math.abs(here - sample(set, u, v, w + 1)),
        );
      }
      expect(worst).toBeLessThan(1e-9);
    });
  }

  it("is signed-permuted between octaves, not merely mirrored", () => {
    // The permutation half of the swizzle was missing for a while, so every
    // octave was a sign flip of every other. A mirror maps the integer lattice
    // onto itself, which means a sign flip leaves an octave's features lying along
    // the very axes the swizzle exists to move them off.
    //
    // The observable consequence is that two octaves of different frequency stop
    // being the same field, which the decorrelation tests below check on the bake
    // as well. This checks it at the source, by confirming that the periods really
    // do divide their resolution once the swizzle is applied — the permutation is
    // what could have broken that.
    for (const set of sets.map(([, s]) => s)) {
      for (const octave of set.octaves) {
        expect(octave.period).toBeGreaterThan(0);
        expect(octave.swizzle).toHaveLength(6);
        for (const sign of [3, 4, 5]) {
          expect(Math.abs(octave.swizzle[sign]!)).toBe(1);
        }
        for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
          expect(octave.swizzle[axisIndex]).toBeGreaterThanOrEqual(0);
          expect(octave.swizzle[axisIndex]!).toBeLessThan(3);
        }
      }
    }
  });
});

describe("baking", () => {
  // The seed tests compare whole fields, and a full bake is two and a half seconds.
  // Seed behaviour is a property of the noise rather than of the resolution, so
  // these compare reduced bakes — which also keeps three extra full bakes out of a
  // suite that runs its files in parallel. The statistics tests further down still
  // use the full bake, because a resolution-dependent number proves nothing at 30³.
  const SMALL_SHAPE = 30;
  const SMALL_WEATHER = 60;
  const small = bakeCloudField(SEED, SMALL_SHAPE, SMALL_WEATHER);
  const smallAgain = bakeCloudField(SEED, SMALL_SHAPE, SMALL_WEATHER);
  const nextSeed = bakeCloudField(SEED + 1, SMALL_SHAPE, SMALL_WEATHER);
  const seedAfter = bakeCloudField(SEED + 2, SMALL_SHAPE, SMALL_WEATHER);

  const shareDiffering = (a: Uint8Array, b: Uint8Array): number => {
    let differing = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) differing++;
    }
    return differing / a.length;
  };

  const shapeBytes = (field: CloudField): Uint8Array => field.shape.data;
  const weatherBytes = (field: CloudField): Uint8Array => field.weather.data;

  it("is deterministic in its seed", () => {
    expect(Array.from(smallAgain.shape.data)).toEqual(
      Array.from(small.shape.data),
    );
    expect(Array.from(smallAgain.weather.data)).toEqual(
      Array.from(small.weather.data),
    );
  });

  it("gives a different sky for a different seed", () => {
    // One would not, if the seed reached only the resolved tables — those are
    // built once when the module loads and shared by every bake. Nor if a channel
    // simply forgot the offset: measured on an earlier version of this file, the
    // warp and the streak between them are half the weather map and neither looked
    // at the seed, so a quarter of every map was byte-identical between two seeds.
    // Two worlds with different weather and the same sky.
    expect(
      shareDiffering(shapeBytes(small), shapeBytes(nextSeed)),
    ).toBeGreaterThan(0.5);
    expect(
      shareDiffering(weatherBytes(small), weatherBytes(nextSeed)),
    ).toBeGreaterThan(0.5);
    for (let channel = 0; channel < 4; channel++) {
      expect(
        shareDiffering(
          channelOf(small.weather, channel),
          channelOf(nextSeed.weather, channel),
        ),
        `weather channel ${channel}`,
      ).toBeGreaterThan(0.3);
    }
  });

  it("keeps neighbouring seeds from producing near-identical skies", () => {
    // The offsets come from the first three terms of the `R2` low-discrepancy
    // sequence, which is what makes them well spread. A single irrational stride is
    // a one-dimensional sequence, so consecutive seeds land on consecutive offsets
    // and produce two skies that differ by a hair — the hardest kind of difference
    // to notice and the easiest to ship by accident.
    //
    // The bound here is the weak half and it is deliberately so: two different
    // seeds differing in nearly every byte is the expected result, not a warning
    // sign. What matters is the next test, which asks how *close* the values are
    // rather than how many of them differ.
    expect(
      shareDiffering(shapeBytes(nextSeed), shapeBytes(seedAfter)),
    ).toBeGreaterThan(0.5);
  });

  it("keeps two seeds from being within a few texels of each other", () => {
    // The same claim in the units the eye would notice.
    const texels = small.shape.data.length / 4;
    let close = 0;
    for (let i = 0; i < texels; i++) {
      const here = small.shape.data[i * 4]!;
      const there = nextSeed.shape.data[i * 4]!;
      if (Math.abs(here - there) <= 8) close++;
    }
    expect(close / texels).toBeLessThan(0.4);
  });

  it("produces the sizes it says it does", () => {
    expect(field.shape.size).toBe(SHAPE_SIZE);
    expect(field.shape.depth).toBe(SHAPE_SIZE);
    expect(field.weather.size).toBe(WEATHER_SIZE);
    expect(field.shape.data).toHaveLength(SHAPE_SIZE ** 3 * 4);
    expect(field.weather.data).toHaveLength(WEATHER_SIZE ** 2 * 4);
  });

  it("stays small enough to upload", () => {
    // Under a megabyte and a quarter, so the two `DataTexture`s are not something
    // the GPU has to think about.
    expect(field.shape.data.length).toBeLessThan(1.5 * 1024 * 1024);
    expect(field.weather.data.length).toBeLessThan(512 * 1024);
  });
});

describe("the shape volume", () => {
  const base = channelOf(field.shape, 0);
  const detail = [1, 2, 3].map((c) => channelOf(field.shape, c));

  it("uses its whole byte range", () => {
    // The Perlin-Worley dilate is a convex combination, and convex combinations
    // lose variance: it cancels where the two fields disagree, which is most of
    // the volume. This left ninety-two per cent of the base shape in the top half
    // of the range and under one per cent below 0.4 — a cloud with almost no
    // gradient for a coverage threshold to work against.
    expect(percentile(base, 0.01)).toBeLessThan(60);
    expect(percentile(base, 0.99)).toBeGreaterThan(190);
    expect(populatedDeciles(base)).toBeGreaterThanOrEqual(8);
  });

  it("varies in every direction, so it is a volume and not a stack of slices", () => {
    // A field that only varies along two axes reads as layered cardboard from
    // inside the slab, which is the single most obvious way for a 3D cloud field
    // to look wrong.
    const s = SHAPE_SIZE;
    const at = (x: number, y: number, z: number, c: number): number =>
      field.shape.data[((z * s + y) * s + x) * 4 + c]! / 255;
    for (const c of [0, 1, 2, 3]) {
      const steps: [number, number, number] = [0, 0, 0];
      let count = 0;
      for (let z = 0; z < s; z += 3) {
        for (let y = 0; y < s; y += 3) {
          for (let x = 0; x < s; x += 3) {
            steps[0] += Math.abs(at(x + 1, y, z, c) - at(x, y, z, c));
            steps[1] += Math.abs(at(x, y + 1, z, c) - at(x, y, z, c));
            steps[2] += Math.abs(at(x, y, z + 1, c) - at(x, y, z, c));
            count++;
          }
        }
      }
      for (const [axis, total] of steps.entries()) {
        expect(total / count, `channel ${c} axis ${axis}`).toBeGreaterThan(
          0.002,
        );
      }
    }
  });

  it("keeps the base shape and the detail uncorrelated", () => {
    // They are different fields at different frequencies. A detail channel
    // correlated with the base adds nothing: the erosion would be subtracting a
    // copy of the thing it is eroding.
    for (const channel of detail) {
      expect(Math.abs(correlation(base, channel))).toBeLessThan(0.2);
    }
  });

  it("keeps its three detail channels uncorrelated from each other", () => {
    // The regression guard for the swizzle bug. With every octave inheriting the
    // first entry of `SWIZZLE` — which is what happened, because both samplers
    // read the sign half of a permutation and ignored the axis half — the three
    // detail channels were three orientations of one lattice, and reading them as
    // three frequencies of it produced a cloud with no high-frequency detail at
    // all.
    expect(Math.abs(correlation(detail[0]!, detail[1]!))).toBeLessThan(0.15);
    expect(Math.abs(correlation(detail[1]!, detail[2]!))).toBeLessThan(0.15);
  });

  it("has three detail channels at three distinct frequencies", () => {
    expect(SHAPE_DETAIL_PERIODS).toHaveLength(3);
    expect(new Set(SHAPE_DETAIL_PERIODS).size).toBe(3);
    // Ascending, so channel order means increasing frequency and the shader can
    // reach for the coarsest one it can afford.
    for (let i = 1; i < SHAPE_DETAIL_PERIODS.length; i++) {
      expect(SHAPE_DETAIL_PERIODS[i]!).toBeGreaterThan(
        SHAPE_DETAIL_PERIODS[i - 1]!,
      );
    }
  });
});

describe("the weather map", () => {
  const coverage = channelOf(field.weather, 0);
  const curlX = channelOf(field.weather, 1);
  const curlY = channelOf(field.weather, 2);
  const streak = channelOf(field.weather, 3);

  it("has coverage across its whole range rather than a plateau", () => {
    // Coverage was first sampled as a flat slice of the shape field, and a
    // period-3 Worley on one plane has features a third of the tile across. The
    // result was a third of the map sitting at a constant 0.78 — a sky with a hard
    // edge and no weather in it. This is the guard.
    expect(percentile(coverage, 0.01)).toBeLessThan(70);
    expect(percentile(coverage, 0.99)).toBeGreaterThan(185);
    expect(populatedDeciles(coverage)).toBeGreaterThanOrEqual(8);
  });

  it("does not leave a large flat region", () => {
    // Directly, rather than through the histogram: a plateau is by definition a
    // large set of adjacent texels with almost the same value, and no
    // distributional summary of the whole field is guaranteed to see one.
    const w = WEATHER_SIZE;
    let flat = 0;
    let pairs = 0;
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const here = field.weather.data[(y * w + x) * 4]!;
        const right = field.weather.data[(y * w + ((x + 1) % w)) * 4]!;
        pairs++;
        if (Math.abs(here - right) <= 1) flat++;
      }
    }
    expect(flat / pairs).toBeLessThan(0.2);
  });

  it("centres the warp on no-warp and spreads it", () => {
    // Byte 128 is the convention the shader relies on: 0.5 means no displacement.
    for (const curl of [curlX, curlY]) {
      expect(mean(curl)).toBeGreaterThan(120);
      expect(mean(curl)).toBeLessThan(136);
      expect(percentile(curl, 0.05)).toBeLessThan(100);
      expect(percentile(curl, 0.95)).toBeGreaterThan(156);
    }
  });

  it("keeps the two warp axes independent", () => {
    // Both components of a curl come from one stream function, so they are
    // genuinely different functions of it rather than one function sampled twice.
    // A near-perfect correlation would mean the warp only pushes along a line.
    expect(Math.abs(correlation(curlX, curlY))).toBeLessThan(0.35);
  });

  it("makes the streak field streaked rather than blobby", () => {
    // The reason the stretch exists. A field that varied equally along both axes
    // would be another cloud shape, and it would be a cloud shape at the scale of
    // the map, which is the scale the map exists to break up.
    const w = WEATHER_SIZE;
    const along = (dx: number, dy: number): number => {
      let total = 0;
      let n = 0;
      for (let y = 8; y < w - 8; y += 4) {
        for (let x = 8; x < w - 8; x += 4) {
          const here = field.weather.data[(y * w + x) * 4 + 3]!;
          const next =
            field.weather.data[
              ((y + dy) * w + ((((x + dx) % w) + w) % w)) * 4 + 3
            ]!;
          total += Math.abs(here - next);
          n++;
        }
      }
      return total / n;
    };
    expect(along(0, 1)).toBeGreaterThan(along(1, 0));
  });

  it("stretches the streak by a whole number along each axis", () => {
    // The stretch scales the sample coordinate, so it has to be a whole number
    // for the field to repeat at the tile's edge. It was 0.35 and 2.4 once,
    // chosen because they looked like a good aspect ratio, and the wrap came back
    // thirty-six times the size of an ordinary step: a hard vertical line down the
    // one channel that decides where clouds are.
    for (const stretch of [STREAK_STRETCH_X, STREAK_STRETCH_Y]) {
      expect(Number.isInteger(stretch)).toBe(true);
      expect(stretch).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses the whole byte range on every channel", () => {
    for (const channel of [coverage, curlX, curlY, streak]) {
      expect(percentile(channel, 0.02)).toBeLessThan(90);
      expect(percentile(channel, 0.98)).toBeGreaterThan(170);
    }
  });
});

describe("the wrap reconstructs", () => {
  it("reconstructs the tile boundary as well as an ordinary texel boundary", () => {
    // The seam, measured the way it is actually seen. A linear filter
    // reconstructs between two texels; at the wrap it reconstructs between the
    // last texel and the first, and if the field is not periodic over the tile
    // those two are unrelated values. So: compare what the filter gives at the
    // wrap against what the field actually is, and compare that error against the
    // error at a texel boundary in the middle. If the tile is seamless the two
    // are the same size.
    const s = SHAPE_SIZE;
    const set = NOISE.detail[1]!;
    let atWrap = 0;
    let inside = 0;
    let count = 0;
    for (let z = 2; z < 8; z++) {
      for (let y = 5; y < 35; y++) {
        const v = (y + 0.5) / s;
        const w = (z + 0.5) / s;
        const first = worleyFbm(set, 0.5 / s, v, w);
        const last = worleyFbm(set, (s - 0.5) / s, v, w);
        // What the filter hands back at the tile's edge, and what the field is.
        atWrap += Math.abs((first + last) / 2 - worleyFbm(set, 1, v, w));

        const a = worleyFbm(set, (s / 2 - 0.5) / s, v, w);
        const b = worleyFbm(set, (s / 2 + 0.5) / s, v, w);
        inside += Math.abs((a + b) / 2 - worleyFbm(set, s / 2 / s, v, w));
        count++;
      }
    }
    expect(count).toBeGreaterThan(100);
    // Both are ordinary cell-boundary interpolation error, and neither is zero —
    // the filter does not know where the field's features are.
    expect(atWrap / count).toBeLessThan(0.2);
    expect(atWrap / count).toBeLessThan((inside / count) * 2 + 0.05);
  });
});

describe("erosion", () => {
  it("never returns more density than it was given", () => {
    // The property the ray-march's early-out depends on. Detail is applied as a
    // subtractive *bound* on the base shape, so a point where the base says no
    // cloud stays no cloud however the detail falls — which is what makes it safe
    // to skip the detail channels entirely wherever the base shape is zero.
    //
    // Neither published form supplies this. Skybolt's mean-stabilising remap
    // returns *more* than it was given about half the time: its output tracks an
    // S-curve through the base rather than the line, so a base of 0.8 with detail
    // of 0.5 comes back as 1.0. Horizon's original is subtractive but its output
    // is compressed into the middle of the range.
    for (let i = 0; i < 20000; i++) {
      const low = i / 20000;
      const high = ((i * 7919) % 20000) / 20000;
      expect(erosionOnlySubtracts(low, high)).toBe(true);
      expect(erosion(low, high)).toBeLessThanOrEqual(low + 1e-12);
    }
  });

  it("holds over the real baked field", () => {
    // Over actual pairs, not tidy ones.
    const texels = field.shape.data.length / 4;
    const changed = [0, 0, 0, 0];
    let violations = 0;
    let reduction = 0;
    for (let i = 0; i < texels; i++) {
      const low = field.shape.data[i * 4]! / 255;
      const high = field.shape.data[i * 4 + 1]! / 255;
      const eroded = erosion(low, high);
      if (eroded > low + 1e-12) violations++;
      if (eroded < low - 1e-9) changed[Math.min(3, Math.floor(low * 4))]!++;
      reduction += low - eroded;
    }
    expect(violations).toBe(0);

    // It has to be doing something. An erosion that returns its input is not
    // subtractive, it is absent.
    const acted = changed.reduce((a, b) => a + b, 0) / texels;
    expect(acted).toBeGreaterThan(0.15);
    expect(reduction / texels).toBeGreaterThan(0.02);

    // And it has to work on the *middle* of the base range and leave the dense
    // cores alone, which is what makes it edge erosion rather than a uniform tax.
    // A cloud's interior is its high values; eroding those punches holes in it.
    expect(changed[1]! / texels).toBeGreaterThan(changed[0]! / texels);
    expect(changed[1]! / texels).toBeGreaterThan((changed[3]! / texels) * 3);
  });

  it("carves the gaps between billows and keeps the billow tops", () => {
    // The direction, which is the part that is easy to get backwards, and which
    // was wrong here first.
    //
    // `high` is one of this volume's detail channels, and those are **inverted**
    // Worley: high at a feature point, which is the middle of a billow. Both
    // published erosion forms erase *most where the detail is lower*, and for this
    // field that is correct — the gaps between billows are what an edge is carved
    // out of, and cutting them is what turns one smooth blob into a ragged edge.
    //
    // Negating the detail so that "high erodes more" reads like the obvious rule is
    // the wrong version, and it is plausible enough to have been written on
    // purpose: it erases the billow tops, which punches a hole through the middle
    // of every dense core. The rule is not "which end erodes more" but "which end
    // of *this* field is the gap", and that depends on whether the field was
    // inverted.
    for (const base of [0.3, 0.5, 0.8]) {
      // A gap — detail at its lowest — takes a real bite out of the cloud. Not all
      // of it, and not at every softness: the remap's window is `softness` wide, so
      // a base sitting above that window only loses the part of itself that hangs
      // over it. At the default a base of 0.8 loses 37%, and it loses all of itself
      // at a softness below about a quarter. What must hold is that it bites, and
      // that it bites harder than anywhere else.
      const carved = erosion(base, 0);
      expect(base - carved, `base ${base} at a gap`).toBeGreaterThan(
        base * 0.3,
      );
      // A billow centre — detail at its highest — leaves it completely alone.
      expect(erosion(base, 1), `base ${base} at a billow`).toBeCloseTo(base, 9);
    }
  });

  it("erodes more as the detail falls, and never more than the base", () => {
    for (const base of [0.1, 0.2, 0.3, 0.4, 0.6, 0.8]) {
      let previous = Infinity;
      for (const detail of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const removed = base - erosion(base, detail);
        // Non-increasing in the detail: less detail is more gap is more carving.
        // It saturates rather than keeping rising, because the clamp stops it at
        // the base once the remap's window has passed the whole of it.
        expect(removed, `base ${base} detail ${detail}`).toBeLessThanOrEqual(
          previous,
        );
        previous = removed;
      }
      // And the effect spans the range rather than being a rounding difference
      // between two no-ops.
      expect(previous, `base ${base}`).toBeLessThan(0.1);
    }
  });

  it("sits closer to the base than either published form does", () => {
    // Skybolt's clamp is not only safe, it is the most faithful of the three.
    // Measured over uniformly random pairs, mean absolute deviation from the base:
    // Horizon's original 0.250, Skybolt's raw remap 0.200, this 0.100.
    let deviation = 0;
    let count = 40000;
    for (let i = 0; i < count; i++) {
      const low = ((i * 2654435761) % 100000) / 100000;
      const high = ((i * 40503) % 100000) / 100000;
      deviation += Math.abs(erosion(low, high) - low);
    }
    expect(deviation / count).toBeLessThan(0.12);
  });

  it("keeps the output inside 0..1 for anything at all", () => {
    for (const low of [-1, 0, 0.5, 1, 2]) {
      for (const high of [-1, 0, 0.5, 1, 2]) {
        const out = erosion(low, high);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is the identity at both ends of the softness range", () => {
    // Not an edge width, and not monotone: `softness` is the fraction of the
    // remap's range the detail fills, and erosion peaks near a half and vanishes at
    // both ends. Both ends being the identity is worth pinning, because a caller
    // who reads the name as "how soft is the edge" and reaches for 1 gets erosion
    // switched off rather than turned up.
    for (const low of [0.1, 0.5, 0.9]) {
      for (const high of [0.1, 0.5, 0.9]) {
        expect(erosion(low, high, 0)).toBeCloseTo(low, 9);
        expect(erosion(low, high, 1)).toBeCloseTo(low, 9);
      }
    }
  });

  it("takes a softness outside 0..1 without dividing by zero", () => {
    // The degenerate cases, reachable from a caller tuning the edge.
    expect(Number.isFinite(erosion(0.5, 0.5, -1))).toBe(true);
    expect(Number.isFinite(erosion(0.5, 0.5, 5))).toBe(true);
    expect(erosion(0.5, 0.5, 0)).toBeCloseTo(0.5, 9);
  });
});

describe("the small helpers", () => {
  it("clamps", () => {
    expect(saturate(-1)).toBe(0);
    expect(saturate(0.5)).toBe(0.5);
    expect(saturate(2)).toBe(1);
  });

  it("has enough curl octaves to build a field out of", () => {
    // Four is what takes the warp off the shape volume's own grid; two would give
    // a single smooth displacement that bends the tile rather than scrambling it.
    expect(CURL_PERIODS.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * What one full bake costs.
 *
 * A ceiling rather than a benchmark, for the reason `src/csg/cost.test.ts` is: the
 * failure worth catching is a change that looks harmless and costs ten times as much,
 * not a number that drifts.
 *
 * Measured on an ARM phone: **2.4 s** for the production pair, which is the number that
 * is why the bake now runs in a worker at all (`cloud-bake-worker.ts`) — it used to be
 * two and a half seconds of frozen page, and a worker is the answer to that rather than
 * a smaller field. A warm bake on the same phone is about a second, because the first
 * one is dominated by the JIT compiling the noise for the first time.
 *
 * The ceiling is ten times the measurement, which is far too loose to be a claim about
 * any machine and is deliberate on two counts. It has to hold wherever it runs, and this
 * one runs at 2.4 s on its own and longer as part of a suite that runs its files in
 * parallel, so a time-based assertion measures the machine's willingness to serve four
 * threads as much as it measures this code. Set near the measurement it fails on a slow
 * runner; set near the target it fails on the machine doing the measuring.
 *
 * What it is for is catching a *change*, and those are factors of ten.
 */
const BAKE_BUDGET_MS = 24000;

describe("what a bake costs", () => {
  it("bakes both production fields inside the budget", () => {
    // A small bake first, so the measurement is not dominated by the JIT's first pass
    // through the noise. The warm-up is the same code at a different resolution —
    // `bakeCloudField`'s sizes are parameters, so nothing is warmed by it that the full
    // bake does not also exercise.
    bakeCloudField(SEED, 30, 60);

    const started = performance.now();
    const baked = bakeCloudField(SEED);
    const elapsed = performance.now() - started;

    // Reported whether or not the assertion passes, so a regression shows its
    // magnitude rather than only that it happened.
    const texels = baked.shape.data.length / 4 + baked.weather.data.length / 4;
    console.log(
      `full bake: ${texels.toLocaleString()} texels in ${elapsed.toFixed(0)} ms ` +
        `(${((elapsed * 1000) / texels).toFixed(2)} us/texel)`,
    );

    // The bake is the only thing in the sky built on the host, and the field it
    // produces is what every other assertion in this file is about — so a bake that
    // returned nothing would satisfy a timing test and no other.
    expect(baked.shape.data).toHaveLength(SHAPE_SIZE ** 3 * 4);
    expect(elapsed).toBeLessThan(BAKE_BUDGET_MS);
  });

  it("spends its time on texels, not on setup", () => {
    // The invariant behind the ceiling: a bake is `size³` independent evaluations of
    // the noise over tables resolved once when the module loaded, so its cost is a
    // function of its resolutions and nothing else. The noise tables, the gradient
    // tables and the seed offsets are all resolved at import — so a second bake is
    // already paying nothing for them, and a bake at a fraction of the resolutions
    // should cost a fraction of the time.
    //
    // A tenth of the shape's texels (30³ against 60³) and a quarter of the weather's
    // (60² against 240²) is a bit over a third of the work. The allowance is loose
    // because both measurements are taken under a suite running four threads: what is
    // being caught is a bake that stopped scaling with its own resolution — a table
    // rebuilt per texel, an octave recomputed per channel — which is a multiple of ten,
    // not a few per cent.
    const timeOf = (shapeSize: number, weatherSize: number): number => {
      const started = performance.now();
      bakeCloudField(SEED, shapeSize, weatherSize);
      return performance.now() - started;
    };

    timeOf(30, 60); // warm, as above
    const small = timeOf(30, 60);
    const full = timeOf(SHAPE_SIZE, WEATHER_SIZE);

    console.log(
      `a 30³/60² bake took ${small.toFixed(0)} ms against ${full.toFixed(0)} ms ` +
        `for 60³/240²`,
    );
    expect(small).toBeLessThan(full * 0.6);
  });
});
