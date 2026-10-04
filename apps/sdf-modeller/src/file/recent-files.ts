/**
 * The files on disk this editor has opened, so they can be opened again without hunting for them.
 *
 * ## What is kept is the handle
 *
 * **A `FileSystemFileHandle` is a live reference to a file on disk, and IndexedDB is the only
 * thing in a browser that will keep one** — it survives a structured clone where a string would
 * not. That is the whole reason this list exists across a reload at all.
 *
 * Permission does **not** survive that long. The browser asks again after a reload, and only in
 * answer to something the person did, which is why:
 *
 * - **A name is kept beside every handle**, so the list can be drawn without reading a single
 *   file. Opening one is the only thing that reads.
 * - **`mayRead` belongs in a click**, never in drawing the list. Calling `requestPermission`
 *   outside a gesture is refused by the browser, and asking for twelve files to draw a menu
 *   would be refused twelve times.
 *
 * ## Nothing here exists on a browser without the API
 *
 * **Opening a file there yields its contents and no handle**, so there is nothing to remember.
 * `remembersFiles()` is the gate and the caller hides the list, rather than the list being drawn
 * empty and looking broken.
 */
import { available, put, read } from "./database";
import { remembersFiles, type FileSystemHandleLike } from "./save-file";

const RECENT_KEY = "recent";

/**
 * How many files are remembered before the least recently opened is dropped.
 *
 * **Twelve, and the number is about the menu rather than about memory.** This is a list somebody
 * picks a file out of, and a picker a person scrolls past its first screen is not a picker. The
 * sibling keeps sixty because its list mixes in published models and has room to scroll; there
 * is nothing else in this one.
 */
export const REMEMBERED = 12;

export interface RecentFile {
  /** This editor's own name for the entry, because a handle cannot be compared cheaply. */
  readonly id: string;
  readonly handle: FileSystemHandleLike;
  /** The file's name as it was when last seen, for showing without reading it. */
  readonly name: string;
  /** How many parts the model had. One number, free, and it tells a sphere from a character. */
  readonly parts: number;
  readonly lastOpenedAt: number;
}

/** Whether there is anything this list could hold. */
export const canRemember = remembersFiles;

/** Every remembered file, most recently opened first. */
export const listRecentFiles = async (): Promise<RecentFile[]> => {
  if (!remembersFiles()) return [];
  const stored = await read<RecentFile[]>(RECENT_KEY);
  if (!Array.isArray(stored)) return [];

  return (
    stored
      // **Entries without a handle are dropped rather than repaired**, because a handle that did
      // not survive the clone cannot be replaced: a name and a handle are one record, and half of
      // one is a file this application can no longer open.
      .filter((entry): entry is RecentFile => entry?.handle !== undefined)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  );
};

/**
 * Records that a file was just opened or written, replacing what was known about it.
 *
 * **The same file opened twice is one entry, not two, and `isSameEntry` is the only way to ask.**
 * Two handles to one file are different objects, so comparing them by identity would show it
 * twice — and the two entries would then race each other on every subsequent save.
 *
 * The entry keeps its **id** when it is replacing a known file, so a list being drawn does not
 * change its keys under itself.
 */
export const rememberFile = async (
  handle: FileSystemHandleLike,
  parts: number,
): Promise<RecentFile> => {
  const known = await listRecentFiles();
  const same = await Promise.all(
    known.map((other) => safeIsSameEntry(handle, other.handle)),
  );

  const remembered: RecentFile = {
    id: known.find((_, index) => same[index])?.id ?? newId(),
    handle,
    name: handle.name,
    parts,
    lastOpenedAt: Date.now(),
  };

  await put(RECENT_KEY, [
    remembered,
    ...known.filter((_, index) => !same[index]).slice(0, REMEMBERED - 1),
  ]);

  return remembered;
};

/** Drops one file from the listing. **The file on disk is untouched.** */
export const forgetFile = async (id: string): Promise<void> => {
  const known = await listRecentFiles();
  await put(
    RECENT_KEY,
    known.filter((entry) => entry.id !== id),
  );
};

/**
 * Asks whether `handle` may be read, without asking for permission.
 *
 * **Separate from `mayRead` because drawing a list must only ever ask.** `requestPermission` is
 * refused outside a gesture, so a list that called it on twelve handles would be refused twelve
 * times; the browser also shows its own prompt, and a menu that opens twelve prompts is a menu
 * nobody can close.
 */
export const mayAlreadyRead = async (
  handle: FileSystemHandleLike,
): Promise<boolean> => {
  try {
    return (await handle.queryPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
};

/**
 * Asks for permission to read `handle`, which the browser only grants in answer to something the
 * person did — so this belongs in a click.
 */
export const mayRead = async (
  handle: FileSystemHandleLike,
): Promise<boolean> => {
  if (await mayAlreadyRead(handle)) return true;
  try {
    return (await handle.requestPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
};

/**
 * The file's bytes, after asking.
 *
 * **`undefined` for every reason it could not be read**, because the caller has one thing to do
 * either way: leave the document alone and say the file could not be opened. Permission refused,
 * the file moved, the disk unplugged — the caller does not act differently for any of them.
 */
export const readThrough = async (
  handle: FileSystemHandleLike,
): Promise<Blob | undefined> => {
  if (!(await mayRead(handle))) return undefined;
  try {
    return await handle.getFile();
  } catch {
    return undefined;
  }
};

/**
 * An id for an entry.
 *
 * **`crypto.randomUUID` where it is there and a counter where it is not.** It only has to be
 * unique within one browser's list and stable across a reload, so this is not a case where a
 * fallback needs to be a real UUID.
 */
const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `file-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

/**
 * `isSameEntry`, tolerating a handle whose method is missing.
 *
 * **A throw here would lose the list.** A handle stored by an older build, or by a browser that
 * has since renamed the method, would make every save throw; treating it as "not the same file"
 * costs a duplicate entry in the list and nothing else.
 */
const safeIsSameEntry = async (
  a: FileSystemHandleLike,
  b: FileSystemHandleLike,
): Promise<boolean> => {
  try {
    return await a.isSameEntry(b);
  } catch {
    return false;
  }
};

/** Whether the browser can keep anything at all, which is a weaker thing than the API. */
export const canStore = available;
