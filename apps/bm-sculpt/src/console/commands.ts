/**
 * The console's command table.
 *
 * Every command is declared once, as an entry in a single object literal keyed
 * by command name. An entry's `run` closure does its own raw-argument parsing
 * and validation, then calls a plain typed method on the thing that owns the
 * state it changes — `Game` here, and a browser API for `/fullscreen`. Neither
 * the game nor the player has any idea a console exists.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape`, which has a console with
 * about forty commands across the clock, the world window, level of detail,
 * accounts, places and multiplayer. The clock and the two commands that act on this
 * application's player came with it; the rest are commands for systems this build
 * does not have yet, and a command that reports on a renderer that isn't there is
 * worse than no command at all.
 */

import { CYCLE_SECONDS, phasePreset, type Phase } from "../world/day-night";

/**
 * Declares a command, keyed by the name that runs it. Every entry's `run`
 * closure parses its own arguments rather than sharing a parser, because
 * `/world:radius` and `/player:fly` disagree about what a missing argument
 * means — one reports the window it is describing, the other toggles — and a
 * shared grammar would have to be told which of the two it is looking at.
 */
export interface CommandEntry {
  /** What the command does, one line, shown against its name by `/help`. */
  description: string;
  /** The arguments it takes, written as they would be typed. */
  args?: string;
  /**
   * What the command hands back: the line to print, or a promise of it.
   *
   * **A promise is allowed because loading a place genuinely takes time** — it bundles,
   * starts an interpreter and runs a script's top-level code — and the alternative was not to
   * support it but to make `/fullscreen` lie about being the only such command. The console
   * prints `…` under the echo and replaces that line when the promise settles, so a pending
   * command is visible rather than silent.
   *
   * Most entries return a string, and widening this type does not put an `await` in them: a
   * synchronous `run` is still synchronous, and the console only awaits what is a promise.
   */
  run: (rest: string[]) => string | Promise<string>;
}

/** One command as `/help` describes it: what to type, and what it does. */
export interface CommandHelp {
  /** The command's name, leading slash included. */
  name: string;
  args?: string;
  description: string;
}

/**
 * What running a line produces: the lines to print, what `/help` lists, or a promise of
 * either. See `CommandEntry.run` for why a promise is allowed.
 */
export type CommandOutput =
  string | CommandHelp[] | Promise<string | CommandHelp[]>;

/**
 * The part of the Screen Orientation API `/fullscreen` uses. `lock` is absent
 * from the DOM type declarations, so the method is reached through this shape
 * and feature-detected before it is called — Android Chrome implements the lock
 * and most desktop browsers implement none of it.
 */
interface Orientable {
  lock?(orientation: "landscape" | "portrait"): Promise<void>;
  unlock?(): void;
}

/** The document's screen orientation, or undefined where the API is absent. */
const screenOrientation = (): Orientable | undefined =>
  (screen as Screen & { orientation?: Orientable }).orientation;

/**
 * Runs a line of input, and knows every command there is.
 *
 * Splitting this out of `createCommands` is what lets a caller hold a
 * `Commander` and ask it for its help — which the console needs on every
 * keystroke to know what to complete — without being handed the whole table a
 * second time.
 */
export class Commander {
  private readonly commands: Record<string, CommandEntry>;

  constructor(commands: Record<string, CommandEntry>) {
    this.commands = commands;
  }

  run(line: string): CommandOutput {
    const [name, ...rest] = line.trim().toLowerCase().split(/\s+/);
    if (name === "/help") {
      return this.help();
    }
    const command = this.commands[name];
    if (command === undefined) {
      return `unknown command "${line}" — try /help`;
    }
    return command.run(rest);
  }

  /**
   * A second table, folded into this one.
   *
   * **For the tables that are not the application's own commands** — `/place:` is a separate
   * table in `place-commands.ts`, because loading a place is asynchronous and nothing else
   * here is. Merging rather than one literal of thirty-six entries keeps `/help`'s order
   * reading as "the game's commands, then the place's", instead of as whatever order two
   * authors happened to type in.
   *
   * A name already present is **kept, not overwritten**, so the application's own table cannot
   * be redefined by whatever a place feature adds later. Nothing reports the collision: both
   * tables are written here, in the same commit as each other, and a duplicate name is a typo
   * that TypeScript does not catch and a person will within a minute of `/help`.
   */
  with(extra: Record<string, CommandEntry>): Commander {
    return new Commander({ ...extra, ...this.commands });
  }

