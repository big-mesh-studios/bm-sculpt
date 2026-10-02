/**
 * Water: one sea-level plane, drawn translucent.
 *
 * A plane rather than a meshed volume, deliberately for the first version. The
 * world being carved is a height field, so a flat surface at one level already
 * reads correctly as a lake or a coast — terrain above the level occludes the
 * plane and terrain below shows it — and it costs no meshing and no worker time.
 * A water *volume* that respects a dug shaft is a later change with a real cost,
 * and this is the cheap ninety percent of it.
 *
 * The plane follows the camera horizontally so its edge is always past the fog,
 * and it is snapped to a coarse grid so the surface does not shimmer as the eye
 * moves a fraction of a unit.
 */

import type { Node } from "@random-mesh/rmsl";
import { float, vec3, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  Mesh,
  NodeMaterial,
  PlaneGeometry,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";

import { DEFAULT_TERRAIN } from "../csg";
import type { Vec3 } from "../constants";
import { Fog } from "../render/fog";
import { SkyLight } from "../render/sky-light";

/** The world y water settles at — the terrain's own zero, so half the land is dry. */
export const SEA_LEVEL = DEFAULT_TERRAIN.origin;

/** How far the plane reaches before it is snapped: past anything the eye resolves. */
const WATER_EXTENT = 100000;

/** The grid the plane's centre snaps to, so it does not shimmer while walking. */
const WATER_SNAP = 100;

/**
 * A translucent water surface: a Fresnel mix from deep water toward the sky at
 * grazing angles, so looking down reads as depth and looking out reads as a horizon.
 *
 * The sky it reflects is the day's, and it is fogged like everything else. Both were
 * hardcoded — the sky was a literal blue duplicated from the viewport's clear colour,
 * which is the kind of duplication that survives until the clear colour changes at dusk
 * and the sea does not.
 */
class WaterMaterial extends NodeMaterial {
  /** The day this reflects, and what it fades into at distance. */
  readonly sky = new SkyLight();

  /** The fog. Its colour is the sky's horizon colour, which is what it reflects too. */
  readonly fog = new Fog();

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
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const normal = b.normalWorld.normalize();
    const view = b.viewDirection.normalize();
    // Grazing angles are water; the view straight down is depth.
    const facing = normal.dot(view).abs();
    const fresnel = float(0.05).add(
      float(0.95).mul(float(1).sub(facing).pow(float(3))),
    );
    const deep = vec3(0.05, 0.22, 0.4);
    const rgb = deep.mix(this.sky.skyColour, fresnel);

    // Fogged, and the fog colour is the same sky it reflects — so the plane's far edge
    // and the sky behind it are the same colour and the sea has no edge. The plane runs
    // to a hundred thousand units and the fog closes by twelve hundred and eighty, so
    // there is nothing to see of it past that.
    const faded = this.fog.apply(b, rgb);
    const alpha = fresnel.add(float(0.55)).clamp(float(0), float(1));
    return vec4(faded, alpha);
  }
}

export interface Water {
  /** Keeps the plane centred on the eye, so its edge is always out of sight. */
  update(camera: Vec3): void;
  /** The material, so a caller can push the day's lighting at it. */
  readonly material: WaterMaterial;
  dispose(): void;
}

export const createWater = (
  scene: Scene,
  seaLevel: number = SEA_LEVEL,
): Water => {
  const geometry = new PlaneGeometry(WATER_EXTENT, WATER_EXTENT, 1, 1);
  const material = new WaterMaterial();
  const mesh = new Mesh(geometry, material);
  // A plane is born in the XY plane; lay it flat and lift it to the sea level.
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = seaLevel;
  scene.add(mesh);

  return {
    material,
    update(camera) {
      mesh.position.x = Math.round(camera.x / WATER_SNAP) * WATER_SNAP;
      mesh.position.z = Math.round(camera.z / WATER_SNAP) * WATER_SNAP;
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose();
    },
  };
};
