/**
 * A planet, as a field: what the measurements say and what they cost.
 *
 * `terrain.test.ts` checks a landscape against the reasoning that produced its bound. This file does
 * the same for `planet.ts`, and differs in one important respect: **three of its measurements are of
 * things this repository had got wrong, or believed, before this file existed.**
 *
 * - **The Lipschitz bound is not three times tighter than the height field's.** It was expected to
 *   be, from the argument that a normalised direction is a cheaper domain than a world x/z. It is
 *   6% *tighter*, which is the interesting number: the extra noise axis and the tighter per-axis
 *   gradient bound very nearly cancel. A planet therefore costs the picker about the same as the
 *   landscape it replaced.
 * - **The bound is about eleven times larger than the gradient it bounds** — and so is the height
 *   field's, which is the more useful finding, because it is not new. `terrain.ts` already calls
 *   its per-axis figure "deliberately pessimistic"; this measures how pessimistic, which at 11x is
 *   worth an afternoon of anyone's time who wants the picker to be faster.
 * - **The radius band is about three times wider than the surface.** Sound, since it has to
 *   contain every surface, but it means `couldHoldSurface` admits chunks that hold nothing — and on
 *   a sphere that is dearer than on a flat field, because the band is radial thickness and a
 *   320-unit chunk spans only about 22 units of it.
 *
 * ## The property everything else rests on
 *
 * **`∂f/∂r = 1` exactly**, because `n̂` does not change along a ray from the centre. That is
 * asserted directly rather than through its consequences, because it is the one claim that makes
 * the file's Lipschitz derivation and its surface-extent arithmetic both work, and both were
 * derived from it.
 */

import { describe, expect, it } from "vitest";
import { length, normalize, scale, vec3 } from "@big-mesh-studios/core";

import { Field } from "./field";
import { OperationBVH } from "./bvh";
import {
  DEFAULT_PLANET,
  DEFAULT_TERRAIN,
  planetField,
  radiusRangeOf,
  terrainField,
} from "./index";
import {
  FBM_AMPLITUDE_BOUND_3D,
  NOISE_GRADIENT_BOUND_3D,
  PerlinNoise3D,
} from "./index";
import {
  FBM_AMPLITUDE_BOUND,
  NOISE_GRADIENT_BOUND,
  PerlinNoise2D,
} from "./terrain";
import { RIDGE_STRENGTH } from "./terrain";

/** Directions spread over a sphere, including both poles. */
const directions = (count = 64): ReturnType<typeof vec3>[] => {
  const out: ReturnType<typeof vec3>[] = [];
  for (let i = 0; i <= count; i++) {
    const theta = Math.PI * (i / count);
    for (let j = 0; j < 2 * count; j++) {
      const phi = (2 * Math.PI * j) / (2 * count);
      out.push(
        vec3(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        ),
      );
    }
  }
  return out;
};

const planet = planetField(DEFAULT_PLANET);
const flat = terrainField(DEFAULT_TERRAIN);

