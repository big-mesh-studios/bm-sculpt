// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  chooseFileToRead,
  choosePlaceToWrite,
  downloadBlob,
  pickFile,
  remembersFiles,
  type FilePickerOptions,
} from "./save-file";

const CHOICE: FilePickerOptions = {
  description: "SDF model",
  extension: ".sdfmod",
  mimeType: "application/zip",
};

/** Puts the File System Access API on `window`, or takes it away again. */
const withApi = (
  open?: (options?: unknown) => Promise<unknown[]>,
  save?: (options?: unknown) => Promise<unknown>,
): void => {
  if (open === undefined) delete window.showOpenFilePicker;
  else window.showOpenFilePicker = open as typeof window.showOpenFilePicker;
  if (save === undefined) delete window.showSaveFilePicker;
  else window.showSaveFilePicker = save as typeof window.showSaveFilePicker;
};

/** A handle that records what was written to it. */
const handleWritingTo = (written: Blob[], name = "duck.sdfmod") => ({
  name,
  getFile: async () => new File([""], name),
  createWritable: async () => {
    let sink: Blob | undefined;
    return {
      write: async (blob: Blob) => {
        sink = blob;
      },
      close: async () => {
        if (sink !== undefined) written.push(sink);
      },
    };
  },
});

afterEach(() => {
  withApi();
  vi.restoreAllMocks();
});

describe("remembersFiles", () => {
  it("is false without the API and true with it, by asking rather than by version", () => {
    // **Feature detection and not a browser name**, because the API's availability has nothing
    // to do with a version number and changes within one — Safari and Firefox have both shipped
    // it behind different flags.
    expect(remembersFiles()).toBe(false);
    withApi(async () => []);
    expect(remembersFiles()).toBe(true);
  });

  it("is false when the property is there but is not a function", () => {
    // **A polyfill that failed to load leaves something behind**, and calling it would throw on
    // the first Save rather than falling back.
    (window as unknown as Record<string, unknown>).showOpenFilePicker = "nope";
    expect(remembersFiles()).toBe(false);
  });
});

describe("pickFile", () => {
  it("settles with nothing when the picker is not there", async () => {
    await expect(pickFile(undefined, CHOICE)).resolves.toBeUndefined();
  });

  it("settles with nothing when the person dismisses it", async () => {
    // **The case a `change`-only listener never reaches.** An input fires `cancel` and nothing
    // else when a dialog is closed, so a promise waiting on `change` never settles and whatever
    // was waiting on it stays waiting for the rest of the session.
    const picker = document.createElement("input");
    const waiting = pickFile(picker, CHOICE);
    picker.dispatchEvent(new Event("cancel"));

    await expect(waiting).resolves.toBeUndefined();
  });

  it("resolves with the file that was chosen", async () => {
    const picker = document.createElement("input");
    const waiting = pickFile(picker, CHOICE);
    const file = new File(["bytes"], "duck.sdfmod");
    Object.defineProperty(picker, "files", { value: [file] });
    picker.dispatchEvent(new Event("change"));

    await expect(waiting).resolves.toMatchObject({
      name: "duck.sdfmod",
      blob: file,
    });
  });

  it("takes only the first file when a picker offered several", async () => {
    const picker = document.createElement("input");
    const waiting = pickFile(picker, CHOICE);
    Object.defineProperty(picker, "files", {
      value: [
        new File(["a"], "first.sdfmod"),
        new File(["b"], "second.sdfmod"),
      ],
    });
    picker.dispatchEvent(new Event("change"));

    expect((await waiting)?.name).toBe("first.sdfmod");
  });

  it("clears the input first, so opening the same file twice still fires", async () => {
    // **The single most likely thing a person does twice**, and a file input holding a value
    // does not report the same file again.
    const picker = document.createElement("input");
    picker.value = "C:/fake/duck.sdfmod";
    void pickFile(picker, CHOICE);

    expect(picker.value).toBe("");
  });

  it("says what it will accept, from the call that opens it", async () => {
    const picker = document.createElement("input");
    void pickFile(picker, CHOICE);

    expect(picker.accept).toBe("application/zip");
  });
});

