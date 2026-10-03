// @vitest-environment jsdom

/**
 * The console as a mounted component: the `>_` trigger, the `/` shortcut, the
 * command round trip, the light dismiss, and the pointer lock the console owes
 * the game's input controller.
 *
 * Rendered into jsdom with `render` from `@solidjs/web`, the way the sibling
 * project's UI tests are. Two things jsdom has no answer for: the popover, whose
 * `togglePopover` is stubbed here, and the browser layout the panel is positioned
 * by — which is why nothing below asserts on geometry. That is the stylesheet's
 * claim, and the only honest way to check it is to open the page.
 */

import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInput, type InputController } from "../player/input";
import { Console, createConsole, type ConsoleState } from "./console";
import type { CommandHelp, CommandOutput } from "./commands";

/** The vocabulary these tests complete against. */
const COMMANDS: CommandHelp[] = [
  { name: "/help", description: "list every command" },
  {
    name: "/player:fly",
    args: "[on|off]",
    description: "turn flight on or off",
  },
  { name: "/clear", description: "clear the console output" },
];

let root: HTMLDivElement | undefined;
let input: InputController | undefined;
let unmount: (() => void) | undefined;

beforeEach(() => {
  Object.defineProperty(HTMLUListElement.prototype, "togglePopover", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  // Solid's disposer first: it is what takes the console's window listeners
  // down. Removing the markup alone would leave them listening for the next
  // test's keystrokes.
  unmount?.();
  unmount = undefined;
  root?.remove();
  root = undefined;
  input?.dispose();
  input = undefined;
});

interface Mounted {
  /** Everything the console has printed, as the text of its output element. */
  output(): string;
  /** The suggestion list's entries, in the order they are shown. */
  suggestions(): string[];
  /** The index of the suggestion the arrow keys have landed on, or -1. */
  selected(): number;
  /** The command input. */
  input(): HTMLInputElement;
  /** The `>_` trigger, which is also how the panel is closed again. */
  trigger(): HTMLButtonElement;
  /** The fullscreen button, in the same row. */
  fullscreen(): HTMLButtonElement;
  /** Every line run, in order. */
  ran: string[];
}

/**
 * Mounts the console over a table of the caller's own making. `answer` stands in
 * for the command table, and defaults to the one thing worth having a real one
 * for: `/help` answering with the table itself.
 */
const mount = (answer: (line: string) => CommandOutput = defaultAnswer) => {
  const ran: string[] = [];
  const terminal: ConsoleState = createConsole({
    onCommand: (line) => {
      ran.push(line);
      return answer(line);
    },
    commands: () => COMMANDS,
  });
  input = createInput();
  root = document.createElement("div");
  document.body.append(root);
  unmount = render(() => <Console terminal={terminal} input={input!} />, root);

  const mounted: Mounted = {
    ran,
    output: () => root!.querySelector("output")?.textContent ?? "",
    suggestions: () =>
      [...root!.querySelectorAll("li")].map((item) => item.textContent ?? ""),
    selected: () =>
      [...root!.querySelectorAll("li")].findIndex((item) =>
        (item.className as string).includes("selected"),
      ),
    input: () => root!.querySelector("input")!,
    // Not by aria-label, which flips between "open" and "close" with the panel
    // — which is exactly what a test wants to press second.
    trigger: () => root!.querySelector("button[aria-expanded]")!,
    fullscreen: () =>
      root!.querySelector<HTMLButtonElement>(
        'button[aria-label="toggle fullscreen"]',
      )!,
  };
  return mounted;
};

/** `/help` answers with the table; everything else answers plainly. */
function defaultAnswer(line: string): CommandOutput {
  return line.trim() === "/help" ? COMMANDS : "ok";
}

const type = (console_: Mounted, text: string): void => {
  const element = console_.input();
  element.value = text;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  // A real keystroke leaves the signal behind the DOM updated; without this the
  // keydown that follows would complete against the line before it.
  flush();
};

const press = (console_: Mounted, key: string): void => {
  console_
    .input()
    .dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  flush();
};

const key = (name: string, init: KeyboardEventInit = {}): void => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }),
  );
  flush();
};

const click = (element: HTMLElement): void => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flush();
};

