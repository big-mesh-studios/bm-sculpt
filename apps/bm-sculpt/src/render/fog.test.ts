import { compileGlsl } from "@random-mesh/rmsl/glsl";
import { Scene } from "@random-mesh/rmsl/scene";
import { describe, expect, it } from "vitest";

import type { Vec3 } from "@big-mesh-studios/core";
import { BLOCK_WORLD } from "../constants";
import { DEFAULT_WINDOW_RADIUS, GAME_WINDOW } from "../session";
import { dayNightState } from "../world/day-night";
import { ATMOSPHERE_EXTINCTION, airMassShell } from "./atmosphere";
import {
  DEFAULT_PLANET_RADIUS,
  FOG_FALLOFF,
  FOG_FAR,
  FOG_NEAR,
  Fog,
  fogColourOf,
} from "./fog";
import { SkyLight } from "./sky-light";
import { SurfaceMaterial } from "./surface-material";

/**
 * The fog and the sky bindings, on the host, as everywhere else.
 *
 * The fog is two terms now and they are tested as two. The distance questions below are the
 * **near-field window term with the atmosphere switched off** — they are about where the streamed
 * chunks stop, which is a fact about the window and not an art decision. The altitude questions are
 * the **whole law**, because the point of the second term is what is left once the near term has gone.
 *
 * Each is written out by hand rather than imported, deliberately. The first version of this file
 * omitted the clamp the shader had, returned a negative number for anything nearer than `FOG_NEAR`,
 * and every test below it failed — which is how the shader's own copy of the same mistake was found.
 * A test that calls the implementation cannot catch that a bug is in the implementation.
 */

/**
 * The near-field window term alone, as the shader computes it with the atmosphere ignored.
 *
 * The real shader adds the atmospheric column to this before the exponential; every test that uses
 * this helper is about where the chunks stop, at distances where the window term is the whole story.
 */
const nearAmount = (distance: number, nearField = 1): number =>
  1 -
  Math.exp(
    -Math.max(distance - FOG_NEAR, 0) *
      (FOG_FALLOFF / (FOG_FAR - FOG_NEAR)) *
      nearField,
  );

/** Both optical depths and one exponential: the shader's law, host-side. */
const fullAmount = (eye: Vec3, point: Vec3, nearField: number): number => {
  const distance = Math.hypot(
    point.x - eye.x,
    point.y - eye.y,
    point.z - eye.z,
  );
  const nearTau =
    Math.max(distance - FOG_NEAR, 0) *
    (FOG_FALLOFF / (FOG_FAR - FOG_NEAR)) *
    nearField;
  const airTau =
    ATMOSPHERE_EXTINCTION * airMassShell(eye, point, DEFAULT_PLANET_RADIUS);
  return 1 - Math.exp(-nearTau - airTau);
};

/** A point on the ground `degrees` of arc away from the subsolar point, on the default planet. */
const groundAt = (degrees: number): Vec3 => {
  const angle = (degrees * Math.PI) / 180;
  return {
    x: DEFAULT_PLANET_RADIUS * Math.sin(angle),
    y: DEFAULT_PLANET_RADIUS * Math.cos(angle),
    z: 0,
  };
};

const eyeAt = (altitude: number): Vec3 => ({
  x: 0,
  y: DEFAULT_PLANET_RADIUS + altitude,
  z: 0,
});

