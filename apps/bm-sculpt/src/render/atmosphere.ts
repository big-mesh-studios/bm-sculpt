/**
 * The atmosphere as a spherical shell, and the column of it between two points.
 *
 * ## Why this exists next to `fog.ts`
 *
 * `Fog` was a function of *distance from the eye* with a height term bolted on, and that shape cannot
 * answer the question the planet asks. Hiding the streamed chunks' 1280-unit window needs a fog
 * thick enough to swallow everything past it, and the same thickness swallows the whole planet when
 * the player climbs — which is the bug this module exists to make impossible. The two jobs are
 * different jobs: a *near-field* fog that closes the window, and an *atmosphere* whose column depends
 * on where the ray goes and how much air it passes through.
 *
 * So this is the second one, stated once and shared. `fog.ts` uses the column to place the air over
 * a surface; the sky uses the same idea for the rim of the planet seen from orbit.
 *
 * ## The shell
 *
 * Air is the spherical shell `radius <= |p| <= radius + ATMOSPHERE_HEIGHT`, with a density that falls
 * off exponentially with height at `ATMOSPHERE_SCALE_HEIGHT`. That is the only model here: no
 * Rayleigh, no Mie, no sun angle. What it buys is that a **downward** ray from orbit passes through a
 * short, thin column and sees the ground, while a **grazing** ray at the limb passes through the same
 * density over a much longer chord and glows. Distance alone cannot tell those two apart; the shell
 * can.
 *
 * ## Why the shader takes two samples and the tests take sixty-four
 *
 * The column is `∫ exp(-h(t)/H) dt` along the eye→fragment segment, clipped to the shell. The exact
 * integral is not worth a loop in the shader, so the shader clamps the segment to the shell and takes
 * a **two-point Gauss-Legendre quadrature** of the density across it. Two points and not one is not a
 * refinement: a height profile that bends at the closest approach — which is every grazing ray — has
 * its density peak between the midpoint and the shell, and a single midpoint sample read the limb up
 * to fifty per cent low. Two samples pull the worst error over the rays that matter to a few per cent
 * for one more `exp`. `airMassShell` is that same rule, host-side, and `airMassReference` is a
 * sixty-four sample integral of the same law. A test asserts the two agree over the rays a player
 * actually looks along, which is the only way to know the cheap one is close without a GPU.
 */

import type { Node } from "@random-mesh/rmsl";
import { exp, float, max, min, select, sqrt } from "@random-mesh/rmsl";

import type { Vec3 } from "@big-mesh-studios/core";
import { DEFAULT_PLANET } from "@big-mesh-studios/csg";

/**
 * Nominal world radius of the planet, so the shell has a size before a world supplies one.
 *
 * **Read from the planet's own field rather than repeated**, because a second radius that can
 * disagree with `DEFAULT_PLANET.radius` is a sky and an ocean built against a different world than
 * the terrain. The render layer is downstream of the field, so the field is the source.
 */
export const DEFAULT_PLANET_RADIUS = DEFAULT_PLANET.radius;

/**
 * How fast the air thins with height, in world units.
 *
 * The scale height of an atmosphere. Reached from `fog.ts`, which called it `FOG_SCALE_HEIGHT`: the
 * same air the near-field fog samples and the column integrates has to thin at the same rate or the
 * two disagree at the altitude they overlap.
 */
export const ATMOSPHERE_SCALE_HEIGHT = 1200;

/**
 * How far the shell reaches above the sea, in world units.
 *
 * Four scale heights. At that height the density is `e^-4` — under two per cent — which is past the
 * point the eye can tell from vacuum, and it puts the top well above the 900-unit altitude where the
 * globe takes over, so the limb has somewhere to fade into.
 */
export const ATMOSPHERE_HEIGHT = 4 * ATMOSPHERE_SCALE_HEIGHT;

/** The shell's outer radius for the default planet. A world with another radius derives its own. */
export const ATMOSPHERE_RADIUS = DEFAULT_PLANET_RADIUS + ATMOSPHERE_HEIGHT;

/**
 * How much one unit of the column dims what is behind it.
 *
 * **Calibrated for seeing the planet, not for hiding the chunk window** — the window is the
 * near-field fog's job. Measured against the two ends a player cares about: from the 900-unit
 * altitude the globe takes over at, straight down is about 17% haze (the ground reads clearly), and
 * along the limb, where the same air is crossed over a much longer chord, is about 85% (the rim
 * glows). The number is what puts those two where they are; raising it toward the window fog's own
 * rate would swallow the planet again, which is the whole bug this module exists to end.
 */
export const ATMOSPHERE_EXTINCTION = 0.0003;

/** The span of a segment inside the sphere of `outerRadius`, as fractions of the segment. */
export interface ShellSpan {
  /** Where the segment enters the shell, in `0..1` along it. */
  readonly lo: number;
  /** Where it leaves, in `0..1`. `lo < hi` whenever this is returned. */
  readonly hi: number;
}

/**
 * Where a segment spends its time inside a sphere, or `null` for a segment that misses it.
 *
 * The half-`b` quadratic: for `p(t) = eye + t·d`, `|p|² = a·t² + 2b·t + c`, so the roots are
 * `(-b ± √(b² - ac)) / a`. Clamping the discriminant before the root keeps a miss from producing a
 * `NaN` that would survive the `null` check and poison arithmetic upstream — the same reason the
 * shader clamps before its `sqrt`.
 */
export const shellSpan = (
  eye: Vec3,
  point: Vec3,
  outerRadius: number,
): ShellSpan | null => {
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const a = dx * dx + dy * dy + dz * dz;
  if (a <= 0) return null;
  const b = eye.x * dx + eye.y * dy + eye.z * dz;
  const c = eye.x * eye.x + eye.y * eye.y + eye.z * eye.z - outerRadius ** 2;
  const disc = b * b - a * c;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  const lo = Math.max(0, (-b - root) / a);
  const hi = Math.min(1, (-b + root) / a);
  if (hi <= lo) return null;
  return { lo, hi };
};

