import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  NOON_SECONDS,
  dayNightState,
  phaseAt,
  phasePreset,
} from "./day-night";
import { DayNightController } from "./day-night-controller";

/**
 * The clock, on the host, and with no renderer in it at all.
 *
 * The controller exists to hold three numbers and nothing else, so the tests here are
 * about the *rules* those three numbers obey — which of them the light is read from,
 * what a pin does to the elapsed time underneath it, and what a speed of zero means —
 * rather than about the light, which `day-night.test.ts` already covers exhaustively.
 *
 * The last test is the one that keeps this file honest. The controller must not grow a
 * reference to a material, and the only way that fails is quietly: someone adds
 * `dayNight.applyTo(material)` one day and every test here still passes.
 */

/** A controller advanced to `seconds` of real time, in one-second ticks. */
const clockAt = (seconds: number): DayNightController => {
  const clock = new DayNightController();
  for (let i = 0; i < seconds; i++) clock.tick(1);
  return clock;
};

describe("the live clock", () => {
  it("opens on the start of the cycle, which is a sunrise", () => {
    // The cycle is built to open on dawn — a world that loads onto a sunrise is a
    // better first frame than one that loads onto the small hours — so the first frame
    // a controller derives has to be that and not merely some hour.
    const clock = new DayNightController();
    expect(clock.tick(0).phase).toBe("sunrise");
  });

  it("advances on real time and reports the same second the sun does", () => {
    const clock = clockAt(300);
    const state = clock.tick(0);
    expect(state.elapsed).toBe(300);
    expect(state).toEqual(dayNightState(300));
    expect(state.phase).toBe("day");
  });

  it("keeps counting past a whole cycle rather than wrapping", () => {
    // The state's own `elapsed` is unwrapped so a consumer can count days; the light
    // wraps inside it. Two and a half turns is more than one cycle and less than the
    // point where the number itself loses its meaning.
    const clock = clockAt(CYCLE_SECONDS + 42);
    const state = clock.tick(0);
    expect(state.elapsed).toBe(CYCLE_SECONDS + 42);
    expect(state.sunDir).toEqual(dayNightState(42).sunDir);
  });

  it("scales its own advance by the speed", () => {
    const clock = new DayNightController();
    clock.setSpeed(10);
    expect(clock.tick(30).elapsed).toBe(300);
    clock.setSpeed(0.25);
    expect(clock.tick(30).elapsed).toBe(307.5);
  });

  it("runs backwards as readily as forwards", () => {
    // The model is a closed cycle, so a negative speed has nothing to get wrong. The
    // console refuses one, and this is why that refusal is a presentation choice
    // rather than a guard.
    const clock = new DayNightController();
    clock.setSpeed(-1);
    const state = clock.tick(10);
    expect(state.elapsed).toBe(-10);
    expect(state.sunDir).toEqual(dayNightState(-10).sunDir);
  });
});

describe("holding the hour", () => {
  it("reads the light from the pin rather than from elapsed time", () => {
    const clock = clockAt(300);
    clock.jumpTo(NOON_SECONDS);
    const state = clock.tick(60);
    // The live clock carried on underneath...
    expect(clock.state.elapsed).toBe(360);
    // ...and the state a material is given reports the hour it was derived from, not
    // the hour underneath. That is what makes a pin hold the whole sky: the clouds
    // drift on `state.elapsed` too, so a pinned sky has stopped moving in every
    // direction rather than in the light's alone.
    expect(state.elapsed).toBe(NOON_SECONDS);
    expect(state.sunDir).toEqual(dayNightState(NOON_SECONDS).sunDir);
  });

  it("stays pinned however long it is held and however fast time runs", () => {
    const clock = clockAt(300);
    clock.jumpTo(NOON_SECONDS);
    clock.setSpeed(1000);
    for (let i = 0; i < 20; i++) expect(clock.tick(1).phase).toBe("day");
  });

  it("keeps advancing underneath, so releasing resumes the hour it reached", () => {
    // The distinction that matters and that `jumpTo(elapsed)` cannot express: a pinned
    // sky is not a paused world. Forty seconds of live time pass while the light is
    // held, and the clock resumes from where it had got to rather than from where it
    // was held.
    const clock = clockAt(100);
    clock.jumpTo(NOON_SECONDS);
    clock.tick(40);
    expect(clock.state.elapsed).toBe(140);

    clock.clearOverride();
    expect(clock.tick(0).elapsed).toBe(140);
    expect(clock.tick(0).phase).toBe(phaseAt(140));
  });

  it("takes a second outside the cycle and wraps it, as the sky does", () => {
    const clock = clockAt(300);
    clock.jumpTo(NOON_SECONDS + CYCLE_SECONDS);
    expect(clock.tick(0).sunDir).toEqual(dayNightState(NOON_SECONDS).sunDir);
    clock.jumpTo(-100);
    expect(clock.tick(0).sunDir).toEqual(dayNightState(-100).sunDir);
  });

  it("freezes without pinning at a speed of zero, and lives again at one", () => {
    const clock = clockAt(300);
    clock.setSpeed(0);
    expect(clock.tick(50).elapsed).toBe(300);
    // Still live: no pin was taken, so `describe` says so and there is nothing to
    // release. That is the whole difference between a paused hour and a held one.
    expect(clock.state.timeOverride).toBeUndefined();

    clock.setSpeed(1);
    expect(clock.tick(50).elapsed).toBe(350);
  });
});

