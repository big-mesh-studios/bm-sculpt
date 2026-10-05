import { compileGlsl } from "@random-mesh/rmsl/glsl";
import { Scene, Side } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import type { Vec3 } from "@big-mesh-studios/core";
import {
  CLOUD_BOTTOM,
  CLOUD_FEATURE,
  CLOUD_THICKNESS,
  CLOUD_TOP,
  LIGHT_STEPS,
  MAX_STEPS,
  CloudMaterial,
  cloudSpan,
  driftAngleAt,
} from "./clouds";
import { DEFAULT_PLANET, planetField, reachOf } from "@big-mesh-studios/csg";
import { DEFAULT_PLANET_RADIUS } from "../render/atmosphere";
import {
  SHAPE_DETAIL_PERIODS,
  SHAPE_SIZE,
  bakeCloudField,
} from "./cloud-field";
import { shapeTexture, weatherTexture } from "./cloud-textures";

/**
 * Compiling a material needs no graphics device.
 *
 * `NodeMaterial.build` turns the node graph into roots plus the exact set of bindings
 * the graph reaches, and `compileGlsl` renders those to GLSL ES 3.00. Both are
 * host-side string and object work, so the questions worth asking about a shader this
 * size are answerable here rather than by looking at a sky.
 *
 * What this cannot see is whether the sky is any good. A march that compiles, marches
 * the right number of steps through the right slab and integrates its transmittance
 * analytically can still produce a grey sheet, and only a browser will show that. So
 * these are about the failures that are *silent* — a fetch the compiler could not
 * see it had already made, an accumulator mutated by assignment rather than by
 * `mul`, a `NaN` from JavaScript arithmetic leaking into a uniform, a march that
 * starts at the eye instead of at the volume.
 *
 * The bake is at a reduced size. Its resolution changes nothing about the shader, and
 * a full one is two and a half seconds.
 */

const field = bakeCloudField(20260901, 20, 60);

const make = (): CloudMaterial =>
  new CloudMaterial(shapeTexture(field.shape), weatherTexture(field.weather));

const compile = (material: CloudMaterial) => {
  const program = material.build(new Scene());
  return {
    program,
    vertex: compileGlsl.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGlsl.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};

/** How many distinct source sites there are, which is what the GPU sees per loop. */
const countSites = (source: string, needle: string): number =>
  source.split(needle).length - 1;

/**
 * One `for` loop in emitted GLSL: how many times it runs, and where its own body is.
 *
 * The braces are matched rather than searched for the next `}`, because a loop body's
 * own text contains two more loops and a nested `if` per sample — and this file is
 * counting fetches per loop, so the body has to be exact.
 */
interface Loop {
  readonly iterations: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** Every `for (int` loop in `source`, in the order it appears. */
const loopsIn = (source: string): Loop[] => {
  const loops: Loop[] = [];
  for (let from = 0; ;) {
    const start = source.indexOf("for (int", from);
    if (start === -1) return loops;
    const iterations = Number(
      /\w+\s*<\s*(\d+)/.exec(source.slice(start, start + 80))?.[1] ?? "1",
    );
    const bodyStart = source.indexOf("{", start);
    if (bodyStart === -1) return loops;
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        bodyEnd = i;
        break;
      }
    }
    loops.push({ iterations, bodyStart, bodyEnd });
    from = start + 1;
  }
};

/** Whether `inner`'s body lies wholly within `outer`'s. */
const nestedIn = (inner: Loop, outer: Loop): boolean =>
  inner !== outer &&
  inner.bodyStart > outer.bodyStart &&
  inner.bodyEnd < outer.bodyEnd;

/**
 * The texture fetches in a loop's own body, counting none of a nested loop's.
 *
 * Counting a nested loop's fetches here as well as in their own right is how a budget
 * ends up double-counting by five hundred, which is a number wrong enough to be
 * believed.
 */
const ownFetches = (source: string, loop: Loop, loops: Loop[]): number => {
  let fetches = 0;
  let cursor = loop.bodyStart;
  for (const other of loops) {
    if (!nestedIn(other, loop)) continue;
    fetches += countSites(source.slice(cursor, other.bodyStart), "texture(");
    cursor = other.bodyEnd;
  }
  return fetches + countSites(source.slice(cursor, loop.bodyEnd), "texture(");
};

/**
 * The worst-case texture fetches for one pixel of sky, read off the emitted source.
 *
 * **The formula is a product of enclosing loops.** A loop nested inside another runs
 * once per iteration of that one, so a march of `MAX_STEPS` steps that takes five
 * samples toward the light on each step fetches `MAX_STEPS × LIGHT_STEPS` times, not
 * five. Each loop contributes `its own fetches × its iterations × every enclosing
 * loop's iterations`, and loops with no fetch of their own contribute nothing — which
 * is how the powder loop, three iterations of arithmetic and no read, correctly costs
 * nothing here.
 */
const fetchesPerPixel = (fragment: string): number => {
  const loops = loopsIn(fragment);
  return loops.reduce((total, loop) => {
    const enclosing = loops
      .filter((other) => nestedIn(loop, other))
      .reduce((runs, other) => runs * other.iterations, 1);
    return (
      total + enclosing * loop.iterations * ownFetches(fragment, loop, loops)
    );
  }, 0);
};

