/**
 * Opening a place zip.
 *
 * ## What is being tested here
 *
 * Two things, and they are not the same kind of thing.
 *
 * **The refusals**, one test per reason, each asserted against *what it said* rather than merely
 * that it threw. A loader that refuses everything passes a test suite of `rejects.toThrow()`,
 * and a person who zipped the wrong folder is entitled to be told which folder they zipped.
 *
 * **One place, end to end** — zipped from real TypeScript, opened, and run through the real
 * bundler and the real interpreter, because that is the claim the whole format exists for. A
 * zip of strings that never reaches a host proves the file plumbing and nothing about whether a
 * place can travel.
 */

import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { readPlaceZip } from "./load-place";
import { MAX_PLACE_SOURCE } from "./limits";
import { PlaceHost } from "./host";
import { PlaceRegistry } from "./place-registry";
import { FoldOrder } from "../edit/fold-order";
import type { HostEffects, HostWorld, RayHit } from "./host";
import type { ClockCommands } from "../console/commands";
import type { Vec3 } from "@big-mesh-studios/core";

/** A manifest that passes, for a test to spoil. */
const manifest = (over: Record<string, unknown> = {}) => ({
  name: "bridge",
  seed: 20260901,
  entry: "main.ts",
  scripts: ["main.ts"],
  ...over,
});

/**
 * Wraps bytes in a `Blob`.
 *
 * **Copied out of the typed array's own buffer rather than passing it.** `generateAsync` returns a
 * `Uint8Array` over an `ArrayBufferLike`, which is not a `BlobPart` under this project's
 * `lib` settings — and a view over a larger buffer than it covers would hand the loader trailing
 * bytes that are not in the archive. Slicing to an `ArrayBuffer` fixes both, and it is the same
 * reason `readPlaceZip` reads a `Blob` through `arrayBuffer()` rather than trusting its view.
 */
const blobOf = async (zip: JSZip): Promise<Blob> => {
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Blob([
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  ]);
};

/**
 * Builds a zip from a manifest object and a map of files.
 *
 * **`manifest.json` is added automatically** so that a test about the other files does not have to
 * carry a valid manifest, and a test about the manifest passes `null` to leave it out. A `null`
 * file value is a directory entry, which is what two of the tests below need.
 */
const zipOf = async (
  files: Record<string, string | null>,
  over: Record<string, unknown> | null = manifest(),
): Promise<Blob> => {
  const zip = new JSZip();
  if (over !== null) zip.file("manifest.json", JSON.stringify(over));
  for (const [name, body] of Object.entries(files)) {
    // **Two calls rather than one, because JSZip has no `file(name, string | null)`
    // overload.** Its four overloads take `null` for a directory entry and a data union for
    // a file, and a `string | null` argument matches neither — so a loop that passed the
    // union straight through was a type error that `pnpm check-types` had been reporting
    // since Phase F, behind a gate nobody was reading the whole output of.
    if (body === null) zip.file(name, null);
    else zip.file(name, body);
  }
  return blobOf(zip);
};

/** A world that answers four queries and records what it was asked. */
const stubWorld = (): HostWorld => {
  const places = new PlaceRegistry(new FoldOrder());
  return {
    places,
    terrainHeight: () => 0,
    geometryChanged: () => {},
    solidAt: () => false,
    waterAt: () => false,
    raycast: (): RayHit | undefined => undefined,
  };
};

const stubEffects = (): HostEffects => ({
  log: () => {},
  toast: () => {},
  movePlayer: (_at: Vec3, _yaw?: number) => {},
  setPlayerSpeed: () => {},
  setPlayerJump: () => {},
  setFlying: () => {},
  lookAt: (_at: Vec3, _fov?: number) => {},
  clearCamera: () => {},
});

const stubClock = (): ClockCommands => ({
  jumpTo: () => {},
  setSpeed: () => {},
  clearOverride: () => {},
  describe: () => "stub clock",
});

