/**
 * The applications this site serves, as data rather than as markup.
 *
 * ## Why this is a separate file, and why it imports nothing
 *
 * **Two reasons, and the second is the one that matters.**
 *
 * The first is that a link is the one thing on this page that can be wrong in a way nobody
 * would notice until somebody clicked it. Written as attributes scattered through JSX it
 * would be a name and a path in two places that have to agree; here they are one field.
 *
 * The second is that this file is read by a test. `tools/homepage.test.ts` imports it and
 * compares `path` against the directories actually in `apps/`, so adding an application and
 * forgetting to list it here fails the build rather than shipping a front page with no card
 * for it. **That is not hypothetical:** the sibling repository has to edit its page and its
 * deploy workflow in the same commit to add or retire an application, and its page metadata
 * still describes a set of applications it no longer has.
 *
 * **No imports, deliberately — not even Solid.** The test loads this from Node, and a module
 * that pulled in the framework would need the JSX transform to be read at all. Plain data
 * is plain data.
 *
 * ## Why `href` is derived rather than written
 *
 * **Because a path and a folder name cannot then disagree.** Every application here is
 * published into a folder named after its workspace, which is what makes
 * `./sdf-modeller/` correct without anyone having to remember it.
 *
 * ## Why relative addresses rather than absolute ones
 *
 * **Because the same `dist` then works wherever it is served from.** The site is at
 * `/bm-sculpt/`, a contributor may serve the built site from a static server at the root of
 * a checkout, and a fork is at a different path again — and `./sdf-modeller/` is right in
 * all three, where a hardcoded `/bm-sculpt/sdf-modeller/` is right in exactly one. Both of
 * the applications are built with `base: "./"` for this same reason; the front page follows
 * the rule rather than making an exception of itself.
 */

/** One application, as the front page knows it. */
export interface AppEntry {
  /**
   * What to call it.
   *
   * **Not the folder name, though the folder name is shown beside it.** The reader of a
   * front page wants to know what a thing is; "bm-sculpt" is what the repository calls it,
   * which is a different question and is answered on the card in a monospace line under the
   * title.
   */
  readonly name: string;
  /** The workspace directory, which is also the folder it is published into. */
  readonly path: string;
  /**
   * The one saturated colour on the card: its hover border, its focus ring and its call to
   * action. Everything else on the page is grey.
   */
  readonly accent: string;
  /** The imperative on the button, with the arrow added in CSS. */
  readonly call: string;
  /** One sentence on what the application is for. */
  readonly blurb: string;
}

/**
 * Every application, in the order they are shown.
 *
 * **Order is source order, because there are two of them and a reader arriving at a front
 * page is deciding where to go.** The one you are most likely to want is first.
 */
export const APPS: readonly AppEntry[] = [
  {
    name: "Landscape",
    path: "bm-sculpt",
    accent: "#6abe30",
    call: "Enter the landscape",
    blurb:
      "An endless signed distance field to walk through and cut into. Paint it, script it, and save places that anybody can open.",
  },
  {
    name: "Figure Modeller",
    path: "sdf-modeller",
    accent: "#9a6ae8",
    call: "Open the modeller",
    blurb:
      "Build a figure out of placed primitives. Union them, subtract from them, colour them, and move them with the handles.",
  },
];

/**
 * Where an application is, from this page.
 *
 * **`./` and a trailing slash, both of them load-bearing.** Without the leading dot the
 * address would be root-relative and would stop working the moment the site moved; without
 * the trailing slash a server would be asked to redirect to add one, and GitHub Pages does
 * not always.
 */
export const hrefFor = (app: AppEntry): string => `./${app.path}/`;

/** The repository, which is the one address on this page that leaves the site. */
export const REPOSITORY = "https://github.com/big-mesh-studios/bm-sculpt";
