/**
 * The command table, built over a pair of spies standing in for the game's own
 * methods and a recorder standing in for the clock. Everything except `/fullscreen`
 * reaches nothing but those three, which is what makes this table testable without a
 * world, a renderer or a browser.
 */

import { describe, expect, it } from "vitest";

import {
  CYCLE_SECONDS,
  dayNightState,
  phaseAt,
  phasePreset,
} from "../world/day-night";
import { createCommands, type CommandOutput, type Commander } from "./commands";

/** Every call the fake clock was asked to make, in order. */
type ClockCalls =
  | { kind: "jumpTo"; seconds: number }
  | { kind: "clearOverride" }
  | { kind: "setSpeed"; multiplier: number }
  | { kind: "describe" };

/** Every call the fake cloud layer was asked to make, in order. */
type CloudCalls =
  | { kind: "coverage"; value: number | undefined }
  | { kind: "density"; value: number | undefined }
  | { kind: "state" };

interface Table {
  commander: Commander;
  /** Every value each setter was called with, in order; `undefined` is a flip. */
  flying: (boolean | undefined)[];
  noclip: (boolean | undefined)[];
  /** Every altitude `/player:space` was called with, in order; `undefined` is the default. */
  space: (number | undefined)[];
  clock: ClockCalls[];
  cloud: CloudCalls[];
  /** What the fake layer reports, so a test can pretend it does not exist yet. */
  built: { value: boolean };
}

const table = (): Table => {
  const flying: (boolean | undefined)[] = [];
  const noclip: (boolean | undefined)[] = [];
  const space: (number | undefined)[] = [];
  const clock: ClockCalls[] = [];
  const cloud: CloudCalls[] = [];
  const built = { value: true };
  // A two-field layer: the same shape `app.tsx` hands over, so the numbers this table
  // prints are the numbers a real material would hold.
  let coverage = 0.52;
  let density = 1;
  const absent = "no cloud layer yet — the field is still baking";
  const commander = createCommands({
    setFlying: (value) => {
      flying.push(value);
      return value === false ? "walking" : "flying";
    },
    setNoClip: (value) => {
      noclip.push(value);
      return value === false ? "collisions on" : "no-clip";
    },
    toSpace: (value) => {
      space.push(value);
      return value === undefined
        ? "in space at the default altitude; flight on"
        : `in space at ${value} units above the sea; flight on`;
    },
    clock: {
      jumpTo: (seconds) => void clock.push({ kind: "jumpTo", seconds }),
      clearOverride: () => void clock.push({ kind: "clearOverride" }),
      setSpeed: (multiplier) =>
        void clock.push({ kind: "setSpeed", multiplier }),
      describe: () => {
        clock.push({ kind: "describe" });
        return "phase: day | t=300.0s | speed=1× | live";
      },
    },
    cloud: {
      coverage: (value) => {
        cloud.push({ kind: "coverage", value });
        if (!built.value) return absent;
        if (value !== undefined) coverage = value;
        return `coverage ${coverage.toFixed(3)}`;
      },
      density: (value) => {
        cloud.push({ kind: "density", value });
        if (!built.value) return absent;
        if (value !== undefined) density = value;
        return `density ${density.toFixed(3)}`;
      },
      state: () => {
        cloud.push({ kind: "state" });
        return built.value
          ? `built | coverage ${coverage.toFixed(3)} | density ${density.toFixed(3)}`
          : absent;
      },
    },
  });
  return { commander, flying, noclip, space, clock, cloud, built };
};

/** Runs a line and insists the answer is text rather than `/help`'s table. */
const text = (recorder: Table, line: string): string => {
  const output: CommandOutput = recorder.commander.run(line);
  if (typeof output !== "string") {
    throw new Error(`expected text, got the /help table for "${line}"`);
  }
  return output;
};

