/**
 * The top of a place zip: `manifest.json`, the file that says what the place is and which of
 * its files are the program.
 *
 * ## Why a manifest at all
 *
 * **The zip's own contents cannot answer the question.** A directory of `.ts` files says what
 * is in a place and nothing about which file runs, what it is called, or what world it belongs
 * to — and a place with two entries needs an answer to the first of those from somewhere that
 * is not "whichever file sorts first". So the manifest is the one file that is not part of the
 * program, and a zip without one is not a place.
 *
 * It is checked **before a byte of it goes anywhere**, which is the same gate
 * `big-mesh-studios`'s `readPlaceZip` puts in front of the same file. A place is a program that
 * runs in an interpreter, and the cheapest place to refuse one is before it is compiled.
 *
 * ## What this takes from the reference, and what it leaves
 *
 * voxelscape's `PlaceManifest` has four fields this does not copy:
 *
 * - **`levels`** — `.json` level plans, read by its `onPlan` handler. A smooth-landscape engine
 *   has no levels and no plan handler, and a manifest naming one would be naming a file nothing
 *   opens.
 * - **`models`** — rm-stacker `.zip` models, attached to NPCs. There are no figures in v1, so
 *   there is nothing for a model to attach to.
 * - **`mode`** — `solo` / `multi` / `:edit`, which decides whether a place starts multiplayer.
 *   Multiplayer is not built (see the README's remaining work), and a manifest that could
 *   switch it on would be a switch wired to nothing.
 *
 * They are **omitted rather than accepted and ignored**, which is the difference that matters:
 * a field this accepts is a promise, and a promise about a level plan is one nothing here keeps.
 * Each is one line to add when the thing it names exists.
 *
 * ## And the one field this has that the reference does not
 *
 * **`entry`.** voxelscape's manifest names `scripts[]` and lets its runtime decide which one is
 * the program; `PlaceHost` is handed an explicit `entry` and refuses one that is not among the
 * place's files. Keeping that means the entry is stated in the artefact rather than inferred,
 * and that `/place:list` can say what a place runs without opening it.
 */

/** The file inside a zip that carries a place's manifest. */
export const PLACE_MANIFEST_FILE = "manifest.json";

/** The media type a place zip is written under, and what a file picker should accept. */
export const PLACE_MIME_TYPE = "application/zip";

/**
 * The most script files one place may name.
 *
 * **Sixty-four, and the number is the reference's.** Two places are close to useless — one
 * program that does everything, and one program per line — and the real cost is per-file, not
 * per-total: the bundler compiles each file with a real TypeScript `Program` (see `bundle.ts`),
 * so the limit is really a limit on how long `/place:open` takes.
 */
export const MAX_PLACE_FILES = 64;

/** The longest one script file name may be, and so the longest a path in the zip may be. */
export const MAX_PLACE_FILE_NAME = 256;

/** The longest a place's name may be. Matches `MAX_NAME_LENGTH` in spirit and not in value. */
export const MAX_PLACE_NAME = 256;

/**
 * How far a place's spawn may lie from the origin, in world units.
 *
 * The same number the reference uses, and for the same reason: a spawn is a `vec3` a person
 * typed or copied, and the furthest this engine's coordinate handling reaches is `MAX_COORDINATE`
 * (`limits.ts`). A spawn beyond it is not a distant place, it is a place that cannot be folded.
 */
export const MAX_PLACE_SPAWN = 1e7;

/** Where a place's player starts, in world units. The ground height is derived from the terrain. */
export type PlaceSpawn = readonly [number, number, number];

/**
 * What a place zip says about itself.
 *
 * A type rather than an interface with everything optional, so a manifest that has passed
 * `isPlaceManifest` is a manifest with all of these — the alternative is every reader carrying
 * a check for a case that is decided once, in the validator.
 */
export interface PlaceManifest {
  /** What the place is called, as it was typed, punctuation and all. */
  readonly name: string;
  /**
   * The terrain seed every peer generates the same world from.
   *
   * **A number rather than nothing, and this is the field that makes a place reproducible.** Two
   * peers loading this place must arrive at the same ground, and the seed is the whole of how
   * (ADR 0016). A place that omitted it would be a place whose world depends on whoever loaded
   * it, which is the one thing this repository is not prepared to ship.
   */
  readonly seed: number;
  /** Where the player starts. Absent means "the world's own surface at the origin". */
  readonly spawn?: PlaceSpawn;
  /** The file that runs, relative to the zip's root. Must be one of `scripts`. */
  readonly entry: string;
  /**
   * The script files in the zip, relative to its root.
   *
   * **Named rather than globbed.** The zip is scanned for `.ts` files in any case — a file the
   * manifest left out would still be read by the bundler if something imported it — but a
   * manifest that does not name its own program is one whose entry cannot be checked.
   */
  readonly scripts: readonly string[];
}

