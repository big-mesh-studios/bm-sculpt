/**
 * Finding what is under a point or a screen position.
 *
 * **A structural interface rather than a class**, and deliberately so: `PickField` is three
 * methods — a distance, an optional Lipschitz-scaled distance for stepping, and a gradient — so
 * anything that can answer those can be picked against, including a field this repository does not
 * own. See ADR 0024.
 */

export {
  MAX_STEP,
  pickAlong,
  rayAt,
  rayThroughScreen,
  toNdc,
  type PickField,
  type PickHit,
  type PickOptions,
  type PickResult,
  type Ray,
} from "./picker";