describe("the command table", () => {
  it("lists /help first, then every command with what it takes", () => {
    const help = table().commander.help();
    expect(help[0]).toEqual({
      name: "/help",
      description: "list every command",
    });
    expect(help.map((command) => command.name)).toEqual([
      "/help",
      "/clock:day",
      "/clock:sunset",
      "/clock:night",
      "/clock:sunrise",
      "/clock:time",
      "/clock:speed",
      "/clock:live",
      "/clock:state",
      "/cloud:coverage",
      "/cloud:density",
      "/cloud:state",
      "/player:fly",
      "/player:no-clip",
      "/player:space",
      "/fullscreen",
      "/clear",
    ]);
    const fly = help.find((command) => command.name === "/player:fly");
    expect(fly?.args).toBe("[on|off]");
  });

  it("answers an unknown command with the line itself and a nudge to /help", () => {
    expect(text(table(), "/player:telep")).toBe(
      'unknown command "/player:telep" — try /help',
    );
  });

  it("ignores surrounding space and case in what it is given", () => {
    const recorder = table();
    expect(text(recorder, "  /PLAYER:FLY  ON  ")).toBe("flying");
    expect(recorder.flying).toEqual([true]);
  });

  it("answers /help with the table rather than with text", () => {
    const recorder = table();
    expect(recorder.commander.run("/help")).toEqual(recorder.commander.help());
  });
});

describe("/player:fly", () => {
  it("turns flight on and off when told which", () => {
    const recorder = table();
    expect(text(recorder, "/player:fly on")).toBe("flying");
    expect(text(recorder, "/player:fly off")).toBe("walking");
    expect(recorder.flying).toEqual([true, false]);
  });

  it("flips flight when given no argument at all", () => {
    const recorder = table();
    text(recorder, "/player:fly");
    expect(recorder.flying).toEqual([undefined]);
  });

  it("answers a usage line rather than guessing at a third argument", () => {
    const recorder = table();
    expect(text(recorder, "/player:fly maybe")).toBe(
      "usage: /player:fly [on|off]  (no argument flips it)",
    );
    // Nothing reached the game: a guess would have moved the player.
    expect(recorder.flying).toEqual([]);
  });
});

describe("/player:no-clip", () => {
  it("turns no-clip on and off when told which", () => {
    const recorder = table();
    expect(text(recorder, "/player:no-clip on")).toBe("no-clip");
    expect(text(recorder, "/player:no-clip off")).toBe("collisions on");
    expect(recorder.noclip).toEqual([true, false]);
  });

  it("flips no-clip when given no argument at all", () => {
    const recorder = table();
    text(recorder, "/player:no-clip");
    expect(recorder.noclip).toEqual([undefined]);
  });

  it("answers a usage line rather than guessing at a third argument", () => {
    const recorder = table();
    expect(text(recorder, "/player:no-clip yes")).toBe(
      "usage: /player:no-clip [on|off]  (no argument flips it)",
    );
    expect(recorder.noclip).toEqual([]);
  });

  it("is reached only by the name it declares", () => {
    // The name is the hyphenated one, which is also the only one completion can
    // ever produce. An underscore is what a player types when their finger
    // misses it, and it is a guess rather than a command.
    const recorder = table();
    expect(text(recorder, "/player:no-clip")).toBe("no-clip");
    expect(text(recorder, "/player:no_clip")).toContain("unknown command");
  });
});

describe("/player:space", () => {
  it("sends the player up with the game's own default when given no altitude", () => {
    const recorder = table();
    expect(text(recorder, "/player:space")).toContain("default altitude");
    // `undefined` is the signal to use the default, so the number lives in one place rather than
    // being repeated here and in the command.
    expect(recorder.space).toEqual([undefined]);
  });

  it("passes an explicit altitude through", () => {
    const recorder = table();
    expect(text(recorder, "/player:space 40000")).toBe(
      "in space at 40000 units above the sea; flight on",
    );
    expect(recorder.space).toEqual([40000]);
  });

  it("refuses anything that is not an altitude rather than guessing", () => {
    const recorder = table();
    expect(text(recorder, "/player:space high")).toBe(
      "usage: /player:space [altitude]  (0 or more, world units)",
    );
    // A negative altitude would put the player inside the planet, which is not what the command
    // is for, so `readNumber`'s minimum rejects it.
    expect(text(recorder, "/player:space -100")).toBe(
      "usage: /player:space [altitude]  (0 or more, world units)",
    );
    expect(recorder.space).toEqual([]);
  });
});

describe("/clear", () => {
  it("says nothing of its own, so the console has nothing to print", () => {
    expect(text(table(), "/clear")).toBe("");
  });
});

