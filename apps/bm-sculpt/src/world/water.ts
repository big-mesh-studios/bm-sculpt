/**
 * Water: one sea, drawn translucent.
 *
 * ## A plane or a sphere, named by the caller
 *
 * **The shape is a property of the world, not of this file**, so `createWater` takes a
 * discriminated union mirroring `BaseFieldSpec`: a flat world gets a plane at an altitude, a
 * spherical one gets a sphere of the sea's radius. There is no mode flag and no "if the radius is
 * positive" — a world that is a sphere has a sea that is a sphere, and the two cannot be confused.
 *
 * ## Why a sphere is coarse and still smooth
 *
 * **The shading normal is computed in the fragment shader, from the sphere's centre, rather than
 * read from the vertex.** A sea sphere tessellated finely enough to avoid faceting outright would
 * need thousands of segments at this planet's radius — hundreds of thousands of triangles for a
 * surface with no texture, no waves and no geometry. Computed analytically, the *shading* is smooth
 * at any tessellation, so only the silhouette is faceted, and the silhouette is only ever seen
 * against the sky from far enough away that a facet subtends a fraction of a degree.
 *
 * This is the same argument the sky dome makes for carrying only a direction, and the same reason
 * the clouds march rather than mesh.
 *
 * ## What the plane still is
 *
 * **The flat world's sea keeps the old plane, snapping and all.** It is two triangles, it costs
 * nothing, and the snap is what stops it shimmering as the eye moves a fraction of a unit. A sphere
 * needs none of that: it is already centred on the planet and it does not shimmer, because there
 * is nothing about it that moves.
 */

import type { Node } from "@random-mesh/rmsl";
import { float, normalize, vec3, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  Mesh,
  NodeMaterial,
  Scene,
  Side,
  SphereGeometry,
} from "@random-mesh/rmsl/scene";

import type { Vec3 } from "@big-mesh-studios/core";
import { DEFAULT_PLANET, DEFAULT_TERRAIN } from "@big-mesh-studios/csg";
import { Fog } from "../render/fog";
import { PointLights, type PointLightBindings } from "../render/point-lights";
import { SkyLight } from "../render/sky-light";

/** The world y water settles at on a flat one: the terrain's own zero, so half the land is dry. */
export const SEA_LEVEL = DEFAULT_TERRAIN.origin;

/**
 * The radius water settles at on a spherical one: **the planet's own radius.**
 *
 * **And the equality is the point, not a coincidence.** `origin` on a height field is "the world y
 * a height of zero sits at", so a sea at `origin` covers exactly where the base noise is negative.
 * On a sphere there is no height of zero — `radiusAt` is `radius + scale · shape`, and `shape` is
 * zero at the radius, so the sea goes at `radius`. Adding `origin` to it, which is the obvious
 * translation, puts the sea *below* the lowest land on a default planet and yields a world that is
 * entirely dry: measured, the surface spans 3979 to 4181 and `4000 − 70 = 3930` is beneath all of
 * it.
 */
export const DEFAULT_SEA_RADIUS = DEFAULT_PLANET.radius;

/**
 * Segments around and up a sea sphere.
 *
 * **Chosen by what the silhouette has to look like, not by the shading.** The shading normal is
 * computed per pixel, so the tessellation only affects the horizon line, and the horizon is seen
 * from thousands of units away. At this count a facet is about three thousand units on the
 * 136,000-unit sphere, which is a fraction of a degree at the distance the limb is seen from —
 * around the size of a pixel at the field of view this project uses.
 */
const SPHERE_SEGMENTS = 256;

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
class WaterMaterial extends NodeMaterial {
  /** The day this reflects, and what it fades into at distance. */
  readonly sky = new SkyLight();

  /** The fog. Its colour is the sky's horizon colour, which is what it reflects too. */
  readonly fog = new Fog();

  /** The lights a place has made. Its own instance, like `sky` — see `render/point-lights.ts`. */
  readonly lights = new PointLights();

