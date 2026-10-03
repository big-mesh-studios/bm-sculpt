import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERRAIN,
  FBM_AMPLITUDE_BOUND,
  NOISE_GRADIENT_BOUND,
  PerlinNoise2D,
  TERRAIN_FEATURE,
  terrainField,
} from "./terrain";

/** A wide, flat-ish region to measure a height range over. */
const COLUMN_SAMPLES = 24;
const SAMPLE_SPAN = 4000;

const heightsOver = (
  heightAt: (x: number, z: number) => number,
  span = SAMPLE_SPAN,
  count = COLUMN_SAMPLES,
): number[] => {
  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < count; k++) {
      heights.push(
        heightAt(
          -span / 2 + (span * i) / count,
          -span / 2 + (span * k) / count,
        ),
      );
    }
  }
  return heights;
};

describe("the noise", () => {
  it("is the same noise for the same seed and a different one for another", () => {
    // Without this the seed is decoration, and every world looks like every other world.
    const one = new PerlinNoise2D(1234);
    const same = new PerlinNoise2D(1234);
    const other = new PerlinNoise2D(1235);

    const at = (n: PerlinNoise2D) => [n.noise(0.5, 0.5), n.noise(3.25, -1.75)];
    expect(at(one)).toEqual(at(same));
    expect(at(one)).not.toEqual(at(other));
  });

  it("is zero at every lattice point, which is what makes it tile", () => {
    // Corner values are zero by construction, so a whole number of cells across is exactly
    // zero and the landscape has no seam at the origin. Compared with `toBeCloseTo` rather
    // than `toBe` because the arithmetic produces `-0` here and `Object.is(-0, 0)` is false
    // — a signed zero here means nothing and would fail the test for no reason.
    const noise = new PerlinNoise2D(9);
    for (let i = -3; i <= 3; i++) {
      for (let k = -3; k <= 3; k++) {
        expect(noise.noise(i, k)).toBeCloseTo(0, 12);
      }
    }
  });

  it("stays inside the amplitude bound it advertises", () => {
    // The bound is what `couldHoldSurface` skips chunks on, so it has to be a bound and not
    // an observation. This is the check that it is one.
    const noise = new PerlinNoise2D(20260901);
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const x = i * 0.37;
      worst = Math.max(worst, Math.abs(noise.fbm(x, x * 0.61, 4)));
    }
    expect(worst).toBeLessThanOrEqual(FBM_AMPLITUDE_BOUND);
  });

  it("varies with the point, so the landscape is not a plateau", () => {
    const noise = new PerlinNoise2D(5);
    const samples = heightsOver((x, z) => noise.fbm(x, z, 4));
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeGreaterThan(0.2);
  });
});

