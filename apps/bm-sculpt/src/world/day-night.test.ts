import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  DAY_SECONDS,
  NOON_SECONDS,
  SOLAR_DECLINATION_DEG,
  SOLAR_LATITUDE_DEG,
  SUNRISE_SECONDS,
  SUNSET_SECONDS,
  TWILIGHT_HIGH_DEG,
  TWILIGHT_LOW_DEG,
  VISIBLE_ELEVATION,
  dayNightState,
  phaseAt,
  phasePreset,
  sunAzimuthDeg,
  sunElevationDeg,
  type DayNightState,
  type Phase,
  type Vec3,
} from "./day-night";

/** The phase names, in the order the cycle runs through them. */
const PHASES: readonly Phase[] = ["sunrise", "day", "sunset", "night"];

const inUnitRange = (v: Vec3, name: string): void => {
  for (const [i, channel] of v.entries()) {
    expect(channel, `${name}[${i}]`).toBeGreaterThanOrEqual(0);
    expect(channel, `${name}[${i}]`).toBeLessThanOrEqual(1);
  }
};

const lengthOf = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/**
 * Every sample of the cycle at `step` seconds, as a state each.
 *
 * The tests below that claim "no jump" or "never leaves 0..1" are claims about
 * the whole cycle and not about a handful of tidy sample times. A tidy sample
 * is a place a bug can hide, so these walk it.
 */
const walk = (step: number): DayNightState[] => {
  const states: DayNightState[] = [];
  for (let t = 0; t < CYCLE_SECONDS; t += step) states.push(dayNightState(t));
  return states;
};

describe("the cycle's shape", () => {
  it("runs for twenty minutes", () => {
    expect(CYCLE_SECONDS).toBe(1200);
    expect(NOON_SECONDS).toBe(300);
  });

  it("puts solar noon a quarter of the way in", () => {
    expect(NOON_SECONDS).toBe(CYCLE_SECONDS / 4);
  });

  it("keeps the nominal boundaries next to the ones the sun produces", () => {
    // The reference's windows were 600 / 90 / 420 / 90. Nothing in this module
    // reads them — the phases are solar — but they are what `/clock:sunset`
    // style presets are documented against, so a solar model that put dusk a
    // hundred seconds away from 690 would mean the constants were lying.
    expect(DAY_SECONDS).toBe(600);
    expect(SUNSET_SECONDS).toBe(90);
    expect(SUNRISE_SECONDS).toBe(90);

    const sunset = phasePreset("sunset");
    const sunrise = phasePreset("sunrise");
    // The solar twilight windows are not the reference's hardcoded ones, so
    // their midpoints are not the reference's either — but they are close enough
    // that the constants still describe roughly where the light changes.
    expect(Math.abs(sunset - (DAY_SECONDS + SUNSET_SECONDS / 2))).toBeLessThan(
      45,
    );
    expect(
      Math.abs(sunrise - (CYCLE_SECONDS - SUNRISE_SECONDS / 2)),
    ).toBeLessThan(45);
  });
});

