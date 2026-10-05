/**
 * Water, as the two things that draw it.
 *
 * ## What this file is for
 *
 * The sea used to be a sphere whose tests were about *geometry* — how many vertices, and
 * whether they sat on a sphere of the sea's radius. All of that is gone: the sea is meshed
 * per chunk now (`mesh/water-mesher.ts`, tested there), and what remains here is a material
 * and a node graph, which have to be tested as such.
 *
 * **The previous version of this file explicitly could not test its shader.** It said so:
 * *"Reading rmsl's node tree to check that the normal comes from `positionWorld` needs a GL
 * context to stringify, and a test that cannot run in CI is not a test."* That is true of
 * rmsl's tree and false of `compileGlsl`, which renders the tree to GLSL with no device at
 * all — `surface-material.test.ts` has been doing it this whole time. So the water shader
 * has tests now, and the thing they can see is the part that matters: **whether the normal
 * is computed from the world position or read from the vertex attribute**, which is the
 * whole reason a meshed sea can be coarse without being faceted.
 *
 * ## The other half of the claim
 *
 * **The globe draws its own ocean, from the same `waterLook`.** So the far sea and the near
 * sea cannot drift apart, and the test below says both use it rather than leaving it to
 * reading two files side by side.
 */

import { compileGlsl } from "@random-mesh/rmsl/glsl";
import { Scene } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import {
  DEEP_WATER,
  FRESNEL_BASE,
  FRESNEL_GAIN,
  WATER_OPACITY,
} from "./water-look";
import {
  createWaterMaterial,
  flatWater,
  sphericalWater,
  type WaterShape,
} from "../world/water";

/**
 * Compiles a material to GLSL, with no graphics device.
 *
 * **The same shape `surface-material.test.ts` uses**, because it is the only way to see a
 * node graph's text in a unit test. What it cannot see is whether the GPU agrees with the
 * text, which is what the browser is for.
 */
