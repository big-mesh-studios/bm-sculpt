import { compileGLSL } from "@random-mesh/rmsl";
import { Scene } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import { SpikeMaterial } from "./spike-material";
import { buildSpikeVolume } from "./spike-volume";

/**
 * Compiling a material needs no graphics device.
 *
 * `NodeMaterial.build` turns the node graph into roots plus the exact set of
 * bindings the graph reaches, and `compileGLSL` renders those to GLSL ES 3.00.
 * Both are host-side string and object work, which means the three questions
 * Phase 0 was gated on are answerable in a unit test rather than by looking at a
 * screen: that the node DSL accepts the octahedral decode written as nodes,
 * that a volume is bound as a `sampler3D` rather than a `sampler2D`, and that
 * the whole thing emits a valid `#version 300 es` program at each precision.
 *
 * What this cannot see is whether the GPU agrees with the text. That is the part
 * the browser is for, and it is why the visual spike scene exists alongside this
 * file rather than instead of it.
 */
const compile = (material: SpikeMaterial) => {
  const scene = new Scene();
  const program = material.build(scene);
  return {
    program,
    vertex: compileGLSL.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGLSL.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};

describe("the spike material compiles", () => {
  it("emits a version 300 es vertex stage", () => {
    const { vertex } = compile(new SpikeMaterial());
    expect(vertex).toContain("#version 300 es");
    expect(vertex).toContain("gl_Position");
  });

  it("emits a version 300 es fragment stage with a main", () => {
    const { fragment } = compile(new SpikeMaterial());
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toMatch(/void\s+main\s*\(/);
  });

  it("binds the volume as a three-dimensional sampler", () => {
    // The assertion that matters for the sampler3D spike: `sampler3D` in the
    // emitted source. A `sampler2D` here would compile, would draw, and would
    // sample a flat slice of the volume — so the text is the only place the
    // difference is visible at all.
    const material = new SpikeMaterial();
    material.volume = buildSpikeVolume();
    const { fragment, program } = compile(material);

    expect(fragment).toContain("sampler3D");
    expect(fragment).not.toContain("uniform sampler2D uVolume");

    const names = program.samplers.map((sampler) => sampler.name);
    expect(names).toContain("uVolume");
    const volume = program.samplers.find(
      (sampler) => sampler.name === "uVolume",
    );
    expect(volume?.type).toBe("sampler3D");
  });

  it("binds no volume sampler at all when there is no volume", () => {
    // The alternative — binding a 1x1x1 placeholder — would work and mean
    // nothing, which is worse than not having the uniform.
    const { program } = compile(new SpikeMaterial());
    expect(program.samplers.map((sampler) => sampler.name)).not.toContain(
      "uVolume",
    );
  });

  it("declares both vertex attributes, and the varyings that carry them", () => {
    const { program } = compile(new SpikeMaterial());

    // On the program rather than on the emitted text. RMSL renames every binding
    // to `_rmsl_aN` in the source and resolves names through the binding list,
    // so an attribute called `normalOct` in the graph is `in vec2 _rmsl_a0` in
    // the shader — the name is meaningless in the string and only meaningful
    // here.
    const attributes = program.attributes.map((attribute) => attribute.name);
    expect(attributes).toContain("normalOct");
    expect(attributes).toContain("colour");
    // `position` is the one attribute every draw needs, supplied by the builder
    // rather than declared, and it arrives here having been resolved.
    expect(attributes).toContain("position");
    for (const attribute of program.attributes) {
      expect(attribute.stepMode).toBe("vertex");
    }

    const varyings = program.varyings.map((varying) => varying.name);
    expect(varyings).toContain("vColour");
    expect(varyings).toContain("normalWorld");
  });

  it("keeps the octahedral decode's arithmetic in the emitted vertex stage", () => {
    // The fold surviving compilation is the thing worth checking: a decode that
    // folded away to a constant would still compile and still draw, and the
    // sphere would simply be lit by a fixed direction.
    const { vertex } = compile(new SpikeMaterial());
    expect(vertex).toContain("normalize");
    expect(vertex).toContain("max(-");
    // One selection per axis: the fold's mirror is applied to x and to y.
    expect(vertex.match(/>= 0\.0 \?/g) ?? []).toHaveLength(2);
  });

  it("compiles at every precision it might be asked for, and says so", () => {
    // A shader that only works at highp renders nothing on the devices the
    // precision probe exists to detect, so each of the three is compiled and the
    // emitted qualifier is checked rather than merely the absence of a throw.
    const material = new SpikeMaterial();
    const program = material.build(new Scene());
    for (const precision of ["lowp", "mediump", "highp"] as const) {
      const vertex = compileGLSL.vertex(program.vertexRoot, { precision });
      const fragment = compileGLSL.fragment(program.fragmentRoot, {
        precision,
      });
      expect(vertex).toContain(`precision ${precision} float;`);
      expect(fragment).toContain(`precision ${precision} float;`);
    }
  });

  it("emits no if-statement in the octahedral decode", () => {
    // The decode writes its lower-hemisphere case as an add of a term that is
    // zero when the case is not taken, so there is no control flow to diverge on
    // exactly the vertices where the fold turns over — which is every vertex of a
    // folded shape, the case this encoding exists to make cheap.
    //
    // RMSL renders the DSL's `select` as a ternary, not as a branch, and a
    // ternary in GLSL is a select on every driver that matters. That is the
    // library's choice rather than a guarantee about the code emitted, so what
    // is asserted is the absence of an `if` — the thing that would actually
    // diverge — rather than a stronger claim the compiler is free to break.
    const { vertex } = compile(new SpikeMaterial());
    expect(vertex).not.toMatch(/\bif\s*\(/);
  });
});
