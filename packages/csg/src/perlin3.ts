/**
 * Seeded 3D gradient noise, for `planet.ts`.
 *
 * `PerlinNoise2D` in `packages/csg/src/terrain.ts` is not usable as the noise domain of a
 * planet, and the reason is a topological obstruction rather than a shortcoming of the
 * construction. The noise needs a *continuous* two-argument domain covering the whole
 * sphere, because the field is `|p - c| - (R + scale·g(n))` and `g` must be continuous or
 * the field steps and the mesher opens a crack along the step.
 *
 * ## Why three dimensions and not two
 *
 * No continuous two-argument chart of a sphere exists — one cannot be drawn without a
 * singularity — so every 2D option is discontinuous, repetitive, or both. `perlin3.test.ts`
 * measures all of them, and the numbers are worth having here because the conclusion drove
 * this file's existence:
 *
 * | Domain | Continuous in world position? | Distinct landscapes at the six axis directions? |
 * |---|---|---|
 * | six cube-face charts | **no**, at 12 of the 12 edges | 1 of 6 |
 * | dominant axis dropped, other two kept | **no** | 1 of 6 |
 * | a single projection, `(n.x, n.z)` | yes | 1 of 6 |
 * | **this file** | yes, everywhere | 6 of 6 |
 *
 * The decisive number is the last column rather than the second. A 2D chart is blind to the
 * direction normal to itself, so all three 2D domains hand the *same* landscape to all six axis
 * directions — a planet carrying one continent three times at right angles to itself. Three
 * dimensions needs no chart, so it has no blind direction.
 *
 * ## The construction
 *
 * `PerlinNoise2D`'s, exactly: the same LCG shuffle, the same quintic fade, the same `& 255`
 * lattice mask, the same amplitude-halved frequency-doubled fBm. The gradients are the twelve
 * unit edge directions rather than four diagonals, which is the standard 3D set and the reason
 * a corner gradient differs from another by at most 2 per axis.
 */

/**
 * A bound on `|d noise / d u|` for one axis, derived as `terrain.ts` derives its own.
 *
 * A corner gradient is one of twelve vectors with a single component of `±1`, so two
 * independent corners differ by at most 2 in each of three axes and by at most `2√3` in
 * magnitude. The quintic's derivative peaks at `30/16 = 1.875`. Multiplying gives
 * `2√3 · 1.875 = 6.495`, and the interpolated derivative is a convex combination of the
 * corner derivatives along each axis, so it cannot exceed it.
 *
 * Slightly *tighter* than the 2D figure of 7.5 despite the extra axis, because the 3D
 * gradient set is shorter than the 2D diagonal set (`2·2·1.875 = 7.5` against
 * `2·√3·1.875`). The three axes are then combined by `√3` rather than `√2`, so the two
 * changes very nearly cancel — which is the reason this file's header predicts the
 * Lipschitz bound will land close to the height field's rather than far from it.
 */
export const NOISE_GRADIENT_BOUND_3D = 2 * Math.sqrt(3) * 1.875;

/**
 * A bound on the amplitude of the normalised 3D fBm.
 *
 * The twelve unit gradients project onto at most one full component, so a corner value is
 * bounded by 1 in magnitude and the normalised average of octaves is bounded by 1 too. The
 * 2D figure is 2 because a 2D diagonal gradient reaches 2 along the diagonal it lies on.
 */
export const FBM_AMPLITUDE_BOUND_3D = 1;

/** The twelve gradient directions, as the classic construction indexes them. */
const GRADIENTS_3D: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
];

export class PerlinNoise3D {
  /** Doubled, so an index of `255 + 255` is in range without a modulo. */
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) table[i] = i;

    let n = seed | 0;
    for (let i = 255; i > 0; i--) {
      n = (Math.imul(n, 1103515245) + 12345) & 0x7fffffff;
      const j = n % (i + 1);
      const swap = table[i];
      table[i] = table[j];
      table[j] = swap;
    }

    for (let i = 0; i < 512; i++) this.perm[i] = table[i & 255];
  }

  /** The quintic smootherstep: zero first *and* second derivative at each lattice point. */
  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private static lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
  }

  /** The dot of one corner's offset into its cell with that corner's gradient. */
  private grad(hash: number, x: number, y: number, z: number): number {
    const g = GRADIENTS_3D[hash % 12] as readonly [number, number, number];
    return g[0] * x + g[1] * y + g[2] * z;
  }

  /** Noise at a point, in roughly [-1, 1]. */
  noise(x: number, y: number, z: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = PerlinNoise3D.fade(xf);
    const v = PerlinNoise3D.fade(yf);
    const w = PerlinNoise3D.fade(zf);

    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;
    const A = this.perm[X] + Y;
    const AA = this.perm[A] + Z;
    const AB = this.perm[A + 1] + Z;
    const B = this.perm[X + 1] + Y;
    const BA = this.perm[B] + Z;
    const BB = this.perm[B + 1] + Z;

    return PerlinNoise3D.lerp(
      PerlinNoise3D.lerp(
        PerlinNoise3D.lerp(
          this.grad(this.perm[AA], xf, yf, zf),
          this.grad(this.perm[BA], xf - 1, yf, zf),
          u,
        ),
        PerlinNoise3D.lerp(
          this.grad(this.perm[AB], xf, yf - 1, zf),
          this.grad(this.perm[BB], xf - 1, yf - 1, zf),
          u,
        ),
        v,
      ),
      PerlinNoise3D.lerp(
        PerlinNoise3D.lerp(
          this.grad(this.perm[AA + 1], xf, yf, zf - 1),
          this.grad(this.perm[BA + 1], xf - 1, yf, zf - 1),
          u,
        ),
        PerlinNoise3D.lerp(
          this.grad(this.perm[AB + 1], xf, yf - 1, zf - 1),
          this.grad(this.perm[BB + 1], xf - 1, yf - 1, zf - 1),
          u,
        ),
        v,
      ),
      w,
    );
  }

  /**
   * Summed octaves, amplitude halved and frequency doubled, normalised to the sum.
   *
   * Identical in construction to `PerlinNoise2D.fbm`, so the octave-count-independent
   * range that makes `FBM_AMPLITUDE_BOUND_3D` a constant holds here too.
   */
  fbm(x: number, y: number, z: number, octaves: number): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let total = 0;

    for (let i = 0; i < octaves; i++) {
      value +=
        amplitude * this.noise(x * frequency, y * frequency, z * frequency);
      total += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }

    return total === 0 ? 0 : value / total;
  }
}
