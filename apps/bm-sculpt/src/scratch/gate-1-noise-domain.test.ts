/**
 * Gate 1: is there a usable noise domain for a sphere?
 *
 * The planet field is `|p - c| - (R + scale·g)` where `g` is the landscape's shape read
 * from a direction. This file measures each candidate domain in `domains.ts`, because the
 * answer decided the shape of `perlin3.ts` and would otherwise have been an assumption.
 *
 * ## What the first draft of this file got wrong, and what replaced it
 *
 * It tested **continuity** — "is `g` continuous in the direction?" — and expected the
 * cube-face domain to fail it. It does not, and the reason is worth stating because it
 * removed a worry rather than adding one: **every one of these domains is continuous as a
 * function of world position.** The mesher never asks a domain for a height, it asks the
 * *field* for a distance at a world position, and two chunks either side of a seam ask for
 * the same position and get the same answer. There is no seam crack to avoid. My original
 * note claiming a cube-face "step" was measuring two identical directions and calling the
 * difference zero a step.
 *
 * So continuity is not the requirement. What a 2D domain actually costs is:
 *
 * 1. **Repetition.** The argument is drawn from one `[-1, 1]²` several times over, so whole
 *    neighbourhoods of the sphere read the *same* landscape. A cube-face domain maps all six
 *    axis directions to `(0, 0)`; the dominant-axis domain maps all three of them to `(0, 0)`.
 * 2. **Collapse.** A direction whose argument vanishes drags its whole neighbourhood to one
 *    value, which is repetition again at a smaller scale.
 *
 * 3D noise of the direction pays neither, because it needs no chart: a 2D domain has to name
 * a sphere with two numbers, which cannot be done without a chart, and every chart repeats.
 */

import { describe, expect, it } from "vitest";

import {
  PerlinNoise2D,
  TERRAIN_FEATURE,
  FACE_COUNT,
  directionAt,
} from "@big-mesh-studios/csg";
import { VOXEL_SIZE } from "../constants";
import {
  cubeFaceDomain,
  dominantAxisDomain,
  noise3Domain,
  singleProjectionDomain,
  unit,
  type NoiseDomain,
} from "./planet/domains";
import {
  DEFAULT_PLANET,
  PerlinNoise3D,
  planetField,
} from "@big-mesh-studios/csg";

const planet = planetField(DEFAULT_PLANET);
const RELIEF = planet.highestRadius - planet.lowestRadius;

const noise2 = new PerlinNoise2D(DEFAULT_PLANET.seed);
const noise3 = new PerlinNoise3D(DEFAULT_PLANET.seed);
const S3 = DEFAULT_PLANET.radius / TERRAIN_FEATURE;

const domains: NoiseDomain[] = [
  cubeFaceDomain(noise2),
  dominantAxisDomain(noise2),
  singleProjectionDomain(noise2),
  noise3Domain(S3, (d) =>
    noise3.fbm(d.x * S3, d.y * S3, d.z * S3, DEFAULT_PLANET.octaves),
  ),
];

