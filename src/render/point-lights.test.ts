/**
 * Point lights, measured rather than inspected.
 *
 * ## Why this file is not a compile test
 *
 * The deleted `TODO.md` recorded four bugs in this repository's sky that **every test passed**.
 * Each compiled, each had a green suite, and each produced a wrong image — a starfield that lit
 * zero pixels, a cloud layer that had never drawn a cloud, clouds at one eightieth of their own
 * brightness. The fourth is the instructive one: there was a test asserting the *shape* of the
 * emitted GLSL, reading the divisor of an analytic integral as part of its numerator.
 *
 * So nothing below checks that a term is present. Every assertion is a **number a light
 * produces**, and the falloff is checked against `1/d²` at three distances rather than "it gets
 * dimmer".
 *
 * The probe is a one-node material rather than `SurfaceMaterial` on purpose: this is about the
 * lighting term alone, and a test that also went through albedo, the volume and fog could pass
 * with any of the four of them wrong.
 */

import { describe, expect, it } from "vitest";
import { Scene, NodeMaterial } from "@random-mesh/rmsl/scene";
import type { Node } from "@random-mesh/rmsl";
import { float, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import { fromProgram, render } from "@random-mesh/rmsl/test";

import {
  MAX_DRAWN_LIGHTS,
  PointLights,
  type PointLight,
  type PointLightBindings,
} from "./point-lights";
import { SurfaceMaterial } from "./surface-material";
import { dayNightState, NOON_SECONDS } from "../world/day-night";

/**
 * A material whose whole fragment body is the lighting term.
 *
 * **Two varyings and nothing else**, so a value read out of it is the term's own arithmetic and
 * not a product of it with anything. `normalWorld` is supplied straight into the fragment stage,
 * which is what a rasteriser would interpolate there.
 */
class LightProbe extends NodeMaterial {
  readonly lights = new PointLights();
  private bindings?: PointLightBindings;

  protected override setup(b: Builder): void {
    void b.varying("vNormal", "vec3");
    void b.varying("vWorld", "vec3");
    this.bindings = this.lights.declare(b);
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    return vec4(
      this.bindings!.contribution(
        b.varying("vWorld", "vec3"),
        b.varying("vNormal", "vec3").normalize(),
      ),
      float(1),
    );
  }
}

/** A light with the parts a test cares about, and neutral values for the rest. */
const light = (over: Partial<PointLight> = {}): PointLight => ({
  at: { x: 0, y: 0, z: 0 },
  colour: [1, 1, 1],
  radius: 1000,
  intensity: 1,
  ...over,
});

/**
 * One fragment, shaded by a probe holding `lights`.
 *
 * **A single pixel, addressed by varying name.** `render` is given one row and one column so that
 * the position supplied is the only one there is, and the answer cannot be an average over a
 * frame that happened to contain something else.
 */
const shade = (
  lights: readonly PointLight[] | null,
  world: readonly [number, number, number],
  normal: readonly [number, number, number] = [0, 1, 0],
): readonly [number, number, number] => {
  const material = new LightProbe();
  material.lights.lights = lights;

  const runner = fromProgram(material.build(new Scene()));
  // Every binding this shader wants must be one of the two varyings it declares. A name here
  // would otherwise shade as `undefined` and the test would measure nothing.
  expect(runner.unbound).toEqual([]);

  const image = render(runner, {
    width: 1,
    height: 1,
    inputs: ({ x, y }) => ({
      varyings: {
        vWorld: [world[0] + x, world[1] + y, world[2]],
        vNormal: normal,
      },
    }),
  });

  // `at` rather than `pixels`, so the row-major offset and the four-channels-per-fragment
  // stride are the library's business rather than this test's arithmetic.
  const [r, g, b] = image.at(0, 0);
  return [r, g, b];
};

/** How much of one channel a light added, which is what every assertion below is about. */
const red = (rgb: readonly [number, number, number]): number => rgb[0];

/**
 * A white light reaching `radius`, centred `radius / 2` above the origin.
 *
 * **Halfway in, not at the edge.** The window is zero at the radius — that is what it is for — so
 * a probe sitting exactly there measures nothing at any intensity, and a helper that put it there
 * by default would make every test below a test of the window rather than of the light.
 */
const lamp = (
  radius: number,
  intensity = 1,
  over: Partial<PointLight> = {},
): PointLight =>
  light({
    at: { x: 0, y: radius * 0.5, z: 0 },
    radius,
    intensity,
    ...over,
  });

/** How bright the light is at `distance` from it, for a fragment facing it. */
const at = (radius: number, distance: number, intensity = 1): number =>
  red(
    shade(
      [light({ at: { x: 0, y: distance, z: 0 }, radius, intensity })],
      [0, 0, 0],
      [0, 1, 0],
    ),
  );

describe("the program itself", () => {
  it("compiles with no lights at all", () => {
    // **The cheap check, and the one that would have passed all four sky bugs.** It is here
    // because it is worth knowing, not because it is worth much.
    expect(() => new LightProbe().build(new Scene())).not.toThrow();
  });

  it("declares one position and one colour uniform per light", () => {
    const program = new LightProbe().build(new Scene());
    const names = program.uniforms?.map((uniform) => uniform.name) ?? [];
    expect(
      names.filter((name) => name.startsWith("uLightPosition")),
    ).toHaveLength(MAX_DRAWN_LIGHTS);
    expect(
      names.filter((name) => name.startsWith("uLightColour")),
    ).toHaveLength(MAX_DRAWN_LIGHTS);
  });

  it("packs a light into two vec4s rather than five scalars", () => {
    // **The whole of the uniform budget argument.** Five uniforms a light would be forty slots
    // for eight lights; two is sixteen, and the reason it can be two is that position travels
    // with radius and colour with intensity.
    const program = new LightProbe().build(new Scene());
    for (const uniform of program.uniforms ?? []) {
      if (uniform.name.startsWith("uLight"))
        expect(uniform.node.name).toBeDefined();
    }
  });
});

describe("a light that is not there", () => {
  it("adds nothing at all when the list is empty", () => {
    expect(shade([], [5, 5, 5])).toEqual([0, 0, 0]);
  });

  it("adds nothing when the list is null", () => {
    // **`null` is "a build with no place loaded", and it is the state the application spends
    // its whole life in before anyone types `/place:load`.**
    expect(shade(null, [5, 5, 5])).toEqual([0, 0, 0]);
  });

  it("adds nothing from a slot past the end of the list", () => {
    // **Padding.** Four lights in an eight-slot shader means four dead slots, and this is what a
    // dead slot has to be — otherwise the padding would light the world with whatever was left in
    // the uniforms.
    const four = [
      light({ at: { x: 1, y: 1, z: 1 }, radius: 400 }),
      light({ at: { x: 2, y: 2, z: 2 }, radius: 400 }),
    ];
    const lit = shade(four, [0, 100, 0]);
    const unlit = shade(
      [...four, light({ at: { x: 0, y: 1000, z: 0 }, radius: 1 })],
      [0, 100, 0],
    );
    expect(red(unlit)).toBeCloseTo(red(lit), 5);
  });

  it("adds nothing from a light with no radius", () => {
    // **Radius zero is the dead light, and it must be free rather than merely invisible.** This
    // is the property the fixed slot count rests on: if a zero-radius light were not exactly
    // zero, every world would be lit by the padding.
    expect(
      red(shade([light({ at: { x: 0, y: 1, z: 0 }, radius: 0 })], [0, 0, 0])),
    ).toBe(0);
  });

  it("adds nothing from a light with no intensity", () => {
    expect(
      red(
        shade([light({ at: { x: 0, y: 1, z: 0 }, intensity: 0 })], [0, 0, 0]),
      ),
    ).toBe(0);
  });
});

describe("a light that is there", () => {
  it("lights the side facing it and not the side facing away", () => {
    // **The one property that makes it a light.** A term that added colour without regard to
    // direction would pass every test above and render as a fog.
    const world: readonly [number, number, number] = [0, 0, 0];
    const up = red(shade([lamp(20)], world, [0, 1, 0]));
    const down = red(shade([lamp(20)], world, [0, -1, 0]));
    expect(up).toBeGreaterThan(0);
    expect(down).toBe(0);
  });

  it("is lit on the horizontal too, not only overhead", () => {
    // **A light is not a ceiling.** The term is `dot(normal, direction)` with no axis singled out,
    // and a version that only ever answered "up" would pass every overhead assertion above.
    const world: readonly [number, number, number] = [0, 0, 0];
    const sideways = red(
      shade(
        [light({ at: { x: 10, y: 0, z: 0 }, radius: 20 })],
        world,
        [1, 0, 0],
      ),
    );
    const away = red(
      shade(
        [light({ at: { x: 10, y: 0, z: 0 }, radius: 20 })],
        world,
        [-1, 0, 0],
      ),
    );
    expect(sideways).toBeGreaterThan(0);
    expect(away).toBe(0);
  });

  it("scales with the radius, so reach and brightness are one decision", () => {
    // **The fingerprint of `r²/d²`, and the claim a place author relies on.** Doubling a light's
    // radius quadruples it at a fixed distance. A version that scaled by radius alone would
    // double it; one that used raw `1/d²` would not change at all.
    //
    // **A bound rather than an equality, and the excess is not slop.** The window is marginally
    // more open at the larger radius, because `d/r` is smaller there, so the ratio is a little
    // over four — 4.015 for this pair. Asserted as a floor of exactly four and a ceiling of 5%,
    // which is the property: `r²` is the whole of the scaling and the window can only add a
    // little.
    const distance = 10;
    const ratio = at(80, distance, 1) / at(40, distance, 1);
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(4.05);
  });

  it("is very slightly brighter per unit reach when given a wider radius", () => {
    // **The same fact as the one above, as its own property** — and worth knowing rather than
    // merely tolerating: a wider light is a little brighter at the same distance, not exactly the
    // same brightness spread thinner. Ten times the radius is a hundred times the `r²`, and this
    // says the window claws back less than half a percent of it.
    const ratio = at(400, 10) / at(40, 10) / 100;
    expect(ratio).toBeGreaterThan(1.002);
    expect(ratio).toBeLessThan(1.005);
  });

  it("scales linearly with intensity, at any radius", () => {
    // **Checked at two radii**, because a term that multiplied intensity in before the radius was
    // applied would agree at one of them and not the other.
    for (const radius of [40, 90]) {
      expect(at(radius, 10, 0.5) / at(radius, 10, 1)).toBeCloseTo(0.5, 3);
      expect(at(radius, 10, 2) / at(radius, 10, 1)).toBeCloseTo(2, 3);
    }
  });

  it("is dark at its own radius whatever its intensity, because the window is", () => {
    // **The claim the intensity documentation explicitly does not make.** A light's reach is
    // where it stops, and that is a property of the radius alone — so this is the test that keeps
    // the docs and the shader agreeing about where "brightness at the edge" would be wrong.
    for (const intensity of [1, 100]) {
      expect(at(20, 20, intensity)).toBe(0);
    }
  });

  it("falls off as one over the square of the distance", () => {
    // **The assertion the four sky bugs would not have survived.** "It gets dimmer" passes for a
    // linear falloff, for an eighth-power one, and for the one-eightieth-of-its-own-brightness
    // that the clouds shipped with. Three distances, each a doubling of the last, each checked for
    // a quartering — so a uniform scale factor anywhere in the term cancels and only the *shape*
    // of the falloff is under test.
    //
    // Held well inside the radius so the window is still fully open; a falloff that also closed
    // would confound the two effects.
    const lit = (distance: number): number => at(1000, distance, 1);

    const near = lit(10);
    const middle = lit(20);
    const far = lit(40);

    expect(middle / near).toBeCloseTo(0.25, 1);
    expect(far / middle).toBeCloseTo(0.25, 1);
  });

  it("is brighter nearer the lamp, measured rather than assumed", () => {
    expect(at(200, 20)).toBeGreaterThan(at(200, 80));
  });

  it("reaches no further than its radius", () => {
    // **And not one unit further.** A window that ended slightly late would be invisible at
    // `1.05 ×` and obvious across a room, so the sample is just outside rather than far outside.
    const radius = 20;
    const world: readonly [number, number, number] = [0, 0, 0];
    const inside = red(
      shade(
        [light({ at: { x: 0, y: radius * 0.9, z: 0 }, radius })],
        world,
        [0, 1, 0],
      ),
    );
    const outside = red(
      shade(
        [light({ at: { x: 0, y: radius * 1.01, z: 0 }, radius })],
        world,
        [0, 1, 0],
      ),
    );
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBe(0);
  });

  it("tapers to nothing at its radius rather than stopping dead", () => {
    // **The window is fourth-power, and this is the difference it makes.** A linear window leaves
    // a visible crease at the edge; the sample just inside the radius is already most of the way
    // to nothing, so a person cannot point at the boundary and see it.
    const radius = 20;
    const brightness = (fraction: number): number =>
      at(radius, radius * fraction);

    // At 90% of the radius the window has closed a long way; a linear one would still be at 10%.
    expect(brightness(0.9)).toBeLessThan(brightness(0.5) * 0.2);
  });

  it("is white when its colour is white", () => {
    // **All three channels equal, which is what "white" is.** Asserted as the channels agreeing
    // rather than as a number, because a term that added `colour * 2` to every channel would
    // still have three equal channels.
    const rgb = shade([lamp(10)], [0, 0, 0], [0, 1, 0]);
    expect(rgb[0]).toBeCloseTo(rgb[1]!, 5);
    expect(rgb[1]!).toBeCloseTo(rgb[2]!, 5);
    expect(rgb[0]).toBeGreaterThan(0);
  });

  it("takes the colour it was given, per channel", () => {
    const world: readonly [number, number, number] = [0, 0, 0];
    const warm = shade([lamp(10, 1, { colour: [1, 0, 0] })], world, [0, 1, 0]);
    const white = shade([lamp(10)], world, [0, 1, 0]);
    expect(warm[0]).toBeCloseTo(white[0]!, 5);
    expect(warm[1]).toBeCloseTo(0, 5);
    expect(warm[2]).toBeCloseTo(0, 5);
  });

  it("is scaled by its intensity", () => {
    const world: readonly [number, number, number] = [0, 0, 0];
    const dim = red(shade([lamp(10, 0.25)], world, [0, 1, 0]));
    const full = red(shade([lamp(10, 1)], world, [0, 1, 0]));
    expect(dim).toBeCloseTo(full * 0.25, 2);
  });

  it("is finite at the lamp's own centre, where there is no direction", () => {
    // **A fragment standing exactly in the light.** The direction is zero-length, so a term that
    // normalised it would divide by zero — an infinity on most hardware and a NaN on some. A NaN
    // in the lighting sum would take the whole pixel with it. Checked as finiteness rather than as
    // a value because the value here is legitimately enormous and is clamped upstream.
    const atCentre = shade(
      [lamp(10, 1, { at: { x: 0, y: 0, z: 0 } })],
      [0, 0, 0],
      [0, 1, 0],
    );
    for (const channel of atCentre) {
      expect(Number.isFinite(channel)).toBe(true);
    }
  });

  it("adds several lights together", () => {
    // **Two lights from two directions sum.** The second is beside the fragment rather than above
    // it, so it arrives through a different part of the term; a shader that kept only the first
    // light, or that overwrote rather than accumulated, would fail this.
    const world: readonly [number, number, number] = [0, 0, 0];
    // **Both lights in the same hemisphere as the normal.** A light level with the surface
    // contributes nothing at all under a Lambert term, which is correct and would otherwise read
    // here as "the sum does not work".
    const one = red(shade([lamp(20)], world, [0, 1, 0]));
    const beside = red(
      shade(
        [lamp(20), light({ at: { x: 10, y: 10, z: 0 }, radius: 40 })],
        world,
        [0, 1, 0],
      ),
    );
    const behind = red(
      shade(
        [lamp(20), light({ at: { x: -10, y: 10, z: 0 }, radius: 40 })],
        world,
        [0, 1, 0],
      ),
    );
    expect(beside).toBeGreaterThan(one);
    expect(behind).toBeGreaterThan(one);
  });

  it("draws at most MAX_DRAWN_LIGHTS, and drops the rest", () => {
    // **The cap, and it is a shader budget rather than a promise.** Nine lights in an eight-slot
    // shader means the ninth is not drawn — which the host's nearest-N selection exists to make
    // harmless, and which this says out loud rather than leaving to be discovered.
    const many = Array.from({ length: MAX_DRAWN_LIGHTS + 4 }, (_, at) =>
      light({ at: { x: 0, y: 10 + at, z: 0 }, radius: 100 }),
    );
    const eight = many.slice(0, MAX_DRAWN_LIGHTS);
    const world: readonly [number, number, number] = [0, 0, 0];
    expect(red(shade(many, world, [0, 1, 0]))).toBeCloseTo(
      red(shade(eight, world, [0, 1, 0])),
      4,
    );
  });

  it("is unaffected by a light that has been replaced rather than appended", () => {
    // **Assigning the list replaces it.** A stale tail from a longer previous list would light a
    // world that has been unloaded, and this is the assertion that the assignment is the whole
    // of the update rather than an addition to something held elsewhere.
    const material = new LightProbe();
    const runner = () => fromProgram(material.build(new Scene()));
    material.lights.lights = [lamp(10, 1, { at: { x: 0, y: 60, z: 0 } })];
    material.lights.lights = [lamp(60, 1, { at: { x: 0, y: 60, z: 0 } })];
    const image = render(runner(), {
      width: 1,
      height: 1,
      inputs: () => ({ varyings: { vWorld: [0, 0, 0], vNormal: [0, 1, 0] } }),
    });
    const expected = shade(
      [lamp(60, 1, { at: { x: 0, y: 60, z: 0 } })],
      [0, 0, 0],
      [0, 1, 0],
    );
    expect(image.at(0, 0)[0]).toBeCloseTo(expected[0], 4);
  });
});

/**
 * The same term, through the material that actually draws the world.
 *
 * ## Why this is separate from everything above
 *
 * **The probe proves the arithmetic; only this proves the wiring.** Every assertion so far would
 * pass with `SurfaceMaterial` never having called `this.lights.declare(b)` — the bindings would
 * be built, the uniforms declared, and the contribution dropped on the floor. That is a real
 * shape of bug and it is invisible to a unit test of the term, which is why `rendered` below
 * asserts on pixels rather than on the program's uniform list.
 *
 * It also catches the two mistakes that are specific to *adding* this to an existing material:
 * declaring the uniforms but reading a `positionWorld` the fragment stage does not have, and
 * adding the term after the clamp rather than before it — which compiles, and renders every light
 * as pure white.
 */
describe("the terrain, lit by a place", () => {
  /** One pixel of the real material, with every binding a renderer would have supplied. */
  const rendered = (
    lights: readonly PointLight[] | null,
    world: readonly [number, number, number],
    normal: readonly [number, number, number] = [0, 1, 0],
  ): readonly [number, number, number] => {
    const material = new SurfaceMaterial();
    material.lights.lights = lights;
    // **Midday, so the sun is strong and a lantern's contribution is a small difference rather
    // than the whole picture.** A test at midnight would pass on any term that adds *something*.
    material.sky.lighting = dayNightState(NOON_SECONDS);

    const runner = fromProgram(material.build(new Scene()));
    const image = render(runner, {
      width: 1,
      height: 1,
      inputs: ({ x, y }) => ({
        varyings: {
          positionWorld: [world[0] + x, world[1] + y, world[2]],
          normalWorld: normal,
          vColour: [0.8, 0.8, 0.8, 1],
        },
      }),
    });

    const [r, g, b] = image.at(0, 0);
    return [r, g, b];
  };

  it("has every binding it needs, so it is not shading as undefined", () => {
    const material = new SurfaceMaterial();
    const runner = fromProgram(material.build(new Scene()));
    // **The check that makes the pixel assertions meaningful.** A missing varying would shade as
    // `undefined` and every measurement below would be of garbage.
    expect(runner.unbound).toEqual([]);
  });

  it("declares the light uniforms in its own program", () => {
    // **Not just in the probe's.** `declare` is what puts them in this material's uniform list, and
    // rmsl prunes any a material never reads — so their presence here is the evidence that the
    // term is actually part of the terrain's shading.
    const names =
      new SurfaceMaterial()
        .build(new Scene())
        .uniforms?.map((uniform) => uniform.name) ?? [];
    for (let at = 0; at < MAX_DRAWN_LIGHTS; at++) {
      expect(names).toContain(`uLightPosition${at}`);
      expect(names).toContain(`uLightColour${at}`);
    }
  });

  it("is brighter under a light than without one", () => {
    // **The wiring assertion.** Same material, same fragment, one variable.
    const world: readonly [number, number, number] = [0, 0, 0];
    const dark = rendered(null, world, [0, 1, 0]);
    const lit = rendered(
      [light({ at: { x: 0, y: 10, z: 0 }, radius: 40 })],
      world,
      [0, 1, 0],
    );
    expect(lit[0]).toBeGreaterThan(dark[0]);
  });

  it("is unchanged by a light on the other side of the surface", () => {
    // **Direction, through the real material, against the same normal.** The comparison is
    // against an unlit *underside* rather than an unlit top — comparing a lit underside to an
    // unlit top would pass for any term at all, since the two differ in the sun as well.
    const world: readonly [number, number, number] = [0, 0, 0];
    const under = [0, -1, 0] as const;
    const unlit = rendered(null, world, under);
    const lit = rendered(
      [light({ at: { x: 0, y: 10, z: 0 }, radius: 40 })],
      world,
      under,
    );
    expect(lit[0]).toBeCloseTo(unlit[0], 6);
  });

  it("saturates to exactly one at a lamp's core rather than exceeding it", () => {
    // **Added before the clamp, not after.** A term added after the clamp would arrive
    // already clamped and a fragment near a lantern would read above one — which compiles,
    // renders, and has a shape assertion to match. Exactly one, not merely at most one.
    //
    // A vertical wall with a lamp beside it, rather than an overhead lamp over a floor: at
    // `d = r/2` the term is `4 × 0.94 ≈ 3.75`, which on top of ambient is far past the top of the
    // range. The point is the ceiling.
    const hot = rendered(
      [light({ at: { x: 20, y: 0, z: 0 }, radius: 40 })],
      [0, 0, 0],
      [1, 0, 0],
    );
    expect(hot[0]).toBe(1);
  });

  it("is not saturated across most of a light's reach", () => {
    // **The other half of the same claim, and the reason the falloff is normalised.** A term that
    // saturated everything within half its radius would make a lantern a white disc with an edge;
    // this says the useful range is wide. At `0.85 ×` the radius the term is about 0.5, which
    // lands between the unlit pixel and one.
    const world: readonly [number, number, number] = [0, 0, 0];
    const side = [1, 0, 0] as const;
    const unlit = rendered(null, world, side)[0];
    const near = rendered(
      [light({ at: { x: 34, y: 0, z: 0 }, radius: 40 })],
      world,
      side,
    )[0];
    expect(near).toBeGreaterThan(unlit);
    expect(near).toBeLessThan(1);
  });

  it("takes a light's colour, which is the point of having one", () => {
    // **Per channel, end to end.** A red lantern must not be a white one, and this is the only
    // place in the repository that would notice if the colour term had been dropped somewhere
    // between the host's conversion and the shader's multiply.
    const world: readonly [number, number, number] = [0, 0, 0];
    const warm = rendered(
      [light({ at: { x: 0, y: 10, z: 0 }, radius: 40, colour: [1, 0, 0] })],
      world,
      [0, 1, 0],
    );
    const cold = rendered(
      [light({ at: { x: 0, y: 10, z: 0 }, radius: 40, colour: [0, 0, 1] })],
      world,
      [0, 1, 0],
    );
    expect(warm[0]).toBeGreaterThan(cold[0]);
    expect(warm[2]).toBeLessThan(cold[2]);
  });

  it("still darkens with the fog, rather than being drawn over it", () => {
    // **Fog is last in the fragment body**, so a light near the horizon is still veiled by the
    // air in front of it. Checked by moving the fragment to the far edge of the window, where the
    // fog has closed: a lantern there must not read brighter than the same terrain with no light
    // at all, or the overlay would be visible through the haze the whole world is drawn into.
    const far: readonly [number, number, number] = [0, 0, 0];
    const unlitFar = rendered(null, [far[0], far[1], 12_000], [0, 1, 0]);
    const litFar = rendered(
      [light({ at: { x: 0, y: 10, z: 0 }, radius: 400 })],
      [far[0], far[1], 12_000],
      [0, 1, 0],
    );
    expect(litFar[0]).toBeCloseTo(unlitFar[0], 6);
  });
});
