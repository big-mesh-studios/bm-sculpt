/**
 * A modal dialogue, and the one-line wrapper that opens and closes it.
 *
 * ## Why a real `<dialog>` and not a div in the top layer
 *
 * **Because the browser then owns four things this application would otherwise write by hand:**
 * the `Esc` key, the click on the backdrop, the focus trap, and the top layer that puts the
 * dialogue above everything including a portal-to-body popover. Each of those is a small feature
 * with a small way to be subtly wrong, and all four are already right.
 *
 * ## Why the backdrop is the dialogue's own click
 *
 * **`event.target === element` is the whole of click-outside-to-close.** A click on the backdrop
 * lands on the dialogue element, because a modal dialogue's backdrop *is* its own background
 * area; a click on anything inside it lands on that thing instead. One comparison, no sentinel
 * element, no listener on the document.
 *
 * ## Why the anchoring and the backdrop styling live in the caller's stylesheet
 *
 * **Because this module has no opinion about where the dialogue goes or what it looks like.**
 * The sibling keeps them in its HUD's stylesheet rather than in the dialogue component, and that
 * is the arrangement worth copying: one stylesheet owns the whole screen's composition instead of
 * each component owning a piece of it.
 */
import { Portal, type JSX } from "@solidjs/web";
import { createSignal, onCleanup } from "solid-js";

export interface DialogProps {
  readonly class?: string;
  readonly children: JSX.Element;
}

/**
 * A dialogue bound to one `<dialog>` element.
 *
 * **The element is created once and remembered, because `showModal` needs it.** A ref assigned
 * after the body runs is why `open` does nothing if it is called before the first paint — which
 * is the same ordering problem `App`'s canvas has, and the reason the two are handled the same
 * way here.
 */
export const createDialog = (): {
  readonly isOpen: () => boolean;
  readonly open: () => void;
  readonly close: () => void;
  readonly Dialog: (props: DialogProps) => JSX.Element;
} => {
  let element!: HTMLDialogElement;
  const [isOpen, setIsOpen] = createSignal(false);

  // **A dialogue closed by the browser** — Escape, or the form method — has to clear the signal
  // too, or the tab that opened it would still read as selected.
  onCleanup(() => element?.close());

  return {
    isOpen,

    open: () => {
      element?.showModal();
      setIsOpen(true);
    },

    close: () => element?.close(),

    Dialog(props: DialogProps) {
      return (
        <Portal>
          <dialog
            ref={(found: HTMLDialogElement | undefined) => {
              element = found as HTMLDialogElement;
            }}
            class={props.class}
            onClose={() => {
              setIsOpen(false);
            }}
            onClick={(event: MouseEvent) => {
              // The backdrop is part of the dialogue, so a click that lands on the element
              // rather than on anything inside it is a click outside — which closes, as it
              // does for a popover.
              if (event.target === element) element.close();
            }}
          >
            {props.children}
          </dialog>
        </Portal>
      );
    },
  };
};