describe("a place that opens", () => {
  it("hands back the manifest it was described by", async () => {
    const place = await readPlaceZip(await zipOf({ "main.ts": "// hi" }));
    expect(place.manifest.name).toBe("bridge");
    expect(place.manifest.seed).toBe(20260901);
  });

  it("hands back the files, keyed by the names the manifest used", async () => {
    const place = await readPlaceZip(
      await zipOf(
        { "main.ts": "// main", "span.ts": "// span" },
        manifest({ scripts: ["main.ts", "span.ts"] }),
      ),
    );
    // **By the manifest's name, not the zip's.** The bundler's whole reproducibility argument is
    // that a file's id comes from its sorted name, so the mapping from name to text is the only
    // thing that has to be right before any of that starts.
    expect(place.files["main.ts"]).toBe("// main");
    expect(place.files["span.ts"]).toBe("// span");
    expect(Object.keys(place.files).sort()).toEqual(["main.ts", "span.ts"]);
  });

  it("hands back the entry the manifest named", async () => {
    const place = await readPlaceZip(
      await zipOf(
        { "a.ts": "// a", "b.ts": "// b" },
        manifest({ entry: "b.ts", scripts: ["a.ts", "b.ts"] }),
      ),
    );
    // **Not `main.ts` by convention.** The reference's manifest names its scripts and lets the
    // runtime choose; `PlaceHost` is handed an entry, so the artefact has to state it or the
    // choice is made somewhere that is not written down anywhere.
    expect(place.entry).toBe("b.ts");
  });

  it("reads a place whose scripts are nested in folders", async () => {
    const place = await readPlaceZip(
      await zipOf(
        { "lib/door.ts": "// door", "main.ts": "// main" },
        manifest({ scripts: ["main.ts", "lib/door.ts"] }),
      ),
    );
    expect(place.files["lib/door.ts"]).toBe("// door");
  });

  it("preserves source exactly, including the characters a naive reader would mangle", async () => {
    // **Tabs, a Windows line ending, a non-ASCII string and a template literal**, because a
    // loader that normalises line endings or trims will bundle a program that is not the one that
    // was written, and the difference is invisible until a string literal compares unequal.
    const source = "export const s = `a\tb\r\nc \u00e9 \u4e2d ${1 + 1}`;";
    const place = await readPlaceZip(await zipOf({ "main.ts": source }));
    expect(place.files["main.ts"]).toBe(source);
  });

  it("ignores a directory entry", async () => {
    // **Not refused.** A zip written by a tool that records folders carries `lib/` as well as
    // `lib/door.ts`, and refusing the place because of it would refuse every place made with the
    // most common zip library there is.
    const place = await readPlaceZip(
      await zipOf(
        { "lib/": null, "lib/door.ts": "// door", "main.ts": "// m" },
        manifest({ scripts: ["main.ts", "lib/door.ts"] }),
      ),
    );
    expect(place.files["lib/door.ts"]).toBe("// door");
  });

  it("ignores a file that is neither the manifest nor a script", async () => {
    // **A `LICENSE` is not a reason to refuse a place.** Somebody handing over a folder of
    // scripts has a licence in it, and this loader has no opinion about licences.
    const place = await readPlaceZip(
      await zipOf({ "main.ts": "// m", LICENSE: "MIT", "README.md": "# hi" }),
    );
    expect(Object.keys(place.files)).toEqual(["main.ts"]);
  });
});

describe("a place that does not open", () => {
  it("says the bytes are not a zip", async () => {
    await expect(readPlaceZip(new Blob(["not a zip at all"]))).rejects.toThrow(
      /not a zip a place was saved as/,
    );
  });

  it("says there is no manifest at the root", async () => {
    // **The reason names the file**, because "malformed place" tells a person nothing about
    // which of the two ways they got it wrong they have.
    await expect(
      readPlaceZip(await zipOf({ "main.ts": "// m" }, null)),
    ).rejects.toThrow(/no manifest\.json at the zip's root/);
  });

  it("says the manifest is not JSON", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{ this is not json");
    zip.file("main.ts", "// m");
    await expect(readPlaceZip(await blobOf(zip))).rejects.toThrow(
      /manifest\.json is not valid JSON/,
    );
  });

  it("says the manifest is not one this can open", async () => {
    await expect(
      readPlaceZip(
        await zipOf({ "main.ts": "// m" }, manifest({ seed: "nope" })),
      ),
    ).rejects.toThrow(/not a place manifest this can open/);
  });

  it("says which file the manifest names and the zip does not hold", async () => {
    await expect(
      readPlaceZip(
        await zipOf(
          { "main.ts": "// m" },
          manifest({ scripts: ["main.ts", "span.ts"] }),
        ),
      ),
    ).rejects.toThrow(/names "span\.ts", which the zip does not hold/);
  });

  it("refuses a path that walks out of the root", async () => {
    // **Even though the manifest was validated first**, and the manifest's `scripts` list would
    // already have refused it. This test exists to pin the second gate: `isPlaceManifest` and the
    // read loop are two checks, and one of them being refactored away should not leave the other
    // as the only thing standing between a zip and `../`.
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify(
        manifest({ scripts: ["../../etc/passwd"], entry: "../../etc/passwd" }),
      ),
    );
    await expect(readPlaceZip(await blobOf(zip))).rejects.toThrow(
      /not a place manifest this can open/,
    );
  });

  it("refuses a script the zip carries and the manifest does not name", async () => {
    // **The one place this loader knowingly differs from the reference, which drops the file.**
    // It refuses instead, because a zip holding a script the manifest does not name means the two
    // were written by different tools or different versions of one — and "what is actually in
    // this zip" is the question a person opening a stranger's place is trying to avoid.
    await expect(
      readPlaceZip(
        await zipOf({ "main.ts": "// m", "stale.ts": "// left over" }),
      ),
    ).rejects.toThrow(/holds "stale\.ts", which manifest\.json does not name/);
  });

  it("refuses a place over the total source limit", async () => {
    // **Over the total, not over a single file** — a manifest of two files each just under the
    // per-file cap passes `bundle.ts`'s own check and is still too much to compile in a tab.
    const half = "x".repeat(Math.floor(MAX_PLACE_SOURCE / 2) + 10);
    await expect(
      readPlaceZip(
        await zipOf(
          { "a.ts": half, "b.ts": half },
          manifest({ scripts: ["a.ts", "b.ts"], entry: "a.ts" }),
        ),
      ),
    ).rejects.toThrow(/over the \d+ character limit/);
  });

  it("reads a place that is exactly at the total source limit", async () => {
    // **The boundary, because a cap tested only one past it is a cap that may be off by one.**
    const a = "x".repeat(Math.floor(MAX_PLACE_SOURCE / 2));
    const b = "y".repeat(MAX_PLACE_SOURCE - a.length);
    const place = await readPlaceZip(
      await zipOf(
        { "a.ts": a, "b.ts": b },
        manifest({ scripts: ["a.ts", "b.ts"], entry: "a.ts" }),
      ),
    );
    expect(place.files["a.ts"].length + place.files["b.ts"].length).toBe(
      MAX_PLACE_SOURCE,
    );
  });

  it("carries the cause, so the underlying zip error is not lost", async () => {
    // **Kept rather than flattened.** "Not a zip" is the answer a person needs; `cause` is what
    // the console prints when nobody is asking, and it distinguishes a truncated download from a
    // file that was never a zip at all.
    await readPlaceZip(new Blob(["junk"])).catch((reason: unknown) => {
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).cause).toBeDefined();
    });
  });
});

