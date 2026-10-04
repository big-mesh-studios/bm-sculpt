/**
 * The draft: this browser's own copy of the document, so a reload does not lose it.
 *
 * ## Why the draft is the project file and nothing else
 *
 * **Because it already contains everything a document is.** `writeProject` writes the parts,
 * their ids, which of them have a colour of their own, the palette and the mesher and the
 * resolution into one zip. The draft is that zip, stored verbatim, and restoring it is
 * `readProject` — the same code that opens a file, on the same bytes, with the same refusals.
 *
 * **What it deliberately does not hold is the undo history.** rm-stacker persists its undo stack,
 * because a `Command` is data it can serialise. This application's history entries are a pair of
 * **closures** (`ModelStore.load` and `add` build `apply`/`invert` out of captured variables), and
 * closures cannot be written to a database. So a restored document has no history and ctrl-Z
 * does nothing until the next edit — which is the right behaviour anyway: undoing back through a
 * page reload to edits somebody can no longer see is a worse thing to offer than not offering it.
 *
 * ## Why the debounce is here and not in the caller
 *
 * **Because a debounce that lives in the caller is a debounce that gets rebuilt on every
 * render.** This is one timer with one rule, and the caller says "this changed" rather than
 * saying when to write.
 */
import { forget, put, read } from "./database";

/** Where the draft's bytes live, and when they were last written. */
const DRAFT_KEY = "draft";
const DRAFT_AT_KEY = "draftAt";

/**
 * How long the document has to be still before it is written, in milliseconds.
 *
 * **A second, and the number is about the disk rather than about the work.** `writeProject` builds
 * a zip, which is a few kilobytes of compression; the cost is not the bytes but the transaction,
 * and a person editing a figure pauses for whole seconds between edits while they look at it.
 * A second writes once per pause rather than once per frame.
 */
export const AUTOSAVE_MS = 1000;

/** The draft as it comes back, with the time it was written. */
export interface Draft {
  readonly blob: Blob;
  readonly at: number;
}

/** Keeps the document. Resolves without having done anything where there is nowhere to keep it. */
export const saveDraft = async (blob: Blob): Promise<void> => {
  const at = Date.now();
  // **The two writes are not one transaction**, because this API takes one value at a time and
  // the pair is small. A crash between them leaves a draft with no timestamp, which reads as
  // "saved at the epoch" and is corrected by the next write — a cosmetic inconsistency rather
  // than a lost document, which is the right way round for a backup.
  await put(DRAFT_KEY, blob);
  await put(DRAFT_AT_KEY, at);
};

/** The draft this browser is holding, or `null` when it is holding none. */
export const readDraft = async (): Promise<Draft | null> => {
  const blob = await read<Blob>(DRAFT_KEY);
  if (!(blob instanceof Blob)) return null;

  const at = await read<number>(DRAFT_AT_KEY);
  return { blob, at: typeof at === "number" ? at : 0 };
};

/**
 * Throws the draft away.
 *
 * **And this is what "New" means.** Without it, a person who starts over, closes the tab and
 * comes back would be given the document they discarded — which is how an autosave becomes
 * something people stop trusting.
 */
export const clearDraft = async (): Promise<void> => {
  await forget(DRAFT_KEY);
  await forget(DRAFT_AT_KEY);
};

/** Something that writes the draft when the document settles. */
export interface Autosave {
  /** Says the document changed. The write happens a second later, or when `flush` is called. */
  readonly changed: () => void;
  /** Writes now if anything is waiting, and says whether it did. */
  readonly flush: () => Promise<boolean>;
  /** Stops, and writes nothing further. */
  readonly dispose: () => void;
}

/**
 * A debounced writer.
 *
 * **And never two writes at once.** A person who edits continuously would otherwise have write
 * two start before write one finished, and the database would keep whichever landed last — which
 * is the *older* of the two as often as not, because the later one has to wait for a transaction
 * that is still open. So a change arriving mid-write re-arms rather than starting another.
 *
 * @param write What to write. Given as a function so the caller is not holding a stale closure
 *   over the model.
 * @param ms How long to wait. Exposed because a test cannot wait a second.
 */
export const autosave = (
  write: () => Promise<void>,
  ms: number = AUTOSAVE_MS,
): Autosave => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting = false;
  let writing = false;
  let stop = false;

  const run = async (): Promise<boolean> => {
    if (!waiting || writing || stop) return false;
    waiting = false;
    writing = true;
    try {
      await write();
      return true;
    } catch {
      // **A failed write is not an error the editor should stop for.** The draft is a backup; a
      // backup that could take the application down with it is a liability. `database.put` is
      // already silent about missing storage and quota; this is the same decision one level up.
      return false;
    } finally {
      writing = false;
      // **A change that arrived while the write was in flight is written now**, not dropped and
      // not left waiting for another edit that may never come.
      if (waiting && !stop) {
        timer = setTimeout(() => void run(), ms);
      }
    }
  };

  return {
    changed: () => {
      if (stop) return;
      waiting = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void run();
      }, ms);
    },

    flush: () => run(),

    dispose: () => {
      stop = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      waiting = false;
    },
  };
};