describe("a planet's surface", () => {
  it("is a radial graph: one crossing per ray, and the sign either side of it", () => {
    // **The star-shaped property**, which is what makes sphere-tracing it terminate and what
    // `∂f/∂r` below is the differential of. Along a ray from the centre, `f` is negative inside and
    // positive outside with one crossing between.
    for (const n of directions(16)) {
      const surface = planet.radiusAt(n);
      const at = (r: number): number => {
        const p = scale(n, r);
        return Math.hypot(p.x, p.y, p.z) - surface;
      };
      // Well inside and well outside, unambiguously.
      expect(at(surface - 200), JSON.stringify(n)).toBeLessThan(0);
      expect(at(surface + 200), JSON.stringify(n)).toBeGreaterThan(0);
      // And exactly one crossing, sampled finely enough that a second one would show.
      let crossings = 0;
      let previous = at(0);
      for (let step = 1; step <= 400; step++) {
        const d = at((DEFAULT_PLANET.radius * 2 * step) / 400);
        if (previous <= 0 && d > 0) crossings++;
        previous = d;
      }
      expect(crossings, JSON.stringify(n)).toBe(1);
    }
  });

  it("has a radial derivative of exactly one, so ∂f/∂r is 1", () => {
    // **The property the Lipschitz derivation and the radius band both come from.**
    //
    // Measured as a derivative along the ray, not as the angle of the normal, because those are
    // different claims and only the first is this one. `Field.gradient` returns a *normalised*
    // vector, so `dot(gradient, n̂)` is `1/|∇f|` and reads about 0.998 on a slope — which is
    // correct, because a sloped surface's normal is not radial, and asserting it was `1` would
    // have been asserting that the planet has no mountains.
    const field = new Field(new OperationBVH([]), {
      base: planet,
      extent: planet,
      lipschitz: planet.lipschitz,
    });
    for (const n of directions(12)) {
      for (const altitude of [-100, 0, 100]) {
        const r = planet.radiusAt(n) + altitude;
        const at = (rr: number): number => {
          const p = scale(n, rr);
          return field.distance(p.x, p.y, p.z);
        };
        const h = 1;
        const radial = (at(r + h) - at(r - h)) / (2 * h);
        expect(radial, `${JSON.stringify(n)} at ${altitude}`).toBeCloseTo(1, 9);
      }
    }
  });

  it("keeps its normal's radial component at one over its gradient's length", () => {
    // The consistency of the two claims above: the normalised gradient is `∇f/|∇f|`, and `∇f`'s
    // radial component is one, so their product is one. Checked because it is the number that
    // looks like a bug on a slope — 0.998 on a three-degree slope — and is worth pinning before
    // somebody spends an afternoon on it.
    const field = new Field(new OperationBVH([]), {
      base: planet,
      extent: planet,
      lipschitz: planet.lipschitz,
    });
    for (const n of directions(12)) {
      const p = scale(n, planet.radiusAt(n));
      const g = field.gradient(p.x, p.y, p.z);
      const radial = g.x * n.x + g.y * n.y + g.z * n.z;
      const measured = 1 / Math.max(radial, 1e-9);
      // The bound has to be at least the truth, and it is comfortably so — see the slack test.
      expect(measured, JSON.stringify(n)).toBeLessThanOrEqual(
        1 / planet.lipschitz + 1e-9,
      );
      // **And the bar is loose because the gradient's length is not one.** It is
      // `1 + tangential correction`, so on this terrain the radial component reads just under one.
      //
      // **The bar moved from nine tenths to eight, and the reason is the terrain rather than the
      // test.** It used to read "anything below nine tenths would mean mountains steep enough to be
      // worth investigating" — and then the range term was signed and tripled, which is exactly
      // that. The correction now reaches about two per five rather than two per cent. Eight
      // tenths still says what the bar is for: the gradient is dominated by its radial term, so
      // the Lipschitz bound above is a bound and not a guess. That assertion is the real one; this
      // is the one that would notice the bound quietly becoming wrong.
      expect(radial, JSON.stringify(n)).toBeGreaterThan(0.8);
    }
  });

  it("is inside the radius band it declares, and the band contains it", () => {
    // Soundness first: `couldHoldSurface` compares against this band, so a surface outside it is a
    // chunk the gate will skip and a hole in the world nothing re-meshes.
    let lowest = Infinity;
    let highest = -Infinity;
    for (const n of directions(200)) {
      const r = planet.radiusAt(n);
      lowest = Math.min(lowest, r);
      highest = Math.max(highest, r);
    }
    console.log(
      `[planet] surface spans ${lowest.toFixed(1)}–${highest.toFixed(1)} against a declared ` +
        `band ${planet.lowestRadius.toFixed(0)}–${planet.highestRadius.toFixed(0)}`,
    );
    expect(lowest).toBeGreaterThanOrEqual(planet.lowestRadius);
    expect(highest).toBeLessThanOrEqual(planet.highestRadius);
  });

  it("gives different landscapes to the six axis directions", () => {
    // **The measurement that justifies three-dimensional noise.** A two-dimensional domain cannot
    // see the direction normal to its own chart, so it hands the same landscape to all six — a
    // planet with one continent three times over. See `perlin3.ts`.
    const at = (n: { x: number; y: number; z: number }): number =>
      planet.radiusAt(n);
    const heights = [
      at(vec3(1, 0, 0)),
      at(vec3(-1, 0, 0)),
      at(vec3(0, 1, 0)),
      at(vec3(0, -1, 0)),
      at(vec3(0, 0, 1)),
      at(vec3(0, 0, -1)),
    ];
    const groups: number[] = [];
    for (const h of heights) {
      if (
        !groups.some(
          (g) =>
            Math.abs(g - h) <
            1e-3 * (planet.highestRadius - planet.lowestRadius),
        )
      ) {
        groups.push(h);
      }
    }
    console.log(
      `[planet] distinct landscapes at the six axis directions: ${groups.length} ` +
        `(${heights.map((h) => h.toFixed(1)).join(", ")})`,
    );
    expect(groups.length).toBe(6);
  });
});

