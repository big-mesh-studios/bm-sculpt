/**
 * One frame's worth of player input, and the listeners that gather it.
 *
 * Every source converges here — keyboard, a pointer-locked mouse, a touch drag
 * and the on-screen joystick — into the single `InputSnapshot` the physics reads.
 * That is deliberate: the movement, the look and the dig/place actions mean the
 * same thing however they arrived, so a touch player and a desktop player are the
 * same player, and the only code that differs is the listeners at the edges.
 *
 * The controller is where a browser's two different looking mechanisms meet: a
 * mouse looks by being **captured** (pointer lock, movement deltas), and a touch
 * looks by being **dragged** (contact deltas). Both end up in `lookDx`/`lookDy`,
 * which the physics applies identically.
 */

/** One frame's worth of player input, gathered from every source and drained once per frame. */
export interface InputSnapshot {
  /** Strafe input, from -1 (left) to 1 (right). */
  moveX: number;
  /** Forward/back input, from -1 (backward) to 1 (forward). */
  moveY: number;
  /** Edge-triggered: true only on the frame the jump was pressed. */
  jump: boolean;
  /**
   * True while the jump input is held. Swims up underwater, and climbs a wall
   * the player is walking into.
   */
  jumpHeld: boolean;
  /** Horizontal look delta accumulated since the last frame (pixels). */
  lookDx: number;
  /** Vertical look delta accumulated since the last frame (pixels). */
  lookDy: number;
  /** Edge-triggered: true only on the frame the dig action fired. Dig removes material. */
  primary: boolean;
  /** True while the dig action is held, so a hold carves continuously. */
  primaryHeld: boolean;
  /** Edge-triggered: true only on the frame the place action fired. Place adds material. */
  secondary: boolean;
  /** True while the place action is held, so a hold builds continuously. */
  secondaryHeld: boolean;
  /** Edge-triggered: true only on the frame the place button went up. */
  secondaryReleased: boolean;
}

/** A snapshot with nothing pressed, for a frame that has no input. */
export const neutralInput = (): InputSnapshot => ({
  moveX: 0,
  moveY: 0,
  jump: false,
  jumpHeld: false,
  lookDx: 0,
  lookDy: 0,
  primary: false,
  primaryHeld: false,
  secondary: false,
  secondaryHeld: false,
  secondaryReleased: false,
});

/** Maps a keydown `KeyboardEvent.code` to its [strafe, forward] contribution. */
const MOVE_KEYS: Record<string, readonly [number, number]> = {
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};

/**
 * Whether the event target is a field a player is typing into, which must keep
 * its keys — the console's own command input above all.
 *
 * Exported because two listeners need it and one definition is the only way to
 * be sure they agree: the console's `/` shortcut must not open the console on a
 * slash typed into the console, and the movement keys must not move the player
 * while one is being typed into it.
 */
export const isEditableTarget = (event: Event): boolean => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
};

export interface InputController {
  /**
   * Binds the canvas and window listeners. Returns a function that removes them,
   * and is safe to call twice. A fresh controller is not listening until this.
   */
  attach(canvas: HTMLCanvasElement): () => void;
  /** Removes every listener, including `attach`'s. */
  dispose(): void;
  /** Whether the listeners act. False while a menu owns the keyboard. */
  setEnabled(enabled: boolean): void;
  /** Returns the frame's input and clears the per-frame edges and deltas. */
  consume(): InputSnapshot;
  /** The on-screen joystick's direction, in [-1, 1], y up. */
  setTouchMove(x: number, y: number): void;
  /** The on-screen dig button's held state. */
  setTouchPrimary(held: boolean): void;
  /** The on-screen place button's held state. */
  setTouchSecondary(held: boolean): void;
  /** The on-screen jump button's held state. */
  setTouchJump(held: boolean): void;
  /** Edge-triggered jump, for a button that only needs the press. */
  queueJump(): void;
  /** Accumulates a drag-to-look delta, in client pixels. */
  addLookDelta(dx: number, dy: number): void;
  /** Whether the canvas currently holds the pointer lock. */
  pointerLocked(): boolean;
  /** Subscribes to pointer-lock changes; returns a function that removes it. */
  onPointerLockChange(listener: (locked: boolean) => void): () => void;
  /**
   * Gives up the pointer lock while something else wants the cursor — the
   * console, above all, since a locked pointer swallows every keystroke aimed
   * anywhere but the crosshair.
   *
   * Counted rather than a boolean, because two things can want the cursor at
   * once and the lock must not be handed back to the first one to finish. The
   * returned function releases this one hold, is safe to call twice, and
   * deliberately does **not** re-take the lock: the canvas re-takes it on the
   * next click, and taking it back unasked would fight the "click to play"
   * prompt that appears alongside it. See ADR 0010.
   */
  suspendPointerLock(): () => void;
  /** Whether something is currently holding the pointer lock released. */
  pointerLockSuspended(): boolean;
  /** Subscribes to suspension changes; returns a function that removes it. */
  onPointerLockSuspensionChange(
    listener: (suspended: boolean) => void,
  ): () => void;
}

