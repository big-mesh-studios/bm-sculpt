/**
 * Gate 2: does a radial field survive the existing meshing machinery unchanged?
 *
 * The chunk structure this plan settled on is the one already in the tree: a **cubic lattice
 * with a fixed 320-unit footprint at every level of detail**, re-centred on the planet.
 * Nothing about the seam rule, the overlap mask, Surface Nets or the slot pool assumes a
 * height field, so the test is whether the *field* can be radial without any of them
 * noticing. It should not be able to tell.
 *
 * ## The cells are found rather than written down
 *
 * The surface's radius is `R + scale·(base + 2·ridge·mask)`, and `base` is bounded by ±1 while
 * `ridge·mask` is in `[0, 1]`, so the surface lies between `R − 96` and `R + 288` — a band of
 * 384 units centred well *above* the nominal radius. A first attempt hardcoded cell
 * `(12, 0, 0)` on the reasoning that `12 · 320 = 3840` is near `R = 4000`; that cell spans
 * `x ∈ [3680, 4000]` and so holds surface only where the terrain dips, and it meshed empty.
 * The three cells below are searched for instead, each chosen for the angle its surface
 * normal makes with the lattice axes, which is the only thing that differs about them.
 */

import { describe, expect, it } from "vitest";

import { Field, OperationBVH } from "@big-mesh-studios/csg";
import type { ChunkMesh } from "@big-mesh-studios/meshing";
import { BLOCK_WORLD } from "../constants";
import { SurfaceNetsChunkMesher, chunkRegion } from "../mesh/chunk-mesher";
import type { CellCoord, Lod } from "../world";
import {
  lodSampleSize,
  lodSamples,
  overlapMaskAt,
  OVERLAP_X_NEG,
  OVERLAP_X_POS,
} from "../world";
import {
  DEFAULT_PLANET,
  planetField,
  radiusRangeOf,
} from "@big-mesh-studios/csg";

interface Point {
  x: number;
  y: number;
  z: number;
}

const planet = planetField(DEFAULT_PLANET);
const mesher = new SurfaceNetsChunkMesher(
  new Field(new OperationBVH([]), {
    base: planet,
    extent: planet,
    lipschitz: planet.lipschitz,
  }),
);

const points = (mesh: ChunkMesh): Point[] => {
  const out: Point[] = [];
  for (let i = 0; i < mesh.vertexCount; i++) {
    out.push({
      x: mesh.positions[i * 3],
      y: mesh.positions[i * 3 + 1],
      z: mesh.positions[i * 3 + 2],
    });
  }
  return out;
};

const radiusOf = (p: Point): number => Math.hypot(p.x, p.y, p.z);

/** Positions are carried as `f32`, so agreement is agreement to single precision at 4000. */
const SAME_POINT = 1e-2;
const near = (a: Point, b: Point): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= SAME_POINT;

/**
 * The world coordinate of sample index `i` along x.
 *
 * The `- 0.5` is `lod-seam.test.ts`'s convention and is not a fudge: the mesher's grid runs
 * of *cells*, cell `i` is world voxel `origin + i - 1`, and a cell's centre is half a sample
 * past its low corner. Getting it wrong puts the column filter half a sample off the column
 * it is asking for, which reads as "no vertices there" rather than as an arithmetic mistake.
 */
const sampleX = (cell: CellCoord, lod: Lod, i: number): number => {
  const region = chunkRegion(cell, lod);
  return region.origin.x + (i - 0.5) * region.sampleSize;
};

/** The plane two horizontally adjacent cells share. */
const seamX = (left: CellCoord): number => (left.x + 0.5) * BLOCK_WORLD;

/** The vertices of a mesh that lie in one sample column, by world x. */
const columnAt = (mesh: ChunkMesh, x: number, lod: Lod): Point[] => {
  const half = lodSampleSize(lod) / 2;
  return points(mesh).filter((p) => Math.abs(p.x - x) <= half);
};

/**
 * Whether a cell's box straddles the surface, by brute force.
 *
 * Decided by whether the field takes **both signs** anywhere in the box, rather than by
 * looking for a crossing along one axis. An earlier version checked `z` and `z + step` with
 * `x` and `y` held still, which only finds a surface that happens to be steep in `z` within
 * the sampled rows — and reported "no surface" for cells whose whole box sits inside the
 * radius of the terrain in one direction and outside it in another. It is a weaker test and
 * it was wrong.
 *
 * A coarse stride, because this is a cross-check on the cheap gate rather than the gate
 * itself. At the mesher's own spacing, over the cell counts below, it times the suite out.
 */
