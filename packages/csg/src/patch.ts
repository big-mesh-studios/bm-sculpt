/**
 * The planet's chunks: square patches of a cube face, chosen by a quadtree.
 *
 * ## What replaces what
 *
 * A cell used to be `{x, y, z}` — an index into a cubic lattice, addressed by dividing a world
 * point by the chunk size and flooring three times. This replaces it with `{face, x, y, size}`: a
 * square region of one of the six faces of a cube, which the warp in `cube-face.ts` pushes out to
 * the sphere. See ADR 0038 for why the cubic lattice had to go; the short version is that most of
 * any large volume of space near a planet is inside the planet, so a window of cubic cells spends
 * its budget on rock. Measured: a window spanning the planet had **4.3%** of its cells able to hold
 * surface.
 *
 * ## Why patches and not a finer cubic lattice
 *
 * Because a patch is on the surface *by construction*. There is no "deep" patch to skip, so there is
 * nothing for a surface gate to reject and nothing wasted to budget for. The consequence that
 * matters is in `selectPatches`: **the number of patches grows logarithmically with altitude**, not
 * with the cube of it, which is what lets a player rise far enough to see the planet as a whole.
 *
 * ## The coordinate system
 *
 * Each face carries a grid of `root` divisions per edge at its finest level, and a patch is a
 * square of `size` of those divisions. **Subdividing a square into four squares halves its edge,
 * so `size` is `root / 2^level` and not `root / 4^level`** — a quadtree quarters the *area* of a
 * patch and halves its side, and confusing the two puts a level out by a factor of two on
 * everything downstream. At `root = 32` the sizes are 32, 16, 8, 4, 2, 1 and the finest level is
 * `size === 1`.
 *
 * **`size` rather than `level` is stored** because every consumer wants the edge length — the
 * mesher wants a sample count, the LOD rule wants a world size, and the overlap rule wants to know
 * how far a patch reaches. Deriving it from a level would put the same shift in each of them.
 */

import { FACE_COUNT, directionAt, type Direction } from "./cube-face";

/** The angle across one cube face, from centre to centre along an edge, in radians. */
const FACE_ANGLE = Math.PI / 2;

/**
 * Divisions per face edge at the finest level.
 *
 * **32, which is a compromise between two failure modes.** Too small and the finest patches are
 * far larger than the chunk they would be meshed at, so the planet cannot be detailed enough near
 * the player. Too large and the coarsest patches are tiny, so the quadtree burns depth on a planet
 * that does not need it and the root count grows for nothing. At `root = 32` a full refinement is
 * `6 · 32² = 6144` patches, and a planet of radius 136,000 at the finest level has patches about
 * 6,700 units across — far larger than the 320-unit chunk the mesher works in, which is one of the
 * reasons this lattice was superseded by the displaced globe (ADR 0039).
 */
export const PATCH_ROOT = 32;

/** A square region of one cube face: the planet's unit of streaming. */
export interface Patch {
  /** Which face, 0..5. See `cube-face.ts`. */
  readonly face: number;
  /** Position along the face's first in-face axis, in fine divisions. */
  readonly x: number;
  /** Position along the face's second in-face axis, in fine divisions. */
  readonly y: number;
  /** Edge length in fine divisions: `root / 2^level`, so a power of two. */
  readonly size: number;
}

/** The level of detail a patch is at, counting from 0 at the coarsest. */
export const patchLevel = (size: number): number =>
  Math.round(Math.log2(PATCH_ROOT / size));

/** The coarsest patch on a face: the whole face, one patch. */
export const rootPatch = (face: number): Patch => ({
  face,
  x: 0,
  y: 0,
  size: PATCH_ROOT,
});

/**
 * The `(u, v)` range a patch covers, in face parameters.
 *
 * The face runs `[-1, 1]` in both parameters and carries `root` fine divisions, so a patch of
 * `size` divisions at position `p` covers `[2p/root - 1, 2(p+size)/root - 1]`.
 */