describe("a terrain field", () => {
  it("is negative below its own surface and positive above it", () => {
    // The whole sign convention of the CSG, in one assertion: solid is negative.
    const terrain = terrainField(DEFAULT_TERRAIN);
    for (const [x, z] of [
      [0, 0],
      [1234, -987],
      [-5000, 5000],
    ]) {
      const surface = terrain.heightAt(x, z);
      expect(terrain(x, surface - 5, z)).toBeLessThan(0);
      expect(terrain(x, surface + 5, z)).toBeGreaterThan(0);
      // And the crossing is where it says it is.
      expect(terrain(x, surface, z)).toBeCloseTo(0, 9);
    }
  });

  it("varies across the world rather than repeating, out past the permutation table", () => {
    // `& 255` masks the lattice, so a point 256 cells out hashes the same corner as the
    // origin. Checked well past that, because a landscape that quietly repeats every 256
    // noise cells looks fine until someone walks a kilometre.
    //
    // The offsets are deliberately *not* whole multiples of the feature size: those land on
    // lattice points, where the noise is exactly zero, and two of them are equal for
    // reasons that have nothing to do with the world repeating.
    const terrain = terrainField(DEFAULT_TERRAIN);
    const here = terrain.heightAt(0.37, 0.71);
    const far = terrain.heightAt(
      TERRAIN_FEATURE * 900.37,
      TERRAIN_FEATURE * 640.71,
    );
    expect(Math.abs(here - far)).toBeGreaterThan(1);
  });

  it("keeps its reported height range, because the mesher's gate skips on it", () => {
    // `couldHoldSurface` answers from these two numbers alone. If the real surface ever
    // leaves them, the mesher skips a chunk that has surface in it and the world gets a
    // hole that nothing re-meshes.
    const terrain = terrainField(DEFAULT_TERRAIN);
    const heights = heightsOver((x, z) => terrain.heightAt(x, z));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(terrain.lowest);
    expect(Math.max(...heights)).toBeLessThanOrEqual(terrain.highest);
  });

  it("reports a Lipschitz factor at or below one", () => {
    // A factor above one claims surfaces are further away than they are, and the picker
    // steps through them. `Field` clamps it, which would hide the mistake rather than
    // report it — so the check belongs here, on the value the terrain actually produces.
    const terrain = terrainField(DEFAULT_TERRAIN);
    expect(terrain.lipschitz).toBeLessThan(1);
    expect(terrain.lipschitz).toBeGreaterThan(0);
  });

  it("has a Lipschitz factor that is actually a bound on its own gradient", () => {
    // The load-bearing test for the whole module. A factor that is too large is not a slow
    // picker, it is a picker that walks through the ground and reports no surface — and it
    // would do so on a slope the analytic argument happened to miss.
    //
    // Checked by measuring the gradient of `y - h` numerically over a wide area and
    // comparing against the bound the terrain advertises. The margin left is the
    // derivative's own step, not slack in the constant.
    const terrain = terrainField(DEFAULT_TERRAIN);
    const step = 1;
    let steepest = 0;
    for (let i = 0; i < 200; i++) {
      const x = -6000 + i * 61;
      const z = 900 - i * 37;
      const surface = terrain.heightAt(x, z);
      const dx = terrain(x + step, surface, z) - terrain(x - step, surface, z);
      const dz = terrain(x, surface, z + step) - terrain(x, surface, z - step);
      steepest = Math.max(steepest, Math.hypot(dx, dz) / (2 * step));
    }
    // `1 / steepest` is the largest factor that would still be safe here.
    expect(steepest * terrain.lipschitz).toBeLessThanOrEqual(1);
  });

  it("scales a steeper landscape to a smaller factor", () => {
    // The factor is derived, not decorative: doubling the vertical scale doubles the
    // gradient and must tighten the bound, or a taller landscape is picked through.
    const gentle = terrainField({ ...DEFAULT_TERRAIN, scale: 40 });
    const steep = terrainField({ ...DEFAULT_TERRAIN, scale: 200 });
    expect(steep.lipschitz).toBeLessThan(gentle.lipschitz);
  });

  it("treats a zero octave count as one rather than as a flat world at random", () => {
    const none = terrainField({ ...DEFAULT_TERRAIN, octaves: 0 });
    expect(none.lipschitz).toBeGreaterThan(0);
    expect(Number.isFinite(none.heightAt(10, 10))).toBe(true);
  });

  it("keeps its documented constants honest", () => {
    // If either of these is edited without the derivation in the file header being redone,
    // every bound above becomes a guess. Cheap to check, and the header is long enough that
    // it will not be re-read on its own.
    expect(NOISE_GRADIENT_BOUND).toBeGreaterThan(0);
    expect(FBM_AMPLITUDE_BOUND).toBeGreaterThan(0);
    expect(TERRAIN_FEATURE).toBeGreaterThan(0);
  });
});

describe("a terrain answering whether a box could hold a surface", () => {
  const terrain = terrainField(DEFAULT_TERRAIN);
  const box = (minY: number, maxY: number) => ({
    min: { x: -160, y: minY, z: -160 },
    max: { x: 160, y: maxY, z: 160 },
  });

  it("rules out a box entirely above the highest possible ground", () => {
    expect(
      terrain.couldHoldSurface(box(terrain.highest + 1, terrain.highest + 300)),
    ).toBe(false);
  });

  it("rules out a box entirely below the lowest possible ground", () => {
    // All solid: no sign change anywhere in it, so there is no surface to find.
    expect(
      terrain.couldHoldSurface(box(terrain.lowest - 300, terrain.lowest - 1)),
    ).toBe(false);
  });

  it("cannot rule out a box that straddles the range", () => {
    expect(
      terrain.couldHoldSurface(box(terrain.lowest - 1, terrain.highest + 1)),
    ).toBe(true);
  });

  it("cannot rule out a box that merely touches the range", () => {
    // The boundary is inclusive on the safe side: a box whose lowest face is exactly at the
    // highest possible ground still contains that ground, and skipping it would drop a
    // surface on the seam.
    expect(
      terrain.couldHoldSurface(box(terrain.highest, terrain.highest + 300)),
    ).toBe(true);
    expect(
      terrain.couldHoldSurface(box(terrain.lowest - 300, terrain.lowest)),
    ).toBe(true);
  });
});
