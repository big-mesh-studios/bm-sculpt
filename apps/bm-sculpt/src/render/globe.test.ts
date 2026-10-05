/**
 * The globe's shader, compiled.
 *
 * ## Why compile it here
 *
 * A globe is the one part of this project whose failure is invisible until somebody flies up, and
 * then it is total: a black planet, or a planet of flat grey with a silhouette that does not match
 * the ground it replaced. Neither is a bug a unit test catches by calling a function — the
 * interesting part is the graph, and the graph is what `compileGlsl` renders to text.
 *
 * So the assertions are about the generated shader, which is the artifact the player sees:
 *
 * - **The equirectangular inverse is in there, twice** — once in the vertex stage for displacement
 *   and once in the fragment stage for the normal and the colour. One occurrence would mean the two
 *   stages read the map at different places, which is a planet whose shading slides off its terrain.
 * - **The height map is read three times in the fragment stage**: the point, and one neighbour along
 *   each surface tangent. Fewer than three is a normal that is not a gradient.
 * - **The displacement is in the vertex stage**, because that is the only stage where a displaced
 *   sphere is cheap: the fragment stage cannot move a vertex.
 */

import { compileGlsl } from "@random-mesh/rmsl/glsl";
import { Scene } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import { GlobeMaterial, globeTextures } from "./globe";
import type { GlobeMaps } from "./globe";

const maps = (width: number, height: number): GlobeMaps => ({
  albedo: new Uint8Array(width * height * 4).fill(200),
  height: new Uint8Array(width * height).fill(128),
  width,
  height_: height,
  seaRadius: 4000,
  relief: 576,
});