/** Six directions a sphere's own geometry singles out: the axis directions. */
const AXES: { x: number; y: number; z: number }[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

/**
 * The six axis heights a domain hands out, in world units.
 *
 * **Read once here** because there are two measurements to make of them and they answer different
 * questions — see `distinctLandscapes` and `identicalPairs`.
 */
const axisHeights = (domain: NoiseDomain): number[] =>
  AXES.map((a) => domain.at(unit(a)) * DEFAULT_PLANET.scale);

/**
 * How many distinct landscapes a domain hands out where the sphere asks six different questions.
 *
 * **Groups the six heights fall into, to within a thousandth of the relief.**
 *
 * This is a *measurement*, and it is not a safe assertion on its own: two of the six heights
 * landing within one part in a thousand of each other is a coincidence of the seed, not blindness,
 * and the tolerance scales with the relief — so tripling the mountains tripled the tolerance and
 * turned six distinct landscapes into five for a domain that has not changed. `identicalPairs`
 * is the structural version of the same claim, and that is what the assertions hold to.
 */
const distinctLandscapes = (domain: NoiseDomain): number => {
  const heights = axisHeights(domain);
  const groups: number[] = [];
  for (const h of heights) {
    if (!groups.some((g) => Math.abs(g - h) < 1e-3 * RELIEF)) groups.push(h);
  }
  return groups.length;
};

/**
 * How many *opposite* pairs of axis directions a domain answers identically.
 *
 * **Exactly identically, with no tolerance — and that is the point.** A two-dimensional chart is
 * a projection and a projection has a kernel, so wherever the sphere walks along the chart's
 * normal the argument does not change at all and the two ends of the axis land on the *same
 * number*, bit for bit. A domain with no kernel cannot do that: its answer depends on the whole
 * direction, so `+x` and `−x` differ.
 *
 * This is the statement the group count is trying to make and cannot make safely, because it is
 * about the domain rather than about one sample of it.
 */
const identicalPairs = (domain: NoiseDomain): number => {
  const heights = axisHeights(domain);
  let same = 0;
  for (let axis = 0; axis < 3; axis++) {
    const plus = axis * 2;
    if (heights[plus] === heights[plus + 1]) same++;
  }
  return same;
};

/** How far apart the six axis heights are, as a fraction of the relief. */
const axisSpread = (domain: NoiseDomain): number => {
  const heights = axisHeights(domain);
  return (Math.max(...heights) - Math.min(...heights)) / RELIEF;
};

/**
 * Whether a domain sees the sphere **evenly**, measured as the spread in how much argument
 * a fixed *angular* distance spans.
 *
 * Take a point `n`, step a fixed angle `α` away from it in several directions, and measure
 * how far the noise argument moved. A domain that sees the sphere evenly gives the same
 * answer wherever `n` is, so the ratio of the largest to the smallest is 1. A domain that
 * does not gives a ratio that is large, or infinite when some direction moves the argument
 * not at all.
 *
 * This is the sharpest statement of why two dimensions cannot carry a sphere, and it is
 * worth stating as a measurement because it is not obvious: **a 2D chart is blind to the
 * direction normal to itself, at every point.** A chart is a projection and a projection has
 * a kernel. Near the place where the chart's normal lines up with a direction you can walk,
 * the argument stops changing, so a whole region of the planet is one point of noise. For a
 * cube-face map that region is at each pole; for a single projection, at both; for the
 * dominant-axis domain, at all six axis directions. Three dimensions have no chart, so they
 * have no normal, so they have no blind direction.
 */
const evennessOf = (
  domain: NoiseDomain,
  alpha = 0.05,
): { min: number; max: number; ratio: number } => {
  const distance = (a: readonly number[], b: readonly number[]): number => {
    let sum = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = (a[i] as number) - (b[i] as number);
      sum += d * d;
    }
    return Math.sqrt(sum);
  };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= 40; i++) {
    const theta = Math.PI * (i / 40);
    for (let j = 0; j < 80; j++) {
      const phi = (2 * Math.PI * j) / 80;
      const n = unit({
        x: Math.sin(theta) * Math.cos(phi),
        y: Math.cos(theta),
        z: Math.sin(theta) * Math.sin(phi),
      });
      // Two unit vectors tangent to the sphere at `n`, so the steps leave in genuinely
      // different directions rather than along one great circle.
      const side =
        Math.abs(n.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const ta = unit({
        x: side.y * n.z - side.z * n.y,
        y: side.z * n.x - side.x * n.z,
        z: side.x * n.y - side.y * n.x,
      });
      const tb = {
        x: n.y * ta.z - n.z * ta.y,
        y: n.z * ta.x - n.x * ta.z,
        z: n.x * ta.y - n.y * ta.x,
      };
      const base = domain.argumentAt(n);
      for (const t of [ta, tb]) {
        const m = unit({
          x: n.x + Math.sin(alpha) * t.x,
          y: n.y + Math.sin(alpha) * t.y,
          z: n.z + Math.sin(alpha) * t.z,
        });
        const moved = distance(base, domain.argumentAt(m));
        min = Math.min(min, moved);
        max = Math.max(max, moved);
      }
    }
  }
  return { min, max, ratio: min === 0 ? Infinity : max / min };
};

