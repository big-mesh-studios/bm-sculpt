/**
 * The cube-to-sphere map, at the twelve places it can be discontinuous.
 *
 * ## Why this file exists
 *
 * `cube-face.ts` carried a comment saying a test checked all twelve cube edges. **No such test
 * existed.** The claim that the map is continuous across an edge was asserted in prose and
 * verified nowhere, and it is the single property the whole cube-sphere plan rests on: a
 * discontinuity at any edge is a crack in the finished planet running from pole to pole along
 * one of twelve lines — and because terrain is a function of the *direction*, a direction that
 * jumps by even a thousandth of a radian is a cliff about two units high.
 *
 * Continuity is therefore measured rather than assumed, at three levels:
 *
 * 1. **The cube points agree.** Two faces meeting at an edge must name the same point of the
 *    cube. That is a convention question and it fails loudly if a sign is wrong.
 * 2. **The directions agree.** Warp and normalise are smooth, so this follows from (1) — and it
 *    is checked separately because a warp bug and a convention bug look identical from outside.
 * 3. **The terrain agrees.** `radiusAt` sampled on both sides of every edge. This is the
 *    property that decides whether there is a crack, and no direction-only test establishes it.
 *
 * ## How the edges are enumerated
 *
 * A cube edge is two fixed axes with two signs, and a free third axis: `C(3,2)·2·2 = 12` of
 * them. They are **generated, not listed**, and the per-edge parameter correspondence is obtained
 * by inverting `cubePointAt` rather than by solving twelve cases by hand. Listing them would have
 * been the same class of mistake this file exists to catch — twelve hand-derived signs, one of
 * which is wrong in a way that only shows up as a hairline crack from orbit.
 */

import { describe, expect, it } from "vitest";

import {
  FACE_COUNT,
  cubePointAt,
  directionAt,
  faceOf,
  type Direction,
} from "./cube-face";
import { DEFAULT_PLANET, planetField } from "./planet";

const AXES = ["x", "y", "z"] as const;
type Axis = 0 | 1 | 2;

/** The face for an axis and a sign: `+X` is 0, `-X` is 1, `+Y` is 2, and so on. */
const faceFor = (axis: Axis, sign: number): number =>
  axis * 2 + (sign > 0 ? 0 : 1);

/**
 * The `(u, v)` on a face that names a given cube point — the exact inverse of `cubePointAt`.
 *
 * Read off the convention rather than searched for, because it is six cases and each is one
 * line, and because `faceOf` already encodes the same six and the test that the two agree is
 * worth more than a numeric search would be.
 */
const paramsOf = (face: number, c: Direction): readonly [number, number] => {
  switch (face) {
    case 0:
      return [-c.z, -c.y];
    case 1:
      return [c.z, -c.y];
    case 2:
      return [c.x, c.z];
    case 3:
      return [c.x, -c.z];
    case 4:
      return [c.x, -c.y];
    default:
      return [-c.x, -c.y];
  }
};

/** One cube edge: two faces, and the axis that runs along it. */
interface Edge {
  readonly faces: readonly [number, number];
  readonly free: Axis;
  /** Where on the cube the edge is, along the free axis, for a given parameter. */
  readonly pointAt: (t: number) => Direction;
}

/** All twelve edges, generated. */
const edges = (): readonly Edge[] => {
  const out: Edge[] = [];
  for (let a = 0 as Axis; a < 3; a = (a + 1) as Axis) {
    for (let b = (a + 1) as Axis; b < 3; b = (b + 1) as Axis) {
      const free = (3 - a - b) as Axis;
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const faces = [faceFor(a, sa), faceFor(b, sb)] as const;
          out.push({
            faces,
            free,
            pointAt: (t) => {
              const c: Direction = { x: 0, y: 0, z: 0 };
              c[AXES[a]] = sa;
              c[AXES[b]] = sb;
              c[AXES[free]] = t;
              return c;
            },
          });
        }
      }
    }
  }
  return out;
};

const EDGES = edges();
const STEPS = 9;

