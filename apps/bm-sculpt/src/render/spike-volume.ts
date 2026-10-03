/**
 * A three-dimensional texture for the sampler3D spike.
 *
 * RMSL has no `Data3DTexture`: a volume is a `DataTexture` given a depth. That
 * is also where the one format constraint of this library shows up — there is no
 * `RedFormat` and no `R8`, so a volume costs four bytes a texel rather than one.
 * For the field this project will compute in workers and never store on the
 * GPU that costs nothing, and it is recorded here so the constraint is a
 * decision rather than a discovery if it is ever relied on.
 *
 * What the texels hold is chosen to make the addressing visible from outside.
 * The red channel is a sphere, so a surface passing through the volume shows a
 * sphere projected along whichever axis it is viewed from — which a two-
 * dimensional texture cannot do, and which is what distinguishes a bound
 * sampler3D from a bound sampler2D on the same data. The green and blue channels
 * carry the texel's own address, so a misaligned or wrongly-sized binding shows
 * as a colour ramp rather than as a shape that merely looks plausible.
 */

import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedIntegerFormat,
  RGBAFormat,
  UnsignedByteType,
} from "@random-mesh/rmsl/scene";

/** The volume's edge length in texels. */
export const VOLUME_RES = 16;

/** The radius of the sphere inside the volume, in texels from its centre. */
const SPHERE_RADIUS = VOLUME_RES * 0.36;

/**
 * Builds the volume: RGBA8, linear filtering, clamped on all three axes.
 *
 * Clamping rather than repeating matters for a volume sampled by a coordinate
 * derived from world position: with repeat, everything outside the volume wraps
 * to somewhere inside it and the surface appears to have copies of the sphere
 * through it. `wrapR` is the one a two-dimensional texture has no field for, and
 * its absence here would be the difference between the volume working and
 * working by accident.
 */
export const buildSpikeVolume = (): DataTexture => {
  const data = new Uint8Array(VOLUME_RES * VOLUME_RES * VOLUME_RES * 4);
  const centre = (VOLUME_RES - 1) / 2;

  for (let z = 0; z < VOLUME_RES; z++) {
    for (let y = 0; y < VOLUME_RES; y++) {
      for (let x = 0; x < VOLUME_RES; x++) {
        const at = (z * VOLUME_RES * VOLUME_RES + y * VOLUME_RES + x) * 4;
        const distance = Math.hypot(x - centre, y - centre, z - centre);
        // A falloff across the last texel of the radius rather than a hard edge,
        // so the sphere's silhouette is where it appears to be instead of one
        // texel inside it.
        const inside = Math.min(
          1,
          Math.max(0, (SPHERE_RADIUS - distance) / 1.5),
        );
        data[at] = Math.round(inside * 255);
        data[at + 1] = Math.round((x / (VOLUME_RES - 1)) * 255);
        data[at + 2] = Math.round((z / (VOLUME_RES - 1)) * 255);
        data[at + 3] = 255;
      }
    }
  }

  const texture = new DataTexture(
    data,
    VOLUME_RES,
    VOLUME_RES,
    VOLUME_RES,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  return texture;
};

/**
 * Formats this library can express a volume in, for the record. `RGBAFormat` is
 * the only floating-point one, and `RedIntegerFormat` is the only one that is
 * not four bytes wide — but it is an *integer* format, so it reads as a whole
 * number in a shader and there is no unfiltered floating-point single-channel
 * option to fall back to.
 */
export const VOLUME_FORMATS = {
  float: RGBAFormat,
  integer: RedIntegerFormat,
} as const;
