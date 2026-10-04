/**
 * The material the application's chunks are drawn with, and the one Phase 0 used to
 * settle its three risks. One shader rather than two: the spike is only evidence about
 * this material if the application draws with the same one, and a second copy would be
 * one shader too many to keep in step.
 *
 *   1. A `snorm16x2` attribute reaching the vertex stage and unfolding into a
 *      unit normal — an octahedral fold that works is smooth on a sphere and
 *      flat on a box; a broken one is neither.
 *   2. A `unorm8x4` attribute reaching the fragment stage as a colour in 0..1,
 *      read straight out of the vertex rather than sampled from a palette.
 *   3. A `sampler3D` binding a volume and addressing it in world space.
 *
 * Lighting was a three-point rig — ambient plus key, fill and rim — kept here so the
 * spike would look like the thing it is standing in for. It is now the sun and the moon
 * and an ambient, read from the day-night cycle: one directional term each, and the hour
 * carried entirely in their colours. A rig is a rig, and a three-point one has no sun in
 * it to move, so a day-night cycle over a fixed key direction is a sky that changes over
 * a world whose shadows do not.
 *
 * Fog arrived with it, for a related reason. The chunk window ends four chunks out —
 * 1280 world units — while the far plane is four hundred thousand, so the terrain's edge is
 * a line across the horizon at a distance the eye resolves easily. `fog.ts` closes that
 * gap, and its far distance is the window's radius rather than a number chosen to look
 * right, because that is not an art decision.
 *
 * There is no raw GLSL escape hatch in this library. Every line below is a node
 * graph that compiles to GLSL ES 3.00, and `compileGlsl` is the way to see what
 * it produced when something comes out wrong.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { float, select, vec3, vec4 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";
import {
  DataTexture,
  NodeMaterial,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";

import { Fog } from "./fog";
import { PointLights, type PointLightBindings } from "./point-lights";
import { SkyLight } from "./sky-light";

/**
 * Unfolds an octahedral point of [-1, 1]² back to the unit vector that folds
 * onto it — the shader half of `decodeOctahedral` in `octahedral.ts`.
 *
 * The lower hemisphere's branch is written as an unconditional add of a term
 * that is zero when the branch is not taken, rather than as an `If`. A branch
 * here would be a per-vertex divergence on exactly the vertices where the fold
 * turns over, which is every vertex of a folded shape — the case this encoding
 * exists to make cheap.
 */
export const octahedralNode = (f: Node<"vec2">): Node<"vec3"> => {
  const n = vec3(f.x, f.y, float(1).sub(f.x.abs()).sub(f.y.abs())).toVar();
  const height = n.z.negate().max(float(0)).toVar();
  n.x.assign(
    n.x.add(select(n.x.greaterThanEqual(float(0)), height.negate(), height)),
  );
  n.y.assign(
    n.y.add(select(n.y.greaterThanEqual(float(0)), height.negate(), height)),
  );
  return n.normalize();
};

export class SurfaceMaterial extends NodeMaterial {
  /**
   * The volume to address, or `null` for a material that does not.
   *
   * The application sets no volume until Phase 6 gives it a base field to cut against;
   * the spike sets one. Assigning a texture flags the program for a rebuild, which is
   * what makes a volume swappable at runtime rather than fixed at construction.
   */
  volume: DataTexture | null = null;

  /**
   * How many world units the volume spans, edge to edge.
   *
   * Named as a size rather than a scale because a scale here is a reciprocal, and
   * writing the reciprocal is how the previous value ended up wrong by a factor of a
   * thousand: `1.6` as "volume units per world unit" is a volume 0.625 world units
   * across, which no shape in this scene comes within a hundred units of, so every
   * sample clamped to an edge texel and the volume did nothing but dim both shapes by
   * four. The image it produced was indistinguishable from a wrongly-addressed
   * sampler, which is the one thing this spike exists to rule out.
   */
  volumeWorldSize = 1200;

  /**
   * The day this surface is lit by, and what it fades into at distance.
   *
   * Two objects rather than a dozen fields, because that is what they are: the six
   * bindings the whole sky shares, and the one colour everything fades towards.
   * Assigning `material.sky.lighting` once a frame is the entire per-frame lighting work
   * for every surface in the world.
   */
  readonly sky = new SkyLight();

  /** The fog. Its colour is normally the sky's horizon colour. */
  readonly fog = new Fog();

  /**
   * The lights a place has made, as distinct from the sun.
   *
   * **Its own instance, like `sky`, and for the same reason** — `declare` writes the uniform
   * nodes onto the instance, so two materials sharing one would have both reading whichever
   * declared last. `app.tsx` assigns each material's list once a frame, and the lists are shared
   * by reference so the per-frame work is one array rather than a fan-out of light data.
   */
  readonly lights = new PointLights();

  /** How much the volume's red channel darkens what it does not cover. */
  volumeStrength = 0.75;

  /**
   * How opaque the chunks are, 0 to 1.
   *
   * **Driven by altitude, so the streamed terrain can fade out as the far-field globe fades in.**
   * The globe is the same field at a coarser resolution, and drawing one over the other is only a
   * crossfade if the terrain can be partly transparent too — otherwise the opaque chunks simply
   * overwrite it. Opaque by default, so the editor and the spike, which have no globe, are
   * unchanged.
   */
  override opacity = 1;

