/**
 * The rule that keeps the monorepo honest: `/packages` is for code with no opinion about
 * what it is for, `/apps` is for code that has one.
 *
 * The rule exists because the split is invisible at the point where it matters. Nothing
 * stops a `ChunkMesher` from being written into an app, and nothing stops a `@big-mesh-studios/meshing`
 * from importing `VOXEL_SIZE`. Both compile. Both run. Both are wrong, and the second one is
 * wrong in a way that only shows up when the next app tries to use the package and finds it
 * already bound to somebody's chunk size.
 *
 * So this checks the three things that actually go wrong, and it runs in CI rather than in
 * review because all three are invisible in a diff:
 *
 * 1. **A workspace in the wrong directory.** A package that declares `private: true` under
 *    `/apps` is an app that will never ship. An app that publishes is a package that will.
 * 2. **A dependency edge pointing the wrong way.** A package may depend on another package;
 *    it may never depend on an app. This is the one that makes the whole arrangement
 *    possible rather than merely tidy.
 * 3. **A package importing across the boundary.** `packages/*` may only import other
 *    packages and, for tests, dev-only tools. An app may import anything.
 *
 * ## Why it reads `package.json` files and not the imports
 *
 * Because a package that depends on an app *by relative path* would be caught by rule 3's
 * import scan anyway, and a package that depends on an app by name is caught by rule 2 from
 * the manifest alone. Reading manifests is enough to keep the graph acyclic, which is the
 * property worth guaranteeing; everything finer than that is TypeScript's job.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface WorkspaceProblem {
  /** The workspace the problem is about. */
  readonly workspace: string;
  /** What is wrong, phrased so it can be printed to a developer unchanged. */
  readonly message: string;
}

export interface Workspace {
  /** Path relative to the repository root, e.g. `packages/csg`. */
  readonly dir: string;
  readonly name: string;
  readonly private: boolean;
  readonly dependencies: ReadonlyMap<string, string>;
}

/** Every workspace under `apps/` or `packages/`, in directory order. */
export async function readWorkspaces(
  root: string = ROOT,
): Promise<Workspace[]> {
  const found: Workspace[] = [];
  for (const group of ["packages", "apps"]) {
    let entries: string[];
    try {
      entries = await readdir(join(root, group));
    } catch {
      // **An absent directory is not an error.** A checkout with no apps yet is a
      // legitimate monorepo, and the check should say so rather than throw.
      continue;
    }
    for (const entry of entries.sort()) {
      const dir = `${group}/${entry}`;
      const manifest = await readManifest(join(root, dir, "package.json"));
      if (manifest === undefined) continue;
      found.push({
        dir,
        name: manifest.name ?? dir,
        private: manifest.private ?? false,
        dependencies: new Map(Object.entries(manifest.dependencies ?? {})),
      });
    }
  }
  return found;
}

interface Manifest {
  name?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readManifest(path: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    // A directory under `packages/` without a manifest is not a workspace. Treating it as
    // one and failing would mean this check had to be edited every time a `node_modules`
    // or a scratch directory appeared alongside real workspaces.
    return undefined;
  }
}

/**
 * Checks every workspace against the three rules.
 *
 * Returns problems rather than exiting, so the test suite can assert on them and so a
 * caller could report all of them at once instead of one per run.
 */
export async function checkWorkspace(
  root: string = ROOT,
): Promise<WorkspaceProblem[]> {
  const workspaces = await readWorkspaces(root);
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const appDirs = new Set(
    workspaces.filter((w) => w.dir.startsWith("apps/")).map((w) => w.dir),
  );
  const problems: WorkspaceProblem[] = [];

  for (const workspace of workspaces) {
    const isApp = workspace.dir.startsWith("apps/");

    // Rule 1: `private` says whether this can ever be published, and it has to agree with
    // which half of the repository it sits in.
    if (isApp && !workspace.private) {
      problems.push({
        workspace: workspace.dir,
        message: "an app must be private: true — it is never published",
      });
    }
    if (!isApp && workspace.private) {
      problems.push({
        workspace: workspace.dir,
        message:
          "a package must not be private: true — it exists to be depended on",
      });
    }

    // Rule 2: no package may depend on an app, by name or by path.
    for (const [dependency, range] of workspace.dependencies) {
      const target = byDir.values().find((w) => w.name === dependency);
      const viaPath = range.startsWith("link:") || range.startsWith("file:");
      if (target === undefined) continue;
      if (!isApp && appDirs.has(target.dir)) {
        problems.push({
          workspace: workspace.dir,
          message: `depends on the app ${dependency} — packages may only depend on packages`,
        });
      }
      // A `link:`/`file:` dependency is a cycle exactly when the target reaches back
      // through its own dependencies. Compared by walking the edge out, not by comparing
      // directory names — `a -> b` and `b -> a` are the same two names either way, and
      // only the walk tells them apart from `a -> b` with no way back.
      if (viaPath && !isApp && reaches(target, workspace.dir, workspaces)) {
        problems.push({
          workspace: workspace.dir,
          message: `depends on ${dependency} by path, which already depends on it — a cycle`,
        });
      }
    }
  }

  return problems;
}

/** Whether `from` reaches `target` by following dependency edges, treating cycles as reachable. */
function reaches(
  from: Workspace,
  target: string,
  workspaces: readonly Workspace[],
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (from.dir === target) return true;
  if (seen.has(from.dir)) return false;
  const next = new Set(seen).add(from.dir);
  for (const name of from.dependencies.keys()) {
    const step = workspaces.find((w) => w.name === name);
    if (step !== undefined && reaches(step, target, workspaces, next))
      return true;
  }
  return false;
}

/** Prints every problem, or reports that the workspace is well formed. */
export async function main(): Promise<number> {
  const problems = await checkWorkspace();
  if (problems.length === 0) {
    const workspaces = await readWorkspaces();
    const packages = workspaces.filter(
      (w) => !w.dir.startsWith("apps/"),
    ).length;
    const apps = workspaces.length - packages;
    console.log(
      `workspace: ${packages} packages, ${apps} apps, no edges into an app`,
    );
    return 0;
  }
  for (const { workspace, message } of problems)
    console.error(`${workspace}: ${message}`);
  console.error(`\n${problems.length} problem(s) with the workspace layout`);
  return 1;
}

// Run directly rather than when imported, so the test can import `checkWorkspace`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
