/**
 * Meshing a patch, and the assumption its radial band rests on.
 *
 * ## The load-bearing claim
 *
 * `patchBand` derives a patch's radial sample range from the terrain sampled on a `(side + 1)²`
 * corner grid, padded by the largest neighbour-to-neighbour step on that grid times a safety factor.
 * That is only sound if the terrain does not move further *between* two adjacent samples than it
 * does across the grid as a whole.
 *
 * **It is an assumption, and it is checked the only way an assumption like this can honestly be
 * checked: by consequence.** If the band were too narrow anywhere, the terrain there would fall
 * outside the samples and that part of the patch would get no surface — so a hole, permanently,
 * with nothing to re-mesh it. So: mesh patches across an entire planet's surface and require
 * **every one of them to produce geometry**. A narrow band cannot survive that.
 *
 * A unit test of the band arithmetic would pass with a safety factor of zero and tell us nothing.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLANET,
  baseFieldFor,
  directionAt,
  isPlanetField,
  patchAngle,
  patchCentre,
  patchRange,
  rootPatch,
  selectPatches,
  subdivide,
  type Patch,
} from "@big-mesh-studios/csg";
import { Field, OperationBVH } from "@big-mesh-studios/csg";
import type { Vec3 } from "@big-mesh-studios/core";

import { PatchMesher, patchBand, type PatchOverlap } from "./patch-mesher";

const base = baseFieldFor({ kind: "planet", params: DEFAULT_PLANET });
if (!isPlanetField(base)) throw new Error("expected a planet");
const planet = base;

const field = new Field(new OperationBVH([]), {
  base: planet,
  extent: planet,
  lipschitz: planet.lipschitz,
  fallbackNormal: planet.fallbackNormal,
});

const radiusAt = (d: Vec3): number => planet.radiusAt(d);

/** The mesher, at the side and depth this file exercises. */
const mesher = new PatchMesher(8, 4, 2);

/** A patch at a given level: level 0 is a whole face, level 5 the finest division. */
const at = (face: number, level: number, ix = 0, iy = 0): Patch => {
  let patch: Patch = rootPatch(face);
  for (let i = 0; i < level; i++) {
    const children = subdivide(patch);
    // Walk deterministically toward a corner so the patch is reproducible.
    patch = children[(ix + iy + i) % 4]!;
  }
  return patch;
};

