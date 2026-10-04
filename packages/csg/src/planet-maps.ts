/**
 * The planet as two maps, baked once from the field that draws it.
 *
 * ## What this is for
 *
 * Streaming chunks cannot show a whole planet. Measured: a cubic window spends about 96% of its
 * budget on deep rock at planet scale, because most of any large volume of space near a planet is
 * inside the planet — so the surface reachable is bounded by the streaming window no matter how much
 * of it there is.
 *
 * A textured sphere has no such problem. It is two triangles, and past the distance where the
 * streamed chunks stop resolving detail, a sphere carrying the same field is both cheaper *and*
 * more accurate than the chunks it replaces. So above a height, the world is this.
 *
 * ## Why the maps are equirectangular, and why that is not a compromise
 *
 * An equirectangular map distorts: the poles get `1/cos(lat)` of the area they should. For a
 * texture on a sphere that is exactly what you want, because the sphere's own triangles are smaller
 * at the poles for the same reason. The distortion of the map and the distortion of the geometry
 * cancel, and a cube-face map — which would need a seam and an atlas — does not.
 *
 * The mapping is stated once, here, and the shader inverts it:
 *
 *     u → longitude   lon = (u − ½)·2π
 *     v → latitude    lat = (½ − v)·π        so v = 0 is the north pole
 *     direction       (cos lat · sin lon,  sin lat,  cos lat · cos lon)
 *
 * ## What is and is not in the maps
 *
 * **The height map is the field's own radius**, so the sphere's silhouette has real mountains and
 * real valleys, and its radius is not a constant that quietly disagrees with a chunk you can still
 * see. **The albedo is the same `colourAt` the terrain chunks use**, built from the same field, so
 * the two agree by construction rather than by my having remembered to match them.
 *
 * That means the globe is as colourless as the terrain is — grey, unless something has been painted
 * onto it — which is the correct answer rather than a disappointing one. Colouring the terrain is a
 * separate decision, and it has to be made in the terrain's own material or the swap becomes
 * visible; see the note on `albedo` in the returned maps.
 */

import type { PlanetParams } from "./planet";
import { planetField } from "./planet";
import type { Rgb8, Vec3 } from "@big-mesh-studios/core";

/** The direction an equirectangular texel names. The inverse of what the globe shader does. */
export const directionAtEquirect = (u: number, v: number): Vec3 => {
  const lon = (u - 0.5) * Math.PI * 2;
  const lat = (0.5 - v) * Math.PI;
  const cos = Math.cos(lat);
  return { x: cos * Math.sin(lon), y: Math.sin(lat), z: cos * Math.cos(lon) };
};

/** The equirectangular texel a direction names. The forward map the bake walks. */
export const equirectAtDirection = (d: Vec3): readonly [number, number] => {
  const lon = Math.atan2(d.x, d.z);
  const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
  return [0.5 + lon / (Math.PI * 2), 0.5 - lat / Math.PI];
};

export interface PlanetMaps {
  /** Terrain colour, `width × height × 4`, RGBA. */
  readonly albedo: Uint8Array;
  /**
   * Terrain height, `width × height`, one byte per texel.
   *
   * **Eight bits over the planet's whole declared relief**, which is about 576 units on the default
   * planet, so a step is roughly two and a quarter units. That is far below what a displacement can
   * show at orbital distance and it is what makes the map a byte rather than a float, which halves
   * the transfer and lets it be filtered and mipmapped by the sampler for free.
   */
  readonly height: Uint8Array;
  readonly width: number;
  readonly height_: number;
  /**
   * Mean sea level: the field's nominal radius.
   *
   * **Not the baseline a height of zero means.** The bytes are encoded over
   * `lowestRadius..highestRadius`, which the field lays symmetrically about this value, so a
   * decoder starts from `seaRadius - relief/2`. This is named for the sea because that is what
   * callers use it for — measuring altitude — not as the displacement's origin.
   */
  readonly seaRadius: number;
  /** The world radius the height map's full range spans. */
  readonly relief: number;
}

/** Where the colour comes from, so the caller supplies the same source the chunks use. */
export interface PlanetMapSource {
  /** The field's colour at a point on the surface. */
  readonly colourAt: (
    x: number,
    y: number,
    z: number,
  ) => { colour: Rgb8; opacity: number };
}

/**
 * Bakes the two maps.
 *
 * **Iterated by column, not by texel, because the access pattern matters more than the arithmetic.**
 * A texel-major walk steps `radiusAt` across a row of longitudes at one latitude, and the noise is
 * three-dimensional, so consecutive samples are as far apart in the third axis as they are in the
 * first. Latitudes are nearly independent, so a column walk gets most of the cache for free. The
 * arithmetic is identical either way.
 */
export const bakePlanetMaps = (
  params: PlanetParams,
  colour: PlanetMapSource,
  width = 1024,
  height = 512,
): PlanetMaps => {
  const field = planetField(params);
  const relief = field.highestRadius - field.lowestRadius;
  const lowest = field.lowestRadius;

  const albedo = new Uint8Array(width * height * 4);
  const heights = new Uint8Array(width * height);

  const u = new Float64Array(width);
  const v = new Float64Array(height);
  for (let x = 0; x < width; x++) u[x] = (x + 0.5) / width;
  for (let y = 0; y < height; y++) v[y] = (y + 0.5) / height;

  const direction = { x: 0, y: 0, z: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = directionAtEquirect(u[x]!, v[y]!);
      direction.x = d.x;
      direction.y = d.y;
      direction.z = d.z;
      const radius = field.radiusAt(d);

      const index = y * width + x;
      heights[index] = Math.max(
        0,
        Math.min(255, Math.round(((radius - lowest) / relief) * 255)),
      );

      const c = colour.colourAt(d.x * radius, d.y * radius, d.z * radius);
      const at = index * 4;
      albedo[at] = c.colour.r;
      albedo[at + 1] = c.colour.g;
      albedo[at + 2] = c.colour.b;
      albedo[at + 3] = Math.round(c.opacity * 255);
    }
  }

  return {
    albedo,
    height: heights,
    width,
    height_: height,
    seaRadius: params.radius,
    relief,
  };
};
