/**
 * The sky: a gradient, a starfield, and the two discs.
 *
 * ## Why a dome at all
 *
 * The reference project has no sky. It paints the clear colour and lets the terrain
 * fog dissolve into it, which is the cheap version that reads correctly — and its
 * night is a flat near-black rectangle that a player reads as a broken renderer rather
 * than as midnight. A gradient costs one `mix`; stars cost a hash; a disc costs a dot
 * product. None of it is expensive, and all of it is what makes the sky look like sky.
 *
 * ## The dome is a carrier, not a place
 *
 * A sphere of `SKY_EXTENT`, centred on the eye, drawn with its back faces. Nothing is
 * sampled by world position — the gradient and the stars are functions of the *ray
 * direction*, taken as `normalize(positionWorld - cameraPosition)`. So the dome's
 * geometry carries no information beyond "which way am I looking", and it can follow
 * the camera without snapping, because the only thing it contributes is a direction
 * that is identical for every pixel however the camera moves.
 *
 * That is the same trick the cloud layer uses, and for the same reason: a snapped
 * carrier would move the sky by up to a grid step every time the player crossed one.
 *
 * ## The ordering is the occlusion scheme
 *
 * The dome is added to the scene **first**, and it neither tests nor writes depth. So
 * it fills the frame, and everything drawn after it — terrain, water, clouds — lands on
 * top. Nothing has to know the sky exists. rmsl has no render-order key, so "first" is
 * achieved by being added first, and `createSky` says so.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import {
  dot,
  exp,
  float,
  fract,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  vec3,
  vec4,
} from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  Mesh,
  NodeMaterial,
  Scene,
  Side,
  SphereGeometry,
} from "@random-mesh/rmsl/scene";

import type { Vec3 } from "@big-mesh-studios/core";
import {
  ATMOSPHERE_EXTINCTION,
  ATMOSPHERE_HEIGHT,
  ATMOSPHERE_SCALE_HEIGHT,
  DEFAULT_PLANET_RADIUS,
} from "../render/atmosphere";
import { SkyLight } from "../render/sky-light";
import {
  CYCLE_SECONDS,
  VISIBLE_ELEVATION,
  type DayNightState,
} from "./day-night";

/**
 * How far the dome reaches, in world units.
 *
 * Inside the camera's four-hundred-thousand far plane, and the same figure the cloud layer
 * uses so the two agree about where the world stops. The dome is drawn first and writes
 * no depth, so this number affects nothing but whether the dome's own geometry is
 * clipped.
 */
const SKY_EXTENT = 40000;

/**
 * How the horizon colour becomes the zenith colour.
 *
 * An exponent below one, which pushes the zenith colour outward — the blue starts
 * quite low in a real sky rather than only at the zenith. At 0.75 a ray ten degrees up
 * is already a fifth of the way to the zenith colour, and one at thirty degrees is
 * nearly two thirds.
 */
const GRADIENT_EXPONENT = 0.75;

/** How many cells of the star grid there are along one unit of direction. */
const STAR_GRID = 130;

/**
 * How much of the grid holds a star.
 *
 * One cell in sixty-six. The visible cells are the ones a unit sphere passes through
 * at this grid scale — about four times pi times `STAR_GRID` squared, some two hundred
 * thousand — so this lands a little under three thousand stars, which is a few more than
 * a dark sky really shows and the right number for a game.
 */
const STAR_THRESHOLD = 0.985;