describe("the console panel", () => {
  it("is closed until the trigger is pressed", () => {
    const console_ = mount();
    expect(console_.output()).toBe("");

    click(console_.trigger());
    expect(root!.querySelector("output")).not.toBeNull();
  });

  it("closes again from the same trigger", () => {
    const console_ = mount();
    click(console_.trigger());
    click(console_.trigger());
    expect(root!.querySelector("output")).toBeNull();
  });

  it("keeps its scrollback across a close and reopen", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/help");
    press(console_, "Enter");
    expect(console_.output()).toContain("list every command");

    click(console_.trigger());
    click(console_.trigger());
    expect(console_.output()).toContain("list every command");
  });

  it("closes on a pointerdown outside itself", () => {
    const console_ = mount();
    click(console_.trigger());
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    flush();
    expect(root!.querySelector("output")).toBeNull();
  });

  it("stays open for a pointerdown inside itself", () => {
    const console_ = mount();
    click(console_.trigger());
    console_.input().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    flush();
    expect(root!.querySelector("output")).not.toBeNull();
  });

  it("closes on Escape, and does nothing when it is already closed", () => {
    const console_ = mount();
    key("Escape");
    expect(root!.querySelector("output")).toBeNull();

    click(console_.trigger());
    key("Escape");
    expect(root!.querySelector("output")).toBeNull();
  });
});

describe("running a command", () => {
  it("echoes the line and prints what came back", () => {
    const console_ = mount(() => "flying");
    click(console_.trigger());
    type(console_, "/player:fly");
    press(console_, "Enter");
    expect(console_.ran).toEqual(["/player:fly"]);
    expect(console_.output()).toContain("/player:fly");
    expect(console_.output()).toContain("flying");
  });

  it("empties the scrollback on /clear, and says nothing about it", () => {
    const console_ = mount(() => "flying");
    click(console_.trigger());
    type(console_, "/player:fly");
    press(console_, "Enter");

    type(console_, "/clear");
    press(console_, "Enter");
    expect(console_.output()).toBe("");
    // The command table owns it, but the terminal intercepts it — so the line
    // naming what emptied the screen is not the first thing back on it.
    expect(console_.ran).toEqual(["/player:fly"]);
  });

  it("prints no line for a command that answers with nothing", () => {
    const console_ = mount(() => "");
    click(console_.trigger());
    type(console_, "/player:fly");
    press(console_, "Enter");
    // The echo is still there; there is simply nothing under it.
    expect(console_.output()).toBe("> /player:fly");
  });

  it("empties the input, so the next command starts clean", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/help");
    press(console_, "Enter");
    expect(console_.input().value).toBe("");
  });

  it("runs nothing at all for an empty line", () => {
    const console_ = mount();
    click(console_.trigger());
    press(console_, "Enter");
    expect(console_.ran).toEqual([]);
  });

  it("remembers what has been run, and walks back through it", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/help");
    press(console_, "Enter");
    expect(console_.output()).toContain("list every command");

    press(console_, "ArrowUp");
    expect(console_.input().value).toBe("/help");
  });
});

describe("completing as it is typed", () => {
  it("suggests every command a bare slash could reach", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/");
    // Shortest name first: the least typing to get right. `/player:fly` is the
    // only one with a colon, and a bare slash cannot tell a scope from a name.
    expect(console_.suggestions()).toEqual(["/help", "/clear", "/player:fly"]);
  });

  it("suggests nothing once the line has reached its arguments", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/player:fly on");
    expect(console_.suggestions()).toEqual([]);
  });

  it("walks the suggestions with the arrow keys, wrapping at both ends", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/");
    expect(console_.selected()).toBe(0);

    press(console_, "ArrowDown");
    expect(console_.selected()).toBe(1);
    press(console_, "ArrowDown");
    expect(console_.selected()).toBe(2);
    press(console_, "ArrowDown");
    expect(console_.selected()).toBe(0);
    press(console_, "ArrowUp");
    expect(console_.selected()).toBe(2);
  });

  it("prefers the candidates over the history while there are any", () => {
    // A command is behind the caret, so the arrows belong to the completion
    // rather than to what has been run before — even with only one to choose.
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/help");
    press(console_, "Enter");

    type(console_, "/");
    press(console_, "ArrowUp");
    expect(console_.selected()).toBe(2);
    expect(console_.input().value).toBe("/");
  });

  it("completes to the whole name where there is no scope left to stop at", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/cl");
    press(console_, "Tab");
    expect(console_.input().value).toBe("/clear");
  });

  it("stops at the scope colon, where the rest of the name is a second choice", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/play");
    press(console_, "Tab");
    expect(console_.input().value).toBe("/player:");
    press(console_, "Tab");
    expect(console_.input().value).toBe("/player:fly");
  });

  it("leaves the caret at the end of what it filled in", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/cl");
    press(console_, "Tab");
    expect(console_.input().selectionStart).toBe("/clear".length);
  });

  it("ghosts the rest of a name behind what has been typed", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/play");
    // The characters really typed are hidden in place, so the overlay reads as
    // the unwritten remainder alone.
    const ghost = root!.querySelector('[class*="completion"]');
    expect(ghost?.textContent).toBe("/player:fly");
  });

  it("hints what a completed name still takes", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/player:fly");
    const ghost = root!.querySelector('[class*="completion"]');
    expect(ghost?.textContent).toBe("/player:fly [on|off]");
  });

  it("does not add a second space where the line already has one", () => {
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/player:fly");
    expect(root!.querySelector('[class*="completion"]')?.textContent).toBe(
      "/player:fly [on|off]",
    );

    type(console_, "/player:fly ");
    // The hidden span holds what is typed, space and all, so the visible
    // remainder starts where the caret is rather than one character before it.
    const overlay = root!.querySelector('[class*="completion"]');
    expect(overlay?.querySelector('[class*="typed"]')?.textContent).toBe(
      "/player:fly ",
    );
    expect(overlay?.lastChild?.textContent).toBe("[on|off]");
  });

  it("takes a name from the list without losing the focus", () => {
    // The caret has to sit after the name the pointer picked, so arguments can
    // be typed straight on rather than reaching for the mouse again.
    const console_ = mount();
    click(console_.trigger());
    type(console_, "/");
    console_.input().focus();
    const chosen = [...root!.querySelectorAll("li")].find(
      (item) => item.textContent === "/player:fly",
    )!;
    chosen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    chosen.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    expect(console_.input().value).toBe("/player:fly");
    expect(document.activeElement).toBe(console_.input());
  });
});

