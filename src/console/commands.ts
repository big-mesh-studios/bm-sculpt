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
 * accounts, places and multiplayer. Only the two that act on this application's
 * player came with it; the rest are commands for systems this build does not
 * have yet, and a command that reports on a renderer that isn't there is worse
 * than no command at all.
 */

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
  run: (rest: string[]) => string;
}

/** One command as `/help` describes it: what to type, and what it does. */
export interface CommandHelp {
  /** The command's name, leading slash included. */
  name: string;
  args?: string;
  description: string;
}

/** What running a line produces: the lines to print, or what `/help` lists. */
export type CommandOutput = string | CommandHelp[];

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
 * Every console command, declared as a single object literal keyed by command
 * name. This is the only place in the application that knows the whole command
 * vocabulary exists.
 */
export const createCommands = ({
  setFlying,
  setNoClip,
}: CommandsParams): Commander => {
  return new Commander({
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
