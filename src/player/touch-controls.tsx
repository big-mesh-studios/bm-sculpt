/**
 * The on-screen controls for a touch device: a movement stick and three buttons.
 *
 * A stick and buttons rather than gestures alone, because the canvas drag is
 * already the look gesture — the one thing a touch screen does better than a
 * mouse — and every world action needs a target a thumb can find without moving
 * the camera. A drag that digs would put the surface under a moving view, which
 * is exactly the dab-in-the-wrong-place error the aim tool exists to avoid.
 *
 * The controls only push into the `InputController`; they decide nothing about
 * the game. That is what keeps a touch player and a desktop player the same
 * player: both end up in the same `InputSnapshot`.
 */

import { createSignal } from "solid-js";

import { JOYSTICK_DEADZONE, type InputController } from "./input";

export interface TouchControlsProps {
  readonly input: InputController;
}

const BUTTON_SIZE = 64;
const STICK_SIZE = 120;

export function TouchControls(props: TouchControlsProps) {
  return (
    <div
      style={{
        position: "absolute",
        inset: "0",
        "pointer-events": "none",
        "user-select": "none",
      }}
    >
      <Joystick
        onChange={(x, y) => props.input.setTouchMove(x, y)}
        onRelease={() => props.input.setTouchMove(0, 0)}
      />
      <div
        style={{
          position: "absolute",
          right: "20px",
          bottom: "28px",
          display: "flex",
          "flex-direction": "column",
          gap: "12px",
          "align-items": "flex-end",
        }}
      >
        <HoldButton
          label="Place"
          onDown={() => props.input.setTouchSecondary(true)}
          onUp={() => props.input.setTouchSecondary(false)}
        />
        <HoldButton
          label="Dig"
          onDown={() => props.input.setTouchPrimary(true)}
          onUp={() => props.input.setTouchPrimary(false)}
        />
        <HoldButton
          label="Jump"
          onDown={() => {
            props.input.setTouchJump(true);
            props.input.queueJump();
          }}
          onUp={() => props.input.setTouchJump(false)}
        />
      </div>
    </div>
  );
}

interface HoldButtonProps {
  readonly label: string;
  readonly onDown: () => void;
  readonly onUp: () => void;
}

/** A button that reports being held, so a hold carves or builds continuously. */
function HoldButton(props: HoldButtonProps) {
  const [down, setDown] = createSignal(false);
  const release = (): void => {
    if (!down()) return;
    setDown(false);
    props.onUp();
  };
  return (
    <button
      type="button"
      style={{
        width: `${BUTTON_SIZE}px`,
        height: `${BUTTON_SIZE}px`,
        "border-radius": "50%",
        border: "2px solid rgba(255,255,255,0.5)",
        background: down() ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.35)",
        color: "white",
        "font-size": "13px",
        "pointer-events": "auto",
        "touch-action": "none",
      }}
      onPointerDown={(event) => {
        setDown(true);
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        props.onDown();
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      {props.label}
    </button>
  );
}

interface JoystickProps {
  readonly onChange: (x: number, y: number) => void;
  readonly onRelease: () => void;
}

/** A self-centring stick; reports a direction in [-1, 1] with y up. */
function Joystick(props: JoystickProps) {
  let base!: HTMLDivElement;
  const [knob, setKnob] = createSignal({ x: 0, y: 0 });
  let pointer: number | undefined;

  const track = (clientX: number, clientY: number): void => {
    const rect = base.getBoundingClientRect();
    const radius = rect.width / 2;
    const cx = rect.left + radius;
    const cy = rect.top + radius;
    let dx = (clientX - cx) / radius;
    let dy = (clientY - cy) / radius;
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    setKnob({ x: dx, y: dy });
    if (Math.hypot(dx, dy) < JOYSTICK_DEADZONE) {
      props.onChange(0, 0);
    } else {
      // Screen y grows down; the input's forward is up.
      props.onChange(dx, -dy);
    }
  };

  const release = (): void => {
    pointer = undefined;
    setKnob({ x: 0, y: 0 });
    props.onRelease();
  };

  return (
    <div
      ref={base}
      style={{
        position: "absolute",
        left: "24px",
        bottom: "28px",
        width: `${STICK_SIZE}px`,
        height: `${STICK_SIZE}px`,
        "border-radius": "50%",
        border: "2px solid rgba(255,255,255,0.4)",
        background: "rgba(0,0,0,0.25)",
        "pointer-events": "auto",
        "touch-action": "none",
      }}
      onPointerDown={(event) => {
        if (pointer !== undefined) return;
        pointer = event.pointerId;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        track(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (pointer !== event.pointerId) return;
        track(event.clientX, event.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: "48px",
          height: "48px",
          margin: "-24px 0 0 -24px",
          "border-radius": "50%",
          background: "rgba(255,255,255,0.5)",
          transform: `translate(${knob().x * (STICK_SIZE / 2 - 24)}px, ${knob().y * (STICK_SIZE / 2 - 24)}px)`,
        }}
      />
    </div>
  );
}