  /** Every command there is, in the order they are declared, `/help` first. */
  help(): CommandHelp[] {
    return [
      { name: "/help", description: "list every command" },
      ...Object.entries(this.commands).map(([name, command]) => ({
        name,
        args: command.args,
        description: command.description,
      })),
    ];
  }
}

export interface CommandsParams {
  /** Turns flight on or off, toggling when `flying` is omitted. */
  setFlying(flying?: boolean): string;
  /** Turns no-clip on or off, toggling when `noclip` is omitted. */
  setNoClip(noclip?: boolean): string;
  /**
   * Puts the player in space above their current ground, for debugging the far field.
   *
   * A debug command rather than a game mechanic: flying up the old way takes minutes, and the
   * only way to look at the globe, the atmosphere or the fog from outside was to sit through the
   * climb. The altitude is optional so the default lives in one place.
   */
  toSpace(altitude?: number): string;
  /**
   * The day-night clock, for `/clock:` — the four methods voxelscape's commands use
   * and no others.
   *
   * Declared structurally rather than as `DayNightController`, which is what keeps
   * this table testable against a three-line fake and keeps `day-night.ts` free of any
   * knowledge that a console exists. It is also what makes the direction of the
   * dependency honest: the console asks the clock to do things, never the reverse.
   */
  clock: ClockCommands;
  /** The cloud layer, for `/cloud:`. See `CloudCommands`. */
  cloud: CloudCommands;
}

/** The clock's surface, as `/clock:` uses it. See `CommandsParams.clock`. */
export interface ClockCommands {
  /** Pins the sky to a second of the cycle. */
  jumpTo(seconds: number): void;
  /** Releases the pin, and the live clock carries on. */
  clearOverride(): void;
  /** Runs the clock at `multiplier` times real time; zero holds it. */
  setSpeed(multiplier: number): void;
  /** One line saying where the clock is. */
  describe(): string;
}

/**
 * The two cloud knobs and the layer's own state, as `/cloud:` uses them.
 *
 * Declared as strings in and strings out, for the same reason `fogColourOf` is a
 * function rather than a rule: nothing in this file should know that a material has a
 * `coverage` field, and the caller owns whether the layer exists yet — it is null for
 * the second or two the field takes to bake.
 *
 * **This exists because the cloud defaults have never been looked at.** Every
 * constant in `clouds.ts` was reasoned about on paper, `coverage = 0.52` and
 * `density = 1` most of all, and the only way to find out what they look like was to
 * edit a constant and rebuild. A console command turns that into a keystroke, which is
 * also why these are the only two the console exposes: they are the two a player would
 * notice first.
 */
export interface CloudCommands {
  /** Reports or sets coverage, 0 to 1. */
  coverage(value?: number): string;
  /** Reports or sets density. */
  density(value?: number): string;
  /** One line saying whether the layer exists and what it is set to. */
  state(): string;
}

/**
 * Reads an `[on|off]` argument.
 *
 * A bare argument — none at all — flips the setting, an explicit `on` or `off`
 * sets it, and anything else is a usage line rather than a guess. Silently
 * treating `maybe` as "off" would report a state the player never asked for.
 *
 * @returns What to do with the setting — `undefined` meaning "flip it" — or
 *   the line to print instead.
 */
const readToggle = (
  argument: string | undefined,
  name: string,
): boolean | undefined | string => {
  if (argument === undefined) return undefined;
  if (argument === "on") return true;
  if (argument === "off") return false;
  return `usage: ${name} [on|off]  (no argument flips it)`;
};

