/**
 * Point lights: the ones a place makes, rather than the sun.
 *
 * ## Why this is not rmsl's scene-graph lights
 *
 * rmsl ships `PointLight`, `collectLights` and `pointLightAttenuation`, and none of them can be
 * used here. `collectLights` walks the scene once per material compile and calls
 * `b.materialUniform` **once per light**, which bakes the light *count* into the shader — so a
 * place that turns a lantern on has changed the program's shape and every material must be
 * rebuilt. A world where lights appear and disappear on a timer would recompile its terrain
 * several times a second.
 *
 * So the count is fixed here at `MAX_DRAWN_LIGHTS` and the table is padded with dead lights. A
 * light that is not there is one whose radius is zero, which the window in `contribution` below
 * turns into exactly no contribution. **The price is sixteen uniform slots and sixteen thunk
 * calls per draw whether or not a place is loaded; the thing bought with them is that a light
 * appearing never rebuilds a shader.**
 *
 * A data texture was the alternative and is worse on both counts. rmsl has no `RedFormat`, so a
 * light's position would need two texels for the precision world coordinates need, and — the
 * decisive part — a loop over a sampler is a dependent texture fetch per light per fragment,
 * across a terrain that fills the screen. Sixteen unrolled uniform reads are arithmetic; that is
 * not.
 *
 * ## Why one instance per material, like `SkyLight`
 *
 * `SkyLight.declare` *assigns* the uniform nodes it builds onto the instance, so calling it twice
 * on one object leaves both materials reading whichever call came last. That is why there are four
 * `SkyLight` objects and `app.tsx` assigns each one, and this follows the same rule exactly rather
 * than inventing a second idiom for the same job. The *list* is shared by reference, so the
 * per-frame work is one array assignment per lit material rather than a fan-out of light data.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { float, max, saturate, vec3 } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";

import type { Vec3 } from "@big-mesh-studios/core";

/**
 * How many lights reach the shader, and therefore how many uniforms exist.
 *
 * **Eight, and it is a shader budget rather than a design number.** Each light is two `vec4`
 * uniforms — position and radius in one, colour and intensity in the other — so this is sixteen
 * uniform slots and sixteen thunk calls per draw, which is nothing next to the per-fragment cost
 * of the eight unrolled terms. Anything above about sixteen would start to matter, and rmsl's own
 * materials would have to be measured rather than assumed to.
 *
 * `MAX_LIGHTS` in `places/limits.ts` is the separate question of how many a place may *declare*;
 * this is how many of them are drawn.
 */
export const MAX_DRAWN_LIGHTS = 8;

/**
 * One light, in the units the renderer wants.
 *
 * **Colour in 0…1, where the place vocabulary says 0…255.** The conversion happens once, in the
 * host, rather than per draw — and it happens at a boundary rather than inside the shader, so
 * this file never has to know that a place speaks in bytes.
 *
 * **Intensity is a multiplier on an inverse-square falloff scaled by the radius, not raw
 * candela.** That is the one semantic decision in this file. Raw `1/d²` is unusable from a script:
 * a lantern ten units from a fragment would contribute `0.01`, so every place would have to write
 * an intensity of a hundred, and an author would have to know the distance to whatever the light
 * lands on in order to pick one. Scaled, `r²/d²` makes a light's reach and its brightness one
 * decision — **doubling the radius quadruples the light at a fixed distance** — so a place
 * author tunes a number and can predict what it did.
 *
 * It is worth being precise about what that does *not* say, because the obvious phrasing is
 * wrong: intensity is **not** the brightness at the light's own radius. The window below is zero
 * there, by construction, so the contribution at `d = radius` is zero whatever the intensity.
 * What intensity scales is the falloff, and the shape of what it falls off along.
 */
export interface PointLight {
  /** Where the light is, in world units. */
  readonly at: Vec3;
  /** Its colour, each channel 0 to 1. */
  readonly colour: readonly [number, number, number];
  /** How far it reaches, in world units. Zero means it contributes nothing at all. */
  readonly radius: number;
  /**
   * How bright, as a multiplier on the colour **at distance `radius`**. Zero also means nothing.
   */
  readonly intensity: number;
}

/**
 * The dead light every unfilled slot holds.
 *
 * **Frozen and shared, because a `PointLights` with no lights must still answer sixteen thunk
 * calls.** Its radius and intensity are zero, which is what makes the window below evaluate to
 * nothing — this is the whole of how "padding" is done without a branch.
 */
const NO_LIGHT: PointLight = {
  at: { x: 0, y: 0, z: 0 },
  colour: [0, 0, 0],
  radius: 0,
  intensity: 0,
};

/**
 * The smallest squared distance the falloff will divide by.
 *
 * **A fragment at the light's own centre has no direction to be lit from.** Left at zero this is
 * a division by zero, which is an infinity on most hardware and a NaN on some; at this value the
 * result is a very bright point rather than an undefined one, and `surface-material.ts` clamps
 * the sum it goes into.
 */
const MIN_D2 = 1e-4;

/**
 * The uniform nodes one material compiled against, and the term they add.
 *
 * **Never constructed by hand.** `PointLights.declare` is the only way to get one, because the
 * uniforms and the loop that reads them have to agree on how many there are.
 */
