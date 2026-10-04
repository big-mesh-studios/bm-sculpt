/**
 * The bake client, against a worker that is not a worker.
 *
 * ## What is actually worth testing here
 *
 * The bake itself is tested in `@big-mesh-studios/csg`, where it is a pure function. What cannot be
 * tested there is the transport, and the transport has exactly one property that matters:
 *
 * **The worker's maps and the main-thread fallback's maps must be the same maps.** They are two
 * copies of one line of colour source, in two files, in two scopes — the fallback cannot import from
 * the worker and the worker cannot import from the renderer, which is the property that made the
 * move possible. So the duplication is structural and the only thing holding it together is this test.
 *
 * The rest is the three guards: a message that is not a reply, a message that arrives after the
 * fallback has already run, and a worker that throws on construction. All three are the browser
 * being the browser rather than this code being wrong, which is exactly why they need pinning.
 */

import { DEFAULT_PLANET, bakePlanetMaps } from "@big-mesh-studios/csg";
import { describe, expect, it } from "vitest";

import { bakePlanetMapsOffThread } from "./planet-bake-client";
import type { PlanetBakeFactory } from "./planet-bake-client";
import type { PlanetBakeReply } from "./planet-bake-protocol";

/**
 * A worker under the test's control.
 *
 * **Both the fake and the delivery handle, because the client only ever sees the first half.** A
 * worker cannot be asked questions, so a fake that cannot also be spoken to cannot test the race
 * where a message arrives after the timeout — which is the one race that matters here.
 */
interface FakeWorker extends PlanetBakeFactory {
  readonly deliver: (data: unknown) => void;
  readonly isTerminated: () => boolean;
  readonly posted: () => unknown;
}

const fakeWorker = (): FakeWorker => {
  const listeners: ((event: { data: unknown }) => void)[] = [];
  let terminated = false;
  let posted: unknown;
  return {
    post: (message) => {
      posted = message;
    },
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    terminate: () => {
      terminated = true;
    },
    deliver: (data) => listeners.forEach((listener) => listener({ data })),
    isTerminated: () => terminated,
    posted: () => posted,
  };
};

/** A worker that never answers, so the timeout path can be driven without waiting four seconds. */
const silentWorker = (): PlanetBakeFactory => fakeWorker();

describe("the planet bake client", () => {
  it("bakes the same maps either way, or the fallback is a different planet", () => {
    // **The test this file exists for.**
    //
    // Two colour sources, two files. The worker is a scope that cannot import the renderer; the
    // fallback runs on the main thread and could import anything. Nothing stops them drifting except
    // this comparison, and if they drift the failure is a planet that changes colour depending on
    // whether the browser let us have a worker — which is to say, a planet that changes colour when
    // the player's machine has a feature, and nobody would ever connect the two.
    const expected = bakePlanetMaps(
      DEFAULT_PLANET,
      { colourAt: () => ({ colour: { r: 190, g: 186, b: 176 }, opacity: 1 }) },
      64,
      32,
    );

    return bakePlanetMapsOffThread(
      DEFAULT_PLANET,
      64,
      32,
      silentWorker,
      5,
    ).maps.then((maps) => {
      expect(maps.albedo).toEqual(expected.albedo);
      expect(maps.height).toEqual(expected.height);
      expect(maps.relief).toBe(expected.relief);
      expect(maps.seaRadius).toBe(expected.seaRadius);
    });
  });

  it("reports which bake won, and it is the fallback when the worker is silent", () => {
    // The HUD shows this, but the real reason to have it is that the two paths are not equally
    // trustworthy: a fallback bake is a 564ms hitch the player saw, and a support report that says
    // "the planet took half a second to appear" needs to be answerable.
    const bake = bakePlanetMapsOffThread(
      DEFAULT_PLANET,
      32,
      16,
      silentWorker,
      5,
    );
    expect(bake.source()).toBe("not yet");
    return bake.maps.then(() => {
      expect(bake.source()).toBe("main thread");
    });
  });

  it("takes the worker's maps when the worker answers, and terminates it", () => {
    const reply: PlanetBakeReply = {
      maps: {
        albedo: new Uint8Array(4).fill(7),
        height: new Uint8Array(1).fill(9),
        width: 1,
        height_: 1,
        seaRadius: 4000,
        relief: 576,
      },
    };
    let factory: FakeWorker | undefined;
    const bake = bakePlanetMapsOffThread(
      DEFAULT_PLANET,
      16,
      8,
      () => (factory = fakeWorker()),
      1000,
    );
    expect(factory!.posted()).toEqual({
      params: DEFAULT_PLANET,
      width: 16,
      height: 8,
    });
    factory!.deliver(reply);
    return bake.maps.then((maps) => {
      expect(maps.albedo[0]).toBe(7);
      expect(bake.source()).toBe("worker");
      // **Terminated, not merely forgotten.** A worker left running holds its maps — two of them —
      // for the rest of the session, and nothing would ever release them.
      expect(factory!.isTerminated()).toBe(true);
    });
  });

  it("ignores a message that is not a reply", () => {
    // A worker is not a private channel; anything on the page can post to it. An unrecognised
    // message must be dropped silently rather than treated as maps, so the client falls back on its
    // timeout instead of resolving with `undefined`.
    let factory: FakeWorker | undefined;
    const bake = bakePlanetMapsOffThread(
      DEFAULT_PLANET,
      16,
      8,
      () => (factory = fakeWorker()),
      10,
    );
    factory!.deliver("hello");
    factory!.deliver({ maps: { albedo: "not a buffer" } });
    expect(bake.source()).toBe("not yet");
  });

  it("does not let a late worker overwrite a fallback that already answered", () => {
    // **The race the `done` flag exists for.** The timeout fires, the fallback bakes, and then the
    // worker — slow, not dead — arrives. `Promise` resolution is idempotent, so the second answer
    // would be dropped silently and its bake's cost would never be visible. Asserting that the
    // first answer survives is the only way that shows up.
    const reply: PlanetBakeReply = {
      maps: {
        albedo: new Uint8Array(1).fill(1),
        height: new Uint8Array(1).fill(2),
        width: 1,
        height_: 1,
        seaRadius: 4000,
        relief: 576,
      },
    };
    let factory: FakeWorker | undefined;
    const bake = bakePlanetMapsOffThread(
      DEFAULT_PLANET,
      16,
      8,
      () => (factory = fakeWorker()),
      5,
    );

    return bake.maps.then((maps) => {
      const fromFallback = maps.albedo[0];
      factory!.deliver(reply);
      return bake.maps.then((later) => {
        expect(later).toBe(maps);
        expect(later.albedo[0]).toBe(fromFallback);
      });
    });
  });

  it("falls back when the worker cannot even be constructed", () => {
    // Some webviews refuse `new Worker`. The bake runs here instead, because 564ms of hitch is a
    // much smaller problem than a planet that never arrives.
    const bake = bakePlanetMapsOffThread(DEFAULT_PLANET, 16, 8, () => {
      throw new Error("blocked");
    });
    return bake.maps.then((maps) => {
      expect(maps.width).toBe(16);
      expect(bake.source()).toBe("main thread");
    });
  });
});
