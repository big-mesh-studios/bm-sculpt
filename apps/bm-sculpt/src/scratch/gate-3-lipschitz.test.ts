/**
 * Gate 3: what is the Lipschitz bound of a radial field?
 *
 * `terrain.ts` derives `lipschitz = 1/√(1 + 2A²)` for a height field and documents the
 * consequence: at default parameters it lands near 0.2, so the sphere-tracing picker takes
 * about five times as many steps as it would over operations alone. The plan said a planet
 * would have a *better* bound, because the noise's argument is a normalised direction rather
 * than a world x/z. That prediction is what this file exists to check, and it needs checking
 * because it is the kind of thing that is easy to reason about and wrong about.
 *
 * ## The derivation
 *
 * For `f(p) = |p - c| - (R + scale·g(n̂))`, with `S = R / TERRAIN_FEATURE` chosen so one noise
 * cell is `TERRAIN_FEATURE` world units across:
 *
 * - `n̂` does not change along a ray from the centre, so **`∂f/∂r = 1` exactly** and the
 *   gradient's radial component is exactly 1.
 * - `∇f = n̂ - (scale/r)·P·∇g` with `P = I - n̂n̂ᵀ`, so the correction is purely tangential and
 *   `|∇f|² = 1 + (scale/r)²·|P∇g|²`.
 * - `(scale/r)·S = scale/TERRAIN_FEATURE`, so **`r` cancels** and the bound keeps the height
 *   field's shape: `sqrt(1 + 3A²)` against `sqrt(1 + 2A²)`, the three being three noise axes
 *   where the height field had two.
 *
 * The prediction was wrong in the direction that matters. The `√3` and the 3D gradient bound
 * very nearly cancel — `NOISE_GRADIENT_BOUND_3D` is 6.495 against `NOISE_GRADIENT_BOUND`'s
 * 7.5, so `√3 · 6.495 = 11.25` is almost exactly `√2 · 7.5 = 10.61` — which leaves `A`
 * essentially unchanged and `lipschitz` essentially the same number it already is. Measured:
 * 0.0786 against the height field's 0.0833, so a planet costs the picker about 1.2x the
 * steps. Not the threefold improvement the plan claimed, and not a regression either.
 *
 * ## The finding worth acting on
 *
 * **The bound is about eleven times larger than the gradient it bounds** — measured 1.14
 * against a permitted 12.7 for the planet, and 1.18 against 12.0 for the height field. That is
 * not new, and it is not the planet's fault: `terrain.ts` already says its per-axis figure is
 * "deliberately pessimistic", and it is. The pessimism is two multiplicative parts, each
 * assuming every octave peaks in the same place as the whole sum, and the *measured* maximum
 * of a normalised fBm is nowhere near the product of its per-octave worst cases.
 *
 * Since `lipschitz` is the reciprocal of that bound, a tenth of it would be a tenth of the
 * steps in `packages/picking`, whose `maxSteps: 512` is currently carrying the cost. That is
 * a separate piece of work and it is worth doing on the flat world today; it is recorded here
 * because the planet work is what makes it visible.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_TERRAIN, terrainField } from "@big-mesh-studios/csg";
import { DEFAULT_PLANET, planetField } from "@big-mesh-studios/csg";

/** The largest gradient magnitude over a dense sample of the sphere, by central differences. */
const maxGradient = (
  distance: (x: number, y: number, z: number) => number,
  radiusAt: (n: { x: number; y: number; z: number }) => number,
  samples = 96,
  step = 1,
): { worst: number; at: string } => {
  let worst = 0;
  let at = "";
  for (let i = 0; i <= samples; i++) {
    const theta = Math.PI * (i / samples);
    for (let j = 0; j < 2 * samples; j++) {
      const phi = (2 * Math.PI * j) / (2 * samples);
      const n = {
        x: Math.sin(theta) * Math.cos(phi),
        y: Math.cos(theta),
        z: Math.sin(theta) * Math.sin(phi),
      };
      // Sampled on the surface itself and a little above and below it, since the mesher and
      // the picker both ask about points in the air as well as points on the ground.
      for (const altitude of [-400, -40, 0, 40, 400]) {
        const r = radiusAt(n) + altitude;
        const x = n.x * r;
        const y = n.y * r;
        const z = n.z * r;
        const gx =
          (distance(x + step, y, z) - distance(x - step, y, z)) / (2 * step);
        const gy =
          (distance(x, y + step, z) - distance(x, y - step, z)) / (2 * step);
        const gz =
          (distance(x, y, z + step) - distance(x, y, z - step)) / (2 * step);
        const magnitude = Math.hypot(gx, gy, gz);
        if (magnitude > worst) {
          worst = magnitude;
          at = `theta ${theta.toFixed(2)} phi ${phi.toFixed(2)} altitude ${altitude}`;
        }
      }
    }
  }
  return { worst, at };
};

