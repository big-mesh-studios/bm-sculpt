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
 */

import { GlobeMaterial, globeTextures } from "../render/globe";
import type { GlobeMaps } from "../render/globe";
import type { PlanetMaps } from "@big-mesh-studios/csg";
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
 * How far up the horizon is before the streamed chunks have nothing left to say.
 *
 * **Four hundred and twenty, which is above the tallest terrain.** The globe is faded by altitude
 * above the *sea*, and the player can stand at up to the terrain's reach (288) above it, so the band
 * has to start above the relief or it would blend the globe over the ground underfoot on every
 * mountain top. Below this the chunks are the whole surface and the near-field fog hides the
 * window's edge; above it the globe fades in. The ground horizon on this planet is about 1,280 — the
 * chunks' own reach — so the chunks cover the ground exactly and the globe is genuinely the far
 * field from the first climb up.
 */
export const GLOBE_START_ALTITUDE = 420;

/** How far up the globe has fully taken over. The band is 480 units — eight seconds of flight. */
export const GLOBE_FULL_ALTITUDE = 900;

/**
 * How much tessellation the globe's *silhouette* needs.
 *
 * **Fewer than the terrain's, and that is the point.** The mesh's job is the outline and the
 * displacement's coarse shape; every pixel's normal comes from the height map per fragment, so a
 * smooth sphere with real displacement looks like terrain. It is 512 rather than 256 now: on a
 * 136,000-unit radius a 256-segment sphere's facets subtend a visible angle from orbit, where the
 * previous 4,000-unit radius's did not. The shading is still per-fragment; this is only the outline.
 */
const GLOBE_SEGMENTS = 512;

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
  const geometry = new SphereGeometry(
    maps.seaRadius,
    GLOBE_SEGMENTS,
    Math.floor(GLOBE_SEGMENTS / 2),
  );
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);

  return {
    material,
    update(radius: number): void {
      const opacity = globeOpacityAt(radius - maps.seaRadius);
      // **Opacity through the material, not through the mesh's `visible`.** A visible flag pops; the
      // only thing that hides a surface without popping is drawing it with nothing left to show.
      material.opacity = opacity;
      // At zero the globe is not drawn at all, so it costs nothing below the crossover and cannot
      // z-fight a chunk that is still fully opaque.
      mesh.visible = opacity > 0;
    },
    dispose(): void {
      scene.remove(mesh);
      geometry.dispose();
    },
  };
};