  private lightBindings?: PointLightBindings;

  constructor() {
    super();
    this.transparent = true;
    // Both sides, because the player swims under it: from below, the surface
    // should still be there.
    this.side = Side.DoubleSide;
    // Transparent and not depth-writing, so terrain below it is drawn first and
    // shows through, and water does not fight the terrain for the same depth.
    this.depthWrite = false;
  }

  protected override setup(b: Builder, _scene: Scene): void {
    this.sky.declare(b);
    this.fog.declare(b);
    this.lightBindings = this.lights.declare(b);
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    // **Analytically for a sphere, from the geometry for a plane.** See the file header: this is
    // the whole reason the sea sphere can be coarse.
    //
    // The centre is the origin rather than a uniform, because the planet's centre is the origin —
    // it is also the chunk lattice's, and ADR 0036 is why. A uniform for a constant would be a
    // value that could be set wrong by nothing.
    const normal = normalize(vec3(b.positionWorld));
    const view = b.viewDirection.normalize();
    // Grazing angles are water; the view straight down is depth.
    const facing = normal.dot(view).abs();
    const fresnel = float(0.05).add(
      float(0.95).mul(float(1).sub(facing).pow(float(3))),
    );
    const deep = vec3(0.05, 0.22, 0.4);
    const rgb = deep
      .mix(this.sky.skyColour, fresnel)
      // **The water's own colour, lifted by the light falling on it.** Before the fog and after
      // the Fresnel mix, so a lantern at the waterline brightens the water rather than the
      // reflection of the sky — and the normal passed is the surface's own, so a wave facing away
      // from the lantern does not pick it up.
      .add(this.lightBindings!.contribution(b.positionWorld, normal));

    // Fogged, and the fog colour is the same sky it reflects — so the sea's far edge and the sky
    // behind it are the same colour and the sea has no edge.
    const faded = this.fog.apply(b, rgb);
    const alpha = fresnel.add(float(0.55)).clamp(float(0), float(1));
    return vec4(faded, alpha);
  }
}

export interface Water {
  /**
   * Keeps a flat sea centred on the eye, so its edge is always out of sight.
   *
   * **A no-op for a sphere**, and that is not laziness: a sphere is already centred on the planet
   * and it does not shimmer, because there is nothing about it that moves with the eye. Snapping
   * one would be the one thing that could make it swim.
   */
  update(camera: Vec3): void;
  /** The material, so a caller can push the day's lighting at it. */
  readonly material: WaterMaterial;
  /**
   * The mesh, so its draw order can be fixed against the globe's.
   *
   * rmsl has no render-order key — draw order is scene traversal order — and the globe is added
   * after the sea and writes no depth, so without moving the sea behind the globe the globe would
   * paint over the ocean. There is no way to reorder without the object.
   */
  readonly mesh: Mesh;
  dispose(): void;
}

/**
 * Builds the sea: the inside of a sphere at `radius` from the planet's centre.
 *
 * **One shape, because there is one world.** This used to take a `SeaSpec` and build either a plane
 * at a world altitude or a sphere at a radius, chosen by a `?flat` flag in the application. The flat
 * world is gone, so the plane is gone with it — along with its snapping, which existed because a
 * small plane has to follow the camera and a large one is too expensive, and which a centred sphere
 * has no use for. The `curved` flag on the material went with it for the same reason: every sea this
 * project can now build is curved, so the material shades from the sphere's centre unconditionally.
 */
export const createWater = (scene: Scene, radius: number): Water => {
  const geometry = new SphereGeometry(
    radius,
    SPHERE_SEGMENTS,
    Math.floor(SPHERE_SEGMENTS / 2),
  );
  const material = new WaterMaterial();
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  return {
    material,
    mesh,
    /** Nothing to do: the sphere is already centred on the planet. */
    update() {},
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
    },
  };
};
