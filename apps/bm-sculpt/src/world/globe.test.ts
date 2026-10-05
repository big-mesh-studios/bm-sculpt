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
 *
 * The fifth thing worth asserting is not about a fade at all: that the globe is drawn as several
 * meshes, none of them over a draw call's vertex limit. That is the `globe's longitude bands`
 * block below, and it is a different kind of property — invisible from every altitude, and the
 * difference between a planet and no planet.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PLANET, planetField } from "@big-mesh-studios/csg";
import { DEFAULT_PLAYER_CONFIG } from "../player/player";
import { DEFAULT_PLANET_RADIUS } from "../render/atmosphere";
import {
  CHUNK_REACH,
  GLOBE_FULL_ALTITUDE,
  GLOBE_SEGMENTS,
  GLOBE_START_ALTITUDE,
  globeBands,
  globeOpacityAt,
  horizonAltitudeFor,
  MAX_DRAW_VERTICES,
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

describe("the globe's longitude bands", () => {
  // The globe is the one geometry in the scene built from a segment count rather than from a chunk,
  // and it is the one geometry that could exceed a draw call's 65,535 vertices: 512 longitude
  // segments by 256 latitudes is 513 × 257 = 131,841. Nothing in this project checks for
  // `OES_element_index_uint`, so over the limit is not a degraded planet but a missing one. These
  // are the assertions that the tessellation is kept and only the *draw* count is spent.

  /** A band's vertex count, as `SphereGeometry` counts it: both ends inclusive. */
  const verticesOf = (segments: number, heightSegments: number): number =>
    (segments + 1) * (heightSegments + 1);

  const shippedHeightSegments = Math.floor(GLOBE_SEGMENTS / 2);

  it("puts every band under the vertex limit", () => {
    // **The assertion the whole mechanism exists to make.** Not "the total is under it" — a total is
    // drawn as separate calls and means nothing; each band is one geometry with one index buffer.
    for (const band of globeBands(GLOBE_SEGMENTS, shippedHeightSegments))
      expect(
        verticesOf(band.segments, shippedHeightSegments),
      ).toBeLessThanOrEqual(MAX_DRAW_VERTICES);
  });

  it("would have been over the limit as one sphere, which is why it is split", () => {
    // **The bug as it stood**, pinned so that a change that quietly restores it is visible. If this
    // ever fails, the limit has moved and the split can be reconsidered — that is the only reason it
    // is allowed to fail.
    expect(verticesOf(GLOBE_SEGMENTS, shippedHeightSegments)).toBeGreaterThan(
      MAX_DRAW_VERTICES,
    );
  });

  it("keeps every segment the silhouette was chosen for", () => {
    // **The reason this is a split and not a thinner sphere.** Losing segments is visible from orbit
    // as a faceted outline; spending a draw call is not. So the bands must sum back to the segment
    // count, and no band may be thinner than another.
    const bands = globeBands(GLOBE_SEGMENTS, shippedHeightSegments);
    const total = bands.reduce((sum, band) => sum + band.segments, 0);
    expect(total).toBe(GLOBE_SEGMENTS);
    for (const band of bands) expect(band.segments).toBe(bands[0]!.segments);
  });

  it("is not avoidable by thinning the sphere instead, because 256 is still over the limit", () => {
    // **The half-measure does not exist, and this is why.** Halving to 256 gives 257 × 257 = 66,049,
    // which is 514 over. The widest single sphere that fits is 254 segments — so "just lower
    // GLOBE_SEGMENTS" means giving up half the silhouette tessellation to save four draw calls, which
    // is the wrong trade and the one this split exists to avoid.
    expect(verticesOf(256, shippedHeightSegments)).toBeGreaterThan(
      MAX_DRAW_VERTICES,
    );
    // And 254 is the boundary: it is exactly the limit, and 253 is under it.
    expect(verticesOf(254, shippedHeightSegments)).toBe(MAX_DRAW_VERTICES);
    expect(verticesOf(253, shippedHeightSegments)).toBeLessThan(
      MAX_DRAW_VERTICES,
    );
  });

  it("takes the fewest bands that fit, because each is a draw call", () => {
    expect(globeBands(GLOBE_SEGMENTS, shippedHeightSegments)).toHaveLength(4);
  });

  it("tiles the sphere exactly, with no gap and no overlap at the joins", () => {
    // **Contiguous and complete.** The bands are named by `phiStart`/`phiLength`, so the seam between
    // two of them is a hole or an overlap if the starts do not abut exactly. A gap is a black
    // meridian down the planet; an overlap is a band drawn twice, which on a `depthWrite: false`
    // transparent surface is a visible bright stripe.
    const bands = globeBands(GLOBE_SEGMENTS, shippedHeightSegments);
    for (const [i, band] of bands.entries()) {
      expect(band.phiStart).toBeCloseTo((i * 2 * Math.PI) / bands.length, 12);
      expect(band.phiLength).toBeCloseTo((2 * Math.PI) / bands.length, 12);
    }
    const covered = bands.reduce((sum, band) => sum + band.phiLength, 0);
    expect(covered).toBeCloseTo(2 * Math.PI, 12);
  });

  it("leaves a sphere that already fits as one mesh", () => {
    // **The banding is a response to the size, so it has to disappear when the size does.** A globe
    // built at a segment count that needs no split must not pay four draw calls for it — and must not
    // need a special case in the caller either, which is why this is a property of the banding
    // rather than a separate code path.
    const bands = globeBands(64, 32);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.segments).toBe(64);
  });

  it("respects a limit the caller sets, so the split is not hard-coded to the hardware", () => {
    // **The limit is a parameter rather than a constant inside the function**, because the limit is a
    // property of the context and every WebGL2 context does not have it. A caller that knows its
    // context has 32-bit indices can pass a number no geometry will reach and get one mesh back.
    const generous = globeBands(
      GLOBE_SEGMENTS,
      shippedHeightSegments,
      1_000_000,
    );
    expect(generous).toHaveLength(1);
    expect(generous[0]!.segments).toBe(GLOBE_SEGMENTS);
  });
});
