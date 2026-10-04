/**
 * The patch quadtree, measured against the failure it replaces.
 *
 * ## What this file is for
 *
 * ADR 0038 rejected the cubic lattice on a measurement: a window of cubic cells spanning the planet
 * had **4.3%** of its cells able to hold surface, and the usable count barely grew as the window
 * grew — 84 cells at radius 5, 6,508 at radius 45, for 745 times the cost. The claim replacing it
 * is that a quadtree of surface patches has a count that grows with the *logarithm* of distance.
 *
 * That claim is the whole justification for the change, so it is measured here rather than
 * asserted. The other tests hold the parts that have to be true for the number to mean anything: if
 * patches overlapped or left gaps, a cheap count would only mean a wrong planet.
 */

import { describe, expect, it } from "vitest";

import { faceOf, directionAt } from "./cube-face";
import { DEFAULT_PLANET, planetField } from "./planet";
import {
  PATCH_ROOT,
  angleBetween,
  patchAngle,
  patchCentre,
  patchDirectionAt,
  patchLevel,
  patchOf,
  rootPatch,
  selectPatches,
  subdivide,
  type Patch,
} from "./patch";

const planet = planetField(DEFAULT_PLANET);

/** A viewer at `altitude` above the surface, looking at the planet. */
const eyeAt = (
  altitude: number,
  direction = patchCentre(rootPatch(2)),
): number => planet.radiusAt(direction) + altitude;

/**
 * Whether a patch's square contains a direction.
 *
 * **Containment in the patch's own `(u, v)` range, not proximity to its centre.** A patch at the
 * finest level has its centre half a patch-width from its own edge, so a viewer standing on the
 * edge of a patch is nowhere near its centre and still on it. Two tests need this and both first
 * failed by asking the proximity question instead.
 */
const containsDirection = (
  patch: Patch,
  d: ReturnType<typeof patchCentre>,
): boolean => {
  // The warp is not its own inverse, so `faceOf` gives the *cube* parameters, which are the ones
  // a patch is addressed in. Exact to within the dominant-axis rule.
  const { face, u, v } = faceOf(d);
  if (face !== patch.face) return false;
  const toIndex = (t: number): number => ((t + 1) / 2) * PATCH_ROOT;
  const pu = toIndex(u);
  const pv = toIndex(v);
  return (
    pu >= patch.x &&
    pu < patch.x + patch.size &&
    pv >= patch.y &&
    pv < patch.y + patch.size
  );
};

describe("a patch", () => {
  it("covers the face it is on and nothing else", () => {
    const root = rootPatch(0);
    const [u, v] = [[-1, 1] as const, [-1, 1] as const];
    expect(u[0]).toBe(-1);
    expect(u[1]).toBe(1);
    expect(v).toEqual([-1, 1]);
    // The centre of the whole +X face is +X, which is what the convention says it is.
    // **Component-wise and not `toEqual`**, because the map multiplies by a warp factor and
    // produces `-0` where the arithmetic says `+0` — which `toEqual` treats as a difference, for
    // no reason a reader of this file would guess.
    const centre = patchCentre(root);
    expect(centre.x).toBeCloseTo(1, 12);
    expect(centre.y).toBeCloseTo(0, 12);
    expect(centre.z).toBeCloseTo(0, 12);
  });

  it("has a centre that is the middle of its own range", () => {
    // The property a quadtree descent depends on: a patch's centre must be inside the patch, or
    // the distance the LOD rule computes is the distance to somewhere else.
    const patch: Patch = { face: 3, x: 8, y: 16, size: 8 };
    const centre = patchCentre(patch);
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.9],
      [0.9, 0.1],
    ] as const) {
      const other = patchDirectionAt(patch, fx, fy);
      // A quarter of a patch's own angle is the most a corner can be from its centre.
      expect(angleBetween(centre, other), `${fx},${fy}`).toBeLessThan(
        patchAngle(patch.size),
      );
    }
  });

  it("divides into four patches that exactly tile it", () => {
    // **Exact tiling, not approximately.** If the children overlapped or left a gap, two patches
    // would be built for some ground or none, and the whole saving would be a wrong planet.
    for (const size of [32, 8, 4]) {
      const parent: Patch = { face: 4, x: 0, y: 0, size };
      const children = subdivide(parent);
      expect(children).toHaveLength(4);
      // Each child is a quarter of the parent's area, so the four together are the parent.
      const childArea = children.reduce(
        (sum, c) => sum + (c.size / PATCH_ROOT) * (c.size / PATCH_ROOT),
        0,
      );
      expect(childArea).toBeCloseTo((size / PATCH_ROOT) ** 2, 12);
      // And no two children overlap. **Two rectangles are disjoint when they are disjoint on
      // *either* axis**, so this is `||` and not `&&` — the `&&` version fails on siblings that
      // share a row, which is most of them, and it fails for a reason that looks like the
      // subdivision is wrong rather than like the test is.
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const a = children[i]!;
          const b = children[j]!;
          const disjoint =
            a.x + a.size <= b.x ||
            b.x + b.size <= a.x ||
            a.y + a.size <= b.y ||
            b.y + b.size <= a.y;
          expect(disjoint, `${a.x},${a.y} vs ${b.x},${b.y}`).toBe(true);
        }
      }
    }
  });

  it("names a level that is a quarter of its parent's", () => {
    expect(patchLevel(32)).toBe(0);
    expect(patchLevel(8)).toBe(2);
    expect(patchLevel(1)).toBe(5);
    expect(patchLevel(subdivide(rootPatch(3))[0]!.size)).toBe(1);
  });
});

