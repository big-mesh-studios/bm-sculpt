/**
 * When the globe takes over.
 *
 * ## What is worth asserting about a fade
 *
 * A crossfade's correctness is entirely in its numbers, and none of them are visible without a
 * browser. The four properties:
 *
 * 1. **Below the start altitude the globe contributes nothing at all** — not "nearly nothing". If it
 *    draws at a thousandth of its alpha over a chunk that is fully opaque, it wins the depth test on
 *    a silhouette that is a slightly different sphere from the chunk's, and the result is a horizon
 *    that crawls.
 * 2. **The ramp is clamped.** The camera can be inside the planet, and can be above the top of the
 *    atmosphere; an unclamped ramp extrapolates the far side of the transition and inverts the fade.
 * 3. **The band is wide enough to be crossed.** The orbital period matters: fly up at a normal speed
 *    and the transition has to take long enough that the eye follows it rather than seeing it as an
 *    event.
 * 4. **The crossover altitude is consistent with the chunks' reach**, or the globe takes over while
 *    the chunks are still the better picture.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PLANET, planetField } from "@big-mesh-studios/csg";
import { DEFAULT_PLAYER_CONFIG } from "../player/player";
import { DEFAULT_PLANET_RADIUS } from "../render/atmosphere";
import {
  CHUNK_REACH,
  GLOBE_FULL_ALTITUDE,
  GLOBE_START_ALTITUDE,
  globeOpacityAt,
  horizonAltitudeFor,
} from "./globe";

describe("the globe's fade", () => {
  it("shows nothing below the start altitude, and everything above the end", () => {
    expect(globeOpacityAt(0)).toBe(0);
    expect(globeOpacityAt(GLOBE_START_ALTITUDE - 1)).toBe(0);
    expect(globeOpacityAt(GLOBE_START_ALTITUDE)).toBe(0);
    expect(globeOpacityAt(GLOBE_FULL_ALTITUDE)).toBe(1);
    expect(globeOpacityAt(GLOBE_FULL_ALTITUDE + 10_000)).toBe(1);
  });

  it("is clamped at both ends, because the camera can be outside the planet", () => {
    // Inside the planet — which the player can be, briefly, after a fall — the altitude is negative
    // and an unclamped ramp would run the fade backwards.
    expect(globeOpacityAt(-5000)).toBe(0);
    expect(globeOpacityAt(-1)).toBe(0);
    // And above the top of the atmosphere.
    expect(globeOpacityAt(1e9)).toBe(1);
  });

  it("rises monotonically, with no step in it", () => {
    // **No step, because a step is a pop.** Every one-unit step through the band has to move the
    // opacity by less than a percent, or there is an altitude at which the globe suddenly exists.
    let previous = globeOpacityAt(GLOBE_START_ALTITUDE);
    for (
      let altitude = GLOBE_START_ALTITUDE;
      altitude <= GLOBE_FULL_ALTITUDE;
      altitude++
    ) {
      const here = globeOpacityAt(altitude);
      expect(here).toBeGreaterThanOrEqual(previous);
      expect(here - previous).toBeLessThan(0.01);
      previous = here;
    }
  });

  it("crosses the band slowly enough to be watched, and not so slowly it stalls", () => {
    // **A duration, not a distance.** The band's 480 units are only meaningful against a speed, and
    // the speed that matters is flight: nobody reaches 420 units of altitude by walking — they would
    // be underground — so this test first used a walking speed and measured a crossfade that takes
    // *two minutes*, which says nothing about the experience. Flight is 60 units a second and a wall
    // climb is 40, so the fade is over in about eight seconds.
    //
    // That is the effect: long enough that the eye follows the planet's detail resolving rather than
    // seeing a switch, short enough that climbing to orbit does not involve waiting for it.
    const seconds =
      (GLOBE_FULL_ALTITUDE - GLOBE_START_ALTITUDE) /
      DEFAULT_PLAYER_CONFIG.speed;
    const climbingSeconds =
      (GLOBE_FULL_ALTITUDE - GLOBE_START_ALTITUDE) /
      DEFAULT_PLAYER_CONFIG.climbSpeed;
    console.log(
      `\n  the crossfade takes ${seconds.toFixed(1)}s flying up, ` +
        `${climbingSeconds.toFixed(1)}s climbing a wall\n`,
    );
    expect(seconds).toBeGreaterThan(2);
    expect(seconds).toBeLessThan(15);
  });

  it("starts above the tallest terrain and below the chunks' reach", () => {
    // **The justification for the constant, and the hard floor under it.** The globe is faded by
    // altitude above the *sea*, so if the band started inside the relief it would blend the globe
    // over the ground underfoot whenever the player stood on a hill. It must start above
    // `highestRadius`, and it must not be so high that the chunks' window edge shows before the
    // globe takes over — so it is also below the chunks' own reach.
    const relief =
      planetField(DEFAULT_PLANET).highestRadius - DEFAULT_PLANET.radius;
    console.log(
      `  terrain rises to ${relief.toFixed(0)} units; the horizon outruns the ` +
        `${CHUNK_REACH}-unit chunks at ${horizonAltitudeFor(CHUNK_REACH, DEFAULT_PLANET_RADIUS).toFixed(0)}\n`,
    );
    expect(GLOBE_START_ALTITUDE).toBeGreaterThan(relief);
    expect(GLOBE_START_ALTITUDE).toBeLessThan(CHUNK_REACH);
  });

  it("is driven by altitude above sea level, not by the camera's radius", () => {
    // **The conversion is the whole risk, so it is done here exactly as the caller does it.**
    //
    // `globeOpacityAt` takes an altitude; the frame loop has a position and a radius. Subtracting
    // the wrong radius moves the entire band: missing the subtraction puts the crossover a whole
    // planet radius up, which on a planet whose total relief is 576 is a height the player can only
    // reach with effort, and the globe would never appear at all.
    const seaRadius = DEFAULT_PLANET_RADIUS;
    const altitudeOf = (radius: number): number => radius - seaRadius;

    expect(globeOpacityAt(altitudeOf(seaRadius))).toBe(0);
    expect(
      globeOpacityAt(altitudeOf(seaRadius + GLOBE_START_ALTITUDE - 1)),
    ).toBe(0);
    expect(globeOpacityAt(altitudeOf(seaRadius + GLOBE_START_ALTITUDE))).toBe(
      0,
    );
    expect(globeOpacityAt(altitudeOf(seaRadius + GLOBE_FULL_ALTITUDE))).toBe(1);

    // And the band sits inside the planet's relief rather than above it, so a player on a mountain is
    // already part-way into it — which is correct, and worth pinning: relief is 576 and the band ends
    // at 900, so a mountain top is at 80% of the fade.
    expect(GLOBE_FULL_ALTITUDE).toBeGreaterThan(500);
  });
});