describe("the phase jumps", () => {
  const jumpsTo = (recorder: Table, line: string): number => {
    text(recorder, line);
    const last = recorder.clock.at(-1);
    if (last?.kind !== "jumpTo") {
      throw new Error(`expected ${line} to jump the clock`);
    }
    return last.seconds;
  };

  it("lands in the phase each command is named for", () => {
    // The property the four commands exist for. voxelscape's were literal seconds —
    // 300, 645, 900, 1120 — which stopped meaning what their names said the moment
    // the sun path became a solar model. A jump that lands in daylight while the
    // console says dusk is not a subtle artefact.
    for (const phase of ["day", "sunset", "night", "sunrise"] as const) {
      const recorder = table();
      const seconds = jumpsTo(recorder, `/clock:${phase}`);
      expect(phaseAt(seconds), `/clock:${phase}`).toBe(phase);
    }
  });

  it("asks the model where the phase is rather than carrying its own seconds", () => {
    // Held against `phasePreset` itself, so the table and the model cannot drift
    // apart even if the model changes underneath both.
    for (const phase of ["day", "sunset", "night", "sunrise"] as const) {
      expect(jumpsTo(table(), `/clock:${phase}`)).toBe(phasePreset(phase));
    }
  });

  it("reports the second it landed on, because dusk is a fifth of the cycle", () => {
    // "jumped to dusk" on its own leaves a player unable to say which dusk, and
    // `/clock:state` is a second command to consult. The number is in the line.
    const recorder = table();
    const reported = text(recorder, "/clock:sunset");
    const seconds = phasePreset("sunset");
    expect(reported).toBe(`jumped to dusk (t=${seconds.toFixed(1)}s)`);
    // And the sun really is low there, not merely labelled so.
    expect(dayNightState(seconds).sunElevation).toBeLessThan(0);
  });

  it("names the phase in words rather than as the model's own word", () => {
    const recorder = table();
    expect(text(recorder, "/clock:day")).toContain("noon");
    expect(text(recorder, "/clock:sunrise")).toContain("dawn");
    expect(text(recorder, "/clock:night")).toContain("midnight");
  });

  it("ignores an argument, because a jump has nothing to read", () => {
    // The reference's `/clock:day` took no arguments either, and a silent one is
    // better than an error line for a command with no second reading — a player who
    // types `/clock:day 645` wanted the jump and has got it.
    const recorder = table();
    expect(jumpsTo(recorder, "/clock:day 645")).toBe(phasePreset("day"));
  });
});

describe("/clock:time", () => {
  it("pins the clock to the second it was given", () => {
    const recorder = table();
    expect(text(recorder, "/clock:time 645")).toBe("time set to 645s");
    expect(recorder.clock).toEqual([{ kind: "jumpTo", seconds: 645 }]);
  });

  it("takes a second outside the cycle, because the sky wraps", () => {
    // The cycle is a closed one, so 1500 is 300 and refusing it would be inventing a
    // restriction the model does not have. What the console cannot do is pin the sky
    // to a number it cannot add.
    const recorder = table();
    text(recorder, `/clock:time ${CYCLE_SECONDS * 3}`);
    expect(recorder.clock).toEqual([{ kind: "jumpTo", seconds: 3600 }]);
  });

  it("refuses anything that is not a number, and says what it wants", () => {
    // `Number("")` is 0 and `Number("12px")` is `NaN`, so the validation is explicit.
    // The failure it prevents is a clock pinned to `NaN`, which is a `NaN` in every
    // colour uniform in the frame and a black screen with nothing in the log.
    const recorder = table();
    for (const line of [
      "/clock:time",
      "/clock:time soon",
      "/clock:time 12px",
      "/clock:time Infinity",
    ]) {
      expect(text(recorder, line), line).toBe(
        `usage: /clock:time <seconds>  (0..${CYCLE_SECONDS}, wraps)`,
      );
    }
    expect(recorder.clock).toEqual([]);
  });
});

