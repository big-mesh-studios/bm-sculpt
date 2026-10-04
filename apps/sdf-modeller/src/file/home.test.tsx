// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { NOWHERE, homeName, homeWriter, type Home } from "./home";
import { ago } from "../ui/files-panel";
import type { FileSystemHandleLike } from "./save-file";

const handleTo = (name: string): FileSystemHandleLike => ({
  name,
  getFile: async () => new File([name], name),
  createWritable: async () => ({
    write: async () => {},
    close: async () => {},
  }),
  isSameEntry: async (other) => other.name === name,
  queryPermission: async () => "granted",
  requestPermission: async () => "granted",
});

describe("home", () => {
  it("is nowhere to begin with, which is a state and not an absence", () => {
    // **Because it is a decision somebody has to be able to act on.** `undefined` would mean the
    // same as "not loaded yet", and Save — which writes back where the document came from —
    // would have to ask which.
    expect(NOWHERE.kind).toBe("nowhere");
    expect(homeName(NOWHERE)).toBe("model");
  });

  it("names a file by the file's own name", () => {
    const home: Home = {
      kind: "file",
      id: "a",
      handle: handleTo("duck.sdfmod"),
      name: "duck.sdfmod",
    };

    expect(homeName(home)).toBe("duck.sdfmod");
  });

  it("has nowhere to write when there is nowhere", () => {
    expect(homeWriter(NOWHERE)).toBeUndefined();
  });

  it("writes through the handle when it has one", async () => {
    // **And closes the stream**, which is the half that is easy to forget and produces a save
    // that silently does nothing: the bytes sit in a buffer and the file on disk is unchanged.
    let written = "";
    let closed = false;
    const home: Home = {
      kind: "file",
      id: "a",
      handle: {
        ...handleTo("duck.sdfmod"),
        createWritable: async () => ({
          write: async (blob: Blob) => {
            written = await blob.text();
          },
          close: async () => {
            closed = true;
          },
        }),
      },
      name: "duck.sdfmod",
    };

    await homeWriter(home)?.(new Blob(["the model"]));

    expect(written).toBe("the model");
    expect(closed).toBe(true);
  });
});

describe("ago", () => {
  /** A fixed "now", so the tests do not depend on when they run. */
  const at = Date.parse("2026-01-15T12:00:00Z");
  const agoFrom = (then: string) => ago(Date.parse(then), at);

  it("says a moment ago for anything inside a minute", () => {
    // **And not a clock time.** A list ordered by time is read from the top, and somebody who
    // saved something ten seconds ago does not need to know what time it is.
    expect(agoFrom("2026-01-15T11:59:30Z")).toBe("a moment ago");
    expect(agoFrom("2026-01-15T11:59:59Z")).toBe("a moment ago");
  });

  it("says minutes up to an hour", () => {
    expect(agoFrom("2026-01-15T11:45:00Z")).toBe("15 min ago");
    expect(agoFrom("2026-01-15T11:01:00Z")).toBe("59 min ago");
  });

  it("says hours up to a day", () => {
    expect(agoFrom("2026-01-15T11:00:00Z")).toBe("1 hour ago");
    expect(agoFrom("2026-01-15T09:00:00Z")).toBe("3 hours ago");
  });

  it("says yesterday, and then days", () => {
    expect(agoFrom("2026-01-14T12:00:00Z")).toBe("yesterday");
    expect(agoFrom("2026-01-12T12:00:00Z")).toBe("3 days ago");
    expect(agoFrom("2026-01-09T12:00:00Z")).toBe("6 days ago");
  });

  it("falls back to a date past a week", () => {
    // **A date and not "N days ago"**, because at a fortnight "13 days ago" is harder to place
    // than a date and the list is full of files either way.
    expect(agoFrom("2026-01-01T12:00:00Z")).toContain("2026");
  });

  it("does not say a negative age for a time in the future", () => {
    // **A clock that went backwards, or a stored timestamp from a device ahead of this one.**
    // "-3 min ago" is worse than useless in a list somebody is reading to decide what to open.
    expect(agoFrom("2026-01-15T12:05:00Z")).toBe("a moment ago");
  });

  it("singular and plural agree", () => {
    expect(agoFrom("2026-01-15T11:00:00Z")).toBe("1 hour ago");
    expect(agoFrom("2026-01-15T10:00:00Z")).toBe("2 hours ago");
  });
});