describe("the selection", () => {
  it("returns patches that do not overlap and leave no gaps", () => {
    // **The invariant that makes a cheap count mean something.** Every returned patch is a
    // disjoint square of one of six faces, so the count is a count of distinct places on the
    // surface. Measured on the index grid, which is exact: two patches on the same face overlap
    // iff their index rectangles do.
    const { patches } = selectPatches(
      patchCentre(rootPatch(2)),
      eyeAt(2),
      (d) => planet.radiusAt(d),
    );
    expect(patches.length).toBeGreaterThan(0);

    const byFace = new Map<number, Patch[]>();
    for (const patch of patches) {
      const list = byFace.get(patch.face) ?? [];
      list.push(patch);
      byFace.set(patch.face, list);
    }
    // **Overlaps are collected and reported, not formatted per comparison.** The loop below runs
    // once per pair of patches — about 210,000 of them — and building a message string for each
    // one cost two seconds of a test that is otherwise integer arithmetic. Only the overlaps
    // themselves are ever described.
    const overlaps: string[] = [];
    for (const [face, list] of byFace) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i]!;
          const b = list[j]!;
          const disjoint =
            a.x + a.size <= b.x ||
            b.x + b.size <= a.x ||
            a.y + a.size <= b.y ||
            b.y + b.size <= a.y;
          if (!disjoint) {
            overlaps.push(
              `face ${face}: ${a.x},${a.y},${a.size} overlaps ${b.x},${b.y},${b.size}`,
            );
          }
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("gives the ground underfoot the finest patches", () => {
    // **The selection has to mean something.** If the patch under the viewer were no finer than
    // one at the horizon, the LOD rule would be inverted and the planet would be detailed
    // everywhere except where anyone stands.
    const look = patchCentre(rootPatch(2));
    const { patches } = selectPatches(look, eyeAt(2), (d) =>
      planet.radiusAt(d),
    );
    const smallest = Math.min(...patches.map((p) => p.size));
    // **"Underfoot" is containment, not proximity to a centre.** A patch at the finest level whose
    // centre is half a patch away still has the viewer standing on it, and testing the distance to
    // its centre instead finds nothing — which is how this assertion first failed, by being a
    // subtly different question.
    const underfoot = patches.filter((p) => containsDirection(p, look));
    expect(underfoot.length).toBeGreaterThan(0);
    for (const p of underfoot) expect(p.size).toBe(smallest);
  });

  it("makes patches coarser with distance from the viewer", () => {
    const look = patchCentre(rootPatch(2));
    const { patches } = selectPatches(look, eyeAt(2), (d) =>
      planet.radiusAt(d),
    );
    // Bucket by angular distance and check the mean patch size rises with the bucket.
    const buckets = new Map<number, number[]>();
    for (const p of patches) {
      const angle = angleBetween(patchCentre(p), look);
      const b = Math.min(9, Math.floor((angle / Math.PI) * 10));
      buckets.set(b, [...(buckets.get(b) ?? []), p.size]);
    }
    const means = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, sizes]) => sizes.reduce((s, v) => s + v, 0) / sizes.length);
    for (let i = 1; i < means.length; i++) {
      expect(means[i]!, `bucket ${i}`).toBeGreaterThanOrEqual(
        means[i - 1]! * 0.9,
      );
    }
  });

  it("stays bounded, and costs nothing on rock", () => {
    // **The claim ADR 0038 makes, measured.**
    //
    // An earlier version of this test asserted the count *grows* with the logarithm of altitude.
    // It does not — distance-proportional detail coarsens as the viewer backs away, so the count
    // falls, and that is correct. The property the change was actually sold on is different and
    // stronger: **the count is bounded by the planet, at any altitude.**
    //
    // The cubic lattice it replaces had no such bound. A window spanning the planet needed 152,669
    // cells to hold 6,508 usable ones, and its cost grew with the cube of its radius.
    const look = patchCentre(rootPatch(2));
    // Altitudes as fractions of the planet's own radius, so "ten radii up" means the same thing
    // after the radius grew from 4,000 to 136,000.
    const R = planet.radiusAt(look);
    const rows: string[] = [];
    let peak = 0;
    for (const altitude of [2, 50, 500, R, 3 * R, 10 * R]) {
      const { patches } = selectPatches(look, eyeAt(altitude), (d) =>
        planet.radiusAt(d),
      );
      peak = Math.max(peak, patches.length);
      rows.push(
        `  ${String(altitude).padStart(7)} units up   ${String(patches.length).padStart(6)} patches`,
      );
    }
    console.log(`\n${rows.join("\n")}\n`);

    // Never more than a full refinement, whatever the altitude.
    expect(peak).toBeLessThanOrEqual(6 * PATCH_ROOT * PATCH_ROOT);
    // And it is a workable budget throughout: a few hundred patches, not tens of thousands. The
    // cubic window needed five figures for the same view.
    expect(peak).toBeLessThan(1_000);
    // And the far end is cheap, because the planet is a small disc from ten radii up.
    const far = selectPatches(look, eyeAt(10 * R), (d) => planet.radiusAt(d))
      .patches.length;
    expect(far).toBeLessThan(peak / 4);
  });

  it("coarsens as the viewer rises, which is what distance-proportional detail means", () => {
    // **The corrected expectation, and it is worth stating because the first version of this test
    // asserted the opposite.** Rising does not refine the planet; it makes the planet smaller in
    // the view, and a detail rule that ignores that would spend the whole budget on a disc a few
    // hundred pixels across. What must *not* coarsen is the ground under the viewer — and that is
    // the next test, because the two together are the property.
    const look = patchCentre(rootPatch(2));
    const near = selectPatches(look, eyeAt(2), (d) => planet.radiusAt(d))
      .patches.length;
    const high = selectPatches(look, eyeAt(40_000), (d) => planet.radiusAt(d))
      .patches.length;
    expect(high).toBeLessThan(near);
  });

  it("keeps the ground underfoot fine however high the viewer is", () => {
    // **The altitude bug, named.** Measuring distance by the angle between directions would give
    // the patch directly below a viewer at any altitude an angle of zero, so it would never split
    // and the ground underfoot would stay coarse forever — invisible from the ground, because from
    // the ground the viewer's own radius *is* the distance. Distance is measured from the viewer's
    // position for exactly this reason.
    const look = patchCentre(rootPatch(2));
    for (const altitude of [2, 500, 4_000, 12_000]) {
      const { patches } = selectPatches(look, eyeAt(altitude), (d) =>
        planet.radiusAt(d),
      );
      const smallest = Math.min(...patches.map((p) => p.size));
      const below = patches.filter((p) => containsDirection(p, look));
      expect(below.length, `at ${altitude}`).toBeGreaterThan(0);
      for (const p of below) expect(p.size, `at ${altitude}`).toBe(smallest);
    }
  });

  it("trades patch count against tessellation through the factor", () => {
    // The one knob. Larger splits less, and this is the check that it turns.
    const look = patchCentre(rootPatch(2));
    // **Larger factor means finer**, not coarser: it makes the split test easier to pass. The first
    // version of this test asserted the opposite and failed, which is the kind of thing worth
    // pinning down in the assertion rather than in a comment.
    const factors = [1, 2, 4, 8, 16];
    const counts = factors.map(
      (factor) =>
        selectPatches(look, eyeAt(2), (d) => planet.radiusAt(d), factor).patches
          .length,
    );
    console.log(
      `\n  factor ${factors.join("/")} at 2 units up: ${counts.join(", ")} patches\n`,
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!, `factor ${factors[i]}`).toBeGreaterThan(
        counts[i - 1]!,
      );
    }
    // And the coarsest factor is still a whole planet, not a handful of patches.
    expect(counts[0]!).toBeGreaterThanOrEqual(6);
  });

  it("never returns a patch finer than the finest division", () => {
    const { patches } = selectPatches(
      patchCentre(rootPatch(2)),
      eyeAt(2),
      (d) => planet.radiusAt(d),
    );
    for (const p of patches) {
      expect(p.size).toBeGreaterThanOrEqual(1);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.size).toBeLessThanOrEqual(PATCH_ROOT);
      expect(p.y + p.size).toBeLessThanOrEqual(PATCH_ROOT);
    }
  });
});

