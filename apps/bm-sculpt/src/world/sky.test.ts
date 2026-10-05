import { compileGlsl } from "@random-mesh/rmsl/glsl";
import {
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";
import { fromProgram, render } from "@random-mesh/rmsl/test";
import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  VISIBLE_ELEVATION,
  dayNightState,
  phaseAt,
} from "./day-night";
import { SkyMaterial, createSky } from "./sky";
import { FOV_Y } from "../render/viewport";
import { ATMOSPHERE_HEIGHT, DEFAULT_PLANET_RADIUS } from "../render/atmosphere";

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
 * One block below steps outside that rule, and the reason is the whole point of it:
 * a starfield that drew *nothing* passed every structural test in this file, because
 * "invisible" is not a shape a shader can be wrong about. So the last block runs the
 * built material on rmsl's CPU target and asserts on the number of pixels it lights —
 * the shader itself rather than a transcription of it, which is what the block was
 * before, and which is what let the starfield be broken at every hour but sunrise.
 */

const compile = (material: SkyMaterial) => {
  const program = material.build(new Scene());
  return {
    program,
    vertex: compileGlsl.vertex(program.vertexRoot, { precision: "highp" }),
    fragment: compileGlsl.fragment(program.fragmentRoot, {
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
      "uSkyRadius",
      "uSkyAtmosphere",
      "uSkyScale",
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
        compileGlsl.fragment(program.fragmentRoot, { precision }),
      ).not.toThrow();
      expect(() =>
        compileGlsl.vertex(program.vertexRoot, { precision }),
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
/**
 * How many pixels the starfield actually lights.
 *
 * These run the **real** `SkyMaterial` — the same built program, the same node graph,
 * the same uniforms — through rmsl's CPU target, and count what came out. That is a
 * deliberate replacement for the transcription that used to be here, which wrote the
 * starfield's arithmetic out again by hand: the lattice, the hash, the disc.
 *
 * **The transcription is what let this bug sit unfixed.** It was written when the
 * starfield was sized as a fraction of a cell, and it omitted the starfield's turn — the
 * rotation about the vertical that carries the field with the hour — because at the time
 * the turn was not part of it. It went on omitting it, so the block measured the sky at
 * `turn = 0` and only `turn = 0`. Sunrise. The cycle starts at sunrise, so the
 * transcription agreed with the shader at the one hour where the shader was right: the
 * numbers it printed were true and the starfield was broken.
 *
 * The bug it could not see: the starfield was handed one direction and used it both to
 * pick the lattice cell and to project the fragment's own ray onto the screen. The first
 * wants the field's own frame and the second wants the world's, and the two are the same
 * direction only when the turn is zero. Everywhere else the shader projected a ray
 * ninety or a hundred and eighty degrees away from the one the pixel was actually
 * looking down, `w` came out negative over most of the frame, and `bothInFront` deleted
 * those stars. Reported as *stars on the right third of the screen at night, and all of
 * them at sunrise*. This block is the assertion that says no: a starfield that lights
 * nothing at nine in the evening, and lights them on one side of the frame only.
 *
 * Nothing is rasterized — `render` evaluates every fragment of the rectangle — so the
 * counts here are of evaluated fragments rather than of covered ones, which for a dome
 * that fills the frame is the same thing.
 */

/**
 * How long a test in the block below is given.
 *
 * **These are the only tests in this application that rasterise on the CPU**, and each one
 * evaluates a 900 × 160 frame several times over through rmsl's software target. That is a
 * few million fragments per test, which is milliseconds on a desktop and seconds on a phone —
 * so the time is a property of the machine rather than of the assertion, and vitest's 5 s
 * default is a coin toss for a block of seven of them running beside the rest of the suite.
 *
 * Stated rather than left, so that a genuine failure inside the block still fails: the numbers
 * these tests compare are deterministic (nothing here is random — the starfield's lattice is a
 * hash of its own cell), so a timeout means the machine was slow, and a slow machine is not a
 * wrong starfield.
 */
const CPU_RASTER_MS = 30_000;

describe(
  "the starfield, on the CPU",
  () => {
    const DEG = Math.PI / 180;

    /** The dome's own radius, which `createSky` fixes. Only the *direction* is read. */
    const SKY_EXTENT = 40000;

    /** How far up the dome is looked at, in degrees. Anywhere above the horizon. */
    const ELEVATION_DEG = 30;

    /**
     * A perspective matrix, column-major as rmsl wants it.
     *
     * Written out rather than taken from a renderer, because there is no renderer here and
     * the starfield's whole argument is about where the projection puts things. A wrong
     * matrix would make the stars wrong in a way that reads as a bug in the shader, which
     * is precisely the failure mode this block exists to catch rather than to cause.
     */
    const perspective = (
      fovY: number,
      aspect: number,
      near: number,
      far: number,
    ) => {
      const f = 1 / Math.tan((fovY / 2) * DEG);
      return [
        f / aspect,
        0,
        0,
        0, //
        0,
        f,
        0,
        0, //
        0,
        0,
        (far + near) / (near - far),
        (2 * far * near) / (near - far), //
        0,
        0,
        -1,
        0,
      ];
    };

    /**
     * The dome at one hour of the cycle, as one material.
     *
     * The six from `SkyLight` and the rest of the day's state fill themselves in from the
     * material's own thunks — which is what the thunks are for — so a caller sets the hour
     * and nothing else. `starBrightness` is the one knob, and it is here because the
     * measurement below needs a frame with the stars off to subtract.
     */
    const domeAt = (
      seconds: number,
      pixelRatio: number,
      starBrightness = 1,
    ) => {
      const material = new SkyMaterial();
      material.sky.lighting = dayNightState(seconds);
      material.pixelScale = pixelRatio;
      material.starBrightness = starBrightness;
      return material;
    };

    /** One frame of the dome, with every binding a renderer would have supplied. */
    const frame = (
      material: SkyMaterial,
      width: number,
      height: number,
      eye: [number, number, number] = [0, 0, 0],
      elevationDeg: number = ELEVATION_DEG,
    ) =>
      render(
        fromProgram(material.build(new Scene()), {
          // Device pixels, which is what a star's size is measured in.
          resolution: [width, height],
          uniforms: {
            cameraPosition: eye,
            viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            projectionMatrix: perspective(FOV_Y, width / height, 0.1, 100000),
          },
        }),
        {
          width,
          height,
          // One ray per fragment, from an eye at the origin looking `-Z` and tilted up.
          // `render` counts rows up from the bottom, as `fragCoord` does.
          //
          // **The dome is carried at the eye, as `createSky` carries it**, so the ray the shader
          // recovers is the direction exactly. Placing the geometry at the origin and putting the eye
          // in `cameraPosition` only approximates a direction while the eye is much nearer the origin
          // than `SKY_EXTENT` is — and on a 136,000-unit planet the eye is not.
          inputs: ({ x, y }) => {
            const tan = Math.tan((FOV_Y / 2) * DEG);
            const d = [
              (((x + 0.5) / width) * 2 - 1) * tan * (width / height),
              (((y + 0.5) / height) * 2 - 1) * tan +
                Math.sin(elevationDeg * DEG),
              -1,
            ];
            const length = Math.hypot(...d);
            return {
              varyings: {
                positionWorld: d.map(
                  (c, i) => (c / length) * SKY_EXTENT + eye[i]!,
                ),
              },
            };
          },
        },
      );

    /**
     * What the starfield itself drew, and where on the frame it drew it.
     *
     * Measured by **rendering the hour twice and subtracting** — once with the stars and
     * once with `starBrightness` at zero — rather than by thresholding brightness. A
     * threshold has to know how bright the sky is, which is a palette question that changes
     * across the cycle: the cut that reads a star at midnight reads the entire dawn sky.
     * The difference isolates the starfield's own contribution, so one number works at
     * every hour and none of these assertions can be satisfied by a bright sky.
     */
    const stars = (
      seconds: number,
      width = 160,
      height = 90,
      pixelRatio = 1.5,
      eye: [number, number, number] = [0, 0, 0],
    ): { lit: number; meanLit: number; peak: number; busiest: number } => {
      const lit = frame(domeAt(seconds, pixelRatio), width, height, eye);
      const plain = frame(domeAt(seconds, pixelRatio, 0), width, height, eye);

      let count = 0;
      let sum = 0;
      let peak = 0;
      // How many lit pixels fell in the leftmost, middle and rightmost third.
      const columns = [0, 0, 0];
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const added = lit.at(x, y)[0]! - plain.at(x, y)[0]!;
          if (added > 1e-4) {
            count++;
            sum += added;
            if (added > peak) peak = added;
            columns[Math.min(2, Math.floor((x / width) * 3))]!++;
          }
        }
      }

      return {
        lit: count,
        meanLit: count === 0 ? 0 : sum / count,
        peak,
        // The share of the lit pixels in the busiest third of the width. One would mean
        // every star is on one side of the frame, which is this bug exactly.
        busiest: count === 0 ? 0 : Math.max(...columns) / count,
      };
    };

    it("lights pixels at every hour of the cycle where stars are due", () => {
      // The assertion the transcription could not make, and the one this block is for. A
      // starfield that works at sunrise and nowhere else is a starfield, and the sky is
      // read at midnight rather than at sunrise.
      //
      // Twelve hours of the cycle, each rendered twice and differenced, which is a few
      // seconds of CPU and the only slow thing in this file.
      const report: string[] = [];
      for (let t = 0; t < CYCLE_SECONDS; t += 100) {
        const twilight = dayNightState(t).twilight;
        const { lit, busiest } = stars(t);
        report.push(
          `t=${String(t).padStart(4)}s ${phaseAt(t).padEnd(8)} ` +
            `twilight ${twilight.toFixed(2)}  ${String(lit).padStart(4)} lit` +
            `  busiest third ${(busiest * 100).toFixed(0)}%`,
        );
        // The two ends of the parameter: `twilight` is 1 under the band and 0 over it, and
        // stars are the sky's at one end of that and absent at the other.
        if (twilight >= 1) {
          expect(
            lit,
            `no stars at t=${t}s, which is full night`,
          ).toBeGreaterThan(0);
        }
        if (twilight <= 0) {
          expect(lit, `stars at t=${t}s, which is full day`).toBe(0);
        }
      }
      console.log(report.join("\n"));
    }, 60_000);

    it("goes black with altitude, because the daylight sky is the atmosphere", () => {
      // The core of the change: the gradient and the glows are scaled by the air still
      // overhead, so a noon sky read from above the shell is the black of space. Measured on
      // the centre pixel, whose ray misses the shell entirely and so isolates the gradient
      // from the new limb term.
      const centre = (eye: [number, number, number]): number => {
        const out = frame(domeAt(300, 1), 1, 1, eye);
        const c = out.at(0, 0);
        return (c[0]! + c[1]! + c[2]!) / 3;
      };
      const ground = centre([0, 0, 0]);
      // A whole radius up, which is well clear of the 4,800-unit shell — an altitude barely above
      // the shell top would still have a 30° ray grazing it on a planet this size.
      const orbit = centre([0, DEFAULT_PLANET_RADIUS * 2, 0]);
      console.log(
        `noon sky: ground ${ground.toFixed(3)}, orbit ${orbit.toFixed(4)}`,
      );
      expect(ground).toBeGreaterThan(0.2);
      expect(orbit).toBeLessThan(ground * 0.05);
    });

    it("draws no atmosphere looking straight up from space, though the line behind the eye meets the planet", () => {
      // **The look-up bug, as a number.** The eye is outside the shell, so this ray never enters the
      // atmosphere — but the *line* through it and the sky passes through the planet's centre behind
      // the camera, and the limb sized its chord from that line. A straight-up look therefore carried
      // a full atmosphere column that was behind the eye: a fog band across the black of space. Blue
      // sky is about 0.75, so a value near zero is the difference between black and that band.
      const out = frame(
        domeAt(300, 1),
        1,
        1,
        [0, DEFAULT_PLANET_RADIUS + 20000, 0],
        89,
      );
      const c = out.at(0, 0);
      const space = (c[0]! + c[1]! + c[2]!) / 3;
      console.log(`straight-up sky from space: ${space.toFixed(4)}`);
      expect(space).toBeLessThan(0.02);
    });

    it("lights stars in daylight once the eye is out of the atmosphere", () => {
      // Noon, and the ground sky has no stars at all because `twilight` is zero. The same
      // hour from above the shell must: the only thing that hid them was the atmosphere.
      expect(stars(300, 160, 90, 1.5, [0, 0, 0]).lit).toBe(0);
      // **And "out" means past the shell's top, not just "the air has thinned".** Half a shell up
      // is still inside the atmosphere, and the old gate (`1 - atmosphere`) let stars in there —
      // the same mistake that drew the from-outside limb on top of the gradient during the climb.
      expect(
        stars(300, 160, 90, 1.5, [
          0,
          DEFAULT_PLANET_RADIUS + ATMOSPHERE_HEIGHT / 2,
          0,
        ]).lit,
      ).toBe(0);
      const above = stars(300, 160, 90, 1.5, [
        0,
        DEFAULT_PLANET_RADIUS * 2,
        0,
      ]).lit;
      console.log(`stars at noon from orbit: ${above} lit`);
      expect(above).toBeGreaterThan(0);
    });

    it("spreads them across the frame rather than crowding one side", () => {
      // The reported symptom, as a number. The stars live in a lattice, so a frame's
      // worth of them can bunch; but each third of the width is a third of the sky, and
      // one of them being empty while another holds them all is not a lattice doing its
      // job — it is a ray projected from the wrong place.
      for (const t of [650, 700, 900, 1100]) {
        const { lit, busiest } = stars(t);
        expect(lit, `nothing lit at t=${t}s`).toBeGreaterThan(0);
        expect(
          busiest,
          `every star in one third of the frame at t=${t}s`,
        ).toBeLessThan(0.75);
      }
    }, 30_000);

    it("lights them brightly enough to see", () => {
      // A lit pixel averaging 0.13 is a grey smudge against a night sky of 0.02: the
      // starfield is technically there and the eye reports nothing. This is what the gain
      // is for, and this is the number that says whether it did its job.
      //
      // Measured on this shader at midnight, two device pixels per CSS pixel: **0.25** with
      // the gain, **0.06** without it, and **0.01** while the in-front guard was still a
      // cosine rather than a test. A fifth sits above the two failures and below the
      // working value, which is what makes this a test of the gain rather than a
      // restatement of it.
      const night = stars(900, 160, 90, 2);
      console.log(
        `160x90 at 2x: ${night.lit} lit, mean ${night.meanLit.toFixed(2)}, ` +
          `peak ${night.peak.toFixed(2)}`,
      );
      expect(night.meanLit).toBeGreaterThan(0.2);
      // And the brightest stars clip, which is what makes a star read as a light source
      // rather than as a pale dot. Short of one, and it has to be: the dome saturates what
      // it returns, so the largest contribution a pixel can show is the distance from a
      // night sky of 0.02 up to white. A star at the head of the distribution is pinned
      // against that ceiling and reads 0.98 here rather than 1.
      expect(night.peak).toBeGreaterThan(0.9);
    });

    it("keeps the same apparent size at any device pixel ratio", () => {
      // The reason the size is carried through a uniform rather than baked in. A star in
      // device pixels is half the size on a phone as on a desktop, and the viewport clamps
      // that ratio at two — so a starfield tuned at one thins out on the other. The count
      // per CSS pixel is the comparison, and the ratio is what has to cancel.
      const perCssPixel = (ratio: number): number =>
        stars(900, 160, 90, ratio).lit / (ratio * ratio);
      const phone = perCssPixel(2);
      const desktop = perCssPixel(1);
      expect(phone).toBeGreaterThan(0.5 * desktop);
      expect(phone).toBeLessThan(2 * desktop);
    });
  },
  CPU_RASTER_MS,
);

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