describe("the cube faces", () => {
  it("generates exactly twelve edges, no duplicates", () => {
    expect(EDGES).toHaveLength(12);
    const keys = new Set(
      EDGES.map((e) => {
        const c = e.pointAt(0);
        return `${[...e.faces].sort().join("/")}:${c.x},${c.y},${c.z}`;
      }),
    );
    expect(keys.size).toBe(12);
  });

  it("inverts its own convention exactly", () => {
    // `paramsOf` is what the edge correspondence below is built on, so it is checked against
    // `cubePointAt` over the whole face before being relied on.
    for (let face = 0; face < FACE_COUNT; face++) {
      for (let i = -3; i <= 3; i++) {
        for (let j = -3; j <= 3; j++) {
          const u = i / 3;
          const v = j / 3;
          const [pu, pv] = paramsOf(face, cubePointAt(face, u, v));
          const label = `face ${face} at (${u}, ${v})`;
          expect(pu, label).toBeCloseTo(u, 12);
          expect(pv, label).toBeCloseTo(v, 12);
        }
      }
    }
  });

  it("names the same cube point from both sides of every edge", () => {
    for (const edge of EDGES) {
      for (let i = 0; i <= STEPS; i++) {
        const t = -1 + (2 * i) / STEPS;
        const c = edge.pointAt(t);
        for (const face of edge.faces) {
          const [u, v] = paramsOf(face, c);
          const got = cubePointAt(face, u, v);
          const label = `face ${face} on edge ${edge.faces.join("/")} at ${t}`;
          expect(got.x, label).toBeCloseTo(c.x, 12);
          expect(got.y, label).toBeCloseTo(c.y, 12);
          expect(got.z, label).toBeCloseTo(c.z, 12);
        }
      }
    }
  });

  it("maps every face parameter to a unit direction", () => {
    for (let face = 0; face < FACE_COUNT; face++) {
      for (let i = -4; i <= 4; i++) {
        for (let j = -4; j <= 4; j++) {
          const d = directionAt(face, i / 4, j / 4);
          const label = `face ${face} at (${i / 4}, ${j / 4})`;
          expect(Math.hypot(d.x, d.y, d.z), label).toBeCloseTo(1, 12);
          expect(Number.isFinite(d.x + d.y + d.z), label).toBe(true);
        }
      }
    }
  });

  it("gives both sides of every edge the same direction", () => {
    for (const edge of EDGES) {
      for (let i = 0; i <= STEPS; i++) {
        const t = -1 + (2 * i) / STEPS;
        const c = edge.pointAt(t);
        const [au, av] = paramsOf(edge.faces[0], c);
        const [bu, bv] = paramsOf(edge.faces[1], c);
        const a = directionAt(edge.faces[0], au, av);
        const b = directionAt(edge.faces[1], bu, bv);
        const label = `faces ${edge.faces.join("/")} at ${t}`;
        // **Twelve places, and the tolerance is not arbitrary.** A direction error of `1e-9` is a
        // height error of about `1.7e-6` units on the default planet — far below what the terrain
        // can express — so this only fails on a genuine discontinuity.
        expect(a.x, label).toBeCloseTo(b.x, 11);
        expect(a.y, label).toBeCloseTo(b.y, 11);
        expect(a.z, label).toBeCloseTo(b.z, 11);
      }
    }
  });

  it("agrees on all eight corners, where three faces meet", () => {
    // **The case an edge test alone misses.** Three faces meet at each corner, so a sign error
    // can leave every *edge* consistent while the corner is wrong: the map would agree with
    // itself pairwise and still have a hole where the three meet.
    const planet = planetField(DEFAULT_PLANET);
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const corner: Direction = { x: sx, y: sy, z: sz };
          const label = `corner ${sx},${sy},${sz}`;
          // Every face that contains this corner must name it, and they are the three whose axis
          // matches the corner's dominant component — found by asking each face for the corner's
          // own cube point rather than by assuming which three they are.
          const onFace: number[] = [];
          for (let face = 0; face < FACE_COUNT; face++) {
            const [u, v] = paramsOf(face, corner);
            const p = cubePointAt(face, u, v);
            if (
              Math.abs(p.x - corner.x) < 1e-9 &&
              Math.abs(p.y - corner.y) < 1e-9 &&
              Math.abs(p.z - corner.z) < 1e-9
            ) {
              onFace.push(face);
            }
          }
          // Three faces meet at every corner of a cube. Not two, not four: if this is ever
          // something else the edge enumeration above is wrong and every count here is fiction.
          expect(onFace, label).toHaveLength(3);

          const first = directionAt(
            onFace[0]!,
            ...paramsOf(onFace[0]!, corner),
          );
          const radius = planet.radiusAt(first);
          for (const face of onFace.slice(1)) {
            const d = directionAt(face, ...paramsOf(face, corner));
            const label2 = `${label} face ${face} vs ${onFace[0]}`;
            expect(d.x, label2).toBeCloseTo(first.x, 11);
            expect(d.y, label2).toBeCloseTo(first.y, 11);
            expect(d.z, label2).toBeCloseTo(first.z, 11);
            // And the terrain there is one height, not three.
            expect(planet.radiusAt(d), label2).toBeCloseTo(radius, 6);
          }
        }
      }
    }
  });
});

