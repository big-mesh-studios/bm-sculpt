/**
 * Command-name completion. No DOM, no commands — just the ranking, which is the
 * one piece of the console with a wrong answer that is invisible: the wrong name
 * is completed, it is simply not the name the player meant.
 */

import { describe, expect, it } from "vitest";

import { candidatesFor, fuzzyScore, toScopeBoundary } from "./completion";

/** The table this console actually ships, as names. */
const NAMES = [
  "/help",
  "/player:fly",
  "/player:no-clip",
  "/fullscreen",
  "/clear",
];

describe("fuzzyScore", () => {
  it("scores nothing above nothing, and a match above a near miss", () => {
    expect(fuzzyScore("", "/clear")).toBe(0);
    expect(fuzzyScore("/cle", "/clear")).toBeGreaterThan(0);
  });

  it("rejects a name missing any character of what was typed", () => {
    // Completing `/clor` to `/clock:speed` would be completing a typo to
    // something the player did not mean.
    expect(fuzzyScore("/clor", "/clear")).toBeUndefined();
    expect(fuzzyScore("/cleer", "/clear")).toBeUndefined();
  });

  it("requires the characters in order", () => {
    expect(fuzzyScore("/elc", "/clear")).toBeUndefined();
  });

  it("scores a run of adjacent characters above the same characters scattered", () => {
    expect(fuzzyScore("/cl", "/clear")).toBeGreaterThan(
      fuzzyScore("/cl", "/circle") ?? Number.NEGATIVE_INFINITY,
    );
  });

  it("scores an early match above a later one", () => {
    expect(fuzzyScore("/cl", "/clone")).toBeGreaterThan(
      fuzzyScore("/cl", "/recycle") ?? Number.NEGATIVE_INFINITY,
    );
  });
});

describe("candidatesFor", () => {
  it("offers every name once a bare slash is typed, shortest first", () => {
    // A bare slash matches every name at the same score, so the ranking falls
    // all the way through to length — the shortest names are the least typing
    // to get right. `/player:fly` and `/fullscreen` are the same length and
    // score alike, so they keep the order the table declares them in.
    expect(candidatesFor("/", NAMES)).toEqual([
      "/help",
      "/clear",
      "/player:fly",
      "/fullscreen",
      "/player:no-clip",
    ]);
  });

  it("offers the names that match and none that do not", () => {
    expect(candidatesFor("/fly", NAMES)).toEqual(["/player:fly"]);
  });

  it("finds a name whose scope the player has not typed yet", () => {
    // The whole reason the scope colon is not required: `/nc` reaches
    // `/player:no-clip`, which no prefix match would.
    expect(candidatesFor("/nc", NAMES)).toEqual(["/player:no-clip"]);
  });

  it("offers nothing for a line that has reached its arguments", () => {
    expect(candidatesFor("/player:fly on", NAMES)).toEqual([]);
  });

  it("offers nothing for text that is not a command at all", () => {
    expect(candidatesFor("cl", NAMES)).toEqual([]);
    expect(candidatesFor("", NAMES)).toEqual([]);
  });

  it("withholds a name that is already spelled out in full", () => {
    // `/help` typed out is finished. Offering it would mean Enter on a line
    // that already names a command could run a different one.
    expect(candidatesFor("/help", NAMES)).toEqual([]);
  });

  it("keeps a longer sibling that extends a name already typed", () => {
    // `/player:no-clip` ends in a name, but `/player:no-clipping` is still
    // possible. With two candidates the list is worth showing, so the typed
    // name stays in it as the first entry and the longer one is offered
    // beside it rather than instead of it.
    expect(
      candidatesFor("/player:no-clip", [
        "/player:no-clip",
        "/player:no-clipping",
      ]),
    ).toEqual(["/player:no-clip", "/player:no-clipping"]);
  });

  it("does not offer the typed name itself even as the only match", () => {
    expect(candidatesFor("/clear", NAMES)).toEqual([]);
  });
});

describe("toScopeBoundary", () => {
  it("completes as far as the scope and no further", () => {
    expect(toScopeBoundary("/player:no-clip", "/nc")).toBe("/player:");
    expect(toScopeBoundary("/clock:speed", "/cl")).toBe("/clock:");
  });

  it("completes the whole name where there is no scope left to stop at", () => {
    expect(toScopeBoundary("/clear", "/cl")).toBe("/clear");
    expect(toScopeBoundary("/clear", "/clear")).toBe("/clear");
  });

  it("completes a name whose colon is the last character in full", () => {
    expect(toScopeBoundary("/player:", "/pl")).toBe("/player:");
  });
});