/**
 * How wide a star is, in **CSS pixels**, and how sharply it falls off.
 *
 * **Pixels, and not a fraction of a grid cell — which is what this was, and why the
 * starfield was invisible.** The grid is 130 cells to the radian, so a cell is about a
 * third of a device pixel at 360 lines and a ninth at 1080: a star sized as a fraction
 * of a cell is a *sub-pixel* feature at every resolution anyone plays at, and a
 * sub-pixel feature is invisible however bright it is, because the fragment shader only
 * ever asks about the pixel's centre. Measured over a real frame at night: **zero lit
 * pixels at 640×360** with the old numbers, and about one in two million at 1080×1920.
 *
 * CSS pixels rather than device ones because the viewport clamps the device pixel ratio
 * at two, and a star sized in device pixels is therefore half the size on a phone as on
 * a desktop — a starfield that thins out on the device it was tuned on. The material
 * carries the ratio (`SkyMaterial.pixelScale`) for exactly this.
 *
 * The falloff is soft because the *sampled* brightness is not the star's brightness: a
 * pixel is almost never at a star's centre, and with `pow(point, 14)` the half-bright
 * core was a fiftieth of the radius — six thousandths of a pixel. At 1.6 the disc is a
 * solid middle with a soft edge, which is what a point light source has to look like.
 */
const STAR_PIXELS = 1.6;
const STAR_FALLOFF = 1.6;

/**
 * How much brighter a star is drawn than its own sampled brightness implies.
 *
 * Because of the falloff, the pixel a star lands on reads `pow(point, 1.6)` of it — a
 * seventh at one pixel out. Measured over a real frame, the mean brightness of a lit
 * pixel without this gain is **0.06**, which is a grey dot on a sky of 0.02: present,
 * technically, and invisible to the eye. The gain takes that mean to **0.25** and clips
 * the cores to white, which is the whole difference between "there are stars" and "there
 * are stars you can see".
 *
 * Both numbers are what the built material measures on rmsl's CPU target at two device
 * pixels per CSS pixel — see "the starfield, on the CPU" in `sky.test.ts`, which prints
 * them and fails if the mean falls below a fifth. They were 0.13 and 0.4 once, before the
 * turn and the in-front guard were fixed, and both were wrong: they came from a
 * hand-written transcription of this shader that used a boolean where the shader used a
 * cosine, so it measured a starfield brighter and more even than the one that drew. A
 * constant whose justification cannot be measured is a constant nobody can check, which
 * is why the measuring now happens on the shader.
 */
const STAR_GAIN = 4.5;

/** How much a star's brightness varies from one to the next. */
const STAR_BRIGHTNESS_RANGE = 0.75;

/**
 * How quickly the stars come out.
 *
 * An exponent on the twilight parameter, so they appear through the last of the dusk
 * rather than all at once at the threshold. Star brightness rises with the eye's own
 * adaptation, and this is the shape of it.
 */
const STAR_FADE = 1.4;

/**
 * The sun's and the moon's angular radii, as chord lengths.
 *
 * Chord rather than angle because the cosine of half a degree differs from one in the
 * fifth decimal place, and a `smoothstep` between two numbers that close is a
 * numerical trap at anything below highp. For two unit vectors the chord is twice the
 * sine of half the angle.
 *
 * **These are two to four times life size, deliberately.** A disc at its true angular
 * size is *too small to read*: the moon is half a degree across, which on a phone at a
 * fifty-degree field of view is eight pixels — a dot, and a blue one, since the disc is
 * tinted by the light the moon casts. Every game that draws a moon draws it bigger, and
 * so does this one: 2.2 degrees across for the moon and 1.5 for the sun, which is the
 * point at which each reads as a disc with an edge rather than as a pixel of noise. The
 * *glow* around them is left at its true angular scale, because a glow that is the right
 * size and a disc that is three times it is exactly the look intended.
 */
const SUN_INNER = 0.007;
const SUN_OUTER = 0.013;
const MOON_INNER = 0.01;
const MOON_OUTER = 0.019;

/**
 * The glow around each disc: a wide lobe and a narrow one.
 *
 * This is the term that makes dusk read. The palette already turns the sun's own light
 * orange as it sets, but a disc on its own does not tint the sky it is in, and a sunset
 * is mostly the *sky* around the sun rather than the sun.
 */
const SUN_GLOW_WIDE = 6;
const SUN_GLOW_WIDE_STRENGTH = 0.5;
const SUN_GLOW_NARROW = 90;
const SUN_GLOW_NARROW_STRENGTH = 0.7;
const MOON_GLOW = 40;
const MOON_GLOW_STRENGTH = 0.06;

