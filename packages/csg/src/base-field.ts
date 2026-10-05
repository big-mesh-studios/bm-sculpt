/**
 * The infinite world behind the operations, as a value.
 *
 * One discriminated union rather than a `BaseFieldKind` and a bag of optional parameter blocks,
 * because the shape it replaces invited the failure it was written to prevent. `ModelMessage`
 * carried `base: "none" | "terrain"` beside an optional `terrain?: { origin; scale; octaves; seed }`,
 * on the reasoning that "a world with no base field cannot accidentally arrive with half of one".
 * It can: a message saying `"planet"` with a terrain's four numbers is exactly that mistake, and
 * nothing in the type stopped it. Here the parameters and the kind that selects them are the same
 * value, so there is no such message to write.
 *
 * **Plain data throughout, because it crosses into workers by structured clone.** A union of two
 * object literals survives that; a class instance becomes an object with its fields and none of
 * its methods, which looks like one and cannot sample.
 */

import { vec3, type Vec3 } from "@big-mesh-studios/core";

import type { BaseField, SurfaceExtent } from "./field";
import { planetField } from "./planet";
import type { PlanetField, PlanetParams } from "./planet";
import { terrainField } from "./terrain";
import type { TerrainParams } from "./terrain";

/** The base field a world is built on, or `undefined` for a world of operations alone. */
export type BaseFieldSpec =
  | { readonly kind: "terrain"; readonly params: TerrainParams }
  | { readonly kind: "planet"; readonly params: PlanetParams };

/** The one-line answer to "what kind of infinite world is behind these operations". */
export type BaseFieldKind = BaseFieldSpec["kind"];

/**
 * A built base field, carrying everything a `Field` needs from it.
 *
 * **Four members rather than one, because `Field` takes four.** `FieldOptions` has separate `base`,
 * `extent`, `lipschitz` and `fallbackNormal` slots, and a caller filling them from two places could
 * pair one field's distances with another's bound — the symptom being a picker that walks through
 * the ground, which is the exact failure `lipschitz` exists to prevent. One function that returns
 * all four together is the only way to make the mistake unrepresentable, and it is what both
 * threads call.
 */
export interface BuiltBaseField extends BaseField, SurfaceExtent {
  /** Which world this is, kept on the built field so callers can ask instead of casting. */
  readonly kind: BaseFieldKind;
  readonly lipschitz: number;
  /**
   * Where this world's water settles: an altitude for a height field, a distance from the
   * centre for a planet.
   *
   * **One number on the field rather than a constant repeated by each caller**, because the two
   * worlds state it in ways that cannot be translated into each other and every caller that
   * guessed would be a place the water is not. It is a landscape's own number — `origin` on a
   * height field, which is the altitude its height of zero sits at, and `radius` on a planet,
   * which is its mean sea level — so it travels with the parameters into workers as part of
   * the same spec, and no thread can read a different sea from the same world.
   */
  readonly seaLevel: number;
  /**
   * Which way "up" is where this field's gradient is zero, or where it is too small to matter.
   *
   * **On the field rather than at the call site, because the two threads disagreed.** The mesher
   * got the outward direction and the player's collision got the default of world up, which is a
   * direction that means nothing on a planet — at the centre of a sphere every direction is down,
   * and `+Y` is one arbitrary answer to that question. The failure it causes is small and real: a
   * single degenerate point where a face's normal is wrong, and a brush stroke at the centre of the
   * world that lifts terrain along an unrelated axis. **Correctness that depends on which thread
   * asked is not correctness**, so the direction travels with the field.
   */
  readonly fallbackNormal: (x: number, y: number, z: number) => Vec3;
}

/** World up, for a field whose up is a direction rather than a place. */
const UP = vec3(0, 1, 0);

/** Away from the centre, for a field whose up is a place. */
const outward = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  // The exact centre has no direction, and `normalize` would answer with the zero vector — which is
  // the one input `Field.gradient`'s fallback is not allowed to return.
  return l === 0 ? UP : vec3(x / l, y / l, z / l);
};

/**
 * The sea level a spec's world has, without building its field.
 *
 * **Because a caller that only needs the water does not need the noise.** The main thread asks this
 * for a world's altitude before the landscape is streamed and a worker asks it on every model to
 * know where to put the water, and neither of those wants a permutation table's worth of setup for
 * one number. Both threads read the same parameters, so both get the same sea — which is the whole
 * of ADR 0009 applied to the water.
 */
export const seaLevelOf = (spec: BaseFieldSpec): number =>
  spec.kind === "terrain" ? spec.params.origin : spec.params.radius;

/**
 * Adds a fallback direction to a field **in place**, because the obvious way to do it is wrong.
 *
 * `{ ...field, fallbackNormal }` compiles and produces something that is no longer a field. A
 * `BaseField` is a *call signature*, and object spread copies own enumerable properties while
 * dropping type-level call signatures — so the result answers `lipschitz` and `couldHoldSurface`
 * and returns `undefined` when asked for a distance. The error arrives at the first `distance`
 * call on the other side of the boundary, in a worker, as `NaN` propagating through a mesher, which
 * is about as far from the cause as a defect can get.
 *
 * `Object.assign` keeps the value, and mutating is safe because `terrainField` and `planetField`
 * each return a fresh object.
 */
const withFallbackNormal = (
  field: BaseField &
    SurfaceExtent & {
      readonly lipschitz: number;
      readonly seaLevel: number;
    },
  kind: BaseFieldKind,
  fallbackNormal: (x: number, y: number, z: number) => Vec3,
): BuiltBaseField => Object.assign(field, { kind, fallbackNormal });

/**
 * Whether a built field is a planet, narrowing it to one that can answer `radiusAt`.
 *
 * A type guard rather than a cast at each use: `baseFieldFor` deliberately returns one type for
 * both worlds, so code that asks a question only a planet can answer needs one place where the
 * narrowing is stated and checked, and everywhere else a type that carries it.
 */
export const isPlanetField = (
  field: BuiltBaseField | undefined,
): field is BuiltBaseField & PlanetField => field?.kind === "planet";

/**
 * Builds the base field a spec names, or `undefined` for a world of operations alone.
 *
 * **One function, called by the main thread and by every worker**, which is the whole of ADR 0009
 * for a base field. The main thread samples for the picker and the player's collision; a worker
 * samples for the mesher. If the two built their landscape from the same numbers in two places,
 * they could drift, and the symptom would be a player walking through ground that is plainly
 * drawn in front of them — or standing on air.
 *
 * @throws if the spec names a field whose parameters it does not carry, which cannot happen with
 * the union and is here so that a widened `BaseFieldSpec` fails loudly rather than silently
 * producing a world nobody asked for.
 */
export const baseFieldFor = (
  spec: BaseFieldSpec | undefined,
): BuiltBaseField | undefined => {
  if (spec === undefined) return undefined;
  switch (spec.kind) {
    case "terrain":
      return withFallbackNormal(terrainField(spec.params), "terrain", () => UP);
    case "planet":
      return withFallbackNormal(planetField(spec.params), "planet", outward);
    default: {
      // Exhaustiveness as a runtime check, because this value crosses a thread boundary by
      // structured clone and a kind added on one side would otherwise arrive on the other as
      // `undefined` and be read as "no base field" — a world with no landscape at all, which is
      // the one reading of that message that is silently wrong.
      const unreachable: never = spec;
      throw new Error(
        `unknown base field ${JSON.stringify((unreachable as BaseFieldSpec).kind)}`,
      );
    }
  }
};
