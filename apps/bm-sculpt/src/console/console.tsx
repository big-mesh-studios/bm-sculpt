/**
 * The scripting surface: a `>_` trigger in the corner of the screen, and the
 * small terminal it opens — its scrollback, and an input row that completes,
 * ghosts and runs commands as they are typed.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape/src/ui/Console.tsx`, minus
 * everything that existed to grow into the place script editor. That is most of
 * the surrounding machinery rather than the terminal itself: the panel's second
 * size and the CSS transition between the two, the scrim, the dock header's
 * collapse chevron, and the media query that took the grown panel to the whole
 * viewport. All of it was answering one question — where does the room go when
 * the editor wants it — and this console has only one tenant. What is left is
 * the terminal, which was never the part that needed the editor.
 *
 * Two deliberate departures from the original:
 *
 * **The pointer lock is released, not regained.** See ADR 0010. The sibling
 * project re-takes it on a timer once the console closes; this one does not,
 * because the game's canvas already re-takes it on the next click and grabbing
 * it back unasked would fight the "click to play" prompt that appears with it.
 *
 * **One view, so one history.** The sibling project's console is drawn from two
 * places at once — a standalone popover and a strip docked in the editor — and
 * its state lives outside the component so neither could drift from the other.
 * With one view there is nothing to drift from, but the state still has to sit
 * outside the panel: a console's scrollback and history have to survive being
 * closed and reopened, and only the signal outlives the `Show` that unmounts
 * everything below it.
 */