  private opacityUniform?: UniformNode<"float">;
  private volumeSampler?: UniformNode<"sampler3D">;
  private volumeScaleUniform?: UniformNode<"float">;
  private volumeStrengthUniform?: UniformNode<"float">;
  private lightBindings?: PointLightBindings;

  constructor() {
    super();
    // Both sides, because a surface nets mesh is a closed shell only in the
    // sense that it surrounds a volume: a camera inside the model, which the
    // brush preview and the primitive gizmo both put it, would otherwise see
    // straight through the near wall.
    this.side = Side.DoubleSide;
  }

  protected override setup(b: Builder, _scene: Scene): void {
    // Declared here rather than where they are written, because a varying the
    // builder never sees is one the compiler will not emit.
    void b.varying("vColour", "vec4");

    this.sky.declare(b);
    this.fog.declare(b);
    // **Declared unconditionally, so a light appearing never rebuilds this program.** See the
    // header of `point-lights.ts`: the slot count is fixed and unfilled slots read as dead.
    this.lightBindings = this.lights.declare(b);
    this.volumeScaleUniform = b.materialUniform(
      "uVolumeScale",
      "float",
      () => 1 / Math.max(this.volumeWorldSize, 1e-6),
    );
    this.volumeStrengthUniform = b.materialUniform(
      "uVolumeStrength",
      "float",
      () => this.volumeStrength,
    );
    this.opacityUniform = b.materialUniform(
      "uTerrainOpacity",
      "float",
      () => this.opacity,
    );

    // Only bound when there is a volume. The sampler has to be named for the
    // renderer to find a value for it, so a material with no volume leaves the
    // binding out entirely and reads nothing — rather than binding a 1x1x1
    // placeholder and sampling it, which would work and mean nothing.
    if (this.volume !== null) {
      this.volumeSampler = b.sampler("uVolume", "sampler3D", () => this.volume);
    }
  }

  protected override buildVertexBody(b: Builder): Node<"vec4"> {
    const oct = b.attribute("normalOct", "vec2");
    const colour = b.attribute("colour", "vec4");
    // The fragment stage cannot read a vertex attribute, so the colour crosses
    // as a varying. The normal does not have to: it is rebuilt per fragment from
    // the interpolated fold, which is both cheaper than a fourth attribute and
    // smoother across a triangle than interpolating three floats and
    // renormalizing them.
    b.varying("vColour", "vec4").assign(colour);
    b.normalWorld.assign(b.normalMatrix.mul(octahedralNode(oct)).normalize());

    const world = b.modelMatrix.mul(vec4(b.position, float(1)));
    b.positionWorld.assign(world.xyz);
    return b.projectionMatrix.mul(b.viewMatrix.mul(world));
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const normal = b.normalWorld.normalize().toVar();
    const albedo = b.varying("vColour", "vec4").xyz.toVar();

    // The volume's contribution, addressed in world space so it stays put while the
    // surface moves. Mapped into the unit cube and clamped: the volume is a single
    // sphere, and clamping is what makes everything outside it read the same rather
    // than whatever the wrap mode decides.
    if (this.volumeSampler !== undefined) {
      const uvw = b.positionWorld
        .mul(this.volumeScaleUniform!)
        .add(vec3(0.5, 0.5, 0.5))
        .clamp(vec3(0, 0, 0), vec3(1, 1, 1));
      const sampled = this.volumeSampler.texture(uvw);

      const covered = sampled.r;
      const darken = float(1).sub(
        this.volumeStrengthUniform!.mul(float(1).sub(covered)),
      );

      // Where the volume does not cover, the albedo is darkened *and* tinted toward the
      // texel's own address, which the green and blue channels carry. That is what makes
      // a misaligned or wrongly-sized binding visible as a ramp instead of as a sphere
      // that happens to land somewhere plausible: the sphere's silhouette alone cannot
      // tell you where the binding's origin is, so a binding shifted by half the volume
      // would still produce a smooth, correctly-shaded, completely wrong sphere.
      const ramp = vec3(sampled.g, sampled.b, sampled.g.mul(sampled.b));
      albedo.assign(albedo.mix(ramp, float(1).sub(covered)));
      albedo.mulAssign(darken);
    }

    // Sun, moon, flat ambient. Nothing else, and that is the point: one directional
    // term per light is all a Lambertian surface needs, and the hour lives in the
    // colours rather than in an intensity curve — the sun's light is near white at noon
    // and a fifth of that at midnight, which is the whole of the day/night range in one
    // number.
    //
    // No rim and no fill. Both were there to make a still frame read well under a fixed
    // key light; under a moving sun they are a second opinion about where the light is,
    // and a wrong one.
    const lighting = this.sky.ambient
      .add(this.sky.sunLight.mul(this.sky.sunOn(normal)))
      .add(this.sky.moonLight.mul(this.sky.moonOn(normal)))
      // **Point lights last, and additively.** They are the only term here that is not one
      // directional source, so they cannot be folded into the sun's colour without making the
      // hour depend on where a place put its lanterns. Clamped with the rest, which is what stops
      // a lantern's core from being anything but white.
      .add(this.lightBindings!.contribution(b.positionWorld, normal));

    const shaded = albedo.mul(lighting).clamp(vec3(0, 0, 0), vec3(1, 1, 1));

    // Fog last, after the lighting and the volume, because it is what the air between
    // the surface and the eye does to it rather than anything the surface is.
    return vec4(this.fog.apply(b, shaded), this.opacityUniform!);
  }
}
