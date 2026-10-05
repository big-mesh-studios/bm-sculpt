/**
 * The far-field globe, and the altitude at which it takes over.
 *
 * ## The swap
 *
 * Above {@link GLOBE_START_ALTITUDE} the streamed chunks are still being drawn but the globe is drawn
 * over them; below it the globe fades out. The band is a band rather than a line because a hard
 * switch has two failure modes and both are visible: a pop, and a seam. The pop is the obvious one and
 * the fade fixes it. The seam is the one that gets missed — the two surfaces have different geometry,
 * and during any fade there is an annulus where both are partly present, so **the fade is wide enough
 * that neither surface is ever at full strength in the overlap**.
 *
 * ## Why the altitude is a measurement and not a preference
 *
 * The streamed chunks stop resolving useful detail at a distance, and the horizon grows with the
 * square root of height — at 400 units up the horizon is thousands of units away, and the chunks
 * are gone by 1,280. So the altitude where the globe becomes necessary is the altitude where the
 * horizon outruns the chunks, and that is computable rather than tunable:
 *
 *     horizon ≈ √(2 · R · h)      for height h over radius R
 *
 * On this planet R = 136,000, so at the surface the horizon is about 1,280 and the chunks' reach
 * just covers it. The crossover below is still a real measurement with a real answer, and the
 * number is that answer's neighbourhood rather than its formula.
 *
 * ## Why it is in pieces
 *
 * **Because 512 longitude segments is 131,841 vertices, and one draw call can address 65,535 of
 * them.** That is `MAX_DRAW_VERTICES` below, and the consequence is not a degraded globe but a
 * missing one — the draw call is refused rather than clamped. So the sphere is cut into longitude
 * bands of the same tessellation and drawn as several meshes on the one material; see `globeBands`
 * for why that is cheaper than the alternative of halving the tessellation, which is the number the
 * constant exists to set.
 */

import { GlobeMaterial, globeTextures } from "../render/globe";
import type { GlobeMaps } from "../render/globe";
import {
  DEFAULT_PLANET,
  reachOf,
  type PlanetMaps,
} from "@big-mesh-studios/csg";
import { Mesh, SphereGeometry } from "@random-mesh/rmsl/scene";

/**
 * The maps' size, in texels.
 *
 * **3072×1536, chosen against a measurement rather than a guess.** The bake is 4,718,592
 * three-dimensional noise evaluations and comes to roughly 5s on a phone; halving either axis
 * quarters the cost and costs visible detail, and doubling either doubles the cost for detail nobody
 * sees from orbit. One texel is about 278 units of surface at the equator — finer than a chunk
 * (`BLOCK_WORLD` is 320), which is the requirement, since the globe replaces chunks rather than
 * approximating them.
 */
export const GLOBE_MAP_WIDTH = 3072;
export const GLOBE_MAP_HEIGHT = 1536;

/**
 * How far above the tallest terrain the crossfade starts.
 *
 * **The relief, plus a margin — and derived, not written down.** The globe is faded by altitude
 * above the *sea* and a player can stand on the highest peak this planet has, so the band has to
 * begin above the relief or it would blend the globe over the ground underfoot on every summit.
 * That was `420` against a reach of `288`, and the margin was doing the work: raise the mountains
 * and the hardcoded number is suddenly *below* the peaks, which is a bug nobody finds by reading
 * it. `reachOf` is the landscape's own answer, and it moves when the landscape does.
 *
 * The margin is 140 units, about one and a half seconds of a climb, so a player who goes up
 * deliberately sees the swap rather than arriving at it.
 */
const GLOBE_CLEARANCE = 140;

/** How far up the horizon is before the streamed chunks have nothing left to say. */
export const GLOBE_START_ALTITUDE = reachOf(DEFAULT_PLANET) + GLOBE_CLEARANCE;

/** How far up the globe has fully taken over. The band is 480 units — eight seconds of flight. */
export const GLOBE_FULL_ALTITUDE = GLOBE_START_ALTITUDE + 480;

/**
 * How much tessellation the globe's *silhouette* needs.
 *
 * **Fewer than the terrain's, and that is the point.** The mesh's job is the outline and the
 * displacement's coarse shape; every pixel's normal comes from the height map per fragment, so a
 * smooth sphere with real displacement looks like terrain. It is 512 rather than 256 now: on a
 * 136,000-unit radius a 256-segment sphere's facets subtend a visible angle from orbit, where the
 * previous 4,000-unit radius's did not. The shading is still per-fragment; this is only the outline.
 *
 * **And it is a count of longitude segments, not of vertices** — this number plus its half is what
 * `globeBands` divides up, and the reason it divides anything at all is {@link MAX_DRAW_VERTICES}.
 */
export const GLOBE_SEGMENTS = 512;

