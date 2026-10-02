import { compileGLSL } from "@random-mesh/rmsl";
import { Scene, Side } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import {
  CLOUD_BOTTOM,
  CLOUD_FEATURE,
  CLOUD_THICKNESS,
  CLOUD_TOP,
  LIGHT_STEPS,
  MAX_STEPS,
  WEATHER_FEATURE,
  CloudMaterial,
} from "./clouds";
import { bakeCloudField } from "./cloud-field";
import { shapeTexture, weatherTexture } from "./cloud-textures";

/**
 * Compiling a material needs no graphics device.
 *
 * `NodeMaterial.build` turns the node graph into roots plus the exact set of bindings
 * the graph reaches, and `compileGLSL` renders those to GLSL ES 3.00. Both are
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
    vertex: compileGLSL.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGLSL.fragment(program.fragmentRoot, {
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
      "uTime",
      "uSunDirection",
      "uSunLight",
      "uMoonDirection",
      "uMoonLight",
      "uAmbient",
      "uSkyColour",
      "uCoverage",
      "uDensity",
      "uDriftX",
      "uDriftZ",
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
        compileGLSL.fragment(program.fragmentRoot, { precision }),
      ).not.toThrow();
      expect(() =>
        compileGLSL.vertex(program.vertexRoot, { precision }),
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
 * the shader, and this one will: what it asserts is about the *defaults and their
 * direction*, which is a property of the two knobs, while the tests above own the
 * shader's shape.
 *
 * Measured at the defaults, and the numbers the assertions are written against:
 * mean alpha 0.50, half the rays carrying cloud, none of it a solid sheet.
 */
