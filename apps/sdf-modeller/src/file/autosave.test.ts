// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTOSAVE_MS, autosave } from "./autosave";

/** Something that stands in for the database, so the debounce can be tested without one. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("autosave", () => {
  it("writes once after the document has been still, rather than once per change", async () => {
    // **The whole point of the debounce.** A person editing a figure pauses for whole seconds
    // between edits while they look at it, and a write per keystroke is a write per frame of a
    // drag — with a transaction each time.
    const write = vi.fn(async () => {});
    const draft = autosave(write, 100);

    for (let i = 0; i < 10; i++) {
      draft.changed();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("writes again after another pause", async () => {
    const write = vi.fn(async () => {});
    const draft = autosave(write, 100);

    draft.changed();
    await vi.advanceTimersByTimeAsync(150);
    draft.changed();
    await vi.advanceTimersByTimeAsync(150);

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when nothing changed", async () => {
    const write = vi.fn(async () => {});
    // **Armed and never changed**, which is the state a document is in between edits — and the
    // state a naive "write on a timer" would fill with writes.
    autosave(write, 100);

    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
  });

  it("writes at once when flushed, and says it did", async () => {
    // **For the case the debounce cannot cover**: somebody is closing the tab, and a draft that
    // has not fired yet is a document that is about to be lost.
    const write = vi.fn(async () => {});
    const draft = autosave(write, AUTOSAVE_MS);

    draft.changed();
    await expect(draft.flush()).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("says it wrote nothing when there was nothing waiting", async () => {
    // **So a caller can tell "saved" from "there was nothing to save"** — which is the
    // difference between a truthful status line and one that claims work it did not do.
    const draft = autosave(async () => {});

    await expect(draft.flush()).resolves.toBe(false);
  });

  it("never has two writes in flight at once", async () => {
    // **The bug this prevents is subtle and bad.** A change arriving while a write is running
    // would otherwise start a second one, and the database keeps whichever lands last — which is
    // the *older* of the two as often as not, because the later one waits behind an open
    // transaction. So a restored document can be an earlier version than the one being typed.
    let running = 0;
    let overlapped = false;
    const draft = autosave(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await settle();
      running -= 1;
    }, 100);

    draft.changed();
    await vi.advanceTimersByTimeAsync(100);
    // Mid-write: this change has to re-arm rather than start another write.
    draft.changed();
    await vi.advanceTimersByTimeAsync(10);

    expect(overlapped).toBe(false);
  });

  it("writes a change that arrived mid-write rather than dropping it", async () => {
    const write = vi.fn(async () => {
      await settle();
    });
    const draft = autosave(write, 100);

    draft.changed();
    await vi.advanceTimersByTimeAsync(100);
    draft.changed();
    await vi.advanceTimersByTimeAsync(200);

    expect(write).toHaveBeenCalledTimes(2);
  });

  it("swallows a failed write, because a backup is not worth stopping for", async () => {
    // **A draft that could take the editor down with it is a liability.** The database is already
    // silent about missing storage and quota; this is the same decision one level up, and the
    // next successful write is what tells the person nothing happened.
    const write = vi.fn(async () => {
      throw new Error("QuotaExceededError");
    });
    const draft = autosave(write, 100);

    draft.changed();
    await expect(draft.flush()).resolves.toBe(false);

    // **And it still tries afterwards**, because a full disk is usually not still full.
    draft.changed();
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("writes nothing further once disposed", async () => {
    // **The teardown path**, and the reason `dispose` exists: a rebuild arriving after the
    // application has torn down must not reach a database the person has closed the tab on.
    const write = vi.fn(async () => {});
    const draft = autosave(write, 100);
    expect(draft).toBeDefined();

    draft.dispose();
    draft.changed();
    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
  });

  it("does not write a pending change when disposed", async () => {
    const write = vi.fn(async () => {});
    const draft = autosave(write, 100);

    draft.changed();
    draft.dispose();
    await vi.advanceTimersByTimeAsync(500);

    expect(write).not.toHaveBeenCalled();
  });

  it("defaults to a second", () => {
    // **Not asserted by behaviour**, because a test that waits a real second is a slow test. The
    // number is here so that it is a decision someone can read rather than a literal in a
    // default parameter nobody looks at.
    expect(AUTOSAVE_MS).toBe(1000);
  });
});
