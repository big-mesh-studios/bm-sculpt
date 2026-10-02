/**
 * Turning a baked cloud field into the two textures the ray-march samples.
 *
 * Separate from `cloud-field.ts`, which knows nothing about the renderer, and from
 * `clouds.ts`, which knows nothing about where the bytes came from. The only thing
 * here is the wrapping, and the wrapping is load-bearing rather than incidental:
 * both fields are periodic by construction and only tile if the sampler repeats.
 */

import {
  DataTexture,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from "@random-mesh/rmsl/scene";

import type { PackedField } from "./cloud-field";

/**
 * Uploads a packed field, repeating on every axis.
 *
 * `wrapR` as well as the other two because the shape field is a volume and its third
 * axis tiles exactly as its other two do — a volume that repeats on two axes and
 * clamps on the third has a seam that the weather map's domain warp drags around the
 * sky for the rest of the session.
 */
const upload = (field: PackedField, name: string): DataTexture => {
  const texture = new DataTexture(
    field.data,
    field.size,
    field.size,
    field.depth,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.name = name;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  // Filtering is left at rmsl's default of `LinearFilter` and it has to stay there:
  // the mipmapped filters are accepted and treated as their base filter, because no
  // renderer in this library builds a mip chain. What protects the horizon from the
  // resulting aliasing is the march's distance-scaled steps and the weather map's
  // low frequency, not a sampler setting.
  texture.needsUpdate = true;
  return texture;
};

/** The shape volume: `sampler3D`, red is the base shape and the rest are detail. */
export const shapeTexture = (field: PackedField): DataTexture =>
  upload(field, "uShape");

/** The weather map: `sampler2D`, coverage, a divergence-free warp, and a streak. */
export const weatherTexture = (field: PackedField): DataTexture =>
  upload(field, "uWeather");