/**
 * Reads a number the console is going to act on, refusing anything that is not one.
 *
 * `NaN` and `Infinity` are both refused by `Number.isFinite`, which is the whole of
 * the validation: `Number` is a permissive parser that answers a number for `"12px"`,
 * and a clock asked to jump to `NaN` seconds hands every material in the frame a
 * `NaN` — a black screen with no error, which is the most expensive kind of typo to
 * chase.
 *
 * @param usage - The line to print instead of a number. Carries the command's own
 *   name and its legal range, so no caller has to spell that out twice.
 * @param minimum - Lowest accepted value, where a negative one would be meaningless.
 * @returns The number, or `usage`.
 */
const readNumber = (
  argument: string | undefined,
  usage: string,
  minimum?: number,
): number | string => {
  const value = Number(argument);
  if (argument === undefined || !Number.isFinite(value)) return usage;
  if (minimum !== undefined && value < minimum) return usage;
  return value;
};

/** The phase a `/clock:<phase>` jump reports, in words rather than as a name. */
const PHASE_WORDS: Record<Phase, string> = {
  day: "noon",
  sunset: "dusk",
  night: "midnight",
  sunrise: "dawn",
};

/**
 * The one `/clock:` jump, written once for the four that share it.
 *
 * **The second comes from `phasePreset`, never from a literal.** voxelscape's four
 * commands jumped to 300 / 645 / 900 / 1120 — hardcoded seconds that stopped meaning
 * what their names said the moment the sun path became a solar model rather than a
 * drawn curve, which is exactly what happened: the dusk the reference drew at 645 is
 * not the dusk this model produces. `phasePreset` asks the model where the phase is
 * and returns the middle of its longest run, so a jump lands as far from either
 * boundary as the phase allows and keeps doing so if the latitude or the twilight
 * threshold ever moves.
 *
 * @returns The line to print, which names the phase and the second it landed on —
 *   because a console that reports "jumped to dusk" alone leaves the player unable to
 *   tell which dusk, and `/clock:state` is a separate command to consult.
 */
const jumpToPhase = (clock: ClockCommands, phase: Phase): string => {
  const seconds = phasePreset(phase);
  clock.jumpTo(seconds);
  return `jumped to ${PHASE_WORDS[phase]} (t=${seconds.toFixed(1)}s)`;
};

/**
 * Every console command, declared as a single object literal keyed by command
 * name. This is the only place in the application that knows the whole command
 * vocabulary exists.
 */