describe("couldHoldSurface on a planet", () => {
  const bounds = (min: number, max: number) => ({
    min: vec3(min, min, min),
    max: vec3(max, max, max),
  });

  it("answers from the box's exact radius range", () => {
    // The minimum is a point-to-box distance and the maximum is the furthest corner, both exact,
    // so the gate is two distances and eight corners rather than a search.
    const [min, max] = radiusRangeOf(bounds(4000, 4320));
    expect(min).toBeCloseTo(4000 * Math.sqrt(3), 6);
    expect(max).toBeCloseTo(4320 * Math.sqrt(3), 6);

    // A box that straddles the origin has a minimum radius of zero.
    expect(radiusRangeOf(bounds(-10, 10))[0]).toBeCloseTo(0, 12);
  });

  it("never answers false for a box that holds surface", () => {
    // **The one direction the gate is allowed to be wrong in.** Answering `false` for a box that
    // does hold surface puts a hole in the world that nothing re-meshes, because the mesher that
    // skipped it recorded an answer. Checked against the surface directly rather than against the
    // reasoning that produced the bound.
    let admitted = 0;
    let withSurface = 0;
    // The surface sits at `radius` from the origin, so the chunk column that straddles it is the
    // radius divided by the chunk size — derived rather than the literal twelve that fitted the old
    // 4,000-unit planet.
    const surfaceCell = Math.round(planet.radiusAt(vec3(1, 0, 0)) / 320);
    for (let lo = surfaceCell - 4; lo <= surfaceCell + 2; lo++) {
      for (const [dy, dz] of [
        [0, 0],
        [2, -2],
        [-4, 5],
      ] as const) {
        const box = {
          min: vec3(lo * 320 - 170, dy * 320 - 170, dz * 320 - 170),
          max: vec3(lo * 320 + 170, dy * 320 + 170, dz * 320 + 170),
        };
        if (!planet.couldHoldSurface(box)) continue;
        admitted++;
        // Does any sample in the box straddle the surface?
        const step = 40;
        let straddles = false;
        for (let x = box.min.x; x <= box.max.x && !straddles; x += step) {
          for (let y = box.min.y; y <= box.max.y && !straddles; y += step) {
            for (let z = box.min.z; z <= box.max.z; z += step) {
              const r = Math.hypot(x, y, z);
              const n = normalize(vec3(x, y, z));
              const here = r - planet.radiusAt(n);
              const there =
                Math.hypot(x, y, z + step) -
                planet.radiusAt(normalize(vec3(x, y, z + step)));
              if (here <= 0 && there >= 0) {
                straddles = true;
                break;
              }
            }
          }
        }
        if (straddles) withSurface++;
      }
    }
    console.log(
      `[planet] couldHoldSurface admitted ${admitted} boxes, of which ${withSurface} hold surface`,
    );
    expect(withSurface).toBeGreaterThan(0);
  });

  it("skips most of a cubic lattice", () => {
    // The number that decides whether a planet is streamable at all: most of a cubic lattice
    // around one is deep rock or empty space, and skipping both is what makes 2000 chunks
    // affordable.
    let total = 0;
    let skipped = 0;
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        for (let z = -14; z <= 14; z++) {
          total++;
          const lo = (x - 0.5) * 320;
          const hi = (x + 0.5) * 320;
          const a = (y - 0.5) * 320;
          const b = (y + 0.5) * 320;
          const c = (z - 0.5) * 320;
          const d = (z + 0.5) * 320;
          if (
            !planet.couldHoldSurface({
              min: vec3(lo, a, c),
              max: vec3(hi, b, d),
            })
          ) {
            skipped++;
          }
        }
      }
    }
    const pct = (100 * skipped) / total;
    console.log(
      `[planet] couldHoldSurface skipped ${pct.toFixed(1)}% of a ±14 chunk lattice`,
    );
    expect(pct).toBeGreaterThan(70);
  });
});