describe("/clock:speed", () => {
  it("runs the clock at the multiplier it was given", () => {
    const recorder = table();
    expect(text(recorder, "/clock:speed 10")).toBe("clock speed set to 10×");
    expect(recorder.clock).toEqual([{ kind: "setSpeed", multiplier: 10 }]);
  });

  it("pauses at zero rather than refusing it", () => {
    // Zero is the pause, and it is the one value a speed argument can take that is
    // also the one a guard on sign would throw away.
    const recorder = table();
    text(recorder, "/clock:speed 0");
    expect(recorder.clock).toEqual([{ kind: "setSpeed", multiplier: 0 }]);
  });

  it("refuses a negative speed and anything that is not a number", () => {
    // The clock runs backwards perfectly well — the model is a closed cycle, so there
    // is nothing to get wrong — but a console that handed a player a sunlit midnight
    // has handed them a way to file a bug about the sky, and `/clock:speed -1` is a
    // typo rather than a request.
    const recorder = table();
    for (const line of [
      "/clock:speed",
      "/clock:speed fast",
      "/clock:speed -1",
    ]) {
      expect(text(recorder, line), line).toBe(
        "usage: /clock:speed <multiplier>  (0 pauses, 1 = real time)",
      );
    }
    expect(recorder.clock).toEqual([]);
  });
});

describe("/clock:live and /clock:state", () => {
  it("releases the pin", () => {
    const recorder = table();
    expect(text(recorder, "/clock:live")).toBe("resumed the live clock");
    expect(recorder.clock).toEqual([{ kind: "clearOverride" }]);
  });

  it("reports the clock's own description, verbatim", () => {
    // One line, and it is the clock's: `/clock:state` is a query rather than an
    // action, and a command table that re-derived the phase would be a second answer
    // to a question there is already one answer to.
    const recorder = table();
    expect(text(recorder, "/clock:state")).toBe(
      "phase: day | t=300.0s | speed=1× | live",
    );
    expect(recorder.clock).toEqual([{ kind: "describe" }]);
  });
});

describe("the cloud commands", () => {
  it("reports coverage and density when given nothing", () => {
    const recorder = table();
    expect(text(recorder, "/cloud:coverage")).toBe("coverage 0.520");
    expect(text(recorder, "/cloud:density")).toBe("density 1.000");
    // A read reaches the layer with `undefined`, which is how it tells "report this"
    // from "set this" — the same convention `/player:fly` uses for its own flip.
    expect(recorder.cloud).toEqual([
      { kind: "coverage", value: undefined },
      { kind: "density", value: undefined },
    ]);
  });

  it("sets either one, and the new value is what it then reports", () => {
    // The whole point of these two commands: the layer's defaults have never been looked
    // at by anyone, and the only way to find out what they look like used to be editing a
    // constant and rebuilding. A player can now find out with a keystroke.
    const recorder = table();
    expect(text(recorder, "/cloud:coverage 0.8")).toBe("coverage 0.800");
    expect(text(recorder, "/cloud:coverage")).toBe("coverage 0.800");
    expect(text(recorder, "/cloud:density 2")).toBe("density 2.000");
    expect(text(recorder, "/cloud:state")).toBe(
      "built | coverage 0.800 | density 2.000",
    );
  });

  it("takes the ends of the range, because those are the interesting ones", () => {
    const recorder = table();
    expect(text(recorder, "/cloud:coverage 0")).toBe("coverage 0.000");
    expect(text(recorder, "/cloud:coverage 1")).toBe("coverage 1.000");
  });

  it("refuses a coverage outside 0 to 1 rather than clamping it", () => {
    // A clamp would report a value the player did not ask for, which is the whole
    // failure mode `readToggle` was written to avoid.
    const recorder = table();
    for (const line of [
      "/cloud:coverage 1.5",
      "/cloud:coverage -0.2",
      "/cloud:coverage most",
    ]) {
      expect(text(recorder, line), line).toBe("usage: /cloud:coverage [0..1]");
    }
    expect(recorder.cloud).toEqual([]);
  });

  it("refuses a negative density, and takes a density above one", () => {
    const recorder = table();
    expect(text(recorder, "/cloud:density -1")).toBe(
      "usage: /cloud:density [multiplier]  (0 or more)",
    );
    expect(text(recorder, "/cloud:density lots")).toBe(
      "usage: /cloud:density [multiplier]",
    );
    expect(recorder.cloud).toEqual([]);
  });

  it("says the layer does not exist yet, rather than reporting zeroes", () => {
    // The layer is null for the second or so the bake takes, and a `/cloud:coverage`
    // answered with "coverage 0.000" would read as a cleared sky — which is a bug the
    // player would go looking for in the wrong place.
    const recorder = table();
    recorder.built.value = false;
    for (const line of [
      "/cloud:coverage",
      "/cloud:density",
      "/cloud:coverage 0.9",
      "/cloud:state",
    ]) {
      expect(text(recorder, line), line).toBe(
        "no cloud layer yet — the field is still baking",
      );
    }
  });

  it("reports the whole layer at once with /cloud:state", () => {
    const recorder = table();
    expect(text(recorder, "/cloud:state")).toBe(
      "built | coverage 0.520 | density 1.000",
    );
    expect(recorder.cloud).toEqual([{ kind: "state" }]);
  });
});