/** How far below the horizon a disc fades out, in degrees either side of the cutoff. */
const DISC_FADE = 3;

/**
 * A cell of the star grid, hashed to three values in 0..1.
 *
 * Dave Hoskins' `hash33`, which is the standard answer for this and is the only part of
 * the shader that is not a piece of physics. The `sin` of a large dot product is a
 * cheap and well-behaved random source on every GPU, which is why it survived the
 * arrival of compute shaders.
 */
const starHash = (cell: Node<"vec3">): Node<"vec3"> => {
  const q = vec3(
    dot(cell, vec3(127.1, 311.7, 74.7)),
    dot(cell, vec3(269.5, 183.3, 246.1)),
    dot(cell, vec3(113.5, 271.9, 124.6)),
  );
  return fract(sin(q).mul(43758.5453));
};

/**
 * How far round the sky has turned, as the pair of trigonometry the sky needs of it.
 *
 * A pair rather than the angle because every consumer wants the sine and the cosine and
 * not the angle: rmsl emits an expression once per use, so passing the angle about would
 * mean recomputing both functions at each site and would make the "one cosine, one sine"
 * test in `sky.test.ts` unfalsifiable.
 */
interface Turn {
  cos: Node<"float">;
  sin: Node<"float">;
}

/**
 * Rotates a direction about the vertical — the frame the starfield is fixed in.
 *
 * The field does not move, so what moves is the lookup: this takes the ray the eye is
 * looking down into the field's own coordinates.
 */
const turned = (turn: Turn, direction: Node<"vec3">): Node<"vec3"> =>
  vec3(
    direction.x.mul(turn.cos).sub(direction.z.mul(turn.sin)),
    direction.y,
    direction.x.mul(turn.sin).add(direction.z.mul(turn.cos)),
  );

/**
 * And back again, for a direction that has to be projected onto the screen.
 *
 * The inverse of `turned`, which is why the signs swap rather than merely reversing.
 * Everything in the field's frame has to come back through this before it can be
 * projected: `projection · view` is a product of world-space matrices and will turn a
 * celestial-space direction into nonsense without complaining about it.
 */
const unturned = (turn: Turn, direction: Node<"vec3">): Node<"vec3"> =>
  vec3(
    direction.x.mul(turn.cos).add(direction.z.mul(turn.sin)),
    direction.y,
    direction.z.mul(turn.cos).sub(direction.x.mul(turn.sin)),
  );

/**
 * The starfield, from where the eye is and which way the field is turned.
 *
 * The grid is a three-dimensional lattice and the star is a point inside the cell the
 * ray lands in. That is not the usual choice — a cube-face projection is what gives
 * uniform density — but a lattice has no faces to choose between, and the density a
 * unit sphere sees in a shell of unit cells is uniform anyway. The polar clustering
 * that makes the lattice look wrong in a cube projection does not arise here.
 *
 * Everything hashed is put in a variable first. rmsl emits an expression once per use
 * and cannot see that two reads of the same hash are the same hash, so written plainly
 * this evaluates `starHash` eleven times per pixel.
 *
 * ## Two directions, and which of them is which
 *
 * The lattice is fixed in **celestial** space and the sky turns under it, so which cell
 * a ray lands in has to be looked up in the turned direction — that is `field`. But the
 * answer then has to be projected back onto the screen, and the screen is in **world**
 * space, where `projection · view` live and know nothing of the turn. So the star's
 * direction is turned back before it is projected, and the fragment's own direction is
 * projected as it is.
 *
 * **These are two different directions and they are the whole of the bug this signature
 * exists to prevent.** This took one direction and used it for both, which is right at
 * exactly one hour of the cycle — the one where the turn is zero, sunrise, because the
 * cycle is built to start there. Everywhere else the "ray" it projected was ninety or
 * 180 degrees off the actual view ray, so `rayClip.w` came out negative over most of the
 * frame, `bothInFront` zeroed those fragments, and the stars that survived were the ones
 * whose *rotated* direction happened still to be in front of the camera. Midnight lit
 * 51 pixels, all of them in the right-hand third of the screen; dusk, at a hundred and
 * eighty degrees, lit none at all. Sunrise was perfect throughout, which is why this sat
 * unfixed and why a test written against sunrise said the starfield was fine.
 *
 * ## Why the distance is measured in pixels
 *
 * The star's place in the cell is a *direction*, so the natural test is how far the ray
 * is from it in units of cells — and that is the test that made the sky empty, because
 * a cell is a fraction of a pixel (see `STAR_PIXELS`). So the star's direction is
 * projected the way a point at infinity is: `projection · view · vec4(dir, 0)`, divided
 * by `w`, which is exactly where on the screen that direction lies. The distance to the
 * fragment's own direction in the same space is then a distance in device pixels, and a
 * star can be given a size that means something.
 *
 * The cost is two matrix-vector products and two divides per pixel, which is why this is
 * the only screen-space thing in the dome: it has no loops and no texture reads, and
 * this is what a point of light costs.
 */
