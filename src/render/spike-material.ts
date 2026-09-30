/**
 * The one material that proves the three things Phase 0 was gated on, in a
 * single shader, so that a single draw settles all of them.
 *
 *   1. A `snorm16x2` attribute reaching the vertex stage and unfolding into a
 *      unit normal — an octahedral fold that works is smooth on a sphere and
 *      flat on a box; a broken one is neither.
 *   2. A `unorm8x4` attribute reaching the fragment stage as a colour in 0..1,
 *      read straight out of the vertex rather than sampled from a palette.
 *   3. A `sampler3D` binding a volume and addressing it in world space.
 *
 * Lighting is a three-point rig — ambient plus key, fill and rim — which is the
 * arrangement the application this replaces used, kept here so the spike looks
 * like the thing it is standing in for. It costs four uniforms and about ten
 * lines, and swapping it for something better later touches nothing else in the
 * file.
 *
 * There is no raw GLSL escape hatch in this library. Every line below is a node
 * graph that compiles to GLSL ES 3.00, and `compileGLSL` is the way to see what
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

export class SpikeMaterial extends NodeMaterial {
  /**
   * The volume to address, or `null` for a material that does not. Assigning a
   * texture flags the program for a rebuild, which is what makes a volume
   * swappable at runtime rather than fixed at construction.
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

  keyDirection: [number, number, number] = [0.4, 0.8, 0.45];
  fillDirection: [number, number, number] = [-0.7, 0.1, 0.4];
  rimDirection: [number, number, number] = [0.1, -0.6, -0.75];
  /** What a surface receives whatever way it is turned. */
  ambient: [number, number, number] = [0.18, 0.19, 0.22];
  keyColour: [number, number, number] = [1.0, 0.97, 0.9];
  fillColour: [number, number, number] = [0.42, 0.5, 0.62];
  rimColour: [number, number, number] = [0.3, 0.36, 0.5];
  /** How much the volume's red channel darkens what it does not cover. */
  volumeStrength = 0.75;

  private volumeSampler?: UniformNode<"sampler3D">;
  private volumeScaleUniform?: UniformNode<"float">;
  private volumeStrengthUniform?: UniformNode<"float">;
  private keyUniform?: UniformNode<"vec3">;
  private fillUniform?: UniformNode<"vec3">;
  private rimUniform?: UniformNode<"vec3">;
  private ambientUniform?: UniformNode<"vec3">;
  private keyColourUniform?: UniformNode<"vec3">;
  private fillColourUniform?: UniformNode<"vec3">;
  private rimColourUniform?: UniformNode<"vec3">;

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

    this.keyUniform = b.materialUniform("uKeyDirection", "vec3", () =>
      normalizeTuple(this.keyDirection),
    );
    this.fillUniform = b.materialUniform("uFillDirection", "vec3", () =>
      normalizeTuple(this.fillDirection),
    );
    this.rimUniform = b.materialUniform("uRimDirection", "vec3", () =>
      normalizeTuple(this.rimDirection),
    );
    this.ambientUniform = b.materialUniform(
      "uAmbient",
      "vec3",
      () => this.ambient,
    );
    this.keyColourUniform = b.materialUniform(
      "uKeyColour",
      "vec3",
      () => this.keyColour,
    );
    this.fillColourUniform = b.materialUniform(
      "uFillColour",
      "vec3",
      () => this.fillColour,
    );
    this.rimColourUniform = b.materialUniform(
      "uRimColour",
      "vec3",
      () => this.rimColour,
    );
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

    const key = normal.dot(this.keyUniform!).max(float(0));
    const fill = normal.dot(this.fillUniform!).max(float(0));
    // The rim term is measured against the opposite of the direction it comes
    // from, so a surface facing away from it is the one that lights up.
    const rim = normal.dot(this.rimUniform!).max(float(0)).pow(2);

    const lit = this.ambientUniform!.add(this.keyColourUniform!.mul(key))
      .add(this.fillColourUniform!.mul(fill))
      .add(this.rimColourUniform!.mul(rim));

    return vec4(albedo.mul(lit).clamp(vec3(0, 0, 0), vec3(1, 1, 1)), float(1));
  }
}

/** A direction tuple as the unit vector the shader wants it in. */
const normalizeTuple = (
  d: readonly [number, number, number],
): [number, number, number] => {
  const length = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / length, d[1] / length, d[2] / length];
};
