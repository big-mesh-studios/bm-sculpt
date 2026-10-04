/**
 * Getting bytes in and out of the browser's file system.
 *
 * ## Two paths, and which one is used when
 *
 * **The File System Access API where it exists, and a plain download everywhere else.**
 * `showOpenFilePicker` and `showSaveFilePicker` hand back a `FileSystemFileHandle`, which is
 * the difference between "Save" writing back to the file the model came from and "Save"
 * downloading a second copy of it every time. That is worth a great deal: somebody who has just
 * fixed a model and saved it, then saved it again, should not end up with four files.
 *
 * The API is not everywhere — Firefox has it behind a flag and Safari not at all — so everything
 * here degrades to a hidden `<input type="file">` and an `<a download>`. The degradation is a
 * *different experience*, not a broken one, which is why nothing in this file throws for its
 * absence.
 *
 * ## Why the fallback input is reset before the listener goes on
 *
 * **A file input holding a value does not report the same file again.** "Open the file I just
 * fixed" is the single most likely thing a person does twice in a row, so the value is cleared
 * first. `apps/bm-sculpt/src/app.tsx` records this having been found the same way.
 *
 * ## Why the promises always settle
 *
 * **A dismissed picker fires `cancel` and nothing else.** An input's promise that only resolves
 * on `change` therefore never settles when the person backs out, and a spinner, a disabled
 * button or a "saving…" line stays up for the rest of the session. So every wait here resolves
 * on `cancel` as well, with `undefined`, and the caller treats that as "nothing happened".
 */

/**
 * The File System Access API, declared here because `lib.dom` does not carry it.
 *
 * **Only the four members this file uses, and no more.** A hand-written declaration of a web
 * platform API is a promise to keep it in step with a specification, and this one is four
 * members; the fuller shape is not needed and would be more of that promise than is worth.
 * `getFile` and `createWritable` are here because a `FileSystemFileHandle` is how Save writes
 * back to the file a model came from.
 */
interface FileSystemWritable {
  write: (blob: Blob) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * A file handle, and the three methods of it this application uses that `lib.dom` lacks.
 *
 * **`isSameEntry` is here because two handles to one file are different objects**, which is the
 * whole of how the recent list avoids showing the same file twice — and it is the only way to
 * ask. `queryPermission` and `requestPermission` are here because a handle that survives a reload
 * does not survive *permission*, and reading through one needs asking.
 */
export interface FileSystemHandleLike {
  readonly name: string;
  getFile: () => Promise<File>;
  createWritable: () => Promise<FileSystemWritable>;
  isSameEntry: (other: FileSystemHandleLike) => Promise<boolean>;
  queryPermission: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission: (descriptor?: {
    mode?: "read" | "readwrite";
  }) => Promise<PermissionState>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: PickerType[];
    }) => Promise<FileSystemHandleLike>;
    showOpenFilePicker?: (options?: {
      multiple?: boolean;
      types?: PickerType[];
    }) => Promise<FileSystemHandleLike[]>;
  }
}

/** The browser can hand back a handle to the file it wrote, so Save can write to it again. */
export const remembersFiles = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.showOpenFilePicker === "function";

/** What a picker is told it may open. */
export interface FilePickerOptions {
  readonly description: string;
  readonly extension: string;
  readonly mimeType: string;
}

/**
 * A file that was opened.
 *
 * **Carries a `write` where the browser supports one, and that is the whole difference between
 * Save and Save as.** Without a handle, Save has to ask where to put the file every time, which
 * is a correct thing to do and not the same experience.
 */
export interface OpenedFile {
  readonly name: string;
  readonly blob: Blob;
  /**
   * The handle, where the browser gave one.
   *
   * **Absent for the hidden-input path**, and that is the whole difference between an opened file
   * that can be saved back to and one that has to be found again. It is also the thing the recent
   * list is made of.
   */
  readonly handle?: FileSystemHandleLike;
  readonly write?: (blob: Blob) => Promise<void>;
}

/**
 * A place a file can be written to.
 *
 * **The handle as well as the way of writing to it**, because the handle is what makes the next
 * Save a Save rather than a Save as — and what the recent list is built from. A target that could
 * only be written to would leave the caller unable to remember where it wrote.
 */
export interface WriteTarget {
  readonly name: string;
  readonly handle: FileSystemHandleLike;
  readonly write: (blob: Blob) => Promise<void>;
}

/**
 * A picker for a file to open, or `undefined` if the person dismissed it.
 *
 * `picker` is a ref to the hidden input, because the element has to exist in the document for
 * `.click()` to open a dialog — a detached input does nothing, silently.
 */
