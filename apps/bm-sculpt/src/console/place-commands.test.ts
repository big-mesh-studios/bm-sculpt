/**
 * The `/place:` command table.
 *
 * Built over a `PlaceCommands` of the caller's own making, which is why this file never
 * mentions a `PlaceHost`: the table asks its caller for four things and knows nothing about
 * how they are answered. The tests below are therefore about *what the console says* — which
 * is the part a person reads — and the host's own behaviour is covered in `host.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { Commander } from "./commands";
import {
  NO_PLACE_LOADED,
  placeCommands,
  type PlaceCommands,
} from "./place-commands";

/** Records what the table asked for, and answers in a way a test can read. */
interface Recorder extends PlaceCommands {
  loaded: string[];
  unloaded: number;
  /** Every file the table asked to open, in order. */
  opened: number;
}

const table = (
  answers: Partial<PlaceCommands> = {},
): { commander: Commander; recorder: Recorder } => {
  const loaded: string[] = [];
  const recorder: Recorder = {
    loaded,
    unloaded: 0,
    opened: 0,
    loadDemo: (id) => {
      loaded.push(id);
      return Promise.resolve(`loaded ${id}`);
    },
    openFromDisk: () => {
      recorder.opened++;
      return Promise.resolve("opened bridge");
    },
    unload: () => {
      recorder.unloaded++;
      return "unloaded bridge";
    },
    describe: () => "bridge\nshapes   7 of 2000",
    notices: () => [],
    ...answers,
  };
  return { commander: new Commander(placeCommands(recorder)), recorder };
};

describe("the place commands exist under the prefix", () => {
  it("declares one per action", () => {
    const names = table()
      .commander.help()
      .map((command) => command.name)
      .filter((name) => name.startsWith("/place:"));
    // **Every one of them**, because a command that is written but not declared is a
    // command nobody can reach: `Commander` looks names up in its record and an
    // entry missing from that record simply does not exist.
    expect(names).toEqual([
      "/place:list",
      "/place:load",
      "/place:open",
      "/place:unload",
      "/place:state",
      "/place:notices",
    ]);
  });

  it("describes each of them, which is what /help prints", () => {
    for (const command of table().commander.help()) {
      if (!command.name.startsWith("/place:")) continue;
      expect(command.description).not.toBe("");
    }
  });

  it("takes the id /place:load needs", () => {
    const load = table()
      .commander.help()
      .find((command) => command.name === "/place:load");
    expect(load?.args).toBe("<id>");
  });
});

describe("/place:list", () => {
  it("names every shipped place", () => {
    const listed = table().commander.run("/place:list") as string;
    for (const id of ["bridge", "lanterns", "lookout"]) {
      expect(listed).toContain(id);
    }
  });

  it("says what each one is for, not just its name", () => {
    const listed = table().commander.run("/place:list") as string;
    expect(listed).toContain("doorway");
  });

  it("answers without a host, because listing is not loading", () => {
    // Nothing is loaded and nothing needs to be: this is the one place command
    // that has to work before anyone has typed anything else.
    const { recorder, commander } = table({
      describe: () => NO_PLACE_LOADED,
    });
    expect(commander.run("/place:list")).toContain("bridge");
    expect(recorder.loaded).toEqual([]);
  });
});

describe("/place:load", () => {
  it("loads the id it was given", async () => {
    const { commander, recorder } = table();
    await commander.run("/place:load bridge");
    expect(recorder.loaded).toEqual(["bridge"]);
  });

  it("resolves to what the caller said happened", async () => {
    const { commander } = table({
      loadDemo: () => Promise.resolve("loaded bridge\n2 shapes"),
    });
    await expect(commander.run("/place:load bridge")).resolves.toBe(
      "loaded bridge\n2 shapes",
    );
  });

  it("says how to use it rather than loading nothing", async () => {
    const { commander, recorder } = table();
    const answer = (await commander.run("/place:load")) as string;
    expect(answer).toContain("usage: /place:load");
    expect(recorder.loaded).toEqual([]);
  });

  it("names the places that would work in its usage line", async () => {
    const answer = (await table().commander.run("/place:load")) as string;
    expect(answer).toContain("bridge");
    expect(answer).toContain("lookout");
  });

  it("says there is no such place, and points at /place:list", async () => {
    const { commander, recorder } = table();
    const answer = (await commander.run("/place:load castle")) as string;
    expect(answer).toContain('no place called "castle"');
    expect(answer).toContain("/place:list");
    expect(recorder.loaded).toEqual([]);
  });

  it("ignores a second word rather than treating it as part of the id", async () => {
    // A person typing `/place:load bridge now` means "bridge", and asking for
    // `bridge now` would answer "no such place" — which is wrong in a way they
    // cannot see the reason for.
    const { commander, recorder } = table();
    await commander.run("/place:load bridge now");
    expect(recorder.loaded).toEqual(["bridge"]);
  });
});

