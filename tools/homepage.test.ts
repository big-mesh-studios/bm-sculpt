/**
 * The front page's list of applications, against the applications that exist.
 *
 * ## Why this test exists at all
 *
 * **Because the page and the site are described in two files and nothing makes them agree.**
 * `apps/homepage/src/apps.ts` says what the front page links to, and the collect step in
 * `.github/workflows/gh-pages.yml` says what gets published. Adding an application means
 * touching both, and forgetting the second produces a card that leads to a 404 while the
 * build stays green.
 *
 * This is not a hypothetical failure mode. The sibling repository has to edit its front page
 * and its deploy workflow in the same commit to add or retire an application, and its page
 * metadata still describes two applications after one was retired — because nothing checks
 * a hand-written list against the directories beside it.
 *
 * ## What is checked, and what is not
 *
 * **The names are checked against the filesystem; the copy commands are checked as text.**
 * The first is the one that actually drifts, and the filesystem is the authority. The second
 * is a substring search rather than a YAML parse, which is deliberate: a test that failed
 * because a comment mentioned a path in a different way would be a test that got turned off.
 * The cost of that looseness is that reformatting the workflow can break it, which is the
 * trade this test makes on purpose.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { APPS, hrefFor } from "../apps/homepage/src/apps";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every directory under `apps/` that is a workspace, minus the front page itself. */
const applicationDirectories = async (): Promise<string[]> => {
  const entries = await readdir(join(ROOT, "apps"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== "homepage")
    .sort();
};

describe("the front page's list of applications", () => {
  it("names every application in apps/, and no others", async () => {
    const listed = APPS.map((app) => app.path).sort();
    expect(listed, "a card does not match a directory in apps/").toEqual(
      await applicationDirectories(),
    );
  });

  it("links each one to the folder it is published into", async () => {
    // The link is derived rather than written, so this is really a check that the derivation
    // is the one the deploy step implements: `./apps/bm-sculpt/dist/.` becomes
    // `dist/bm-sculpt/`, and a card that pointed anywhere else would 404.
    for (const app of APPS) {
      expect(hrefFor(app)).toBe(`./${app.path}/`);
      expect(
        hrefFor(app).startsWith("./"),
        `${app.path} is linked absolutely and would stop working if the site moved`,
      ).toBe(true);
    }
  });

  it("has something to say about each one, and a distinct colour", () => {
    // A card with no blurb is a title and a link, which is a worse front page than no front
    // page. Two cards sharing an accent are one card in two colours.
    const accents = new Set<string>();
    for (const app of APPS) {
      expect(app.name.trim(), `${app.path} has no name`).not.toBe("");
      expect(app.blurb.trim(), `${app.path} has no blurb`).not.toBe("");
      expect(app.call.trim(), `${app.path} has no call to action`).not.toBe("");
      expect(app.accent, `${app.path} has no accent`).toMatch(
        /^#[0-9a-f]{6}$/i,
      );
      expect(
        accents.has(app.accent.toLowerCase()),
        `${app.path} shares its accent with another card`,
      ).toBe(false);
      accents.add(app.accent.toLowerCase());
    }
  });
});

describe("the deploy workflow", () => {
  it("publishes each listed application into the folder its card links to", async () => {
    const workflow = await readFile(
      join(ROOT, ".github/workflows/gh-pages.yml"),
      "utf8",
    );
    for (const app of APPS) {
      expect(
        workflow.includes(`cp -r apps/${app.path}/dist/. dist/${app.path}/`),
        `the workflow does not copy apps/${app.path} into dist/${app.path}`,
      ).toBe(true);
    }
  });

  it("publishes the front page at the root, which is what its links assume", async () => {
    // **Relative links only work from the root.** `./bm-sculpt/` resolves against whatever
    // directory the page was served from, so a front page published at `/front-page/` would
    // link to `/front-page/bm-sculpt/` and 404 — with a green build, because both files
    // would be exactly where the workflow put them.
    const workflow = await readFile(
      join(ROOT, ".github/workflows/gh-pages.yml"),
      "utf8",
    );
    expect(workflow).toContain("cp -r apps/homepage/dist/. dist/");
  });
});
