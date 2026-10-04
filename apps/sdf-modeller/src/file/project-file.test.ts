import { describe, expect, it } from "vitest";

import { MAX_PARTS } from "../model/model-store";
import { PALETTE_LIMIT } from "../ui/palette";
import { MESH_MODES, RESOLUTIONS } from "../model/mesh-model";
import {
  isProjectManifest,
  MAX_MANIFEST_COLOURS,
  MAX_MANIFEST_PARTS,
  MAX_PART_ID,
  PROJECT_VERSION,
  projectName,
} from "./project-file";

/** A manifest with nothing in it that is nevertheless valid. */
const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: PROJECT_VERSION,
  ids: ["body"],
  coloured: [],
  palette: [],
  view: { mode: "surface-nets", resolution: 0.25 },
  ...overrides,
});

const colour = { r: 1, g: 2, b: 3, a: 4 };

describe("isProjectManifest", () => {
  it("opens a manifest this build wrote", () => {
    expect(isProjectManifest(manifest())).toBe(true);
  });

  it("refuses a version it does not know rather than reading it at this one's widths", () => {
    // **The same rule `deserialiseOperations` follows.** A manifest is fixed-width in the same
    // way the binary is, and reading a later one at this version's field positions produces
    // plausible values in plausible places.
    expect(isProjectManifest(manifest({ version: PROJECT_VERSION + 1 }))).toBe(
      false,
    );
    expect(isProjectManifest(manifest({ version: 0 }))).toBe(false);
  });

  it("refuses anything that is not an object", () => {
    for (const value of [null, undefined, 3, "manifest", [], true]) {
      expect(isProjectManifest(value)).toBe(false);
    }
  });

  describe("ids", () => {
    it("accepts an empty model, which is a thing a person can save", () => {
      // **Not refused.** An empty list means a model with no parts, which is a legitimate state
      // and the store's own initial one; refusing it would make "New" unsaveable.
      expect(isProjectManifest(manifest({ ids: [] }))).toBe(true);
    });

    it("refuses two parts with one id between them", () => {
      // **Refused rather than collapsed.** Two ids that are the same string are one part as far
      // as a selection is concerned, and `store.load` refuses these too — the manifest is the
      // earlier of the two checks, and this is the message a person gets.
      expect(isProjectManifest(manifest({ ids: ["a", "b", "a"] }))).toBe(false);
    });

    it("refuses an empty id", () => {
      expect(isProjectManifest(manifest({ ids: [""] }))).toBe(false);
    });

    it("refuses an id with whitespace at either end rather than trimming it", () => {
      // **A trimmed id is a different id.** The parts list would show one and the file would
      // hold another, and nothing downstream would notice.
      expect(isProjectManifest(manifest({ ids: [" arm"] }))).toBe(false);
      expect(isProjectManifest(manifest({ ids: ["arm "] }))).toBe(false);
    });

    it("refuses an id too long to show", () => {
      expect(
        isProjectManifest(manifest({ ids: ["a".repeat(MAX_PART_ID)] })),
      ).toBe(true);
      expect(
        isProjectManifest(manifest({ ids: ["a".repeat(MAX_PART_ID + 1)] })),
      ).toBe(false);
    });

    it("refuses more parts than the store would hold", () => {
      const many = Array.from({ length: MAX_PARTS + 1 }, (_, i) => `p${i}`);
      expect(isProjectManifest(manifest({ ids: many }))).toBe(false);
    });
  });

  describe("coloured", () => {
    it("accepts an empty list, which is a model where no part has a colour", () => {
      expect(isProjectManifest(manifest({ coloured: [] }))).toBe(true);
    });

    it("accepts positions in order", () => {
      expect(
        isProjectManifest(manifest({ ids: ["a", "b", "c"], coloured: [0, 2] })),
      ).toBe(true);
    });

    it("refuses a position naming a part that is not there", () => {
      // **The cross-field check, and the only one here.** This is a manifest whose model and
      // whose parts disagree, and the loader would otherwise colour a part that does not exist
      // or refuse a file that is fine.
      expect(isProjectManifest(manifest({ ids: ["a"], coloured: [1] }))).toBe(
        false,
      );
      expect(
        isProjectManifest(manifest({ ids: ["a", "b"], coloured: [2] })),
      ).toBe(false);
    });

    it("refuses a position out of range at either end", () => {
      expect(isProjectManifest(manifest({ coloured: [-1] }))).toBe(false);
    });

    it("refuses positions out of order", () => {
      // **The writer emits them in order**, so a list that is not ordered came from something
      // else — and a duplicated position is one part claiming to be coloured twice, which would
      // make the loader's own answer depend on which of the two it read last.
      expect(
        isProjectManifest(manifest({ ids: ["a", "b"], coloured: [1, 0] })),
      ).toBe(false);
      expect(
        isProjectManifest(manifest({ ids: ["a", "b"], coloured: [0, 0] })),
      ).toBe(false);
    });

    it("refuses a position that is not a whole number", () => {
      expect(isProjectManifest(manifest({ coloured: [0.5] }))).toBe(false);
    });
  });

  describe("palette", () => {
    it("accepts an empty palette", () => {
      expect(isProjectManifest(manifest({ palette: [] }))).toBe(true);
    });

    it("accepts whole channels within the eight bits", () => {
      expect(isProjectManifest(manifest({ palette: [colour] }))).toBe(true);
      expect(
        isProjectManifest(manifest({ palette: [{ r: 0, g: 0, b: 0, a: 0 }] })),
      ).toBe(true);
    });

    it("refuses a channel outside the eight bits rather than clamping it", () => {
      // **Clamped rather than refused** would give a file a colour that is not the one it names.
      for (const channel of [-1, 256, 1.5]) {
        expect(
          isProjectManifest(manifest({ palette: [{ ...colour, r: channel }] })),
        ).toBe(false);
      }
    });

    it("refuses a colour missing a channel", () => {
      expect(
        isProjectManifest(manifest({ palette: [{ r: 1, g: 2, b: 3 }] })),
      ).toBe(false);
    });

    it("refuses a colour that is not an object", () => {
      expect(isProjectManifest(manifest({ palette: ["#010203"] }))).toBe(false);
    });

    it("refuses more colours than the panel would show", () => {
      const many = Array.from(
        { length: MAX_MANIFEST_COLOURS + 1 },
        () => colour,
      );
      expect(isProjectManifest(manifest({ palette: many }))).toBe(false);
    });
  });

  describe("view", () => {
    it("accepts every mesher this application offers", () => {
      for (const mode of MESH_MODES) {
        expect(
          isProjectManifest(
            manifest({ view: { mode: mode.value, resolution: 0.25 } }),
          ),
        ).toBe(true);
      }
    });

    it("refuses a mesher this application does not have", () => {
      expect(
        isProjectManifest(
          manifest({ view: { mode: "marching-tetrahedra", resolution: 0.25 } }),
        ),
      ).toBe(false);
    });

    it("refuses a resolution that is not one of the offered sizes", () => {
      // **Not a range check.** `RESOLUTIONS` is a union type precisely so a control's value
      // cannot be a size the mesher was never measured at, and a manifest that could name `0.3`
      // would put one back through the back door.
      expect(
        isProjectManifest(
          manifest({ view: { mode: "surface-nets", resolution: 0.3 } }),
        ),
      ).toBe(false);
      expect(
        isProjectManifest(
          manifest({ view: { mode: "surface-nets", resolution: 0 } }),
        ),
      ).toBe(false);
      expect(
        isProjectManifest(
          manifest({ view: { mode: "surface-nets", resolution: "0.25" } }),
        ),
      ).toBe(false);
    });

    it("refuses a view that is not there at all", () => {
      // **Required, not defaulted.** The mesher decides what geometry the model is built from,
      // so a file that did not say would be opening a model at somebody else's resolution and
      // calling it the one that was saved.
      expect(isProjectManifest(manifest({ view: undefined }))).toBe(false);
    });
  });

  it("tolerates a field it does not know", () => {
    // **The reason ADR 0017 gives.** A manifest is read once by this code and never reaches
    // anywhere that could act on it, so a field from a future version is inert rather than
    // dangerous — and refusing it would make every added field a breaking change.
    expect(isProjectManifest(manifest({ camera: { radius: 12 } }))).toBe(true);
  });

  it("names its own bounds after the ones it duplicates", () => {
    // **The three numbers this file writes down rather than imports**, and the reason it writes
    // them down: `../model/model-store` drags in the meshing package and `../ui/palette` imports
    // a stylesheet, and a validator for a file's contents is not the place to pull either in to
    // read a number. Duplication is only safe while something checks it, and this is that.
    expect(MAX_MANIFEST_PARTS).toBe(MAX_PARTS);
    expect(MAX_MANIFEST_COLOURS).toBe(PALETTE_LIMIT);
  });

  it("offers exactly the resolutions the viewport offers", () => {
    const accepted = [0.5, 0.25, 0.125, 0.0625].filter((resolution) =>
      isProjectManifest(
        manifest({ view: { mode: "surface-nets", resolution } }),
      ),
    );

    expect(accepted).toEqual([...RESOLUTIONS]);
  });
});

describe("projectName", () => {
  it("drops the extension so a title is not a file name", () => {
    expect(projectName("my monster.sdfmod")).toBe("my monster");
  });

  it("leaves a name without the extension alone", () => {
    expect(projectName("my monster")).toBe("my monster");
    expect(projectName("my monster.zip")).toBe("my monster.zip");
  });
});