/**
 * Whether a value read out of `manifest.json` is a manifest this can open.
 *
 * **Every field is checked, and nothing is coerced.** A seed that arrived as `"123"` is refused
 * rather than parsed, because a manifest is written by a tool and a tool that writes a string
 * where a number belongs has a bug that would otherwise surface as a world that is subtly not
 * the one the place was authored for.
 *
 * An **unknown field is not refused**, and deliberately: the rule in ADR 0017 is that an
 * undeclared *payload* field on an effect is refused, because it is arriving at a place's effect
 * handler. A manifest is read once by this code and never reaches a place, so a field from a
 * future version of the format is inert here rather than dangerous — and refusing it would make
 * every added field a breaking change.
 */
export const isPlaceManifest = (value: unknown): value is PlaceManifest => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  if (typeof record.name !== "string") return false;
  if (record.name.length === 0 || record.name.length > MAX_PLACE_NAME)
    return false;

  if (typeof record.seed !== "number" || !Number.isFinite(record.seed)) {
    return false;
  }

  if (record.spawn !== undefined && !isSpawn(record.spawn)) return false;

  return isFileList(record.scripts) && isEntryOf(record.entry, record.scripts);
};

/** Whether a value is a spawn this engine can stand a player at. */
const isSpawn = (value: unknown): value is PlaceSpawn => {
  if (!Array.isArray(value) || value.length !== 3) return false;
  return value.every(
    (axis) =>
      typeof axis === "number" &&
      Number.isFinite(axis) &&
      Math.abs(axis) <= MAX_PLACE_SPAWN,
  );
};

/**
 * Whether `scripts` is a list of file names this engine will read.
 *
 * Distinct from the other two list checks in one specific way: **the names must be usable
 * paths**, checked by `isSafePathName`. A zip is untrusted input, and a name that walks out of
 * its own root is not a path this code should ever hand to a bundler that will compile whatever
 * it is told to.
 */
const isFileList = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_PLACE_FILES) return false;

  const seen = new Set<string>();
  for (const name of value) {
    if (typeof name !== "string") return false;
    if (!isSafePathName(name)) return false;
    // **Duplicates refused rather than collapsed.** Two names that are the same string are one
    // file, and which of the two the bundler reads would be decided by iteration order — so the
    // manifest would describe a place that does not exist.
    if (seen.has(name)) return false;
    seen.add(name);
  }
  return true;
};

/** Whether the entry is one of the files the place names. */
const isEntryOf = (entry: unknown, scripts: unknown): boolean =>
  typeof entry === "string" &&
  Array.isArray(scripts) &&
  scripts.includes(entry);

/**
 * Whether a name from a zip is a path this code will read.
 *
 * **Four rules, and every one is a zip that exists.** This is the whole of the path-traversal
 * defence, and it is a short list because the alternative — normalising the path and checking
 * the result — has to be right about symlinks, drive letters, NUL bytes, percent-encoding and
 * Unicode normalisation, all of which are somebody else's bug rather than this code's.
 *
 * - **No `..` in any segment.** The rule that matters, and the one a traversal is made of.
 * - **No absolute path.** A leading `/` is an absolute path here whatever produced it.
 * - **No backslash.** A zip written on Windows may use it, and this treats it as a separator so
 *   that `..\..\x` cannot slip past the segment check by arriving as one segment.
 * - **Nothing empty, and no `.` segment.** `src//main.ts` and `src/./main.ts` are the same file
 *   under two names, and a zip may hold both; the second would be silently unread.
 *
 * Nothing here limits a name to a known extension. A place's own files are `.ts` and the entry
 * is one of them, but a file the entry imports does not have to be — and a check that assumed
 * otherwise would refuse a valid place over a naming choice.
 */
export const isSafePathName = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_PLACE_FILE_NAME) return false;
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  // NUL is not a path character in any archive format this reads; a name holding one is either
  // corruption or an attempt to truncate a path in a C library downstream.
  if (name.includes("\0")) return false;

  const segments = name.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};