/**
 * The most vertices one draw call can address, and the reason the globe is in pieces.
 *
 * **A WebGL index buffer is sixteen bits wide without `OES_element_index_uint`**, so 65,535 is not
 * a choice here — it is what the hardware will read. Above it the index buffer wraps and the mesh
 * is not slightly wrong, it is gone.
 *
 * **Nothing in this project checks for the extension**, which is why the globe was over the limit
 * for as long as it was: rmsl's indexed path picks `UNSIGNED_INT` for any array that is not a
 * `Uint16Array` and calls `drawElements` with it, so on a context without the extension the call is
 * refused by the driver and **nothing is drawn and nothing is logged**. A missing planet, silently.
 *
 * The chunk meshes have never been at risk — Surface Nets puts at most one vertex in a cell, and a
 * chunk owns at most 35 cells on an axis, so no chunk mesh can pass 42,875 whatever it contains. The
 * globe was the one geometry in the scene built from a segment count rather than from a chunk, and
 * it was the one geometry that could exceed this.
 */
export const MAX_DRAW_VERTICES = 65_535;

/**
 * How many vertices a sphere patch of these segment counts holds.
 *
 * **Both ends inclusive**, which is what makes the whole thing necessary: a `SphereGeometry` has a
 * duplicated column at each meridian and a duplicated row at each pole, so 512 × 256 is
 * 513 × 257 = 131,841 rather than 131,072, and the extra 769 are what put it over the line.
 */
const patchVertices = (width: number, height: number): number =>
  (width + 1) * (height + 1);

/**
 * The globe's longitude bands: how many the sphere is cut into, and where each one starts.
 *
 * **The fewest whole meridians that bring every band under {@link MAX_DRAW_VERTICES}.** Bands are
 * equal and the sphere is cut in longitude only, because longitude is the axis whose segment count
 * the silhouette is chosen by — cutting there costs tessellation exactly nowhere, since the poles
 * get no more segments than they already had and the equator gets all of them.
 *
 * For the shipped 512 × 256 that is **four bands of 128 segments each**, at 129 × 257 = 33,153
 * vertices apiece. Three would do if they divided: 512 / 3 is not a whole number of segments, and a
 * band width that is not a whole number is not something the geometry can be built from.
 *
 * **Splitting rather than thinning, and the arithmetic says thinning is not even available.** A single
 * sphere of 256 longitude segments is 257 × 257 = 66,049 vertices — *still* over the limit, by 514. The
 * widest sphere that fits in one draw call is **254 segments**, at 255 × 257 = 65,535 exactly, so
 * keeping the globe as one mesh means giving up half its tessellation. That is the constant this
 * file exists to justify: 256's facets sag four times further from the sphere than 512's, which from
 * orbit is four times the outline error. Four draw calls of the same tessellation is the cheaper
 * price, and it is the only one that does not spend the silhouette.
 *
 * **Bands and not arbitrary patches, so the seam between them cannot be a crack.** Adjacent bands
 * generate the shared meridian from the same `phiStart` and the same formula, so their vertices
 * along it are bit-identical, and `SphereGeometry` is closed in longitude — there is no gap to leave.
 * The shading cannot disagree across the join either, and this is worth stating because it is the
 * usual reason a sphere gets split: **`GlobeMaterial` never reads the mesh's `normal` attribute.**
 * Every normal is rebuilt per fragment from the height map, and the displacement reads the
 * `position` attribute, so two bands meeting at a meridian differ only in which triangles they own.
 */
export const globeBands = (
  widthSegments: number,
  heightSegments: number,
  maxVertices: number = MAX_DRAW_VERTICES,
): readonly { phiStart: number; phiLength: number; segments: number }[] => {
  let bands = 1;
  // The bound is `widthSegments` rather than a number: a sphere has at least one band, and every
  // count from one up divides itself, so the loop terminates.
  while (bands <= widthSegments) {
    if (widthSegments % bands === 0) {
      const width = widthSegments / bands;
      if (patchVertices(width, heightSegments) <= maxVertices)
        return Array.from({ length: bands }, (_, band) => ({
          phiStart: (band * 2 * Math.PI) / bands,
          phiLength: (2 * Math.PI) / bands,
          segments: width,
        }));
    }
    bands++;
  }
  // Unreachable: one band of the full width is the whole sphere, so `bands === widthSegments` always
  // divides, and at that width the patch is `(1 + 1) * (heightSegments + 1)`, which is smaller than
  // any limit that admits the globe at all.
  throw new Error(
    `globe: no longitude banding of ${widthSegments} segments fits under ${maxVertices} vertices`,
  );
};

