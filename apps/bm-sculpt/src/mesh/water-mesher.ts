/**
 * Water, meshed per chunk from a field, rather than drawn as a sphere over everything.
 *
 * ## What was wrong with a sphere
 *
 * The sea used to be a `SphereGeometry` at the planet's radius, drawn after the terrain and
 * depth-tested against it. It has no relationship to the ground: it is everywhere below
 * that radius, and the only reason a hole in the ground does not show it is that the rock
 * around the hole happens to be in front of it. **Dig a shaft down through a hill and the
 * sphere crosses the shaft**, and the shaft fills with water to the bottom — which is
 * where the shape of the sphere, rather than the shape of the landscape, decided where
 * water is.
 *
 * ## What this is instead
 *
 * A water surface, meshed by the same Surface Nets that meshes the ground, out of a field
 * that is only the sea:
 *
 *     sea(p) = |p| − seaLevel                a planet
 *     sea(p) = p.y − seaLevel                a height field
 *
 * and refused wherever the **ground** is, which is the part a sphere cannot do. The ground
 * is not in the field — it is the mesher's `marker`, and a cell with any corner inside it
 * gets no vertex. See `SurfaceNetsParams.cellGate` for why the alternative, a CSG
 * difference `max(sea, −ground)`, does not work: a difference's boundary is both operands'
 * boundaries, so it draws the seabed as well as the sea, and the seabed is already drawn.
 *
 * ## The gate takes the ground from the *landscape*, not from the model
 *
 * **The marker is the base field, with no operations folded over it**, and that is the
 * whole of the fix. Water is a static sheet at sea level, cut to the shape of the world as
 * it was generated:
 *
 * - a shaft dug down through a hill crosses sea level *inside rock*, where the landscape
 *   says solid, so the water is not there and the shaft is dry;
 * - a pit dug into the seabed sits below a landscape that was already underwater, so the
 *   water surface stays above it and the pit is dry air under water.
 *
 * Which is what the sibling voxel engine does with water: water is placed when the world
 * is generated and digging removes voxels rather than adding them, so a hole you dig in the
 * ground is not a hole water finds. It is also the cheaper arrangement — the base field is
 * a closed form and never walks the operation BVH, so **the water pass costs a fraction of
 * what the ground pass it clips costs**, and it does not depend on the model's revision at
 * all, so a sculpt does not re-mesh the sea.
 *
 * The consequence worth stating: the sea does not follow a dig. That is a decision, not an
 * oversight, and ADR 0043 is where it is recorded along with what it costs.
 *
 * ## The edge where the water meets the shore
 *
 * **One cell ragged, in whichever direction the ground rises.** A cell is accepted only if
 * none of its corners is in the ground, and the cell holding the shoreline has corners in
 * it, so the water stops up to a cell short of the true waterline — ten units at the finest
 * level, forty at the coarsest. That reads as shallows: the strip it loses is the strip
 * where the ground is within a cell of the surface, which is exactly where you would see
 * the bottom anyway.
 *
 * ## Normals and colour, neither of which this uses
 *
 * **The material takes the normal from the sphere's centre, per fragment**, so the sea's
 * surface is smooth at any tessellation and the vertex normals are never read — which is
 * why the sphere's own argument for being coarse (`world/water.ts`) survives the sphere
 * being deleted. The vertex layout is shared with the ground's chunks, so a normal and an
 * opaque white are still written: the normal as the outward radial, which is what the
 * material would compute anyway, and the colour because `ChunkMeshBuilder` will not take a
 * vertex without one.
 */

import type { Bounds } from "@big-mesh-studios/core";
import type { BuiltBaseField } from "@big-mesh-studios/csg";
import { isPlanetField, radiusRangeOf } from "@big-mesh-studios/csg";
import {
  ChunkMeshBuilder,
  scratchFor,
  surfaceNets,
  type ChunkMesh,
  type SurfaceNetsScratch,
} from "@big-mesh-studios/meshing";

import { lodSamples } from "../world";
import type { CellCoord, Lod, OverlapMask } from "../world";
import { VOXEL_SIZE } from "../constants";
import {
  chunkRegion,
  type ChunkMesher,
  type MeshRequest,
} from "./chunk-mesher";
import { OVERLAP_CELLS, overlapCells } from "./overlap";

