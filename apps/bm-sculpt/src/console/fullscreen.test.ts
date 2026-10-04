// @vitest-environment jsdom

/**
 * `/fullscreen` against a DOM, because the whole command is the DOM: there is no
 * game state, no field and no renderer in it. jsdom implements none of the three
 * APIs it touches — fullscreen, the screen orientation lock, or either of their
 * promises — so each is stubbed here rather than feature-detected around.
 *
 * Ported from `big-mesh-studios`'s `apps/voxelscape/src/fullscreen-command.test.ts`,
 * which asserts the same five outcomes against a command that reports the
 * browser's actual answers. This one reports what it asked for instead (see the
 * comment on the command), so two of those assertions became checks on the
 * request made rather than on the line printed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommands, type CommandOutput } from "./commands";

interface OrientationStub {
  lock: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
}

const setOrientation = (orientation: OrientationStub | undefined): void => {
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: orientation,
  });
};

const setFullscreenElement = (element: Element | null): void => {
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: element,
  });
};

const setFullscreenEnabled = (enabled: boolean | undefined): void => {
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    value: enabled,
  });
};

/** The command table, built over setters, a clock and clouds it never calls. */
const commands = () =>
  createCommands({
    setFlying: () => "flying",
    setNoClip: () => "no-clip",
    toSpace: () => "in space",
    clock: {
      jumpTo: () => {},
      clearOverride: () => {},
      setSpeed: () => {},
      describe: () => "phase: day | t=0.0s | speed=1× | live",
    },
    cloud: {
      coverage: () => "coverage 0.520",
      density: () => "density 1.000",
      state: () => "built",
    },
  });

const run = (line: string): string => {
  const output: CommandOutput = commands().run(line);
  if (typeof output !== "string") {
    throw new Error("expected text");
  }
  return output;
};

const requestFullscreen = vi.fn().mockResolvedValue(undefined);
const exitFullscreen = vi.fn().mockResolvedValue(undefined);

// Installed before each test rather than after: jsdom implements neither method,
// so the first test to run would otherwise find them missing.
beforeEach(() => {
  document.body.requestFullscreen = requestFullscreen;
  document.exitFullscreen = exitFullscreen;
});

afterEach(() => {
  vi.clearAllMocks();
  delete (window.screen as { orientation?: unknown }).orientation;
  setFullscreenElement(null);
  setFullscreenEnabled(undefined);
});

describe("/fullscreen entering", () => {
  it("requests fullscreen and locks landscape when given nothing to go on", () => {
    const orientation = {
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn(),
    };
    setOrientation(orientation);

    const said = run("/fullscreen");
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(orientation.lock).toHaveBeenCalledWith("landscape");
    expect(said).toContain("landscape");
  });

  it("locks the orientation it is asked for", () => {
    const orientation = {
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn(),
    };
    setOrientation(orientation);

    run("/fullscreen true portrait");
    expect(orientation.lock).toHaveBeenCalledWith("portrait");
  });

  it("keeps every argument, not just the first, for its orientation", () => {
    // The first word after the name is the on/off flag, so the orientation is
    // only reached by the second. Dropping the flag would read "portrait" as
    // the flag — which is truthy, so it would still enter fullscreen, but
    // sideways the wrong way.
    const orientation = {
      lock: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn(),
    };
    setOrientation(orientation);

    run("/fullscreen true portrait");
    expect(orientation.lock).toHaveBeenCalledWith("portrait");
    run("/fullscreen true");
    expect(orientation.lock).toHaveBeenLastCalledWith("landscape");
  });

  it("still requests fullscreen where the orientation lock is absent", () => {
    setOrientation(undefined);

    const said = run("/fullscreen");
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(said).toContain("landscape");
  });

  it("still requests fullscreen where the lock is refused", () => {
    // A browser that rejects the lock has, by definition, nothing to report
    // that the player could act on — and the rejection must not escape as an
    // unhandled one.
    setOrientation({
      lock: vi.fn().mockRejectedValue(new Error("not allowed")),
      unlock: vi.fn(),
    });

    expect(run("/fullscreen")).toContain("landscape");
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("says so, rather than asking, when the browser will not go fullscreen", () => {
    setFullscreenEnabled(false);

    expect(run("/fullscreen")).toBe(
      "this browser will not enter fullscreen here.",
    );
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});

describe("/fullscreen leaving", () => {
  it("unlocks the orientation and exits fullscreen when told to", () => {
    const orientation = { lock: vi.fn(), unlock: vi.fn() };
    setOrientation(orientation);
    setFullscreenElement(document.body);

    run("/fullscreen false");
    expect(orientation.unlock).toHaveBeenCalledOnce();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("leaves fullscreen with no arguments when already in it", () => {
    // The button's whole behaviour in one case: no argument means "the other
    // way round from where we are", so the same command both enters and leaves.
    setFullscreenElement(document.body);

    run("/fullscreen");
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("enters with no arguments when not already in it", () => {
    setFullscreenElement(null);

    run("/fullscreen");
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});