const starfield = (
  b: Builder,
  ray: Node<"vec3">,
  field: Node<"vec3">,
  turn: Turn,
  pixelScale: Node<"float">,
): Node<"vec3"> => {
  const grid = field.mul(float(STAR_GRID)).toVar();
  const cell = grid.floor().toVar();
  const pick = starHash(cell).toVar();
  const jitter = starHash(cell.add(vec3(7.3, 11.7, 3.1))).toVar();

  // Where in its cell this star sits, as a direction — and then back out of the field's
  // own frame into the world, because the next thing that happens to it is a
  // projection. A star turned the wrong way is a star in the wrong place, which is
  // invisible until the turn is anything but zero.
  const place = cell.add(jitter.mul(0.7).add(0.15)).normalize().toVar();
  const placed = unturned(turn, place).toVar();
  const placeClip = b.projectionMatrix
    .mul(b.viewMatrix)
    .mul(vec4(placed, float(0)))
    .toVar();
  const rayClip = b.projectionMatrix
    .mul(b.viewMatrix)
    .mul(vec4(ray, float(0)))
    .toVar();

  // Both divides are guarded by `w`: a direction at ninety degrees to the view has no
  // screen position, and one behind the camera projects mirrored, so an unguarded
  // distance would be small exactly where it should be undefined.
  //
  // The guard is a *test* of `w` and not `w` itself, which is what this was and why the
  // field was dark away from the middle of the frame. `saturate(w)` returns `w`, not
  // one, for every direction in front of the camera — and `w` is `-z` of the direction in
  // view space, which is its cosine from the view axis. So every star was multiplied by
  // the cosine of its own angle *and* the fragment's: one at the centre of the frame,
  // a half at sixty degrees, a thirtieth at eighty. The gain above was tuned against a
  // transcription that used a boolean, so the stars never got the brightness they were
  // measured at: a lit pixel read 0.01 on this shader against the 0.4 the constant
  // comment claims, which on a night sky of 0.02 is invisible.
  //
  // A step at zero, rather than something smooth, because the fade belongs where the
  // projection stops meaning anything at all — ninety degrees off the view axis, which
  // is off the frame for any field of view narrower than 180 degrees, so it cannot pop
  // anywhere a player can see.
  const placeScreen = placeClip.xy.div(placeClip.w.max(float(1e-6))).toVar();
  const rayScreen = rayClip.xy.div(rayClip.w.max(float(1e-6))).toVar();
  const bothInFront = step(float(1e-6), placeClip.w)
    .mul(step(float(1e-6), rayClip.w))
    .toVar();

  // Half the resolution converts NDC to pixels; the star's radius is then in them.
  const resolution = b.rendererUniform("resolution", "vec2").toVar();
  const offset = rayScreen
    .sub(placeScreen)
    .mul(resolution)
    .mul(0.5)
    .length()
    .toVar();

  // A round point, and how bright this one is: both from the hash, so a cell with no
  // star in it is dark and a cell with one is not a predictable size.
  const radius = float(STAR_PIXELS).mul(pixelScale).toVar();
  const point = saturate(float(1).sub(offset.div(radius)));
  const shape = saturate(pow(point, float(STAR_FALLOFF))).toVar();
  const present = smoothstep(float(STAR_THRESHOLD), float(1), pick.x).toVar();
  const magnitude = pick.y
    .mul(STAR_BRIGHTNESS_RANGE)
    .add(1 - STAR_BRIGHTNESS_RANGE)
    .toVar();

  // Colour, not brightness: a field of identical white dots reads as confetti, while a
  // field with a few distinctly warm and a few distinctly cool ones reads as stars.
  // Returned as a colour rather than folded into a scalar so the hue survives — which is
  // most of what separates "dots" from "stars".
  const hue = pick.z.sub(0.5).toVar();
  const tint = vec3(
    hue.mul(-0.28).add(1),
    hue.mul(0.06).add(1),
    hue.mul(0.42).add(1),
  ).toVar();

  return tint
    .mul(shape)
    .mul(present)
    .mul(magnitude)
    .mul(float(STAR_GAIN))
    .mul(bothInFront);
};