describe("the terrain on the cube faces", () => {
  it("is continuous across every edge", () => {
    // **The property that decides whether there is a crack in the planet.**
    //
    // Terrain is `radiusAt(direction)`, so a direction off by `δ` is a height off by about
    // `1660 · δ`. A hairline crack two units deep is invisible underfoot and a visible line from
    // orbit — which is the only altitude at which the planet is ever seen as a whole.
    const planet = planetField(DEFAULT_PLANET);
    let worst = 0;
    let worstWhere = "";

    for (const edge of EDGES) {
      for (let i = 0; i <= STEPS; i++) {
        const t = -1 + (2 * i) / STEPS;
        const c = edge.pointAt(t);
        const a = directionAt(edge.faces[0], ...paramsOf(edge.faces[0], c));
        const b = directionAt(edge.faces[1], ...paramsOf(edge.faces[1], c));
        const gap = Math.abs(planet.radiusAt(a) - planet.radiusAt(b));
        if (gap > worst) {
          worst = gap;
          worstWhere = `faces ${edge.faces.join("/")} at ${t}`;
        }
        expect(gap, `faces ${edge.faces.join("/")} at ${t}`).toBeLessThan(0.1);
      }
    }
    console.log(
      `[cube-face] worst terrain step across all twelve edges: ` +
        `${worst.toExponential(2)} units (worst at ${worstWhere})`,
    );
    expect(worst).toBeLessThan(0.1);
  });

  it("puts the surface in the same place on either side of an edge, in world units", () => {
    // **The same continuity in the units the mesher will work in.** A direction can agree to
    // twelve decimals while the surface point does not, and the surface point is where vertices
    // land and where two patches have to share one.
    const planet = planetField(DEFAULT_PLANET);
    for (const edge of EDGES) {
      for (let i = 0; i <= STEPS; i++) {
        const t = -1 + (2 * i) / STEPS;
        const c = edge.pointAt(t);
        const a = directionAt(edge.faces[0], ...paramsOf(edge.faces[0], c));
        const b = directionAt(edge.faces[1], ...paramsOf(edge.faces[1], c));
        const ra = planet.radiusAt(a);
        const rb = planet.radiusAt(b);
        const label = `faces ${edge.faces.join("/")} at ${t}`;
        expect(a.x * ra, label).toBeCloseTo(b.x * rb, 6);
        expect(a.y * ra, label).toBeCloseTo(b.y * rb, 6);
        expect(a.z * ra, label).toBeCloseTo(b.z * rb, 6);
      }
    }
  });

  it("covers the whole sphere once, with no face's interior overlapping another's", () => {
    // **A direction must belong to exactly one face**, or a patch address is ambiguous and two
    // patches will be built for the same ground. Sampled on a fine grid of directions, each
    // resolved by `faceOf`, and every direction must resolve to the face whose interior it is in.
    const planet = planetField(DEFAULT_PLANET);
    let mismatches = 0;
    const n = 60;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // A direction from a cube-face sweep, which is the distribution patches actually live in.
        const face = i % FACE_COUNT;
        const u = -1 + (2 * Math.floor(i / FACE_COUNT)) / (n / FACE_COUNT - 1);
        const v = -1 + (2 * j) / (n - 1);
        if (Math.abs(u) === 1 || Math.abs(v) === 1) continue;
        const d = directionAt(face, u, v);
        if (faceOf(d).face !== face) mismatches++;
        // And the surface point is finite and at a sane radius, which is what makes it a place.
        const r = planet.radiusAt(d);
        if (
          !Number.isFinite(r) ||
          r < planet.lowestRadius ||
          r > planet.highestRadius
        ) {
          mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
  });
});