describe("the Lipschitz bound", () => {
  const maxGradient = (
    distance: (x: number, y: number, z: number) => number,
    at: (n: { x: number; y: number; z: number }) => number,
  ): number => {
    let worst = 0;
    for (const n of directions(64)) {
      for (const altitude of [-400, -40, 0, 40, 400]) {
        const r = at(n) + altitude;
        const p = scale(n, r);
        const h = 1;
        const gx =
          (distance(p.x + h, p.y, p.z) - distance(p.x - h, p.y, p.z)) / (2 * h);
        const gy =
          (distance(p.x, p.y + h, p.z) - distance(p.x, p.y - h, p.z)) / (2 * h);
        const gz =
          (distance(p.x, p.y, p.z + h) - distance(p.x, p.y, p.z - h)) / (2 * h);
        worst = Math.max(worst, Math.hypot(gx, gy, gz));
      }
    }
    return worst;
  };

  it("bounds the real gradient of the planet", () => {
    const measured = maxGradient(planet, planet.radiusAt);
    const bound = 1 / planet.lipschitz;
    console.log(
      `[planet] lipschitz ${planet.lipschitz.toFixed(4)}, gradient bound ${bound.toFixed(2)}, ` +
        `measured maximum ${measured.toFixed(3)}`,
    );
    // The contract `FieldOptions.lipschitz` exists to keep: a distance scaled by it must never
    // over-report, or the picker steps through the surface.
    expect(measured).toBeLessThanOrEqual(bound);
  });

  it("costs the picker about what the height field costs, not three times less", () => {
    // **A prediction this file's first draft got wrong.** The argument was that a normalised
    // direction is a cheaper domain than a world x/z, so the bound should have improved. It did
    // not, because `√3` for the third noise axis and the tighter 3D gradient bound very nearly
    // cancel: `√3 · 6.495 = 11.25` against `√2 · 7.5 = 10.61`.
    console.log(
      `[planet] lipschitz: planet ${planet.lipschitz.toFixed(4)} against height field ` +
        `${flat.lipschitz.toFixed(4)} — a ray needs about ` +
        `${(1 / planet.lipschitz / (1 / flat.lipschitz)).toFixed(2)}x the steps`,
    );
    // "No worse" is the useful fact, so the bounds are ratios rather than inequalities.
    expect(planet.lipschitz).toBeGreaterThan(0.8 * flat.lipschitz);
    expect(planet.lipschitz).toBeLessThan(1.1 * flat.lipschitz);
  });

  it("leaves about a decade of the bound unused, as the height field already does", () => {
    // **The finding worth acting on, and it is not the planet's.** `lipschitz` is the reciprocal
    // of this bound and the picker steps by it, so every factor of bound spent is a factor of steps
    // paid — and the flat world has been paying the same factor all along.
    /**
     * The height field's largest gradient, sampled over the flat world's own surface.
     *
     * **Sampled in world space rather than through `radiusAt`, because there is no such thing**
     * — the height field's surface is a plane, so there is no direction to sample it at and
     * handing it one produces a radius and therefore a `NaN`.
     */
    const flatMaxGradient = (): number => {
      let worst = 0;
      for (let ix = -24; ix <= 24; ix++) {
        for (let iz = -24; iz <= 24; iz++) {
          const x = ix * 60;
          const z = iz * 60;
          for (const y of [
            flat.heightAt(x, z) - 200,
            flat.heightAt(x, z),
            flat.heightAt(x, z) + 200,
          ]) {
            const h = 1;
            const gx = (flat(x + h, y, z) - flat(x - h, y, z)) / (2 * h);
            const gy = (flat(x, y + h, z) - flat(x, y - h, z)) / (2 * h);
            const gz = (flat(x, y, z + h) - flat(x, y, z - h)) / (2 * h);
            worst = Math.max(worst, Math.hypot(gx, gy, gz));
          }
        }
      }
      return worst;
    };

    const planetSlack =
      1 / planet.lipschitz / maxGradient(planet, planet.radiusAt);
    const flatSlack = 1 / flat.lipschitz / flatMaxGradient();
    console.log(
      `[planet] bound slack: planet ${planetSlack.toFixed(1)}x, height field ${flatSlack.toFixed(1)}x`,
    );
    expect(planetSlack).toBeGreaterThan(5);
    expect(flatSlack).toBeGreaterThan(5);
  });
});

