/**
 * The baked maps, measured.
 *
 * ## Why this file exists
 *
 * The maps are what a planet looks like from far enough away that the streamed chunks stop resolving
 * detail, so an error in them is not a subtle shading mistake — it is a planet that is the wrong
 * shape or the wrong colour, seen from the one altitude at which the whole thing is visible.
 *
 * Two properties matter and both are checked here rather than on screen:
 *
 * 1. **The round trip is exact.** A direction and its texel must find each other, because the bake
 *    walks texels and the shader walks directions, and a mismatch shows up as a planet whose
 *    terrain is smeared rather than as an error.
 * 2. **The height map's range is the field's.** If the byte encoding does not span exactly the
 *    planet's relief, the sphere's radius is a constant that disagrees with the chunks beside it —
 *    which is the one artefact the swap cannot hide.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PLANET, planetField } from "./planet";
import {
  bakePlanetMaps,
  directionAtEquirect,
  equirectAtDirection,
} from "./planet-maps";
import type { Rgb8 } from "@big-mesh-studios/core";

const field = planetField(DEFAULT_PLANET);

const flatColour = {
  colourAt: () => ({ colour: { r: 190, g: 186, b: 176 } as Rgb8, opacity: 1 }),
};

describe("the equirectangular mapping", () => {
  it("round-trips a direction through its texel", () => {
    // **Exact, not approximate.** The bake walks texels and the shader walks directions, so if these
    // two disagree by a texel the planet's terrain is smeared — and a smear is invisible in a unit
    // test and unmissable on a globe.
    for (const [u, v] of [
      [0.5, 0.5],
      [0.25, 0.25],
      [0.75, 0.75],
      [0.1, 0.9],
      [0.5, 0.02],
      [0.99, 0.98],
      [0.33, 0.66],
    ] as const) {
      const d = directionAtEquirect(u, v);
      const back = equirectAtDirection(d);
      // One part in `width`, which is the most a sampler can resolve anyway.
      expect(back[0], `u at ${u},${v}`).toBeCloseTo(u, 5);
      expect(back[1], `v at ${u},${v}`).toBeCloseTo(v, 5);
    }
  });

  it("puts the poles where the map puts them", () => {
    // v = 0 is the north pole and v = 1 the south, and the shader's inverse assumes exactly that.
    const north = directionAtEquirect(0.5, 0);
    expect(north.y).toBeCloseTo(1, 6);
    const south = directionAtEquirect(0.5, 1);
    expect(south.y).toBeCloseTo(-1, 6);
  });

  it("sends every texel's direction back to its own row", () => {
    // The pole rows are the degenerate ones: an equirectangular map crowds them, so a mistake in the
    // latitude sign puts both poles at the same end and the planet wears its ice caps at the equator.
    const top = directionAtEquirect(0.25, 0);
    const middle = directionAtEquirect(0.25, 0.5);
    const bottom = directionAtEquirect(0.25, 1);
    expect(top.y).toBeGreaterThan(middle.y);
    expect(middle.y).toBeGreaterThan(bottom.y);
  });
});

describe("the baked maps", () => {
  it("clamps nothing, so the sphere's radius is the field's and not a constant's", () => {
    // **The one artefact the swap cannot hide.** If the encoding clipped, some of the planet would
    // be flat at the encoding's floor or ceiling and the horizon would disagree with the chunks
    // beside it.
    //
    // The test first asserted that a bake reached the field's *declared* extremes, which it never
    // does: `lowestRadius` and `highestRadius` are the theoretical bounds, and the terrain reaches
    // about a third of the way in from each — measured at 2.85× wider than the relief that actually
    // occurs. Demanding the declared extremes was demanding the noise do something it does not do.
    //
    // So the property is the one that matters: **no texel is at either end of the byte range**,
    // which is what "nothing was clipped" means from outside.
    const maps = bakePlanetMaps(DEFAULT_PLANET, flatColour, 256, 128);
    expect(maps.relief).toBe(field.highestRadius - field.lowestRadius);
    expect(maps.seaRadius).toBe(DEFAULT_PLANET.radius);

    let lowest = Infinity;
    let highest = -Infinity;
    for (const h of maps.height) {
      lowest = Math.min(lowest, h);
      highest = Math.max(highest, h);
    }
    const asRadius = (h: number): number =>
      field.lowestRadius + (h / 255) * maps.relief;
    console.log(
      `\n  baked range ${asRadius(lowest).toFixed(0)}..${asRadius(highest).toFixed(0)} of the ` +
        `declared ${field.lowestRadius.toFixed(0)}..${field.highestRadius.toFixed(0)}\n`,
    );
    expect(lowest).toBeGreaterThan(0);
    expect(highest).toBeLessThan(255);
    // And the terrain it does reach is the terrain the field has, not a flattened version of it.
    expect(asRadius(highest) - asRadius(lowest)).toBeGreaterThan(
      maps.relief * 0.2,
    );
  });

  it("puts the height a texel asks for within a step of the field's own answer", () => {
    // The quantisation, stated. 255 steps over the relief is about two and a quarter units on the
    // default planet — far below what a displacement shows from orbit, and worth pinning so that
    // raising the map's resolution is a deliberate act rather than an accident of the format.
    const maps = bakePlanetMaps(DEFAULT_PLANET, flatColour, 128, 64);
    const step = maps.relief / 255;
    let worst = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 128; x++) {
        const d = directionAtEquirect((x + 0.5) / 128, (y + 0.5) / 64);
        const baked =
          field.lowestRadius + (maps.height[y * 128 + x]! / 255) * maps.relief;
        worst = Math.max(worst, Math.abs(baked - field.radiusAt(d)));
      }
    }
    console.log(
      `  worst height error ${worst.toFixed(2)} units, one step is ${step.toFixed(2)}\n`,
    );
    expect(worst).toBeLessThanOrEqual(step + 1e-9);
  });

  it("takes its colour from the caller, so the globe and the chunks agree", () => {
    // **By construction, not by remembering to match them.** The bake is handed the same
    // `colourAt` the terrain material is fed, so a painted chunk and the globe's version of it are
    // the same colour without either being told about the other.
    const maps = bakePlanetMaps(
      DEFAULT_PLANET,
      {
        colourAt: () => ({
          colour: { r: 12, g: 200, b: 90 } as Rgb8,
          opacity: 0.5,
        }),
      },
      8,
      4,
    );
    expect(maps.albedo[0]).toBe(12);
    expect(maps.albedo[1]).toBe(200);
    expect(maps.albedo[2]).toBe(90);
    expect(maps.albedo[3]).toBe(128);
  });

  it("is sized as asked, and not one texel off", () => {
    const maps = bakePlanetMaps(DEFAULT_PLANET, flatColour, 32, 16);
    expect(maps.width).toBe(32);
    expect(maps.height_).toBe(16);
    expect(maps.albedo).toHaveLength(32 * 16 * 4);
    expect(maps.height).toHaveLength(32 * 16);
  });

  it("bakes a map the size the globe wants, in a time the startup can spend", () => {
    // **The measurement that decided the bake's resolution, and whether it needs a worker.**
    //
    // 1024×512 is 524,288 texels, each one a three-dimensional noise evaluation. The cost is per texel
    // and nothing amortises across them, so this is a straight multiplication: the number below is
    // the whole of the cost, once, at startup.
    //
    // If this is a few hundred milliseconds it belongs on a worker, because the frame loop is running
    // and a half-second hitch at startup is a hitch the player feels as the world not appearing. The
    // client has a main-thread fallback for exactly that, and the fallback is what the player gets
    // when the worker cannot start.
    const flat = {
      colourAt: () => ({
        colour: { r: 190, g: 186, b: 176 } as Rgb8,
        opacity: 1,
      }),
    };
    const started = performance.now();
    const maps = bakePlanetMaps(DEFAULT_PLANET, flat, 1024, 512);
    const elapsed = performance.now() - started;
    console.log(
      `\n  baked 1024x512 (${maps.width * maps.height_} texels) in ${elapsed.toFixed(0)}ms\n`,
    );
    expect(elapsed).toBeLessThan(4000);
  });
});
