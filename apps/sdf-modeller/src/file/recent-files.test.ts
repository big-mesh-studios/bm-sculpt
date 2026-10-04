// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forget, put, read, release } from "./database";
import {
  forgetFile,
  listRecentFiles,
  rememberFile,
  REMEMBERED,
} from "./recent-files";
import type { FileSystemHandleLike } from "./save-file";

/**
 * A minimal IndexedDB, because jsdom has none.
 *
 * **Written here rather than pulled in as `fake-indexeddb`,** and the reason is that a fake is a
 * statement about which parts of IndexedDB this module uses. This one supports exactly `open`,
 * `createObjectStore`, `transaction`, `put`, `get` and `delete` — so if `database.ts` ever reaches
 * for an index, a cursor or a transaction mode, this stops compiling or this test starts failing.
 *
 * **It also stores by reference rather than by cloning**, which means the "survives a structured
 * clone" claim is not proved by it. What it does prove is the rest: the keys, the replacing, the
 * blob path and the recent list's own logic.
 */
const installFakeDatabase = (): void => {
  const rows = new Map<string, unknown>();
  let name: string | undefined;

  // **The event carries the request as its target**, which is how every handler in
  // `database.ts` reads the result — and a synthetic `Event` has a null target, which throws
  // inside the handler and leaves the promise it was meant to settle unsettled.
  const fires = (made: {
    onsuccess: ((event: unknown) => void) | null;
  }): void => {
    queueMicrotask(() => made.onsuccess?.({ target: made }));
  };

  const request = <T>(answer: T): IDBRequest<T> => {
    const made = {
      result: answer,
      error: null,
      onsuccess: null as ((event: unknown) => void) | null,
      onerror: null,
    };
    // **Resolved on the microtask queue**, as a real request is — so a caller that reads the
    // result synchronously after the call sees the same thing it would in a browser.
    fires(made);
    return made as unknown as IDBRequest<T>;
  };

  const store = {
    put: (value: unknown, key: string) => {
      rows.set(`${name}:${key}`, value);
      return request(undefined as never);
    },
    get: (key: string) => request(rows.get(`${name}:${key}`)),
    delete: (key: string) => {
      rows.delete(`${name}:${key}`);
      return request(undefined as never);
    },
  };

  const open = (): IDBOpenDBRequest => {
    const made = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => store,
        transaction: () => ({ objectStore: () => store }),
      } as unknown as IDBDatabase,
      error: null,
      onupgradeneeded: null as ((event: unknown) => void) | null,
      onsuccess: null as ((event: unknown) => void) | null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      (made.onupgradeneeded as unknown as ((event: unknown) => void) | null)?.({
        target: made,
      });
      made.onsuccess?.({ target: made });
    });
    return made as unknown as IDBOpenDBRequest;
  };

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open },
  });
};

/** Takes the fake away again, so a test can check what happens without one. */
const removeFakeDatabase = (): void => {
  Reflect.deleteProperty(globalThis, "indexedDB");
};

/**
 * A handle that survives being structured-cloned, which is the property the whole recent list
 * rests on.
 *
 * **A real object rather than a stub**, because the two methods that matter are `isSameEntry`
 * (which compares identity of the *file*, not of the object) and `getFile`. A stub that compared
 * by reference would make the dedupe untestable — every handle would look like a different file.
 */
const handleTo = (
  name: string,
  same: string[] = [name],
): FileSystemHandleLike => ({
  name,
  getFile: async () => new File([name], name),
  createWritable: async () => ({
    write: async () => {},
    close: async () => {},
  }),
  isSameEntry: async (other) => same.includes(other.name),
  queryPermission: async () => "granted" as PermissionState,
  requestPermission: async () => "granted" as PermissionState,
});

/** The three recent files call each other by name, so two handles to one file can be told apart. */
const sameFile = (name: string): FileSystemHandleLike =>
  handleTo(name, ["shared.sdfmod"]);

/**
 * The File System Access API, present.
 *
 * **Because the recent list is empty without it and that is the correct behaviour** — there is
 * nothing to remember where a browser cannot hold a handle, so the tests that want a list have to
 * say there is a browser that could. `remembersFiles` gating the list is tested separately, by
 * taking this away.
 */
const withFileApi = (present: boolean): void => {
  if (!present) {
    Reflect.deleteProperty(window, "showOpenFilePicker");
    return;
  }
  (window as unknown as Record<string, unknown>).showOpenFilePicker =
    async () => [];
};

beforeEach(async () => {
  installFakeDatabase();
  withFileApi(true);
  release();
});

afterEach(() => {
  removeFakeDatabase();
  withFileApi(false);
  release();
});