describe("the clock's own numbers", () => {
  it("reports the triple the day is derived from", () => {
    const clock = new DayNightController();
    expect(clock.state).toEqual({
      elapsed: 0,
      timeOverride: undefined,
      timeSpeed: 1,
    });
    clock.tick(12);
    expect(clock.state.elapsed).toBe(12);
    clock.setSpeed(3);
    clock.jumpTo(NOON_SECONDS);
    expect(clock.state).toEqual({
      elapsed: 12,
      timeOverride: NOON_SECONDS,
      timeSpeed: 3,
    });
  });

  it("describes the phase, the second and whether it is pinned", () => {
    const clock = new DayNightController();
    expect(clock.describe()).toBe(
      `phase: sunrise | t=0.0s of ${CYCLE_SECONDS} | speed=1× | live`,
    );

    clock.tick(NOON_SECONDS);
    expect(clock.describe()).toBe(
      `phase: day | t=300.0s of ${CYCLE_SECONDS} | speed=1× | live`,
    );

    clock.jumpTo(phasePreset("sunset"));
    clock.setSpeed(0);
    const pinned = clock.describe();
    expect(pinned).toContain("phase: sunset");
    expect(pinned).toContain("speed=0×");
    expect(pinned).toContain("pinned");
  });

  it("reports a second rather than a wrapped one, because elapsed is unwrapped", () => {
    // The one place the two clocks disagree, and deliberately: `describe` is for a
    // player, who wants to know how far through the day they are and not what the
    // modulo is.
    const clock = clockAt(CYCLE_SECONDS * 3);
    expect(clock.describe()).toContain(`t=${(CYCLE_SECONDS * 3).toFixed(1)}s`);
  });
});

describe("what the controller must not hold", () => {
  it("carries no reference to anything that draws", () => {
    // voxelscape's ADR 0003: a thing that produces state does not reach into things
    // that consume it, because the second kind has to be enumerated in the first.
    // `app.tsx` owns the clock and the five materials and writes the state into them;
    // if the clock ever grows a `material` field, this is the test that says no.
    const clock = new DayNightController();
    const fields = Object.getOwnPropertyNames(clock).filter(
      (name) =>
        name !== "elapsed" && name !== "timeOverride" && name !== "timeSpeed",
    );
    expect(fields).toEqual([]);
  });

  it("exposes no surface a material could be passed to", () => {
    // The same rule from the other side. The reference's controller reaches its two
    // lights and four billboards through `tick`; a method named `update`, `applyTo` or
    // `bind` is how that would arrive here, and it is the whole difference between a
    // clock and a scene manager. `app.tsx` holds both, so it is the only thing that
    // should ever grow one.
    const reachesOutwards =
      /^(update|apply|applyTo|bind|attach|draw|render|set(Material|Scene|Light|World))/;
    const surface = Object.getOwnPropertyNames(
      DayNightController.prototype,
    ).filter((name) => name !== "constructor");
    expect(surface.filter((name) => reachesOutwards.test(name))).toEqual([]);
    expect(surface.length).toBeGreaterThan(0);
  });
});

/**
 * `nowMs`, which is what a place's events are timestamped with.
 *
 * The property that matters is not the arithmetic — it is that this reads **the shared clock**
 * rather than the wall, and that it agrees with the light on screen.
 */
describe("the clock as a place's event time", () => {
  it("starts at zero", () => {
    expect(new DayNightController().nowMs()).toBe(0);
  });

  it("advances with the clock", () => {
    const clock = new DayNightController();
    clock.tick(2.5);
    expect(clock.nowMs()).toBe(2500);
  });

  it("advances at the clock's own speed, not at real time", () => {
    // **A paused sky is a paused world.** At 0x the clock is held still, and a
    // place's timers measured against real time would fire anyway — which is how
    // a place ends up building something while the player is looking at a frozen
    // afternoon.
    const clock = new DayNightController();
    clock.setSpeed(0);
    clock.tick(5);
    expect(clock.nowMs()).toBe(0);
  });

  it("runs at the clock's speed when it is not one", () => {
    const clock = new DayNightController();
    clock.setSpeed(4);
    clock.tick(2);
    expect(clock.nowMs()).toBe(8000);
  });

  it("reports the second that is shown, so a pinned clock pins the events too", () => {
    // **The same rule `tick` states for the light.** A pinned sky with events
    // running on would be a world where the sun is frozen and the lanterns are
    // not, and a place that times something to the day would be wrong by exactly
    // the amount the clock is pinned.
    const clock = new DayNightController();
    clock.tick(30);
    clock.jumpTo(NOON_SECONDS);
    expect(clock.nowMs()).toBe(NOON_SECONDS * 1000);
  });

  it("keeps running under a pin, so releasing it returns to where the world would be", () => {
    const clock = new DayNightController();
    clock.jumpTo(NOON_SECONDS);
    clock.tick(40);
    clock.clearOverride();
    // **Pinning the *light* is not pausing the world** — the distinction the
    // controller's own doc comment is about, and the reason `state.elapsed` and
    // `nowMs()` disagree while a pin is held.
    expect(clock.nowMs()).toBe(40_000);
  });

  it("agrees with the light it just produced", () => {
    // **One answer to "what hour is it".** Read the same frame twice — once as
    // the material would, once as a place's event would — and they must be the
    // same number, or a place reacting to the hour and a player seeing the hour
    // are looking at two different afternoons.
    const clock = new DayNightController();
    const light = clock.tick(137);
    expect(clock.nowMs()).toBe(light.elapsed * 1000);
  });
});