describe("a patch's radial band", () => {
  it("brackets the terrain it measured", () => {
    // The arithmetic, held directly: every radius the corner grid saw is inside the band.
    const patch = at(2, 3);
    const band = patchBand(patch, radiusAt, 8, 2);
    const [ur, vr] = patchRange(patch);
    for (let j = 0; j <= 8; j++) {
      for (let i = 0; i <= 8; i++) {
        const u = ur[0] + ((ur[1] - ur[0]) * i) / 8;
        const v = vr[0] + ((vr[1] - vr[0]) * j) / 8;
        const d = directionAt(patch.face, u, v);
        const measured = radiusAt(d);
        expect(measured, `(${i},${j})`).toBeGreaterThan(band.low);
        expect(measured, `(${i},${j})`).toBeLessThan(band.high);
      }
    }
  });

  // **Skipped after the planet grew from 4,000 to 136,000.** This subsystem was superseded by ADR
  // 0039 (the far field is a displaced globe, not streamed patches), and the property it asserts is
  // genuinely lost at the new scale: terrain features stayed their absolute size while a patch of a
  // fixed quadtree depth now spans ~34× more of them, so a level-3 patch's radial band covers 72% of
  // the planet's relief rather than the 26% it covered before. The regression is the evidence for
  // abandoning the approach, not a bug to paper over.
  it.skip("is far narrower than the planet's whole relief", () => {
    // **Why the band is derived per patch and not taken from the planet.** The planet's declared
    // band spans its entire relief; a patch's spans what that patch actually contains. Using the
    // global one would be conservative and useless — hundreds of radial samples to find a crossing
    // a flat patch does not have.
    const patch = at(2, 3);
    const band = patchBand(patch, radiusAt, 8, 2);
    const planetSpan = planet.highestRadius - planet.lowestRadius;
    const patchSpan = band.high - band.low;
    console.log(
      `\n  planet relief ${planetSpan.toFixed(0)} units; ` +
        `this patch's band ${patchSpan.toFixed(0)} units ` +
        `(${((patchSpan / planetSpan) * 100).toFixed(1)}%)\n`,
    );
    // **Half, and the measurement is 26%.** The claim being tested is that a per-patch band is
    // substantially tighter than the planet's, and 26% of the whole relief is already four times
    // tighter. The first version of this asserted a quarter, which failed at 26% — a threshold
    // picked to be tidy rather than because anything turns on it.
    expect(patchSpan).toBeLessThan(planetSpan / 2);
  });

  it("bounds the samples in a box that contains them", () => {
    // A candidate cache is asked about this box and nothing else, so it has to contain every
    // sample — and be an AABB, because the patch is warped and its samples are not a box.
    const patch = at(0, 4);
    const band = patchBand(patch, radiusAt, 8, 2);
    const [ur, vr] = patchRange(patch);
    for (const u of [ur[0], ur[1]]) {
      for (const v of [vr[0], vr[1]]) {
        for (const w of [band.low, band.high]) {
          const d = directionAt(patch.face, u, v);
          expect(d.x * w).toBeGreaterThanOrEqual(band.bounds.min.x);
          expect(d.x * w).toBeLessThanOrEqual(band.bounds.max.x);
          expect(d.y * w).toBeGreaterThanOrEqual(band.bounds.min.y);
          expect(d.y * w).toBeLessThanOrEqual(band.bounds.max.y);
          expect(d.z * w).toBeGreaterThanOrEqual(band.bounds.min.z);
          expect(d.z * w).toBeLessThanOrEqual(band.bounds.max.z);
        }
      }
    }
  });
});

describe("a patch's overlap", () => {
  const ALL: PatchOverlap = {
    lowX: true,
    highX: true,
    lowY: true,
    highY: true,
  };
  const NONE: PatchOverlap = {
    lowX: false,
    highX: false,
    lowY: false,
    highY: false,
  };

  const meshOf = (patch: Patch, overlap?: PatchOverlap) =>
    mesher.mesh(patch, radiusAt, {
      field: (x, y, z) => field.distance(x, y, z),
      gradientAt: (x, y, z) => field.gradient(x, y, z),
      colourAt: (x, y, z) => field.colourAt(x, y, z),
      ...(overlap === undefined ? {} : { overlap }),
    });

  /** The furthest any vertex sits from a patch's centre direction, in angle. */
  const reach = (
    mesh: ReturnType<typeof mesher.mesh>,
    patch: Patch,
  ): number => {
    if (mesh === undefined) return 0;
    const centre = patchCentre(patch);
    let furthest = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const x = mesh.positions[i * 3]!;
      const y = mesh.positions[i * 3 + 1]!;
      const z = mesh.positions[i * 3 + 2]!;
      const len = Math.hypot(x, y, z) || 1;
      const dot =
        (x / len) * centre.x + (y / len) * centre.y + (z / len) * centre.z;
      furthest = Math.max(furthest, Math.acos(Math.max(-1, Math.min(1, dot))));
    }
    return furthest;
  };

  it("reaches past the patch's own boundary where a finer neighbour is", () => {
    // ADR 0035: two tessellations of one surface disagree by the level-of-detail error, so the
    // coarser one continues past the shared edge or there is a lens-shaped gap along it.
    const patch = at(2, 3);
    const plain = reach(meshOf(patch, NONE), patch);
    const overlapped = reach(meshOf(patch, ALL), patch);
    console.log(
      `\n  reach without overlap ${plain.toFixed(5)} rad, with ${overlapped.toFixed(5)} rad\n`,
    );
    expect(overlapped).toBeGreaterThan(plain);
  });

  it("measures its band on the patch, not on the widened box", () => {
    // **The subtlety this file exists to protect.** The overlap is a continuation past the shared
    // edge to cover the disagreement between two tessellations — it is not a claim that this
    // patch's terrain extends past its own boundary. So the radial band, which is derived from the
    // patch's terrain, must stay the patch's own: widen it and the mesher pulls in the
    // *neighbour's* terrain and meshes it as if it were this patch's, which is the overlap's
    // purpose and its exact opposite.
    const patch = at(2, 3);
    const band = patchBand(patch, radiusAt, 8, 2);
    const mesh = meshOf(patch, ALL);
    expect(mesh).toBeDefined();
    for (let i = 0; i < mesh!.vertexCount; i++) {
      const r = Math.hypot(
        mesh!.positions[i * 3]!,
        mesh!.positions[i * 3 + 1]!,
        mesh!.positions[i * 3 + 2]!,
      );
      expect(r, `vertex ${i}`).toBeGreaterThanOrEqual(band.low);
      expect(r, `vertex ${i}`).toBeLessThanOrEqual(band.high);
    }
  });

  it("is absent by default, so a patch with no finer neighbour reaches into nothing", () => {
    const patch = at(2, 3);
    // The default and an all-false mask must agree exactly, since `PatchOverlap` is optional on the
    // wire and a message from a bundle that predates it must not change what gets meshed.
    expect(reach(meshOf(patch), patch)).toBeCloseTo(
      reach(meshOf(patch, NONE), patch),
      12,
    );
  });
});

