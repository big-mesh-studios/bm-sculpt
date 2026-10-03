/**
 * The material a model's surface is drawn with: its own colour per vertex, its own normal
 * per vertex, and three fixed lights.
 *
 * ## Why this is a node graph and not one of rmsl's materials
 *
 * **Because the packed vertex layout has no `normal` attribute.** It has `normalOct` —
 * octahedral-encoded, two bytes a normal — and only the landscape's `SurfaceMaterial`
 * knows to read and decode it. `MeshStandardMaterial` and `MeshLambertMaterial` look for
 * `normal`, find nothing, and fall back to a constant, so a figure shades as one flat tone
 * however good its geometry is.
 *
 * That failure is **silent**: nothing throws, nothing warns, and the model is visible,
 * correctly coloured, correctly shaped and completely flat. An earlier version of this
 * material was a stock `MeshStandardMaterial`, which is the natural thing to reach for and
 * which produced exactly that.
 *
 * Adding a `normal` attribute instead would cost twelve bytes a vertex to save about thirty
 * lines of shader, and would change a vertex layout three packages agree on — so the
 * decode happens here instead.
 *
 * ## Why the lights are in the material rather than in the scene
 *
 * **Because a rig that lives in the scene has to be added and removed as panels come and
 * go, and because the modeller's rig exists to make a form readable rather than to light a
 * world.** The landscape's terrain has a sun, a sky and a fog, and its rig is a property of
 * the place. This has a turntable and a form, and the three constants that do that job sit
 * next to the shading that uses them.
 *
 * The numbers are the landscape's rig in spirit: a warm key from above and to the right, a
 * cool fill from the opposite side so the shadowed half is shaped rather than hollow, and an
 * ambient at under a fifth of the key so nothing is ever fully black.
 */
import { float, select, vec3, vec4, type Node } from "@random-mesh/rmsl";
import {
  Blending,
  NodeMaterial,
  Side,
  type Builder,
  type Scene,
} from "@random-mesh/rmsl/scene";

/**
 * Octahedral decode, in the shader.
 *
 * **The lower hemisphere's branch is an unconditional add of a term that is zero when the
 * branch is not taken**, rather than an `If` — the same reasoning as the landscape's
 * `octahedralNode`: a branch here would be a per-vertex divergence on exactly the vertices
 * where a fold turns over, which is most of a modelled shape.
 *
 * A copy rather than a shared import, because a GLSL expression cannot live in a package
 * that does not depend on the renderer.
 */
const octahedralNode = (f: Node<"vec2">): Node<"vec3"> => {
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

/** Direction, colour and strength of one light. All three are fixed in world space. */
const KEY = {
  direction: [0.51, 0.79, 0.56] as const,
  colour: [1.0, 0.97, 0.92] as const,
  power: 1.55,
};
const FILL = {
  direction: [-0.78, 0.21, -0.58] as const,
  colour: [0.66, 0.76, 1.0] as const,
  power: 0.6,
};
const AMBIENT = [0.28, 0.3, 0.36] as const;

/**
 * A Lambert material over the packed vertex layout.
 *
 * **Diffuse only, and deliberately.** A figure being modelled wants to read as a form, and
 * a specular highlight on a matte clay surface mostly reads as a rendering artefact.
 */
export class ModelMaterial extends NodeMaterial {
  protected override setup(b: Builder, _scene: Scene): void {
    // Declared here rather than where it is written, because a varying the builder never
    // sees is one the compiler will not emit.
    void b.varying("vColour", "vec4");

    // **Double-sided, because a subtracted shape is mostly its own inside.** With a
    // one-sided material the interior of a difference is back-facing and invisible, so
    // cutting a hole out of a figure leaves the figure looking whole from the far side.
    // This is the same reason the terrain material is double-sided.
    this.side = Side.DoubleSide;
  }

  protected override buildVertexBody(b: Builder): Node<"vec4"> {
    const oct = b.attribute("normalOct", "vec2");
    const colour = b.attribute("colour", "vec4");

    // **The octahedral decode happens per vertex and the result is what crosses as a
    // varying**, which is both cheaper than carrying the encoded pair and smoother across a
    // triangle than interpolating two shorts and decoding per fragment.
    b.normalWorld.assign(octahedralNode(oct));
    b.varying("vColour", "vec4").assign(colour);

    const world = b.modelMatrix.mul(vec4(b.position, float(1)));
    b.positionWorld.assign(world.xyz);
    return b.projectionMatrix.mul(b.viewMatrix.mul(world));
  }

  protected override buildFragmentBody(b: Builder): Node<"vec4"> {
    const normal = b.normalWorld.normalize().toVar();
    const colour = b.varying("vColour", "vec4").toVar();

    // **The normal is turned towards the eye, which is what makes a two-sided surface
    // read rather than merely be drawn.** A one-sided check on the sign of the
    // normal-to-eye dot flips it only when it points away; because the test is made on
    // whichever normal arrived, this is also correct if the renderer has already flipped
    // one for a back face, and a no-op in that case.
    const facing = normal.dot(
      b.cameraPosition.sub(b.positionWorld).normalize(),
    );
    normal.mulAssign(select(facing.lessThan(float(0)), float(-1), float(1)));

    const lambert = (
      direction: readonly number[],
      colour: readonly number[],
      power: number,
    ): Node<"vec3"> => {
      const light = vec3(
        float(direction[0]),
        float(direction[1]),
        float(direction[2]),
      ).normalize();
      // **Clamped at zero**, so a surface turned away from a light contributes nothing
      // rather than a negative amount that darkens the far side twice.
      return vec3(colour[0], colour[1], colour[2])
        .mul(normal.dot(light).max(float(0)))
        .mul(float(power));
    };

    const lit = lambert(KEY.direction, KEY.colour, KEY.power)
      .add(lambert(FILL.direction, FILL.colour, FILL.power))
      .add(vec3(AMBIENT[0], AMBIENT[1], AMBIENT[2]));

    return vec4(colour.xyz.mul(lit), colour.w);
  }
}

/**
 * A material for `translucent`, built once per install.
 *
 * **`translucent` is passed rather than derived from the mesh, because a mesh cannot say
 * whether it wants blending**: every vertex carries an alpha either way, and a model with no
 * transparency in it still has an opaque fourth byte. An always-transparent material would
 * put a fully opaque model into the transparent queue with depth writes off, which is the
 * arrangement that makes a solid self-overlap wrongly.
 */
export const modelMaterial = (translucent: boolean): ModelMaterial => {
  const material = new ModelMaterial();

  if (translucent) {
    material.transparent = true;
    material.blending = Blending.NormalBlending;
    material.depthWrite = false;
  }

  return material;
};