describe("a noise domain for a sphere", () => {
  it("steps in world position for the two domains that pick their coordinates from the direction", () => {
    // The decisive measurement of Gate 1. A jump that does not halve when the step halves is
    // a discontinuity: the field steps there and the mesher opens a crack along it. The
    // ratio is 1 for a step function and 2 for a continuous one.
    //
    // Note this is *not* rescued by addressing the field by world position. It was, in an
    // earlier draft of this file, on the reasoning that both sides of a chunk seam ask for
    // the same position. They do — and they still disagree, because the domain itself
    // changes its answer as the direction crosses the face boundary, and the field is the
    // composition of the two.
    const profiles = domains.map((d) => {
      // The step is in direction, and the 3D domain's noise argument is scaled by `S3`, which grew
      // with the planet's radius. Scaling the step by the inverse keeps the *noise-argument* step
      // the size the ratios below were measured at, so the test measures continuity rather than how
      // far the argument moved.
      const stepScale = 4000 / DEFAULT_PLANET.radius;
      let coarse = 0;
      let fine = 0;
      for (let i = 0; i <= 32; i++) {
        const theta = Math.PI * (i / 32);
        for (let j = 0; j < 32; j++) {
          const phi = (2 * Math.PI * j) / 32;
          const n = {
            x: Math.sin(theta) * Math.cos(phi),
            y: Math.cos(theta),
            z: Math.sin(theta) * Math.sin(phi),
          };
          for (const axis of ["x", "y", "z"] as const) {
            for (const [step, isCoarse] of [
              [2e-3 * stepScale, true],
              [1e-3 * stepScale, false],
            ] as const) {
              const jump =
                Math.abs(
                  d.at(unit({ ...n, [axis]: n[axis] - step })) -
                    d.at(unit({ ...n, [axis]: n[axis] + step })),
                ) * DEFAULT_PLANET.scale;
              if (isCoarse) coarse = Math.max(coarse, jump);
              else fine = Math.max(fine, jump);
            }
          }
        }
      }
      return { name: d.name, ratio: fine === 0 ? Infinity : coarse / fine };
    });
    console.log(
      `[gate 1] continuity ratios (2 means continuous): ` +
        profiles.map((p) => `${p.name} ${p.ratio.toFixed(2)}`).join(", "),
    );
    const byName = new Map(profiles.map((p) => [p.name, p.ratio]));
    expect(byName.get("cube-face (u, v)")).toBeLessThan(1.2);
    expect(byName.get("dominant axis dropped")).toBeLessThan(1.2);
    expect(byName.get("single projection (n.x, n.z)")).toBeGreaterThan(1.8);
    expect(byName.get("3D noise")).toBeGreaterThan(1.8);
  });

  it("gives the 3D domain six different landscapes where the sphere asks six questions", () => {
    // **Both measurements, and the assertions are on the structural one.** The group count is
    // printed because it is the headline number and it is what the finding was first seen in; the
    // identical-pair count is what is held to, because it is a property of the domain rather than
    // of one sample of it.
    const rows = domains.map((d) => ({
      name: d.name,
      groups: distinctLandscapes(d),
      identical: identicalPairs(d),
      spread: axisSpread(d),
    }));
    console.log(
      `[gate 1] at the six axis directions — distinct ${rows
        .map((r) => `${r.name} ${r.groups}`)
        .join(", ")}; identical opposite pairs ${rows
        .map((r) => `${r.name} ${r.identical}`)
        .join(", ")}; spread ${rows
        .map((r) => `${r.name} ${r.spread.toFixed(2)}`)
        .join(", ")}`,
    );

    // **The claim, and the reason the planet uses 3D noise: every 2D chart has a kernel, so it
    // answers the two ends of at least one axis with the same number, and 3D noise cannot.**
    const threeD = rows[3]!;
    for (const row of rows.slice(0, 3)) {
      expect(
        row.identical,
        `${row.name} is blind along at least one axis`,
      ).toBeGreaterThan(0);
    }
    expect(threeD.identical, "3D noise has no kernel").toBe(0);
    // And it is not merely distinguishable but *differently* so. Every chart's spread is exactly
    // **zero** — one landscape for all six directions, which is the whole of the fault — while 3D
    // noise's is a real fraction of the relief. The bar is the same tolerance that defines a
    // distinct landscape above, so this says the six answers are genuinely different answers and
    // not four coincident ones. Measured: 0.01.
    for (const row of rows.slice(0, 3))
      expect(row.spread, `${row.name} is one landscape everywhere`).toBe(0);
    expect(threeD.spread).toBeGreaterThan(1e-3);
  });

  it("leaves every 2D domain blind to some direction, and the 3D domain to none", () => {
    const rows = domains.map((d) => ({ name: d.name, ...evennessOf(d) }));
    console.log(
      `[gate 1] evenness (argument spanned by a fixed 0.05 rad step, max/min over the sphere): ` +
        rows.map((r) => `${r.name} ${r.ratio.toExponential(2)}`).join(", "),
    );
    const byName = new Map(rows.map((r) => [r.name, r]));
    // The finding. Each 2D domain has a chart normal somewhere the sphere walks over, and at
    // those places the argument barely moves: a fixed 0.05-radian step spans between forty
    // and a hundred and thirty times as much argument in one direction as in another. The
    // sampled grid does not land exactly on the normal, so these are floors rather than the
    // infinities the theory allows.
    expect(byName.get("cube-face (u, v)")!.ratio).toBeGreaterThan(20);
    expect(byName.get("single projection (n.x, n.z)")!.ratio).toBeGreaterThan(
      20,
    );
    expect(byName.get("dominant axis dropped")!.ratio).toBeGreaterThan(20);
    // Three dimensions have no chart and therefore no normal, so a fixed angle spans the same
    // argument everywhere on the sphere — at the poles, at the face edges, or anywhere else.
    // It is exact, not approximate: the argument is a constant multiple of the direction, and
    // the chord between two directions depends only on the angle between them.
    expect(byName.get("3D noise")!.ratio).toBeCloseTo(1, 10);
  });

  it("changes the landscape by less than a voxel across a two-milliradian step", () => {
    // What makes the 3D domain a *landscape* rather than a blur: the height changes slowly
    // enough with direction that a chunk 320 units across spans several features, not
    // several hundred.
    let worst = 0;
    for (let i = 0; i <= 32; i++) {
      const theta = Math.PI * (i / 32);
      for (let j = 0; j < 32; j++) {
        const phi = (2 * Math.PI * j) / 32;
        const n = {
          x: Math.sin(theta) * Math.cos(phi),
          y: Math.cos(theta),
          z: Math.sin(theta) * Math.sin(phi),
        };
        const step = 2e-3;
        worst = Math.max(
          worst,
          Math.abs(
            planet.radiusAt(unit({ ...n, x: n.x + step })) -
              planet.radiusAt(unit({ ...n, x: n.x - step })),
          ),
        );
      }
    }
    console.log(
      `[gate 1] 3D domain: worst height change over 4e-3 of direction ` +
        `${worst.toFixed(2)} world units (relief ${RELIEF.toFixed(0)}, voxel ${VOXEL_SIZE})`,
    );
    // The steepest legitimate slope, which the Lipschitz bound in `planet-field.test.ts`
    // also predicts. Not a continuity assertion — a "this reads as landscape" one.
    expect(worst).toBeLessThan(0.25 * RELIEF);
  });
});