describe("the clock commands", () => {
  it("are reachable by scope boundary, which is what completion offers", () => {
    // Every name shares the `/clock:` prefix, so tabbing to that prefix is a real
    // choice — eight commands to make at once — and the second tab walks them. The
    // test is that the prefix is there, since the completion code offers nothing at
    // all if it is not.
    const names = table()
      .commander.help()
      .map((command) => command.name);
    expect(names.filter((name) => name.startsWith("/clock:"))).toHaveLength(8);
  });

  it("take no argument a jump would ignore", () => {
    const help = table().commander.help();
    const withArgs = help
      .filter((command) => command.name.startsWith("/clock:"))
      .filter((command) => command.args !== undefined)
      .map((command) => command.name);
    expect(withArgs).toEqual(["/clock:time", "/clock:speed"]);
  });
});

/**
 * `with`, for the tables that are not the application's own commands.
 *
 * `/place:` is the one that exists, and the point of these tests is that merging it is
 * invisible: the merged table runs both, `/help` lists both, and nothing about the game's
 * thirty-odd commands had to change.
 */
describe("merging a second command table", () => {
  const extra = {
    "/place:list": {
      description: "list the places this build ships",
      run: () => "shipped places:\n  bridge",
    },
  };

  it("runs the commands that were added", () => {
    expect(table().commander.with(extra).run("/place:list")).toBe(
      "shipped places:\n  bridge",
    );
  });

  it("still runs the ones that were already there", () => {
    expect(table().commander.with(extra).run("/help")).toBeDefined();
    expect(table().commander.with(extra).run("/clock:day")).toBeDefined();
  });

  it("lists both in /help, and says /help first", () => {
    const names = table()
      .commander.with(extra)
      .help()
      .map((command) => command.name);
    expect(names[0]).toBe("/help");
    expect(names).toContain("/place:list");
    expect(names).toContain("/clock:day");
  });

  it("carries the added command's own description and args", () => {
    const added = table()
      .commander.with({
        "/place:load": {
          description: "load a place",
          args: "<id>",
          run: () => "loaded",
        },
      })
      .help()
      .find((command) => command.name === "/place:load");
    expect(added).toEqual({
      name: "/place:load",
      args: "<id>",
      description: "load a place",
    });
  });

  it("does not let the added table redefine an existing command", () => {
    // The application's own table cannot be overwritten by whatever a later
    // feature adds. Nothing reports the collision — both tables are written in
    // this repo — but `/help` must still describe the command that runs.
    const merged = table().commander.with({
      "/clock:day": { description: "hijacked", run: () => "hijacked" },
    });
    expect(merged.run("/clock:day")).not.toBe("hijacked");
    expect(
      merged.help().find((command) => command.name === "/clock:day")
        ?.description,
    ).not.toBe("hijacked");
  });

  it("leaves the table it was called on alone", () => {
    const base = table().commander;
    base.with(extra);
    // Merging returns a new table rather than adding to this one, so a second
    // merge of the same extra cannot accumulate duplicates.
    expect(base.help().map((command) => command.name)).not.toContain(
      "/place:list",
    );
  });

  it("puts the added commands first in /help", () => {
    // **Order is what makes `/help` readable at thirty-six entries.** The place
    // commands are a small block and the game's own are the long tail, and the
    // added ones land before them because they were spread in first.
    const names = table()
      .commander.with(extra)
      .help()
      .map((command) => command.name);
    expect(names[1]).toBe("/place:list");
  });

  it("returns a promise when a command hands one back", async () => {
    const merged = table().commander.with({
      "/place:load": {
        description: "load a place",
        run: () => Promise.resolve("loaded bridge"),
      },
    });
    await expect(merged.run("/place:load")).resolves.toBe("loaded bridge");
  });
});
