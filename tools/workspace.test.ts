import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkWorkspace, readWorkspaces } from "./workspace";

/**
 * Tests for the workspace check, on synthetic workspaces rather than this one.
 *
 * **Against this repository's own layout the check has nothing to prove**, because a green
 * check on the layout you just wrote by hand is the least interesting possible result. The
 * failures have to be manufactured to know they are caught.
 */

const layout = async (files: Record<string, unknown>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bm-workspace-"));
  for (const [path, manifest] of Object.entries(files)) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), JSON.stringify(manifest));
  }
  return root;
};

describe("the workspace layout", () => {
  it("accepts a package depending on a package", async () => {
    const root = await layout({
      "packages/core": { name: "@b/core", dependencies: {} },
      "packages/csg": {
        name: "@b/csg",
        dependencies: { "@b/core": "workspace:*" },
      },
    });
    expect(await checkWorkspace(root)).toEqual([]);
  });

  it("refuses a package that depends on an app", async () => {
    const root = await layout({
      "packages/csg": {
        name: "@b/csg",
        dependencies: { "@b/app": "workspace:*" },
      },
      "apps/app": { name: "@b/app", private: true, dependencies: {} },
    });
    const problems = await checkWorkspace(root);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/packages may only depend on packages/);
  });

  it("allows an app to depend on packages", async () => {
    const root = await layout({
      "packages/core": { name: "@b/core", dependencies: {} },
      "apps/app": {
        name: "@b/app",
        private: true,
        dependencies: { "@b/core": "workspace:*" },
      },
    });
    expect(await checkWorkspace(root)).toEqual([]);
  });

  it("refuses an app that could be published", async () => {
    const root = await layout({
      "apps/app": { name: "@b/app", dependencies: {} },
    });
    const problems = await checkWorkspace(root);
    expect(problems[0].message).toMatch(/private: true/);
  });

  it("refuses a package marked private, which cannot be depended on", async () => {
    const root = await layout({
      "packages/core": { name: "@b/core", private: true },
    });
    expect((await checkWorkspace(root))[0].message).toMatch(
      /must not be private/,
    );
  });

  it("refuses two packages that depend on each other by path", async () => {
    const root = await layout({
      "packages/a": { name: "@b/a", dependencies: { "@b/b": "file:../b" } },
      "packages/b": { name: "@b/b", dependencies: { "@b/a": "file:../a" } },
    });
    expect((await checkWorkspace(root)).map((p) => p.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/cycle/)]),
    );
  });

  it("allows a one-way path dependency, which is not a cycle", async () => {
    const root = await layout({
      "packages/a": { name: "@b/a", dependencies: { "@b/b": "file:../b" } },
      "packages/b": { name: "@b/b", dependencies: {} },
    });
    expect(await checkWorkspace(root)).toEqual([]);
  });

  it("says nothing about a directory that has no manifest", async () => {
    const root = await layout({ "packages/core": { name: "@b/core" } });
    await mkdir(join(root, "packages/node_modules"), { recursive: true });
    expect((await readWorkspaces(root)).map((w) => w.dir)).toEqual([
      "packages/core",
    ]);
  });

  it("accepts an empty repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "bm-workspace-empty-"));
    expect(await checkWorkspace(root)).toEqual([]);
  });
});

describe("this repository's own layout", () => {
  it("has no problems", async () => {
    expect(await checkWorkspace()).toEqual([]);
  });
});
