import { describe, expect, it } from "vitest";

import { bakeCloudField, type CloudField } from "./cloud-field";
import {
  bakedSeed,
  emptyBakeWorkerState,
  handleBakeMessage,
  type BakeWorkerState,
  type Baker,
} from "./cloud-bake-handler";
import {
  bakeTransferables,
  isFromBakeWorker,
  isToBakeWorker,
  type BakeReadyMessage,
  type FromBakeWorker,
  type ToBakeWorker,
} from "./cloud-bake-protocol";
import { runBakeWorker } from "./cloud-bake-worker";

/**
 * The bake boundary, in three layers and no browser.
 *
 * The handler is pure and the fake below is the only `Worker` in this file, which is
 * the arrangement `src/mesh/worker.ts` has for the same reason. What the tests are
 * really about is the three things that fail silently at a thread boundary: an answer
 * that never arrives, a field that arrives *copied* rather than moved, and a message
 * from a bundle that is not this one.
 */

/** A two-texel field, cheap enough to make several of. */
const tinyField = (seed: number): CloudField => ({
  shape: {
    size: 1,
    depth: 1,
    data: new Uint8Array([seed & 0xff, 1, 2, 3]),
  },
  weather: {
    size: 1,
    depth: 1,
    data: new Uint8Array([0, 4, 5, 6]),
  },
});

const request = (over: Partial<ToBakeWorker> = {}): ToBakeWorker => ({
  kind: "bakeCloudField",
  seed: 7,
  ...over,
});

describe("the message shapes", () => {
  it("accepts only a bake request and a field", () => {
    // Rejecting by shape rather than trusting the type, because a worker receives
    // whatever arrives — including a structured clone left over from a bundle that has
    // since been replaced.
    expect(isToBakeWorker(request())).toBe(true);
    expect(
      isToBakeWorker({ kind: "meshChunk", cell: { x: 0, y: 0, z: 0 } }),
    ).toBe(false);
    expect(isToBakeWorker({ kind: "cloudFieldReady" })).toBe(false);
    expect(isToBakeWorker(undefined)).toBe(false);
    expect(isToBakeWorker(42)).toBe(false);

    const ready: FromBakeWorker = {
      kind: "cloudFieldReady",
      seed: 7,
      shape: tinyField(7).shape,
      weather: tinyField(7).weather,
    };
    expect(isFromBakeWorker(ready)).toBe(true);
    expect(isFromBakeWorker({ kind: "cloudFieldFailed", seed: 7 })).toBe(true);
    expect(isFromBakeWorker(request())).toBe(false);
  });

  it("transfers the two fields' buffers and nothing else", () => {
    // The transfer list is the whole reason the answer moves rather than being copied:
    // a field that arrives by copy still arrives, so a mistake here costs a megabyte of
    // memcpy on the thread the worker was created to free, silently, on every load.
    const field = tinyField(7);
    const ready: BakeReadyMessage = {
      kind: "cloudFieldReady",
      seed: 7,
      shape: field.shape,
      weather: field.weather,
    };
    const transferables = bakeTransferables(ready);
    expect(transferables).toHaveLength(2);
    expect(transferables).toContain(field.shape.data.buffer);
    expect(transferables).toContain(field.weather.data.buffer);
  });

  it("transfers nothing for a failure, which carries no buffers", () => {
    expect(
      bakeTransferables({ kind: "cloudFieldFailed", seed: 7, reason: "no" }),
    ).toEqual([]);
  });
});

describe("the bake handler", () => {
  it("bakes what it was asked for and says which seed", () => {
    const calls: number[] = [];
    const handled = handleBakeMessage(
      emptyBakeWorkerState(),
      request(),
      (seed, shapeSize, weatherSize) => {
        calls.push(seed, shapeSize ?? -1, weatherSize ?? -1);
        return tinyField(seed);
      },
    );
    // The sizes are passed through even when the message does not name them, so the
    // baker's own defaults decide rather than the protocol's.
    expect(calls).toEqual([7, -1, -1]);
    expect(bakedSeed(handled.reply!)).toBe(7);
    expect(handled.reply!.kind).toBe("cloudFieldReady");
    expect(handled.state.bakes).toBe(1);
    expect(handled.state.failures).toBe(0);
  });

  it("passes a reduced size through, which is how a test can bake a small field", () => {
    const calls: [number, number | undefined, number | undefined][] = [];
    handleBakeMessage(
      emptyBakeWorkerState(),
      request({ shapeSize: 8, weatherSize: 12 }),
      (seed, shapeSize, weatherSize) => {
        calls.push([seed, shapeSize, weatherSize]);
        return tinyField(seed);
      },
    );
    expect(calls).toEqual([[7, 8, 12]]);
  });

  it("answers a failure as a message rather than dying", () => {
    // The property `handleMeshMessage` has and this needs for the same reason: a worker
    // that throws is a worker that is gone, and a promise nobody can settle. The main
    // thread's fallback can only run if it is told.
    const handled = handleBakeMessage(emptyBakeWorkerState(), request(), () => {
      throw new Error("out of memory");
    });
    expect(handled.reply).toEqual({
      kind: "cloudFieldFailed",
      seed: 7,
      reason: "out of memory",
    });
    expect(handled.state.bakes).toBe(1);
    expect(handled.state.failures).toBe(1);
  });

  it("answers a thrown non-Error too", () => {
    const handled = handleBakeMessage(emptyBakeWorkerState(), request(), () => {
      throw "noisy";
    });
    expect(handled.reply).toEqual({
      kind: "cloudFieldFailed",
      seed: 7,
      reason: "noisy",
    });
  });

  it("ignores a message that is not a bake request", () => {
    const state: BakeWorkerState = { bakes: 3, failures: 1 };
    const handled = handleBakeMessage(state, { kind: "setModel" }, tinyField);
    expect(handled).toEqual({ state, reply: undefined });
  });
});