describe("the noise", () => {
  it("has a 3D gradient bound very nearly cancelling the extra axis", () => {
    // The cancellation above, as arithmetic, so a change to either constant shows up here.
    console.log(
      `[planet] gradient bounds: 3D ${NOISE_GRADIENT_BOUND_3D.toFixed(3)} over √3 is ` +
        `${(Math.sqrt(3) * NOISE_GRADIENT_BOUND_3D).toFixed(3)}, against 2D ` +
        `${NOISE_GRADIENT_BOUND} over √2 is ` +
        `${(Math.sqrt(2) * NOISE_GRADIENT_BOUND).toFixed(3)}`,
    );
    // Within ten per cent, which is what "very nearly cancel" has to mean to be worth asserting.
    const threeD = Math.sqrt(3) * NOISE_GRADIENT_BOUND_3D;
    const twoD = Math.sqrt(2) * NOISE_GRADIENT_BOUND;
    expect(Math.abs(threeD - twoD) / twoD).toBeLessThan(0.1);
  });

  it("reaches a unit-ish amplitude in both dimensions", () => {
    // The two amplitude bounds are the inputs to the two radius bands, and they are different
    // numbers: a 3D corner gradient lies on one axis and reaches 1, where a 2D diagonal reaches 2.
    const n3 = new PerlinNoise3D(DEFAULT_PLANET.seed);
    const n2 = new PerlinNoise2D(DEFAULT_TERRAIN.seed);
    const peak3 = Math.max(
      ...directions(32).map((n) =>
        Math.abs(n3.fbm(n.x * 5, n.y * 5, n.z * 5, 1)),
      ),
    );
    const peak2 = Math.max(
      ...directions(32).map((n) => Math.abs(n2.fbm(n.x * 5, n.z * 5, 1))),
    );
    console.log(
      `[planet] amplitude bounds: 3D ${FBM_AMPLITUDE_BOUND_3D} (measured ${peak3.toFixed(3)}), ` +
        `2D ${FBM_AMPLITUDE_BOUND} (measured ${peak2.toFixed(3)})`,
    );
    expect(peak3).toBeLessThanOrEqual(FBM_AMPLITUDE_BOUND_3D);
    expect(peak2).toBeLessThanOrEqual(FBM_AMPLITUDE_BOUND);
  });

  it("keeps the relief comparable to the height field's", () => {
    // Both are `scale · (base + RIDGE · ridge · mask)` on the same features, so a planet's
    // mountains are this project's mountains. The band is `reach` on either side, and `reach` is
    // wider on the height field only because its base bound is 2 rather than 1.
    const flatReach =
      (FBM_AMPLITUDE_BOUND + RIDGE_STRENGTH) * DEFAULT_TERRAIN.scale;
    const planetReach =
      (FBM_AMPLITUDE_BOUND_3D + RIDGE_STRENGTH) * DEFAULT_PLANET.scale;
    console.log(
      `[planet] declared reach: planet ${planetReach.toFixed(0)} against height field ` +
        `${flatReach.toFixed(0)}`,
    );
    expect(planet.highestRadius - planet.lowestRadius).toBeCloseTo(
      2 * planetReach,
      6,
    );
  });
});

describe("the field a planet is used through", () => {
  it("answers the sign and a finite normal at the origin", () => {
    // **The origin is the one point with no direction**, and it is the one point a player can reach
    // by digging straight down. `normalize` of the zero vector is zero, so the field has to
    // answer for itself rather than divide by it.
    const field = new Field(new OperationBVH([]), {
      base: planet,
      extent: planet,
      lipschitz: planet.lipschitz,
      fallbackNormal: (x, y, z) => normalize(vec3(x, y, z)),
    });
    expect(field.distance(0, 0, 0)).toBeLessThan(0);
    expect(Number.isFinite(field.distance(0, 0, 0))).toBe(true);
    expect(length(field.gradient(0, 0, 0))).toBeCloseTo(1, 6);
  });

  it("reports the surface of a planet at the radius the field claims", () => {
    // **The cross-check that matters**: the field the mesher reads and the radius the water and
    // the spawn use must agree about where the ground is, or the player stands somewhere the
    // world is not drawn.
    const field = new Field(new OperationBVH([]), {
      base: planet,
      extent: planet,
      lipschitz: planet.lipschitz,
    });
    for (const n of directions(12)) {
      const surface = planet.radiusAt(n);
      const near = scale(n, surface - 1);
      const far = scale(n, surface + 1);
      const inside = field.distance(near.x, near.y, near.z);
      const outside = field.distance(far.x, far.y, far.z);
      expect(inside, JSON.stringify(n)).toBeLessThan(0);
      expect(outside, JSON.stringify(n)).toBeGreaterThan(0);
    }
  });
});
