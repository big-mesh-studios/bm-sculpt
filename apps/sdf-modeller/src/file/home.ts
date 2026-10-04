/**
 * Where the document being edited lives, if it lives anywhere yet.
 *
 * ## Why this is one type and not two signals
 *
 * **Because a name and a handle drift apart.** Held separately, the state is "called duck" in
 * one place and "a handle to something else" in another, and nothing notices until Save writes
 * the wrong model over an unrelated file — which is the worst thing this application can do and
 * the one failure with no way back. rm-stacker learned this with three kinds of home (a file, an
 * atproto record, nowhere) and the same reason is why they are one union there; there are only
 * two here, and the reason is the same.
 *
 * ## Why "nowhere" is a state and not an absence
 *
 * **Because it is a decision, and a caller has to be able to act on it.** `undefined` would mean
 * the same as "not loaded yet" and "loaded from nowhere", and Save — which writes back where the
 * document came from — would have to ask which. `nowhere` is the answer: there is nothing to
 * write back to, so the next Save becomes Save as.
 *
 * It is also a state a document passes *through*. A restored draft has no home: the bytes came
 * from this browser's own database, not from a file, and saving it should ask where it goes
 * rather than quietly claiming the draft slot can be written back to.
 */
import { writerFor, type FileSystemHandleLike } from "./save-file";

export type Home =
  | { kind: "nowhere" }
  | {
      kind: "file";
      /**
       * This application's own name for the entry, so a list can key on it.
       *
       * **Because a handle cannot be compared cheaply** — `isSameEntry` is asynchronous and only
       * answers whether two handles are the same file, not which of a set they are.
       */
      id: string;
      handle: FileSystemHandleLike;
      name: string;
    };

/** Nothing anywhere yet, which is also what a restored draft has. */
export const NOWHERE: Home = { kind: "nowhere" };

/** What to call the document as things stand, for a title or a save dialog. */
export const homeName = (home: Home): string =>
  home.kind === "nowhere" ? "model" : home.name;

/**
 * Where a save would go, or nothing when there is nowhere to write back to.
 *
 * **`writerFor` and not a second copy of it**, because the copy that forgot to close the stream
 * would be a save that silently does nothing — the browser keeps the bytes in a buffer and the
 * file on disk is unchanged. One writer, used by everything that writes.
 */
export const homeWriter = (
  home: Home,
): ((blob: Blob) => Promise<void>) | undefined =>
  home.kind === "file" ? writerFor(home.handle) : undefined;
