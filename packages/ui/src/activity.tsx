import type { JSX } from "@solidjs/web/jsx-runtime";

/**
 * Keeps `children` mounted, and only hides them.
 *
 * ## Why this is here rather than `<Show>`
 *
 * **Because this repository has canvases, and a real unmount destroys one.**
 * `<Show when={narrow}>` swapping between a desktop layout and a mobile one tears
 * down whatever was inside it — and in an application whose entire content is a
 * WebGL scene graph, that means losing the context, the compiled shaders, the worker
 * pool, and everything uploaded so far. Rotating a phone would then cost a second
 * before the first frame, on every rotation.
 *
 * The sibling hit this and wrote this: `display: contents` while active, `none`
 * while hidden. `contents` matters as much as `none` — it keeps the wrapper out of
 * layout entirely, so a component's parent does not have to know there is a wrapper
 * at all. Solid has no built-in equivalent (React's `Activity` and `Offscreen` are
 * the same idea).
 *
 * The cost is real and worth naming: **hidden children keep whatever they hold.** A
 * hidden tab's scroll position, a closed picker's in-progress gesture and a paused
 * render loop all survive. That is the point, and it is also why a hidden subtree
 * that is expensive to keep alive has to be cheap to leave alone.
 */
export function Activity(props: {
  when: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div style={{ display: props.when ? "contents" : "none" }}>
      {props.children}
    </div>
  );
}