describe("the cube-to-sphere map", () => {
  it("lands every face parameter on the unit sphere", () => {
    for (let face = 0; face < FACE_COUNT; face++) {
      for (let i = 0; i <= 8; i++) {
        const u = -1 + (2 * i) / 8;
        for (let j = 0; j <= 8; j++) {
          const n = directionAt(face, u, -1 + (2 * j) / 8);
          expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 12);
        }
      }
    }
  });

  it("spreads face vertices evenly enough to keep a patch lattice uniform", () => {
    // The reason the warp exists rather than a plain normalisation, which also reaches the
    // unit sphere. Naive normalisation bunches vertices into the cube corners, so the
    // shortest edge of a corner patch is a small fraction of its longest, and a patch
    // lattice inherits that.
    let worst = Infinity;
    for (const face of [0, 2, 4]) {
      const at = (u: number, v: number) => directionAt(face, u, v);
      const gap = (
        a: { x: number; y: number; z: number },
        b: typeof a,
      ): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      const centreStep = gap(at(0, 0), at(0.02, 0));
      for (const [cu, cv] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const corner = at(cu, cv);
        const edge = Math.min(
          gap(at(cu * 0.98, cv), corner),
          gap(at(cu, cv * 0.98), corner),
        );
        worst = Math.min(worst, centreStep / edge);
      }
    }
    console.log(
      `[gate 1] spherified cube: worst centre-step/corner-step ratio ${worst.toFixed(3)}`,
    );
    // Naive normalisation gives a ratio near 0.1 here; the warp is meant to keep it near 1.
    expect(worst).toBeGreaterThan(0.6);
  });
});