/**
 * The sea as a signed distance: negative below the waterline.
 *
 * **Measured outward, because that is the mesher's convention and not a detail.** Surface Nets
 * reads `distance < 0` as inside the material, so the water has to be the material here: a point
 * below the sea level is negative. The sign is the only thing the meshing depends on, and it is
 * the thing a field that reads "distance to the surface" would have wrong — which would put a
 * sphere of air in the middle of the ocean and nothing at all at its surface.
 *
 * **The landscape's own sea level, not a number passed in.** `seaLevel` travels on the field
 * (`BuiltBaseField.seaLevel`) because it is a property of the world rather than of anything
 * drawing it: it is `radius` on a planet and `origin` on a height field, and a caller that
 * supplied its own would be one more place the water could be somewhere other than where the
 * ground says.
 */
export const seaDistanceOf = (
  base: BuiltBaseField,
): ((x: number, y: number, z: number) => number) => {
  const seaLevel = base.seaLevel;
  // A planet's centre is the origin, which ADR 0036 is why — so the radius needs no centre
  // and the two worlds differ only in where the distance is measured from.
  if (isPlanetField(base))
    return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - seaLevel;
  return (_x, y, _z) => y - seaLevel;
};

/**
 * How far the sea is allowed to reach *into* the ground, in world units.
 *
 * **Two finest voxels, and it is there to close a gap you can see.** A cell is refused when any
 * of its corners is inside the ground, and the cell holding the shoreline always has some — so
 * the water stops short of where the ground actually crosses the sea level, and that strip is
 * bare seabed along every beach. How short is not one cell: the gate's decision is about a
 * *corner's* depth, and on a gentle shore a corner a hundred units from the water line is still
 * only a few units inside the rock. Measured on a 1:10 beach, with no margin at all the sea's edge
 * stopped 105 units short of the shoreline; one voxel closed it to 5, and two reached past it.
 *
 * The water this admits is **buried, not visible**, and that is structural rather than lucky: a
 * vertex is still placed where the sea's own surface crosses zero, which on the land side of a
 * rising shore is *inside* the land, by ever more the further in it goes. So the deeper the overlap
 * the deeper the burial, and there is no margin at which a water vertex ends up above ground —
 * `water-mesher.test.ts` holds that, and it is why a margin rather than a shift of the sea level.
 * The land is opaque and writes depth, so the extra water is not drawn at all.
 *
 * Fixed rather than scaled with the level of detail, and the asymmetry is deliberate: admitting
 * extra cells only ever *adds* water that is inside rock, and rock occludes it, so where two
 * chunks of different strides disagree about a cell near the shore the disagreement is a vertex
 * nobody can see rather than a notch in the water. A margin that scaled with the stride would
 * put the far chunk's overlap four times deeper for no gain anyone could see.
 */
export const WATER_OVERLAP = 2 * VOXEL_SIZE;

/**
 * Whether a cell may carry the sea's surface, given how far into the ground the sea may reach.
 *
 * **Every corner, not all.** A cell holding one corner of rock is a cell the seabed passes
 * through, and the whole of the original complaint was that the seabed was being drawn as water.
 * The margin is what distinguishes the corner of a *beach* — where the rock is a few units under
 * the surface and the water can be hidden inside it — from the corner of the sea bed, which is
 * tens of units down and must be refused.
 *
 * `marks` is the ground's signed distance at each corner, negative inside the rock, so `-overlap`
 * is the furthest into the ground a corner may be and still have the sea reach it.
 *
 * @param overlap how far into the ground the sea may reach. `0` is the strict rule — every corner
 *   out of the ground — and is what the mesher's own tests hold the gate to; the game passes
 *   `WATER_OVERLAP` so there is no gap at the shore.
 */
export const outOfTheGround =
  (overlap = 0) =>
  (_corners: Float32Array, marks: Float32Array): boolean => {
    for (let corner = 0; corner < 8; corner++)
      if (marks[corner]! < -overlap) return false;
    return true;
  };

