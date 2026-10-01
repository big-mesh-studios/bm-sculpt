/**
 * The command table, built over a pair of spies standing in for the game's own
 * methods. Everything except `/fullscreen` reaches nothing but those two, which
 * is what makes this table testable without a world, a renderer or a browser.
 */

import { describe, expect, it } from "vitest";

import { createCommands, type CommandOutput, type Commander } from "./commands";

interface Table {
  commander: Commander;
  /** Every value each setter was called with, in order; `undefined` is a flip. */
  flying: (boolean | undefined)[];
  noclip: (boolean | undefined)[];
}

const table = (): Table => {
  const flying: (boolean | undefined)[] = [];
  const noclip: (boolean | undefined)[] = [];
  const commander = createCommands({
    setFlying: (value) => {
      flying.push(value);
      return value === false ? "walking" : "flying";
    },
    setNoClip: (value) => {
      noclip.push(value);
      return value === false ? "collisions on" : "no-clip";
    },
  });
  return { commander, flying, noclip };
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
      "/player:fly",
      "/player:no-clip",
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

describe("/clear", () => {
  it("says nothing of its own, so the console has nothing to print", () => {
    expect(text(table(), "/clear")).toBe("");
  });
});