export const pickFile = (
  picker: HTMLInputElement | undefined,
  choice: FilePickerOptions,
): Promise<OpenedFile | undefined> =>
  new Promise<OpenedFile | undefined>((resolve) => {
    if (picker === undefined) {
      resolve(undefined);
      return;
    }

    // **Set here rather than in the markup**, so the one thing that decides what a person may
    // open is the call that opens it — a picker wired up from a JSX attribute is a picker whose
    // accepted types have to be found by reading the component that renders it.
    picker.accept = choice.mimeType;
    picker.value = "";
    picker.addEventListener(
      "change",
      () => {
        const file = picker.files?.[0];
        if (file === undefined) {
          resolve(undefined);
          return;
        }
        resolve({ name: file.name, blob: file });
      },
      { once: true },
    );
    picker.addEventListener("cancel", () => resolve(undefined), { once: true });
    picker.click();
  });

/**
 * A place to write a file, chosen through `showSaveFilePicker` where it exists.
 *
 * **`undefined` where the browser has no such dialog**, which is a different answer from "the
 * person dismissed it" and the caller needs to tell them apart: one means write it somewhere
 * else, the other means do nothing. `write` is absent in the first case, because there is
 * nowhere to write to.
 *
 * **The dismissal case is a thrown `AbortError`, not a resolution**, so the throw is caught and
 * told apart from a real failure by its name alone. `apps/bm-sculpt`'s console has the same
 * distinction to make.
 */
export const choosePlaceToWrite = async (
  choice: FilePickerOptions,
  preferredName: string,
): Promise<WriteTarget | undefined> => {
  const show = window.showSaveFilePicker;
  if (show === undefined) return undefined;

  try {
    const handle = await show({
      suggestedName: preferredName,
      types: [
        {
          description: choice.description,
          accept: { [choice.mimeType]: [choice.extension] },
        },
      ],
    });
    return { name: handle.name, handle, write: writerFor(handle) };
  } catch (reason) {
    if (isAbort(reason)) return undefined;
    throw reason;
  }
};

/**
 * A file to read, chosen through `showOpenFilePicker` where it exists and through a plain input
 * where it does not.
 *
 * **`undefined` in both cases means nothing was chosen** — dismissed either way — because the
 * caller has nothing to do about a file that was not picked either.
 */
export const chooseFileToRead = async (
  picker: HTMLInputElement | undefined,
  choice: FilePickerOptions,
): Promise<OpenedFile | undefined> => {
  const show = window.showOpenFilePicker;
  if (show === undefined) return pickFile(picker, choice);

  try {
    const [handle] = await show({
      multiple: false,
      types: [
        {
          description: choice.description,
          accept: { [choice.mimeType]: [choice.extension] },
        },
      ],
    });
    if (handle === undefined) return undefined;
    return {
      name: handle.name,
      blob: await handle.getFile(),
      handle,
      write: writerFor(handle),
    };
  } catch (reason) {
    if (isAbort(reason)) return undefined;
    throw reason;
  }
};

/**
 * Writing to a handle.
 *
 * **`close` and not just `write`, because a writable stream that is written to and not closed
 * is a promise the browser has made and not kept**: the bytes sit in a buffer and the file on
 * disk is unchanged until the stream closes. This is the kind of thing that makes an export
 * silently do nothing, and it is why the two are chained rather than the write awaited alone.
 *
 * **Exported because there are now two callers** and a second implementation of it would be a
 * second chance to forget the close.
 */
export const writerFor =
  (handle: FileSystemHandleLike) =>
  async (blob: Blob): Promise<void> => {
    const stream = await handle.createWritable();
    await stream.write(blob);
    await stream.close();
  };

/**
 * Writes `blob` to wherever the browser will put it, which is a download.
 *
 * **An object URL, revoked immediately after the click.** The URL holds the bytes alive until it
 * is revoked, and an export is a few megabytes — so a person who exports twenty times in a
 * session leaks twenty megabytes unless the URL is let go of. The revoke is in a `finally`
 * because the click is what hands the URL over and the browser has taken a reference by then,
 * so it is safe immediately rather than after a timeout.
 */
export const downloadBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    // **Not appended to the document.** A click on a detached anchor works in every browser that
    // matters, and appending one would leave it in the tree if anything above threw.
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * Whether a failure is the person closing a dialog rather than something going wrong.
 *
 * **`name === "AbortError"`, and only that.** A message match would be a bet on somebody else's
 * wording; the name is the part of the DOM standard that says what happened.
 */
const isAbort = (reason: unknown): boolean =>
  typeof reason === "object" &&
  reason !== null &&
  (reason as { name?: unknown }).name === "AbortError";