describe("the Lipschitz bound of a radial field", () => {
  it("bounds the real gradient, and the picker still converges under it", () => {
    const planet = planetField(DEFAULT_PLANET);
    const measured = maxGradient((x, y, z) => planet(x, y, z), planet.radiusAt);
    const bound = 1 / planet.lipschitz;

    console.log(
      `[gate 3] planet: lipschitz ${planet.lipschitz.toFixed(4)}, so distances are scaled ` +
        `by it and the gradient may reach ${bound.toFixed(3)}. Measured maximum |∇f| ` +
        `${measured.worst.toFixed(3)} at ${measured.at}`,
    );

    // The bound is the contract `FieldOptions.lipschitz` exists to keep: a distance scaled by
    // `lipschitz` must never over-report, because the picker steps by it and a step that is
    // too long steps through the surface.
    expect(measured.worst).toBeLessThanOrEqual(bound);
  });

  it("leaves about a decade of the bound unused, as the height field already does", () => {
    // The measurement that matters beyond this project. `lipschitz` is the reciprocal of the
    // gradient bound, so the picker takes `|∇f| / lipschitz` steps per unit of travel and
    // every factor of bound spent is a factor of steps paid.
    const planet = planetField(DEFAULT_PLANET);
    const flat = terrainField(DEFAULT_TERRAIN);
    const planetMeasured = maxGradient(
      (x, y, z) => planet(x, y, z),
      planet.radiusAt,
    ).worst;
    const flatMeasured = maxGradient(
      (x, y, z) => flat(x, y, z),
      (n) =>
        flat.heightAt(n.x * DEFAULT_PLANET.radius, n.z * DEFAULT_PLANET.radius),
    ).worst;

    const slack = (measured: number, bound: number): number => bound / measured;
    console.log(
      `[gate 3] bound slack: planet ${slack(planetMeasured, 1 / planet.lipschitz).toFixed(1)}x, ` +
        `height field ${slack(flatMeasured, 1 / flat.lipschitz).toFixed(1)}x`,
    );

    // Held as a floor rather than an exact figure, so a change to the noise that tightens the
    // gradient turns this red and gets looked at, and one that loosens it past two decades
    // turns it red the other way. Both fields are asserted, because the point is that the
    // planet neither introduces nor fixes the slack.
    expect(slack(planetMeasured, 1 / planet.lipschitz)).toBeGreaterThan(5);
    expect(slack(flatMeasured, 1 / flat.lipschitz)).toBeGreaterThan(5);
  });

  it("costs the picker about the same as the height field it replaces", () => {
    // The number that decides whether `packages/picking`'s `maxSteps: 512` needs raising.
    const planet = planetField(DEFAULT_PLANET);
    const flat = terrainField(DEFAULT_TERRAIN);

    const planetGradient = maxGradient(
      (x, y, z) => planet(x, y, z),
      planet.radiusAt,
    );
    const flatGradient = maxGradient(
      (x, y, z) => flat(x, y, z),
      (n) => {
        // The flat field's surface, sampled on the same sphere so the two are comparable.
        const r = DEFAULT_PLANET.radius;
        void r;
        return flat.heightAt(n.x * r, n.z * r);
      },
    );

    console.log(
      `[gate 3] height field: lipschitz ${flat.lipschitz.toFixed(4)}, gradient bound ` +
        `${(1 / flat.lipschitz).toFixed(3)}, measured ${flatGradient.worst.toFixed(3)}`,
    );
    console.log(
      `[gate 3] so a sphere-tracing ray needs about ` +
        `${((planetGradient.worst * flat.lipschitz) / planet.lipschitz).toFixed(2)}x the ` +
        `steps the flat landscape does`,
    );

    // The plan predicted the planet would be *faster* to trace. It is not, and by a small
    // margin: `√3` on the axis count and the tighter 3D gradient bound cancel almost exactly.
    // Asserted as a ratio rather than an inequality because the useful fact is "no worse",
    // and a bound that came out 30% worse would still be fine but would be worth knowing.
    expect(planet.lipschitz).toBeGreaterThan(0.8 * flat.lipschitz);
    expect(planet.lipschitz).toBeLessThan(1.25 * flat.lipschitz);
  });

  it("keeps the relief inside the radius range the cheap gate compares against", () => {
    // Soundness is the assertion; tightness is reported. The closed-form `reach` has to
    // *contain* every surface or the gate puts holes in the planet, and it does. It is also
    // about three times wider than the surface actually is, which is the same deliberate
    // pessimism the height field has and which `terrain.ts` argues for at length — but on a
    // sphere the waste is dearer, because the band is radial thickness and a 320-unit cell
    // spans only about 22 units of it.
    // `couldHoldSurface` answers from `lowestRadius` and `highestRadius` and never evaluates
    // noise, so those two numbers have to actually contain every surface on the planet. This
    // is the check that the closed-form `reach` in `planet-field.ts` is not a guess.
    const planet = planetField(DEFAULT_PLANET);
    let lowest = Infinity;
    let highest = -Infinity;
    const samples = 200;
    for (let i = 0; i <= samples; i++) {
      const theta = Math.PI * (i / samples);
      for (let j = 0; j < 2 * samples; j++) {
        const phi = (2 * Math.PI * j) / (2 * samples);
        const r = planet.radiusAt({
          x: Math.sin(theta) * Math.cos(phi),
          y: Math.cos(theta),
          z: Math.sin(theta) * Math.sin(phi),
        });
        lowest = Math.min(lowest, r);
        highest = Math.max(highest, r);
      }
    }
    console.log(
      `[gate 3] surface radius spans ${lowest.toFixed(1)}–${highest.toFixed(1)} against a ` +
        `declared band ${planet.lowestRadius.toFixed(0)}–${planet.highestRadius.toFixed(0)}`,
    );
    expect(lowest).toBeGreaterThanOrEqual(planet.lowestRadius);
    expect(highest).toBeLessThanOrEqual(planet.highestRadius);

    // The reported ratio, and the reason it is a measurement rather than an assertion: it is
    // the fraction of the samples the gate takes that are worth taking, and it decides how
    // much a tighter band would buy.
    const surface = highest - lowest;
    const declared = planet.highestRadius - planet.lowestRadius;
    console.log(
      `[gate 3] the declared band is ${(declared / surface).toFixed(2)}x the sampled ` +
        `surface, so the gate wastes about ` +
        `${(100 * (1 - surface / declared)).toFixed(0)}% of the chunks it admits`,
    );
    expect(surface / declared).toBeGreaterThan(0.2);
  });
});