describe("the solar model", () => {
  it("peaks at ninety degrees minus the latitude", () => {
    // The defining property of a zero-declination day, and the assertion that
    // would fail first if the elevation formula were transposed.
    expect(SOLAR_DECLINATION_DEG).toBe(0);
    expect(sunElevationDeg(NOON_SECONDS)).toBeCloseTo(
      90 - SOLAR_LATITUDE_DEG,
      9,
    );
  });

  it("puts the sun's lowest night elevation opposite noon", () => {
    expect(sunElevationDeg(NOON_SECONDS + CYCLE_SECONDS / 2)).toBeCloseTo(
      -(90 - SOLAR_LATITUDE_DEG),
      9,
    );
  });

  it("crosses the horizon exactly at dawn and dusk", () => {
    // Only true at zero declination, which is why that is the default: with the
    // sun on the celestial equator a day is half the cycle, so dawn and dusk sit
    // symmetrically about noon and the cycle can open on a sunrise.
    expect(sunElevationDeg(0)).toBeCloseTo(0, 9);
    expect(sunElevationDeg(CYCLE_SECONDS / 2)).toBeCloseTo(0, 9);
  });

  it("rises in the east, crosses south, and sets in the west", () => {
    expect(sunAzimuthDeg(0)).toBeCloseTo(90, 6);
    expect(sunAzimuthDeg(NOON_SECONDS)).toBeCloseTo(180, 6);
    expect(sunAzimuthDeg(CYCLE_SECONDS / 2)).toBeCloseTo(270, 6);
    expect(sunAzimuthDeg(NOON_SECONDS + CYCLE_SECONDS / 2)).toBeCloseTo(0, 6);
  });

  it("sweeps the sun east to west across the whole day", () => {
    // Monotonic through the day, which is what separates a computed arc from the
    // reference's piecewise one — that curve also increased, but by being a
    // drawn polyline whose azimuth jumped between segments.
    let previous = sunAzimuthDeg(0);
    for (let t = 1; t <= CYCLE_SECONDS / 2; t += 1) {
      const azimuth = sunAzimuthDeg(t);
      expect(azimuth).toBeGreaterThan(previous);
      previous = azimuth;
    }
  });

  it("stays continuous all the way round", () => {
    // The single most valuable assertion in this file. A piecewise curve, a
    // hardcoded palette edge, or a sign error in the hour angle all show up here
    // as a step, and every other test in it would still pass.
    const step = 0.1;
    let worstElevation = 0;
    let worstAzimuth = 0;
    let previous = dayNightState(0);
    for (let t = step; t <= CYCLE_SECONDS; t += step) {
      const state = dayNightState(t);
      worstElevation = Math.max(
        worstElevation,
        Math.abs(state.sunElevation - previous.sunElevation),
      );
      const delta = Math.abs(
        ((sunAzimuthDeg(t) - sunAzimuthDeg(t - step) + 540) % 360) - 180,
      );
      worstAzimuth = Math.max(worstAzimuth, delta);
      previous = state;
    }
    // At this latitude the sun climbs about three quarters of a degree a
    // second; a tenth of a second is under a tenth of a degree, and the bound
    // has enough room for that plus the pole wrap of the azimuth at midnight.
    expect(worstElevation).toBeLessThan(0.1);
    expect(worstAzimuth).toBeLessThan(0.1);
  });

  it("never leaves the directions on the unit sphere", () => {
    let worst = 0;
    for (const state of walk(0.5)) {
      worst = Math.max(worst, Math.abs(lengthOf(state.sunDir) - 1));
      worst = Math.max(worst, Math.abs(lengthOf(state.moonDir) - 1));
    }
    expect(worst).toBeLessThan(1e-12);
  });
});

describe("phases", () => {
  it("labels the four parts of the cycle", () => {
    expect(new Set(walk(0.5).map((s) => s.phase))).toEqual(new Set(PHASES));
  });

  it("runs each phase once, in order, with no gaps or overlaps", () => {
    // Walking the cycle must produce a single cyclic run of each phase. A phase
    // that appeared twice would mean a boundary is being crossed twice, and a
    // cycle that never closed would mean the walk disagrees with itself.
    //
    // Sunrise begins at 1144 and ends at 29, so it is entered twice by a walk
    // that starts at 0 and closed at the top — the first and last entries are
    // the same phase and are one run, not two.
    const seen: Phase[] = [phaseAt(0)];
    let previous = seen[0];
    for (let t = 1; t < CYCLE_SECONDS; t++) {
      const phase = phaseAt(t);
      if (phase !== previous) {
        seen.push(phase);
        previous = phase;
      }
    }
    expect(seen.length).toBe(PHASES.length + 1);
    expect(seen[seen.length - 1]).toBe(seen[0]);

    // Started partway into a run, so the order is a rotation of the true one.
    const start = seen.indexOf("sunrise");
    expect(start).toBeGreaterThanOrEqual(0);
    const rotated = [...seen.slice(start), ...seen.slice(0, start)];
    expect(rotated.slice(0, PHASES.length)).toEqual([...PHASES]);
    expect(rotated[PHASES.length]).toBe("sunrise");
  });

  it("durations sum to the cycle", () => {
    const durations = new Map<Phase, number>(
      PHASES.map((phase) => [
        phase,
        walk(0.5).filter((s) => s.phase === phase).length * 0.5,
      ]),
    );
    const total = [...durations.values()].reduce((sum, d) => sum + d, 0);
    expect(total).toBeCloseTo(CYCLE_SECONDS, 6);

    // The solar split is near the reference's 600 / 90 / 90 / 420 but not on it,
    // and it should not be: the twilight windows are a consequence of where the
    // sun is, not a pair of numbers. What is worth pinning is the *shape* — day
    // longest, night next, the two twilight windows equal because the sun is on
    // the celestial equator, and all four near the reference within a tenth.
    expect(durations.get("day")!).toBeGreaterThan(durations.get("night")!);
    expect(durations.get("night")!).toBeGreaterThan(durations.get("sunset")!);
    expect(durations.get("sunrise")).toBeCloseTo(durations.get("sunset")!, 0);
    expect(Math.abs(durations.get("day")! - DAY_SECONDS)).toBeLessThan(70);
    expect(Math.abs(durations.get("sunset")! - SUNSET_SECONDS)).toBeLessThan(
      25,
    );
    expect(Math.abs(durations.get("night")! - 420)).toBeLessThan(80);
  });

  it("has the sun up through the day and down through the night", () => {
    for (const state of walk(0.5)) {
      if (state.phase === "day") expect(state.sunElevation).toBeGreaterThan(0);
      if (state.phase === "night") {
        expect(state.sunElevation).toBeLessThan(0);
      }
    }
  });

  it("agrees with the twilight band at its own edges", () => {
    expect(phaseAt(NOON_SECONDS)).toBe("day");
    expect(sunElevationDeg(NOON_SECONDS)).toBeGreaterThan(TWILIGHT_HIGH_DEG);
    expect(sunElevationDeg(NOON_SECONDS + CYCLE_SECONDS / 2)).toBeLessThan(
      TWILIGHT_LOW_DEG,
    );
  });
});