const holdsSurface = (cell: CellCoord, coarse = 2): boolean => {
  const region = chunkRegion(cell, 0);
  const step = region.sampleSize * coarse;
  const b = region.sampleBounds;
  let sawSolid = false;
  let sawAir = false;
  for (let x = b.min.x; x <= b.max.x; x += step) {
    for (let y = b.min.y; y <= b.max.y; y += step) {
      for (let z = b.min.z; z <= b.max.z; z += step) {
        if (planet(x, y, z) <= 0) sawSolid = true;
        else sawAir = true;
        if (sawSolid && sawAir) return true;
      }
    }
  }
  return false;
};

/**
 * The cell nearest the origin along a given direction that holds surface.
 *
 * Searched rather than written down, because the surface's band is not where the nominal
 * radius is and a hand-picked cell silently tests the wrong thing — which is what happened
 * the first time.
 */
/**
 * Every cell in the surface's own radial band, on a ray out from the centre.
 *
 * **The band comes from the field's `lowestRadius` and `highestRadius`, and the step is a quarter
 * of a chunk.** It used to be six fixed steps of `BLOCK_WORLD / 4` from `lowestRadius`, which
 * searched a 400-unit band — and the range term being signed and tripled took the planet's reach
 * to 672, so a direction whose surface sat high fell off the end of the search and the helper
 * threw instead of finding a cell. The same mistake as the globe's hardcoded crossfade altitude,
 * and for the same reason: a band written down means something only until the landscape changes.
 */
const shellCells = (direction: Point): CellCoord[] => {
  const d = norm(direction);
  const out: CellCoord[] = [];
  const step = BLOCK_WORLD * 0.25;
  // A margin at each end, because the search rounds a radius to the cell containing it and a
  // surface at either extreme still lands inside a cell the scan has to visit.
  for (
    let radius = planet.lowestRadius - step;
    radius <= planet.highestRadius + step;
    radius += step
  ) {
    out.push({
      x: Math.round((d.x * radius) / BLOCK_WORLD),
      y: Math.round((d.y * radius) / BLOCK_WORLD),
      z: Math.round((d.z * radius) / BLOCK_WORLD),
    });
  }
  return out;
};

/**
 * A cell holding surface, near a direction.
 *
 * Scanned rather than placed on a ray: the surface's radius varies by hundreds of units
 * around the planet, so the cell a ray at one scale lands in is often a neighbour away from
 * where the terrain actually is.
 */
const surfaceCell = (direction: Point): CellCoord => {
  for (const cell of shellCells(direction)) {
    if (holdsSurface(cell)) return cell;
  }
  throw new Error(`no surface cell near ${JSON.stringify(direction)}`);
};

/**
 * Every pair of horizontally adjacent cells in the shell that both hold surface, with the
 * direction each pair sits in.
 *
 * Scanned, because a pair cannot be found by walking a ray. The surface sits at one radius
 * per direction, and a 320-unit cell spans only about ±22 units of radius at these distances
 * — so along most directions the surface falls well inside a single cell and its x-neighbour
 * is empty rock or empty air. Along `+X` specifically the terrain there is at radius 4091
 * against a cell boundary at 4000, so cell 13 holds the surface and neither 12 nor 14 does.
 * Pairs exist where the surface happens to cross a cell boundary, which is a thin set of
 * directions and has to be searched for rather than aimed at.
 */
const shellPairs = (): { cell: CellCoord; direction: Point }[] => {
  const out: { cell: CellCoord; direction: Point }[] = [];
  for (let x = 11; x <= 15; x++) {
    for (let y = -8; y <= 8; y++) {
      for (let z = -8; z <= 8; z++) {
        const cell: CellCoord = { x, y, z };
        if (!mesher.couldHaveMesh(cell, 0)) continue;
        if (!holdsSurface(cell)) continue;
        if (!holdsSurface({ ...cell, x: x + 1 })) continue;
        const centre = {
          x: (x + 0.5) * BLOCK_WORLD,
          y: (y + 0.5) * BLOCK_WORLD,
          z: (z + 0.5) * BLOCK_WORLD,
        };
        out.push({ cell, direction: norm(centre) });
      }
    }
  }
  return out;
};