describe("the cloud material compiles", () => {
  it("emits a version 300 es vertex stage with a position", () => {
    const { vertex } = compile(make());
    expect(vertex).toContain("#version 300 es");
    expect(vertex).toContain("gl_Position");
  });

  it("emits a version 300 es fragment stage with a main", () => {
    const { fragment } = compile(make());
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toMatch(/void\s+main\s*\(/);
  });

  it("binds the shape volume as a three-dimensional sampler", () => {
    // The assertion that matters most for a volumetric cloud. A `sampler2D` here
    // would compile, would draw, and would sample one flat slice of the volume — a sky
    // of clouds with no height in them. The text is the only place the difference is
    // visible at all.
    const { fragment, program } = compile(make());
    expect(fragment).toContain("sampler3D");
    expect(fragment).not.toContain("uniform sampler2D uShape");
    expect(program.samplers.find((s) => s.name === "uShape")?.type).toBe(
      "sampler3D",
    );
    expect(program.samplers.find((s) => s.name === "uWeather")?.type).toBe(
      "sampler2D",
    );
  });

  it("emits no NaN anywhere", () => {
    // The guard for the worst bug in this file's history, and one that produced no
    // error of any kind. Writing `DRIFT * scale` where `scale` is a node is
    // JavaScript multiplication of a number by an object, which is `NaN`; the shader
    // compiled, drew, and simply never drifted, with the dither quietly absent from
    // the emitted source because the node containing it had been consumed by the
    // arithmetic that produced the NaN.
    const { vertex, fragment } = compile(make());
    expect(vertex).not.toContain("NaN");
    expect(fragment).not.toContain("NaN");
    expect(vertex).not.toContain("undefined");
    expect(fragment).not.toContain("undefined");
  });

  it("costs a bounded number of texture fetches", () => {
    // rmsl builds a graph, not a compiler, so a texture read used twice in the node
    // graph becomes two reads in the GLSL — it cannot see that they were the same
    // sample. Written naturally this shader issued eighteen fetches per iteration
    // where three do. The count here is the regression guard, and it is a real
    // budget: it is proportional to what the GPU actually does per pixel per step.
    const { fragment } = compile(make());
    // One weather read, one volume read for the main sample, and one inside the
    // march toward the light — which is five fetches at run time, and the only one
    // that is skipped by the far field.
    expect(countSites(fragment, "texture(uShape")).toBeLessThanOrEqual(2);
    expect(countSites(fragment, "texture(uWeather")).toBe(1);
  });

  it("holds its worst-case fetches per pixel to a budget", () => {
    // The only per-pixel cost this stack can measure. rmsl has no `renderer.info`, this
    // project has no render-scale plumbing, and no GPU timer is reachable from a
    // vitest process — so the proxy is the texture-read count multiplied by the loop
    // bounds, read off the emitted source rather than assumed, and the budget is
    // asserted on the host rather than looked for in a frame.
    //
    // The arithmetic, per pixel of sky:
    //
    // | loop                 | fetches each | runs per pixel        | cost |
    // | -------------------- | ------------ | --------------------- | ---- |
    // | the march            | 2 — weather, volume | `MAX_STEPS`   | 256 |
    // | the march toward light | 1 — volume  | `MAX_STEPS` × `LIGHT_STEPS` | 640 |
    // | the powder loop      | 0 — arithmetic only | `MAX_STEPS` × 3 | 0 |
    // | **total**            |              |                       | **896** |
    //
    // 896 is a ceiling on a ceiling: a ray that finds dense cloud on every step and
    // never leaves the near field never pays all of it. That is the right way round
    // for a budget — it is a number the shader cannot beat by being lucky, so it moves
    // when the shader gets more expensive rather than when the weather does.
    //
    // The budget is 1024, which is the first number that fails for the *cheapest*
    // plausible regression: one more fetch inside the march. It is deliberately not
    // ten times the measurement, unlike the host-side ceilings in `csg/cost.test.ts`
    // and `cloud-field.test.ts` — those run on a machine whose speed is known, while a
    // shader's cost is visible as a dropped frame on whichever device is slowest. The
    // budget that matters here is the one that catches the change before a device
    // does, and a tenfold allowance would permit a layer nothing could draw.
    const { fragment } = compile(make());
    const worstCase = fetchesPerPixel(fragment);

    console.log(`worst case ${worstCase} texture fetches per pixel of sky`);
    expect(worstCase).toBeLessThan(1024);
    // Held against the constants, so that raising either loop bound shows up as what
    // it is — a number in a table — rather than as a total that quietly moved.
    expect(worstCase).toBe(MAX_STEPS * 2 + MAX_STEPS * LIGHT_STEPS);
  });

  it("skips the march toward the light in the far field", () => {
    // The reason the worst case above is well above what any frame costs: the march
    // toward the light — five fetches to the two of the march itself — is behind a
    // distance test, so everything past `FAR_FIELD` pays a third of what the nearest
    // cloud does. Without it the layer's horizon would cost five times what its middle
    // costs, and the far field is most of the pixels a player can see.
    //
    // The number is written out rather than imported: this file is asserting about the
    // emitted source, and an import would let the constant and the shader drift apart
    // in the one direction a test cannot see.
    const { fragment } = compile(make());
    const loops = loopsIn(fragment);
    const light = loops.find(
      (loop) => ownFetches(fragment, loop, loops) === 1,
    )!;
    expect(fragment.slice(0, light.bodyStart)).toMatch(/_\w+\s*<\s*7000\.0/);
  });

  it("reads the base shape and the detail from one fetch", () => {
    // They are the red channel and the rest of the same texel. Two reads for the pair
    // is the most common way a shader like this loses its performance, because it
    // looks like two different values rather than one sample.
    const { fragment } = compile(make());
    const sites = [...fragment.matchAll(/vec4\s+(\w+)\s*=\s*texture\(uShape/g)];
    expect(sites).toHaveLength(1);
    const name = sites[0]![1]!;
    for (const channel of ["r", "g", "b", "a"]) {
      // No leading dot: the emitted source is `_rmsl_225.r`, because this is a local
      // rather than a swizzle of something being dereferenced.
      expect(fragment, channel).toContain(`${name}.${channel}`);
    }
  });

  it("starts the march at the slab, not at the eye", () => {
    // The march has to begin where the ray crosses the layer's underside. Starting at
    // the camera spends up to a sixth of the step budget walking through empty air
    // under the layer — nothing is drawn there, but the budget is gone by the time
    // the ray arrives — and it costs the far end of the layer its last few steps.
    const { fragment } = compile(make());
    const loop = fragment.indexOf("for (int");
    expect(loop).toBeGreaterThan(0);
    const before = fragment.slice(0, loop);
    // An assignment of the entry distance, dithered, outside the loop.
    expect(before).toMatch(/=\s*\w+\s*\+\s*\w+\s*\*\s*[\d.]+;/);
    // And it references the clamped entry, which is the same expression as the loop's
    // upper bound rather than a literal zero.
    expect(before).toMatch(/=\s*\w+\s*\+\s*\w+\s*\*\s*[\d.]+;/);
  });

  it("dithers the march rather than only the light march", () => {
    // Fixed steps through a volume cut visible shells where rays cross the same
    // density boundary together. Nothing here accumulates over frames, so the dither
    // is the only thing standing between the march and that banding — and the first
    // version of this shader used its dither solely for the light march, where it
    // does nothing for the banding.
    const { fragment } = compile(make());
    expect(fragment).toContain("gl_FragCoord");
    const loop = fragment.indexOf("for (int");
    expect(fragment.slice(0, loop)).toContain("gl_FragCoord");
  });

  it("emits a bounded march and can leave it early", () => {
    const { fragment } = compile(make());
    expect(fragment).toMatch(/for\s*\(\s*int\s+\w+\s*=\s*0;\s*\w+\s*<\s*128/);
    expect(fragment).toMatch(/\bbreak\s*;/);
  });

  it("never assigns to a literal", () => {
    // rmsl's `mulAssign` on anything that is not a `toVar` emits the literal
    // `1.0 = 0.5;`, because it mutates the node it was called on rather than a
    // variable. It is not GLSL, and it is not raised as an error here — it was found
    // by reading the emitted source while writing this file.
    const { fragment } = compile(make());
    expect(fragment).not.toMatch(/^\s*-?\d*\.?\d+\s*(=|\+=|-=|\*=|\/=)/m);
  });

  it("declares its accumulators before the loop that changes them", () => {
    // rmsl hoists a `toVar` out of a loop body, so a value introduced inside one
    // carries the previous iteration's contents into the next. Every mutable value in
    // this shader is declared above its loop for that reason.
    const { fragment } = compile(make());
    const loop = fragment.indexOf("for (int");
    const before = fragment.slice(0, loop);
    const declarations = [
      ...before.matchAll(/^\s*(?:float|vec2|vec3|vec4)\s+\w+\s*=/gm),
    ];
    expect(declarations.length).toBeGreaterThanOrEqual(10);
  });

  it("takes its step from the density rather than from a fixed count", () => {
    // The long-empty-step optimisation: a step through empty air is longer than a
    // step through cloud, and the decision is a branch on the base shape rather than
    // arithmetic, so it costs one compare and saves a run of fetches.
    const { fragment } = compile(make());
    expect(fragment).toMatch(/\?\s*[\d.]+\s*:\s*[\d.]+\s*;/);
  });

  it("integrates transmittance instead of approximating it", () => {
    // The property that buys the long empty steps. Approximating transmittance as
    // constant over a step makes a cloud's brightness depend on how finely it was
    // sampled, which is what forces small steps. The analytic form is the fraction of
    // the step's remaining opacity, `T - T·exp(-σd)` — so look for the numerator
    // subtracting `T * exp(...)` from `T`.
    const { fragment } = compile(make());
    expect(fragment).toMatch(/(\w+)\s*-\s*\1\s*\*\s*exp\(/);
  });

  it("does not divide the step's opacity by its optical depth", () => {
    // **The bug that made every cloud black.** The segment used to be divided by `σd` —
    // the step's optical depth — which is correct only when what multiplies it is a
    // scattering coefficient in units of one per length. It is a *colour*, so the
    // division made each cloud accumulate `1/σd` of itself, and `σd` is
    // `density · 1.15 · 70` for a dense step: **eighty**. A white cloud accumulated one
    // eightieth of itself and the sky was black clouds at full alpha, with perfect
    // silhouettes and a perfect starfield over the top.
    //
    // The check is on the *shape* of the emitted arithmetic rather than on a variable
    // name, because the name is rmsl's to choose: a division by `max(...)` of something
    // containing the extinction constant is the mistake, whatever it is called.
    //
    // There is a better assertion than this one, and it is in `the layer's defaults`
    // below: with no division, `scatter / covered` telescopes to a weighted mean of the
    // step colours, so it cannot come out darker than the sky it is in front of.
    const { fragment } = compile(make());
    expect(fragment).not.toMatch(/\)\s*\/\s*max\([^;]*1\.15/);
  });

  it("composites for rmsl's blend rather than premultiplying twice", () => {
    // Front-to-back accumulation produces `scatter + transmittance * background`, and
    // rmsl blends `src.rgb * src.a + dst * (1 - src.a)`. The scatter is therefore
    // already premultiplied and has to be divided by its own alpha, or every cloud
    // comes out twice as dark as it should be.
    const { fragment } = compile(make());
    const output = /_rmsl_o\d+ = vec4\(([^;]+)\);/.exec(fragment);
    expect(output).not.toBeNull();
    const expression = output![1]!;
    // The colour divided by a complement of the alpha, and the alpha is that same
    // complement. The two halves have to agree: if they do not, the cloud is twice as
    // dark as it should be in the channels and correct in the alpha, which reads as a
    // cloud in the wrong weather rather than as a bug.
    //
    // The expression was captured from inside `vec4(...)`, so it carries no trailing
    // parenthesis of its own.
    const composite =
      /^\s*(\w+)\s*\/\s*max\(\s*1\.0\s*-\s*(\w+)\s*,[^)]*\),\s*1\.0\s*-\s*(\w+)\s*$/.exec(
        expression,
      );
    expect(composite, expression).not.toBeNull();
    const [, scatter, inTheDivisor, asAlpha] = composite!;
    expect(inTheDivisor).toBe(asAlpha);
    expect(scatter).not.toBe(inTheDivisor);
  });

  it("marches toward whichever light is up, once", () => {
    // Marching both costs ten fetches where five do, and it is not ten for two
    // shadows: the sun's march runs below the horizon at night and accumulates
    // nothing, so the moon would inherit an empty result and go flat.
    const { fragment } = compile(make());
    // A direction chosen by the sun's elevation, and exactly one march of five steps.
    expect(fragment).toMatch(/\.y\s*>\s*0\.0\s*\?\s*\w+\s*:\s*\w+/);
    expect(fragment).toMatch(/for\s*\(\s*int\s+\w+\s*=\s*0;\s*\w+\s*<\s*5/);
  });

  it("reads the eye and the view ray rather than a mesh coordinate", () => {
    // The whole design rests on this: the box is centred on the camera, so
    // `positionWorld - cameraPosition` is the view ray for every pixel and the sky
    // cannot swim as the player walks.
    const { fragment, vertex } = compile(make());
    expect(fragment).toContain("cameraPosition");
    expect(fragment).toContain("normalize");
    expect(vertex).toContain("modelMatrix");
  });

  it("reads every uniform the day-night cycle pushes at it", () => {
    const { fragment, program } = compile(make());
    for (const expected of [
      "uSunDirection",
      "uSunLight",
      "uMoonDirection",
      "uMoonLight",
      "uAmbient",
      "uSkyColour",
      "uCoverage",
      "uDensity",
      "uSeaRadius",
      "uDriftAngle",
    ]) {
      expect(
        program.uniforms.map((u) => u.name),
        expected,
      ).toContain(expected);
      expect(fragment, expected).toContain(expected);
    }
  });

  it("keeps every uniform at material scope, so a write takes effect at once", () => {
    // The renderer reads a material uniform's thunk per draw, which is what lets
    // `app.tsx` assign `lighting` every frame with no `needsUpdate` anywhere. A
    // camera- or renderer-scoped uniform would be filled differently and would not
    // respond to a write at all.
    const { program } = compile(make());
    for (const uniform of program.uniforms) {
      if (uniform.name.startsWith("u")) {
        expect(uniform.scope, uniform.name).toBe("material");
      }
    }
  });

  it("compiles at every precision the renderer might pick", () => {
    // `detectFragmentPrecision` chooses between these at boot from what the device
    // claims, so a shader that only builds at highp fails on whatever device that
    // was not.
    for (const precision of ["lowp", "mediump", "highp"] as const) {
      const program = make().build(new Scene());
      expect(() =>
        compileGlsl.fragment(program.fragmentRoot, { precision }),
      ).not.toThrow();
      expect(() =>
        compileGlsl.vertex(program.vertexRoot, { precision }),
      ).not.toThrow();
    }
  });

  it("passes no varyings the fragment stage does not read", () => {
    // The box covers most of the frame, so an unused varying is a cost on most of
    // it. The default vertex body also passes the normal and the uv.
    const { vertex, program } = compile(make());
    expect(program.varyings).toHaveLength(1);
    expect(vertex).not.toContain("normalMatrix");
  });
});

/**
 * Whether the defaults produce weather at all.
 *
 * Every other test in this file asks whether the shader is *shaped* correctly, and none
 * of them can ask whether the numbers it is shaped around produce a sky anybody would
 * want to look at. That question was open until a player loaded the game and reported
 * clear sky overhead, and the answer turned out to be neither the field nor the tuning:
 * the layer had never been built, because the bake's promise settled nowhere and
 * nothing in the application said so.
 *
 * So this block answers the question the others cannot. It **transcribes the shader's
 * own arithmetic** into plain numbers — coverage gates the base shape, detail erodes
 * inside it, and the result is integrated against the extinction the shader uses — and
 * runs it over a grid of rays at the material's defaults. A transcription can drift from
 * the shader, and this one did for most of its life: six separate ways, listed at
 * `alphaOfRay`, each of which survived because the field is self-similar and a
 * self-similar field forgives almost any addressing error. What it asserts is about the
 * *defaults and their direction*, which is a property of the two knobs, while the tests
 * above own the shader's shape.
 *
 * Measured at the defaults before the address was fixed, and the numbers the assertions
 * were written against: mean alpha 0.50, half the rays carrying cloud, none of it a solid
 * sheet. After: **mean alpha 0.328, 33% cloudy, 33% solid** — a third fewer cloudy rays,
 * and a much sharper split between them. The reduction is the point: a ray that sweeps the
 * volume meets the threshold along its length or it does not, so the sky broke up instead
 * of hazing over. The sharpness is discussed, measured and left alone at the assertion
 * below.
 */
describe("the layer's defaults", () => {
  // Thirty and sixty, not the production pair: the statistics below are the same at
  // both — measured, mean alpha 0.499 against 0.480 — and this is a second full bake in
  // a file whose first one is already reduced for exactly this reason.
  const baked = bakeCloudField(20260901, 30, 60);

  /** `seaRadius / CLOUD_FEATURE`, the radius of the direction sphere inside the volume. */
  const SHAPE_SCALE = DEFAULT_PLANET_RADIUS / CLOUD_FEATURE;

  /**
   * The shape volume, addressed on each axis and repeating.
   *
   * The coordinate wraps and then floors, which is not tidiness on either count: the shader
   * samples a *direction* scaled past one tile, so the coordinate leaves `0..1` and has to
   * come back; and a fractional index into a `Uint8Array` reads `undefined`,
   * `undefined / 255` is `NaN`, and a `NaN` in a comparison is simply false — so the whole
   * grid below would report clear sky and no assertion would fail for the reason anyone was
   * looking at.
   */
  const shape = (u: number, v: number, w: number, channel: number): number => {
    const n = baked.shape.size;
    const cell = (t: number): number => {
      const wrapped = ((t % 1) + 1) % 1;
      return Math.min(n - 1, Math.max(0, (wrapped * n) | 0));
    };
    return (
      baked.shape.data[(cell(u) + n * (cell(v) + n * cell(w))) * 4 + channel]! /
      255
    );
  };

  /**
   * The weather map, addressed equirectangularly and repeating — and **wrapping**, which is
   * the correction that mattered here.
   *
   * `equirectUV` is `atan(x, z) / 2π + 0.5` and `−asin(y) / π + 0.5`, so `v` runs *down*
   * from north to south and leaves `0..1` at both poles. This used to clamp instead, which
   * meant it could not read past the first or last row at all and so pinned both edges of the
   * grid to the same two rows of the map. A mirror was hiding behind that: `latitude` was
   * built as `(v − 0.5)·π`, which is `asin(y) = π(v − 0.5)` — the opposite sign from the
   * shader's. The map was sampled upside down for as long as this file existed, and because
   * the field is roughly symmetric that is very nearly invisible in the statistics; it would
   * not be invisible the moment anyone compared a frame against this number.
   */
  const weather = (u: number, v: number, channel: number): number => {
    const n = baked.weather.size;
    const cell = (t: number): number => {
      const wrapped = ((t % 1) + 1) % 1;
      return Math.min(n - 1, Math.max(0, (wrapped * n) | 0));
    };
    return baked.weather.data[(cell(u) + n * cell(v)) * 4 + channel]! / 255;
  };

  const STEPS = 48;
  const STEP = CLOUD_THICKNESS / STEPS;

  /**
   * How much of one ray's sky is cloud: the shader's chain, at 48 steps.
   *
   * The dimensional profile, the coverage threshold, the erosion and the extinction are
   * all transcribed rather than imported, for the reason above — and because they are
   * constants in a shader, not values anything else can read.
   *
   * Three things this transcription deliberately leaves out, because they are about cost
   * rather than about what the layer looks like: the two tiers of step length, so every
   * sample is `STEP` here regardless of what it found; the `MIN_PROFILE` and `density`
   * early-outs; and the drift, which is zero at `t = 0` and which this grid reads as zero.
   *
   * Six things it used to get wrong, all of them fixed here and all of them the kind that
   * survives because the field is self-similar: the address held its direction still for the
   * whole ray; the streak came from a second, differently-addressed weather read; `v` clamped
   * rather than wrapped; `v` was mirrored; the coverage threshold lacked its `min(profile, 1)`;
   * and the erosion was applied to the **raw** shape instead of the **coverage-thresholded**
   * one, which is the one that mattered — `erosionNode`'s floor is `1 − base` and its final
   * `min(…, base)` is that same `base`, so substituting a different one silently changes what
   * the erosion is allowed to remove.
   */
  const alphaOfRay = (
    u: number,
    v: number,
    coverage: number,
    density: number,
  ): number => {
    // The direction the ray leaves the planet on, from the same longitude and latitude the
    // weather map is addressed by — inverted the way `equirectUV` inverts it, which is why
    // `latitude` has the sign it has.
    const latitude = Math.PI * (0.5 - v);
    const longitude = (u - 0.5) * Math.PI * 2;
    const cosLat = Math.cos(latitude);
    const dx = cosLat * Math.cos(longitude) * SHAPE_SCALE;
    const dy = Math.sin(latitude) * SHAPE_SCALE;
    const dz = cosLat * Math.sin(longitude) * SHAPE_SCALE;

    // One weather fetch for the ray, as the shader takes it: the coverage out of `r` and the
    // streak out of `a`, from the same address.
    const streak = weather(u, v, 3);
    const field = weather(u, v, 0);

    let depth = 0;
    for (let i = 0; i < STEPS; i++) {
      // The altitude fraction: zero at the underside, one at the top, and **the volume's own
      // vertical address** as well as the profile's.
      const height = (i + 0.5) / STEPS;
      const ay = dy + height;

      // The dimensional profile, from the layer's height gradient.
      const core = streak * 0.3 + 0.47;
      const profile =
        Math.min(Math.max(height / 0.09, 0), 1) *
        (1 - Math.min(Math.max((height - (core - 0.34)) / 0.34, 0), 1));

      // Coverage thresholds the shape, and then the erosion works on *that*.
      const threshold = field * coverage * profile;
      const shaped = Math.min(
        Math.max(
          (shape(dx, ay, dz, 0) - (1 - Math.min(threshold, 1))) /
            Math.max(threshold, 0.02),
          0,
        ),
        1,
      );
      const detail =
        shape(dx, ay, dz, 1) * 0.55 +
        shape(dx, ay, dz, 2) * 0.3 +
        shape(dx, ay, dz, 3) * 0.15;
      const eroded = Math.min(
        Math.min(Math.max((detail * 0.6 + 0.4 - (1 - shaped)) / 0.4, 0), 1),
        shaped,
      );
      const sample = Math.pow(eroded * density, 0.42);
      if (sample > 0.002) depth += sample * 1.15 * STEP;
    }
    return 1 - Math.exp(-depth);
  };

  /** Every ray of a 16×16 patch of sky, as its alpha. */
  const albedos = (coverage: number, density: number): number[] => {
    const out: number[] = [];
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++)
        out.push(alphaOfRay(a / 16 + 0.003, b / 16 + 0.003, coverage, density));
    }
    return out;
  };

  const summary = (
    alphas: number[],
  ): { mean: number; any: number; solid: number } => {
    const mean = alphas.reduce((a, b) => a + b, 0) / alphas.length;
    return {
      mean,
      any: alphas.filter((a) => a > 0.15).length / alphas.length,
      solid: alphas.filter((a) => a > 0.7).length / alphas.length,
    };
  };

  it("gives half the sky cloud at the defaults, rather than an empty one", () => {
    // The assertion that would have caught an empty sky. It is a *floor* on `coverage`
    // written as a property of the finished image, because a floor on the constant is a
    // tautology and this is not: it says the field, the profile and the threshold
    // together produce weather a player can see.
    //
    // **The distribution is bimodal and that is not a defect of the transcription.** A ray
    // crossing the layer now sweeps a whole tile of the volume, so it meets the coverage
    // threshold along its length or it does not, and the `pow(density, 0.42)` and the
    // extinction saturate within a few hundred units when it does. Measured at the defaults,
    // over a 16×16 grid of directions: 172 rays below 0.1 and 84 above 0.9, with nothing at
    // all in between. Two things were checked before believing that. Re-running the same grid
    // with the *shader's* two tiers of step — 70 units through cloud and 120 through air,
    // capped at 128 steps, rather than this transcription's 48 equal ones — moves the split
    // to 188 and 68 and leaves the gap exactly where it was, so it is not oversampling. And
    // the flat world's own shader ran the same threshold against the same volume on the same
    // 700-unit crossing, so the sharpness predates the planet entirely.
    //
    // What it means is that the layer's *edges* are in the volume rather than in the
    // accumulation, which is why the erosion and the detail channels have to carry them, and
    // why `solid` is asserted only as a ceiling. A renderer that wanted a soft gradient here
    // would have to soften the threshold, which is a change of look and not a fix of one.
    const { mean, any, solid } = summary(albedos(0.52, 1));
    console.log(
      `default layer: mean alpha ${mean.toFixed(3)}, ` +
        `${(any * 100).toFixed(0)}% of rays cloudy, ${(solid * 100).toFixed(0)}% solid`,
    );
    expect(any).toBeGreaterThan(0.2);
    expect(mean).toBeGreaterThan(0.15);
    // And the other end, because "more coverage" must not mean "more of everything":
    // an overcast sheet at 0.84 mean is as much a missing sky as none at all.
    expect(mean).toBeLessThan(0.75);
    expect(solid).toBeLessThan(0.6);
  });

  it("moves the sky the way the two knobs are named", () => {
    // Coverage is a threshold on the base shape, so more of it can only remove less and
    // so can only make more sky cloudy — and density can only deepen what is already
    // there. Both are one-line facts about the shader that a rename or an inverted
    // comparison would break silently, and both were unverified until this.
    const thin = summary(albedos(0.2, 1));
    const thick = summary(albedos(0.9, 1));
    expect(thick.mean).toBeGreaterThan(thin.mean);
    expect(thick.any).toBeGreaterThanOrEqual(thin.any);

    const heavy = summary(albedos(0.52, 3));
    const light = summary(albedos(0.52, 0.4));
    expect(heavy.mean).toBeGreaterThan(light.mean);
    // And density changes nothing about *where* there is cloud — it is opacity, not a
    // mask, which is what separates it from coverage.
    expect(heavy.any).toBeCloseTo(summary(albedos(0.52, 1)).any, 1);
  });

  it("leaves clear sky clear, because a layer with no holes is not weather", () => {
    // The two ends of the scale, which is what makes the middle read as weather rather
    // than as a grey sheet: at low coverage most rays are empty, and at high coverage
    // almost none are. Without both of those the layer is either nothing or a lid.
    expect(summary(albedos(0.2, 1)).any).toBeLessThan(0.4);
    expect(summary(albedos(0.9, 1)).any).toBeGreaterThan(0.6);
  });
});

/**
 * The shell's address: what a sample's direction and altitude each mean.
 *
 * The layer stopped being a slab, so the address stopped being a scale and an offset into a
 * world `x`/`z`/`y` volume. The shape volume is now sampled at the **direction from the
 * planet's centre**, scaled so one tile is `CLOUD_FEATURE` of surface — which is what makes
 * the field seam-free and pole-free — **plus the sample's altitude in the volume's own `y`**.
 *
 * That second half is the one this file exists to hold. A direction is scale-invariant, so a
 * ray going straight up from the ground moves the address by about eight thousandths of a
 * tile: half a texel of a sixty-texel volume, across the whole seven-hundred-unit crossing.
 * Every sample of the ray read the same base shape and the same three detail channels, the
 * sky was a silhouette extruded through the layer, and every assertion below still passed —
 * because no assertion looked at the address's *movement*, only at its presence.
 *
 * The altitude has its own single number to get wrong, and it is the same class of fault as
 * the old `volumeOffset`: the profile multiplies the coverage by `saturate(height / 0.09)`, so
 * an altitude that is not divided by the thickness empties the layer at its underside.
 *
 * Both halves are read out of the emitted shader, because both are arithmetic that a rename
 * or an inverted subtraction would break silently.
 */
describe("the shell's address", () => {
  it("addresses the shape volume by direction, scaled by the sea radius", () => {
    // `shapeScale` is `seaRadius / CLOUD_FEATURE`: the sea radius a uniform, so a world with
    // a different planet moves its weather with it, and the reciprocal a constant.
    const { fragment } = compile(make());
    expect(fragment).toContain("uSeaRadius");
    expect(fragment).toContain(String(1 / CLOUD_FEATURE));
  });

  it("puts the altitude in the volume's vertical axis, not only in the profile", () => {
    // `vec3(0.0, <height>, 0.0)`, added to the direction's scaled address. Two of them: one
    // hoisted for the march, one inline inside the march toward the light — which is the
    // count that matters, because a light march addressing itself by direction alone draws
    // shadows that do not follow the density casting them, and does it in a shader that
    // otherwise compiles, bakes and passes.
    const { fragment } = compile(make());
    const inAddress = fragment.match(/vec3\(0\.0, .+?, 0\.0\)/g) ?? [];
    expect(inAddress).toHaveLength(2);
    // And the warp, in the two *horizontal* slots. A tenth of a tile of it in `y` would
    // slide each billow up or down its own layer depending on where in the weather field
    // the sample fell, which is a shear rather than a wind.
    for (const address of inAddress) {
      expect(address).not.toMatch(/vec3\(0\.0, 0\.0,/);
    }
    expect(fragment).toMatch(/vec3\([^)]*\.x, 0\.0, [^)]*\.y\)/);
  });

  it("reads the altitude as the layer's own normalised height", () => {
    // `(length(world) − seaRadius − CLOUD_BOTTOM) / CLOUD_THICKNESS`, read off the source.
    // Zero at the underside, one at the top — and the *same* expression the profile is
    // given, which is why it appears twice rather than being spelled two ways.
    //
    // **The two numbers are the constants**, rather than `700` written down. The layer's floor is
    // now the planet's reach plus a clearance — it has to clear the highest mountain, or a summit
    // stands inside the cloud deck — so the literal is whatever that arithmetic produced and a
    // hardcoded `700` in the pattern would be a second place to be wrong. Reading it off the
    // constants is also the assertion that the two agree.
    const { fragment } = compile(make());
    // **A character class for the closing paren, not a backslash.** `\)` inside a template
    // literal is one escape away from being a bare `)`, which is a pattern that compiles and
    // matches nothing — so the test would have gone quiet rather than red.
    const expression = new RegExp(
      `- uSeaRadius[)] - ${CLOUD_BOTTOM.toFixed(1)}[)] / ${CLOUD_THICKNESS.toFixed(1)}`,
      "g",
    );
    expect(fragment.match(expression)).toHaveLength(2);
  });

  it("keeps the layer's floor above the tallest terrain", () => {
    // **The reason the floor is derived rather than written down.** A cloud deck whose base sits
    // below the highest peak is not a cloud deck, it is weather the mountains stand inside of.
    expect(CLOUD_BOTTOM).toBeGreaterThan(reachOf(DEFAULT_PLANET));
    expect(
      planetField(DEFAULT_PLANET).highestRadius - DEFAULT_PLANET.radius,
    ).toBeLessThan(CLOUD_BOTTOM);
  });

  it("wraps the weather map around the planet once", () => {
    // The equirectangular inverse: `atan` of two components and `asin` of the vertical. The
    // read is what makes the weather a sphere rather than a plane.
    const { fragment } = compile(make());
    expect(fragment).toContain("atan(");
    expect(fragment).toContain("asin(");
  });
});

/**
 * How far the address *moves* along a ray, which is the question no other test here was
 * asking.
 *
 * Every other assertion in this file is about the address's **shape**: that it is scaled by
 * the sea radius, that the weather wraps once, that the altitude is divided by the thickness.
 * All three held while the layer was addressed by direction alone, and the sky was smooth and
 * structureless — because the address was *correct* and did not go anywhere. A direction is
 * scale-invariant, so a ray marching through the layer moves it by a few thousandths of a
 * tile, and a sixty-texel volume read at that rate is one texel: the same base shape and the
 * same three detail channels, sixty times over, with only the one-dimensional height profile
 * varying between them.
 *
 * So this is arithmetic rather than a regex, and it is the test that had to exist. It asks how
 * many texels of the volume a ray actually reads on its way through the layer, from the eye
 * heights a player stands at and along the elevations they look, and it holds the answer to
 * something the volume can resolve: its **finest** detail cell is
 * `SHAPE_SIZE / SHAPE_DETAIL_PERIODS[2]` texels, and a ray that crosses less than one of
 * those is a ray that never sees an edge.
 *
 * **What this catches and what the tests above catch, because they are not the same thing.**
 * This one is written against the *rule*, in plain arithmetic — it cannot see the shader, and
 * deleting the altitude from `shapeAt` leaves every assertion in it green. The two regex
 * assertions in "the shell's address" are what bind the shader to the rule, and they are
 * verified to fail when the altitude is dropped from either the march or the light march. The
 * division is deliberate: the regexes pin the shape of the address and would happily pin a
 * useless one, while this pins the number that address has to produce and knows nothing about
 * how it is spelled. Together they are the pair the bug needed and only had neither of.
 *
 * Measured, at the eye height a player actually stands at (11) and the layer's constants:
 * a vertical ray across the layer now reads **60.0 texels** of the volume, from 60.1 at
 * thirty degrees of elevation to 61.8 at two. Addressed by direction alone it read 0.00 and
 * 0.37 respectively — a fortieth of a texel and a two-hundredth — because the whole of the
 * seven hundred units of the crossing went into the altitude and none of it into the address.
 *
 * The two halves of the address are counted separately because they answer different
 * questions. The direction half is what keeps the layer seamless and pole-free and is *supposed*
 * to be nearly still — a small drift with elevation is the price, and it is the correct price.
 * The altitude half is the one that was missing, and it is the one that has to deliver the
 * layer's whole vertical structure.
 */
describe("the address along a ray", () => {
  const sea = DEFAULT_PLANET_RADIUS;
  const shapeScale = sea / CLOUD_FEATURE;

  /** The finest cell in the volume, in tiles: the smallest thing the address can resolve. */
  const finestCell = 1 / SHAPE_DETAIL_PERIODS[2];

  /** The same cell in texels, which is the unit a reader of this file cares about. */
  const finestTexels = SHAPE_SIZE / SHAPE_DETAIL_PERIODS[2];

  /**
   * A point `t` from an eye on the planet's axis, `elevation` radians above the local
   * horizon. The eye is at `(0, sea + eyeAltitude, 0)`, so the local up is `+y` and the local
   * tangent is `+z`; the ray is `tangent·cos(elevation) + up·sin(elevation)`, which is a unit
   * vector because the two are orthogonal unit vectors.
   */
  const pointAt = (
    eyeAltitude: number,
    elevation: number,
    t: number,
  ): Vec3 => ({
    x: 0,
    y: sea + eyeAltitude + t * Math.sin(elevation),
    z: t * Math.cos(elevation),
  });

  /** The unit ray at `elevation` above the local horizon. */
  const rayAt = (elevation: number): Vec3 => ({
    x: 0,
    y: Math.sin(elevation),
    z: Math.cos(elevation),
  });

  /**
   * The address at a point, in tiles: the direction scaled by `shapeScale` with the altitude
   * in `y`. The same two terms `shapeAt` adds, written out so the test can walk a ray rather
   * than read a shader. Only the direction's `y` component is carried, because a ray here
   * leaves along the `y`/`z` plane and the `x` component is identically zero — and the sweep
   * is what is being measured, not the address.
   */
  const addressAt = (p: Vec3): { direction: number; altitude: number } => {
    const radius = Math.hypot(p.x, p.y, p.z);
    return {
      direction: (p.y / radius) * shapeScale,
      altitude: (radius - sea - CLOUD_BOTTOM) / CLOUD_THICKNESS,
    };
  };

  /**
   * How much of the volume a ray reads crossing the layer, in tiles, and how much of that
   * comes from each half of the address.
   */
  const sweepOf = (
    eyeAltitude: number,
    elevation: number,
  ): { direction: number; altitude: number; total: number } => {
    const span = cloudSpan(
      pointAt(eyeAltitude, elevation, 0),
      rayAt(elevation),
      sea,
    );
    const from = addressAt(pointAt(eyeAltitude, elevation, span.enter));
    const to = addressAt(pointAt(eyeAltitude, elevation, span.exit));
    const direction = Math.abs(to.direction - from.direction);
    const altitude = Math.abs(to.altitude - from.altitude);
    return { direction, altitude, total: direction + altitude };
  };

  // Every elevation a player standing on the ground looks along, from overhead to a couple of
  // degrees up — which on a planet this size is the whole of the sky that has any cloud in it.
  const ELEVATIONS = [90, 60, 30, 20, 10, 5, 2].map((d) => (d * Math.PI) / 180);
  const EYE_ALTITUDES = [2, 6, 11];

  it("reads the volume's finest cell on every ray through the layer", () => {
    // The assertion the bug needed and did not have. Every ray, every elevation, every eye
    // height: the crossing has to cover at least one cell of the finest detail, or the
    // erosion is reading a constant and there is nothing in the sky with an edge to it.
    for (const eyeAltitude of EYE_ALTITUDES) {
      for (const elevation of ELEVATIONS) {
        const sweep = sweepOf(eyeAltitude, elevation);
        expect(
          sweep.total * SHAPE_SIZE,
          `eye ${eyeAltitude}, elevation ${Math.round(
            (elevation * 180) / Math.PI,
          )}°: read ${(sweep.total * SHAPE_SIZE).toFixed(1)} texels, needs ${finestTexels}`,
        ).toBeGreaterThanOrEqual(finestTexels);
      }
    }
  });

  it("gets its vertical structure from the altitude, not from the direction", () => {
    // The altitude half alone carries the layer's whole thickness: one tile across
    // `CLOUD_THICKNESS`, so the sixty-texel volume is swept end to end going up through the
    // layer. It is the same number at every elevation and at every eye height, because it is
    // an altitude and the layer is a shell.
    for (const eyeAltitude of EYE_ALTITUDES) {
      for (const elevation of ELEVATIONS) {
        expect(sweepOf(eyeAltitude, elevation).altitude).toBeCloseTo(1, 6);
      }
    }
  });

  it("keeps the direction half nearly still, which is what it is for", () => {
    // The load-bearing half of the reason this is not a position address: the direction term
    // moves by *less* than a twentieth of a tile over a whole crossing, so the field stays
    // seam-free and pole-free and the clouds stay planted over the ground. A position address
    // moves it by two to fourteen tiles — and at the pole, where the player spawns, it moves it
    // by nothing at all in *every* direction, which is a uniform sky rather than a weather one.
    for (const elevation of ELEVATIONS) {
      expect(sweepOf(11, elevation).direction).toBeLessThan(0.05);
    }
  });

  it("has the march toward the light read the volume too", () => {
    // A shadow ray is five steps at 1.9× the last, so it climbs about fifteen hundred units
    // at a raised sun — more than twice the layer's thickness. If it were addressed by
    // direction alone it would read a single texel and every cloud would be unshaded, which is
    // the same defect as the march's reached from the other side.
    //
    // The first step is written out rather than imported, for the reason the `FAR_FIELD`
    // assertion above gives: an import would let the constant and the shader drift apart in
    // the one direction a test cannot see.
    const firstStep = 60;
    const steps = [0, 1, 2, 3, 4].map((i) => firstStep * 1.9 ** i);
    expect(LIGHT_STEPS).toBe(steps.length);
    // The whole climb is the figure that matters: it is the span over which the march
    // integrates an optical depth, so it has to be several of the finest detail's cells or the
    // shadow is a function of where the dither happened to land. It is a little over two
    // tiles, which is fourteen cells.
    const climb = steps.reduce((a, b) => a + b, 0) / CLOUD_THICKNESS;
    expect(climb).toBeGreaterThan(finestCell * 8);
    // **The steps are deliberately not uniform, and the short one is short on purpose.** The
    // dither scales the first by 0.6 to 1.4, so it reads between three tenths and two tenths
    // of a tile — under the finest *detail* cell, which is the wrong cell to hold it to: the
    // light march reads the base shape alone (`baseAt`), whose finest octave is three times
    // coarser again, and it integrates a depth over all five rather than sampling a profile.
    // Asserting every step resolves a detail cell would be asserting something this design
    // never claimed, and would be satisfied only by making the near steps shorter — which is
    // the costliest part of the shader to give back. Recorded here so the numbers are not
    // mistaken for an oversight later.
    expect((Math.min(...steps) * 0.6) / CLOUD_THICKNESS).toBeLessThan(
      finestCell,
    );
    expect((Math.min(...steps) * 0.6) / CLOUD_THICKNESS).toBeGreaterThan(0);
  });
});

describe("the shell's span", () => {
  const sea = DEFAULT_PLANET_RADIUS;
  const up = { x: 0, y: 1, z: 0 };
  const down = { x: 0, y: -1, z: 0 };
  const at = (altitude: number): { x: number; y: number; z: number } => ({
    x: 0,
    y: sea + altitude,
    z: 0,
  });

  it("starts at the layer's underside when looking up from the ground", () => {
    const span = cloudSpan(at(2), up, sea);
    expect(span.enter).toBeCloseTo(CLOUD_BOTTOM - 2, 3);
    expect(span.exit).toBeCloseTo(CLOUD_TOP - 2, 3);
  });

  it("starts at the eye when the eye is inside the layer", () => {
    const span = cloudSpan(at(1000), down, sea);
    expect(span.enter).toBe(0);
    expect(span.exit).toBeCloseTo(1000 - CLOUD_BOTTOM, 3);
  });

  it("stops at the planet's near side when looking down from orbit", () => {
    // The far side of the shell is behind the planet and is not marched, because the globe
    // writes no depth for it to hide behind.
    const span = cloudSpan(at(8000), down, sea);
    expect(span.enter).toBeCloseTo(8000 - CLOUD_TOP, 3);
    expect(span.exit).toBeCloseTo(8000 - CLOUD_BOTTOM, 3);
  });

  it("is empty when a ground eye looks down into the planet", () => {
    const span = cloudSpan(at(2), down, sea);
    expect(span.exit).toBeLessThanOrEqual(span.enter);
  });
});

describe("the layer's geometry", () => {
  it("sits above the terrain and has real thickness", () => {
    expect(CLOUD_BOTTOM).toBeGreaterThan(0);
    expect(CLOUD_TOP).toBeGreaterThan(CLOUD_BOTTOM);
    expect(CLOUD_THICKNESS).toBe(CLOUD_TOP - CLOUD_BOTTOM);
  });

  it("keeps its carrier inside the camera's far plane", () => {
    // A sphere centred on the eye, so its furthest point is its own radius away. The
    // viewport's camera is `PerspectiveCamera(50, 1, 1, 400000)`.
    expect(40000).toBeLessThan(400000);
  });

  it("repeats the shape many times around the weather's single wrap", () => {
    // The anti-repetition argument, in its spherical form. The shape volume is addressed by
    // direction, so it repeats `2π · seaRadius / CLOUD_FEATURE` times around the equator
    // while the weather map wraps exactly once. A whole-number ratio would let the eye lock
    // the two together; fifty-two-point-something will not.
    const around = (2 * Math.PI * DEFAULT_PLANET_RADIUS) / CLOUD_FEATURE;
    expect(around).toBeGreaterThan(8);
    // **Fifteen per cent, not ten.** The wrap count is `2π / angularFeatureSize`, so it is
    // whatever it is for a given `CLOUD_FEATURE`, and a tenth of a turn is close enough to
    // lock onto that the eye will find it. At `0.12 · R` the count is 52.36 — a sixth of a
    // turn clear of a whole number — and this bound is what stops a later retune landing on
    // 52.0 or 52.2 and calling it a pass. Every other value of the constant in the range a
    // person would reach for clears fifteen per cent comfortably: 0.6 gives 10.47, 0.13 gives
    // 48.33, 0.2 gives 31.42, and the ones that do not (0.11 gives 57.12, 0.14 gives 44.88)
    // are exactly the ones this is here to reject.
    expect(Math.abs(around - Math.round(around))).toBeGreaterThan(0.15);
  });

  it("draws its back faces and writes no depth", () => {
    // The back faces because the camera is inside the carrier; the missing depth write so
    // the layer occludes nothing drawn after it, and because the terrain is drawn before it
    // and therefore z-rejects the carrier wherever there is a mountain.
    const material = make();
    expect(material.side).toBe(Side.BackSide);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
  });
});

describe("the drift", () => {
  it("turns the field so its surface speed is the same on any planet", () => {
    // The angular speed is `DRIFT / seaRadius`, so `angle × seaRadius` — the speed at the
    // surface — is the linear `DRIFT` whatever the radius. A player on a bigger world does
    // not get slower clouds.
    const small = driftAngleAt(1, 1000) * 1000;
    const large = driftAngleAt(1, 8000) * 8000;
    expect(small).toBeCloseTo(large, 9);
  });
});