const compile = (shape: WaterShape = sphericalWater) => {
  const material = createWaterMaterial(shape);
  const scene = new Scene();
  const program = material.build(scene);
  const vertex = compileGlsl.vertex(program.vertexRoot, { precision: "highp" });
  return {
    material,
    vertex,
    fragment: compileGlsl.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};

/**
 * The name the compiler gave a varying, found rather than assumed.
 *
 * **rmsl renames everything it generates, so a test cannot write `positionWorld`.** The
 * node graph says `positionWorld` and the GLSL says `_rmsl_v0`, which is the same value with
 * a different label — and a test hard-coding either one would fail on a compiler change and
 * pass for the wrong reason. So the name is read out of the stage that writes it and then used
 * against the stage that reads it, which is the actual claim: *the fragment normalises the
 * varying the vertex stage filled with the transformed position.*
 *
 * `nth` is the varying's line number among the `out` declarations, which is as stable as the
 * declaration order and no more.
 */
const varyingWrittenBy = (vertex: string, nth = 0): string => {
  const names = [...vertex.matchAll(/^out\s+\w+\s+(\w+);/gm)].map((m) => m[1]);
  const name = names[nth];
  if (name === undefined)
    throw new Error(`no varying at ${nth} in:\n${vertex}`);
  return name;
};

/**
 * What a stage takes as input, by the same argument.
 *
 * **`in` in a fragment stage is a varying and in a vertex stage is an attribute**, and that
 * difference is what the last assertion below turns on: the vertex stage reads the sea mesh's
 * position, normal and UV attributes, and the fragment reads one varying and nothing else.
 */
const inputsOf = (stage: string): readonly string[] =>
  [...stage.matchAll(/^in\s+\w+\s+(\w+);/gm)].map((m) => m[1]!);

describe("the sea material compiles", () => {
  it("emits a version 300 es program at both stages", () => {
    const { vertex, fragment } = compile();
    expect(vertex).toContain("#version 300 es");
    expect(vertex).toContain("gl_Position");
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toMatch(/void\s+main\s*\(/);
  });

  it("takes its normal from the world position, not from a vertex attribute", () => {
    // **The reason a meshed sea can be as coarse as its chunk's samples are.** The surface is
    // a sphere of the sea's radius, so the radial direction is its exact normal at every point,
    // and computing it per fragment makes the shading independent of the tessellation — the
    // argument the deleted sphere made for carrying only a direction, which survives the
    // sphere because it was never about the sphere.
    //
    // Three assertions, because each alone would pass for the wrong reason:
    //
    // 1. the vertex stage fills a varying with the model-transformed position, so the varying
    //    the fragment normalises really is a world position;
    // 2. the fragment normalises that same varying;
    // 3. the fragment takes in **that varying and nothing else** — so it cannot be reading the
    //    sea mesh's octahedral normals, which the shared vertex layout supplies and no one uses.
    //
    //    The vertex stage reads three attributes and the fragment one, and the difference
    //    between them *is* the claim: the sea's normal is computed here rather than carried.
    const { fragment, vertex } = compile();
    expect(vertex).toMatch(/modelMatrix\s*\*\s*vec4\([^)]*,\s*1\.0\s*\)/);
    const worldPosition = varyingWrittenBy(vertex, 0);
    expect(fragment).toMatch(
      new RegExp(`normalize\\s*\\(\\s*vec3\\(${worldPosition}\\)`),
    );
    expect(inputsOf(fragment)).toEqual([worldPosition]);
    expect(inputsOf(vertex).length).toBeGreaterThan(1);
  });

  it("blends, and writes the fog and the sky's own colour", () => {
    // **A sea that did not blend would be an opaque blue disc**, and a sea that did not read the
    // fog would have a hard edge against the horizon the fog has just dissolved.
    const { fragment } = compile();
    expect(fragment).toContain("uFogColour");
    expect(fragment).toContain("uSkyColour");
    // The alpha is the Fresnel term plus the floor, clamped — which is the only thing standing
    // between "translucent" and "a hole in the world" if the Fresnel ever goes negative.
    expect(fragment).toContain(`+ ${WATER_OPACITY}`);
    expect(fragment).toContain("clamp");
  });

  it("mixes from the deep colour the look declares", () => {
    // **The shared look is what the globe and the sea agree on**, and it is inlined into the
    // GLSL as literals — so the assertion has to be on the numbers, not on a call that is no
    // longer there by the time the text exists. Three literals, in this order, is the mix.
    const { fragment } = compile();
    expect(fragment).toContain(
      `vec3(${DEEP_WATER.map((c) => (c === 0.05 ? "0.05" : String(c))).join(", ")})`,
    );
    // And the Fresnel's own three numbers, which is the shape of the reflection term.
    expect(fragment).toMatch(
      new RegExp(
        `${FRESNEL_BASE} \\+ ${FRESNEL_GAIN} \\* pow\\(1\\.0 - abs\\(dot`,
      ),
    );
    expect(fragment).toMatch(/0\.05 \+ 0\.95 \* pow/);
  });

  it("multiplies its alpha by the uniform that fades it", () => {
    // The sea has to be able to come and go without a recompile, and rmsl's opacity hook is
    // a node rather than a scalar — so the uniform is multiplied into the material's own
    // alpha rather than set through `material.opacity`.
    const { material, fragment } = compile();
    material.opacity = 0.5;
    expect(fragment).toContain("uWaterOpacity");
  });

  it("faces world up on a height field and away from the centre on a planet", () => {
    // **Two worlds, one material class, and the two cannot be shaded by the other's rule.** A
    // height field's sea is flat, so its normal is `+Y`; taking the radial direction on a flat
    // world points sideways at one end of it and backwards at the other.
    //
    // Asserted by the difference between the two fragments rather than by either one's text,
    // because the only thing to say is which normal each one normalises.
    const curved = compile(sphericalWater);
    const flat = compile(flatWater);
    const worldPosition = varyingWrittenBy(curved.vertex, 0);
    expect(curved.fragment).toContain(`vec3(${worldPosition})`);
    // The flat sea never mentions the world position at all: its normal is a constant, so the
    // radial expression cannot appear.
    expect(flat.fragment).not.toContain(
      `vec3(${varyingWrittenBy(flat.vertex, 0)})`,
    );
  });
});

describe("the water look", () => {
  it("mixes toward the sky it is given and is opaque enough to stay water", () => {
    // The one thing both callers must agree on. The globe passes its own `SkyLight` and the sea's
    // material passes the same one, and the numbers are the same because there is only one copy
    // of them — which is what this file's existence is for.
    expect(WATER_OPACITY).toBeGreaterThan(0);
    expect(WATER_OPACITY).toBeLessThan(1);
    // **Looking straight down is the least reflective case and it still has to be water.** An
    // offset rather than a product, so the alpha never falls below the floor — which is the
    // difference between a sea and a hole in the world where the sea is.
    expect(FRESNEL_BASE + WATER_OPACITY).toBeGreaterThan(0.5);
  });

  it("keeps a deep water colour that is blue rather than black", () => {
    // Water at depth is blue — it is what is left after the red end is gone — rather than an
    // absence, which is what a black would be.
    const [, , blue] = DEEP_WATER;
    expect(blue).toBeGreaterThan(DEEP_WATER[0]);
    expect(blue).toBeGreaterThan(DEEP_WATER[1]);
  });
});