export const createCommands = ({
  setFlying,
  setNoClip,
  toSpace,
  clock,
  cloud,
}: CommandsParams): Commander => {
  return new Commander({
    "/clock:day": {
      description: "jump to the middle of the day",
      run: () => jumpToPhase(clock, "day"),
    },
    "/clock:sunset": {
      description: "jump to the middle of dusk",
      run: () => jumpToPhase(clock, "sunset"),
    },
    "/clock:night": {
      description: "jump to the middle of the night",
      run: () => jumpToPhase(clock, "night"),
    },
    "/clock:sunrise": {
      description: "jump to the middle of dawn",
      run: () => jumpToPhase(clock, "sunrise"),
    },
    "/clock:time": {
      description: `pin the sky to a second of the ${CYCLE_SECONDS}-second cycle`,
      args: "<seconds>",
      run: (rest) => {
        const seconds = readNumber(
          rest[0],
          `usage: /clock:time <seconds>  (0..${CYCLE_SECONDS}, wraps)`,
        );
        if (typeof seconds === "string") return seconds;
        clock.jumpTo(seconds);
        return `time set to ${seconds}s`;
      },
    },
    "/clock:speed": {
      description: "run the clock that many times fast (0 pauses)",
      args: "<multiplier>",
      run: (rest) => {
        const speed = readNumber(
          rest[0],
          "usage: /clock:speed <multiplier>  (0 pauses, 1 = real time)",
          0,
        );
        if (typeof speed === "string") return speed;
        clock.setSpeed(speed);
        return `clock speed set to ${speed}×`;
      },
    },
    "/clock:live": {
      description: "release the pin, and let the cycle run on",
      run: () => {
        clock.clearOverride();
        return "resumed the live clock";
      },
    },
    "/clock:state": {
      description: "say where the clock is",
      run: () => clock.describe(),
    },
    "/cloud:coverage": {
      description: "report or set how much of the sky is cloud (0 to 1)",
      args: "[0..1]",
      run: (rest) => {
        if (rest[0] === undefined) return cloud.coverage();
        const value = readNumber(rest[0], "usage: /cloud:coverage [0..1]");
        if (typeof value === "string") return value;
        if (value < 0 || value > 1) {
          return "usage: /cloud:coverage [0..1]";
        }
        return cloud.coverage(value);
      },
    },
    "/cloud:density": {
      description: "report or set how opaque a formed cloud is",
      args: "[multiplier]",
      run: (rest) => {
        if (rest[0] === undefined) return cloud.density();
        const value = readNumber(rest[0], "usage: /cloud:density [multiplier]");
        if (typeof value === "string") return value;
        if (value < 0) return "usage: /cloud:density [multiplier]  (0 or more)";
        return cloud.density(value);
      },
    },
    "/cloud:state": {
      description: "say whether the layer is built and what it is set to",
      run: () => cloud.state(),
    },
    "/player:fly": {
      description: "turn flight on or off (no gravity; W follows the look)",
      args: "[on|off]",
      run: (rest) => {
        const argument = readToggle(rest[0], "/player:fly");
        return typeof argument === "string" ? argument : setFlying(argument);
      },
    },
    "/player:no-clip": {
      description: "turn no-clip on or off (fly through solid blocks)",
      args: "[on|off]",
      run: (rest) => {
        const argument = readToggle(rest[0], "/player:no-clip");
        return typeof argument === "string" ? argument : setNoClip(argument);
      },
    },
    "/player:space": {
      description:
        "put the player in space above the current ground, with flight on (debug)",
      args: "[altitude]",
      run: (rest) => {
        // No argument uses the game's own default, so the two cannot drift.
        if (rest[0] === undefined) return toSpace();
        const altitude = readNumber(
          rest[0],
          "usage: /player:space [altitude]  (0 or more, world units)",
          0,
        );
        if (typeof altitude === "string") return altitude;
        return toSpace(altitude);
      },
    },
    "/fullscreen": {
      description: "enter or leave fullscreen, locking the screen sideways",
      args: "true|false [landscape|portrait]",
      // Synchronous, where the sibling project's equivalent is not. Its console
      // prints a promise's settlement under the command's echo, so it can await
      // the fullscreen request and then report what the orientation lock
      // answered — two `await`s and a `Promise<string>` its own terminal only
      // knows how to display because it handles the pending case. This console
      // has no pending state: a command hands back the line to print. What it
      // reports is what was asked of the browser, which is the whole of what a
      // player can act on — whether the lock was granted changes nothing they
      // would do next, and the browser that grants nothing has taken away
      // nothing they were relying on.
      run: (rest) => {
        const shouldRequest =
          rest[0] === undefined
            ? document.fullscreenElement !== document.body
            : rest[0] !== "false";
        const orientation = rest[1] === "portrait" ? "portrait" : "landscape";

        if (!shouldRequest) {
          screenOrientation()?.unlock?.();
          void document.exitFullscreen?.().catch(() => undefined);
          return "leaving fullscreen.";
        }

        // The one refusal that can be reported rather than swallowed: a
        // browser that says outright that it will not do this at all. Every
        // other refusal comes back as a rejected promise — an untrusted
        // request, or one the document has already left fullscreen by — and
        // there is nothing to be done about any of them.
        if (document.fullscreenEnabled === false) {
          return "this browser will not enter fullscreen here.";
        }

        void document.body.requestFullscreen().catch(() => undefined);
        // Not awaited: a lock is only ever granted to a document already in
        // fullscreen, which the browser decides on its own schedule. Asked for
        // in the same turn regardless, since that is the only moment it stands
        // a chance of being answered at all.
        const api = screenOrientation();
        try {
          void api?.lock?.(orientation).catch(() => undefined);
        } catch {
          /* a browser that throws rather than rejecting takes the same outcome */
        }
        return `full screen requested, screen set to ${orientation}.`;
      },
    },
    "/clear": {
      description: "clear the console output",
      run: () => "",
    },
  });
};
