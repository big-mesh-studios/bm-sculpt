/**
 * Opening a place zip: the gate between a file somebody handed you and a program that runs in
 * an interpreter.
 *
 * ## What this is for
 *
 * `src/places/demos.ts` builds a `PlaceFiles` record out of `?raw` imports, which is the right
 * shape for a place that is in the tree and the only possible shape for one that is not. A
 * place has to be able to arrive as a **file** — exported from an editor, sent to a person,
 * fetched from somewhere — and this is the code that turns those bytes into the same
 * `{ files, entry }` the host already takes, so the host knows nothing about where a place came
 * from.
 *
 * The reference implementation is `big-mesh-studios`'s `apps/voxelscape/src/places/package.ts`,
 * and the shape of the manifest and the order of the checks are its.
 *
 * ## All or nothing
 *
 * **A place that cannot be fully read is refused entirely, never partly loaded.** This is the
 * same rule ADR 0017 states for an effect payload — a shape added with three fields present and
 * two absent is not a shape with a defect, it is a different shape — applied one level up. A
 * half-read place would give a script an import that resolves to nothing, and the failure would
 * surface as an error inside the interpreter about a line number in a scope nobody wrote.
 *
 * ## The bytes are read to an array buffer first
 *
 * `JSZip.loadAsync` reads a `Blob` through the browser's `FileReader`, **which Node does not
 * provide**, so the array-buffer path is the one that works in both a browser and this
 * repository's tests. The reference hit exactly this and left the reason in a comment; it is
 * repeated here because the `Blob` overload looks like the better API and is.
 *
 * ## What this does not claim to defend against
 *
 * **A zip bomb, entirely.** Every file is decompressed before its length can be read, so the
 * peak is one file's uncompressed size rather than `MAX_PLACE_SOURCE` — the cap bounds what is
 * *retained*, which is the part this code controls. Bounding decompression itself means asking
 * for a stream and counting as it goes, which jszip does not offer; the honest position is that
 * `MAX_PLACE_FILES` bounds the worst case to sixty-four files and the step budget in ADR 0015
 * bounds what the program does with them once it is running.
 */

import JSZip from "jszip";

import { MAX_PLACE_SOURCE } from "./limits";
import {
  isPlaceManifest,
  isSafePathName,
  PLACE_MANIFEST_FILE,
  type PlaceManifest,
} from "./place-file";
import type { PlaceFiles } from "./bundle";

/** A place that was read out of a zip, with the manifest that described it. */
export interface LoadedPlace {
  readonly manifest: PlaceManifest;
  /** The script files, as the bundler takes them. Every path is safe and relative to the root. */
  readonly files: PlaceFiles;
  /** The file that runs. Copied out of the manifest so a caller need not re-validate it. */
  readonly entry: string;
}

/** The extension a compiled script is stored under in the zips this reads. */
const SCRIPT_EXTENSION = ".ts";

/**
 * Reads a place out of a zip.
 *
 * **Every refusal names what is wrong and where.** A person who opened the wrong file, or whose
 * editor wrote a manifest this version does not understand, needs to be told which — and the
 * whole list of refusals is short enough that each one can say its own reason rather than
 * collapsing to "not a place".
 *
 * @param blob - The zip's bytes.
 * @returns The manifest, the files it named, and which of them runs.
 * @throws When the bytes are not a zip, carry no readable `manifest.json`, carry a manifest this
 *   cannot open, name a file the zip does not hold, hold a path that walks out of its own root,
 *   or carry more source than a place is allowed to.
 */
export const readPlaceZip = async (blob: Blob): Promise<LoadedPlace> => {
  const zip = await openZip(blob);
  const manifest = await readManifest(zip);

  // **A zip is allowed to hold more than it declares**, and this is where that is settled. The
  // reference throws away every file the manifest did not name; this refuses the archive
  // instead, because the two answers are about different things and only one of them is right.
  //
  //   - Declaring is what makes a file part of the program. An undeclared `.ts` is dead weight,
  //     and quietly dropping it is what lets a stale build load a place that is missing a file
  //     its author removed weeks ago.
  //   - But an archive carrying an undeclared file at all means the manifest and the zip were
  //     written by different tools, or by different versions of one tool. That is a place whose
  //     contents nobody can state, and "what is actually in this zip" is exactly the question a
  //     person opens a stranger's place to avoid.
  //
  // So an undeclared `.ts` is refused, an undeclared directory entry is ignored (a zip written
  // by a tool that records folders carries them for every file), and anything else undeclared is
  // refused too — there is no file in a place that is neither the manifest nor a declared script,
  // and a `.md` somebody left in the folder is not a reason to refuse the place.
  const declared = new Set(manifest.scripts);
  for (const name of Object.keys(zip.files)) {
    if (name === PLACE_MANIFEST_FILE) continue;
    const entry = zip.files[name];
    // **`dir` is JSZip's own flag on the entry, not a guess from the trailing slash.** A zip
    // written by a tool that does not record directories leaves a trailing slash on a file that
    // is not a directory, and refusing those would refuse a perfectly ordinary place.
    if (entry.dir) continue;
    if (declared.has(name)) continue;

    if (name.toLowerCase().endsWith(SCRIPT_EXTENSION)) {
      throw new Error(
        `the zip holds "${name}", which manifest.json does not name — the manifest and the archive disagree`,
      );
    }
    // Not a script, so not part of the program, and not something this loader knows what to do
    // with. Ignored rather than refused, because a folder of scripts plus a `LICENSE` is a
    // perfectly ordinary thing to hand someone.
  }

  const files: Record<string, string> = {};
  let characters = 0;

  for (const name of manifest.scripts) {
    if (!isSafePathName(name)) {
      throw new Error(
        `the manifest names "${name}", which is not a path this can read`,
      );
    }

    const entry = zip.file(name);
    if (entry === null) {
      throw new Error(
        `the manifest names "${name}", which the zip does not hold`,
      );
    }

    const source = await entry.async("text");
    characters += source.length;
    if (characters > MAX_PLACE_SOURCE) {
      throw new Error(
        `the place's source is over the ${MAX_PLACE_SOURCE} character limit`,
      );
    }
    files[name] = source;
  }

  return { manifest, files, entry: manifest.entry };
};

/** Opens the archive, or says what the bytes were not. */
const openZip = async (blob: Blob): Promise<JSZip> => {
  try {
    const buffer = await blob.arrayBuffer();
    return await JSZip.loadAsync(buffer);
  } catch (reason) {
    // **Its own error, not the zip library's.** The library says things like "Can't read end
    // of central directory", which is a sentence about a format and not an answer to "what did
    // I just try to open".
    throw new Error(`not a zip a place was saved as`, { cause: reason });
  }
};

/**
 * Reads and checks `manifest.json`.
 *
 * **Parsed, then validated, then trusted — in that order, with nothing in between.** `JSON.parse`
 * on bytes from a stranger is the only genuinely untrusted parse in this file, and everything
 * after it is a check on a value of known shape.
 */
const readManifest = async (zip: JSZip): Promise<PlaceManifest> => {
  const entry = zip.file(PLACE_MANIFEST_FILE);
  if (entry === null) {
    throw new Error(`no ${PLACE_MANIFEST_FILE} at the zip's root`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await entry.async("text"));
  } catch {
    throw new Error(`${PLACE_MANIFEST_FILE} is not valid JSON`);
  }

  if (!isPlaceManifest(parsed)) {
    throw new Error(
      `${PLACE_MANIFEST_FILE} is not a place manifest this can open`,
    );
  }
  return parsed;
};