describe("the layer's defaults", () => {
  // Thirty and sixty, not the production pair: the statistics below are the same at
  // both — measured, mean alpha 0.499 against 0.480 — and this is a second full bake in
  // a file whose first one is already reduced for exactly this reason.
  const baked = bakeCloudField(20260901, 30, 60);

  /**
   * The shape volume, addressed in 0..1 on each axis and repeating.
   *
   * Floored and clamped, which is not tidiness: a fractional index into a `Uint8Array`
   * reads `undefined`, `undefined / 255` is `NaN`, and a `NaN` in a comparison is
   * simply false — so the whole grid below would report clear sky and no assertion
   * would fail for the reason anyone was looking at.
   */
  const shape = (u: number, v: number, w: number, channel: number): number => {
    const n = baked.shape.size;
    const cell = (t: number): number =>
      Math.min(n - 1, Math.max(0, (t * n) | 0));
    return (
      baked.shape.data[(cell(u) + n * (cell(v) + n * cell(w))) * 4 + channel]! /
      255
    );
  };

  /** The weather map, addressed in 0..1 on each axis and repeating. */
  const weather = (u: number, v: number, channel: number): number => {
    const n = baked.weather.size;
    const cell = (t: number): number =>
      Math.min(n - 1, Math.max(0, (t * n) | 0));
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
   */
  const alphaOfRay = (
    u: number,
    w: number,
    coverage: number,
    density: number,
  ): number => {
    let depth = 0;
    for (let i = 0; i < STEPS; i++) {
      const height = (i + 0.5) / STEPS;
      const streak = weather(u, w * 3, 3);
      const core = streak * 0.3 + 0.47;
      const profile =
        Math.min(height / 0.09, 1) *
        (1 - Math.min(Math.max((height - (core - 0.34)) / 0.34, 0), 1));
      const threshold = Math.max(weather(u, w, 0) * coverage * profile, 0.02);
      const base = shape(u, height, w, 0);
      const detail =
        shape(u, height, w, 1) * 0.55 +
        shape(u, height, w, 2) * 0.3 +
        shape(u, height, w, 3) * 0.15;
      const eroded = Math.min(
        Math.max((detail * 0.6 + 0.4 - (1 - base)) / 0.4, 0),
        1,
      );
      const sample = Math.pow(
        Math.min(
          eroded,
          Math.min(Math.max(base - (1 - threshold), 0) / threshold, 1),
        ) * density,
        0.42,
      );
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
 * The volume's address: where a world altitude lands in the shape volume.
 *
 * The single most consequential number in the shader, and the one whose fault was
 * invisible for as long as it was there. The shape volume's third axis is the layer's
 * *thickness*, so an altitude has to address it as `(y - CLOUD_BOTTOM) / THICKNESS` —
 * 0 at the underside, 1 at the top. Written as a scale and an offset that is
 * `1 / THICKNESS` and `-CLOUD_BOTTOM / THICKNESS`, and subtracting the altitude instead
 * leaves every sample at about −699. The dimensional profile then multiplies the
 * coverage by `saturate(height / 0.09)`, so the coverage was multiplied by zero at every
 * height in the layer, and the sky had no clouds in it at all — with the layer built, its
 * shader compiling, its field well-formed, and every other assertion in this file green.
 *
 * So the assertion is on the address's own arithmetic, read out of the emitted shader:
 * the layer's underside must address zero and its top must address one. Those two
 * numbers are what the density threshold consumes, and nothing else in the file would
 * have noticed their being wrong.
 */
describe("the volume's address", () => {
  /**
   * The scale and the offset, read out of the emitted shader.
   *
   * Matched by pattern rather than by "every `vec3(...)` on the line", because the
   * offset is `vec3(fract(uDriftX), …)` and a `[^)]*` cannot span `fract`'s own
   * parentheses — it stops inside the first one and hands back `fract(uDriftX`, which
   * parses as `NaN` and is the same rmsl trap the file's own header warns about, in a
   * different costume.
   */
  const addressOf = (
    fragment: string,
  ): { scale: number[]; offset: number[] } => {
    const scale =
      /\*\s*vec3\(\s*([\d.eE+-]+),\s*([\d.eE+-]+),\s*([\d.eE+-]+)\s*\)/.exec(
        fragment,
      );
    const offset =
      /vec3\(\s*fract\(uDriftX\),\s*([\d.eE+-]+),\s*fract\(uDriftZ\)\s*\)/.exec(
        fragment,
      );
    if (scale === null || offset === null) {
      throw new Error(
        "the volume's scale and offset were not found in the shader",
      );
    }
    return {
      scale: [Number(scale[1]), Number(scale[2]), Number(scale[3])],
      // The two drifts are a tile fraction each and take no part in the arithmetic here.
      offset: [0, Number(offset[1]), 0],
    };
  };

  it("maps the layer's altitudes onto the volume's whole range", () => {
    // The single most consequential number in the shader, and the one whose fault was
    // invisible for as long as it was there. The shape volume's third axis is the
    // layer's *thickness*, so an altitude addresses it as
    // `(y - CLOUD_BOTTOM) / CLOUD_THICKNESS` — 0 at the underside, 1 at the top.
    //
    // Subtracting the altitude instead leaves every sample at about −699, and the
    // dimensional profile multiplies the coverage by `saturate(height / 0.09)`, so the
    // coverage became zero at every height in the layer: a sky with no clouds in it at
    // all, at every hour, with the layer built, its shader compiling, its field
    // well-formed, and every other assertion in this file green.
    //
    // The two numbers asserted here are what the density threshold consumes, and nothing
    // else in this file would have noticed their being wrong.
    const { scale, offset } = addressOf(compile(make()).fragment);
    expect(scale[1]! * CLOUD_BOTTOM + offset[1]!).toBeCloseTo(0, 9);
    expect(scale[1]! * CLOUD_TOP + offset[1]!).toBeCloseTo(1, 9);
    // And so the offset is the altitude *divided by the thickness*, which is the half
    // that was wrong: it matters whenever the two differ, which they do for any layer
    // that does not start at zero.
    expect(scale[1]!).toBeCloseTo(1 / CLOUD_THICKNESS, 12);
    expect(offset[1]!).toBeCloseTo(-CLOUD_BOTTOM / CLOUD_THICKNESS, 9);
  });

  it("repeats on x and z in tiles of the shape feature, and in no altitude", () => {
    // The horizontal axes are the drift's business: `CLOUD_FEATURE` units to a tile, and
    // an offset that is a tile fraction and nothing else. Getting the vertical wrong the
    // way it was wrong put an altitude into an axis that has no altitude in it.
    const { scale, offset } = addressOf(compile(make()).fragment);
    expect(scale[0]!).toBeCloseTo(1 / CLOUD_FEATURE, 12);
    expect(scale[2]!).toBeCloseTo(1 / CLOUD_FEATURE, 12);
    expect(offset[0]!).toBe(0);
    expect(offset[2]!).toBe(0);
  });
});

describe("the layer's geometry", () => {
  it("sits above the terrain and has real thickness", () => {
    expect(CLOUD_BOTTOM).toBeGreaterThan(0);
    expect(CLOUD_TOP).toBeGreaterThan(CLOUD_BOTTOM);
    expect(CLOUD_THICKNESS).toBe(CLOUD_TOP - CLOUD_BOTTOM);
  });

  it("keeps its box inside the camera's far plane", () => {
    // Otherwise the corners are clipped and the sky has holes in it. The viewport's
    // camera is `PerspectiveCamera(50, 1, 1, 100000)`.
    const half = 40000;
    expect(half * Math.sqrt(3)).toBeLessThan(100000);
  });

  it("repeats the two fields on a joint period beyond the view", () => {
    // The single most important number in the sky. One field at one scale is a
    // texture; two fields are weather only if the eye cannot see them repeat
    // *together*, and the eye cannot do that as long as their joint period is longer
    // than the distance being looked at.
    //
    // The ratio being a whole number is not the problem and does not need to be
    // dodged: 48 000 over 2 400 is twenty to one, an unremarkable ratio. What matters
    // is that the least common repeat is the weather map's own period, so at a reach
    // of seventeen thousand there is no common repeat anywhere in view.
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const joint =
      (CLOUD_FEATURE * WEATHER_FEATURE) / gcd(CLOUD_FEATURE, WEATHER_FEATURE);
    expect(joint).toBe(WEATHER_FEATURE);
    // Longer than the march's reach, which is seventeen thousand units. Forty-eight
    // thousand is 2.8 times that, and by the far end of the march the aerial
    // perspective has taken more than half the contrast out anyway — so the point
    // where both fields would line up again is somewhere the sky has already faded to
    // nothing. Two and a half times would be the number to hold this to.
    expect(joint).toBeGreaterThan(17000 * 2);
  });

  it("draws its back faces and writes no depth", () => {
    // The back faces because the camera is inside the box; the missing depth write so
    // the layer occludes nothing drawn after it, and because the terrain is drawn
    // before it and therefore z-rejects the box wherever there is a mountain.
    const material = make();
    expect(material.side).toBe(Side.BackSide);
    expect(material.depthWrite).toBe(false);
    expect(material.transparent).toBe(true);
  });
});
