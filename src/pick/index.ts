/**
 * Finding the surface under the pointer.
 *
 * Separate from the mesher because the mesher runs in a worker and this does not. What the
 * two share is the field: both read the same function of position, which is why a pick and
 * the surface a user can see cannot disagree about where the surface is.
 */

export type {
  PickField,
  PickHit,
  PickOptions,
  PickResult,
  Ray,
} from "./picker";
export { MAX_STEP, pickAlong, rayAt, rayThroughScreen, toNdc } from "./picker";