describe("twilight", () => {
  it("is zero in the day and one at night", () => {
    for (const state of walk(0.5)) {
      if (state.phase === "day") expect(state.twilight).toBe(0);
      if (state.phase === "night") expect(state.twilight).toBe(1);
    }
  });

  it("is strictly inside the band while the sun is in it", () => {
    for (const state of walk(0.5)) {
      if (state.phase === "sunset" || state.phase === "sunrise") {
        expect(state.twilight).toBeGreaterThan(0);
        expect(state.twilight).toBeLessThan(1);
      }
    }
  });

  it("falls as the sun climbs", () => {
    // Twilight is a function of elevation and of nothing else, so it is
    // non-increasing in it. Asserted by sorting the cycle's samples by elevation
    // rather than by walking time, because time is not monotonic in elevation:
    // the sun climbs once before noon and again after midnight, so a time-walk
    // has to tolerate both directions and would pass even if twilight also
    // depended on which way the sun was going.
    const samples = walk(0.25)
      .map((state) => ({
        elevation: state.sunElevation,
        twilight: state.twilight,
      }))
      .sort((a, b) => a.elevation - b.elevation);
    expect(samples.length).toBeGreaterThan(4000);

    let saturatedRuns = 0;
    for (let i = 1; i < samples.length; i++) {
      const lower = samples[i - 1];
      const higher = samples[i];
      // Strictly below the twilight band both clamp to one, so those pairs are
      // ties by construction and say nothing about monotonicity.
      if (lower.twilight >= 1) {
        saturatedRuns++;
        continue;
      }
      expect(
        higher.twilight,
        `elevation ${higher.elevation}`,
      ).toBeLessThanOrEqual(lower.twilight);
    }
    expect(saturatedRuns).toBeGreaterThan(1000);

    // And it is a ramp rather than a step: the band is eighteen degrees wide and
    // the sun crosses it in about fifty seconds of the cycle, twice over, so the
    // unsampled values reach both ends of zero and one.
    const ramp = samples.filter((s) => s.twilight > 0 && s.twilight < 1);
    expect(ramp.length).toBeGreaterThan(400);
    const twilights = ramp.map((s) => s.twilight);
    expect(Math.min(...twilights)).toBeLessThan(0.01);
    expect(Math.max(...twilights)).toBeGreaterThan(0.99);
    // Distinct values, allowing for the dawn and dusk crossings landing on the
    // same elevations and therefore the same twilight — which is the symmetry
    // the next test is about, and which is why this is a fraction and not a
    // count.
    expect(new Set(twilights).size).toBeGreaterThan(twilights.length * 0.75);

    // And it spans the band rather than sitting in one part of it.
    expect(dayNightState(NOON_SECONDS).twilight).toBe(0);
    expect(dayNightState(NOON_SECONDS + CYCLE_SECONDS / 2).twilight).toBe(1);
  });

  it("gives a dawn and a dusk at the same elevation the same colour", () => {
    // The property the reference could not express. Its sun path was asymmetric
    // in time, so it tweened sunrise and sunset in opposite directions over
    // differently-shaped windows and the two could never agree. Parameterising
    // the palette on elevation rather than on the clock makes it automatic.
    const dawn = dayNightState(phasePreset("sunrise"));
    const dusk = dayNightState(phasePreset("sunset"));
    expect(Math.abs(dawn.sunElevation - dusk.sunElevation)).toBeCloseTo(0, 6);
    expect(Math.abs(dawn.twilight - dusk.twilight)).toBeCloseTo(0, 6);
    // Equal to float precision rather than bit-identical: the two presets are
    // found by walking the cycle, so their elevations agree to about a
    // trillionth of a degree rather than exactly, and the palette carries that
    // through to the sixteenth digit of a channel.
    const close = (a: Vec3, b: Vec3): void => {
      for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 12);
    };
    close(dawn.skyColor, dusk.skyColor);
    close(dawn.sunLight, dusk.sunLight);
    close(dawn.moonLight, dusk.moonLight);
    close(dawn.ambient, dusk.ambient);
    // And both are genuinely twilight, not two samples of daylight.
    expect(dawn.twilight).toBeGreaterThan(0.4);
    expect(dawn.twilight).toBeLessThan(0.6);
  });
});

