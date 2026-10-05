/**
 * Water: the sea's surface, meshed per chunk and drawn translucent.
 *
 * ## What this file is, now that it is not a sphere
 *
 * **A material and nothing else.** The sea was a 256-segment `SphereGeometry` at the
 * planet's radius, and the shape of that sphere — not the shape of the ground — decided
 * where water was: it is everywhere below the radius, and the only reason a hole in the
 * ground did not show it was that the rock around the hole happened to be in front of it.
 * Dig a shaft down through a hill, cross the radius inside the rock, and the shaft filled
 * with water to the bottom. That sphere is gone. `mesh/water-mesher.ts` now meshes the
 * sea per chunk from the landscape's own field, and this file is what draws the result.
 *
 * ## Why the normal is still computed rather than read
 *
 * **From the sphere's centre, per fragment, and not from the vertex.** The sea's surface
 * is a sphere of `seaLevel` by construction, so its true normal at a point is the
 * direction from the planet's centre — and computing it that way makes the *shading* exact
 * at any tessellation, which is what lets the mesh be as coarse as its chunk's samples are.
 * The chunk mesh carries normals because the vertex layout is shared with the ground's and
 * `ChunkMeshBuilder` will not take a vertex without one; nothing reads them.
 *
 * The same argument the sphere made for carrying only a direction, and it survives the
 * sphere's deletion because what it argued was never about the sphere.
 *
 * ## One material for every water mesh
 *
 * **Not one per chunk.** The day's light, the fog and a place's lights are written into a
 * material once a frame; a second instance would be a second thing to remember to write to,
 * and there is nothing per-chunk here that would justify one. The store's sea group holds
 * every water mesh and draws them in one pass through this.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { normalize, vec3, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import { NodeMaterial, Side } from "@random-mesh/rmsl/scene";

import { Fog } from "../render/fog";
import { PointLights, type PointLightBindings } from "../render/point-lights";
import { SkyLight } from "../render/sky-light";
import { waterFresnel, waterLook } from "../render/water-look";

/**
 * Which way up a world's water surface faces.
 *
 * **A field rather than a branch on `positionWorld`.** A planet's sea is a sphere about the
 * origin and its normal is the radial direction; a height field's is `+Y` everywhere, and
 * radial-from-origin would point sideways at one end of the world and backwards at the
 * other. One of the two worlds cannot be shaded by the other's rule, and which one this is
 * is a property of the landscape rather than of anything drawing it.
 */
export interface WaterShape {
  /** The surface's outward normal at a world point, per fragment. */
  readonly normalAt: (b: Builder) => Node<"vec3">;
}

/**
 * A sea on a planet: its normal points away from the centre, which is the origin.
 *
 * **The centre rather than a uniform, because the planet's centre is the origin** — it is
 * also the chunk lattice's, and ADR 0036 is why. A uniform for a constant would be a value
 * that could be set wrong by nothing.
 */
export const sphericalWater: WaterShape = {
  normalAt: (b) => normalize(vec3(b.positionWorld)),
};

/** A sea on a height field: its normal is world up, at every point. */
export const flatWater: WaterShape = {
  normalAt: () => vec3(0, 1, 0),
};

/**
 * A translucent water surface: a Fresnel mix from deep water toward the sky at
 * grazing angles, so looking down reads as depth and looking out reads as a horizon.
 *
 * The sky it reflects is the day's, and it is fogged like everything else. Both were
 * hardcoded — the sky was a literal blue duplicated from the viewport's clear colour,
 * which is the kind of duplication that survives until the clear colour changes at dusk
 * and the sea does not.
 *
 * It takes a place's lights, because the sea is a surface a person looks at: a lantern on
 * the shore with no reflection in the water in front of it is the most obviously wrong
 * thing a lit world can do. The clouds and the sky deliberately do **not**, and the reasons
 * are in ADR 0023 — the short version being that a cloud is marched through rather than lit
 * at a surface, and the sky has no surface at all.
 */
export class WaterMaterial extends NodeMaterial {
  /** The day this reflects, and what it fades into at distance. */
  readonly sky = new SkyLight();

  /** The fog. Its colour is the sky's horizon colour, which is what it reflects too. */
  readonly fog = new Fog();

  /** The lights a place has made. Its own instance, like `sky` — see `render/point-lights.ts`. */
  readonly lights = new PointLights();

  private lightBindings?: PointLightBindings;
  private opacityUniform?: UniformNode<"float">;

  /**
   * How much of the sea to show, 0 to 1.
   *
   * **A field multiplied into the alpha rather than `material.opacity`, because rmsl's alpha
   * hook is a node.** Same arrangement and same reason as `GlobeMaterial.opacity`: changing
   * this cannot trigger a recompile, and the blend is part of the material's own alpha rather
   * than a second drawing pass.
   *
   * One at all times today. It exists because the sea has to be able to come and go — the
   * ocean is what the globe's own ocean fades in over, and this is the half of that a chunk
   * could fade if the two ever needed to cross rather than hand over.
   */
  override opacity = 1;

  /**
   * @param shape which way this world's sea faces. See `WaterShape`.
   */
  constructor(private readonly shape: WaterShape = sphericalWater) {
    super();
    this.transparent = true;
    // Both sides, because the player swims under it: from below, the surface
    // should still be there.
    this.side = Side.DoubleSide;
    // Transparent and not depth-writing, so terrain below it is drawn first and
    // shows through, and water does not fight the terrain for the same depth.
    this.depthWrite = false;
  }

  protected override setup(b: Builder): void {
    this.sky.declare(b);
    this.fog.declare(b);
    this.lightBindings = this.lights.declare(b);
    this.opacityUniform = b.materialUniform(
      "uWaterOpacity",
      "float",
      () => this.opacity,
    );
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const normal = this.shape.normalAt(b);
    const view = b.viewDirection.normalize();
    const { colour, alpha } = waterLook(
      this.sky.skyColour,
      waterFresnel(normal, view),
    );

    const rgb = colour
      // **The water's own colour, lifted by the light falling on it.** Before the fog and
      // after the Fresnel mix, so a lantern at the waterline brightens the water rather
      // than the reflection of the sky — and the normal passed is the surface's own, so a
      // wave facing away from the lantern does not pick it up.
      .add(this.lightBindings!.contribution(b.positionWorld, normal));

    // Fogged, and the fog colour is the same sky it reflects — so the sea's far edge and the
    // sky behind it are the same colour and the sea has no edge.
    const faded = this.fog.apply(b, rgb);
    return vec4(faded, alpha.mul(this.opacityUniform!));
  }
}

/**
 * The sea's material for a world.
 *
 * **A factory rather than a shared singleton**, because the shape is the world's and two
 * worlds with two shapes cannot share one material. Nothing else about the material varies,
 * so a caller makes one and hands it to everything that draws water: the chunk store for
 * the near sea, and — when there is a globe — nothing else, because the globe draws its own
 * ocean through `render/water-look.ts`.
 */
export const createWaterMaterial = (
  shape: WaterShape = sphericalWater,
): WaterMaterial => new WaterMaterial(shape);