export class PointLightBindings {
  /** `[x, y, z, radius]` per light. */
  private readonly positions: UniformNode<"vec4">[] = [];
  /** `[r, g, b, intensity]` per light. */
  private readonly colours: UniformNode<"vec4">[] = [];

  constructor(
    private readonly lights: PointLights,
    b: Builder,
  ) {
    for (let at = 0; at < MAX_DRAWN_LIGHTS; at++) {
      const index = String(at);
      this.positions.push(
        b.materialUniform(`uLightPosition${index}`, "vec4", () => {
          const light = this.lights.at(index);
          return [light.at.x, light.at.y, light.at.z, light.radius];
        }),
      );
      this.colours.push(
        b.materialUniform(`uLightColour${index}`, "vec4", () => {
          const light = this.lights.at(index);
          return [
            light.colour[0],
            light.colour[1],
            light.colour[2],
            light.intensity,
          ];
        }),
      );
    }
  }

  /**
   * What every light adds to one fragment.
   *
   * **Inverse-square normalised to the light's own radius, with a smooth window, and no branch.**
   *
   * The `r²/d²` is where the normalisation happens: it is `1/d²` scaled so that the contribution
   * equals `intensity` at `distance = radius`. The window is `1 − (d/r)⁴`, fourth-power so that
   * it reaches zero at the radius with no slope left in it — a linear window leaves a visible
   * crease exactly at the light's edge, and a light's edge is the one place a person looks to
   * judge whether a light is real.
   *
   * **Nothing here divides by the radius**, which is what makes a dead light free rather than
   * merely invisible: at radius zero `r²` is zero, so the whole term is zero, and the window
   * below saturates to nothing on its own as well. A dead light therefore costs a divide by
   * `d²` and a multiply, and no branch.
   */
  contribution(
    worldPosition: Node<"vec3">,
    normal: Node<"vec3">,
  ): Node<"vec3"> {
    const total = vec3(0, 0, 0).toVar();

    // **Unrolled in JavaScript rather than a `Loop`,** because the count is fixed: a runtime loop
    // would need its index to reach a uniform, and rmsl would hoist the accumulator out of it
    // (`clouds.ts` records that trap). Building the graph eight times at compile time is cheaper
    // and has no such hazard.
    for (let at = 0; at < MAX_DRAWN_LIGHTS; at++) {
      const position = this.positions[at];
      const colour = this.colours[at];

      const delta = position.xyz.sub(worldPosition);
      // **Squared, never square-rooted.** `d²` is needed for the window and `1/d²` for the
      // falloff; taking the root to normalise would be a transcendental per light per fragment
      // to arrive back where it started.
      const d2 = max(delta.dot(delta), float(MIN_D2));
      const r2 = position.w.mul(position.w);

      // Written as `(r⁴ − d⁴) / r⁴` rather than `1 − pow(d2/r2, 2)` for one reason: the form that
      // divides by the radius produces a division by zero for a dead light, and this one does
      // not — at radius zero the numerator is `−d⁴` over `1e-4`, which saturates to nothing.
      const window = saturate(
        r2.mul(r2).sub(d2.mul(d2)).div(r2.mul(r2).add(MIN_D2)),
      );

      // **Lambert from the squared distance's own root.** `dot(normal, delta) / |delta|` is the
      // cosine; `d2`'s root is `|delta|²`, so this is a divide by the square root of a value
      // already computed, rather than a second normalisation.
      const cosine = saturate(normal.dot(delta).div(d2.sqrt()));

      // **The normalisation, and the only multiply in this term that is not a colour.** `r²/d²`
      // is `1/d²` rescaled so the term equals `intensity` at the light's own radius.
      total.addAssign(
        colour.xyz.mul(colour.w).mul(cosine).mul(window).mul(r2.div(d2)),
      );
    }

    return total;
  }
}

/**
 * The lights in one material's world.
 *
 * **The same shape as `SkyLight`, and deliberately.** `lights` is data, `declare` builds
 * bindings from it, and assigning `lights` once a frame is the whole of the per-frame work. A
 * material with none gets `null` and contributes nothing, because every slot is still read and
 * every one of them asks this object what it holds.
 */
export class PointLights {
  /** The lights to draw, in order. `null` and `[]` both mean none. */
  lights: readonly PointLight[] | null = null;

  private bindings: PointLightBindings | undefined;

  /**
   * Declares the uniforms this material will read them through.
   *
   * **Once, in `setup`.** Calling it twice would replace the bindings the first call handed the
   * fragment body, which is the reason `SkyLight` has one instance per material — see the file
   * header.
   */
  declare(b: Builder): PointLightBindings {
    // Re-declaring is a bug rather than a rebuild, and a silent one would be worse: the caller
    // would get bindings whose uniforms are not in the program. Returning the first set is the
    // least surprising answer and keeps that failure to a missing contribution.
    if (this.bindings !== undefined) return this.bindings;
    this.bindings = new PointLightBindings(this, b);
    return this.bindings;
  }

  /**
   * The light in slot `index`, or a dead one. **Padding, in one place.**
   *
   * Public because `PointLightBindings` reads it — the bindings and the data are two objects on
   * purpose (one per material, one per world), and hiding this behind a module-level function
   * would be a way of pretending they are one.
   */
  at(index: string): PointLight {
    const slot = Number(index);
    return this.lights?.[slot] ?? NO_LIGHT;
  }
}
