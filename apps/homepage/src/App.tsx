/**
 * The whole of the front page: what this is, and where to go next.
 *
 * ## Why there is no `import.meta.env.BASE_URL` in this file
 *
 * **Because every address on this page is relative, and a relative address is already
 * correct.** The sibling repository's front page reads `BASE_URL` and hardcodes
 * `base: "/big-mesh-studios/"`; that is right there and would be one more thing to keep in
 * step here for nothing. If a `base` is ever added to this app's Vite config, nothing on
 * this page will notice — which is the intended behaviour, and the reason the cards take
 * their address from `apps.ts` and not from the environment.
 *
 * ## Why the whole card is the link
 *
 * **Because a card with a link inside it has a small target and a large non-target.** The
 * panel is the button, so the entire area is reachable, there is no nested-interactive
 * problem to solve, and the focus ring is drawn around the thing that is actually
 * activatable.
 */
import type { JSX } from "@solidjs/web/jsx-runtime";

import { APPS, hrefFor, REPOSITORY, type AppEntry } from "./apps";

/**
 * The faces of a solid seen from a corner, drawn in the colour the card is keyed to.
 *
 * **A path can carry more than one face**, so a solid of more than one box is a path with
 * subpaths in it rather than a second component. The shading is three opacities of one
 * colour rather than three colours, which is what lets a card's accent be written down
 * once and still look like a lit solid.
 */
function Mark(props: {
  colour: string;
  top: string;
  left: string;
  right: string;
}) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path d={props.top} fill={props.colour} />
      <path d={props.left} fill={props.colour} opacity="0.72" />
      <path d={props.right} fill={props.colour} opacity="0.45" />
    </svg>
  );
}

/** One application, as a panel that links to it. */
function AppCard(props: { app: AppEntry; mark: JSX.Element }) {
  const { app } = props;
  return (
    <a class="card" href={hrefFor(app)} style={{ "--accent": app.accent }}>
      {props.mark}
      <h2>{app.name}</h2>
      {/*
        **The workspace directory, in monospace, under the title.**
        *
        It is the one thing on the card that a reader cannot use and an author cannot do
        without, because it is both the address this link points at and the directory in this
        repository that the address is built from. Showing it makes a card that looks broken
        ("where does this go?") instead look explained.
      */}
      <p class="path">{app.path}</p>
      <p class="blurb">{app.blurb}</p>
      <span class="call">{app.call}</span>
    </a>
  );
}

/** The page. */
export function App() {
  return (
    <>
      <header>
        <h1>bm-sculpt</h1>
        <p>
          One signed distance field core, two ways into it: a world to walk
          through, and a modeller to build what the world wears.
        </p>
      </header>

      <main>
        {/*
          **An array, keyed by the folder name**, rather than one hand-written element per
          application. Both of those are edited by hand; this one is at least *checked*,
          because `apps.ts` is compared against the directories in `apps/` by a test.
        */}
        {APPS.map((app) => (
          <AppCard
            app={app}
            mark={
              app.path === "bm-sculpt" ? (
                // **Terraced ground**, for the landscape: two stacked slabs.
                <Mark
                  colour={app.accent}
                  top="M24 4 40 12 24 20 8 12Z M24 20 40 28 24 36 8 28Z"
                  left="M8 12 24 20v8L8 20Z M8 28 24 36v8L8 36Z"
                  right="M40 12 24 20v8l16-8Z M40 28 24 36v8l16-8Z"
                />
              ) : (
                // **A single primitive**, for the modeller: one box, which is the atom
                // everything in that application is an arrangement of.
                <Mark
                  colour={app.accent}
                  top="M24 8 42 18 24 28 6 18Z"
                  left="M6 18v12l18 10V28Z"
                  right="M42 18v12L24 40V28Z"
                />
              )
            }
          />
        ))}
      </main>

      <footer>
        <p>
          Open source, in one repository:{" "}
          <a href={REPOSITORY}>github.com/big-mesh-studios/bm-sculpt</a>.
        </p>
        <p>
          The design decisions are written down as{" "}
          <a href="https://github.com/big-mesh-studios/bm-sculpt/tree/main/docs/adr">
            architecture decision records
          </a>
          , including why this page is a file rather than an application.
        </p>
      </footer>
    </>
  );
}
