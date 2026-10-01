/**
 * Clouds: one high plane carrying a tileable noise texture, scrolled by time.
 *
 * A layer rather than a meshed volume, for the same reason water is a plane: it is
 * the cheap version that already reads correctly, and a volumetric cloud field
 * that the mesher can carve is a much larger change. The plane sits above any
 * terrain the mountains reach and follows the camera horizontally, so its edge is
 * never in view.
 *
 * The noise is baked once into a `DataTexture` and sampled by **world position**,
 * not by texture coordinate. That is what keeps a cloud planted over the ground
 * while the player walks: a plane that followed the eye and sampled by its own uv
 * would slide the whole sky sideways with every step.
 *
 * The texture is tileable by construction — a value-noise fBm whose every octave
 * wraps at its own period — so the world-anchored sampling has no seam where the
 * texture repeats.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { float, vec2, vec3, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  DataTexture,
  Mesh,
  NodeMaterial,
  PlaneGeometry,
  Scene,
  Side,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from "@random-mesh/rmsl/scene";

import type { Vec3 } from "../constants";

/** How high the cloud layer sits, above the tallest the mountains reach. */
export const CLOUD_ALTITUDE = 900;

/** World units one repeat of the cloud texture covers. */
export const CLOUD_FEATURE = 3000;

/** How far the layer reaches before it is snapped, past anything the eye resolves. */
const CLOUD_EXTENT = 100000;

/** The grid the layer's centre snaps to, so a wander does not shimmer it. */
const CLOUD_SNAP = 100;

/** How far the noise must rise before it reads as cloud. */
const CLOUD_COVERAGE = 0.52;

/** The softness of the edge, in noise units. */
const CLOUD_SOFTNESS = 0.22;

/** How fast the layer drifts, in texture repeats per second. */
const CLOUD_DRIFT = 0.004;

/** The texture's side and the noise cells across it. */
const TEXTURE_SIZE = 256;
const BASE_PERIOD = 8;
const OCTAVES = 4;

/** A small integer hash, returning 0..1. */
const hash2 = (ix: number, iy: number, seed: number): number => {
  let h =
    (Math.imul(ix, 374761393) ^
      Math.imul(iy, 668265263) ^
      Math.imul(seed, 2246822519)) >>>
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise that wraps every `period` cells, so a tiled fBm has no seam. */
const tileNoise = (
  x: number,
  y: number,
  period: number,
  seed: number,
): number => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (i: number, n: number): number => ((i % n) + n) % n;
  const x0 = wrap(xi, period);
  const x1 = wrap(xi + 1, period);
  const y0 = wrap(yi, period);
  const y1 = wrap(yi + 1, period);
  const v00 = hash2(x0, y0, seed);
  const v10 = hash2(x1, y0, seed);
  const v01 = hash2(x0, y1, seed);
  const v11 = hash2(x1, y1, seed);
  const sx = smooth(xf);
  const sy = smooth(yf);
  const top = v00 + (v10 - v00) * sx;
  const bottom = v01 + (v11 - v01) * sx;
  return top + (bottom - top) * sy;
};

/** Summed octaves, each wrapping at its own period, so the tile is seamless. */
const tileFbm = (x: number, y: number, seed: number): number => {
  let value = 0;
  let amplitude = 1;
  let total = 0;
  let period = BASE_PERIOD;
  let frequency = 1;
  for (let i = 0; i < OCTAVES; i++) {
    value +=
      amplitude *
      tileNoise(x * frequency, y * frequency, period, seed + i * 101);
    total += amplitude;
    amplitude *= 0.5;
    period *= 2;
    frequency *= 2;
  }
  return total === 0 ? 0 : value / total;
};

/** Bakes the tileable fBm into an RGBA texture, once. */
const bakeCloudTexture = (seed: number): DataTexture => {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      // Sampling the base period across the whole texture makes the wrap exact.
      const n = tileFbm(
        (x / TEXTURE_SIZE) * BASE_PERIOD,
        (y / TEXTURE_SIZE) * BASE_PERIOD,
        seed,
      );
      const value = Math.round(Math.min(1, Math.max(0, n)) * 255);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new DataTexture(
    data,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
};

/** A soft, drifting cloud layer: noise coverage thresholded into a white sheet. */
class CloudMaterial extends NodeMaterial {
  time = 0;
  private readonly scale: number;
  private sampler?: UniformNode<"sampler2D">;
  private timeUniform?: UniformNode<"float">;

  constructor(
    private readonly texture: DataTexture,
    feature: number,
  ) {
    super();
    this.transparent = true;
    this.side = Side.DoubleSide;
    this.depthWrite = false;
    this.scale = 1 / feature;
  }

  protected override setup(b: Builder): void {
    this.sampler = b.sampler("uClouds", () => this.texture);
    this.timeUniform = b.materialUniform("uTime", "float", () => this.time);
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const world = b.positionWorld;
    // World-anchored, so the sky does not slide when the player walks.
    const coords = vec2(
      world.x.mul(this.scale).add(this.timeUniform!.mul(CLOUD_DRIFT)),
      world.z.mul(this.scale),
    );
    const noise = this.sampler!.texture(coords).r.smoothstep(
      float(CLOUD_COVERAGE),
      float(CLOUD_COVERAGE + CLOUD_SOFTNESS),
    );
    const colour = vec3(0.92, 0.94, 0.98);
    return vec4(colour, noise.mul(float(0.85)));
  }
}

export interface Clouds {
  /** Drifts the layer and keeps it centred over the eye. */
  update(camera: Vec3, elapsed: number): void;
  dispose(): void;
}

export const createClouds = (
  scene: Scene,
  seed = 20260901,
  altitude: number = CLOUD_ALTITUDE,
): Clouds => {
  const texture = bakeCloudTexture(seed);
  const geometry = new PlaneGeometry(CLOUD_EXTENT, CLOUD_EXTENT, 1, 1);
  const material = new CloudMaterial(texture, CLOUD_FEATURE);
  const mesh = new Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = altitude;
  scene.add(mesh);

  return {
    update(camera, elapsed) {
      material.time = elapsed;
      mesh.position.x = Math.round(camera.x / CLOUD_SNAP) * CLOUD_SNAP;
      mesh.position.z = Math.round(camera.z / CLOUD_SNAP) * CLOUD_SNAP;
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      texture.dispose();
    },
  };
};