/**
 * How much of the globe is showing, 0 to 1.
 *
 * **A plain linear ramp, and the reason it is not smoother is that a smoother one is worse.** The
 * globe has to reach full strength before the chunks stop being drawn, and it has to be gone before
 * the player is low enough for the chunks' own detail to matter. A smoothstep spends most of its
 * range in the middle of the band, where the two surfaces are both half-transparent and the seam is
 * widest; a linear ramp spends it evenly, so the overlap is never long.
 *
 * Clamped, because the caller is a camera position that can be inside the planet and above the top of
 * the atmosphere, and a fade factor outside 0…1 would extrapolate the other side of the transition.
 */
export const globeOpacityAt = (altitude: number): number => {
  const t =
    (altitude - GLOBE_START_ALTITUDE) /
    (GLOBE_FULL_ALTITUDE - GLOBE_START_ALTITUDE);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
};

/** The distance at which the streamed chunks stop, used to say why the altitude is what it is. */
export const CHUNK_REACH = 4 * 320;

/**
 * The altitude at which the horizon passes the chunks' edge, for the record.
 *
 * **Not used to drive the swap — the switch does not happen where the arithmetic says, because the
 * arithmetic assumes a smooth sphere and the chunks are a cube.** It is here because the constant it
 * produces is the closest thing to a justification for {@link GLOBE_START_ALTITUDE} that can be had
 * without a browser, and a number nobody can account for is a number nobody dares change.
 */
export const horizonAltitudeFor = (reach: number, radius: number): number =>
  (reach * reach) / (2 * radius);

export interface Globe {
  readonly material: GlobeMaterial;
  /**
   * How many meshes the globe is drawn as, which is {@link globeBands}' count.
   *
   * Exposed because the number is the whole of {@link MAX_DRAW_VERTICES} made visible, and a
   * readout that reports "1 mesh" on hardware that cannot draw it would be a second wrong answer.
   */
  readonly meshCount: number;
  /**
   * Where the camera is, and the hour.
   *
   * Called every frame with the player's radius, because the opacity is a function of it and the
   * material's uniform has to be written every frame or it holds the last value.
   */
  update(radius: number): void;
  dispose(): void;
}

export const createGlobe = (
  scene: { add: (mesh: Mesh) => void; remove: (mesh: Mesh) => void },
  maps: PlanetMaps,
): Globe => {
  const asGlobeMaps: GlobeMaps = {
    albedo: maps.albedo,
    height: maps.height,
    width: maps.width,
    height_: maps.height_,
    seaRadius: maps.seaRadius,
    relief: maps.relief,
  };

  const material = new GlobeMaterial();
  material.setMaps(globeTextures(asGlobeMaps), asGlobeMaps);

  // **The sea radius, not a constant.** The sphere's undisplaced size has to be the field's own
  // baseline so the displacement reads as terrain sitting on the ground rather than as a sphere with
  // mountains glued to it, and so the horizon line agrees with a chunk's.
  //
  // **One mesh per band, all on the one material, and the tessellation is unchanged** — see
  // `globeBands`, which is where the reason for four rather than one lives. One material rather
  // than one each is the same decision `ChunkMeshStore` makes about the sea: the day's light and the
  // fog are written into it once a frame, and a second instance would be a second thing to write to.
  const heightSegments = Math.floor(GLOBE_SEGMENTS / 2);
  const meshes = globeBands(GLOBE_SEGMENTS, heightSegments).map((band) => {
    const geometry = new SphereGeometry(
      maps.seaRadius,
      band.segments,
      heightSegments,
      band.phiStart,
      band.phiLength,
    );
    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    return { geometry, mesh };
  });

  return {
    material,
    meshCount: meshes.length,
    update(radius: number): void {
      const opacity = globeOpacityAt(radius - maps.seaRadius);
      // **Opacity through the material, not through the mesh's `visible`.** A visible flag pops; the
      // only thing that hides a surface without popping is drawing it with nothing left to show.
      material.opacity = opacity;
      // At zero the globe is not drawn at all, so it costs nothing below the crossover and cannot
      // z-fight a chunk that is still fully opaque. **Every band, because one band drawn is a
      // planet with a slice of it missing** — which is a worse failure than the whole thing being
      // absent, because it looks like a bug in the terrain.
      for (const { mesh } of meshes) mesh.visible = opacity > 0;
    },
    dispose(): void {
      // **Every band, and its geometry.** The geometries are what own the GPU buffers and the
      // renderer's buffer table keys on the geometry object, so a band removed from the scene
      // without being disposed is a leak of several hundred thousand bytes that lives for the
      // renderer's lifetime — and the globe is built once per session, so it is small, but it is
      // the same rule as `releaseSlotGeometry` and for the same reason.
      for (const { geometry, mesh } of meshes) {
        scene.remove(mesh);
        geometry.dispose();
      }
    },
  };
};