/**
 * The nearest patch centre on the entire sphere, by exhaustive scan.
 *
 * **The reference both inverse tests are measured against**, and deliberately the slowest thing in
 * this file. If the bounded search in `patchOf` ever disagrees with this, the search is wrong — not
 * the definition.
 */
/**
 * Every patch centre at a size, built once.
 *
 * **Hoisted out of the per-direction loop**, which is the whole cost of this reference: rebuilding
 * six thousand centres for each of thousands of directions is a five-second test that measures
 * nothing. It is still an independent scan — it walks the grid itself rather than asking the
 * implementation for its table — so it can still catch the implementation being wrong.
 */
const referenceTable = (
  size: number,
): { patches: readonly Patch[]; centres: Float64Array } => {
  const patches: Patch[] = [];
  for (let face = 0; face < 6; face++) {
    // **The bound is `x + size <= 32`, stepping by `size`.** This reference first walked
    // `x < 32/size` instead, which at `size = 8` considered exactly one patch per face and
    // disagreed with the lookup on nearly everything. A reference that is wrong is worse than none.
    for (let x = 0; x + size <= 32; x += size) {
      for (let y = 0; y + size <= 32; y += size)
        patches.push({ face, x, y, size });
    }
  }
  const centres = new Float64Array(patches.length * 3);
  for (let i = 0; i < patches.length; i++) {
    const c = patchCentre(patches[i] as Patch);
    centres[i * 3] = c.x;
    centres[i * 3 + 1] = c.y;
    centres[i * 3 + 2] = c.z;
  }
  return { patches, centres };
};