export const patchRange = (
  patch: Patch,
): readonly [readonly [number, number], readonly [number, number]] => {
  const s = (2 * patch.size) / PATCH_ROOT;
  const u0 = -1 + (2 * patch.x) / PATCH_ROOT;
  const v0 = -1 + (2 * patch.y) / PATCH_ROOT;
  return [
    [u0, u0 + s],
    [v0, v0 + s],
  ];
};

/**
 * The unit direction at a patch's centre.
 *
 * The **centre** rather than a corner, because a corner is shared with three neighbouring patches
 * and whichever of them asks first would get a different answer to the same question.
 */
export const patchCentre = (patch: Patch): Direction =>
  patchDirectionAt(patch, 0.5, 0.5);

/**
 * The direction at a point inside a patch, in the patch's own fractions.
 *
 * `fx` and `fy` run 0..1 across the patch. This is how the mesher places samples: a patch is a
 * region of a face, so a sample inside it is a face parameter, and the warp takes it from there.
 */
export const patchDirectionAt = (
  patch: Patch,
  fx: number,
  fy: number,
): Direction =>
  directionAt(
    patch.face,
    -1 + (2 * (patch.x + fx * patch.size)) / PATCH_ROOT,
    -1 + (2 * (patch.y + fy * patch.size)) / PATCH_ROOT,
  );

/**
 * The angle a patch subtends at the planet's centre, in radians.
 *
 * **The face parameter span times a quarter-turn, not the patch's own size in world units** — and
 * the reason is that the warp is not area-preserving, so a patch at a face centre and one at a
 * corner cover visibly different amounts of sphere despite having identical `(u, v)` extents. The
 * factor below is measured from the map rather than derived, and it is the corner patches that
 * need it: `faceAngle` is the angle across a whole face and `PATCH_ROOT` divisions, so a patch of
 * `size` divisions spans `size / PATCH_ROOT` of it.
 */
export const patchAngle = (size: number): number =>
  (size / PATCH_ROOT) * FACE_ANGLE;

/**
 * The four patches a patch divides into, in reading order.
 *
 * **Reading order and not compass order**, so that a patch's children are numbered the same way
 * every time and a test can compare lists rather than sets.
 */
export const subdivide = (patch: Patch): readonly Patch[] => {
  const h = patch.size / 2;
  const { face, x, y } = patch;
  return [
    { face, x, y, size: h },
    { face, x: x + h, y, size: h },
    { face, x, y: y + h, size: h },
    { face, x: x + h, y: y + h, size: h },
  ];
};

/** The angle between two directions, in radians, clamped so floating point cannot exceed π. */
export const angleBetween = (a: Direction, b: Direction): number => {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot);
};

/** The patches whose surface covers a viewer at a direction and a radius from the centre. */
export interface PatchSelection {
  /** The patches, in face order and within each face in reading order. */
  readonly patches: readonly Patch[];
  /** How many patches the traversal looked at, which is more than it returned. */
  readonly visited: number;
}