describe("the palette", () => {
  it("warms at the midpoint of the transition", () => {
    // The warm peak is what the dusk stop is for, and it has to land where the
    // transition is halfway rather than at a boundary.
    const dusk = dayNightState(phasePreset("sunset"));
    expect(Math.abs(dusk.twilight - 0.5)).toBeLessThan(0.05);
    expect(dusk.skyColor[0]).toBeGreaterThan(dusk.skyColor[1]);
    expect(dusk.skyColor[1]).toBeGreaterThan(dusk.skyColor[2]);
    expect(dusk.skyColor[0]).toBeGreaterThan(
      dayNightState(NOON_SECONDS).skyColor[0],
    );
  });

  it("lights full and warm at noon, dim and blue at night", () => {
    const noon = dayNightState(NOON_SECONDS);
    expect(noon.sunLight[0]).toBeGreaterThan(0.9);
    expect(noon.ambient[0]).toBeGreaterThan(0.4);
    expect(noon.moonLight).toEqual([0, 0, 0]);

    const midnight = dayNightState(NOON_SECONDS + CYCLE_SECONDS / 2);
    expect(midnight.moonLight[2]).toBeGreaterThan(0.5);
    expect(midnight.ambient[0]).toBeLessThan(0.1);
    expect(midnight.skyColor[2]).toBeGreaterThan(midnight.skyColor[0]);
    // Night is not merely dimmer than noon, it is a fifth as bright — the point
    // of carrying the brightness in the colour rather than in an intensity.
    const noonLuma = noon.sunLight[0] + noon.sunLight[1] + noon.sunLight[2];
    const nightLuma =
      midnight.sunLight[0] + midnight.sunLight[1] + midnight.sunLight[2];
    expect(nightLuma / noonLuma).toBeLessThan(0.3);
  });

  it("keeps every colour in 0..1 all the way round", () => {
    for (const state of walk(0.5)) {
      inUnitRange(state.skyColor, "skyColor");
      inUnitRange(state.ambient, "ambient");
      inUnitRange(state.sunLight, "sunLight");
      inUnitRange(state.moonLight, "moonLight");
    }
  });

  it("moves without jumping", () => {
    // A palette edge that cut rather than tweened would show as a step of most
    // of the day-to-night range in a single frame.
    const step = 0.1;
    let previous = dayNightState(0);
    let worst = 0;
    for (let t = step; t <= CYCLE_SECONDS; t += step) {
      const state = dayNightState(t);
      for (let i = 0; i < 3; i++) {
        worst = Math.max(
          worst,
          Math.abs(state.skyColor[i] - previous.skyColor[i]),
        );
        worst = Math.max(
          worst,
          Math.abs(state.ambient[i] - previous.ambient[i]),
        );
      }
      previous = state;
    }
    expect(worst).toBeLessThan(0.01);
  });
});

describe("the moon", () => {
  it("sits exactly opposite the sun", () => {
    for (const state of walk(2)) {
      expect(state.moonDir[0]).toBeCloseTo(-state.sunDir[0], 12);
      expect(state.moonDir[1]).toBeCloseTo(-state.sunDir[1], 12);
      expect(state.moonDir[2]).toBeCloseTo(-state.sunDir[2], 12);
      expect(state.moonElevation).toBeCloseTo(-state.sunElevation, 12);
    }
  });

  it("is up through the night and down through the day", () => {
    const noon = dayNightState(NOON_SECONDS);
    const midnight = dayNightState(NOON_SECONDS + CYCLE_SECONDS / 2);
    expect(noon.moonVisible).toBe(false);
    expect(midnight.moonVisible).toBe(true);
    expect(midnight.sunVisible).toBe(false);
  });

  it("is visible exactly when it is above the visibility elevation", () => {
    for (const state of walk(0.5)) {
      expect(state.sunVisible).toBe(state.sunElevation > VISIBLE_ELEVATION);
      expect(state.moonVisible).toBe(state.moonElevation > VISIBLE_ELEVATION);
    }
  });
});