/** The height of a point above the sea, clamped to zero inside the planet. */
const heightOf = (p: Vec3, radius: number): number =>
  Math.max(Math.hypot(p.x, p.y, p.z) - radius, 0);

/** Gauss-Legendre's two nodes on `[-1, 1]`, `±1/√3`, shared by the host and the shader. */
export const GAUSS_NODE = 1 / Math.sqrt(3);

/** A point `t` of the way along a segment. */
const lerpAt = (eye: Vec3, point: Vec3, t: number): Vec3 => ({
  x: eye.x + (point.x - eye.x) * t,
  y: eye.y + (point.y - eye.y) * t,
  z: eye.z + (point.z - eye.z) * t,
});

/**
 * The column of air between two points, as the shader computes it: **two-point Gauss-Legendre
 * quadrature of the density across the shell-clipped segment**, times its world length.
 *
 * A height profile that bends at the closest approach — every grazing ray — peaks in density between
 * the midpoint and the shell, which is why one midpoint sample read the limb badly low; two nodes
 * straddle that peak and bring the error on the rays a player looks along to a few per cent.
 */
export const airMassShell = (
  eye: Vec3,
  point: Vec3,
  radius: number,
  atmosphereHeight: number = ATMOSPHERE_HEIGHT,
  scaleHeight: number = ATMOSPHERE_SCALE_HEIGHT,
): number => {
  const span = shellSpan(eye, point, radius + atmosphereHeight);
  if (span === null) return 0;
  const mid = (span.lo + span.hi) * 0.5;
  const half = (span.hi - span.lo) * 0.5;
  const near = lerpAt(eye, point, mid - half * GAUSS_NODE);
  const far = lerpAt(eye, point, mid + half * GAUSS_NODE);
  const density =
    0.5 *
    (Math.exp(-heightOf(near, radius) / scaleHeight) +
      Math.exp(-heightOf(far, radius) / scaleHeight));
  const segment = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
  return (span.hi - span.lo) * segment * density;
};

/**
 * The same column, integrated. The oracle `airMassShell` is measured against.
 *
 * Two hundred and fifty-six midpoint samples, which is the most this is worth: the midpoint rule's
 * error falls as `1/n²`, so the default is under a thousandth of a unit on the longest column this
 * world draws — close enough to stand in for the exact integral without being another approximation.
 */
export const airMassReference = (
  eye: Vec3,
  point: Vec3,
  radius: number,
  atmosphereHeight: number = ATMOSPHERE_HEIGHT,
  scaleHeight: number = ATMOSPHERE_SCALE_HEIGHT,
  samples = 256,
): number => {
  const span = shellSpan(eye, point, radius + atmosphereHeight);
  if (span === null) return 0;
  const segment = Math.hypot(point.x - eye.x, point.y - eye.y, point.z - eye.z);
  const step = (span.hi - span.lo) / samples;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const t = span.lo + (i + 0.5) * step;
    const at: Vec3 = {
      x: eye.x + (point.x - eye.x) * t,
      y: eye.y + (point.y - eye.y) * t,
      z: eye.z + (point.z - eye.z) * t,
    };
    total += Math.exp(-heightOf(at, radius) / scaleHeight);
  }
  return total * step * segment;
};

/**
 * `airMassShell`, as nodes.
 *
 * The same arithmetic, term for term, so the host version is a real mirror rather than a description.
 * The discriminant is clamped before the root for the same `NaN` reason `shellSpan` gives, and the
 * `select` at the end is what turns a segment that misses the shell into zero rather than into
 * whatever the clamped root happened to produce.
 *
 * **Every intermediate is bound with `toVar`, and that is not tidiness.** rmsl builds an expression
 * graph and emits each node once per use; the shell quadratic feeds the near and far samples, which
 * feed the density, which the `select` names twice — written plainly, the emitted source repeated the
 * whole `a`/`b`/`c`/`sqrt` block about twenty times and the fragment ran to thousands of characters.
 * A variable is the only thing in this DSL that is computed once.
 */
export const airMassNode = (
  eye: Node<"vec3">,
  point: Node<"vec3">,
  radius: Node<"float">,
  atmosphereHeight: Node<"float">,
  scaleHeight: Node<"float">,
): Node<"float"> => {
  const d = point.sub(eye).toVar();
  const a = max(d.dot(d), float(1e-6)).toVar();
  const b = eye.dot(d).toVar();
  const outer = radius.add(atmosphereHeight);
  const c = eye.dot(eye).sub(outer.mul(outer)).toVar();
  const disc = max(b.mul(b).sub(a.mul(c)), float(0)).toVar();
  const root = sqrt(disc).toVar();
  const lo = max(b.negate().sub(root).div(a), float(0)).toVar();
  const hi = min(b.negate().add(root).div(a), float(1)).toVar();
  const span = hi.sub(lo).toVar();
  const mid = lo.add(hi).mul(0.5).toVar();
  const half = span.mul(0.5).toVar();
  const near = eye.add(d.mul(mid.sub(half.mul(float(GAUSS_NODE))))).toVar();
  const far = eye.add(d.mul(mid.add(half.mul(float(GAUSS_NODE))))).toVar();
  const density = exp(
    near.length().sub(radius).max(float(0)).div(scaleHeight).negate(),
  )
    .add(exp(far.length().sub(radius).max(float(0)).div(scaleHeight).negate()))
    .mul(0.5)
    .toVar();
  return select(
    span.greaterThan(float(0)),
    span.mul(d.length()).mul(density),
    float(0),
  );
};