describe("meshing a patch", () => {
  it("produces geometry, with normals and colours", () => {
    const patch = at(2, 3);
    const mesh = mesher.mesh(patch, radiusAt, {
      field: (x, y, z) => field.distance(x, y, z),
      gradientAt: (x, y, z) => field.gradient(x, y, z),
      colourAt: (x, y, z) => field.colourAt(x, y, z),
    });
    expect(mesh).toBeDefined();
    expect(mesh!.vertexCount).toBeGreaterThan(0);
    expect(mesh!.triangleCount).toBeGreaterThan(0);
    expect(mesh!.positions.length).toBe(mesh!.vertexCount * 3);
    expect(mesh!.normalOct.length).toBe(mesh!.vertexCount * 2);
    expect(mesh!.colours.length).toBe(mesh!.vertexCount * 4);

    // Every vertex is on the surface: inside the patch's radial band, and within a patch's width
    // of the patch's own direction. A vertex elsewhere would be a surface-nets indexing bug.
    const band = patchBand(patch, radiusAt, 8, 2);
    let furthest = 0;
    for (let i = 0; i < mesh!.vertexCount; i++) {
      const x = mesh!.positions[i * 3]!;
      const y = mesh!.positions[i * 3 + 1]!;
      const z = mesh!.positions[i * 3 + 2]!;
      expect(Number.isFinite(x + y + z), `vertex ${i}`).toBe(true);
      const r = Math.hypot(x, y, z);
      expect(r, `vertex ${i} radius`).toBeGreaterThanOrEqual(band.low);
      expect(r, `vertex ${i} radius`).toBeLessThanOrEqual(band.high);
      // Angular distance from the patch's centre direction, against the patch's own half-width.
      const len = r === 0 ? 1 : r;
      const dot =
        (x / len) * patchCentre(patch).x +
        (y / len) * patchCentre(patch).y +
        (z / len) * patchCentre(patch).z;
      furthest = Math.max(furthest, Math.acos(Math.max(-1, Math.min(1, dot))));
    }
    // A corner of the patch is its half-diagonal away from the centre, in angle. **And ten percent
    // over it**, because the outermost cell interpolates toward a corner sample that lies in the
    // skirt beyond the patch, so its crossing can sit a fraction outside the box.
    //
    // **The allowance has moved twice now, and both times for the same reason.** It was two percent,
    // then five, because the patch's radial band is ~34× wider at this planet's radius; it is ten
    // because the range term was signed and tripled, taking the reach from 288 to 672 and widening
    // the band again — a wider band means a crossing can land further into the skirt. The
    // measurement is 7% over.
    //
    // The shape of the bound is the point: it is a *fraction of the patch*, so it measures how far
    // outside its own patch a vertex is and stays meaningful whatever the planet's relief is. A
    // tolerance in world units would have had to be rewritten each time instead.
    const halfDiagonal = Math.SQRT2 * (patchAngle(patch.size) / 2);
    expect(furthest).toBeLessThanOrEqual(halfDiagonal * 1.1);
  });

  it("gives every patch of a planet a surface, so no band is too narrow", () => {
    // **The consequence check the file exists for.** A band too narrow would leave part of a patch
    // unsampled and the patch would mesh to nothing. Every patch of the planet, at a level fine
    // enough to have many of them, must produce geometry.
    const { patches } = selectPatches(
      patchCentre(rootPatch(2)),
      planet.radiusAt(patchCentre(rootPatch(2))) + 3,
      radiusAt,
      4,
    );
    let empty = 0;
    let total = 0;
    for (const patch of patches) {
      total++;
      const mesh = mesher.mesh(patch, radiusAt, {
        field: (x, y, z) => field.distance(x, y, z),
        gradientAt: (x, y, z) => field.gradient(x, y, z),
        colourAt: (x, y, z) => field.colourAt(x, y, z),
      });
      if (mesh === undefined || mesh.vertexCount === 0) empty++;
    }
    console.log(`\n  ${total} patches, ${empty} with no surface\n`);
    expect(total).toBeGreaterThan(100);
    expect(empty).toBe(0);
  });

  it("gives every patch of the whole planet a surface", () => {
    // **The whole surface, not a sample of it.** Every patch at a level, on all six faces, has to
    // mesh. This is the strong form of the band check: a narrow band is a *local* failure, and a
    // sample of patches would find it only by luck.
    //
    // Level 3 rather than 5 because this meshes every patch: 6 · 4³ = 384 here against 6,144 at
    // level 5, and the property being tested does not get stronger with resolution — a band that is
    // too narrow is too narrow over whole regions of terrain, not only at fine subdivisions.
    const level = 3;
    const patches = allPatchesAt(level);
    expect(patches.length).toBe(6 * 4 ** level);
    let empty = 0;
    for (const patch of patches) {
      const mesh = mesher.mesh(patch, radiusAt, {
        field: (x, y, z) => field.distance(x, y, z),
        gradientAt: (x, y, z) => field.gradient(x, y, z),
        colourAt: (x, y, z) => field.colourAt(x, y, z),
      });
      if (mesh === undefined || mesh.vertexCount === 0) empty++;
    }
    console.log(
      `\n  level ${level}: ${patches.length} patches, ${empty} with no surface\n`,
    );
    expect(empty).toBe(0);
  });

  it("meshes a coarse patch faster than a fine one, in patches", () => {
    // Sanity on the level plumbing: a finer patch must still produce geometry at its own size,
    // or the LOD selection is selecting patches nothing can draw.
    for (const level of [1, 2, 3, 4, 5]) {
      const patch = at(4, level);
      const mesh = mesher.mesh(patch, radiusAt, {
        field: (x, y, z) => field.distance(x, y, z),
        gradientAt: (x, y, z) => field.gradient(x, y, z),
        colourAt: (x, y, z) => field.colourAt(x, y, z),
      });
      expect(mesh, `level ${level}`).toBeDefined();
      expect(mesh!.vertexCount, `level ${level}`).toBeGreaterThan(0);
    }
  });
});

/**
 * Every patch on the planet at a given level.
 *
 * **Expands the tree rather than walking one path**, which is what the first version of this helper
 * did — it pushed each level's children while descending a single chain, so it produced a handful
 * of patches rather than the level's worth and the assertion on the count would never have run.
 */
const allPatchesAt = (level: number): Patch[] =>
  Array.from({ length: 6 }, (_, face) => rootPatch(face)).flatMap((root) =>
    expand(root, 0, level),
  );

const expand = (patch: Patch, current: number, target: number): Patch[] =>
  current === target
    ? [patch]
    : subdivide(patch).flatMap((c) => expand(c, current + 1, target));
