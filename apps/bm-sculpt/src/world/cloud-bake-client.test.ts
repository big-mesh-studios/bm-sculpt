import { describe, expect, it, vi } from "vitest";

import { SHAPE_SIZE, WEATHER_SIZE, type CloudField } from "./cloud-field";
import type { FromBakeWorker, ToBakeWorker } from "./cloud-bake-protocol";
import {
  BAKE_TIMEOUT_MS,
  bakeCloudFieldOffThread,
  isBakeAnswer,
  type BakeWorker,
} from "./cloud-bake-client";

/**
 * The main thread's side of the bake, driven against a worker that answers when told.
 *
 * The fake holds its answer back until a test releases it, which is the only way to
 * express the failures that matter here: a field that arrives after the world has been
 * torn down, an answer for a seed nobody asked about, and a worker that never answers
 * at all. A fake that replied immediately could express none of them.
 *
 * The fallback is exercised for real, and it is a *production* bake: the client calls
 * `bakeCloudField(seed)` with no sizes, so each of the three fallback tests here costs
 * a second of arithmetic. They are kept anyway — a fallback that has never been run is
 * a fallback nobody knows works — and the assertions are on the sizes rather than on the
 * contents, because the contents are `cloud-field.test.ts`'s to prove.
 */

const SEED = 20260901;

/** A worker that posts nothing back until a test says so. */
const fakeBakeWorker = () => {
  const posted: ToBakeWorker[] = [];
  const terminated: number[] = [];
  const removed: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();

  const worker: BakeWorker = {
    post: (message) => void posted.push(message),
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => {
      removed.push(type);
      listeners.delete(type);
    },
    terminate: () => void terminated.push(Date.now()),
  };

  return {
    worker,
    posted,
    removed,
    terminated,
    /** Delivers a worker message, as the browser would. */
    deliver(message: unknown): void {
      const listener = listeners.get("message");
      if (listener === undefined) throw new Error("nothing is listening");
      listener({ data: message });
    },
    /** Delivers the error a worker fires when it cannot even load its module. */
    fail(reason: unknown): void {
      const listener = listeners.get("error");
      if (listener === undefined) throw new Error("nothing is listening");
      listener({ message: reason });
    },
    listening(): boolean {
      return listeners.has("message") || listeners.has("error");
    },
  };
};

/** A field shaped like the real one, small enough to build several of. */
const fieldOf = (seed: number, mark: number): CloudField => ({
  shape: { size: 1, depth: 1, data: new Uint8Array([seed & 0xff, mark, 2, 3]) },
  weather: { size: 1, depth: 1, data: new Uint8Array([0, mark, 5, 6]) },
});

const readyFor = (seed: number, mark = 9): FromBakeWorker => {
  const field = fieldOf(seed, mark);
  return { kind: "cloudFieldReady", seed, ...field };
};

describe("a bake on a worker", () => {
  it("asks for the field once, by seed, and takes no size it did not choose", () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    expect(fake.posted).toEqual([{ kind: "bakeCloudField", seed: SEED }]);
    bake.dispose();
  });

  it("hands over the field the worker produced, buffers and all", async () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    const field = fieldOf(SEED, 42);
    fake.deliver({ kind: "cloudFieldReady", seed: SEED, ...field });

    // The same object rather than a copy: the two `Uint8Array`s arrived by transfer,
    // and `createClouds` uploads them straight into two `DataTexture`s. Copying them
    // here would put back the megabyte the worker was created to move.
    const baked = await bake.field;
    expect(baked).toEqual(field);
    expect(baked.shape.data).toBe(field.shape.data);
    bake.dispose();
  });

  it("settles `fallback` with the same field, so a caller can read either", async () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    const field = fieldOf(SEED, 11);
    fake.deliver({ kind: "cloudFieldReady", seed: SEED, ...field });
    expect(await bake.fallback).toBe(await bake.field);
    bake.dispose();
  });

  it("ignores an answer for a seed nobody asked about", () => {
    // Not a hypothetical: a worker from an older world, or a message queued from before
    // a seed change. Applying it would build the sky out of another world's weather,
    // and nothing downstream could tell.
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    let settled = false;
    void bake.field.then(() => {
      settled = true;
    });
    fake.deliver(readyFor(SEED + 1));
    expect(settled).toBe(false);
    expect(fake.removed).toEqual([]);
    bake.dispose();
  });

  it("refuses an answer that arrived with no bytes in it", async () => {
    // The one answer worse than no answer, because it looks like one: a field whose
    // buffers were detached in transit is a zero-texel volume, and a sky built from that
    // is transparent — no clouds, no error, nothing to look at. Cheap to refuse.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.deliver({
      kind: "cloudFieldReady",
      seed: SEED,
      shape: { size: 60, depth: 60, data: new Uint8Array(0) },
      weather: { size: 240, depth: 240, data: new Uint8Array(0) },
    });

    expect((await bake.field).shape.size).toBe(SHAPE_SIZE);
    expect(String(warn.mock.calls[0]![0])).toContain("arrived empty");
    warn.mockRestore();
    bake.dispose();
  });

  it("ignores a message that is not one of ours", () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.deliver({ kind: "meshReady", cell: { x: 0, y: 0, z: 0 } });
    fake.deliver(undefined);
    fake.deliver("nonsense");
    bake.dispose();
    expect(fake.terminated).toHaveLength(1);
  });

  it("takes the first answer and bakes once, whatever else arrives", async () => {
    // A disposed worker that answers anyway is a race the browser is entitled to
    // produce. `Promise` takes a second resolution silently, so without the guard this
    // would bake twice and there would be nothing to notice it by.
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.deliver(readyFor(SEED, 1));
    fake.deliver(readyFor(SEED, 2));
    expect(await bake.field).toEqual(fieldOf(SEED, 1));
    bake.dispose();
  });

  it("knows an answer from a failure", () => {
    // The one judgement at this boundary that nothing downstream makes: a failure
    // taken for a field would draw a sky with no weather in it and throw nothing.
    expect(isBakeAnswer(readyFor(SEED))).toBe(true);
    expect(
      isBakeAnswer({ kind: "cloudFieldFailed", seed: SEED, reason: "no" }),
    ).toBe(false);
  });
});

