/**
 * The clock: what hour it is, and what the console does to that.
 *
 * `day-night.ts` answers "what does the light look like at second `t` of the cycle"
 * and knows nothing about time passing. This owns the passage of time — the elapsed
 * seconds, the console's ability to pin them, and the speed they run at — and answers
 * that question once a frame.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape/src/environment/day-night-controller.ts`,
 * which carries the same triple of `(elapsed, timeOverride, timeSpeed)`. What did not
 * come across is everything the reference's controller does to the scene: it owns two
 * `Light`s and four billboard meshes and writes to them inside `tick`. voxelscape's
 * ADR 0003 exists to keep that from spreading, and the rule it states is that things
 * which *produce* state do not reach into things that *consume* it.
 *
 * So `tick` returns a `DayNightState` and holds no reference to any material at all.
 * `app.tsx` owns both and writes the state into the sky, the terrain, the water and
 * the fog itself — which is the same five assignments the frame loop already had, kept
 * where they are because they are the seam. A clock that could set the colours would
 * have to know how many consumers there are and what they are called, and the answer
 * would change every time a lit material was added.
 *
 * There is exactly one clock per scene, and everything that needs the time of day takes
 * its state from the same `tick` — a consumer that derived its own hour would be a
 * second answer to the same question.
 */

import {
  CYCLE_SECONDS,
  dayNightState,
  phaseAt,
  type DayNightState,
} from "./day-night";

/** A clock's three numbers, as `/clock:state` reports them and as a tick reads them. */
export interface ClockState {
  /**
   * Seconds the live clock has accumulated, unwrapped.
   *
   * Kept advancing under an override, so releasing one returns to the hour the world
   * would have reached rather than to the one it was pinned at — which is the
   * difference between "pause the sky" and "pause the world".
   *
   * **Not the second the light is read from.** The `DayNightState` a tick returns
   * reports the shown second in its own `elapsed`, so that everything a frame draws
   * reads one clock: a pinned sky has its cloud drift pinned with it rather than
   * sliding under a frozen light.
   */
  readonly elapsed: number;
  /** The second the clock is pinned to, or `undefined` while it runs live. */
  readonly timeOverride: number | undefined;
  /** How many times real time the clock runs at. Zero holds it still. */
  readonly timeSpeed: number;
}

/**
 * Owns the passage of time and nothing else.
 *
 * Three numbers, five methods, and no reference to anything that draws: the whole of
 * it is small enough to read in one sitting, which is the point of keeping the
 * material's five assignments in `app.tsx` rather than here.
 */
export class DayNightController {
  private elapsed = 0;
  private timeOverride: number | undefined;
  private timeSpeed = 1;

  /**
   * Advances the clock and returns the light for the new hour.
   *
   * @param dt - Real seconds since the last tick. The caller's own clamped `dt`, so
   *   that a frame which took a second does not jump the sky a second with it.
   * @returns Everything the frame's materials need, from one derivation.
   */
  tick(dt: number): DayNightState {
    this.elapsed += dt * this.timeSpeed;
    return dayNightState(this.shownTime());
  }

  /** The clock's own numbers, whether it is running or pinned. */
  get state(): ClockState {
    return {
      elapsed: this.elapsed,
      timeOverride: this.timeOverride,
      timeSpeed: this.timeSpeed,
    };
  }

  /**
   * The second the clock is showing, in milliseconds.
   *
   * **What a place's events are timestamped with.** Reading `Date.now()` here instead would
   * be the obvious thing and would break convergence: two peers a few hundred milliseconds
   * apart order the same facts differently and never re-converge (ADR 0016). So the shared
   * clock *is* the clock that draws the sky, which means a place's events and a place's
   * light cannot disagree about what time it is.
   *
   * `shownTime()` rather than `elapsed`, because a pinned sky is pinned for its events too —
   * the same rule the `tick` doc comment states for the light.
   */
  nowMs(): number {
    return this.shownTime() * 1000;
  }

  /**
   * Pins the clock to a second of the cycle.
   *
   * Not clamped to the cycle: `dayNightState` wraps, so a second outside the cycle is
   * a second in it, and answering a player who asked for 1500 with a usage line would
   * be inventing a restriction the sky does not have.
   *
   * @param seconds - Where in the 1200-second cycle to hold the light.
   */
  jumpTo(seconds: number): void {
    this.timeOverride = seconds;
  }

  /**
   * Releases the pin, and the clock resumes from the hour it had reached live.
   *
   * A separate method rather than `jumpTo(elapsed)` because the two are not the same
   * statement: this one says "the world carries on" and the other says "the world is at
   * this instant", and they differ by however long the pin was held.
   */
  clearOverride(): void {
    this.timeOverride = undefined;
  }

  /**
   * Runs the clock at `multiplier` times real time.
   *
   * Zero holds the hour without pinning it, which is the difference between a paused
   * sky and a frozen one: `elapsed` keeps its value, and `/clock:live` resumes from it.
   * Negative speeds run the day backwards, and are allowed — the model is a closed
   * cycle, so there is nothing to be gained by refusing.
   *
   * @param multiplier - 1 is real time, 0 pauses, 10 fast-forwards a whole day.
   */
  setSpeed(multiplier: number): void {
    this.timeSpeed = multiplier;
  }

  /** One line describing where the clock is, for `/clock:state`. */
  describe(): string {
    const shown = this.shownTime();
    const phase = phaseAt(shown);
    const speed = `${this.timeSpeed}×`;
    const pinned = this.timeOverride === undefined ? "live" : "pinned";
    return `phase: ${phase} | t=${shown.toFixed(1)}s of ${CYCLE_SECONDS} | speed=${speed} | ${pinned}`;
  }

  /** The second the light is currently derived from, which is not `elapsed` if pinned. */
  private shownTime(): number {
    return this.timeOverride ?? this.elapsed;
  }
}
