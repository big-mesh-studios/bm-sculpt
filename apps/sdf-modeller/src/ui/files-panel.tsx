/**
 * "Your files": the document you are working on, what you can do to it, and what you have opened
 * before.
 *
 * ## Why this is a modal dialogue and not a menu in the corner
 *
 * **Because it is a list of files, and a list of files does not fit in a popover.** The actions
 * are five buttons and fit anywhere. The list is a grid of cards, and on a phone it wants the
 * whole screen — which is exactly the arrangement the sibling arrived at, and the reason its
 * dialogue goes full-bleed under 500px.
 *
 * ## Why the dialogue responds to its own width and not the window's
 *
 * **Because it is inset from the window by a clearance on a desktop screen.** A viewport query
 * would fire at the wrong size: at a 712px window the dialogue is 620px and wants the narrow
 * layout, while the window itself is nowhere near any breakpoint. So `.panel` declares
 * `container-type: inline-size` and everything below it is a `@container` query. That is the
 * single most worth-copying detail of the sibling's layout.
 *
 * ## Why the export's numbers are in here rather than in the shell
 *
 * **Because they are about the destination, and the destination is a decision somebody makes
 * once per file.** They sit with the current-document card they apply to, rather than in the
 * footer where they would be two more persistent controls competing with the tools for a thumb.
 */
import { For, Show } from "solid-js";
import type { RGBA } from "@big-mesh-studios/core";

