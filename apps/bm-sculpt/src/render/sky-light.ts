/**
 * The six bindings every lit material needs from the day.
 *
 * One class rather than six uniforms in each of four materials, because the fallback
 * rule is a real decision and four copies of it would be four chances to disagree: a
 * material built and drawn before it has been given a state reads these instead, and
 * what it should read is midday — because that is what the editor wants anyway, and
 * the alternative is a black screen for a frame at every scene's start.
 *
 * The colours are the day-night palette's own, so a material that has never been
 * updated looks like the reference project's noon rather than like nothing.
 */

import type { Node, UniformNode } from "@random-mesh/rmsl";
import { float } from "@random-mesh/rmsl";
import type { Builder } from "@random-mesh/rmsl/scene";

import type { DayNightState } from "../world/day-night";

/** Midday, for a material that has not been given a day yet. */
const NO_SUN: [number, number, number] = [0.4, 0.8, 0.45];
const NO_MOON: [number, number, number] = [-0.4, -0.8, -0.45];
const NOON_LIGHT: [number, number, number] = [1, 0.98, 0.9];
const NOON_AMBIENT: [number, number, number] = [0.45, 0.5, 0.6];
const NOON_SKY: [number, number, number] = [0.53, 0.81, 0.92];

export class SkyLight {
  /**
   * The day's state, read per draw.
   *
   * Held whole rather than as six fields, because that is what the caller has and a
   * copy of it per channel per frame is an allocation the render loop should not be
   * making. Assigning it is the whole of the per-frame lighting work: rmsl reads the
   * thunk on every draw, so no `needsUpdate` is involved and none exists.
   */
  lighting: DayNightState | null = null;

  /** Unit direction toward the sun. */
  sunDirection!: UniformNode<"vec3">;

  /** What the sun contributes. Its brightness is here, not in an intensity curve. */
  sunLight!: UniformNode<"vec3">;

  /** Unit direction toward the moon, which is exactly opposite the sun. */
  moonDirection!: UniformNode<"vec3">;

  /** What the moon contributes. Zero while the sun is up. */
  moonLight!: UniformNode<"vec3">;

  /** What a surface receives however it is turned. */
  ambient!: UniformNode<"vec3">;

  /** Sky colour at the horizon. What fog fades towards. */
  skyColour!: UniformNode<"vec3">;

  declare(b: Builder): void {
    this.sunDirection = b.materialUniform("uSunDirection", "vec3", () =>
      this.lighting ? this.lighting.sunDir : NO_SUN,
    );
    this.sunLight = b.materialUniform("uSunLight", "vec3", () =>
      this.lighting ? this.lighting.sunLight : NOON_LIGHT,
    );
    this.moonDirection = b.materialUniform("uMoonDirection", "vec3", () =>
      this.lighting ? this.lighting.moonDir : NO_MOON,
    );
    this.moonLight = b.materialUniform("uMoonLight", "vec3", () =>
      this.lighting ? this.lighting.moonLight : [0, 0, 0],
    );
    this.ambient = b.materialUniform("uAmbient", "vec3", () =>
      this.lighting ? this.lighting.ambient : NOON_AMBIENT,
    );
    this.skyColour = b.materialUniform("uSkyColour", "vec3", () =>
      this.lighting ? this.lighting.skyColor : NOON_SKY,
    );
  }

  /**
   * The sun's contribution to a surface facing `normal`.
   *
   * `max(dot(n, l), 0)` and nothing else, which is a Lambertian term: the whole
   * point of carrying the hour in the *colour* is that one light at one intensity
   * covers every time of day. A direction that reads as "sun up" has its brightness
   * in `sunLight`, which is near white at noon and a fifth of that at midnight.
   */
  sunOn(normal: Node<"vec3">): Node<"float"> {
    return this.sunDirection.dot(normal).max(float(0));
  }

  /** The same for the moon, which is why there are two and not one. */
  moonOn(normal: Node<"vec3">): Node<"float"> {
    return this.moonDirection.dot(normal).max(float(0));
  }
}