describe("choosePlaceToWrite", () => {
  it("says there is nowhere to write on a browser with no dialog", async () => {
    // **`undefined` rather than a throw**, because this is a fact about the browser and the
    // caller has a different answer for it than for a dismissal.
    await expect(
      choosePlaceToWrite(CHOICE, "model.sdfmod"),
    ).resolves.toBeUndefined();
  });

  it("asks for the name it was given and the types it may have", async () => {
    const save = vi.fn(async () => handleWritingTo([]));
    withApi(undefined, save);

    await choosePlaceToWrite(CHOICE, "duck.sdfmod");

    expect(save).toHaveBeenCalledWith({
      suggestedName: "duck.sdfmod",
      types: [
        {
          description: "SDF model",
          accept: { "application/zip": [".sdfmod"] },
        },
      ],
    });
  });

  it("settles with nothing when the dialog is dismissed", async () => {
    // **An `AbortError` by name**, because that is the part of the DOM standard that says what
    // happened; a message match would be a bet on somebody else's wording.
    withApi(undefined, async () => {
      throw Object.assign(new Error("The user aborted a request."), {
        name: "AbortError",
      });
    });

    await expect(
      choosePlaceToWrite(CHOICE, "m.sdfmod"),
    ).resolves.toBeUndefined();
  });

  it("lets a real failure through rather than calling it a dismissal", async () => {
    withApi(undefined, async () => {
      throw new Error("quota exceeded");
    });

    await expect(choosePlaceToWrite(CHOICE, "m.sdfmod")).rejects.toThrow(
      "quota exceeded",
    );
  });
});

describe("writing through a handle", () => {
  it("writes the bytes and closes the stream", async () => {
    // **`close` and not just `write`,** because a writable stream that is written to and not
    // closed is a promise the browser has made and not kept: the bytes sit in a buffer and the
    // file on disk is unchanged. This is the kind of thing that makes an export silently do
    // nothing.
    const written: Blob[] = [];
    withApi(
      async () => [handleWritingTo(written)],
      async () => handleWritingTo(written),
    );

    const target = await choosePlaceToWrite(CHOICE, "m.sdfmod");
    const payload = new Blob(["the model"], { type: "application/zip" });
    await target?.write(payload);

    expect(written).toHaveLength(1);
    expect(await written[0]?.text()).toBe("the model");
  });

  it("opens a file through the API and hands back something writable", async () => {
    // **Writable as well as readable**, because that is what makes Save a Save rather than a
    // Save as: a document opened once should be saved back to where it came from.
    const written: Blob[] = [];
    withApi(async () => [handleWritingTo(written, "duck.sdfmod")]);

    const opened = await chooseFileToRead(undefined, CHOICE);

    expect(opened?.name).toBe("duck.sdfmod");
    expect(opened?.write).toBeTypeOf("function");
    await opened?.write?.(new Blob(["later"]));
    expect(written).toHaveLength(1);
  });

  it("settles with nothing when the open dialog is dismissed", async () => {
    withApi(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });

    await expect(chooseFileToRead(undefined, CHOICE)).resolves.toBeUndefined();
  });

  it("falls back to the input where there is no API", async () => {
    // **The same call, a different mechanism**, so the caller has no branch on which browser it
    // is. The input is created here rather than passed in, which is what a caller without a
    // ref in its markup would do.
    const picker = document.createElement("input");
    const waiting = chooseFileToRead(picker, CHOICE);
    Object.defineProperty(picker, "files", {
      value: [new File(["bytes"], "duck.sdfmod")],
    });
    picker.dispatchEvent(new Event("change"));

    expect((await waiting)?.name).toBe("duck.sdfmod");
  });
});

describe("downloadBlob", () => {
  it("offers the bytes under the name it was given", () => {
    // **A detached anchor**, which every browser that matters honours and which appending to
    // the document would leave in the tree if anything above threw.
    const clicks: HTMLAnchorElement[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = create(tag);
      if (element instanceof HTMLAnchorElement) {
        element.click = () => clicks.push(element);
      }
      return element;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");

    downloadBlob(new Blob(["bytes"]), "duck.sdfmod");

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toBe("duck.sdfmod");
    expect(clicks[0]?.href).toContain("blob:fake");
  });

  it("lets the object URL go, which is what stops an export leaking", async () => {
    // **Revoked in a `finally`.** The URL holds the bytes alive until it is revoked, and an
    // export is megabytes — so twenty exports in a session without this leaks twenty megabytes.
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        tag,
      );
      if (element instanceof HTMLAnchorElement) element.click = () => {};
      return element;
    });

    downloadBlob(new Blob(["bytes"]), "duck.sdfmod");

    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });

  it("revokes the URL even when the click throws", async () => {
    // **The `finally` earning its place.** A browser that refuses a download should not also
    // leave several megabytes of export alive for the rest of the session.
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        tag,
      );
      if (element instanceof HTMLAnchorElement) {
        element.click = () => {
          throw new Error("blocked");
        };
      }
      return element;
    });

    expect(() => {
      downloadBlob(new Blob(["bytes"]), "duck.sdfmod");
    }).toThrow("blocked");
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});
