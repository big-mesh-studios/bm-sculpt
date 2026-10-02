/**
 * Fog: what everything fades into at distance, and how far away that is.
 *
 * ## Why there is any
 *
 * The chunk window is four chunks on a side, which is 1280 world units, and the
 * camera's far plane is a hundred thousand. So the terrain stops at one and a
 * hundredth of the depth of the frame, and without something to fade into the sky its
 * edge is a hard line across the horizon at a distance the eye resolves perfectly
 * well. Every surface in this application — terrain, water — reaches the end of its
 * world well before the frame does, and this is what closes the gap.
 *
 * The far distance is therefore **the window's radius**, not a number chosen to look
 * right. It is the one distance in the scene that is not an art decision, because it
 * is a fact about where the geometry stops.
 *
 * ## Why exponential rather than the reference's smoothstep
 *
 * `big-mesh-studios`'s voxelscape ramps fog with `smoothstep(near, far, distance)`,
 * which is a straight line between two distances and has a visible terminus: everything
 * past `far` is one flat colour, and the band where it reaches that colour is a ring.
 * An exponential has no terminus and no ring — it never arrives, and the eye cannot
 * find the place where it stops.
 *
 * The cost is that it never fully hides anything, so the falloff is set steeply enough
 * that the window's edge is nonetheless invisible: at `FOG_FAR` about three per cent of
 * the surface is still showing, and at the *edge* of the window rather than at the
 * nominal far distance that is a fraction of a per cent.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { exp, float } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";

import { BLOCK_WORLD } from "../constants";

/** Where the fog starts, in world units. */
export const FOG_NEAR = 500;

/**
 * Where the fog has effectively hidden everything.
 *
 * Four chunks on a side, which is where the streaming window stops placing cells. Not
 * the far plane: the terrain genuinely ends here, and this is the distance that fact
 * is visible at.
 */
export const FOG_FAR = 4 * BLOCK_WORLD;

/**
 * How steeply the fog closes, in multiples of "fully fogged" over `FOG_FAR - FOG_NEAR`.
 *
 * Three and a half, chosen so that at `FOG_FAR` about three per cent of the surface
 * still shows. Steeper would reach solid sooner and start banding in the gradient;
 * shallower would let the window's edge through.
 */
export const FOG_FALLOFF = 3.5;

export class Fog {
  /** What everything fades towards: the sky at the horizon. */
  colour: [number, number, number] = [0.53, 0.81, 0.92];

  private uniform?: UniformNode<"vec3">;

  declare(b: Builder): void {
    this.uniform = b.materialUniform("uFogColour", "vec3", () => this.colour);
  }

  /**
   * `colour` faded towards the fog colour by distance from the eye.
   *
   * Exponential, so there is no distance at which the answer stops changing. See the
   * note at the top of this file for why the reference's straight line is not used.
   */
  apply(b: Builder, colour: Node<"vec3">): Node<"vec3"> {
    const distance = b.positionWorld.sub(b.cameraPosition).length().toVar();
    const rate = float(FOG_FALLOFF).div(FOG_FAR - FOG_NEAR);
    // Clamped at the near end, and that clamp is not tidiness. The exponential's
    // argument is `distance - FOG_NEAR`, which is *negative* for anything nearer than
    // that — and an unclamped mix with a negative weight extrapolates past the surface
    // colour, away from the fog, so the ground at the player's feet would come out
    // inverted. Writing the test's own copy of this law is what turned that up: the
    // copy returned −8 at the origin and the shader was doing the same thing.
    const amount = float(1).sub(
      exp(distance.sub(float(FOG_NEAR)).max(float(0)).mul(rate).negate()),
    );
    return colour.mix(this.uniform!, amount);
  }
}

/**
 * The fog colour the day implies.
 *
 * Kept as a function rather than left to each caller to remember which of the sky's two
 * colours fog wants: the horizon's, because fog is what the horizon looks like when it
 * is full of air.
 */
export const fogColourOf = (
  skyColour: [number, number, number],
): [number, number, number] => skyColour;