/**
 * A disc with a soft edge, from a direction and an angular size.
 *
 * `1 - smoothstep`, because the inner edge is the smaller chord and a smoothstep runs
 * from its first argument to its second.
 */
const disc = (
  direction: Node<"vec3">,
  toward: Node<"vec3">,
  inner: number,
  outer: number,
): Node<"float"> => {
  const chord = direction.sub(toward).length();
  return float(1).sub(smoothstep(float(inner), float(outer), chord));
};

/** Whether a disc is above the cutoff, faded rather than cut. */
const elevationFade = (elevation: Node<"float">): Node<"float"> =>
  smoothstep(
    float(VISIBLE_ELEVATION - 1),
    float(VISIBLE_ELEVATION + DISC_FADE),
    elevation,
  );

/**
 * The dome.
 *
 * Exported because the test compiles it, and compiling is the only thing about a
 * shader that can be checked without a graphics device.
 */
export class SkyMaterial extends NodeMaterial {
  /**
   * The day this is lit by, shared with every other lit material.
   *
   * The dome needs six things the terrain, the water and the clouds also need — the two
   * directions, the three colours and the horizon — so they are one object rather than
   * four copies of six uniforms. What is left here is what only a sky needs: the zenith
   * colour, the twilight parameter, the two elevations and the starfield's turn.
   */
  readonly sky = new SkyLight();

  /** Multiplies every star. The one knob here worth having. */
  starBrightness = 1;

  /**
   * The device pixel ratio the canvas is drawing at.
   *
   * Read per draw, so a resize needs no `needsUpdate` and no scene rebuild. It exists
   * because a star sized in device pixels is half the size on a phone as on a desktop,
   * and the viewport clamps that ratio at two — so a starfield tuned on a desktop
   * silently thins out on the device it was tuned *for*. One and a half is the default
   * rather than one because most of what this runs on is not a one.
   */
  pixelScale = 1.5;

  /** The planet's sea radius, so the shell the sky reads is this world's and not a constant's. */
  readonly planetRadius: number;

  /** How far the shell reaches above the sea. */
  readonly atmosphereHeight: number;

  /** How fast the air thins with height. */
  readonly scaleHeight: number;

  private zenith?: UniformNode<"vec3">;
  private twilight?: UniformNode<"float">;
  private sunElevation?: UniformNode<"float">;
  private moonElevation?: UniformNode<"float">;
  private starTurn?: UniformNode<"float">;
  private starBrightnessUniform?: UniformNode<"float">;
  private pixelScaleUniform?: UniformNode<"float">;
  private planetRadiusUniform?: UniformNode<"float">;
  private atmosphereUniform?: UniformNode<"float">;
  private scaleUniform?: UniformNode<"float">;

