/**
 * A popover and the button that opens it, wired to each other by name.
 *
 * ## Why the pairing is generated rather than written out
 *
 * **Because an anchor name has to match exactly and nothing checks it if it does not.** A
 * `popovertarget` that names no element, or a `position-anchor` that names no trigger, is two
 * silent failures: the panel opens in the corner and the trigger does nothing. A counter in the
 * factory makes them match by construction, so the wiring cannot be got wrong at a call site.
 *
 * ## The two properties a popover needs before anchoring means anything
 *
 * **`inset: unset` and `position: absolute`**, in that order and both of them. The user agent
 * gives every `[popover]` `position: fixed; inset: 0; margin: auto`, which centres it — and
 * `margin: auto` in particular silently defeats `left: anchor(left)` by centring the box
 * *within* the anchored edge. Every popover stylesheet in this application therefore opens with
 * those two lines, and a rule that sets a position without them is a rule that does not work.
 *
 * ## Why `portal` is an option
 *
 * **Because a modal dialogue sits in the top layer, above the document body.** A popover portalled
 * to `<body>` from inside a `showModal()` dialogue would open in the right place and take no
 * clicks at all: the dialogue is above it. So the sibling creates its one in-dialogue popover with
 * `portal: false`, and that is not a special case to remember but a flag to pass.
 */
import { Portal, type JSX } from "@solidjs/web";

export interface PopoverOptions {
  /**
   * Where the panel is put in the document.
   *
   * `false` for a popover inside a modal dialogue, whose top layer is above the body.
   */
  readonly portal?: boolean;
}

export interface TriggerProps {
  readonly class?: string;
  readonly title?: string;
  /** Set by the caller to mark the trigger as the open one, for styling and `aria`. */
  readonly selected?: boolean;
  readonly children: JSX.Element;
}

export interface PanelProps {
  readonly class?: string;
  readonly style?: JSX.CSSProperties;
  readonly children: JSX.Element;
}

let counter = 0;

export const createPopover = (
  options: PopoverOptions = {},
): {
  readonly Trigger: (props: TriggerProps) => JSX.Element;
  readonly Panel: (props: PanelProps) => JSX.Element;
} => {
  // **One name per popover, derived from a counter.** `--popover-0`, `--popover-1`, and so on,
  // so the trigger's `anchor-name` and the panel's `position-anchor` are the same string by
  // construction rather than by two halves of it being typed the same way.
  const id = `popover-${counter++}`;

  const Trigger = (props: TriggerProps): JSX.Element => (
    <button
      type="button"
      aria-expanded={props.selected === true ? "true" : undefined}
      style={{ "anchor-name": `--${id}` }}
      popovertarget={id}
      class={props.class}
      title={props.title}
    >
      {props.children}
    </button>
  );

  const Panel = (props: PanelProps): JSX.Element => {
    const panel = (
      <div
        id={id}
        popover="auto"
        class={props.class}
        style={{ "position-anchor": `--${id}`, ...props.style }}
      >
        {props.children}
      </div>
    );
    return options.portal === false ? panel : <Portal>{panel}</Portal>;
  };

  return { Trigger, Panel };
};