describe("a bake that cannot be reached", () => {
  it("bakes on the main thread when no worker can be built", async () => {
    // A browser without module workers, a `file://` page, a policy that forbids them.
    // The point of the whole file is that the main thread does *not* stall, so this is
    // the one case where it does — and the alternative is no sky at all.
    const bake = bakeCloudFieldOffThread(SEED, () => {
      throw new Error("no workers here");
    });
    const field = await bake.field;
    expect(field.shape.size).toBe(SHAPE_SIZE);
    expect(field.shape.data).toHaveLength(SHAPE_SIZE ** 3 * 4);
    expect(field.weather.data).toHaveLength(WEATHER_SIZE ** 2 * 4);
    // Nothing to terminate, and disposing must not throw.
    bake.dispose();
    expect(await bake.fallback).toBe(field);
  });

  it("bakes here when the worker reports a failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.deliver({
      kind: "cloudFieldFailed",
      seed: SEED,
      reason: "out of memory",
    });

    const field = await bake.field;
    expect(field.shape.size).toBe(SHAPE_SIZE);
    // And it says why, because a sky that arrived two seconds late with nothing in the
    // log is the kind of fault that is never chased.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![1])).toContain("out of memory");
    warn.mockRestore();
    bake.dispose();
  });

  it("bakes here when the worker dies without answering", async () => {
    // The event that matters is the one with no `data` on it: a worker whose module
    // failed to load never posts anything at all, so without this the promise would
    // never settle and the sky would be a loading state for ever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.fail("Failed to fetch dynamically imported module");

    expect((await bake.field).shape.size).toBe(SHAPE_SIZE);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    bake.dispose();
  });

  it("falls back to this thread when the answer is a failure for another seed", () => {
    // A failure whose seed does not match is somebody else's failure. Ignoring it is
    // right — and it leaves this bake unanswered, which is what the next test is about.
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    fake.deliver({ kind: "cloudFieldFailed", seed: SEED + 1, reason: "no" });
    bake.dispose();
  });
});

describe("disposing of a bake", () => {
  it("terminates the worker and drops both listeners", () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    bake.dispose();
    expect(fake.terminated).toHaveLength(1);
    expect(fake.removed.sort()).toEqual(["error", "message"]);
    expect(fake.listening()).toBe(false);
  });

  it("is idempotent, because a teardown can reach it twice", () => {
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    bake.dispose();
    bake.dispose();
    expect(fake.terminated).toHaveLength(1);
  });

  it("leaves the field promise unsettled rather than baking on the way out", () => {
    // The deliberate trade. `field` cannot be settled honestly once the worker is gone
    // — the answer died with it — and baking here to fill the gap would spend two and a
    // half seconds on the main thread inside a teardown, which is the one moment nobody
    // is waiting for a field. A caller that disposed of a bake and still wants a field
    // reads `fallback`, which is what it is for.
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker);
    let settled = false;
    void bake.field.then(() => {
      settled = true;
    });
    bake.dispose();
    expect(settled).toBe(false);
    // `fallback` still answers, because it is not a promise about the worker's survival.
    void bake.fallback.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
  });

  it("cancels its wait, so a teardown cannot bake a field nobody wanted", async () => {
    const fake = fakeBakeWorker();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker, 5);
    bake.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // No warning, and no second `terminate` from a timer that outlived its bake.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a worker that says nothing at all", () => {
  // The fourth failure, and the only one with no event to wait for: a worker that
  // loads, takes its message and answers nothing. It has happened — the symptom was a
  // sky that never arrived, with a log that never said why, which is a fault measured
  // in hours. So the client gives up on its own and bakes here instead.
  it("bakes on this thread once the wait runs out", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker, 5);

    const field = await bake.field;
    expect(field.shape.size).toBe(SHAPE_SIZE);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("did not arrive");
    warn.mockRestore();
    bake.dispose();
  });

  it("gives up quietly when the worker is merely slow", async () => {
    // The other half of the same bargain: a timeout that fires on a worker about to
    // answer would bake twice and terminate nothing, so an answer that arrives first
    // cancels the wait and is taken as the answer.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = fakeBakeWorker();
    const bake = bakeCloudFieldOffThread(SEED, () => fake.worker, 40);
    setTimeout(() => fake.deliver(readyFor(SEED, 3)), 5);

    expect(await bake.field).toEqual(fieldOf(SEED, 3));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    bake.dispose();
  });

  it("waits eight seconds by default, which is past noticing", () => {
    expect(BAKE_TIMEOUT_MS).toBeGreaterThan(4000);
    expect(BAKE_TIMEOUT_MS).toBeLessThan(20000);
  });
});