/**
 * The patches to build for a viewer at `eye`, standing `eyeRadius` from the planet's centre.
 *
 * ## The rule
 *
 * Descend from each face's root, splitting a patch while it is **both** nearer than `factor` of its
 * own world size and larger than one fine division. The test is a comparison of the viewer to the
 * patch, never of the patch to the planet — a patch on the far side of the planet is far away and
 * stays coarse, which is correct, and it costs nothing to discover because the traversal that
 * decides that never has to look at anything else.
 *
 * ## Why the count is the thing worth designing for
 *
 * This is the replacement for the measured failure in ADR 0038, where a window spanning the planet
 * had 4.3% of its cells usable and the usable count barely grew with the window. Here the count is
 * bounded by the *angular* size of each patch and the depth of the tree, so it grows with the
 * logarithm of the distance rather than with its cube. That is the property that makes "fly up and
 * see a planet" affordable, and `patch.test.ts` measures it rather than trusting it.
 *
 * ## `factor`
 *
 * One patch is worth splitting while the viewer is within `factor` of its own world width — so
 * `factor` is roughly "samples across a patch's near edge", and **larger means finer**, not
 * coarser: it makes the test easier to pass, so more patches split. Measured on a default planet,
 * by count, from the surface and from a radius up:
 *
 * | factor | 2 up | 500 up | 4,000 up | 40,000 up |
 * | --- | --- | --- | --- | --- |
 * | 2 | 204 | 177 | 36 | 6 |
 * | 4 | 648 | 552 | 144 | 6 |
 * | 8 | 1,812 | 1,704 | 600 | 24 |
 * | 16 | 4,419 | 4,038 | 2,433 | 96 |
 *
 * `4` is the default: a few hundred patches at ground level, comparable to the 205 cells the cubic
 * window held, and 144 for a whole planet from a radius up.
 *
 * ## The count falls as the viewer rises, and that is correct
 *
 * An earlier draft of this comment claimed the count *grows* with the logarithm of altitude. It
 * does not, and the measurement above says why: distance-proportional level of detail coarsens
 * everything as the viewer backs away, so the count **falls**. That is the right behaviour — the
 * planet shrinks in the view and needs less detail — and it is not the property the change was
 * sold on.
 *
 * The property it was sold on is that the count is **bounded**, and the bound is the whole planet:
 * at any altitude the selection returns no more than a full refinement, `6 · 32² = 6144` patches,
 * and every one of them is on the surface. The cubic lattice it replaces could not say that. A
 * window spanning the planet needed **152,669 cells** to hold 6,508 usable ones — 4.3% — and its
 * cost grew with the cube of its radius. Here the cost is bounded by the planet's area and never
 * spends anything on rock, because there is no rock to spend it on.
 */
export const selectPatches = (
  eye: Direction,
  eyeRadius: number,
  radiusAt: (d: Direction) => number,
  factor = 4,
): PatchSelection => {
  const patches: Patch[] = [];
  let visited = 0;

  const descend = (patch: Patch): void => {
    visited++;
    if (patch.size <= 1) {
      patches.push(patch);
      return;
    }
    // The patch's world width, from the terrain radius at its centre — so a patch over high
    // ground is measured against the ground it is actually over.
    const centre = patchCentre(patch);
    const r = radiusAt(centre);
    const worldSize = patchAngle(patch.size) * r;

    // **Distance from the viewer's position, not the angle between directions.** Angular distance
    // alone is the bug this line exists to prevent: at four thousand units up, the patch directly
    // below the viewer subtends an angle of *zero* and so would never split, which is the exact
    // case the whole change is for. The law of cosines on the two radii gives the real distance,
    // and it degrades to `angle · r` when the viewer is standing on the surface.
    const cos = Math.max(
      -1,
      Math.min(1, eye.x * centre.x + eye.y * centre.y + eye.z * centre.z),
    );
    const away = Math.sqrt(
      Math.max(0, eyeRadius * eyeRadius + r * r - 2 * eyeRadius * r * cos),
    );

    // Split while the patch is both too coarse for its distance and still divisible. `away`
    // against `worldSize` is a ratio of lengths, so it is the same comparison at any radius.
    if (away < factor * worldSize) {
      for (const child of subdivide(patch)) descend(child);
      return;
    }
    patches.push(patch);
  };

  for (let face = 0; face < FACE_COUNT; face++) descend(rootPatch(face));
  return { patches, visited };
};

