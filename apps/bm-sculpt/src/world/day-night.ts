/**
 * A twenty-minute day-night cycle: where the sun and moon are, and what colour
 * the light is. Every function here is pure, so the cycle is unit-testable and
 * the caller can ask it for the frame's lighting without owning a clock.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape`, which owns the same cycle
 * in `src/environment/day-night.ts`. What came across is the shape of it: a
 * palette of three stops tweened through a warm midpoint, a moon placed exactly
 * opposite the sun, a phase vocabulary of day / sunset / night / sunrise, and
 * the whole thing parameterised by a single elapsed-seconds argument.
 *
 * What did not come across is the sun's path. The reference walks elevation
 * through a piecewise-linear curve — 35° to 60° and back, then a dive to −25°
 * held flat all night — which is a *drawn* arc rather than a computed one. It
 * reads fine and it is cheap, but its dawn and its dusk are the same length by
 * construction, and no latitude on earth has that. Here the sun is placed by
 * the standard solar-position solution for a latitude and a declination, so the
 * elevation curve is the one the model actually produces: it peaks where the
 * model peaks, it crosses zero when the model says it crosses zero, and the
 * twilight windows come out longer or shorter than each other as a consequence
 * of the geometry rather than as a decision.
 *
 * The consequence worth stating plainly is that the *phases are now solar*,
 * not a partition of the clock. The reference could classify by wall-clock
 * because its sun path was piecewise and its palette windows were hardcoded to
 * match. Here a phase is a statement about the sun's elevation — above the
 * twilight band, inside it and falling, under it, inside it and rising — so the
 * sky can never be painted dusk while the sun is twenty degrees up, which is
 * the failure mode a hand-drawn curve and a hand-painted palette drift into.
 */

/**
 * One turn of the clock, in seconds.
 *
 * Twenty minutes, from the reference. Long enough that a session sees a whole
 * day without waiting out real time for it, short enough that night does not
 * outlast the player's interest in it.
 */
export const CYCLE_SECONDS = 1200;

/**
 * Where solar noon lands in the cycle, in seconds.
 *
 * A quarter of the way in, which is where the reference put it: its day runs
 * from the first sunrise to the first sunset, with noon at the middle of that
 * run. The hour angle below is built around this number rather than around
 * midnight, because the cycle starts at dawn — a world that opens on a sunrise
 * is a better first frame than one that opens on the small hours.
 */
export const NOON_SECONDS = CYCLE_SECONDS / 4;

/**
 * Nominal phase boundaries, kept for the console's presets.
 *
 * These are what the sun's elevation produces at the default latitude and
 * declination, rounded — they are a convenience for `/clock:sunset` and its
 * siblings, not the definition of where a phase begins. `phaseAt` is. Read
 * them as "roughly where dusk was the last time we looked", and prefer
 * `phasePreset` for anything that has to be correct.
 */
export const DAY_SECONDS = NOON_SECONDS * 2;
export const SUNSET_SECONDS = 90;
export const NIGHT_SECONDS = 420;
export const SUNRISE_SECONDS = 90;

/**
 * Elevation, in degrees, below which a sun or moon disc is hidden.
 *
 * A few degrees under the horizon, so a disc does not hang at the horizon line
 * after the terrain has stopped being able to occlude it — which is what hides
 * the sun behind a hill everywhere else in this scene.
 */
export const VISIBLE_ELEVATION = -8;

/**
 * The observer's latitude, in degrees north.
 *
 * Forty-five. Arbitrary, and deliberately mid-latitude: the point of a computed
 * solar path is that the dawn and dusk windows differ in length, and that
 * difference is legible at this latitude and nearly invisible near the equator.
 */
export const SOLAR_LATITUDE_DEG = 45;

/**
 * The sun's declination, in degrees — how far north or south of the celestial
 * equator the sun is.
 *
 * Zero, which is an equinox and therefore a twelve-hour day. A real cycle would
 * carry a calendar and derive this from the day of the year with Cooper's
 * equation; this one does not, because a repeating sky is worth more here than
 * a seasonal one, and a season would make two visits to the same `elapsed` give
 * two different skies. Zero is chosen over any other constant because it is the
 * value that makes sunrise and sunset symmetric about noon, so the default
 * configuration's timings line up with the reference's.
 */
export const SOLAR_DECLINATION_DEG = 0;

/**
 * Solar elevation, in degrees, above which the sky is painted as full day.
 *
 * Six, not zero. The sky is visibly day-coloured while the sun is still below
 * the horizon — the sun clears the ground long before the light changes
 * character — and thresholding at zero would snap the palette from warm to
 * bright in a single frame. Six degrees is roughly where it stops reading as
 * golden.
 */
export const TWILIGHT_HIGH_DEG = 6;

