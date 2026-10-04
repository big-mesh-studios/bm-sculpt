/**
 * The browser's own database, and the four things anything here keeps in it.
 *
 * ## Why this is a module and not part of `autosave`
 *
 * **Because two unrelated things need it and neither should know the other's keys.** The draft a
 * reload restores is a project file; the recent list is an array of file handles. They share a
 * database and nothing else, and folding them together is how a fix to one becomes a surprise in
 * the other.
 *
 * ## The one property everything else rests on
 *
 * **`put` stores whatever the browser structured-clones, and a `FileSystemFileHandle` is one of
 * those things.** That is why the recent files list survives a reload at all: a handle is a live
 * reference to a file on disk, not something that could be written out as text, and IndexedDB
 * is the only place in a browser that will keep one. Permission to *read* through it does not
 * last that long — the browser asks again after a reload, and only in answer to something the
 * person did — which is why `recent-files` keeps a name beside each handle and the file is only
 * ever read when somebody asks for it by name.
 *
 * ## Nothing here ever throws
 *
 * **Autosave failing must not break the editor.** `indexedDB` is missing in a browser with it
 * disabled, unavailable over some private modes, and absent under Node — so `put` resolves
 * without having done anything and `read` resolves to `null`. A caller cannot tell the
 * difference, which is deliberate: there is nothing it could do about it except stop working.
 *
 * A quota failure is the same case. A draft is a few kilobytes, but "the disk is full" is a
 * thing that happens on a phone, and an editor that stops accepting edits because its backup
 * failed has the priorities backwards.
 */

/** The database, and the one object store in it. */
const DB_NAME = "sdf-modeller";
const DB_VERSION = 1;
const STORE_NAME = "Store";

/**
 * The database handle, held between calls.
 *
 * **Because opening it is a round trip and every operation here needs it.** The promise is cached
 * rather than the database so that a failure is cached too — otherwise a browser with no
 * `indexedDB` would attempt the open on every keystroke's worth of debounce.
 */
let opening: Promise<IDBDatabase | null> | undefined;

/** Whether there is anywhere to keep anything, asked once and remembered. */
export const available = (): boolean => typeof indexedDB !== "undefined";

const open = (): Promise<IDBDatabase | null> => {
  if (!available()) return Promise.resolve(null);
  if (opening !== undefined) return opening;

  opening = new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event: Event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      // **Out-of-line keys, so one store holds everything.** The keys are string constants
      // declared by the modules that own them; nothing here knows what they are, which is what
      // lets autosave and recent files share a store without sharing a vocabulary.
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };
    // **Blocked as well as failed**, and both resolve to nothing: another tab of this
    // application holds an older version open, and waiting for it to close would hang the one
    // that is trying to save somebody's work.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return opening;
};

/**
 * Keeps `value` under `key`, replacing whatever was there.
 *
 * **A `FileSystemFileHandle` is a value this accepts**, which is the point of the module.
 */
export const put = async (key: string, value: unknown): Promise<void> => {
  const db = await open();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    const request = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(value, key);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
};

/**
 * What was kept under `key`, or `null` when there is nothing or nowhere to look.
 *
 * **A read failure is `null` for the same reason a write failure is silent**, and a caller that
 * treated "the database is broken" as "you have no draft" would behave exactly as it should.
 */
export const read = async <T>(key: string): Promise<T | null> => {
  const db = await open();
  if (db === null) return null;
  return new Promise<T | null>((resolve) => {
    const request = db
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(key);
    request.onsuccess = () =>
      resolve((request.result as T | undefined) ?? null);
    request.onerror = () => resolve(null);
  });
};

/** Throws away what was under `key`, which is what "New" means for a draft nobody asked to keep. */
export const forget = async (key: string): Promise<void> => {
  const db = await open();
  if (db === null) return;
  await new Promise<void>((resolve) => {
    const request = db
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
};

/**
 * Forgets the cached handle, for a test that wants the module to start from nothing.
 *
 * **Not a close, because nothing here opens a connection it is finished with** — the cached
 * handle is reused for the life of the page on purpose.
 */
export const release = (): void => {
  opening = undefined;
};