describe("a place that arrives as a file and runs", () => {
  /**
   * The claim the format exists for: **zipped, opened, bundled, interpreted, geometry in the
   * registry.** Every layer below the host is the real one — the real bundler compiling real
   * TypeScript, the real interpreter, the real table-driven effects — because a zip of strings
   * that never reaches a host would prove the file plumbing and nothing a person cares about.
   */
  it("zips, opens, bundles and builds its geometry", async () => {
    const source = `
      import { createShape, onTick, log } from "voxelscape";
      createShape({
        place: "bridge",
        id: "deck",
        at: [0, 20, 0],
        shape: { type: "Box", len: { x: 30, y: 3, z: 30 } },
        combine: "Add",
      });
      onTick(() => {});
      log("up");
    `;

    const place = await readPlaceZip(await zipOf({ "main.ts": source }));

    const notices: string[] = [];
    const world = stubWorld();
    const host = new PlaceHost({
      files: place.files,
      entry: place.entry,
      seed: place.manifest.seed,
      now: () => 1_700_000_000_000,
      world,
      effects: stubEffects(),
      clock: stubClock(),
      onNotice: (message) => notices.push(message),
    });
    await host.load();

    // **Cleanly, and with geometry.** A place that opens and then fails to build is the case
    // this catches, and it is the whole reason the end-to-end assertion is here rather than only
    // in `demos.test.ts`: that file tests places in the tree, and this one tests places from a
    // file, which arrive by a different route and fail differently.
    expect(notices).toEqual([]);
    expect(world.places.operationCount).toBe(1);
    host.dispose();
  });

  it("refuses a place whose script does not compile, naming the file", async () => {
    // **A bundle error throws out of `load`, rather than becoming a notice.** The two are
    // different failures: a script that throws at run time is a broken place the host steps past,
    // while a script that does not parse is a broken *artefact* and there is nothing to step. The
    // file name is the part a person can act on, so it is the part asserted on — the alternative
    // would be an interpreter stack frame in a scope nobody wrote.
    const place = await readPlaceZip(
      await zipOf({ "main.ts": "export const = ;" }),
    );
    const host = new PlaceHost({
      files: place.files,
      entry: place.entry,
      seed: 1,
      now: () => 0,
      world: stubWorld(),
      effects: stubEffects(),
      clock: stubClock(),
    });
    await expect(host.load()).rejects.toThrow(/main\.ts: does not parse/);
    host.dispose();
  });

  it("seeds the world from the manifest, so two peers agree on the ground", async () => {
    // **The field the manifest adds that the in-tree path had nowhere to put.** A place that
    // omitted it would be a place whose world depends on whoever loaded it, which is the one
    // thing ADR 0016 exists to prevent.
    const place = await readPlaceZip(
      await zipOf({ "main.ts": "// m" }, manifest({ seed: 12345 })),
    );
    expect(place.manifest.seed).toBe(12345);
  });
});
