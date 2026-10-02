import { compileGLSL } from "@random-mesh/rmsl";
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  VISIBLE_ELEVATION,
  dayNightState,
  phaseAt,
} from "./day-night";
import { SkyMaterial, createSky } from "./sky";
import { FOV_Y } from "../render/viewport";

/**
 * Compiling a material needs no graphics device.
 *
 * Same reasoning as `clouds.test.ts`: the questions worth asking about a shader are
 * the ones that fail silently, and a shader's whole visible output is a colour that
 * only a browser can judge. So these are about structure — does it read the eye, does
 * it read the day, does it fade the discs at the right elevation, does the starfield
 * turn once per cycle — and not about whether the sky is blue.
 *
 * The dome takes the whole `DayNightState` rather than a list of fields, so these can
 * be built from real states at real times of day rather than from hand-picked numbers.
 *
 * One block below steps outside that rule, and the reason is the whole point of it: a
 * starfield that drew *nothing* passed every structural test in this file, because
 * "invisible" is not a shape a shader can be wrong about. So the starfield's own
 * arithmetic — its grid, its hash, its pixel-space disc — is transcribed here and run
 * over a grid of rays, and the file asserts on the number of pixels it lights.
 */

const compile = (material: SkyMaterial) => {
  const program = material.build(new Scene());
  return {
    program,
    vertex: compileGLSL.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGLSL.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};

const at = (seconds: number) => {
  const material = new SkyMaterial();
  material.sky.lighting = dayNightState(seconds);
  return material;
};

describe("the sky dome compiles", () => {
  it("emits both stages", () => {
    const { vertex, fragment } = compile(new SkyMaterial());
    expect(vertex).toContain("#version 300 es");
    expect(vertex).toContain("gl_Position");
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toMatch(/void\s+main\s*\(/);
  });

  it("emits no NaN", () => {
    // The guard for the bug that cost a whole afternoon in the cloud shader, where
    // JavaScript arithmetic on a node produced a NaN that compiled, drew, and did
    // nothing at all.
    const { vertex, fragment } = compile(at(0));
    expect(vertex).not.toContain("NaN");
    expect(fragment).not.toContain("NaN");
    expect(fragment).not.toContain("undefined");
  });

  it("reads the eye and the view ray, not a mesh coordinate", () => {
    // The dome is a carrier, not a place: everything on it is a function of the ray
    // direction, which is why it can follow the camera unsnapped and never swim.
    const { fragment } = compile(at(0));
    expect(fragment).toContain("cameraPosition");
    expect(fragment).toContain("normalize");
  });

  it("samples no textures at all", () => {
    // The whole sky is arithmetic on a direction, so it costs nothing in bandwidth and
    // cannot alias at the horizon the way a skybox image does.
    const { fragment, program } = compile(at(0));
    expect(fragment).not.toContain("texture(");
    expect(program.samplers).toHaveLength(0);
  });

  it("reads every part of the day's state the sky needs", () => {
    const { fragment, program } = compile(at(0));
    for (const expected of [
      "uSunDirection",
      "uSunElevation",
      "uSunLight",
      "uMoonDirection",
      "uMoonElevation",
      "uMoonLight",
      "uSkyColour",
      "uZenith",
      "uTwilight",
      "uStarTurn",
    ]) {
      expect(
        program.uniforms.map((u) => u.name),
        expected,
      ).toContain(expected);
      expect(fragment, expected).toContain(expected);
    }
  });

  it("keeps them all at material scope, so one write a frame is enough", () => {
    // The renderer reads a material uniform's thunk per draw, which is what lets
    // `app.tsx` hand the whole day's state over once a frame with no `needsUpdate`.
    const { program } = compile(at(0));
    for (const uniform of program.uniforms) {
      if (uniform.name.startsWith("u")) {
        expect(uniform.scope, uniform.name).toBe("material");
      }
    }
  });

  it("takes the zenith and the horizon as two separate colours", () => {
    // A sky gradient derived from a single colour by hue-shifting gets dusk wrong, and
    // dusk is the fifth of the cycle the sky is read from: the horizon goes orange
    // while the zenith is still blue, which no single hue shift can express.
    const { fragment } = compile(at(0));
    expect(fragment).toContain("mix(uSkyColour, uZenith");
  });

  it("shares the six sky bindings with every other lit material", () => {
    // One object rather than a copy per material, so there is one fallback rule and one
    // place the day's lighting is read from. A material drawn before its first update
    // reads midday rather than nothing.
    const material = at(0);
    expect(material.sky.lighting).not.toBeNull();
    expect(material.sky.lighting!.phase).toBe("sunrise");
  });

  it("fades the discs at the visibility elevation rather than cutting them", () => {
    // The reference cuts at eight degrees under, which pops. A `smoothstep` over a few
    // degrees reads as a body going down behind something.
    const { fragment } = compile(at(0));
    const fades = [
      ...fragment.matchAll(
        /smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*u(\w*Elevation)/g,
      ),
    ];
    expect(fades).toHaveLength(2);
    for (const fade of fades) {
      expect(fade[3]).toMatch(/Sun|Moon/);
      expect(Number(fade[1])).toBeLessThan(VISIBLE_ELEVATION);
      expect(Number(fade[2])).toBeGreaterThan(VISIBLE_ELEVATION);
    }
  });

  it("scales the sun's glow with how low the sun is, not how high", () => {
    // The obvious first attempt multiplies the glow by elevation, which makes it
    // vanish at exactly the moment a sunset is meant to happen. What makes a sunset is
    // the light having come through the most atmosphere.
    const { fragment } = compile(at(0));
    expect(fragment).toMatch(
      /1\.0\s*-\s*clamp\(\s*uSunElevation\s*\/\s*[\d.]+\s*,\s*0\.0\s*,\s*1\.0\s*\)/,
    );
  });

  it("turns the starfield once per cycle", () => {
    // Left static, a starfield with a sun that sweeps three hundred and sixty degrees
    // in twenty minutes is a sky that visibly running on two clocks.
    //
    // The turn is hoisted into a local before the trigonometry, so this is a count
    // rather than a substring: the uniform is read exactly once, and exactly one
    // cosine and one sine are taken of it.
    const { fragment } = compile(at(0));
    expect(fragment.split("uStarTurn").length - 1).toBe(2);
    // One cosine, for the turn and nothing else.
    expect(fragment.split("cos(").length - 1).toBe(1);
    // Three sines: the turn, plus the two star hashes. The second number is the one
    // worth watching — the hashes are hoisted into locals precisely so that this is
    // three rather than seven, and a `sin` of three dot products is not free.
    expect(fragment.split("sin(").length - 1).toBe(3);
  });

  it("computes the star's hash once and not once per use", () => {
    // rmsl emits an expression once per use and cannot see that two reads of the same
    // hash are the same hash. Written plainly this shader evaluated the hash eleven
    // times per pixel; `sin` is not cheap.
    const { fragment } = compile(at(0));
    // Two hashes — one for the star's identity, one for its position inside the cell.
    expect(fragment.split("43758.5453").length - 1).toBe(2);
    // And the cell is hashed once each rather than four times.
    expect(fragment.split("vec3(127.1, 311.7, 74.7)").length - 1).toBe(2);
  });

  it("emits no loops", () => {
    // Nothing in a sky needs one, and an unrolled body is a sign something was
    // written as a loop by accident.
    const { fragment } = compile(at(0));
    expect(fragment).not.toMatch(/for\s*\(|while\s*\(/);
  });

  it("compiles at every precision the renderer might pick", () => {
    for (const precision of ["lowp", "mediump", "highp"] as const) {
      const program = at(0).build(new Scene());
      expect(() =>
        compileGLSL.fragment(program.fragmentRoot, { precision }),
      ).not.toThrow();
      expect(() =>
        compileGLSL.vertex(program.vertexRoot, { precision }),
      ).not.toThrow();
    }
  });

  it("compiles at every hour of the cycle", () => {
    // The uniforms read whatever the day's state holds, and a palette value outside
    // 0..1 or a direction that is not unit length would show up as a compile failure
    // in a branch. Cheap to check, and it is the one thing that can vary.
    for (let t = 0; t < CYCLE_SECONDS; t += 17) {
      expect(() => compile(at(t)), `t = ${t}, ${phaseAt(t)}`).not.toThrow();
    }
  });

  it("is small enough to be a shader", () => {
    const { fragment } = compile(at(0));
    expect(fragment.length).toBeLessThan(6000);
  });
});

const scene = (): Scene => new Scene();

/**
 * How many pixels the starfield actually lights.
 *
 * The starfield's arithmetic, transcribed from `sky.ts`: the lattice, Dave Hoskins'
 * `hash33`, and the disc measured in **screen pixels** rather than in cells — which is
 * the fix, and the reason this block exists. With the size in cells the whole thing
 * emits perfectly valid GLSL, compiles at every precision, passes the hash-once test
 * and lights **zero** pixels at 640×360.
 *
 * A transcription can drift from the shader. It is worth having anyway, because what it
 * measures — a starfield that lights pixels — is not a property the emitted source can
 * be wrong about in any way the tests above would notice, and it is the property that
 * was wrong.
 */
describe("the starfield's size", () => {
  const STAR_GRID = 130;
  const STAR_THRESHOLD = 0.985;
  const STAR_PIXELS = 1.6;
  const STAR_FALLOFF = 1.6;
  const STAR_GAIN = 4.5;
  const BRIGHTNESS_RANGE = 0.75;

  const fract = (x: number): number => x - Math.floor(x);

  /** Dave Hoskins' `hash33`, three channels from one cell. */
  const hash33 = (c: number[]): number[] =>
    [
      [127.1, 311.7, 74.7],
      [269.5, 183.3, 246.1],
      [113.5, 271.9, 124.6],
    ].map((k) =>
      fract(
        Math.sin(c[0]! * k[0]! + c[1]! * k[1]! + c[2]! * k[2]!) * 43758.5453,
      ),
    );

  /** The star's own brightness for one ray, at one ratio and frame size. */
  const brightness = (
    dir: number[],
    pixelRatio: number,
    w: number,
    h: number,
  ): number => {
    const grid = dir.map((v) => v * STAR_GRID);
    const cell = grid.map(Math.floor);
    const pick = hash33(cell);
    const present0 = Math.min(
      Math.max((pick[0]! - STAR_THRESHOLD) / (1 - STAR_THRESHOLD), 0),
      1,
    );
    const present = present0 * present0 * (3 - 2 * present0);
    const jitter = hash33([cell[0]! + 7.3, cell[1]! + 11.7, cell[2]! + 3.1]);
    const place = [
      cell[0]! + 0.15 + jitter[0]! * 0.7,
      cell[1]! + 0.15 + jitter[1]! * 0.7,
      cell[2]! + 0.15 + jitter[2]! * 0.7,
    ];
    const placeLength = Math.hypot(...place);
    // A point at infinity, projected: `projection * view * vec4(dir, 0)`, divided by w.
    // A point at infinity, projected: `projection * view * vec4(dir, 0)` over w. With
    // the direction normalised onto z = -1 the view-space w is 1, so the clip position
    // is the tangent-space position divided by `tan(fov/2)` and the aspect.
    const tan = Math.tan((FOV_Y / 2) * (Math.PI / 180));
    const aspect = w / h;
    const clip = (d: number[]): { x: number; y: number; w: number } => {
      const viewW = -d[2]!;
      return {
        x: d[0]! / (tan * aspect) / viewW,
        y: d[1]! / tan / viewW,
        w: viewW,
      };
    };
    const ray = clip(dir);
    const star = clip(place.map((v) => v / placeLength));
    if (ray.w <= 0 || star.w <= 0) return 0;
    // NDC to device pixels: half the resolution either way.
    const offset = Math.hypot(
      (star.x - ray.x) * (w / 2),
      (star.y - ray.y) * (h / 2),
    );
    const point = Math.min(
      Math.max(1 - offset / (STAR_PIXELS * pixelRatio), 0),
      1,
    );
    return (
      Math.pow(point, STAR_FALLOFF) *
      present *
      (pick[1]! * BRIGHTNESS_RANGE + 1 - BRIGHTNESS_RANGE) *
      STAR_GAIN
    );
  };

  /** Every ray of a frame, sampled every other pixel, looking up and east. */
  const frame = (
    w: number,
    h: number,
    pixelRatio: number,
  ): { lit: number; meanLit: number; peak: number } => {
    const tan = Math.tan((FOV_Y / 2) * (Math.PI / 180));
    let lit = 0;
    let sum = 0;
    let peak = 0;
    for (let py = 0; py < h; py += 2) {
      for (let px = 0; px < w; px += 2) {
        const nx = ((px + 0.5) / w) * 2 - 1;
        const ny = 1 - ((py + 0.5) / h) * 2;
        const d = [nx * tan * (w / h), ny * tan + Math.sin(0.5), -1];
        const length = Math.hypot(d[0]!, d[1]!, d[2]!);
        const v = brightness(
          d.map((c) => c / length),
          pixelRatio,
          w,
          h,
        );
        if (v > 0.05) {
          lit++;
          sum += v;
          if (v > peak) peak = v;
        }
      }
    }
    return {
      lit: ((lit * 4) / (w * h)) * 1e6,
      meanLit: lit === 0 ? 0 : sum / lit,
      peak,
    };
  };

  it("lights a scatter of pixels, not zero", () => {
    // The assertion whose absence cost the most. Zero lit pixels is not a subtle
    // regression: it is a sky with no stars, and every other test in this file passed.
    const landscape = frame(1280, 720, 1.5);
    console.log(
      `1280x720 at 1.5x: ${landscape.lit.toFixed(0)} lit pixels per megapixel, ` +
        `mean ${landscape.meanLit.toFixed(2)}, peak ${landscape.peak.toFixed(2)}`,
    );
    expect(landscape.lit).toBeGreaterThan(200);
  });

  it("lights them brightly enough to see", () => {
    // A lit pixel that averages 0.13 is a grey smudge against a night sky of 0.02: the
    // starfield is technically there and the eye reports nothing. This is what the gain
    // is for, and this is the number that says whether it did its job.
    const night = frame(1280, 720, 2);
    console.log(
      `1280x720 at 2x: ${night.lit.toFixed(0)} lit pixels per megapixel, ` +
        `mean ${night.meanLit.toFixed(2)}, peak ${night.peak.toFixed(2)}`,
    );
    expect(night.meanLit).toBeGreaterThan(0.25);
    // And the brightest stars clip, which is what makes a star read as a light source
    // rather than as a pale dot.
    expect(night.peak).toBeGreaterThanOrEqual(1);
  });

  it("keeps the same apparent size at any device pixel ratio", () => {
    // The reason the size is carried through a uniform rather than baked in. A star in
    // device pixels is half the size on a phone as on a desktop, and the viewport clamps
    // that ratio at two — so a starfield tuned at one thins out on the other. The lit
    // count per megapixel is the comparison, and the ratio is what has to cancel.
    const perCssPixel = (ratio: number): number =>
      frame(640, 360, ratio).lit / ratio;
    const phone = perCssPixel(2);
    const desktop = perCssPixel(1);
    expect(phone).toBeGreaterThan(0.5 * desktop);
    expect(phone).toBeLessThan(2 * desktop);
  });
});

describe("the sun and the moon", () => {
  it("draws discs big enough to read as discs", () => {
    // At its true angular size the moon is half a degree across, which is about eight
    // pixels on a phone at this field of view — a dot, and a blue one. Both discs are
    // drawn two to four times life size, and these are the numbers that say so: a
    // player who has to squint to find the moon is looking at a bug report, not a sky.
    //
    // The constants are read out of the **emitted shader**, so this is a claim about
    // what is drawn rather than a restatement of what was typed. The disc is
    // `1 - smoothstep(inner, outer, chord)`, and for two unit vectors the chord is
    // `2·sin(θ/2)`, so `outer` is twice the sine of the disc's *angular radius*.
    const { fragment } = compile(at(900));
    // Emitted as `1.0 - smoothstep(inner, outer, length(...))`, once per disc.
    const pairs = [
      ...fragment.matchAll(/smoothstep\(([\d.]+), ([\d.]+), length/g),
    ].map((match) => Number(match[2]));
    expect(pairs).toHaveLength(2);

    // `outer` is the disc's angular radius, because the chord between two unit vectors
    // `θ` apart is `2·sin(θ/2)` — so the diameter across the disc is twice that angle.
    const radiusDeg = (chord: number): number =>
      (2 * Math.asin(chord / 2) * 180) / Math.PI;
    const diameters = pairs
      .map((outer) => radiusDeg(outer) * 2)
      .sort((a, b) => a - b);

    // Smallest first: the sun at about 1.5° across, the moon at about 2.2°.
    expect(diameters[0]).toBeGreaterThan(1.4);
    expect(diameters[1]).toBeGreaterThan(2);
    // And both are wider than the bodies they stand for — the sun is half a degree and
    // the moon is very nearly the same — by the factor that makes them read at all.
    expect(diameters[0]).toBeGreaterThan(2 * 0.53);
    expect(diameters[1]).toBeGreaterThan(4 * 0.52);
  });

  it("draws the moon brighter than the light it casts", () => {
    // `moonLight` is what the moon puts on the world: dim, and blue, because that is
    // what moonlight is. A disc drawn in exactly that value is a grey-blue smudge — which
    // is how it read before, as a blue spot rather than as a moon.
    const { fragment } = compile(at(900));
    // The moon's own line, and the multiplier the disc carries on it. Read out of the
    // emitted source by line rather than by pattern, because the parentheses rmsl emits
    // around a nested call are an implementation detail and this is not about those.
    const moonLine = fragment
      .split("\n")
      .find(
        (line) =>
          line.includes("uMoonDirection") &&
          line.includes("uMoonLight") &&
          line.includes("smoothstep"),
      );
    expect(moonLine).toBeDefined();
    const multiplier = Number(/\*\s*([\d.]+);\s*$/.exec(moonLine!.trim())![1]);
    expect(multiplier).toBeGreaterThan(1.5);
  });
});

describe("the dome's state", () => {
  it("neither tests nor writes depth, because it is drawn first", () => {
    // rmsl has no render-order key. The dome fills the frame and everything after it
    // lands on top; a dome that tested depth would have to sort against forty thousand
    // units of cloud and a streaming terrain window, for no gain at all.
    const material = new SkyMaterial();
    expect(material.depthTest).toBe(false);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(Side.BackSide);
  });

  it("survives a frame before it has been given a state", () => {
    // The dome is added to the scene before the first `update` runs, and a shader that
    // reads an unset state is a black screen for a frame or a NaN for ever. The
    // fallbacks are no sun, no moon, full night.
    const material = new SkyMaterial();
    expect(material.sky.lighting).toBeNull();
    expect(() => compile(material)).not.toThrow();
  });

  it("adds exactly one child, at the end of the scene, and takes it away again", () => {
    // The dome's position in the draw order is the whole of its occlusion scheme, and
    // rmsl has no render-order key — draw order *is* scene traversal order. So the
    // contract is that `createSky` appends, and that `app.tsx` calls it before the
    // session that owns the terrain's meshes. That call site is at the top of the
    // shared-scene block, which is the only place ordering is decided.
    const scene = new Scene();
    expect(scene.children).toHaveLength(0);

    const sky = createSky(scene);
    expect(scene.children).toHaveLength(1);
    const dome = scene.children[0]!;
    expect(dome.isMesh).toBe(true);
    // `children` is typed as `Object3D[]` and `isMesh` is a flag rather than a type
    // guard, so the narrowing is a cast after the check rather than an inference.
    expect((dome as Mesh).material).toBeInstanceOf(SkyMaterial);

    sky.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("leaves the scene's existing children alone", () => {
    // Whatever is already there has to keep its place, or the dome would end up drawn
    // after the terrain and paint over it — the dome does not test depth.
    const scene = new Scene();
    const existing = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshBasicMaterial({}),
    );
    scene.add(existing);

    const sky = createSky(scene);
    expect(scene.children).toHaveLength(2);
    expect(scene.children[0]).toBe(existing);
    expect((scene.children[1]! as Mesh).material).toBeInstanceOf(SkyMaterial);

    sky.dispose();
    expect(scene.children).toHaveLength(1);
    expect(scene.children[0]).toBe(existing);
  });

  it("holds no reference to a state until it is given one", () => {
    const sky = createSky(scene());
    expect(sky.material.sky.lighting).toBeNull();
    sky.material.sky.lighting = dayNightState(0);
    expect(sky.material.sky.lighting).not.toBeNull();
    sky.dispose();
  });
});