  constructor(
    planetRadius = DEFAULT_PLANET_RADIUS,
    atmosphereHeight = ATMOSPHERE_HEIGHT,
    scaleHeight = ATMOSPHERE_SCALE_HEIGHT,
  ) {
    super();
    this.planetRadius = planetRadius;
    this.atmosphereHeight = atmosphereHeight;
    this.scaleHeight = scaleHeight;
    // No depth at all. The dome is drawn first and fills the frame, and everything
    // after it lands on top; a dome that tested depth would have to be sorted against
    // forty thousand units of cloud and a terrain window, for no gain.
    this.depthTest = false;
    this.depthWrite = false;
    this.side = Side.BackSide;
  }

  protected override setup(b: Builder): void {
    // Every thunk reads the day's state per draw, which is what lets the whole lighting
    // be handed over once a frame with no `needsUpdate` anywhere. The fallbacks are what
    // a frame before the first `update` would otherwise read: no sun, no moon, full
    // night. A sky that arrives one frame late rather than as a flash of black.
    this.sky.declare(b);
    const f = 0;
    const v: [number, number, number] = [0, 0, 0];
    this.zenith = b.materialUniform("uZenith", "vec3", () =>
      this.sky.lighting ? this.sky.lighting.skyZenith : v,
    );
    this.twilight = b.materialUniform("uTwilight", "float", () =>
      this.sky.lighting ? this.sky.lighting.twilight : 1,
    );
    this.sunElevation = b.materialUniform("uSunElevation", "float", () =>
      this.sky.lighting ? this.sky.lighting.sunElevation : f,
    );
    this.moonElevation = b.materialUniform("uMoonElevation", "float", () =>
      this.sky.lighting ? this.sky.lighting.moonElevation : f,
    );
    this.starBrightnessUniform = b.materialUniform(
      "uStarBrightness",
      "float",
      () => this.starBrightness,
    );
    this.pixelScaleUniform = b.materialUniform(
      "uStarPixelScale",
      "float",
      () => this.pixelScale,
    );
    // How far round the sky has turned. Reduced modulo a whole turn *on the host*,
    // because the clock is unbounded: `elapsed / 1200` passes a thousand turns in an
    // hour, and at a thousand turns a float32 cosine has lost every digit that mattered
    // and the starfield judders.
    this.starTurn = b.materialUniform("uStarTurn", "float", () =>
      this.sky.lighting === null
        ? 0
        : ((this.sky.lighting.elapsed / CYCLE_SECONDS) % 1) * Math.PI * 2,
    );
    // The shell, so the sky can tell air from space: the eye's own altitude sets how much
    // atmosphere is above it, and the same geometry draws the planet's rim.
    this.planetRadiusUniform = b.materialUniform(
      "uSkyRadius",
      "float",
      () => this.planetRadius,
    );
    this.atmosphereUniform = b.materialUniform(
      "uSkyAtmosphere",
      "float",
      () => this.atmosphereHeight,
    );
    this.scaleUniform = b.materialUniform(
      "uSkyScale",
      "float",
      () => this.scaleHeight,
    );
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const raw = b.positionWorld.sub(b.cameraPosition).normalize().toVar();

    // The gradient runs on the true direction. The stars run on a direction turned
    // about the vertical by the hour, so that they rise in the east and set in the
    // west along with the sun.
    //
    // A real sky wheels about a celestial pole at the observer's latitude rather than
    // about the horizon, and this is a simplification of that: the tilt is left out
    // because it is a refinement nobody would read in a twenty-minute cycle, and the
    // east-to-west component is the whole of the motion at this scale.
    const turn = this.starTurn!.toVar();
    const spin: Turn = { cos: turn.cos().toVar(), sin: turn.sin().toVar() };
    // The field is fixed in celestial space, so what moves is the *lookup*: this is
    // the inverse of the apparent motion. Written out, a star due east at dusk is due
    // south a quarter-cycle later — the same direction the sun gets to — and the
    // naive sign puts it due north instead, which is a sky that runs backwards.
    const field = turned(spin, raw).toVar();

    // ---- how much air is left above the eye ----
    // The sky *is* the atmosphere lit from behind. Once the eye is above the shell there is
    // nothing left to scatter the daylight and the sky goes black, which is the whole reason
    // a player who leaves the atmosphere sees stars at noon. `atmosphere` is the fraction of
    // the ground's own column still overhead: one at sea level, nothing at the top.
    const eyeRadius = b.cameraPosition.length();
    const altitude = eyeRadius.sub(this.planetRadiusUniform!).max(float(0));
    const atmosphere = exp(altitude.div(this.scaleUniform!).negate()).toVar();

    // ---- how much of the view is *outside* the shell ----
    // **"Above the shell", not "the air is thin".** The limb and the stars are the view from
    // outside, and `1 - atmosphere` is a poor test for it: at two scale heights — still well inside
    // the 4,800-unit shell — it is already 0.86, so the from-outside limb was drawn on top of the
    // gradient's own horizon glow while the player climbed out, reading as a second fog band in the
    // sky. The eye is genuinely in space only past the shell's top, so this is gated there and
    // faded across one shell thickness so crossing it is not a pop.
    const shellTop = this.planetRadiusUniform!.add(this.atmosphereUniform!);
    const fromSpace = saturate(
      eyeRadius.sub(shellTop).div(this.atmosphereUniform!),
    ).toVar();

    // ---- the gradient ----
    const upward = saturate(raw.y);
    const gradient = pow(upward, float(GRADIENT_EXPONENT)).toVar();
    const sky = this.sky
      .skyColour!.mix(this.zenith!, gradient)
      .mul(atmosphere)
      .toVar();

    // ---- the glow around the sun, which is most of what a sunset is ----
    const toSun = saturate(dot(raw, this.sky.sunDirection!)).toVar();
    const wide = pow(toSun, float(SUN_GLOW_WIDE))
      .mul(SUN_GLOW_WIDE_STRENGTH)
      .toVar();
    const narrow = pow(toSun, float(SUN_GLOW_NARROW)).mul(
      SUN_GLOW_NARROW_STRENGTH,
    );
    // Strongest when the sun is *lowest*, because that is when its light has come
    // through the most atmosphere. Scaling this by elevation upwards — the obvious
    // first attempt — makes the glow vanish at exactly the moment a sunset is meant
    // to happen.
    const low = float(1).sub(saturate(this.sunElevation!.div(25)));
    // The glow is atmosphere, so it goes out with the rest of the sky — the sun is left a
    // hard disc in a black field when there is no air to spread it.
    sky.addAssign(
      this.sky.sunLight!.mul(wide.add(narrow)).mul(low).mul(atmosphere),
    );

    // ---- the moon's, much weaker and cool ----
    const toMoon = saturate(dot(raw, this.sky.moonDirection!));
    sky.addAssign(
      this.sky
        .moonLight!.mul(pow(toMoon, float(MOON_GLOW)).mul(MOON_GLOW_STRENGTH))
        .mul(atmosphere),
    );

    // ---- the rim of the atmosphere, seen from outside it ----
    // The same shell `fog.ts` integrates, read here for the ray instead of for a fragment:
    // the air mass is the length of the **ray**, not the line, inside the shell, minus the part
    // the planet blocks, weighted by the density at its closest approach. It is zero until the
    // eye is above the ground and grows as the ray grazes, so in space it draws the band around
    // the silhouette and nothing else.
    const eyeSquared = b.cameraPosition.dot(b.cameraPosition);
    const along = b.cameraPosition.dot(raw);
    const closestSq = eyeSquared.sub(along.mul(along)).max(float(0));
    const closest = sqrt(closestSq);
    const planetRadius = this.planetRadiusUniform!;
    const outerRadius = planetRadius.add(this.atmosphereUniform!);

    // **The roots are clamped to `t ≥ 0`, and that is the whole correction.** The chord's midpoint
    // is at `t = -along`; when `along > 0` the ray points away from the planet and that midpoint is
    // *behind the eye*. A player looking up makes exactly this ray, its perpendicular distance to
    // the centre is zero, and the old code counted a full atmosphere column that was behind the
    // camera — a fog band across the black of space. Each sphere's near and far roots are
    // `-along ∓ half`, so clamping both to zero gives the length actually in front of the eye.
    const tc = along.negate();
    const outerHalf = sqrt(
      outerRadius.mul(outerRadius).sub(closestSq).max(float(0)),
    );
    const innerHalf = sqrt(
      planetRadius.mul(planetRadius).sub(closestSq).max(float(0)),
    );
    const outerFront = tc
      .add(outerHalf)
      .max(float(0))
      .sub(tc.sub(outerHalf).max(float(0)));
    const innerFront = tc
      .add(innerHalf)
      .max(float(0))
      .sub(tc.sub(innerHalf).max(float(0)));
    // Inside the silhouette the planet blocks the middle of the chord, so only the caps of air in
    // front of it count. Where the line does not cross the planet (`closest >= R`) nothing blocks.
    const blocked = select(
      closest.lessThan(planetRadius),
      innerFront,
      float(0),
    );
    const air = outerFront
      .sub(blocked)
      .mul(
        exp(
          closest
            .sub(planetRadius)
            .max(float(0))
            .div(this.scaleUniform!)
            .negate(),
        ),
      );
    const limb = float(1).sub(exp(air.mul(float(-ATMOSPHERE_EXTINCTION))));
    // Only from outside: on the ground the horizon is the gradient's and the fog's job, and a
    // limb term there would white out the whole lower sky. `fromSpace`, defined above, is zero
    // until the eye clears the shell's top.
    sky.addAssign(this.sky.skyColour!.mul(limb).mul(fromSpace));

    // ---- the stars ----
    // Above the horizon, once the twilight parameter has climbed — **or once the eye is out
    // of the atmosphere**, which is the half this change adds. The two are `max`ed rather
    // than added: a star is revealed by the night or by the vacuum, and never twice as bright
    // for being both.
    const night = saturate(this.twilight!).toVar();
    const horizonFade = upward.mul(0.35).add(0.65);
    const inTheDark = saturate(pow(night, float(STAR_FADE))).mul(horizonFade);
    const inSpace = fromSpace.mul(horizonFade);
    sky.addAssign(
      starfield(b, raw, field, spin, this.pixelScaleUniform!)
        .mul(inTheDark.max(inSpace))
        .mul(this.starBrightnessUniform!),
    );

    // ---- the two discs ----
    const sunUp = elevationFade(this.sunElevation!).toVar();
    const moonUp = elevationFade(this.moonElevation!).toVar();

    sky.assign(
      sky.add(
        this.sky
          .sunLight!.mul(
            disc(raw, this.sky.sunDirection!, SUN_INNER, SUN_OUTER),
          )
          .mul(sunUp)
          .mul(2.0),
      ),
    );
    sky.addAssign(
      this.sky
        .moonLight!.mul(
          disc(raw, this.sky.moonDirection!, MOON_INNER, MOON_OUTER),
        )
        .mul(moonUp)
        // Lifted above the colour it casts. `moonLight` is the light the moon puts on
        // the world — dim and blue, because that is what moonlight is — and a disc drawn
        // in exactly that value is a grey-blue smudge rather than a moon. Two and a bit
        // takes the core toward white and leaves the cast at the rim.
        .mul(2.2),
    );

    return vec4(saturate(sky), float(1));
  }
}

export interface Sky {
  /** Faces the eye and takes the day's state. */
  update(camera: Vec3, state: DayNightState): void;
  /** The material, so a caller can reach `starBrightness`. */
  readonly material: SkyMaterial;
  dispose(): void;
}

/**
 * Builds the dome and **adds it to the scene**.
 *
 * Add it first. rmsl has no render-order key — draw order is scene traversal order —
 * so this has to happen before anything that should appear in front of the sky, which
 * means before the session that owns the terrain's meshes.
 */
export const createSky = (scene: Scene): Sky => {
  const geometry = new SphereGeometry(SKY_EXTENT, 48, 24);
  const material = new SkyMaterial();
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  return {
    material,
    update(camera, state) {
      material.sky.lighting = state;
      // Dead-centre on the eye and deliberately unsnapped; see the note at the top.
      mesh.position.set(camera.x, camera.y, camera.z);
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
    },
  };
};