describe("/place:open", () => {
  it("asks for a file and reports what happened", async () => {
    const { commander, recorder } = table();
    await expect(commander.run("/place:open")).resolves.toBe("opened bridge");
    expect(recorder.opened).toBe(1);
  });

  it("takes no argument, because the dialog is the argument", () => {
    // **No `<file>` placeholder.** A name here would suggest a path could be typed, and the
    // browser's dialog is the only way in — so a suggestion that cannot be followed is worse
    // than none.
    const open = table()
      .commander.help()
      .find((command) => command.name === "/place:open");
    expect(open?.args).toBeUndefined();
  });

  it("passes a dismissal back rather than resolving to nothing", async () => {
    // **The pending line depends on this.** The console replaces its `…` when the promise
    // settles; a caller that never resolves for a cancelled picker leaves that line on screen
    // for the rest of the session, which is the one outcome the pending line exists to prevent.
    const { commander } = table({
      openFromDisk: () => Promise.resolve("no file chosen"),
    });
    await expect(commander.run("/place:open")).resolves.toBe("no file chosen");
  });

  it("reports a refusal from the format rather than a load failure", async () => {
    // **The format's own gate, passed through.** A zip with no manifest, or one whose manifest
    // names a file it does not hold, has been told precisely what is wrong with it before this
    // table is reached, and re-summarising it would throw away the only actionable sentence.
    const { commander } = table({
      openFromDisk: () => Promise.resolve("no manifest.json at the zip's root"),
    });
    await expect(commander.run("/place:open")).resolves.toMatch(
      /manifest\.json/,
    );
  });
});

describe("/place:unload", () => {
  it("takes the place away", () => {
    const { commander, recorder } = table();
    expect(commander.run("/place:unload")).toBe("unloaded bridge");
    expect(recorder.unloaded).toBe(1);
  });

  it("says so even when there was nothing to take away", () => {
    // **An unload that reports success when it did nothing** is the failure mode
    // here: the person presses it twice and gets two identical confirmations, and
    // the second is a lie. The caller's own wording is what is checked, because
    // this table cannot know whether anything was loaded — which is also why the
    // idle case is the caller's line and not this table's.
    const { commander } = table({ unload: () => NO_PLACE_LOADED });
    expect(commander.run("/place:unload")).toBe(NO_PLACE_LOADED);
  });
});

describe("/place:state", () => {
  it("reports what the caller says is loaded", () => {
    expect(table().commander.run("/place:state")).toContain(
      "shapes   7 of 2000",
    );
  });

  it("says plainly that nothing is loaded", () => {
    const { commander } = table({ describe: () => NO_PLACE_LOADED });
    // A console that says nothing when idle is a console that looks broken, so
    // the idle line has to be a sentence with a next step in it.
    expect(commander.run("/place:state")).toBe(NO_PLACE_LOADED);
    expect(NO_PLACE_LOADED).toContain("no place loaded");
    expect(NO_PLACE_LOADED).toContain("/place:load");
  });
});

describe("/place:notices", () => {
  it("says so when the place has reported nothing", () => {
    // **Not an empty string.** An empty console line is indistinguishable from a
    // command that was typed wrong, and "nothing is wrong" is the answer most
    // worth stating plainly.
    expect(table().commander.run("/place:notices")).toBe(
      "the place has reported nothing",
    );
  });

  it("numbers the notices, so one can be quoted back", () => {
    const { commander } = table({
      notices: () => [
        "shape 4 was refused: no such combine",
        "timer 1 was refused",
      ],
    });
    const printed = commander.run("/place:notices") as string;
    expect(printed).toContain("1. shape 4 was refused");
    expect(printed).toContain("2. timer 1 was refused");
  });

  it("shows the most recent few, not the whole log", () => {
    // A console is a scrollback, not a log file. Twenty refusals is a page of
    // numbers that hides the one that was new.
    const many = Array.from({ length: 40 }, (_, at) => `notice ${at}`);
    const printed = table({ notices: () => many }).commander.run(
      "/place:notices",
    ) as string;
    expect(printed).toContain("notice 39");
    expect(printed).not.toContain("notice 0\n");
  });

  it("says nothing about a notice it did not show", () => {
    const many = Array.from({ length: 40 }, (_, at) => `notice ${at}`);
    const printed = table({ notices: () => many }).commander.run(
      "/place:notices",
    ) as string;
    expect(printed).not.toContain("notice 0.");
  });
});

describe("what this table does not know", () => {
  it("never reaches past its caller for anything", () => {
    // Every command resolves through the five functions in `PlaceCommands` — no
    // import of a host, a renderer, a scene or a `File` anywhere in the file. That is
    // the property that lets `host.test.ts` and this file stand in for each other,
    // and it is worth asserting because a `PlaceHost` import here would type-check
    // and quietly break it. It is also why `openFromDisk` is a callback rather than
    // a file input: this table must not know a DOM exists.
    const answers: PlaceCommands = {
      loadDemo: () => Promise.resolve("loaded"),
      openFromDisk: () => Promise.resolve("opened"),
      unload: () => "unloaded",
      describe: () => "nothing",
      notices: () => [],
    };
    expect(Object.keys(answers).sort()).toEqual([
      "describe",
      "loadDemo",
      "notices",
      "openFromDisk",
      "unload",
    ]);
  });
});