import {
  createEffect,
  createMemo,
  createSignal,
  flush,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";

import { isEditableTarget, type InputController } from "../player/input";
import { candidatesFor, toScopeBoundary } from "./completion";
import type { CommandHelp, CommandOutput } from "./commands";
import { FullscreenIcon } from "./icons";
import styles from "./console.module.css";

/** The imperative handle `Console` holds, so the `/` shortcut can type into the input. */
export interface ConsoleInputHandle {
  /** Focuses the input and replaces what is typed, leaving the caret at the end. */
  prefill(text: string): void;
}

function ConsoleInput(props: {
  /** Every command, for completing the one being typed and hinting what it takes. */
  commands: CommandHelp[];
  /** Whether the console panel is showing, and with it this input. */
  open: boolean;
  onCommand(command: string): void;
  ref(handle: ConsoleInputHandle): void;
}) {
  let element!: HTMLInputElement;
  let suggestions!: HTMLUListElement;

  const history: string[] = [];

  const [historyIndex, setHistoryIndex] = createSignal(-1);
  const [value, setValue] = createSignal(() => history[historyIndex()]);
  const [candidateIndex, setCandidateIndex] = createSignal(0);

  /** Every command's name, read once per change rather than per keystroke. */
  const names = createMemo(() => props.commands.map((command) => command.name));

  const typed = (): string => value() ?? "";

  /**
   * What the command being typed still takes, ghosted after it once its name is
   * spelled out in full. Completing a name is `candidate`'s job; this takes over
   * when there is no name left to complete and the question becomes what goes
   * after it.
   */
  const hint = (): string => {
    const line = typed();
    const command = props.commands.find(
      (entry) => entry.name === line.trimEnd(),
    );
    if (command?.args === undefined) {
      return "";
    }
    // A space of its own, unless what is typed already ends in one.
    return `${line.endsWith(" ") ? "" : " "}${command.args}`;
  };
  const candidates = (): string[] => candidatesFor(typed(), names());
  /** The candidate the arrow keys have landed on, if any is left to show. */
  const candidate = (): string | undefined => candidates()[candidateIndex()];
  /** Whether `line` already spells out a command's name in full. */
  const isCommand = (line: string): boolean => names().includes(line);
  /**
   * `candidate`, only when it continues what is typed as a prefix and what is
   * typed isn't already a complete command in its own right — a fuzzy match that
   * skips ahead of the caret has no trailing remainder that can be ghosted after
   * it, and a name that already stands on its own defers to `hint` instead of
   * ghosting a longer sibling on top of it.
   */
  const ghost = (): string | undefined => {
    if (isCommand(typed())) {
      return undefined;
    }
    const name = candidate();
    return name?.startsWith(typed()) ? name : undefined;
  };

  // Showing the list again whenever the panel reopens puts it back on top of the
  // panel in the top layer, which is stacked in the order things were shown.
  createEffect(
    () => props.open && candidates().length > 0,
    (shown) => {
      suggestions.togglePopover(shown);
    },
  );

  // Keeps the highlighted suggestion in view as the arrow keys walk past the
  // end of the list's scrolled window.
  createEffect(
    () => candidateIndex(),
    (index) => {
      suggestions.children[index]?.scrollIntoView({ block: "nearest" });
    },
  );

  /** Replaces what is typed, leaving the caret at the end. */
  const fill = (text: string): void => {
    setValue(text);
    setCandidateIndex(0);
    // The signal only reaches the DOM on the next microtask, and the caret has
    // to be placed behind text that is already there.
    element.value = text;
    element.focus();
    element.setSelectionRange(text.length, text.length);
  };

  const onKeyDown = (
    event: KeyboardEvent & { currentTarget: HTMLInputElement },
  ) => {
    switch (event.key) {
      case "Enter": {
        const line = event.currentTarget.value.trim();
        // A line that already names a command runs as itself; one still being
        // completed runs as the completion standing behind it.
        const command = isCommand(line)
          ? line
          : (candidatesFor(line, names())[candidateIndex()] ?? line);

        if (command === "") {
          return;
        }

        props.onCommand(command);
        history.push(command);
        setCandidateIndex(0);
        setValue("");

        return;
      }
      case "Tab": {
        const completion = candidate();
        if (completion === undefined) {
          return;
        }
        event.preventDefault();
        const scope = completion.startsWith(typed())
          ? toScopeBoundary(completion, typed())
          : completion;
        fill(scope);
        // The name the arrows had landed on is still the one being completed, so
        // the highlight follows it to the place it takes in the shorter list
        // rather than starting over at the top.
        setCandidateIndex(
          Math.max(0, candidatesFor(scope, names()).indexOf(completion)),
        );
        return;
      }
      case "ArrowUp": {
        // While a completion is standing behind the caret the arrows belong to
        // it, even when there is only the one and they have nowhere to go.
        const count = candidates().length;
        if (count > 0) {
          event.preventDefault();
          setCandidateIndex((index) => (index + count - 1) % count);
          return;
        }
        setHistoryIndex((index) => {
          if (index === -1) {
            return history.length - 1;
          }
          return index - 1;
        });
        return;
      }
      case "ArrowDown": {
        const count = candidates().length;
        if (count > 0) {
          event.preventDefault();
          setCandidateIndex((index) => (index + 1) % count);
          return;
        }
        setHistoryIndex((index) => {
          if (index === history.length - 1) {
            return -1;
          }
          return index + 1;
        });
        return;
      }
    }
  };

  props.ref({ prefill: fill });

  return (
    <div class={styles.field}>
      <input
        ref={element}
        value={value()}
        autofocus
        onInput={(e) => {
          setHistoryIndex(-1);
          setCandidateIndex(0);
          setValue(e.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        placeholder="type a command (/help)"
        class={styles.input}
      />
      <Show when={ghost()}>
        {(completion) => (
          <div class={styles.completion} aria-hidden="true">
            <span class={styles.typed}>{typed()}</span>
            {completion().slice(typed().length)}
          </div>
        )}
      </Show>
      <Show when={hint()}>
        {(args) => (
          <div class={styles.completion} aria-hidden="true">
            <span class={styles.typed}>{typed()}</span>
            {args()}
          </div>
        )}
      </Show>
      {/* A manual popover, kept a child of the field so that the panel around it
          counts as its ancestor and a click on a name doesn't dismiss the
          console. Showing it lifts it into the top layer, clear of the panel's
          clipped edges. */}
      <ul ref={suggestions} popover="manual" class={styles.suggestions}>
        <For each={candidates()}>
          {(name, index) => (
            <li
              class={[
                styles.suggestion,
                { [styles.selected]: index() === candidateIndex() },
              ]}
              // The input keeps the focus, so the caret sits after the name the
              // pointer picked and arguments can be typed straight on.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => fill(name)}
            >
              {name}
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/**
 * One entry of the output: a line the world or a command printed, the echo of a
 * command as it was typed, or the table `/help` answers with.
 */
type ConsoleEntry =
  | { kind: "line"; text: string }
  /**
   * A line from a command that has not finished.
   *
   * **Which is why the `id` is here.** A pending line is replaced rather than appended to, so
   * that `/place:load` leaves one line saying it is loading and then one line saying what
   * happened, instead of two lines the reader has to pair up themselves. Replacing by position
   * works; replacing by content does not, because two pending commands can print the same
   * `…`.
   */
  | { kind: "pending"; id: number; text: string }
  | { kind: "echo"; command: string }
  | { kind: "help"; commands: CommandHelp[] };

/** A typed command, its name and arguments coloured as `/help` colours them. */
function Echo(props: { command: string }) {
  const name = (): string => props.command.split(/\s/)[0];
  const args = (): string => props.command.slice(name().length);

  return (
    <div>
      <span class={styles.prompt}>{"> "}</span>
      <span class={styles.name}>{name()}</span>
      <span class={styles.args}>{args()}</span>
    </div>
  );
}

/** Every command, its name against what it does and what it takes. */
function Help(props: { commands: CommandHelp[] }) {
  return (
    <dl class={styles.help}>
      <For each={props.commands}>
        {(command) => (
          <>
            <dt class={styles.name}>{command.name}</dt>
            <dd>
              <Show when={command.args}>
                <span class={styles.args}>{command.args} </span>
              </Show>
              {command.description}
            </dd>
          </>
        )}
      </For>
    </dl>
  );
}

function ConsoleOutput(props: { entries: ConsoleEntry[] }) {
  let element!: HTMLOutputElement;

  // keep the output scrolled to the newest entry
  createEffect(
    () => props.entries,
    () => {
      element.scrollTop = element.scrollHeight;
    },
  );

  return (
    <output ref={element} class={styles.output}>
      <For each={props.entries}>
        {(entry) => {
          switch (entry.kind) {
            case "echo":
              return <Echo command={entry.command} />;
            case "pending":
              return <div class={styles.pending}>{entry.text}</div>;
            case "help":
              return <Help commands={entry.commands} />;
            default:
              return <div>{entry.text}</div>;
          }
        }}
      </For>
    </output>
  );
}

export interface CreateConsoleProps {
  onCommand: (line: string) => CommandOutput;
  /** Every command, for completing the one being typed and hinting what it takes. */
  commands: Accessor<CommandHelp[]>;
}

export interface ConsoleState {
  entries: Accessor<ConsoleEntry[]>;
  commands: Accessor<CommandHelp[]>;
  onCommand(command: string): void;
  /**
   * Prints a line that did not come from a command.
   *
   * **For a loaded place's `log`, which is not a command and has no echo of its own.** It is
   * appended as a bare line rather than run through `onCommand`, so it cannot be mistaken for
   * something a person typed — and because it lands in the same scrollback, a place's output
   * and a person's commands interleave in the order they happened rather than in two stacks.
   *
   * An empty string prints nothing, on the same rule commands follow: a script that logs a
   * blank line has said nothing, and saying nothing should not take a line of the scrollback.
   */
  print(line: string): void;
}

/** What a command that has not finished prints under its echo. */
const PENDING_TEXT = "…";

/**
 * The console's scrollback and command handling, independent of whether the
 * panel is open. Closing the terminal is not closing the console: the history
 * and the output survive, so reopening it shows the same session rather than a
 * blank one.
 */
export function createConsole(props: CreateConsoleProps): ConsoleState {
  const [entries, setEntries] = createSignal<ConsoleEntry[]>([]);

  const append = (...added: ConsoleEntry[]): void => {
    setEntries((entries) => [...entries, ...added]);
  };

  const print = (line: string): void => {
    if (line === "") return;
    append({ kind: "line", text: line });
  };

  /** What a command handed back, as entries to print under its echo. */
  const printed = (output: string | CommandHelp[]): ConsoleEntry[] =>
    typeof output === "string"
      ? output === ""
        ? []
        : output.split("\n").map((text) => ({ kind: "line", text }))
      : [{ kind: "help", commands: output }];

  /**
   * The next id for a pending line, so a settlement can replace its own line and not another
   * command's.
   */
  let nextPending = 0;

  /**
   * `/clear` empties the scrollback rather than printing into it, and is the one
   * command that does not echo itself: the point of clearing is a clean screen,
   * and the line naming what emptied it would be the first thing on it. The
   * command's own table entry still exists, so `/help` lists it.
   */
  function onCommand(command: string) {
    if (command === "/clear") {
      setEntries([]);
      return;
    }

    const output = props.onCommand(command);

    // **The promise is awaited here rather than by the caller**, so that every caller — the
    // key handler, the fullscreen button — gets pending output for free and none of them has
    // to know a command can be slow. The line under the echo says so immediately, so a slow
    // command is visibly slow rather than apparently hung.
    if (output instanceof Promise) {
      const id = nextPending++;
      append(
        { kind: "echo", command },
        { kind: "pending", id, text: PENDING_TEXT },
      );
      void output.then(
        (settled) =>
          setEntries((entries) =>
            entries.flatMap((entry) =>
              entry.kind === "pending" && entry.id === id
                ? printed(settled)
                : [entry],
            ),
          ),
        (reason: unknown) =>
          setEntries((entries) =>
            entries.flatMap((entry) =>
              entry.kind === "pending" && entry.id === id
                ? printed(
                    `failed: ${reason instanceof Error ? reason.message : String(reason)}`,
                  )
                : [entry],
            ),
          ),
      );
      return;
    }

    append({ kind: "echo", command }, ...printed(output));
  }

  return { entries, commands: props.commands, onCommand, print };
}

export interface ConsoleProps {
  terminal: ConsoleState;
  /**
   * The game's own input, read only for the pointer lock: opening the console
   * releases it, so the cursor is somewhere the player can aim it at a button.
   */
  input: InputController;
}

/**
 * The terminal's visible body: its scrollback and an always-present input row.
 *
 * The scrollback has no header and no chevron to collapse it. The sibling
 * project's terminal had both, so that opening the place editor could take the
 * room back — docked in a panel, hiding the output is how the editor's own
 * fields got more of it. Nothing here needs the room, so the input row is the
 * whole of what is always visible.
 */
function TerminalBody(props: {
  terminal: ConsoleState;
  ref(handle: ConsoleInputHandle): void;
}) {
  return (
    <>
      <ConsoleOutput entries={props.terminal.entries()} />
      <div class={styles["input-container"]}>
        <span class={styles.prefix}>{">"}</span>
        <ConsoleInput
          commands={props.terminal.commands()}
          open={true}
          onCommand={props.terminal.onCommand}
          ref={(handle) => props.ref(handle)}
        />
      </div>
    </>
  );
}

/**
 * The one scripting surface: a `>_` trigger that opens a small floating
 * terminal, which runs commands and prints what they hand back.
 */
export function Console(props: ConsoleProps) {
  const [terminalOpen, setTerminalOpen] = createSignal(false);

  let panel!: HTMLDivElement;
  // The button row is outside `panel`, so a click on it would otherwise also
  // count as the "outside" click that closes the terminal — undone a moment
  // later by the same click's own toggle, which would leave it looking like
  // clicking the trigger to close never did anything. The fullscreen button sits
  // in the same row, so it is excused the same way.
  let controls!: HTMLDivElement;
  let input: ConsoleInputHandle = null!;

  // Releasing the pointer lock is what makes the console usable at all: a locked
  // pointer swallows every keystroke aimed anywhere but the crosshair. The
  // disposer is the effect's own teardown, so the lock is only given up for as
  // long as the terminal is showing.
  createEffect(
    () => (terminalOpen() ? props.input : null),
    (input) => {
      if (input !== null) {
        return input.suspendPointerLock();
      }
    },
  );

  const controller = new AbortController();
  onCleanup(() => controller.abort());

  window.addEventListener(
    "keydown",
    (event) => {
      // Modified slashes belong to the browser (Ctrl+/ and friends), and a slash
      // typed into any text field is just a slash.
      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isEditableTarget(event)
      ) {
        event.preventDefault();
        setTerminalOpen(true);
        // The panel (and this input) may not exist yet — it mounts on the next
        // microtask flush otherwise, too late for the prefill below.
        flush();
        input.prefill("/");
        return;
      }
      if (event.key === "Escape" && terminalOpen()) {
        // The same light dismiss a native popover gives for free, regardless of
        // whether the command input itself happens to be focused.
        setTerminalOpen(false);
      }
    },
    { signal: controller.signal },
  );

  // A pointerdown outside the panel closes it, the same light dismiss a native
  // popover would give for free.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!terminalOpen()) {
        return;
      }
      if (
        event.target instanceof Node &&
        !panel.contains(event.target) &&
        !controls.contains(event.target)
      ) {
        setTerminalOpen(false);
      }
    },
    { signal: controller.signal },
  );

  return (
    <div class={styles.underlay}>
      <div ref={controls} class={styles.controls}>
        <button
          type="button"
          class={styles.fullscreen}
          onClick={() => props.terminal.onCommand("/fullscreen")}
          aria-label="toggle fullscreen"
        >
          <FullscreenIcon />
        </button>
        <button
          type="button"
          class={styles.anchor}
          onClick={() => setTerminalOpen((open) => !open)}
          aria-expanded={terminalOpen() ? "true" : "false"}
          aria-label={terminalOpen() ? "close console" : "open console"}
        >
          {">_"}
        </button>
      </div>
      <Show when={terminalOpen()}>
        <div ref={panel} class={styles.panel}>
          <div class={styles.terminal}>
            <TerminalBody
              terminal={props.terminal}
              ref={(handle) => {
                input = handle;
              }}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}