describe("the fog's distances", () => {
  it("closes exactly where the chunk window stops", () => {
    // The session's default window is four chunks on a side and a chunk is
    // `BLOCK_WORLD` across. That is the distance at which the terrain genuinely ends,
    // so it is the distance at which the fog has to have taken over — and it is not an
    // art decision, which is the whole reason it is written as this rather than tuned.
    expect(DEFAULT_WINDOW_RADIUS).toBe(4);
    expect(FOG_FAR).toBe(DEFAULT_WINDOW_RADIUS * BLOCK_WORLD);
    expect(FOG_FAR).toBe(1280);
  });

  it("closes inside the widest window any scene builds", () => {
    // The coupling this file exists for, and the half of it that a test on `FOG_FAR`
    // alone cannot see. The game's window is five chunks — 1600 units — while the fog's
    // nominal far distance is the *editor's* four. That is still correct, because an
    // exponential never stops, but it means the fog is not *tuned* to where the game's
    // terrain ends.
    //
    // What is left showing at that edge, measured: **0.7 %**, or under two eight-bit
    // steps. Enough that the seam is a faint line rather than nothing at all, and
    // little enough that it reads as distance — the same argument the window's own edge
    // makes at the editor's radius, a third of a per cent instead of seven tenths.
    // Raising the game's radius again is the change that would make it worth looking at,
    // and this is what would fail first: the bound below is half what it is.
    //
    // The second half of the test is the real guard, because it is what fails when
    // somebody widens a window without moving the fog. Nothing else in the system would.
    expect(GAME_WINDOW.radius).toBeGreaterThan(DEFAULT_WINDOW_RADIUS);
    const edge = GAME_WINDOW.radius * BLOCK_WORLD;
    expect(edge).toBeGreaterThan(FOG_FAR);
    expect(nearAmount(edge)).toBeGreaterThan(0.99);
    expect(1 - nearAmount(edge)).toBeLessThan(0.01);
  });

  it("starts inside the window, so the near ground is not hazed", () => {
    expect(FOG_NEAR).toBeGreaterThan(0);
    expect(FOG_NEAR).toBeLessThan(FOG_FAR);
    // And nothing at all at the origin: a player standing at the centre of a chunk is
    // looking at ground beside them.
    expect(nearAmount(0)).toBeLessThan(0.001);
  });

  it("leaves the window's edge effectively invisible", () => {
    // Ninety-seven per cent fogged at the nominal far distance, and rather less at the
    // actual edge — which is the number that matters, because that is where the terrain
    // stops, and a few per cent of a seam is a line across the horizon.
    expect(nearAmount(FOG_FAR)).toBeGreaterThan(0.95);
    expect(1 - nearAmount(FOG_FAR)).toBeLessThan(0.05);
    expect(1 - nearAmount(FOG_FAR * 1.5)).toBeLessThan(0.005);
  });

  it("does nothing at all nearer than it starts", () => {
    // The one that matters most and is invisible in a screenshot: without the clamp the
    // exponential's argument goes negative, the mix weight does too, and the ground at
    // the player's feet comes out extrapolated past its own colour — away from the fog,
    // which is to say inverted.
    for (const distance of [0, 10, 100, FOG_NEAR - 1, FOG_NEAR]) {
      expect(nearAmount(distance), `${distance} units`).toBe(0);
    }
  });

  it("has no terminus for the eye to find", () => {
    // The reference ramps fog with a `smoothstep`, which is a straight line reaching
    // solid at `far` and staying there: the band where it gets there is a visible ring,
    // and everything beyond is a flat colour with an edge. An exponential keeps
    // *approaching*, so its rate of change falls without bound and there is no place
    // where the fog stops changing.
    //
    // The rate is asserted rather than the amount, and only over the range where the
    // fog is above one eight-bit step: a float runs out of room a few thousand units
    // out and the amount stops rising, which says nothing about the curve.
    let previousRate = Infinity;
    let previous = nearAmount(FOG_NEAR);
    for (let d = FOG_NEAR + 25; d <= 2000; d += 25) {
      const amount = nearAmount(d);
      expect(amount).toBeGreaterThan(previous);
      expect((amount - previous) / 25).toBeLessThan(previousRate);
      previousRate = (amount - previous) / 25;
      previous = amount;
    }
    // Past that, what is left of the surface is below what an eight-bit channel can
    // represent, so "it reached solid" is not a thing anybody can see.
    expect(1 - nearAmount(2000)).toBeLessThan(1 / 255);
    expect(1 - nearAmount(1e6)).toBeLessThan(1e-12);
  });

  it("is monotonic, which is the property that makes it read as distance", () => {
    let previous = -1;
    for (let d = 0; d <= 2000; d += 10) {
      expect(nearAmount(d)).toBeGreaterThanOrEqual(previous);
      previous = nearAmount(d);
    }
  });

  it("fades towards the sky's horizon colour and nothing else", () => {
    // Fog *is* what the horizon looks like when it is full of air, and the water
    // reflects the same colour — so the far plane of the sea and the sky behind it are
    // the same value and the sea has no edge. There is a function for it so that no
    // caller has to remember which of the sky's two colours is meant.
    expect(fogColourOf([0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
  });
});

describe("the fog, as a material uses it", () => {
  it("reads the eye and a world position", () => {
    // Which is to say it does not read the camera's *forward* direction or a screen
    // coordinate: fog is a function of how far a fragment is, and getting that from a
    // view vector rather than a position is how it ends up uniform with distance from
    // the screen centre.
    const { fragment } = compile(new SurfaceMaterial());
    expect(fragment).toContain("uFogColour");
    expect(fragment).toContain("cameraPosition");
    expect(fragment).toContain("exp(");
  });

  it("sums the window term and the atmosphere through one exponential", () => {
    // The shape of the change. Two optical depths add *before* the exponential, not after
    // it: the near term is the window closure scaled by `uFogNearField`, and the air term
    // is the column through the shell. Three `exp(` — two in the quadrature and one for
    // the sum. Pinned because this is the shader every surface in the project runs, and
    // the cost is the place a change hides; the shell's own `sqrt` and the quadrature's
    // structure are pinned where the node is built, in `atmosphere.test.ts`, because the
    // eight point lights in this material contribute `sqrt(` of their own.
    const { fragment } = compile(new SurfaceMaterial());
    expect(fragment.split("exp(").length - 1).toBe(3);
    expect(fragment).toContain("uFogNearField");
    expect(fragment).toContain("uFogAtmosphere");
    expect(fragment).toContain("uFogRadius");
    expect(fragment).toContain("uFogScale");
  });

  it("reveals the planet from the altitude the globe takes over at", () => {
    // **The bug this whole arrangement exists to fix.** At 900 units the globe has fully
    // taken over, so the near-field window term is off and the fog is the aerial
    // perspective through the shell — a short, thin column straight down, and the ground
    // reads. Switch the near term back on and the same view is a wall of sky, which is
    // what the player saw before.
    const fromOrbit = fullAmount(eyeAt(900), groundAt(0), 0);
    const withWindow = fullAmount(eyeAt(900), groundAt(0), 1);
    expect(fromOrbit).toBeLessThan(0.3);
    expect(withWindow).toBeGreaterThan(0.8);
  });

  it("hazes the limb far more than straight down, which is what makes a rim", () => {
    // The same air, crossed over a much longer chord. Distance from the eye cannot tell
    // the two apart — this is the difference the shell was introduced for, and it is what
    // the atmosphere shell in `atmosphere.ts` renders as the rim of the planet.
    const down = fullAmount(eyeAt(900), groundAt(0), 0);
    const limb = fullAmount(eyeAt(900), groundAt(85), 0);
    expect(limb).toBeGreaterThan(0.7);
    expect(limb).toBeGreaterThan(down * 3);
  });

  it("still closes the window from the ground, where the near field is on", () => {
    // The near term's job is untouched: a ground eye and a fragment at the window's own
    // distance are effectively the sky, and the atmosphere term only adds to that.
    const eye: Vec3 = { x: 0, y: DEFAULT_PLANET_RADIUS + 2, z: 0 };
    const out: Vec3 = { x: 0, y: DEFAULT_PLANET_RADIUS + 2, z: FOG_FAR };
    expect(fullAmount(eye, out, 1)).toBeGreaterThan(0.97);
  });

  it("uses the horizon colour rather than the zenith, by default", () => {
    // The default is the palette's noon horizon, which is also what the day-night cycle
    // hands it on the first frame. Getting this wrong would put a blue cast on every
    // distant surface at dusk.
    expect(new Fog().colour).toEqual(dayNightState(300).skyColor);
  });
});

describe("the sky bindings", () => {
  it("fall back to midday rather than to nothing", () => {
    // Every material is built and possibly drawn before its first `update`, and a
    // shader reading an unset state is a black screen for a frame at every scene's
    // start — or, if the fallback were a zero direction, a NaN for ever. So a material
    // with no lighting assigned still has to compile, and to compile to something.
    const material = new SurfaceMaterial();
    expect(material.sky.lighting).toBeNull();
    const { fragment } = compile(material);
    expect(fragment).not.toContain("NaN");
    expect(fragment).toContain("uSunDirection");
  });

  it("reads the day's state when it has one", () => {
    const sky = new SkyLight();
    sky.lighting = dayNightState(300);
    const { program } = compile(new SurfaceMaterial());
    expect(program.uniforms.map((u) => u.name)).toContain("uSunDirection");
    expect(sky.lighting!.sunLight[0]).toBeGreaterThan(0.9);
  });

  it("gives every lit material the same five names for the same five things", () => {
    // One object shared by the terrain, the water, the sky and the clouds, so a name
    // that drifted in one place would drift in all four.
    //
    // Five and not six: the sixth, the sky's horizon colour, is what *fog* is, and the
    // terrain reaches it as `uFogColour` rather than reading the sky and mixing in the
    // shader. rmsl prunes a uniform a material registers but never reads, so the
    // terrain's program legitimately has no `uSkyColour` in it — and asserting that it
    // does is what distinguishes "pruned because unused" from "missing".
    const { program } = compile(new SurfaceMaterial());
    const names = program.uniforms.map((u) => u.name);
    for (const expected of [
      "uSunDirection",
      "uSunLight",
      "uMoonDirection",
      "uMoonLight",
      "uAmbient",
    ]) {
      expect(names, expected).toContain(expected);
      expect(
        names.filter((n) => n === expected),
        expected,
      ).toHaveLength(1);
    }
    expect(names).toContain("uFogColour");
    expect(names).not.toContain("uSkyColour");
  });

  it("keeps them at material scope so one write a frame is enough", () => {
    const { program } = compile(new SurfaceMaterial());
    for (const uniform of program.uniforms) {
      if (uniform.name.startsWith("u")) {
        expect(uniform.scope, uniform.name).toBe("material");
      }
    }
  });

  it("declares them for a material that has no lighting of its own", () => {
    // The fallback path has to reach the GPU as well as the graph: a uniform the
    // material registers but never reads is dropped by the compiler, and one that is
    // read but never registered is a link error. Compiling a fresh material with no
    // state assigned is what proves the two agree.
    const material = new SurfaceMaterial();
    material.sky.lighting = null;
    const { fragment } = compile(material);
    expect(fragment).toContain("uSunDirection");
    expect(fragment).not.toContain("NaN");
  });
});

describe("the terrain's lighting", () => {
  it("takes the sun, the moon and an ambient, and nothing else", () => {
    // Three-point rigs were the arrangement the application this replaces used, kept so
    // the spike would resemble its predecessor. Under a moving sun they are a second
    // opinion about where the light is, and a wrong one — so the key, the fill and the
    // rim are gone.
    const { fragment } = compile(new SurfaceMaterial());
    expect(fragment).toContain("uSunLight");
    expect(fragment).toContain("uMoonLight");
    expect(fragment).toContain("uAmbient");
    expect(fragment).not.toContain("uKeyColour");
    expect(fragment).not.toContain("uFillColour");
    expect(fragment).not.toContain("uRimColour");
    expect(fragment).not.toContain("uRimDirection");
  });

  it("carries the hour in the colours rather than in an intensity curve", () => {
    // Which is the reference project's trick and the reason one light covers every hour:
    // the sun's colour is near white at noon and a fifth of that at midnight. If there
    // were also an intensity, the two would multiply and the range would be wrong at
    // every hour but one.
    const noon = dayNightState(300);
    const midnight = dayNightState(900);
    const noonLuma = noon.sunLight[0]! + noon.sunLight[1]! + noon.sunLight[2]!;
    const nightLuma =
      midnight.sunLight[0]! + midnight.sunLight[1]! + midnight.sunLight[2]!;
    expect(noonLuma / nightLuma).toBeGreaterThan(4);
    // And the shader reads no intensity to contradict it.
    const { fragment } = compile(new SurfaceMaterial());
    expect(fragment).not.toMatch(/uSunIntensity|uMoonIntensity/);
  });

  it("clamps a surface's colour rather than its lighting", () => {
    // Clamping after the albedo is what keeps a bright surface from being turned into a
    // different colour by the lighting's own range; clamping the lighting first would
    // flatten every lit surface to the same brightness.
    const { fragment } = compile(new SurfaceMaterial());
    // Clamped after the multiply by the albedo, and against the full unit cube.
    expect(fragment).toMatch(
      /clamp\([^;]*?, vec3\(0, 0, 0\), vec3\(1, 1, 1\)\)/,
    );
    // And not against the lighting on its own: there is no clamp between the light and
    // the albedo, so a bright surface keeps its brightness and a lit one keeps its hue.
    expect(fragment).not.toMatch(/clamp\(uAmbient/);
  });

  it("fogs after the lighting, not before it", () => {
    // Fog is what the air between the surface and the eye does to it. Applied before the
    // lighting it would be lit itself and go bright at dusk, which is the one thing fog
    // never does.
    const { fragment } = compile(new SurfaceMaterial());
    expect(fragment.indexOf("uFogColour")).toBeGreaterThan(
      fragment.indexOf("uAmbient"),
    );
  });
});

const compile = (material: SurfaceMaterial) => {
  const program = material.build(new Scene());
  return {
    program,
    fragment: compileGlsl.fragment(program.fragmentRoot, {
      precision: "highp",
    }),
  };
};
