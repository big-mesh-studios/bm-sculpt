/**
 * The planet as two triangles.
 *
 * ## What this is
 *
 * Streamed chunks cannot show a whole planet. Measured: at planet scale a cubic window spends most
 * of its budget on deep rock — most of any large volume of space near a planet is *inside* the
 * planet — so the reachable surface is bounded by the window no matter how much of it exists.
 *
 * Past the altitude where the streamed chunks stop resolving detail, this is cheaper *and* more
 * accurate than the chunks it replaces. The maps come from `bakePlanetMaps` in `@big-mesh/csg`,
 * which reads the same field the chunks do, so the sphere's silhouette is the terrain's and its
 * colour is the terrain's.
 *
 * ## The two things that make the swap invisible
 *
 * 1. **The same lighting and the same fog as the terrain**, term for term, from the same `SkyLight`,
 *    `Fog` and `PointLights`. A globe lit by its own sun and hazed by its own atmosphere is a second
 *    opinion about what the light is doing, and it disagrees at exactly one altitude: the one the
 *    player is watching.
 * 2. **The relief is real.** The height map displaces the mesh and is differentiated per fragment
 *    into a normal, so the mountains catch the low sun the way the chunked ones do.
 *
 * ## Why the normal comes from the map rather than from the mesh
 *
 * A displaced sphere's mesh normals are the normals of a coarse tessellation — at 256 segments the
 * facet is about a hundred units across, which is coarser than the mountains, so shading them
 * gives a faceted rock rather than a landscape. Differentiating the height map per fragment costs
 * two extra texture reads and a cross product, and gets the terrain's own slope.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import {
  atan,
  asin,
  cross,
  float,
  normalize,
  sqrt,
  vec2,
  vec3,
  vec4,
} from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  ClampToEdgeWrapping,
  DataTexture,
  NodeMaterial,
  RGBAFormat,
  RepeatWrapping,
  Texture,
  UnsignedByteType,
} from "@random-mesh/rmsl/scene";

import { Fog } from "./fog";
import { PointLightBindings, PointLights } from "./point-lights";
import { SkyLight } from "./sky-light";
import { waterFresnel, waterLook } from "./water-look";

/** The height map's byte range, as a float, so a sample reads as 0…1. */
const BYTE_TO_UNIT = 1 / 255;

export interface GlobeMaps {
  /** Terrain colour, `width × height × 4`. */
  readonly albedo: Uint8Array;
  /** Terrain height, `width × height`. */
  readonly height: Uint8Array;
  readonly width: number;
  readonly height_: number;
  /** Mean sea level: the field's nominal radius, and the middle of the relief band. */
  readonly seaRadius: number;
  /** The world radius the height map's full range spans. */
  readonly relief: number;
}

/**
 * A linear-filtered RGBA texture.
 *
 * **Wrapped in u and clamped in v, because the two axes are different.** An equirectangular map's
 * left and right edges meet at the antimeridian, so u wraps and the seam is continuous. Its top and
 * bottom rows are the poles, which do not continue anywhere, so v clamps.
 *
 * **No mipmaps.** The globe is drawn at exactly one distance — the one the swap happens at — and a
 * mip chain would be built once and never reused; asking for a mip level the sampler does not have
 * is the expensive way to find that out, so the globe is filtered and not mipped. The clouds volume,
 * which *is* drawn across a whole approach, is the opposite case and does want them.
 */