/** Every place the surface crosses the plane two horizontally adjacent cells share. */
const seamCrossings = (cell: CellCoord): Point[] => {
  const plane = seamX(cell);
  const delta = lodSampleSize(0) / 2;
  const step = lodSampleSize(0);
  const out: Point[] = [];
  for (
    let y = cell.y * BLOCK_WORLD;
    y < (cell.y + 1) * BLOCK_WORLD;
    y += step
  ) {
    for (
      let z = cell.z * BLOCK_WORLD;
      z < (cell.z + 1) * BLOCK_WORLD;
      z += step
    ) {
      if (planet(plane - delta, y, z) < 0 !== planet(plane + delta, y, z) < 0) {
        out.push({ x: plane, y, z });
      }
    }
  }
  return out;
};

/**
 * Every pair in the shell whose shared seam the surface actually crosses, spread by direction.
 *
 * **Enumerated rather than picked.** Three earlier attempts chose one "representative" pair
 * per surface-normal angle and every one of them chose badly: along `+X` the terrain sits at
 * radius 4091 while the cell boundary is at 4000, so the surface is deep inside one cell and
 * both its neighbours are empty — there is no seam there to test. A representative chosen by
 * aiming at a direction is a representative chosen blind.
 *
 * Enumerating the shell and keeping only the pairs with a crossed seam finds every seam there
 * is, and taking a spread of them by direction covers the whole sphere rather than three
 * guesses at it.
 */
const seamPairs = (): CellCoord[] => {
  const found: { cell: CellCoord; direction: Point }[] = [];
  for (const { cell, direction } of shellPairs()) {
    if (seamCrossings(cell).length > 0) found.push({ cell, direction });
  }
  found.sort(
    (a, b) =>
      angleTo(a.direction, { x: 1, y: 0, z: 0 }) -
      angleTo(b.direction, { x: 1, y: 0, z: 0 }),
  );
  // A spread of `SEAM_PAIR_SAMPLES` evenly across the sorted list, so the sample spans the
  // shell's range of angles rather than clustering where the sort put them.
  const take = Math.min(SEAM_PAIR_SAMPLES, found.length);
  return Array.from({ length: take }, (_, i) => {
    const at = Math.floor((i * (found.length - 1)) / Math.max(1, take - 1));
    return (found[at] as { cell: CellCoord }).cell;
  });
};

/** How many crossed-seam pairs to test. A handful, spread by angle. */
const SEAM_PAIR_SAMPLES = 6;

/** The angle between two directions, in radians. */
const angleTo = (a: Point, b: Point): number =>
  Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));

const DIAGONAL: Point = { x: 1, y: 1, z: 1 };
const norm = (p: Point): Point => {
  const l = Math.hypot(p.x, p.y, p.z);
  return { x: p.x / l, y: p.y / l, z: p.z / l };
};

/** One cell per surface-normal angle, for the tests that only need somewhere to mesh. */
const CELLS: { name: string; cell: CellCoord }[] = [
  {
    name: "surface normal along +X",
    cell: surfaceCell(norm({ x: 1, y: 0, z: 0 })),
  },
  {
    name: "surface normal oblique",
    cell: surfaceCell(norm({ x: 1, y: 0.35, z: -0.2 })),
  },
  {
    name: "surface normal along the body diagonal",
    cell: surfaceCell(norm(DIAGONAL)),
  },
];

/** A spread of crossed-seam pairs, for the seam tests. */
const PAIRS: CellCoord[] = seamPairs();

/**
 * Pairs for the same-level test, which additionally need a vertex in **both** boundary
 * columns.
 *
 * A crossed seam is not enough for that test: the seam has to be crossed at the particular
 * sample column the two chunks share, and on a sphere the terrain can cross the shared plane
 * somewhere else in the cell and miss that column entirely. An empty column is not a broken
 * seam — there is nothing at the seam to break — so a pair without one is a pair the test
 * says nothing about.
 */
const columnPairs = (): CellCoord[] => {
  const out: CellCoord[] = [];
  for (const cell of seamPairs()) {
    const right: CellCoord = { x: cell.x + 1, y: cell.y, z: cell.z };
    const mesher_ = mesher;
    const left = columnAt(
      mesher_.mesh({ cell, lod: 0 }),
      sampleX(cell, 0, lodSamples(0)),
      0,
    );
    const rightColumn = columnAt(
      mesher_.mesh({ cell: right, lod: 0 }),
      sampleX(right, 0, 0),
      0,
    );
    if (left.length > 0 && rightColumn.length > 0) out.push(cell);
  }
  return out;
};

