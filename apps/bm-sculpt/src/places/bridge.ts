/**
 * The whole of what a place script can reach, in one interface.
 *
 * ## Why this is an interface and not an argument
 *
 * ADR 0015 established that a script's only way to the host is a function parameter, and
 * that nothing crosses the boundary as an object. This file is the boundary, written down
 * once so that both sides can be checked against it: the guest library imports it as a type
 * and declares `engine` from it; the host implements it.
 *
 * **Five members, and every one of them is a string or a number in each direction** except
 * `onTick`, which is the host receiving a function the guest made. That one exception is
 * unavoidable — a script has to be able to say "call this later" — and it is the only way
 * anything is ever handed *from* the guest to the host without being validated first.
 *
 * ## Why `dispatch` and `query` are separate
 *
 * They are both strings in and strings out, so they could have been one method with a
 * discriminator. Keeping them apart is about what the host can do wrong:
 *
 * - `dispatch` **changes the world.** Under the authority model its arguments are peer's
 *   bytes, so it validates, and a refusal is reported back as a reason string rather than
 *   swallowed.
 * - `query` **reads the world.** It cannot change anything, it takes no arguments it could
 *   use to, and it cannot be refused for being out of bounds — it answers with "no" or a
 *   miss, because a query that failed would be a script that could not tell a solid
 *   surface from no answer at all.
 *
 * Merging them would mean the host holding one validated path and one unvalidated one, and
 * the mistake would be a `query` reaching the applier.
 *
 * ## The refusal return
 *
 * `dispatch` returns `""` when the effect was carried out, and a sentence naming the problem
 * otherwise. The guest library turns a non-empty one into a thrown `PlaceError`.
 *
 * **A script is told when its own effect is refused**, which sounds fussy and is the
 * opposite. A place that silently loses its two-thousandth shape is a world with a missing
 * bridge and nothing to say why; a script that throws at the moment it happens fails in a
 * place its author can find, with `MAX_OPERATIONS_PER_PLACE` in the message. It is also
 * deterministic — every peer applies the same effects to the same state and reaches the same
 * refusal — so this cannot make two peers diverge.
 */

/** The queries a script may ask. Closed, so both sides can be checked against it. */
export const GUEST_QUERIES = [
  /** `getSolidAt(x, y, z)` → boolean. Inside material. Water is not material. */
  "getSolidAt",
  /** `getHeightAt(x, z)` → number. The terrain's own analytic surface height. */
  "getHeightAt",
  /** `getWaterAt(x, y, z)` → boolean. */
  "getWaterAt",
  /**
   * `getMediumAt(x, y, z)` → a field or null.
   *
   * **A spatial query rather than "the medium the player is in",** because a place building a
   * conveyor wants to know whether the player is standing on *its* belt, which is a question
   * about a box and a position. `MAX_PLAYERS` is 1 today, so the two would be the same answer;
   * they would not be once there were more.
   */
  "getMediumAt",
  /** `raycast(origin, direction, maxDistance)` → a hit or null. */
  "raycast",
  /**
   * `getData(key)` → a string or null.
   *
   * **The one query that reads a place's own state rather than the world's**, and it is on
   * this list rather than somewhere else because the interpreter refuses a name that is not
   * here — so leaving it off would have made `loadData` quietly answer `undefined` forever,
   * with no error anywhere. That is the failure this list exists to prevent: a name a place
   * asks for that no host is asked about, because the query never left the interpreter.
   */
  "getData",
] as const;

export type GuestQuery = (typeof GUEST_QUERIES)[number];

/**
 * What a script can reach, from inside the interpreter.
 *
 * A host implements this by binding five functions onto an object it holds and never
 * installs on the interpreter's global — the reason being that a global is reachable from
 * anywhere in the script, including code the author did not write, and a parameter has to
 * be passed.
 */
export interface GuestBridge {
  /**
   * Asks the host to carry out an effect.
   *
   * @param tag one of the effect tags in `effects.ts`
   * @param payloadJson the payload, as JSON text — objects do not cross (ADR 0015)
   * @returns `""` on success, or a sentence naming the refusal
   */
  dispatch(tag: string, payloadJson: string): string;

  /**
   * Asks the host a question about the world.
   *
   * @param name one of `GUEST_QUERIES`
   * @param argsJson the arguments, as a JSON array
   * @returns the answer, as JSON text — never a refusal, because a query cannot fail
   */
  query(name: string, argsJson: string): string;

  /**
   * Registers the function to call on each step.
   *
   * The only thing handed from the guest to the host without being validated, and it is
   * safe because it is a *reference* rather than data: the host can only call it, and it can
   * only be called with what the host itself produced.
   */
  onTick(handler: (clockJson: string, eventsJson: string) => void): void;

  /** The shared clock, in milliseconds. Not `Date.now` — see ADR 0015. */
  now(): number;

  /** The seeded generator. Not `Math.random`. */
  random(): number;
}

/**
 * The module name a place's source imports the guest library by.
 *
 * A single specifier rather than a relative path, because it is not a file: there is one
 * guest library, it is not the place's own, and a place should not be able to shadow it
 * with a file of its own that happens to be named the same thing.
 */
export const GUEST_MODULE = "voxelscape";

/**
 * The reserved specifier that hands a script the host's own object.
 *
 * **Refused in `bundle.ts`, and deliberately.** It exists so that the bundler's resolution
 * rules have a stated answer for it, and so that a place which reaches for it fails with
 * "not available" rather than resolving to something it should not have. Nothing may use it.
 */
export const RESERVED_HOST_MODULE = "engine-host";