const textureOf = (
  data: Uint8Array,
  width: number,
  height: number,
): DataTexture => {
  const texture = new DataTexture(
    data,
    width,
    height,
    1,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  return texture;
};

/**
 * Builds the globe's two textures, **padding the height map's width by one texel**.
 *
 * The extra column repeats the first. The height map's edges meet at the antimeridian, and linear
 * filtering at the seam reads the two texels either side of it — which, in a wrapped texture, are
 * the *last* column and the *first*, both correct — but a clamped one reads the edge texel twice,
 * producing a one-texel crease down the middle of an ocean. The albedo map is a colour and the same
 * seam in a colour is invisible, so it is not padded.
 */
export const globeTextures = (
  maps: GlobeMaps,
): { albedo: DataTexture; height: DataTexture } => {
  // Height is a single channel sampled as RGBA, because a one-channel sampler format is a portability
  // question this renderer has not answered. Zero in G and B and opaque in A.
  const padded = new Uint8Array((maps.width + 1) * maps.height_ * 4);
  for (let y = 0; y < maps.height_; y++) {
    for (let x = 0; x <= maps.width; x++) {
      const source = maps.height[y * maps.width + (x % maps.width)]!;
      const at = (y * (maps.width + 1) + x) * 4;
      padded[at] = source;
      padded[at + 1] = source;
      padded[at + 2] = source;
      padded[at + 3] = 255;
    }
  }
  return {
    albedo: textureOf(maps.albedo, maps.width, maps.height_),
    height: textureOf(padded, maps.width + 1, maps.height_),
  };
};

/**
 * The equirectangular address of a direction. The exact inverse of `directionAtEquirect`.
 *
 * Exported so the cloud shell can wrap its weather map around the planet the same way the
 * globe wraps its albedo — one mapping for a sphere, not two that could disagree at a seam.
 */
export const equirectUV = (direction: Node<"vec3">): Node<"vec2"> =>
  vec2(
    atan(direction.x, direction.z)
      .div(Math.PI * 2)
      .add(float(0.5)),
    asin(direction.y).div(Math.PI).negate().add(float(0.5)),
  );

export class GlobeMaterial extends NodeMaterial {
  constructor() {
    super();
    /** Because the fade is real: without this the alpha is written and nothing blends it. */
    this.transparent = true;
    /**
     * **No depth write, for the water's and the clouds' reason.** The globe is a coarser copy of the
     * very surface the chunks draw, so its depth is all but identical to theirs; writing it would
     * fight them for the same pixel. Not writing lets the globe blend over the terrain it replaces
     * and lets the sea and the clouds — which are added after it precisely so they land on top —
     * show through it.
     */
    this.depthWrite = false;
  }

  /** The bindings the whole sky shares, and the fog. Assigned once a frame, like every surface. */
  readonly sky = new SkyLight();
  readonly fog = new Fog();
  readonly lights = new PointLights();

  private albedoTexture?: Texture;
  private heightTexture?: Texture;
  private albedoSampler?: UniformNode<"sampler2D">;
  private heightSampler?: UniformNode<"sampler2D">;
  private reliefUniform?: UniformNode<"float">;
  private seaRadiusUniform?: UniformNode<"float">;
  private texelUniform?: UniformNode<"vec2">;
  private lightBindings?: PointLightBindings;

  /** The maps, and with them the radius and relief the displacement is measured against. */
  private maps?: GlobeMaps;

  /** How much of the field's own relief to raise, in world units per unit of map height. */
  reliefScale = 1;

  /**
   * How much of the globe to show, 0 to 1.
   *
   * **A field rather than `material.opacity`, because rmsl's alpha hook is a node.** `opacityNode`
   * takes a `Node`, so the fade is a uniform the frame loop writes and the shader multiplies — which
   * means the blend is part of the material's own alpha rather than a second drawing pass, and
   * changing it cannot trigger a recompile. Setting `transparent` once, in the constructor, is what
   * makes the blend happen at all.
   */
  override opacity = 0;

  private opacityUniform?: UniformNode<"float">;

  setMaps(
    textures: { albedo: Texture; height: Texture },
    maps: GlobeMaps,
  ): void {
    this.albedoTexture = textures.albedo;
    this.heightTexture = textures.height;
    this.maps = maps;
  }

  protected override setup(
    b: Builder,
    scene: Parameters<NodeMaterial["setup"]>[1],
  ): void {
    void scene;
    this.sky.declare(b);
    this.fog.declare(b);
    this.lightBindings = this.lights.declare(b);

    const maps = this.maps;
    if (maps === undefined)
      throw new Error("GlobeMaterial.setMaps before setup");
    this.reliefUniform = b.materialUniform(
      "uRelief",
      "float",
      () => maps.relief * this.reliefScale,
    );
    this.seaRadiusUniform = b.materialUniform(
      "uSeaRadius",
      "float",
      () => maps.seaRadius,
    );
    // The padded map is one texel wider, so the gradient step is over the *unpadded* texel.
    this.texelUniform = b.materialUniform("uTexel", "vec2", () => [
      1 / maps.width,
      1 / maps.height_,
    ]);
    this.opacityUniform = b.materialUniform(
      "uGlobeOpacity",
      "float",
      () => this.opacity,
    );
    this.albedoSampler = b.sampler(
      "uGlobeAlbedo",
      "sampler2D",
      () => this.albedoTexture ?? null,
    );
    this.heightSampler = b.sampler(
      "uGlobeHeight",
      "sampler2D",
      () => this.heightTexture ?? null,
    );
  }

  /**
   * Where the vertex's height says the surface is, pushed out along the sphere's own normal.
   *
   * **Displacement in the vertex stage and a normal rebuilt per fragment**, rather than displacing
   * and interpolating the displaced normal. Interpolating a normal across a triangle whose three
   * corners have very different heights gives a normal that belongs to none of them; sampling the
   * height map per fragment gives the terrain's own slope at the pixel. The mesh then only has to be
   * dense enough that its silhouette is right, not that its shading is.
   */
  protected override buildVertexBody(b: Builder): Node<"vec4"> {
    // **The sphere's `position` attribute, not `positionWorld`.** The latter is the varying this
    // stage is about to write, so reading it here reads an uninitialised output: the compiled vertex
    // shader normalises its own `out` before assigning it, and the globe collapses to whatever the
    // driver left in that register. The attribute is the undisplaced sphere, which is exactly the
    // direction the displacement is measured along.
    const direction = normalize(b.position);
    const unit = this.heightUnitAt(b, direction);
    // **The map's zero is the field's *lowest* radius, not the sea.** The bake encodes
    // `(radius - lowestRadius) / relief`, so decoding starts at `lowestRadius`; `uSeaRadius` is mean
    // sea level, which sits in the middle of the relief band. The field's reach is symmetric — it is
    // `radius ± reach` — so `lowestRadius` is exactly `seaRadius - relief/2`. Measuring from sea
    // level instead would float the entire globe half a relief above its own terrain, which is the
    // one artefact the swap cannot hide.
    const relief = this.reliefUniform!;
    const baseline = this.seaRadiusUniform!.sub(relief.mul(0.5));
    const world = direction.mul(baseline.add(unit.mul(relief)));
    b.positionWorld.assign(world);
    return b.projectionMatrix.mul(b.viewMatrix.mul(vec4(world, float(1))));
  }

  /**
   * The height map's sample at a direction, as 0…1 of the field's relief.
   *
   * The equirectangular inverse, stated once and used by both stages: the bake walks texels and the
   * shader walks directions, so this and `directionAtEquirect` are a matched pair. `uTexel` scales u
   * to the padded map's width, which is one texel wider than the unwrapped map.
   */
  private heightUnitAt(b: Builder, direction: Node<"vec3">): Node<"float"> {
    return this.sampleHeight(b, equirectUV(direction)).mul(BYTE_TO_UNIT);
  }

  /** One bilinear read of the height map's red channel. */
  private sampleHeight(_b: Builder, uv: Node<"vec2">): Node<"float"> {
    return this.heightSampler!.texture(uv).x;
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const direction = normalize(b.positionWorld);
    const uv = equirectUV(direction);

    const albedo = this.albedoSampler!.texture(uv).xyz;
    const relief = this.reliefUniform!;
    const seaRadius = this.seaRadiusUniform!;

    // **The normal, from the terrain's own slope.**
    //
    // Two neighbours along the surface, differenced, then the height's rate of change turned into a
    // tilt about each tangent. `north` is the pole's degenerate case and the `max` is what keeps the
    // east step from dividing by a cosine that has gone to zero: without it the planet's polar
    // regions shade to noise.
    const here = this.sampleHeight(b, uv);
    const east = this.sampleHeight(
      b,
      uv.add(vec2(this.texelUniform!.x, float(0))),
    );
    const north = this.sampleHeight(
      b,
      uv.add(vec2(float(0), this.texelUniform!.y)),
    );

    // World length of one texel step in each direction. East shrinks towards the poles with the
    // cosine of the latitude; north does not, because the map's rows are evenly spaced in latitude.
    const cosLat = sqrt(
      float(1).sub(direction.y.mul(direction.y)).max(float(1e-4)),
    );
    const eastStep = float(2 * Math.PI)
      .mul(seaRadius)
      .mul(cosLat)
      .mul(this.texelUniform!.x);
    const northStep = float(Math.PI).mul(seaRadius).mul(this.texelUniform!.y);

    const slopeEast = east.sub(here).mul(relief).div(eastStep);
    const slopeNorth = north.sub(here).mul(relief).div(northStep);

    // The sphere's east and north at this point, built from the normal rather than from a fixed
    // frame so the pair rotates with the surface instead of degenerating at one longitude.
    const up = direction;
    const tangentEast = normalize(
      cross(vec3(float(0), float(1), float(0)), up),
    );
    const tangentNorth = cross(up, tangentEast);

    const normal = normalize(
      up.sub(tangentEast.mul(slopeEast)).sub(tangentNorth.mul(slopeNorth)),
    );

    const lighting = this.sky.ambient
      .add(this.sky.sunLight.mul(this.sky.sunOn(normal)))
      .add(this.sky.moonLight.mul(this.sky.moonOn(normal)))
      .add(this.lightBindings!.contribution(b.positionWorld, normal));

    // **The ocean, from the height map's own zero.**
    //
    // The map's zero is the field's *lowest* radius, not the sea — see the vertex stage — so
    // the radius this texel describes is rebuilt here the same way and compared against mean
    // sea level. Everything below that is water, and it is the same `waterLook` the near sea's
    // material uses, which is the whole reason the two agree where the swap happens.
    const radius = seaRadius.sub(relief.mul(0.5)).add(here.mul(relief));
    const depth = seaRadius.sub(radius).max(float(0)).div(relief);
    const { colour: waterColour } = waterLook(
      this.sky.skyColour,
      waterFresnel(normal, b.viewDirection.normalize()),
    );

    // **Shallow water shows its bottom; deep water does not**, and the mix is the depth
    // against the reflection. A planet seen from orbit has no blend against a sea behind it,
    // so the near sea's translucent pass has no equivalent here — this is where the two
    // genuinely differ, and it is why the far sea takes a depth the near one does not.
    //
    // **Twice the depth, so the deepest water is fully water.** The reach is half the relief and
    // the sea sits in the middle of it, so `depth` runs to `0.5` and not to `1` — a factor below two
    // leaves the deepest ocean a few percent of seabed showing through, which from orbit reads as
    // pale patches in the middle of the sea rather than as anything meaningful.
    //
    // **And the square root, so a coastline is a gradient rather than a line.** A linear mix puts
    // deep blue within a texel of the shore, which from orbit reads as a drawn outline around every
    // continent. The root spreads the shallow band out over the first few hundred units, which is
    // where the real colour change is.
    const submerged = depth
      .mul(float(2))
      .clamp(float(0), float(1))
      .pow(float(0.5));
    const surface = albedo
      .mul(lighting)
      .clamp(vec3(0, 0, 0), vec3(1, 1, 1))
      .mix(waterColour, submerged);

    return vec4(this.fog.apply(b, surface), this.opacityUniform!);
  }
}
