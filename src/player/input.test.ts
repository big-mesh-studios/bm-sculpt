// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { createInput, type InputController } from "./input";

let controller: InputController | undefined;

const attach = (): InputController => {
  controller = createInput();
  const canvas = document.createElement("canvas");
  controller.attach(canvas);
  return controller;
};

afterEach(() => {
  controller?.dispose();
  controller = undefined;
});

const key = (type: "keydown" | "keyup", code: string): void => {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
};

describe("keyboard movement", () => {
  it("holds a direction until the key is released", () => {
    const input = attach();
    key("keydown", "KeyW");
    expect(input.consume().moveY).toBe(1);
    // Still held: the snapshot is a property of state, not an edge.
    expect(input.consume().moveY).toBe(1);
    key("keyup", "KeyW");
    expect(input.consume().moveY).toBe(0);
  });

  it("adds opposite keys to nothing", () => {
    const input = attach();
    key("keydown", "KeyA");
    key("keydown", "KeyD");
    expect(input.consume().moveX).toBe(0);
  });
});

describe("jump", () => {
  it("is an edge on the frame it is pressed", () => {
    const input = attach();
    key("keydown", "Space");
    const first = input.consume();
    expect(first.jump).toBe(true);
    expect(first.jumpHeld).toBe(true);
    // The edge is gone, the hold stays.
    const second = input.consume();
    expect(second.jump).toBe(false);
    expect(second.jumpHeld).toBe(true);
    key("keyup", "Space");
    expect(input.consume().jumpHeld).toBe(false);
  });
});

describe("touch", () => {
  it("reports the joystick direction", () => {
    const input = attach();
    input.setTouchMove(0.5, -0.25);
    const snap = input.consume();
    expect(snap.moveX).toBe(0.5);
    expect(snap.moveY).toBe(-0.25);
  });

  it("emits a dig edge once and holds while held", () => {
    const input = attach();
    input.setTouchPrimary(true);
    const first = input.consume();
    expect(first.primary).toBe(true);
    expect(first.primaryHeld).toBe(true);
    const second = input.consume();
    expect(second.primary).toBe(false);
    expect(second.primaryHeld).toBe(true);
    input.setTouchPrimary(false);
    expect(input.consume().primaryHeld).toBe(false);
  });

  it("reports a place release", () => {
    const input = attach();
    input.setTouchSecondary(true);
    expect(input.consume().secondary).toBe(true);
    input.setTouchSecondary(false);
    expect(input.consume().secondaryReleased).toBe(true);
  });

  it("queues a jump from a button", () => {
    const input = attach();
    input.queueJump();
    expect(input.consume().jump).toBe(true);
  });

  it("accumulates a look delta and drains it", () => {
    const input = attach();
    input.addLookDelta(4, -3);
    input.addLookDelta(1, 1);
    const snap = input.consume();
    expect(snap.lookDx).toBe(5);
    expect(snap.lookDy).toBe(-2);
    expect(input.consume().lookDx).toBe(0);
  });
});
