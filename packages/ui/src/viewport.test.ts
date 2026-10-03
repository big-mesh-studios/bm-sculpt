/**
 * Reads each `index.html` under `apps/` and asserts the `viewport` meta tag carries the tokens
 * the rest of this package's CSS depends on.
 *
 * ## Why a test reads HTML
 *
 * **Because the dependency runs one way and nothing checks it.** `baseline.css`
 * defines `--ui-safe-*` from `env(safe-area-inset-*)`, and those resolve to `0px`
 * unless the page's viewport meta tag says `viewport-fit=cover`. There is no CSS
 * feature query that can detect the tag's absence: the browser simply letterboxes
 * and hands back zeroes, so the rules compile, apply, match, and do nothing.
 *
 * That is not a hypothetical failure. In the sibling monorepo, one application sets
 * `env(safe-area-inset-bottom)`, `env(safe-area-inset-left)` and
 * `env(safe-area-inset-right)` on three separate selectors, and its `index.html` has
 * no `viewport-fit=cover` — **all three rules are dead, and the application has a
 * bottom sheet that a home indicator sits on top of.** Nothing reported it. The
 * declarations are correct; they are just never reached.
 *
 * So the assertion lives here, at the only place both halves are visible at once.
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APPS = fileURLToPath(new URL("../../../apps/", import.meta.url));

/** The `content` of the viewport meta tag, or null if there is not one. */
const viewportContent = async (html: string): Promise<string | null> => {
  const match = /<meta\s[^>]*name=["']viewport["'][^>]*>/i.exec(html);
  if (match === null) return null;
  const content = /content=["']([^"']*)["']/i.exec(match[0]);
  return content === null ? null : content[1];
};

describe("every application's viewport", () => {
  it("declares a viewport meta tag", async () => {
    const apps = await readdir(APPS, { withFileTypes: true });
    const html = apps.filter((entry) => entry.isDirectory());
    expect(
      html.length,
      "no apps found — has the layout changed?",
    ).toBeGreaterThan(0);
    for (const app of html) {
      const file = join(APPS, app.name, "index.html");
      const source = await readFile(file, "utf8").catch(() => null);
      expect(source, `${app.name}/index.html is missing`).not.toBeNull();
      expect(await viewportContent(source!), app.name).not.toBeNull();
    }
  });

  it("carries viewport-fit=cover, or the safe-area rules in the baseline are dead", async () => {
    // The pairing, asserted in the one place both halves can be seen. If an
    // application ever decides it wants letterboxing instead, this is the test to
    // delete — and deleting it should be a decision, not an oversight.
    for (const app of await readdir(APPS, { withFileTypes: true })) {
      if (!app.isDirectory()) continue;
      const file = join(APPS, app.name, "index.html");
      const source = await readFile(file, "utf8").catch(() => null);
      if (source === null) continue;
      expect(
        await viewportContent(source),
        `${app.name} has no viewport-fit=cover, so --ui-safe-* resolves to 0px`,
      ).toContain("viewport-fit=cover");
    }
  });

  it("does not disable zoom unless the baseline raises its input font size", async () => {
    // `maximum-scale=1, user-scalable=no` is how the sibling's 3D editors rule out
    // iOS zooming the page when a small-font input takes focus. This repository's
    // applications are **deliberately zoomable**, so the baseline has to handle it
    // with `font-size: 16px` on inputs under a coarse pointer instead.
    //
    // The two are alternatives, not a menu: an application that pins
    // `maximum-scale=1` without needing to is overriding a user's accessibility
    // setting for no gain, and one that stays zoomable without the 16px rule zooms the
    // page in on its own command line.
    const baseline = await readFile(
      fileURLToPath(new URL("./baseline.css", import.meta.url)),
      "utf8",
    );
    const baselineZoomsSafely = /font-size:\s*16px/.test(baseline);
    expect(baselineZoomsSafely, "baseline.css lost its 16px input rule").toBe(
      true,
    );

    for (const app of await readdir(APPS, { withFileTypes: true })) {
      if (!app.isDirectory()) continue;
      const source = await readFile(
        join(APPS, app.name, "index.html"),
        "utf8",
      ).catch(() => null);
      if (source === null) continue;
      const content = (await viewportContent(source)) ?? "";
      const pinsZoom =
        /maximum-scale\s*=\s*1(?!\.)/.test(content) ||
        /user-scalable\s*=\s*no/.test(content);
      if (pinsZoom) {
        // Allowed, but only if the baseline still has the rule — so removing the rule
        // and keeping the pin is what fails here, not the reverse.
        expect(baselineZoomsSafely, app.name).toBe(true);
      }
    }
  });
});