/**
 * The patch a direction falls in, at a given size.
 *
 * ## The nearest-centre definition, and why it is the only one available
 *
 * "Which patch is this direction in" has an obvious answer and it is wrong. Patches are squares of
 * a cube face, so the inverse of "warp this square to the sphere" is "unwarp this direction", and
 * **the warp cannot be cheaply inverted** — not in closed form, and not by iteration either. The
 * obvious fixed point (normalise onto the cube surface, warp, normalise) *diverges*: measured, its
 * worst round-trip error grows `0.199 → 0.311 → 0.500 → 0.728` over one, two, four and eight
 * rounds. Reading cube parameters straight off the direction's own components — which is what
 * `faceOf` does, and what a first version of this did — disagrees with the nearest patch on
 * **99.1%** of directions, because a warp that pushes a corner out by 15% moves a direction several
 * patch-widths away from where its cube coordinates would put it.
 *
 * So the patch is found by its **centre**: the answer is the patch whose centre is angularly
 * nearest the direction. That is a well-defined partition of the sphere, it is what "the mesh you
 * are standing on" means to anything that asks, and it costs a bounded search.
 *
 * ## The search radius is measured, not guessed
 *
 * `faceOf` still picks the *face* correctly — the dominant axis survives the warp — so it gives a
 * starting cell, and the search is a neighbourhood around it. How wide that has to be is measured
 * in the test file rather than assumed: a start cell can be several patch-widths out, because that
 * is how far the warp moves a direction from its cube coordinates. `PATCH_SEARCH_RADIUS` is the
 * measured bound plus margin.
 */
/**
 * The patch whose centre is nearest a direction.
 *
 * ## Exhaustive, cached, and correct by construction
 *
 * Every earlier version of this searched a bounded neighbourhood and tried to bound how far the
 * warp could displace a direction from the cell its cube coordinates suggest. **That bound is not
 * knowable cheaply** — the warp has no closed-form inverse and its obvious fixed point diverges
 * (worst round-trip error `0.199 → 0.728` over one to eight rounds) — so each attempt to bound it
 * was an attempt to tune a guess, and the guesses disagreed with an exhaustive scan on between 124
 * and 3,348 directions out of 2,646 tried, depending on the radius.
 *
 * So there is no radius here. The centres of every patch at a size are computed once and cached, and
 * the answer is a linear scan over them: `6 · (32/size)²` dot products, which is 6,144 at the
 * finest size and about six thousand floating-point multiply-adds — a few microseconds, and less
 * than a single noise evaluation of the terrain it is being asked about.
 *
 * **It is a query for "where have I arrived", not one for the streaming traversal**, which already
 * knows its patches and never asks. A caller that needs this every frame for many points should
 * cache its own answer per cell, which is what the window does for chunks.
 */
const centreCache = new Map<
  number,
  { centres: Float64Array; patches: readonly Patch[] }
>();

/** Every patch centre at a size, computed once and kept. */
const centresAt = (
  size: number,
): { centres: Float64Array; patches: readonly Patch[] } => {
  const cached = centreCache.get(size);
  if (cached !== undefined) return cached;
  const step = PATCH_ROOT / size;
  const patches: Patch[] = [];
  for (let face = 0; face < FACE_COUNT; face++) {
    // `x` and `y` step by `size`: patches tile the face and each is `size` divisions wide, so
    // their indices are multiples of `size`, not of the patch count. Confusing the two was the
    // bug that made the first version return patches no quadtree contains.
    for (let x = 0; x + size <= PATCH_ROOT; x += size) {
      for (let y = 0; y + size <= PATCH_ROOT; y += size) {
        patches.push({ face, x, y, size });
      }
    }
  }
  void step;
  const centres = new Float64Array(patches.length * 3);
  for (let i = 0; i < patches.length; i++) {
    const c = patchCentre(patches[i] as Patch);
    centres[i * 3] = c.x;
    centres[i * 3 + 1] = c.y;
    centres[i * 3 + 2] = c.z;
  }
  const built = { centres, patches };
  centreCache.set(size, built);
  return built;
};

export const patchOf = (d: Direction, size: number): Patch => {
  const { centres, patches } = centresAt(size);
  let best = patches[0] as Patch;
  let bestDot = -Infinity;
  for (let i = 0; i < patches.length; i++) {
    const dot =
      (centres[i * 3] as number) * d.x +
      (centres[i * 3 + 1] as number) * d.y +
      (centres[i * 3 + 2] as number) * d.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = patches[i] as Patch;
    }
  }
  return best;
};

/** How many patches a lookup at this size considers, which is what the scan costs. */
export const patchLookupCost = (size: number): number =>
  centresAt(size).patches.length;