/**
 * Whether a box could hold any water at all, answered without sampling it.
 *
 * **Two distances and eight corners for a planet, two comparisons for a height field.**
 * Water is only ever where the ground is open and the point is below sea level, so a box
 * whose radius range misses the sea level cannot hold any — and on a planet almost every
 * box does, which is the point: deep rock and high sky are answered here rather than by
 * 34,304 samples each.
 *
 * **Conservative in the safe direction only**, for the reason `couldHoldSurface` gives: a
 * `false` for a box that does hold water puts a hole in the sea that nothing re-meshes,
 * while a `true` costs one chunk's samples. The comparisons are therefore strict, so a
 * box whose corner lands exactly on the sea level is not ruled out.
 */
export const couldHoldWater = (
  base: BuiltBaseField,
  bounds: Bounds,
): boolean => {
  const seaLevel = base.seaLevel;
  if (!isPlanetField(base))
    return bounds.min.y <= seaLevel && bounds.max.y >= seaLevel;
  const [min, max] = radiusRangeOf(bounds);
  return min <= seaLevel && max >= seaLevel;
};

/**
 * Meshes a chunk's water with Surface Nets, from the sea's field and the landscape's.
 *
 * **The same region, the same samples and the same overlap as the ground**, because the
 * two are two surfaces through one volume: the sea's edge has to land on the same plane
 * the ground's boundary does or the shoreline breaks wherever a level of detail changes.
 */
export class WaterChunkMesher implements ChunkMesher {
  private readonly scratch: SurfaceNetsScratch;
  private readonly builder = new ChunkMeshBuilder();
  private readonly sea: (x: number, y: number, z: number) => number;
  private readonly ground: (x: number, y: number, z: number) => number;
  private readonly gate: (
    corners: Float32Array,
    marks: Float32Array,
  ) => boolean;

  constructor(
    private readonly base: BuiltBaseField,
    samples: number = lodSamples(0),
  ) {
    // Sized for the widest run rather than the widest chunk, for the reason
    // `SurfaceNetsChunkMesher` is: a scratch one cell short reads air where the field said
    // solid. The sea's own grid is the same size, so this is two grids rather than one.
    this.scratch = scratchFor(samples, OVERLAP_CELLS);
    this.sea = seaDistanceOf(base);
    // Bound once, because it is called once per crossing cell and a closure built per chunk is
    // a small cost for a predicate that never changes shape.
    this.gate = outOfTheGround(WATER_OVERLAP);
    // Bound once, because it is called 34,304 times a chunk and a property read on a
    // `this` per call is a cost this does not need to pay.
    this.ground = (x, y, z) => base(x, y, z);
  }

  /** See `SurfaceNetsChunkMesher.couldHaveMesh`; this is the sea's version of it. */
  couldHaveMesh(cell: CellCoord, lod: Lod, overlap?: OverlapMask): boolean {
    return couldHoldWater(
      this.base,
      chunkRegion(cell, lod, overlapCells(overlap)).sampleBounds,
    );
  }

  mesh(request: MeshRequest): ChunkMesh {
    const region = chunkRegion(
      request.cell,
      request.lod,
      overlapCells(request.overlap),
    );
    surfaceNets({
      origin: [region.origin.x, region.origin.y, region.origin.z],
      samples: region.samples,
      extra: region.extra,
      sampleSize: region.sampleSize,
      sampler: { distance: this.sea },
      // `BaseField` is a call signature rather than an object with a `distance` method,
      // so the ground is read by calling it. Wrapped rather than passed straight through
      // because `SurfaceSampler` is an interface a caller can implement, and a field that
      // *is* one would satisfy it by accident.
      marker: { distance: this.ground },
      cellGate: this.gate,
      out: this.builder,
      scratch: this.scratch,
      onVertex: (index, x, y, z) => {
        // The outward radial, which is the normal the material computes per fragment
        // anyway — written because the layout is shared and the builder will not take a
        // vertex without one, not because anything reads it.
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length > 1e-9)
          this.builder.setNormal(index, x / length, y / length, z / length);
        this.builder.setColour(index, { r: 255, g: 255, b: 255 }, 255);
      },
    });
    return this.builder.finish();
  }
}