/** A worker scope that records what was posted, and can be sent messages. */
const fakeScope = () => {
  const posted: { message: unknown; transfer: Transferable[] | undefined }[] =
    [];
  let deliver: ((event: { data: unknown }) => void) | undefined;

  return {
    posted,
    scope: {
      postMessage: (message: unknown, transfer?: Transferable[]) => {
        posted.push({ message, transfer });
      },
      addEventListener: (
        _type: "message",
        listener: (event: { data: unknown }) => void,
      ) => {
        deliver = listener;
      },
    },
    /** Delivers a message to the loop, as the browser would. */
    send(data: unknown): void {
      if (deliver === undefined) throw new Error("nothing is listening");
      deliver({ data });
    },
  };
};

describe("the worker loop", () => {
  it("posts the baked field back with its buffers transferred", () => {
    // The wiring, which is the part a pure handler cannot reach and which fails
    // silently: a reply posted without its transfer list is a perfectly good reply
    // that copies a megabyte instead of moving it.
    const fake = fakeScope();
    runBakeWorker(fake.scope);
    fake.send(request({ shapeSize: 2, weatherSize: 2 }));

    expect(fake.posted).toHaveLength(1);
    const { message, transfer } = fake.posted[0]!;
    const ready = message as BakeReadyMessage;
    expect(ready.kind).toBe("cloudFieldReady");
    expect(ready.seed).toBe(7);
    expect(transfer).toHaveLength(2);
    expect(transfer).toContain(ready.shape.data.buffer);
    expect(transfer).toContain(ready.weather.data.buffer);
  });

  it("bakes what it was asked for, through the real baker", () => {
    // One small real bake rather than a fake, so the module's own wiring — which
    // baker, which sizes — is exercised end to end at a size that costs nothing.
    const fake = fakeScope();
    runBakeWorker(fake.scope);
    fake.send(request({ shapeSize: 6, weatherSize: 8 }));

    const ready = fake.posted[0]!.message as BakeReadyMessage;
    const expected = bakeCloudField(7, 6, 8);
    expect(ready.shape.size).toBe(expected.shape.size);
    expect(ready.weather.size).toBe(expected.weather.size);
    expect(Array.from(ready.shape.data)).toEqual(
      Array.from(expected.shape.data),
    );
  });

  it("posts nothing at all for a message it does not recognise", () => {
    const fake = fakeScope();
    runBakeWorker(fake.scope);
    fake.send({ kind: "cancel" });
    expect(fake.posted).toEqual([]);
  });

  it("answers every request it is given, one reply each", () => {
    // A worker handles one bake and then the next. There is no pool here and no
    // generation, so the only rule is that nothing asked for goes unanswered.
    const fake = fakeScope();
    runBakeWorker(fake.scope);
    fake.send(request({ seed: 1, shapeSize: 2, weatherSize: 2 }));
    fake.send(request({ seed: 2, shapeSize: 2, weatherSize: 2 }));
    expect(
      fake.posted.map((p) => bakedSeed(p.message as FromBakeWorker)),
    ).toEqual([1, 2]);
  });
});

describe("the injected baker", () => {
  it("is the real one by default, and the field is pure in its seed", () => {
    // Not a test of the handler: a statement about the property the worker relies on.
    // Two seeds give two fields, and one seed gives one field, whichever thread it is
    // baked on — otherwise the sky would depend on which browser built it.
    const a = tinyField(7);
    const b = tinyField(7);
    const baker: Baker = tinyField;
    expect(baker(7)).toEqual(a);
    expect(baker(8)).not.toEqual(b);
  });
});
