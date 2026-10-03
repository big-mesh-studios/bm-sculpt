// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { onSettled } from "solid-js";

/**
 * The lifecycle this application depends on.
 *
 * ## The bug this exists for
 *
 * **`ref={canvas}` is assigned *after* the component body runs.** Creating the renderer
 * in the body therefore hands `createViewport` an `undefined` canvas, which it passes
 * straight to `ResizeObserver.observe`, and the browser throws:
 *
 *     Failed to execute 'observe' on 'ResizeObserver': parameter 1 is not of type 'Element'
 *
 * It type-checked and built cleanly, because `let canvas!: HTMLCanvasElement` is a promise
 * about the type rather than a guarantee about the value. Nothing caught it but running it.
 *
 * ## Why it is tested here rather than by running the application
 *
 * **Because jsdom has no WebGL context**, so mounting the real `App` here fails inside
 * rmsl's `WebGLRenderer` rather than in this application's code — which would make the
 * test a test of jsdom. What is worth pinning is the *ordering*, and that is testable with
 * a bare canvas.
 */
describe("a ref and the lifecycle around it", () => {
  it("has the element by the time onSettled runs", () => {
    let assigned: HTMLCanvasElement | undefined;
    let atSettled: HTMLCanvasElement | undefined;
    let inBody: HTMLCanvasElement | undefined;

    const Probe = () => {
      let canvas!: HTMLCanvasElement;
      // Read in the body, which is where the viewport used to be created and where the
      // value is still undefined.
      inBody = canvas;
      onSettled(() => {
        atSettled = canvas;
      });
      return (
        <canvas
          ref={(element) => {
            canvas = element;
            assigned = element;
          }}
        />
      );
    };

    const root = document.createElement("div");
    document.body.append(root);
    render(() => <Probe />, root);
    flush();

    expect(
      inBody,
      "the element is not there while the body runs",
    ).toBeUndefined();
    expect(assigned, "the ref callback ran").toBeDefined();
    expect(
      atSettled,
      "onSettled runs after the ref, which is why the renderer is built there",
    ).toBe(assigned);
  });

  it("tears down through the callback's return, because onCleanup inside onSettled is an error", () => {
    // **Solid 2's `onSettled` does not return a disposal** — the callback returns the
    // teardown itself, and an `onCleanup` registered inside one is a dev-mode error that
    // halts the reactive system. The house pattern in the landscape's `app.tsx` says so
    // and this application follows it; this asserts the shape rather than the rule.
    let ran = false;
    const dispose = render(() => {
      onSettled(() => () => {
        ran = true;
      });
      return <div />;
    }, document.createElement("div"));
    flush();
    expect(ran, "the teardown has not run while mounted").toBe(false);
    dispose();
    expect(ran, "the returned teardown ran on dispose").toBe(true);
  });
});