const COLUMN_PAIRS: CellCoord[] = columnPairs();

describe("a radial field on the cubic lattice", () => {
  it("finds the surface where the band's own arithmetic says it is", () => {
    // Before anything else: that the three chosen cells really are surface cells, and that
    // the radius band is what the derivation says. A gate that tests the wrong cells passes
    // for the wrong reason.
    for (const { name, cell } of CELLS) {
      const region = chunkRegion(cell, 0);
      const [min, max] = radiusRangeOf(region.sampleBounds);
      console.log(
        `[gate 2] ${name}: cell ${cell.x},${cell.y},${cell.z} radii ` +
          `${min.toFixed(0)}–${max.toFixed(0)}, surface band ` +
          `${planet.lowestRadius.toFixed(0)}–${planet.highestRadius.toFixed(0)}`,
      );
      expect(holdsSurface(cell), name).toBe(true);
      expect(
        min <= planet.highestRadius && max >= planet.lowestRadius,
        name,
      ).toBe(true);
    }
  });

  it("meshes every cell kind at every level without a non-finite vertex", () => {
    for (const { name, cell } of CELLS) {
      for (const lod of [0, 1, 2] as Lod[]) {
        const mesh = mesher.mesh({ cell, lod });
        expect(mesh.vertexCount, `${name} at lod ${lod}`).toBeGreaterThan(0);
        for (const p of points(mesh)) {
          expect(
            Number.isFinite(p.x) &&
              Number.isFinite(p.y) &&
              Number.isFinite(p.z),
            `${name} at lod ${lod}`,
          ).toBe(true);
        }
      }
    }
  });

  it("puts every vertex inside the band the surface can occupy", () => {
    // A vertex sits where the field changed sign, so its radius must be inside the band. A
    // vertex outside it would mean the mesher invented geometry in air or inside rock — the
    // radial form of the check a height field gets for free from `y` being a height.
    for (const { name, cell } of CELLS) {
      const mesh = mesher.mesh({ cell, lod: 0 });
      const radii = points(mesh).map(radiusOf);
      const outside = radii.filter(
        (r) => r < planet.lowestRadius || r > planet.highestRadius,
      ).length;
      console.log(
        `[gate 2] ${name}: ${mesh.vertexCount} vertices, radii ` +
          `${Math.min(...radii).toFixed(1)}–${Math.max(...radii).toFixed(1)}, ` +
          `${outside} outside the band`,
      );
      expect(outside, name).toBe(0);
    }
  });

  it("joins two cells at one level on shared vertices, whatever the cell kind", () => {
    // Over the pairs, because a same-level seam needs a cell on each side.
    // The `lod-seam.test.ts` invariant, re-run over a radial field. Its subject is the
    // *lattice*, not the field: a cell's last own sample and its neighbour's low padding
    // sample are the same world sample, read from the same field, so both place a vertex
    // there. A radial field cannot change that, and this checks that it does not.
    for (const cell of COLUMN_PAIRS) {
      const name = `cell ${cell.x},${cell.y},${cell.z}`;
      const right: CellCoord = { x: cell.x + 1, y: cell.y, z: cell.z };
      const leftColumn = columnAt(
        mesher.mesh({ cell, lod: 0 }),
        sampleX(cell, 0, lodSamples(0)),
        0,
      );
      const rightColumn = columnAt(
        mesher.mesh({ cell: right, lod: 0 }),
        sampleX(right, 0, 0),
        0,
      );

      expect(leftColumn.length, `${name} left`).toBeGreaterThan(0);
      expect(rightColumn.length, `${name} right`).toBeGreaterThan(0);
      const unmatched = rightColumn.filter(
        (p) => !leftColumn.some((q) => near(p, q)),
      );
      expect(
        unmatched.length,
        `${name}: ${unmatched.length} unmatched of ${rightColumn.length}`,
      ).toBe(0);
    }
  });

  it("covers a level step with the coarse chunk's overlap, as on flat ground", () => {
    // ADR 0035's arrangement: the coarse side owns one cell into the finer one, so its
    // surface crosses the shared plane rather than stopping on it. On flat ground that is
    // checked by measuring how far the coarse sheet reaches past the plane, and how far the
    // two sheets disagree over the overlap.
    //
    // **Neither measure transfers to a sphere, and the reason is worth stating.**
    //
    // The reach measure assumes the overlap cell contains a surface crossing. It need not: the
    // surface is a *radius*, and where the terrain puts it well inside one chunk the overlap
    // region is solid rock, so the coarse chunk correctly draws nothing there. Requiring
    // geometry there asks for a hole.
    //
    // The disagreement measure assumes the two sheets are two tessellations of one field at
    // one and the same place, so their vertices nearly coincide. On a height field a vertex's
    // (x, z) fixes its y, so "nearly coincide" holds. On a sphere the surface turns away from
    // the lattice — along `+X` it is nearly *perpendicular* to the x axis — so two
    // tessellations at different spacings put their vertices genuinely different places along
    // the surface, and the nearest-vertex distance between them measures the tessellation
    // difference rather than a disagreement about the field.
    //
    // So the property is tested directly instead: **every crossing of the shared plane is
    // covered by both sheets.** That is what "no slit" means, it holds whatever the local
    // geometry is, and it is the property a player would see broken if it failed.
    for (const cell of PAIRS) {
      const name = `cell ${cell.x},${cell.y},${cell.z}`;
      const right: CellCoord = { x: cell.x + 1, y: cell.y, z: cell.z };
      const plane = seamX(cell);
      const fine = points(mesher.mesh({ cell, lod: 0 }));
      const plainCoarse = points(mesher.mesh({ cell: right, lod: 1 }));
      const coarse = points(
        mesher.mesh({ cell: right, lod: 1, overlap: OVERLAP_X_NEG }),
      );

      // How far the coarse sheet carries past the plane. Padding alone must not cross it;
      // with the overlap it must. A vertex sits in the middle of its own cell, so the
      // furthest one can be from a crossing is half a coarse sample, and half a sample is
      // exactly the "does not stop on the plane" claim — a sheet that stopped short would
      // reach zero.
      const reachPast = (ps: Point[]): number =>
        ps.length === 0 ? 0 : plane - Math.min(...ps.map((p) => p.x));
      expect(reachPast(plainCoarse), `${name} padding only`).toBeLessThan(
        lodSampleSize(1),
      );
      expect(reachPast(coarse), `${name} with overlap`).toBeGreaterThan(
        lodSampleSize(1) / 2,
      );

      // Do the two sheets describe the same surface?
      //
      // `lod-seam.test.ts` answers that by measuring the 3D distance from each coarse vertex
      // in the overlap to the nearest fine vertex, and calls it a disagreement past one fine
      // sample. That measure is **frame-bound**: it assumes a vertex's (x, z) fixes its
      // height, which is true of a height field and false of a sphere, where the surface
      // turns away from the lattice and two tessellations at different spacings place their
      // vertices genuinely different places along the surface.
      //
      // The frame-invariant form is to compare **radius at the same direction**. Both sheets
      // are approximations of one radial graph, so a coarse vertex and the fine vertex
      // nearest it *angularly* must agree in how far out they are, however far apart they
      // sit along the ground.
      const direction = (p: Point): Point => {
        const l = radiusOf(p) || 1;
        return { x: p.x / l, y: p.y / l, z: p.z / l };
      };
      const strip = coarse.filter((p) => p.x < plane - 1e-6);
      expect(strip.length, `${name} strip`).toBeGreaterThan(0);

      let worstRadius = 0;
      let worstAngle = 0;
      let compared = 0;
      for (const p of strip) {
        const d = direction(p);
        let nearest = Infinity;
        let match: Point | undefined;
        for (const q of fine) {
          const e = direction(q);
          // `1 - dot` is squared chord length, so it orders angular nearness without an
          // arccos per pair.
          const dot = d.x * e.x + d.y * e.y + d.z * e.z;
          const gap = 1 - dot;
          if (gap < nearest) {
            nearest = gap;
            match = q;
          }
        }
        if (match === undefined) continue;
        // Skip a coarse vertex whose nearest fine vertex is genuinely far away *along the
        // surface*, so the measure cannot be satisfied by an unrelated part of the planet.
        const alongSurface = Math.sqrt(2 * nearest) * radiusOf(p);
        if (alongSurface > lodSampleSize(0) * 4) continue;
        compared++;
        worstAngle = Math.max(worstAngle, alongSurface);
        worstRadius = Math.max(
          worstRadius,
          Math.abs(radiusOf(p) - radiusOf(match)),
        );
      }

      console.log(
        `[gate 2] ${name}: ${seamCrossings(cell).length} crossings of the seam plane, ` +
          `coarse sheet reaches ${reachPast(coarse).toFixed(1)} past it ` +
          `(a coarse sample is ${lodSampleSize(1)}), ` +
          `${compared} coarse vertices compared, worst match ${worstAngle.toFixed(1)} along ` +
          `the surface, worst radius disagreement ${worstRadius.toFixed(2)}`,
      );

      // The bound is the level-of-detail error: the coarse sheet samples the same radial
      // graph twice as coarsely, so at the same direction its radius can differ by the
      // surface's own curvature over one coarse cell. Measured rather than derived, because
      // what it is depends on the terrain at the seam and there is no reason to predict it.
      // The relief is 288 units, so a bound of one coarse sample is a twelfth of the whole
      // height range — generous, and it is the same generosity `lod-seam.test.ts` allows.
      expect(compared, `${name} compared something`).toBeGreaterThan(0);
      expect(
        worstRadius,
        `${name} sheets describe one surface`,
      ).toBeLessThanOrEqual(lodSampleSize(1));
    }
  });

  it("puts the overlap on the coarse side only, as the mask decides", () => {
    // The arrangement is only cheaper if one side pays for it. Checked on the diagonal cell,
    // whose neighbours are at every angle to the surface.
    const cell = CELLS[2].cell;
    const right: CellCoord = { x: cell.x + 1, y: cell.y, z: cell.z };
    const bands = { full: 0, coarse: 1 };
    const focus: CellCoord = { ...cell };

    expect(overlapMaskAt(cell, focus, bands) & OVERLAP_X_POS).toBe(0);
    expect(overlapMaskAt(right, focus, bands) & OVERLAP_X_NEG).toBe(
      OVERLAP_X_NEG,
    );

    const fine = mesher.mesh({
      cell,
      lod: 0,
      overlap: overlapMaskAt(cell, focus, bands),
    });
    const plain = mesher.mesh({ cell, lod: 0 });
    expect([...fine.indices]).toEqual([...plain.indices]);
  });
});