const nearestCentreEverywhere = (
  d: ReturnType<typeof directionAt>,
  reference: { patches: readonly Patch[]; centres: Float64Array },
): Patch => {
  let best = reference.patches[0] as Patch;
  let bestDot = -Infinity;
  for (let i = 0; i < reference.patches.length; i++) {
    const dot =
      (reference.centres[i * 3] as number) * d.x +
      (reference.centres[i * 3 + 1] as number) * d.y +
      (reference.centres[i * 3 + 2] as number) * d.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = reference.patches[i] as Patch;
    }
  }
  return best;
};

describe("the inverse", () => {
  it("puts a direction in the patch whose centre is nearest, against a brute-force scan", () => {
    // **The real correctness property**, and the one the neighbourhood search could plausibly fail:
    // that the bounded search around `faceOf`'s starting cell finds the same patch a scan of the
    // whole face would. A cheaper test — that a direction comes back in *some* patch — would pass
    // with the search radius set to zero and a return of the start cell every time.
    for (const size of [32, 8, 2, 1]) {
      // Built once per size. The first version rebuilt it inside the direction loop, which at the
      // finest size meant six thousand `patchCentre` calls per direction and a test that timed out
      // before it could report anything.
      const reference = referenceTable(size);
      // **Step by `size`, not by a fraction of the patch count.** The first version stepped by a
      // quarter of `step`, which generated patches at indices no quadtree contains — a size-8 patch
      // at `y = 2` — and then compared the lookup against a reference that only knew about real
      // ones, so it failed on inputs that were never valid to begin with.
      for (const face of [0, 2, 4, 5]) {
        for (let x = 0; x + size <= 32; x += size) {
          for (let y = 0; y + size <= 32; y += size) {
            const patch: Patch = { face, x, y, size };
            // A direction from the patch's own middle, then one from a third of the way across it.
            for (const [fx, fy] of [
              [0.5, 0.5],
              [0.2, 0.8],
            ] as const) {
              const d = patchDirectionAt(patch, fx, fy);
              const back = patchOf(d, size);
              const label = `face ${face} patch ${x},${y},${size} at ${fx},${fy}`;
              expect(back.size, label).toBe(size);
              // **Against a scan of every face**, because the answer is a global one: near a cube
              // edge the nearest centre can be on the neighbouring face, and a per-face scan
              // would call that wrong.
              const nearest = nearestCentreEverywhere(d, reference);
              expect(`${back.face},${back.x},${back.y}`, label).toBe(
                `${nearest.face},${nearest.x},${nearest.y}`,
              );
            }
          }
        }
      }
    }
  });

  it("gives every direction on the sphere some patch", () => {
    // The floor of the whole thing: an address outside the grid is a hole in the world.
    let outside = 0;
    let total = 0;
    for (let i = 0; i < 6; i++) {
      for (let j = -6; j <= 6; j++) {
        for (let k = -6; k <= 6; k++) {
          const d = directionAt(i, j / 6, k / 6);
          total++;
          const p = patchOf(d, 1);
          if (p.x < 0 || p.y < 0 || p.x >= 32 || p.y >= 32 || p.size !== 1)
            outside++;
        }
      }
    }
    console.log(`\n  ${total} directions, ${outside} with no patch\n`);
    expect(outside).toBe(0);
  });

  it("puts every direction in the same patch a full scan of the sphere would", () => {
    // **The search radius, validated against the whole sphere.** `patchOf` searches a bounded
    // neighbourhood around `faceOf`'s starting cell, and the bound is only safe if the true
    // nearest is always inside it. This scans every patch of every face and compares, so a radius
    // that were too small would fail here rather than in a player's collision.
    let differ = 0;
    let total = 0;
    for (const size of [8, 4, 2, 1]) {
      const table = referenceTable(size);
      for (let face = 0; face < 6; face++) {
        for (let i = 0; i <= 10; i++) {
          for (let j = -10; j <= 10; j++) {
            const d = directionAt(face, i / 10 - 0.5, j / 10);
            total++;
            const got = patchOf(d, size);
            const nearest = nearestCentreEverywhere(d, table);
            if (
              got.face !== nearest.face ||
              got.x !== nearest.x ||
              got.y !== nearest.y
            ) {
              differ++;
            }
          }
        }
      }
    }
    console.log(
      `\n  bounded search matched a full sphere scan on ${total - differ}/${total} directions\n`,
    );
    expect(differ).toBe(0);
  });

  it("is stable along a walk, which is what streaming needs", () => {
    // **The property that matters for a player rather than a direction.** Walking over the surface,
    // the patch a point is attributed to changes only when the walk crosses a patch boundary. A
    // lookup that flickered between neighbours every few steps would make the level of detail
    // stutter while a player walks in a straight line.
    const look = patchCentre(rootPatch(2));
    const eye = planet.radiusAt(look) + 2;
    const size = 2;
    let changes = 0;
    let previous: string | undefined;
    for (let step = 0; step < 400; step++) {
      // A great circle around the planet.
      const angle = (step / 400) * Math.PI * 2;
      const d = {
        x: Math.cos(angle),
        y: Math.sin(angle * 0.5) * 0.2,
        z: Math.sin(angle),
      };
      const len = Math.hypot(d.x, d.y, d.z);
      const unit = { x: d.x / len, y: d.y / len, z: d.z / len };
      const r = planet.radiusAt(unit);
      if (r > eye) continue;
      const q = patchOf(unit, size);
      const key = `${q.face},${q.x},${q.y}`;
      if (previous !== undefined && key !== previous) changes++;
      previous = key;
    }
    // Four hundred steps around a whole turn, at a patch size of two: the number of boundaries
    // crossed is bounded by the number of patches passed, which is nowhere near four hundred.
    expect(changes).toBeLessThan(200);
  });
});