describe("the database", () => {
  it("keeps a value and reads it back", async () => {
    await put("greeting", { hello: "world" });
    expect(await read("greeting")).toEqual({ hello: "world" });
  });

  it("says nothing for a key that was never written", async () => {
    expect(await read("nothing")).toBeNull();
  });

  it("replaces rather than appends", async () => {
    await put("n", 1);
    await put("n", 2);
    expect(await read<number>("n")).toBe(2);
  });

  it("throws a key away", async () => {
    await put("gone", true);
    await forget("gone");
    expect(await read("gone")).toBeNull();
  });

  it("keeps a value that is not JSON at all", async () => {
    // **The whole reason this is IndexedDB and not `localStorage`.** A file handle is a live
    // reference to a file on disk and cannot be written out as text; it survives a structured
    // clone and nothing else does.
    const handle = handleTo("duck.sdfmod");
    await put("handle", handle);

    const readBack = await read<FileSystemHandleLike>("handle");
    expect(readBack?.name).toBe("duck.sdfmod");
    expect(await readBack?.isSameEntry(handle)).toBe(true);
  });

  it("does nothing and says nothing where there is no database at all", async () => {
    // **The case jsdom actually is**, and the case a browser with storage disabled is. Autosave
    // failing must not break the editor, and there is nothing a caller could do about it except
    // stop working.
    removeFakeDatabase();
    release();

    await expect(put("k", 1)).resolves.toBeUndefined();
    await expect(read("k")).resolves.toBeNull();
    await expect(forget("k")).resolves.toBeUndefined();
  });

  it("keeps a blob", async () => {
    // **A draft is the project file's own bytes**, so a draft is a blob and nothing is written
    // twice to hold it.
    const blob = new Blob(["zip"], { type: "application/zip" });
    await put("draft", blob);

    const readBack = await read<Blob>("draft");
    expect(readBack).toBeInstanceOf(Blob);
    expect(await readBack?.text()).toBe("zip");
  });
});

describe("recent files", () => {
  it("starts empty", async () => {
    expect(await listRecentFiles()).toEqual([]);
  });

  it("is empty on a browser that cannot hold a handle at all", async () => {
    // **And that is not a broken list, it is no list.** Opening a file on such a browser yields
    // its contents and no handle, so there is nothing to remember and drawing an empty grid would
    // look like something had gone wrong.
    withFileApi(false);
    await rememberFile(handleTo("duck.sdfmod"), 3);

    expect(await listRecentFiles()).toEqual([]);
  });

  it("remembers a file and can name it without reading it", async () => {
    // **The name is kept beside the handle so the list can be drawn without reading a
    // single file.** Opening one is the only thing that reads.
    await rememberFile(handleTo("duck.sdfmod"), 7);
    const [file] = await listRecentFiles();

    expect(file?.name).toBe("duck.sdfmod");
    expect(file?.parts).toBe(7);
  });

  it("puts the most recent first", async () => {
    await rememberFile(handleTo("first.sdfmod"), 1);
    await rememberFile(handleTo("second.sdfmod"), 2);

    expect((await listRecentFiles()).map((file) => file.name)).toEqual([
      "second.sdfmod",
      "first.sdfmod",
    ]);
  });

  it("remembers the same file once, not twice", async () => {
    // **Two handles to one file are different objects**, so identity would show it twice — and
    // the two entries would then race each other on every subsequent save.
    await rememberFile(handleTo("shared.sdfmod"), 3);
    await rememberFile(sameFile("shared.sdfmod"), 5);

    const known = await listRecentFiles();
    expect(known).toHaveLength(1);
    expect(known[0]?.parts).toBe(5);
  });

  it("keeps the entry's id when it replaces a known file", async () => {
    // **So a list being drawn does not change its keys under itself.**
    await rememberFile(handleTo("shared.sdfmod"), 3);
    const before = (await listRecentFiles())[0]?.id;
    await rememberFile(sameFile("shared.sdfmod"), 5);

    expect((await listRecentFiles())[0]?.id).toBe(before);
  });

  it("gives a new entry its own id", async () => {
    await rememberFile(handleTo("one.sdfmod"), 1);
    await rememberFile(handleTo("two.sdfmod"), 1);

    const [a, b] = await listRecentFiles();
    expect(a?.id).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
  });

  it("drops the least recently opened past the limit", async () => {
    for (let i = 0; i < REMEMBERED + 3; i++) {
      await rememberFile(handleTo(`model-${i}.sdfmod`), i);
    }

    const known = await listRecentFiles();
    expect(known).toHaveLength(REMEMBERED);
    // The three oldest went, and the newest stayed.
    expect(known[0]?.name).toBe(`model-${REMEMBERED + 2}.sdfmod`);
    expect(known.map((file) => file.name)).not.toContain("model-0.sdfmod");
  });

  it("forgets one file and leaves the rest", async () => {
    await rememberFile(handleTo("one.sdfmod"), 1);
    await rememberFile(handleTo("two.sdfmod"), 1);

    // **The most recent one, so the assertion is about which entry went rather than about the
    // ordering** — "two" is first because it was remembered last, and forgetting it leaves
    // "one", which is the opposite of what forgetting the *oldest* would leave.
    const [mostRecent] = await listRecentFiles();
    await forgetFile(mostRecent?.id ?? "");

    expect((await listRecentFiles()).map((file) => file.name)).toEqual([
      "one.sdfmod",
    ]);
  });

  it("forgetting a file that is not there changes nothing", async () => {
    await rememberFile(handleTo("one.sdfmod"), 1);
    await forgetFile("not-an-id");

    expect(await listRecentFiles()).toHaveLength(1);
  });

  it("drops an entry whose handle did not survive, rather than drawing half of one", async () => {
    // **A name and a handle are one record**, and half of one is a file this application can no
    // longer open — so it is not drawn at all rather than drawn unopenable.
    await put("recent", [
      { id: "a", name: "gone.sdfmod", parts: 1, lastOpenedAt: 2 },
      {
        id: "b",
        handle: handleTo("here.sdfmod"),
        name: "here.sdfmod",
        parts: 1,
        lastOpenedAt: 1,
      },
    ]);

    expect((await listRecentFiles()).map((file) => file.name)).toEqual([
      "here.sdfmod",
    ]);
  });

  it("treats a stored value of the wrong shape as no list at all", async () => {
    // **A database shared with something else, or a half-written value.** A string where an
    // array belongs is not a list to be salvaged.
    await put("recent", "not a list");

    expect(await listRecentFiles()).toEqual([]);
  });
});