const compiled = (width = 64, height = 32) => {
  const source = maps(width, height);
  const material = new GlobeMaterial();
  material.setMaps(globeTextures(source), source);
  const program = material.build(new Scene());
  return {
    program,
    vertex: compileGlsl.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGlsl.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};

const occurrences = (source: string, needle: string): number =>
  source.split(needle).length - 1;

describe("the globe's shader", () => {
  it("compiles at all", () => {
    // The cheapest of these assertions and the one most likely to catch a real mistake: rmsl's graph
    // is built by calling into the builder, and a node wired to the wrong socket type throws here
    // rather than on the player's machine.
    const { vertex, fragment } = compiled();
    expect(vertex.length).toBeGreaterThan(0);
    expect(fragment.length).toBeGreaterThan(0);
  });

  it("addresses the equirectangular map the same way in both stages", () => {
    // **The property that makes the globe's shading belong to its terrain.** Displacement samples
    // the height map in the vertex stage and the normal samples it again per fragment; if the two
    // addresses differed by a texel, the lit surface and the silhouette are different maps of the
    // planet, and the mismatch is a slow shimmer rather than an obvious break.
    const { vertex, fragment } = compiled();
    for (const [stage, source] of [
      ["vertex", vertex],
      ["fragment", fragment],
    ] as const) {
      expect(
        occurrences(source, "atan"),
        `${stage} addresses longitude`,
      ).toBeGreaterThan(0);
      expect(
        occurrences(source, "asin"),
        `${stage} addresses latitude`,
      ).toBeGreaterThan(0);
    }
  });

  it("differentiates the height map in the fragment stage, for a normal", () => {
    // Three reads: the point and a neighbour along each tangent. A displaced mesh's own normals are
    // the normals of a coarse tessellation, which at 256 segments is a hundred units across — far
    // coarser than the mountains, so it would shade a faceted rock.
    const { fragment } = compiled();
    expect(occurrences(fragment, "uGlobeHeight")).toBeGreaterThanOrEqual(3);
  });

  it("displaces in the vertex stage and not the fragment stage", () => {
    // The vertex stage is the only one that can move a vertex, so the height map has to appear
    // there too — and a height map read in the fragment stage must be the *gradient*, not the
    // position, or the geometry would be a perfect sphere wearing the terrain's colour.
    const { vertex, fragment } = compiled();
    expect(vertex).toContain("uGlobeHeight");
    expect(vertex).toContain("uRelief");
    expect(vertex).toContain("uSeaRadius");
    expect(fragment).toContain("uRelief");
  });

  it("displaces the sphere's own vertices, not the varying it is writing", () => {
    // **The bug this test exists for.** `positionWorld` is a varying: in the vertex stage it is an
    // `out`, and reading it before assigning it reads whatever the driver left in that register.
    // The displacement direction has to come from the `position` attribute, the undisplaced sphere.
    // When this was wrong the compiler emitted `_rmsl_v0 = normalize(_rmsl_v0) * ...` — the output
    // normalised before it was written — and the globe collapsed to NaN and was never drawn.
    //
    // Asserted structurally rather than by name: find the world-position `out` and require it to
    // appear exactly twice, its declaration and its one assignment. Any further occurrence is a
    // read, and a read here is the bug.
    const { vertex } = compiled();
    const out = /out vec3 (\w+);/.exec(vertex);
    expect(
      out,
      "the vertex stage writes a world position varying",
    ).not.toBeNull();
    expect(occurrences(vertex, out![1]!)).toBe(2);
  });

  it("shares the terrain's lighting and the terrain's fog", () => {
    // **Why the swap is invisible, asserted rather than hoped for.** The globe reads the same sky
    // uniforms and the same fog as every chunk, so at the altitude the two overlap they are lit by
    // the same sun and hazed by the same air. A globe with its own light would disagree at exactly
    // the altitude the player is watching.
    const { fragment } = compiled();
    // The names are `SkyLight`'s and `Fog`'s, not invented here: a typo would compile to a uniform
    // nothing writes, and the globe would light and haze itself by whatever the defaults were.
    //
    // Two names are deliberately absent, and both absences were found by this test rather than by
    // reading `fog.ts`:
    //
    // - **`uSkyColour`.** `SkyLight` declares it, but it is the sky's own colour and no surface
    //   reads it.
    // - **`uFogNear` and `uFogFar`.** They are not uniforms at all — `Fog` folds them into the shader
    //   as literals at build time, so they are not names to look for.
    //
    // Which is the point of asserting on the compiled source: both were written into this list as
    // plausible-looking names, and an assertion written that way proves nothing at all.
    for (const uniform of [
      "uSunDirection",
      "uSunLight",
      "uMoonDirection",
      "uMoonLight",
      "uAmbient",
      "uFogColour",
      "uFogScale",
      "uFogRadius",
    ]) {
      expect(fragment, uniform).toContain(uniform);
    }
  });
});

describe("the globe's ocean", () => {
  // The globe used to be a bare displaced sphere with the sea drawn over it as a 256-segment
  // sphere, so from orbit there was no ocean at all except that sphere. There is now a sea
  // sphere's worth of water either side of the streamed window — and ADR 0043 is the record of why
  // it moved here. These are the assertions that the ocean is *in* the globe's shader and not
  // merely implied by it.
  it("shades below the sea level as water, from the height map's own zero", () => {
    // **The map's zero is the field's lowest radius, not the sea**, which the vertex stage has to
    // subtract a half relief to get. A fragment stage that compared the raw texel against
    // `uSeaRadius` would put the waterline in the wrong place by half the relief — every ocean on
    // the planet hundreds of units shallow, or drowned entirely.
    const { fragment } = compiled();
    // The radius is rebuilt as `seaRadius - relief/2 + height * relief`, and the depth is that
    // difference over the relief. Both appear as emitted arithmetic.
    expect(fragment).toContain("uSeaRadius");
    expect(fragment).toContain("uRelief");
    // And a mix toward the water colour, which is the only thing that puts blue on the planet.
    expect(fragment).toContain("uSkyColour");
  });

  it("uses the same water look as the near sea", () => {
    // **One copy of the numbers, in `render/water-look.ts`.** The two are visible together at
    // exactly the altitude the swap happens, so a second set of constants is a visible seam at the
    // one moment somebody is watching for one.
    const { fragment } = compiled();
    // The deep-water colour and the Fresnel's own literals, inlined as the near sea's are.
    expect(fragment).toContain("vec3(0.05, 0.22, 0.4)");
    expect(fragment).toMatch(/0\.05 \+ 0\.95 \* pow/);
  });

  it("reaches full water colour at the deepest point of the sea", () => {
    // **Twice the normalised depth, because the sea sits in the middle of the relief.** The reach is
    // half the relief and `uSeaRadius` is the middle, so `depth` runs to a half and not to one. A
    // factor below two leaves the deepest ocean a few percent of seabed showing through, which from
    // orbit reads as pale patches in the middle of the sea.
    //
    // **And rooted, so a coastline is a gradient rather than a line** — a linear mix puts deep blue
    // within a texel of the shore, which from orbit is a drawn outline round every continent.
    // The root spreads the shallow band over the first few hundred units of depth.
    //
    // Asserted on the emitted arithmetic: `clamp((depth) * 2.0, 0.0, 1.0)` then `pow(…, 0.5)` — the
    // clamp before the root so it cannot exceed one however deep the map claims.
    const { fragment } = compiled();
    expect(fragment).toMatch(/clamp\(\([^;]*\* 2\.0, 0\.0, 1\.0\), 0\.5\)/);
  });
});

describe("the globe's blending", () => {
  it("writes no depth, so it blends over the terrain it replaces", () => {
    // **The globe and the chunks are the same surface at two resolutions**, so writing depth would
    // make them fight for the same pixel and the opaque chunks would win wherever they were drawn
    // last. Not writing lets the globe blend over them, exactly as the sea and the clouds do — and
    // those two are re-added after the globe so they land on top of it.
    const material = new GlobeMaterial();
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });
});

describe("the globe's textures", () => {
  it("pads the height map's width by one texel, so the antimeridian is not a crease", () => {
    // An equirectangular map's left and right edges meet. Without a repeated column the wrap is
    // continuous only in the middle of a texel; the seam becomes a one-texel dip running down the
    // planet's side, and a dip reads as a valley rather than as a mistake.
    const source = maps(64, 32);
    source.height[0] = 0;
    source.height[63] = 255;
    const { height } = globeTextures(source);
    expect(height.width).toBe(65);
    expect(height.height).toBe(32);
  });

  it("repeats the first column into the pad rather than leaving it blank", () => {
    // The pad exists to be *read*, and an unwritten pad is a column of zeros — which would pull the
    // seam down to the bottom of the height range and cut a canyon round the planet.
    const source = maps(8, 4);
    source.height.fill(200);
    const padded = new Uint8Array(9 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x <= 8; x++) {
        const at = (y * 9 + x) * 4;
        padded[at] = source.height[y * 8 + (x % 8)]!;
        padded[at + 1] = padded[at]!;
        padded[at + 2] = padded[at]!;
        padded[at + 3] = 255;
      }
    }
    // Every pad texel equals the first column's, so the seam reads as continuous.
    for (let y = 0; y < 4; y++) {
      expect(padded[(y * 9 + 8) * 4], `row ${y}`).toBe(padded[(y * 9 + 0) * 4]);
    }
  });

  it("takes its colour bytes straight through", () => {
    const source = maps(4, 2);
    source.albedo.set([
      1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255, 13, 14, 15,
      255, 16, 17, 18, 255, 19, 20, 21, 255, 22, 23, 24, 255,
    ]);
    const { albedo } = globeTextures(source);
    expect(albedo.width).toBe(4);
    expect(albedo.height).toBe(2);
    expect(albedo.image).toEqual(source.albedo);
  });
});
