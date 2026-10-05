/**
 * What water looks like, as one function two materials call.
 *
 * ## Why this is a file
 *
 * **The sea is drawn twice**, and it used to be drawn once by a sphere that the globe
 * regime covered over. The globe is a displaced sphere carrying the baked height map, so
 * it knows perfectly well where the water is — `uSeaRadius` and the map's own zero — and
 * it simply was not colouring it. That left two ways to draw an ocean and no reason for
 * either to be the truth: a shader on the near chunks and a guess in the distance.
 *
 * The far one cannot be a mesh. Streamed chunks reach 1,600 units; the globe swap happens
 * at 420 and the planet is 136,000 across. So the near sea and the far sea are two
 * materials, and the colours, the Fresnel and the alpha between them have to be the same
 * numbers or the swap is visible at exactly the altitude a person is watching it.
 *
 * ## What is shared and what is not
 *
 * **The colour and the opacity are one function of the normal, the view and the sky.**
 * Both callers have a `SkyLight` and a surface normal by the time they get here, and both
 * want the same answer: looking straight down is deep and looking out is a reflection of
 * the sky.
 *
 * **Not the lighting, the fog or the geometry.** The near sea is a translucent mesh over
 * terrain and is fogged like the terrain; the far sea is the terrain, displaced, and is
 * fogged like the terrain too — but the far one has a seabed underneath it inside the same
 * shaded colour, where the near one has geometry behind it that the blend shows. That
 * difference is why the far sea takes a `depth` and the near one does not, and it is the
 * one place the two genuinely do not agree.
 */

import type { Node } from "@random-mesh/rmsl";
import { float, vec3 } from "@random-mesh/rmsl";

/**
 * The colour of deep water, and the floor of how much of the sky it reflects.
 *
 * **A literal, as it always was**, and a deep blue rather than black because water at
 * depth is blue rather than dark: it is what is left after the red end is gone, not an
 * absence.
 */
export const DEEP_WATER = [0.05, 0.22, 0.4] as const;

/**
 * How reflective water is: `base + gain · (1 − |n·v|)^power`.
 *
 * **Four literals, and they are the same four the sphere's shader had.** `power` is what
 * makes it a reflection rather than a wash — three puts almost all of the reflection into
 * the last few degrees before the horizon — and `base` is what keeps water looking like
 * water when you look straight down into it, which is most of the time.
 */
export const FRESNEL_BASE = 0.05;
export const FRESNEL_GAIN = 0.95;
export const FRESNEL_POWER = 3;

/**
 * How opaque water is at a given Fresnel term, before the sky it reflects.
 *
 * **An offset rather than a product**, so water never disappears: 0.55 looking down and
 * 1.0 at the horizon. A product would make a shallow lagoon transparent enough to see the
 * tiled floor of it, which is not what water does.
 */
export const WATER_OPACITY = 0.55;

/**
 * The Fresnel term for a surface, from its normal and the eye's direction.
 *
 * **`abs` on the dot, because the sea is seen from both sides** — a player swims under it,
 * and from below the water is still water. Without it, the underside would report a
 * negative term and the deep colour would come out inverted.
 */
export const waterFresnel = (
  normal: Node<"vec3">,
  view: Node<"vec3">,
): Node<"float"> => {
  const facing = normal.dot(view).abs();
  return float(FRESNEL_BASE).add(
    float(FRESNEL_GAIN).mul(float(1).sub(facing).pow(float(FRESNEL_POWER))),
  );
};

/**
 * Water's colour, and how much of it there is, for a surface facing `normal`.
 *
 * `fresnel` is passed in rather than computed here because the globe has one already — it
 * has a normal and a view, same as the sea does — and computing it twice would be two
 * copies of the same four literals.
 */
export const waterLook = (
  skyColour: Node<"vec3">,
  fresnel: Node<"float">,
): { readonly colour: Node<"vec3">; readonly alpha: Node<"float"> } => ({
  // Grazing angles are water; the view straight down is depth. The mix is toward the sky
  // the surface is reflecting, which is also the colour the fog fades to — so the sea's
  // far edge and the sky behind it are the same colour and the sea has no edge.
  colour: vec3(DEEP_WATER[0], DEEP_WATER[1], DEEP_WATER[2]).mix(
    skyColour,
    fresnel,
  ),
  alpha: fresnel.add(float(WATER_OPACITY)).clamp(float(0), float(1)),
});