describe("the clock", () => {
  it("wraps at the end of the cycle", () => {
    const start = dayNightState(0);
    const end = dayNightState(CYCLE_SECONDS);
    expect(end.phase).toBe(start.phase);
    expect(end.sunDir).toEqual(start.sunDir);
    expect(end.moonDir).toEqual(start.moonDir);
    expect(end.sunLight).toEqual(start.sunLight);
    expect(end.moonLight).toEqual(start.moonLight);
    expect(end.ambient).toEqual(start.ambient);
    expect(end.skyColor).toEqual(start.skyColor);
    expect(end.sunElevation).toBeCloseTo(start.sunElevation, 9);
    expect(end.twilight).toBeCloseTo(start.twilight, 9);
    expect(end.sunVisible).toBe(start.sunVisible);
    expect(end.moonVisible).toBe(start.moonVisible);
  });

  it("repeats every turn of the clock", () => {
    const noon = dayNightState(NOON_SECONDS);
    for (let turns = 1; turns <= 3; turns++) {
      const later = dayNightState(NOON_SECONDS + turns * CYCLE_SECONDS);
      expect(later.sunDir).toEqual(noon.sunDir);
      expect(later.skyColor).toEqual(noon.skyColor);
      expect(later.phase).toBe(noon.phase);
    }
  });

  it("handles negative elapsed by wrapping into the cycle", () => {
    expect(sunElevationDeg(-1)).toBe(sunElevationDeg(CYCLE_SECONDS - 1));
    expect(phaseAt(-1)).toBe(phaseAt(CYCLE_SECONDS - 1));
    expect(dayNightState(-250).sunDir).toEqual(
      dayNightState(CYCLE_SECONDS - 250).sunDir,
    );
  });

  it("reports the time it was given, unwrapped", () => {
    // The weather schedule keys off this rather than off the wrapped time, so a
    // consumer can count days rather than seeing the same second forever.
    const elapsed = CYCLE_SECONDS * 7 + 123;
    expect(dayNightState(elapsed).elapsed).toBe(elapsed);
    expect(dayNightState(-50).elapsed).toBe(-50);
  });

  it("is pure", () => {
    const first = dayNightState(372.5);
    const second = dayNightState(372.5);
    expect(second).toEqual(first);
    expect(second.sunDir).not.toBe(first.sunDir);
  });
});

describe("phase presets", () => {
  it("lands inside the phase it names", () => {
    for (const phase of PHASES) {
      expect(phaseAt(phasePreset(phase)), phase).toBe(phase);
    }
  });

  it("lands at the deepest or brightest point of its phase", () => {
    expect(sunElevationDeg(phasePreset("day"))).toBeCloseTo(
      90 - SOLAR_LATITUDE_DEG,
      6,
    );
    expect(sunElevationDeg(phasePreset("night"))).toBeCloseTo(
      -(90 - SOLAR_LATITUDE_DEG),
      6,
    );
  });

  it("merges a phase that runs across the start of the cycle", () => {
    // Sunrise begins at 1144 and ends at 29, so a scan of [0, CYCLE) sees two
    // halves and the midpoint of the longer one is not the middle of the phase.
    // Splitting it that way put the preset in the flat blue either side of the
    // warm peak rather than on it.
    const sunrise = phasePreset("sunrise");
    expect(sunrise).toBeGreaterThan(1140);
    const state = dayNightState(sunrise);
    expect(state.twilight).toBeCloseTo(0.5, 1);
    expect(state.skyColor[0]).toBeGreaterThan(state.skyColor[2]);
  });

  it("finds each phase's whole span, including across the wrap", () => {
    const spanOf = (phase: Phase): number => {
      let span = 0;
      for (let d = -700; d <= 700; d += 0.5) {
        if (phaseAt(phasePreset(phase) + d) === phase) span += 0.5;
      }
      return span;
    };
    expect(spanOf("sunrise")).toBeGreaterThan(SUNRISE_SECONDS - 20);
    expect(spanOf("sunset")).toBeGreaterThan(SUNSET_SECONDS - 20);
    expect(spanOf("day")).toBeGreaterThan(DAY_SECONDS - 60);
  });
});