/**
 * Solar elevation, in degrees, below which the sky is painted as full night.
 *
 * Minus twelve. Civil twilight ends at minus six, but that is the point at
 * which *outdoor work* stops, not the point at which the sky has finished
 * changing: the last of the blue and the first stars are still arriving for
 * another six degrees after it. Painting night from minus six put a hard cut in
 * the middle of the darkest blue, which is the one colour the whole cycle is
 * built to arrive at.
 */
export const TWILIGHT_LOW_DEG = -12;

/** Which part of the cycle the light is in. */
export type Phase = "day" | "sunset" | "night" | "sunrise";

/**
 * A colour or direction as three plain numbers.
 *
 * A tuple rather than this project's `Vec3` object because everything this
 * module produces is handed straight to a material's uniform thunk, which takes
 * `number[]`, and an object per frame per channel is an allocation the render
 * loop should not be making. Converted to whatever a consumer's own type is at
 * the boundary.
 */
export type Vec3 = [number, number, number];

export interface DayNightState {
  /** Which part of the cycle the light is in, from the sun's elevation. */
  phase: Phase;
  /**
   * Raw clock seconds the state was derived from, unwrapped, so a dependent
   * system reads the same time the sun does.
   */
  elapsed: number;
  /** Unit direction from the world origin toward the sun. */
  sunDir: Vec3;
  /** Unit direction from the world origin toward the moon. */
  moonDir: Vec3;
  /** Diffuse light the sun contributes. Its brightness lives here, not in an
   *  intensity curve — one value that falls from near-white at noon to a fifth
   *  of that at night, rather than a constant colour scaled up and down. */
  sunLight: Vec3;
  /** Diffuse light the moon contributes; zero while the sun is up. */
  moonLight: Vec3;
  /** Flat, non-directional fill. What a surface receives however it is turned. */
  ambient: Vec3;
  /** Sky colour at the horizon. Drives the clear colour and the fog. */
  skyColor: Vec3;
  /**
   * Sky colour overhead.
   *
   * A second colour rather than deriving one from `skyColor`, because the relation
   * between a zenith and its horizon is not a scalar: at noon the zenith is a deep
   * blue against a pale one, and at sunset the zenith is *still* blue while the
   * horizon has gone orange. Any single hue shift gets one of those two wrong, and
   * the wrong one is dusk — the twenty per cent of the cycle where the sky is mostly
   * read from its gradient.
   */
  skyZenith: Vec3;
  /** Sun elevation in degrees; negative below the horizon. */
  sunElevation: number;
  /** Moon elevation in degrees; negative below the horizon. */
  moonElevation: number;
  /** Whether the sun disc should be drawn. */
  sunVisible: boolean;
  /** Whether the moon disc should be drawn. */
  moonVisible: boolean;
  /**
   * How far through the twilight transition the light is, from full day at 0
   * to full night at 1.
   *
   * The parameter the palette tween runs on. Exposed because it is the one
   * number in this module that is not a colour or a direction, and it is what
   * the starfield's fade should be driven from rather than from the elevation
   * it happens to be a function of.
   */
  twilight: number;
}

export interface Palette {
  /** At the horizon. */
  sky: Vec3;
  /** Overhead. */
  zenith: Vec3;
  ambient: Vec3;
  sunLight: Vec3;
  moonLight: Vec3;
}

const DAY: Palette = {
  sky: [0.53, 0.81, 0.92],
  zenith: [0.16, 0.36, 0.72],
  ambient: [0.45, 0.5, 0.6],
  sunLight: [1.0, 0.98, 0.9],
  moonLight: [0, 0, 0],
};

const DUSK: Palette = {
  sky: [0.95, 0.5, 0.25],
  // Still blue, and only just: by the time the horizon is that orange the zenith has
  // come down to near the horizon's own value, which is what makes dusk read as a
  // single warm sheet rather than as two colours meeting.
  zenith: [0.24, 0.22, 0.4],
  ambient: [0.28, 0.2, 0.18],
  sunLight: [1.0, 0.5, 0.2],
  moonLight: [0.15, 0.2, 0.35],
};

const NIGHT: Palette = {
  sky: [0.02, 0.03, 0.09],
  zenith: [0.008, 0.012, 0.045],
  ambient: [0.05, 0.07, 0.15],
  sunLight: [0.05, 0.08, 0.15],
  moonLight: [0.3, 0.4, 0.65],
};

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const clamp01 = (v: number): number => clamp(v, 0, 1);

const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/**
 * Walks from `from` through `mid` to `to` as `s` goes 0 to 1, so a sunset glows
 * warm at its midpoint instead of fading straight through from day to night.
 */