/** Radians of look per pixel is small, so deltas are scaled by the physics, not here. */
export const createInput = (): InputController => {
  let keyMoveX = 0;
  let keyMoveY = 0;
  let touchMoveX = 0;
  let touchMoveY = 0;
  let jumpQueued = false;
  let lookDx = 0;
  let lookDy = 0;
  let primaryQueued = false;
  let secondaryQueued = false;
  let secondaryReleasedQueued = false;

  /** Which sources hold each action, so releasing one never clears another. */
  const sources = {
    jumpKey: false,
    jumpTouch: false,
    primaryMouse: false,
    primaryTouch: false,
    secondaryMouse: false,
    secondaryTouch: false,
  };
  let enabled = true;
  let canvas: HTMLCanvasElement | undefined;
  let controller: AbortController | null = null;
  /** Whether a touch drag-to-look is in progress, and which pointer owns it. */
  let lookPointer: number | undefined;
  let lookPointerLastX = 0;
  let lookPointerLastY = 0;
  let locked = false;
  const lockListeners = new Set<(locked: boolean) => void>();
  /** The holders keeping the pointer lock released, one entry each. */
  const holders = new Set<symbol>();
  let suspended = false;
  const suspensionListeners = new Set<(suspended: boolean) => void>();

  const markMove = (x: number, y: number): void => {
    lookDx += x;
    lookDy += y;
  };

  const syncPointerLock = (): void => {
    const next = canvas !== undefined && document.pointerLockElement === canvas;
    if (next === locked) return;
    locked = next;
    for (const listener of lockListeners) listener(locked);
  };

  const syncSuspension = (): void => {
    const next = holders.size > 0;
    if (next === suspended) return;
    suspended = next;
    for (const listener of suspensionListeners) listener(suspended);
  };

  /**
   * Holds are a set of tokens rather than a count, which settles two ways a
   * count gets wrong at once: a disposer called twice deletes one entry and
   * stops, and a disposer called after a teardown — the holders having already
   * been cleared — finds nothing of its own to delete and stops. Either way the
   * first holder's disposal can never take the lock back from the rest.
   *
   * The lock is only let go when the first holder asks, and nothing here ever
   * re-takes it. A browser that refused the lock, or a canvas that has since
   * been replaced, would both end up granted one the player never asked for
   * again.
   */
  const suspendPointerLock = (): (() => void) => {
    const token = Symbol();
    holders.add(token);
    if (holders.size === 1) {
      if (locked) {
        void document.exitPointerLock?.();
      }
      syncSuspension();
    }

    return () => {
      if (!holders.delete(token)) return;
      if (holders.size === 0) {
        syncSuspension();
      }
    };
  };

  const install = (): void => {
    if (controller !== null) return;
    controller = new AbortController();
    const { signal } = controller;

    window.addEventListener(
      "keydown",
      (event) => {
        if (!enabled || isEditableTarget(event)) return;
        if (event.code === "Space") {
          event.preventDefault();
          if (!sources.jumpKey) {
            sources.jumpKey = true;
            jumpQueued = true;
          }
          return;
        }
        const move = MOVE_KEYS[event.code];
        if (move === undefined || event.repeat) return;
        event.preventDefault();
        keyMoveX += move[0];
        keyMoveY += move[1];
      },
      { signal },
    );

    window.addEventListener(
      "keyup",
      (event) => {
        if (!enabled || isEditableTarget(event)) return;
        if (event.code === "Space") {
          sources.jumpKey = false;
          return;
        }
        const move = MOVE_KEYS[event.code];
        if (move === undefined) return;
        event.preventDefault();
        keyMoveX -= move[0];
        keyMoveY -= move[1];
      },
      { signal },
    );

    // A locked mouse looks by movement and acts on its buttons. The listeners are
    // on the window because a locked pointer is not delivered to the element.
    window.addEventListener(
      "mousedown",
      (event) => {
        if (!enabled || document.pointerLockElement !== canvas) return;
        if (event.button === 0) {
          sources.primaryMouse = true;
          primaryQueued = true;
        } else if (event.button === 2) {
          sources.secondaryMouse = true;
          secondaryQueued = true;
        }
      },
      { signal },
    );
    window.addEventListener(
      "mouseup",
      (event) => {
        if (event.button === 0) sources.primaryMouse = false;
        else if (event.button === 2) {
          if (sources.secondaryMouse) secondaryReleasedQueued = true;
          sources.secondaryMouse = false;
        }
      },
      { signal },
    );
    window.addEventListener(
      "mousemove",
      (event) => {
        if (!enabled || document.pointerLockElement !== canvas) return;
        markMove(event.movementX, event.movementY);
      },
      { signal },
    );

    document.addEventListener("pointerlockchange", syncPointerLock, { signal });
    // The right button places, so the browser's own context menu is suppressed
    // across the page rather than only over the canvas.
    window.addEventListener("contextmenu", (e) => e.preventDefault(), {
      signal,
    });

    syncPointerLock();
  };

  const detachCanvas = (): void => {
    if (canvas === undefined) return;
    canvas.removeEventListener("pointerdown", onCanvasPointerDown);
    canvas.removeEventListener("pointermove", onCanvasPointerMove);
    canvas.removeEventListener("pointerup", onCanvasPointerUp);
    canvas.removeEventListener("pointercancel", onCanvasPointerUp);
  };

  function onCanvasPointerDown(event: PointerEvent): void {
    if (!enabled) return;
    canvas ??= event.currentTarget as HTMLCanvasElement;

    // A mouse click takes the pointer lock; once locked, looking is the mouse's
    // job and buttons are handled by the window listeners above.
    if (event.pointerType === "mouse") {
      if (document.pointerLockElement !== canvas) {
        void canvas.requestPointerLock?.();
      }
      return;
    }

    // A touch or pen press turns the view by being dragged. Only the first
    // finger is followed, so a second contact does not double the turn rate.
    if (lookPointer !== undefined) return;
    lookPointer = event.pointerId;
    lookPointerLastX = event.clientX;
    lookPointerLastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerMove(event: PointerEvent): void {
    if (lookPointer !== event.pointerId) return;
    const dx = event.clientX - lookPointerLastX;
    const dy = event.clientY - lookPointerLastY;
    lookPointerLastX = event.clientX;
    lookPointerLastY = event.clientY;
    markMove(dx, dy);
  }

  function onCanvasPointerUp(event: PointerEvent): void {
    if (lookPointer !== event.pointerId) return;
    lookPointer = undefined;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  /**
   * Forgets the listeners and everything they were gathering, including the holds
   * the console keeps on the lock — a teardown that left them would have the next
   * suspension read as a second one, and the lock would never be let go again.
   */
  function teardown(): void {
    detachCanvas();
    controller?.abort();
    controller = null;
    canvas = undefined;
    lookPointer = undefined;
    locked = false;
    holders.clear();
    syncSuspension();
  }

  return {
    attach(element) {
      teardown();
      canvas = element;
      element.addEventListener("pointerdown", onCanvasPointerDown);
      element.addEventListener("pointermove", onCanvasPointerMove);
      element.addEventListener("pointerup", onCanvasPointerUp);
      element.addEventListener("pointercancel", onCanvasPointerUp);
      install();
      return teardown;
    },

    dispose() {
      teardown();
    },

    setEnabled(value) {
      enabled = value;
      if (!value) {
        keyMoveX = 0;
        keyMoveY = 0;
        touchMoveX = 0;
        touchMoveY = 0;
      }
    },

    consume() {
      const nextJump = sources.jumpKey || sources.jumpTouch;
      const nextPrimary = sources.primaryMouse || sources.primaryTouch;
      const nextSecondary = sources.secondaryMouse || sources.secondaryTouch;

      const snapshot: InputSnapshot = {
        moveX: clamp(keyMoveX + touchMoveX, -1, 1),
        moveY: clamp(keyMoveY + touchMoveY, -1, 1),
        jump: jumpQueued,
        jumpHeld: nextJump,
        lookDx,
        lookDy,
        primary: primaryQueued,
        primaryHeld: nextPrimary,
        secondary: secondaryQueued,
        secondaryHeld: nextSecondary,
        secondaryReleased: secondaryReleasedQueued,
      };

      jumpQueued = false;
      lookDx = 0;
      lookDy = 0;
      primaryQueued = false;
      secondaryQueued = false;
      secondaryReleasedQueued = false;
      return snapshot;
    },

    setTouchMove(x, y) {
      touchMoveX = clamp(x, -1, 1);
      touchMoveY = clamp(y, -1, 1);
    },

    setTouchPrimary(held) {
      if (held && !sources.primaryTouch) primaryQueued = true;
      sources.primaryTouch = held;
    },

    setTouchSecondary(held) {
      if (held && !sources.secondaryTouch) secondaryQueued = true;
      if (!held && sources.secondaryTouch) secondaryReleasedQueued = true;
      sources.secondaryTouch = held;
    },

    setTouchJump(held) {
      if (held && !sources.jumpTouch) jumpQueued = true;
      sources.jumpTouch = held;
    },

    queueJump() {
      jumpQueued = true;
    },

    addLookDelta(dx, dy) {
      markMove(dx, dy);
    },

    pointerLocked() {
      return locked;
    },

    onPointerLockChange(listener) {
      lockListeners.add(listener);
      return () => {
        lockListeners.delete(listener);
      };
    },

    suspendPointerLock,

    pointerLockSuspended() {
      return suspended;
    },

    onPointerLockSuspensionChange(listener) {
      suspensionListeners.add(listener);
      return () => {
        suspensionListeners.delete(listener);
      };
    },
  };
};

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

/**
 * A deadzone for an analog joystick. Shared by the touch UI and any gamepad,
 * because a stick that reports 0.03 at rest would otherwise walk the player
 * forever.
 */
export const JOYSTICK_DEADZONE = 0.15;