describe("couldHoldSurface over a radial field", () => {
  it("never answers false for a box that holds surface", () => {
    // The one direction the gate is allowed to be wrong in: answering `false` for a box that
    // does hold surface puts a hole in the world that nothing re-meshes, because the mesher
    // that skipped it recorded an answer. The height field gets this from two comparisons;
    // the radial gate gets it from a distance-to-AABB and eight corners.
    let admitted = 0;
    let withSurface = 0;
    // The chunk column that straddles the surface, derived from the field's own radius rather than
    // the literal ten-to-fifteen that fitted the old 4,000-unit planet.
    const surfaceCell = Math.round(
      planet.radiusAt({ x: 1, y: 0, z: 0 }) / BLOCK_WORLD,
    );
    for (let cx = surfaceCell - 4; cx <= surfaceCell + 1; cx++) {
      for (let cy = -2; cy <= 2; cy++) {
        for (let cz = -2; cz <= 2; cz++) {
          const cell: CellCoord = { x: cx, y: cy, z: cz };
          const answered = mesher.couldHaveMesh(cell, 0);
          if (answered) admitted++;
          if (!answered) {
            // A skipped box must be entirely inside or entirely outside the surface band.
            const region = chunkRegion(cell, 0);
            const [min, max] = radiusRangeOf(region.sampleBounds);
            const outside =
              max < planet.lowestRadius || min > planet.highestRadius;
            expect(outside, `cell ${cx},${cy},${cz} skipped wrongly`).toBe(
              true,
            );
          }
          if (answered && holdsSurface(cell)) withSurface++;
        }
      }
    }
    console.log(
      `[gate 2] the gate admitted ${admitted} cells, of which ${withSurface} hold surface ` +
        `(${(100 * withSurface) / admitted}%)`,
    );
    expect(withSurface).toBeGreaterThan(0);
  });

  it("skips most of a cubic lattice, which is what makes 2000 chunks affordable", () => {
    let total = 0;
    let skipped = 0;
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        for (let z = -14; z <= 14; z++) {
          total++;
          if (!mesher.couldHaveMesh({ x, y, z }, 0)) skipped++;
        }
      }
    }
    const pct = (100 * skipped) / total;
    console.log(
      `[gate 2] couldHaveMesh skipped ${skipped} of ${total} cells in a ±14 cube (${pct.toFixed(1)}%)`,
    );
    // The shell through a sphere is a small fraction of a cube around it, so the gate's
    // saving is large. This is the number that decides whether a planet is streamable at all.
    expect(pct).toBeGreaterThan(70);
  });
});