const tween = (from: Vec3, mid: Vec3, to: Vec3, s: number): Vec3 =>
  s < 0.5 ? mix(from, mid, s * 2) : mix(mid, to, (s - 0.5) * 2);

/** Wraps elapsed seconds into `[0, CYCLE_SECONDS)`, negatives included. */
const cycleTime = (elapsed: number): number =>
  ((elapsed % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS;

/**
 * The sun's position in the observer's horizon frame.
 *
 * `east`, `north` and `up` are the components of the unit vector from the
 * observer toward the sun, expressed along the horizon axes rather than the
 * world ones, so that the latitude and declination appear exactly once in the
 * whole module and everything downstream — elevation, azimuth, direction, phase
 * — is a reading off this.
 *
 * The forms are the textbook ones. `up` is the sine of the altitude, which is
 * why it is all this function needs to return for elevation; `east` is negative
 * for a positive hour angle because a positive hour angle is afternoon and
 * afternoon is to the west.
 */
const horizonFrame = (
  t: number,
): { east: number; north: number; up: number } => {
  // One full turn of the hour angle per cycle, zeroed at solar noon, so H = −90°
  // at dawn, 0° at noon, +90° at dusk and 180° at midnight.
  const hourAngle = ((t - NOON_SECONDS) / CYCLE_SECONDS) * TWO_PI;
  const latitude = SOLAR_LATITUDE_DEG * DEG;
  const declination = SOLAR_DECLINATION_DEG * DEG;

  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const sinH = Math.sin(hourAngle);
  const cosH = Math.cos(hourAngle);

  return {
    east: -cosDec * sinH,
    north: sinDec * cosLat - cosDec * cosH * sinLat,
    up: sinDec * sinLat + cosDec * cosH * cosLat,
  };
};

/**
 * Sun elevation above the horizon, in degrees; negative when below it.
 *
 * @param elapsed - Clock seconds. Wraps, so negatives and multiples of the cycle
 *   are both fine.
 */
export const sunElevationDeg = (elapsed: number): number => {
  const { up } = horizonFrame(cycleTime(elapsed));
  // Clamped because the frame is orthonormal in exact arithmetic and a value a
  // few ulps over 1 would make asin return NaN for one frame at solar noon,
  // and a NaN in a colour uniform is a black screen.
  return Math.asin(clamp(up, -1, 1)) / DEG;
};

/**
 * The sun's compass bearing in degrees: 0 north, 90 east, 180 south, 270 west.
 *
 * @param elapsed - Clock seconds, as above.
 */
export const sunAzimuthDeg = (elapsed: number): number => {
  const { east, north } = horizonFrame(cycleTime(elapsed));
  const degrees = Math.atan2(east, north) / DEG;
  return ((degrees % 360) + 360) % 360;
};

/**
 * How far through the twilight transition the light is, from full day at 0 to
 * full night at 1, linear across the twilight band and clamped outside it.
 *
 * The one parameter the whole palette runs on. It is a function of elevation
 * alone and knows nothing about which way the sun is travelling, so a dawn and a
 * dusk at the same elevation are the same colour — which they are in the sky,
 * and which the reference could not say because it tweened sunrise and sunset
 * in opposite directions over differently-shaped windows.
 */
const twilightAt = (elevation: number): number =>
  clamp01(
    (TWILIGHT_HIGH_DEG - elevation) / (TWILIGHT_HIGH_DEG - TWILIGHT_LOW_DEG),
  );

/**
 * Whether the sun is climbing at this moment.
 *
 * By probing, not by the sign of the hour angle's cosine. The cosine is the
 * cheaper answer and it is wrong near the poles, where the sun can climb at a
 * positive hour angle; probing is right everywhere and costs one extra
 * evaluation of a function with no allocation in it. One second of cycle is a
 * third of a degree, which is far enough above the floating-point noise floor to
 * never tie.
 */
const sunIsRising = (t: number): boolean =>
  sunElevationDeg(t + 1) > sunElevationDeg(t);

/**
 * Which part of the cycle the light is in.
 *
 * A statement about the sun rather than about the clock, so the palette and the
 * light cannot disagree. Above the twilight band is day; under it is night; and
 * inside it, which of the two edges the sun came in through.
 */
export const phaseAt = (elapsed: number): Phase => {
  const t = cycleTime(elapsed);
  const elevation = sunElevationDeg(t);
  if (elevation >= TWILIGHT_HIGH_DEG) return "day";
  if (elevation <= TWILIGHT_LOW_DEG) return "night";
  return sunIsRising(t) ? "sunrise" : "sunset";
};

const paletteAt = (twilight: number): Palette => {
  if (twilight <= 0) return DAY;
  if (twilight >= 1) return NIGHT;
  return {
    sky: tween(DAY.sky, DUSK.sky, NIGHT.sky, twilight),
    zenith: tween(DAY.zenith, DUSK.zenith, NIGHT.zenith, twilight),
    ambient: tween(DAY.ambient, DUSK.ambient, NIGHT.ambient, twilight),
    sunLight: tween(DAY.sunLight, DUSK.sunLight, NIGHT.sunLight, twilight),
    moonLight: tween(DAY.moonLight, DUSK.moonLight, NIGHT.moonLight, twilight),
  };
};

/**
 * The sun's direction in world space, from the horizon frame.
 *
 * The mapping is `east → +X`, `up → +Y`, `north → −Z`, which is the
 * right-handed Y-up arrangement: with East at `+X` and Up at `+Y`, the only
 * axis left for North that keeps the frame right-handed is `−Z`. Getting this
 * backwards is not visible as a mistake — the sun still rises and sets — it is
 * visible as the sun rising in the west.
 *
 * Normalised explicitly because the callers hand this to a shader as a unit
 * vector and because `horizonFrame` is only unit-length to within a few ulps,
 * which is close enough to matter once a phase function squares it.
 */
const sunDirAt = (t: number): Vec3 => {
  const { east, north, up } = horizonFrame(t);
  const dir: Vec3 = [east, clamp(up, -1, 1), -north];
  const length = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return [dir[0] / length, dir[1] / length, dir[2] / length];
};

/**
 * The frame's lighting, for `elapsed` seconds of clock.
 *
 * @param elapsed - Clock seconds. Unwrapped and reported back as given.
 * @returns Everything the renderer needs to light and colour this frame.
 */
export const dayNightState = (elapsed: number): DayNightState => {
  const t = cycleTime(elapsed);
  const sunElevation = sunElevationDeg(t);
  const twilight = twilightAt(sunElevation);
  const palette = paletteAt(twilight);

  // The moon is the anti-sun: no ephemeris, no phase, and a night sky with
  // something in it that is guaranteed to be up whenever the sun is down.
  const moonElevation = -sunElevation;
  const sunDir = sunDirAt(t);
  const moonDir: Vec3 = [-sunDir[0], -sunDir[1], -sunDir[2]];

  return {
    phase: phaseAt(elapsed),
    elapsed,
    sunDir,
    moonDir,
    sunLight: palette.sunLight,
    moonLight: palette.moonLight,
    ambient: palette.ambient,
    skyColor: palette.sky,
    skyZenith: palette.zenith,
    sunElevation,
    moonElevation,
    sunVisible: sunElevation > VISIBLE_ELEVATION,
    moonVisible: moonElevation > VISIBLE_ELEVATION,
    twilight,
  };
};

/**
 * A clock time that sits unambiguously inside `phase`, for a console command to
 * jump to.
 *
 * Found by walking the cycle rather than hardcoded, which is the point: the
 * reference's presets were literal numbers that quietly stopped meaning what
 * they said the moment the sun path changed underneath them. This asks the
 * model where the phase actually is, and takes the midpoint of its longest
 * uninterrupted run so the jump lands as far from either boundary as the phase
 * allows. A phase that never occurs falls back to its nominal boundary, so the
 * console still answers rather than returning something meaningless.
 */
export const phasePreset = (phase: Phase): number => {
  const isPhase = (t: number): boolean => phaseAt(t) === phase;

  // Cut the cycle at a sample that is *not* this phase, so the run that crosses
  // midnight is one run rather than two. Sunrise does exactly that — it starts
  // at 1144 and finishes at 29 — and scanning [0, CYCLE) without this cut would
  // see two halves and pick the midpoint of the longer one, which lands off in
  // the flat blue at one end of the window rather than in the middle of it.
  let cut = 0;
  while (cut < CYCLE_SECONDS && isPhase(cut)) cut++;
  if (cut >= CYCLE_SECONDS) return 0;

  let bestStart = cut;
  let bestLength = 0;
  let runStart = cut;
  let runLength = 0;

  // Stepping at one second is a third of a degree of solar motion, so a phase
  // lasting more than a few seconds is found whole.
  for (let i = 0; i <= CYCLE_SECONDS; i++) {
    const t = (cut + i) % CYCLE_SECONDS;
    if (i === CYCLE_SECONDS) break;
    if (isPhase(t)) {
      if (runLength === 0) runStart = t;
      runLength++;
      if (runLength > bestLength) {
        bestLength = runLength;
        bestStart = runStart;
      }
    } else {
      runLength = 0;
    }
  }

  if (bestLength === 0) {
    return { day: NOON_SECONDS, sunset: 645, night: 900, sunrise: 1140 }[phase];
  }
  return (bestStart + (bestLength - 1) / 2) % CYCLE_SECONDS;
};