describe("the / shortcut", () => {
  it("opens the panel and types the slash into it", () => {
    const console_ = mount();
    key("/");
    expect(root!.querySelector("output")).not.toBeNull();
    expect(console_.input().value).toBe("/");
  });

  it("opens an already-open panel without closing it", () => {
    // A toggle here would be a trap: the slash means "let me type a command",
    // and closing the panel would close the thing it was meant to type into.
    mount();
    key("/");
    key("/");
    expect(root!.querySelector("output")).not.toBeNull();
  });

  it("leaves a modified slash to the browser", () => {
    mount();
    key("/", { ctrlKey: true });
    key("/", { metaKey: true });
    expect(root!.querySelector("output")).toBeNull();
  });

  it("leaves a slash typed into another field alone", () => {
    mount();
    const field = document.createElement("input");
    document.body.append(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    flush();
    expect(root!.querySelector("output")).toBeNull();
  });
});

describe("the fullscreen button", () => {
  it("runs /fullscreen, so the button and the command are one thing", () => {
    const console_ = mount(() => "full screen requested");
    click(console_.trigger());
    click(console_.fullscreen());
    expect(console_.ran).toEqual(["/fullscreen"]);
    expect(console_.output()).toContain("full screen requested");
  });

  it("works with the panel closed, and does not open it", () => {
    // It is a control of its own, not part of the terminal: the screen can be
    // made landscape without the console ever having been asked for.
    const console_ = mount(() => "full screen requested");
    click(console_.fullscreen());
    expect(console_.ran).toEqual(["/fullscreen"]);
    expect(root!.querySelector("output")).toBeNull();
  });

  it("does not close the panel by being pressed", () => {
    // The button row sits outside the panel, so a click on it would otherwise
    // count as the outside click that closes the terminal and be undone a
    // moment later by its own toggle.
    const console_ = mount();
    click(console_.trigger());
    click(console_.fullscreen());
    expect(root!.querySelector("output")).not.toBeNull();
  });
});

describe("what the console does to the pointer lock", () => {
  beforeEach(() => {
    document.exitPointerLock = vi.fn() as unknown as () => void;
  });

  it("does not hold the lock until it is opened", () => {
    mount();
    expect(input!.pointerLockSuspended()).toBe(false);
  });

  it("lets the lock go while it is open", () => {
    mount();
    key("/");
    expect(input!.pointerLockSuspended()).toBe(true);
  });

  it("stops holding the lock once it is closed", () => {
    mount();
    key("/");
    key("Escape");
    expect(input!.pointerLockSuspended()).toBe(false);
  });

  it("holds the lock for exactly as long as the panel is showing", () => {
    const console_ = mount();
    click(console_.trigger());
    expect(input!.pointerLockSuspended()).toBe(true);
    click(console_.trigger());
    expect(input!.pointerLockSuspended()).toBe(false);
    expect(root!.querySelector("output")).toBeNull();
  });
});

/**
 * A command that takes time.
 *
 * **The one behaviour `/place:load` needs** and the only one the rest of the table cannot
 * reach: a `run` that returns a promise prints something immediately, and then prints the
 * answer in the same place rather than below it.
 */
describe("a command that has not finished", () => {
  /** A promise a test settles by hand, so nothing here depends on a real timer. */
  const deferred = () => {
    let resolve!: (text: string) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };

  /**
   * Runs a line, opening the panel first if it is closed.
   *
   * **Opens only when closed**, so a second `submit` in one test runs against the open panel
   * rather than toggling it shut and typing into nothing.
   */
  const submit = (console_: Mounted, text: string): void => {
    if (root!.querySelector("input") === null) click(console_.trigger());
    type(console_, text);
    press(console_, "Enter");
  };

  const until = async (check: () => boolean): Promise<void> => {
    for (let i = 0; i < 20 && !check(); i++) {
      await Promise.resolve();
      flush();
    }
  };

  it("says so while it waits", () => {
    const { promise } = deferred();
    const console_ = mount(() => promise);
    submit(console_, "/place:load bridge");
    expect(console_.output()).toContain("…");
  });

  it("prints the answer where the waiting was", async () => {
    const { promise, resolve } = deferred();
    const console_ = mount(() => promise);
    submit(console_, "/place:load bridge");
    resolve("loaded bridge\n2 shapes");
    await until(() => console_.output().includes("2 shapes"));

    // One line, not two: the "…" is *replaced*, so a reader is never left
    // pairing up a line that said it was waiting with a line that said what
    // happened.
    expect(console_.output()).not.toContain("…");
    expect(console_.output()).toContain("loaded bridge");
  });

  it("still echoes the command that is waiting", async () => {
    const { promise, resolve } = deferred();
    const console_ = mount(() => promise);
    submit(console_, "/place:load bridge");
    resolve("loaded");
    await until(() => console_.output().includes("loaded"));
    expect(console_.output()).toContain("/place:load bridge");
  });

  it("reports a refusal instead of leaving the waiting there", async () => {
    const { promise, reject } = deferred();
    const console_ = mount(() => promise);
    submit(console_, "/place:load bridge");
    reject(new Error("bridge.ts:12: no such file"));
    await until(() => console_.output().includes("failed"));

    // **The reason, not "failed".** A place that will not load is the one
    // failure a person can act on, and a summary of it is the same as none.
    expect(console_.output()).toContain("bridge.ts:12: no such file");
    expect(console_.output()).not.toContain("…");
  });

  it("settles a reason that is not an Error at all", async () => {
    const { promise, reject } = deferred();
    const console_ = mount(() => promise);
    submit(console_, "/place:load bridge");
    reject("the interpreter was closed");
    await until(() => console_.output().includes("failed"));
    expect(console_.output()).toContain("the interpreter was closed");
  });

  it("keeps two waiting commands apart", async () => {
    const first = deferred();
    const second = deferred();
    const console_ = mount((line) =>
      line.includes("bridge") ? first.promise : second.promise,
    );
    submit(console_, "/place:load bridge");
    submit(console_, "/place:load lanterns");

    // **The second to settle must not take the first's line with it.** This is
    // what the pending entry's id is for: by position alone the first to settle
    // would rewrite whichever line came first.
    second.resolve("loaded lanterns");
    await until(() => console_.output().includes("loaded lanterns"));
    expect(console_.output()).toContain("…");
    expect(console_.output()).not.toContain("loaded bridge");

    first.resolve("loaded bridge");
    await until(() => console_.output().includes("loaded bridge"));
    expect(console_.output()).not.toContain("…");
  });

  it("answers a later command before an earlier one is still waiting", async () => {
    const first = deferred();
    const console_ = mount((line) =>
      line === "/place:load bridge" ? first.promise : "answered",
    );
    submit(console_, "/place:load bridge");
    submit(console_, "/player:fly");
    expect(console_.output()).toContain("answered");
    // **The waiting command does not block the console.** It is a line in the
    // scrollback, not a lock on it — otherwise one slow place would make the
    // whole console unusable while it loaded.
    expect(console_.output()).toContain("…");
  });
});

/** `print`, for a loaded place's `log`, which is not a command. */
describe("printing a line that was not typed", () => {
  it("lands in the scrollback as a bare line", () => {
    const terminal: ConsoleState = createConsole({
      onCommand: () => "",
      commands: () => COMMANDS,
    });
    terminal.print("the bridge is up");
    flush();
    expect(terminal.entries().map((entry) => JSON.stringify(entry))).toContain(
      JSON.stringify({ kind: "line", text: "the bridge is up" }),
    );
  });

  it("is not an echo of anything", () => {
    const terminal: ConsoleState = createConsole({
      onCommand: () => "",
      commands: () => COMMANDS,
    });
    terminal.print("the bridge is up");
    flush();
    // No echo, because nothing was typed: a place's output should not look like
    // something a person typed into a prompt.
    expect(terminal.entries().every((entry) => entry.kind !== "echo")).toBe(
      true,
    );
  });

  it("prints nothing for a blank line", () => {
    const terminal: ConsoleState = createConsole({
      onCommand: () => "",
      commands: () => COMMANDS,
    });
    terminal.print("");
    flush();
    expect(terminal.entries()).toEqual([]);
  });
});