import { homeName, type Home } from "../file/home";
import { REMEMBERED, type RecentFile } from "../file/recent-files";
import { DEFAULT_HEIGHT_MM, printReadout } from "../print/print-problem";
import { DEFAULT_MAX_COLOURS } from "../print/quantise";
import type { MeshResult } from "../model/mesh-model";
import { createPopover } from "./popover";
import {
  CrossIcon,
  CubeIcon,
  FloppyIcon,
  FolderOpenIcon,
  Icon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import controls from "./controls.module.css";
import styles from "./files-panel.module.css";

export function FilesPanel(props: {
  /** Where the document lives, which is what the card under the bar is about. */
  home: () => Home;
  /** How many parts the document has, and whether that is worth showing. */
  parts: () => number;
  palette: () => readonly RGBA[];
  recent: () => readonly RecentFile[];
  /** The browser can hold on to files at all, and so whether the list is worth drawing. */
  canRemember: () => boolean;
  /** The draft this browser is holding, and when it was written. */
  draftAt: () => number | undefined;
  /** The last mesh, for the export's readout. */
  mesh: () => MeshResult | undefined;
  height: () => string;
  filaments: () => string;
  notice: () => string | undefined;
  busy: () => boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onHeight: (value: string) => void;
  onFilaments: (value: string) => void;
  onOpenRecent: (file: RecentFile) => void;
  onForgetRecent: (id: string) => void;
  onClose: () => void;
}) {
  // **Not drawn through a portal**, because the trigger is inside a modal dialogue and a panel in
  // the body of the document is outside that dialogue — which the dialogue sits on top of. The
  // panel would open in the right place and take no clicks at all.
  const ExportPopover = createPopover({ portal: false });

  return (
    <div class={styles.panel}>
      {/*
        **A grid of named areas rather than a flex row, and the slack goes to the name.**

        `minmax(0, 1fr)` in the middle is what lets the document's name ellipsis instead of
        pushing the buttons off the end of the row, and it is the reason the fixed-width action
        columns are safe: the name absorbs everything and gives none of it back.
      */}
      <div class={styles.bar}>
        <button
          type="button"
          class={`${controls.button} ${styles.new}`}
          disabled={props.busy()}
          title="Start a new model"
          onClick={() => props.onNew()}
        >
          <span class={controls.icon}>
            <PlusIcon />
          </span>
          <span class={controls.label}>New</span>
        </button>

        <button
          type="button"
          class={`${controls.button} ${styles.open}`}
          disabled={props.busy()}
          title="Open a model from disk"
          onClick={() => props.onOpen()}
        >
          <span class={controls.icon}>
            <FolderOpenIcon />
          </span>
          <span class={controls.label}>Open</span>
        </button>

        <button
          type="button"
          class={`${controls.button} ${styles.save}`}
          disabled={props.busy()}
          title="Write this model to a file"
          onClick={() => props.onSave()}
        >
          <span class={controls.icon}>
            <FloppyIcon />
          </span>
          <span class={controls.label}>Save</span>
        </button>

        {/*
          **The export is a popover because it is three things and two of them are numbers.**
          Height in millimetres and filaments are questions about the printer, asked once per
          file rather than held on screen; the sibling puts them in exactly this shape for exactly
          this reason.
        */}
        <ExportPopover.Trigger
          class={`${controls.button} ${styles.export}`}
          title="Write this model out for a 3D printer"
        >
          <span class={controls.icon}>
            <CubeIcon />
          </span>
          <span class={controls.label}>Export</span>
        </ExportPopover.Trigger>

        <button
          type="button"
          class={`${controls.button} ${styles.close}`}
          title="Close"
          onClick={() => props.onClose()}
        >
          <span class={controls.icon}>
            <CrossIcon />
          </span>
        </button>

        <p class={styles.title}>
          <span class={controls.label}>{homeName(props.home())}</span>
          {props.home().kind === "nowhere" ? (
            <span class={styles.where}>not saved anywhere yet</span>
          ) : (
            <span class={styles.where}>· {props.parts()} parts</span>
          )}
        </p>
      </div>

      <ExportPopover.Panel class={`${controls.popover} ${styles.exportPanel}`}>
        <label class={controls.field}>
          <span>Height</span>
          <input
            type="number"
            min={1}
            step={1}
            value={props.height() === "" ? DEFAULT_HEIGHT_MM : props.height()}
            onInput={(event: Event & { currentTarget: HTMLInputElement }) => {
              props.onHeight(event.currentTarget.value);
            }}
          />
          <span>mm</span>
        </label>

        <label class={controls.field}>
          <span>Filaments</span>
          <input
            type="number"
            min={1}
            step={1}
            value={
              props.filaments() === "" ? DEFAULT_MAX_COLOURS : props.filaments()
            }
            onInput={(event: Event & { currentTarget: HTMLInputElement }) => {
              props.onFilaments(event.currentTarget.value);
            }}
          />
        </label>

        {/*
          **The mesh report, verbatim, because it is the same sentence the export refuses with.**
          Nothing here decides anything; it is there so that a person finds out a model is a
          lidless shell while they are looking at the control that would send it to a printer.
        */}
        <p class={styles.report}>{printReadout(props.mesh())}</p>

        <button
          type="button"
          class={controls.button}
          disabled={props.busy()}
          onClick={() => props.onExport()}
        >
          <span class={controls.icon}>
            <CubeIcon />
          </span>
          <span class={controls.label}>Export .3mf</span>
        </button>
      </ExportPopover.Panel>

      {/*
        **The refusal, in the body rather than in the popover it came from.**

        A message shown on a closed surface is a message nobody reads, and `readProject`'s
        reasons are the only sentence about what is wrong that a person can act on.
      */}
      <Show when={props.notice()}>
        {(message) => (
          <p class={styles.notice} role="alert">
            {message()}
          </p>
        )}
      </Show>

      {/*
        **The draft's age, because "your work was restored" is alarming without it.** Somebody
        who reloads after a week needs to know which week.
      */}
      <Show when={props.draftAt()}>
        {(at) => <p class={styles.draft}>saved in this browser {ago(at())}</p>}
      </Show>

      <Show
        when={props.canRemember() && props.recent().length > 0}
        fallback={
          <p class={styles.empty}>
            {props.canRemember()
              ? "No files opened yet. Open one and it will be here."
              : "This browser cannot hold on to files, so there is no list. Saving downloads a file instead."}
          </p>
        }
      >
        <div class={styles.grid}>
          {/*
            **Cards, not a list of names.** A list of file names tells somebody nothing about which
            file is which, and this is a list they pick out of rather than scan. The
            `auto-fill` with a `min()` guard is what makes it four across on a desktop, three on a
            full-width phone and two on a small one, with no media query anywhere.
          */}
          <For each={props.recent().slice(0, REMEMBERED)}>
            {(file) => (
              <div class={styles.card}>
                <button
                  type="button"
                  class={styles.openCard}
                  disabled={props.busy()}
                  title={`Open ${file.name}`}
                  onClick={() => props.onOpenRecent(file)}
                >
                  <div class={styles.preview}>
                    {/*
                      **A number rather than a picture.** Rendering a thumbnail per remembered
                      file means rendering on every autosave to store something that only one of
                      them will ever be looked at again, and the alternative costs nothing: how
                      many parts a file holds is what tells a sphere from a character, and it is
                      already known.
                    */}
                    <span class={styles.partCount}>{file.parts}</span>
                    <span class={styles.partLabel}>
                      {file.parts === 1 ? "part" : "parts"}
                    </span>
                  </div>
                  <span class={styles.name}>
                    <span class={controls.icon}>
                      <FloppyIcon />
                    </span>
                    <span class={controls.label}>{file.name}</span>
                  </span>
                </button>

                <span class={styles.when}>{ago(file.lastOpenedAt)}</span>

                {/*
                  **Hidden behind a hover on a pointer device and always there on a touch one**,
                  **and shown for keyboard focus as well**, because an affordance that only a
                  mouse can find is not available to everybody.
                */}
                <button
                  type="button"
                  class={styles.forget}
                  disabled={props.busy()}
                  title={`Forget ${file.name} — the file on disk is not touched`}
                  onClick={() => props.onForgetRecent(file.id)}
                >
                  <span class={controls.icon}>
                    <TrashIcon />
                  </span>
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * How long ago something happened, in the fewest words that are still true.
 *
 * **"a moment ago" rather than a locale date**, because the list is ordered by time and the top
 * of it is what somebody reads. A date is the right answer for everything below three days and
 * the wrong one above it.
 */
export const ago = (at: number, now: number = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "a moment ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
};

/** The glyph for a home, which is what says where a document came from. */
export const HomeIcon = () => <Icon kind="floppy" />;
