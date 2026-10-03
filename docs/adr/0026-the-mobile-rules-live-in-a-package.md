# 0026 — The mobile rules live in a package, because they were never this application's

## Context

The second application is a figure modeller, and it is going to be built on a phone
because the first one is. `sdf-modeller` has a canvas, drag handles, a parts list and a
toolbar — every one of which has a documented mobile failure mode, and none of which this
repository has written down in a place the second application would find.

What `apps/bm-sculpt` actually had, measured rather than assumed:

|                                               | before                                                      |
| --------------------------------------------- | ----------------------------------------------------------- |
| `viewport-fit=cover`                          | already correct                                             |
| `-webkit-text-size-adjust: 100%`              | already present                                             |
| `touch-action`                                | on the canvas and the console, correctly placed             |
| `overscroll-behavior`                         | **absent**                                                  |
| `safe-area-inset-*`                           | **absent**                                                  |
| `(pointer: coarse)` / `(any-pointer: coarse)` | **absent — no hover substitution, no finger-sized targets** |
| tap-highlight suppression                     | **absent**                                                  |
| `16px` on inputs under a coarse pointer       | **absent**                                                  |

Three of those are not omissions in the sense of "we would have liked to". **They are bugs
in the shipped application:**

1. **The command line zooms the page in and does not come back.** `console.module.css`
   declared `font: 12px monospace` on the only text input in the application. iOS Safari
   zooms the _page_ when an input under 16px takes focus and does not reliably zoom back
   out on blur. This application is **deliberately zoomable** — its viewport tag is
   `initial-scale=1` with no `maximum-scale` — so unlike the sibling monorepo's 3D editors
   it cannot rule the zoom out with `user-scalable=no`. It has to make the font big enough
   that the browser has no reason to zoom.
2. **A pull towards the top of the page starts pull-to-refresh in the middle of an orbit.**
   No `touch-action` on any element stops this, because the gesture belongs to the
   document and not to the canvas.
3. **The header's first line sits under the notch.** It is pinned to `top: 0` and the
   viewport tag already asked for `viewport-fit=cover`, so the browser was already handing
   out the inset and nothing asked for it.

The third one has a lesson attached, and it is why this is a package and not a fix.

## Decision

**`packages/ui` holds the mobile rules, and it holds them as plain CSS with no classes on
it — plus four small Solid primitives.**

### The packaging rule: no CSS modules in a package

**A CSS module's class names are hashed per build and scoped to the file that declared
them, so they cannot travel.** This is not a preference; the sibling monorepo's own design
record names it as the one thing that made a component extraction cost more than it saved:
"the editor's `PopOver` hardcodes `class={[props.class, styles.popover]}` against its own
CSS module, which cannot travel into a package — that class becomes one the caller passes."

So `baseline.css` is entirely custom properties and unclassed rules, with **one** class
(`ui-bottom-bar`) where the `max()` arithmetic is the fiddly part and three applications
would otherwise each reach for it and one would forget. Anything with a class in it stays
in the application that draws it.

**The green build was checked against the built CSS, not trusted.** "The build succeeded"
says nothing about whether a stylesheet reached the output, and a stylesheet that silently
did not is exactly the failure this package exists to prevent — the rules would compile,
the tokens would be undefined, and `max(1.25rem, var(--ui-safe-top, 0px))` would degrade to
the fallback. So `overscroll-behavior`, both `env(safe-area-inset-*)`, `any-pointer: coarse`,
`font-size: 16px` and the console's own 16px override were each counted in
`dist/assets/*.css` rather than assumed.

### The four declarations that were worth having

- **`overscroll-behavior: none` on `*`.** The single highest-value line in the file, and
  the one no element-level rule can replace.
- **`font-size: 16px` on inputs under `any-pointer: coarse`.** Not a style; the fix for the
  zoom bug above, and the reason the baseline and the viewport tag are tested against each
  other.
- **`--ui-size` raised to 44px under `any-pointer: coarse`, in `:root`.** The sibling
  monorepo repeats the 44px figure in three separate component files before working out
  that it belongs on the token. One media query, and every control measured in the token
  gets it.
- **`--ui-safe-*` from `env(safe-area-inset-*, 0px)`, the two-argument form.** The
  fallback matters: `env()` with one argument makes the whole declaration invalid where it
  is unsupported, taking the fallback with it.

### Four Solid primitives, and which of them are wired

`pointer`, `create-mediaQuery`, `combineRefs` and `Activity`. **Only `baseline.css` has an
in-repo consumer today**, and the record should say that plainly rather than imply four
adoptions. `combineRefs` and `Activity` are what the modeller's canvas and panels need;
`pointer` is below.

### `pointer()` fixed two bugs it inherited, and the orbit camera does not use it

Both of these are the kind that arrive silently:

- **An aborted drag never released the pointer capture.** The cleanup path removed the
  listeners but not the capture, and did not remove the entry from the module-level pointer
  map. A capture held for a dead pointer keeps receiving that pointer's later events, so
  the _next_ drag on that element would start already owned, and the pointer count would
  never return to zero. Both halves now go through one `release()`, because releasing only
  one leaks the other.
- **An aborted drag left its promise pending forever.** A component unmounting mid-gesture
  is exactly the caller left waiting on a promise that could not settle. An abort now
  resolves with the drag as it last stood — and does _not_ call the callback, because a
  cancelled drag moved nothing and a delta handed to an unmounted component is a delta
  applied to nothing.

**`controls/orbit-camera.ts` does not adopt `pointer()`, and this is a decision rather than
an oversight.** It already uses `PointerEvent` with `setPointerCapture` and handles
`pointercancel`, and it keeps its own map of pointer ids to **element-local** positions —
because a pinch needs the spread between two fingers measured in the canvas's own
coordinates, and `pointer()` hands back client coordinates and follows exactly one pointer
per call. Swapping it would replace a correct multi-touch implementation with a
single-pointer one that has to be bent. **The primitive is for the modeller's single-pointer
drags, and it is not a universal pointer layer.**

### The test that reads HTML

**`viewport.test.ts` reads every `apps/*/index.html` and asserts `viewport-fit=cover`.**
The dependency runs one way and nothing checked it: the baseline defines `--ui-safe-*` from
`env()`, and those resolve to `0px` unless the page asked for `viewport-fit=cover`. There is
no CSS feature query that can detect the tag's absence — the browser letterboxes and hands
back zeroes, so the rules compile, apply, match, and do nothing.

**This is not hypothetical.** In the sibling monorepo, one application sets
`env(safe-area-inset-bottom)`, `env(safe-area-inset-left)` and `env(safe-area-inset-right)`
on three separate selectors, and its `index.html` has no `viewport-fit=cover`. All three
rules are dead, and that application has a bottom sheet with a home indicator sitting on
top of it. Nothing reported it, because the declarations are correct.

The same file asserts the other pairing: an application may pin `maximum-scale=1,
user-scalable=no` only while the baseline still carries the 16px rule, so losing the rule
and keeping the pin is what fails.

## Consequences

- **Three shipped mobile bugs are fixed**, and two of them were only visible because the
  rules were gathered in one place and read against the page's actual viewport tag.
- **`packages/ui` ships no CSS module and no component**, which is the constraint that makes
  it usable by an application that has not been written yet. The cost is that a reusable
  _panel_ cannot be shared, only a reusable _rule_ — and that is the trade the sibling's
  record already made once.
- **The coarse-pointer rules are one media query on `:root`**, so an application that
  overrides `--ui-size` for its own density gets the finger-sized version for free and one
  that does not still gets it from the baseline.
- **The package has no `build` script and its `exports` point at `src`**, like every other
  package here. **The baseline reaches an application as a JavaScript import, not a CSS
  `@import`, and that was found by the build rather than by reading.** A CSS `@import` of a
  bare specifier is resolved by PostCSS, which looks for a _file_ at that path and has no
  idea a workspace package exists: the build fails with
  `ENOENT ... '@big-mesh-studios/ui/baseline.css'`. The same specifier in an `import` in
  `index.tsx` goes through Vite's own resolver, which reads the package's `exports` and so
  finds the source. Ordering — baseline before the application's own CSS, so the
  application's rules win at equal specificity — is therefore set by the order of two
  JavaScript imports, which is a less obvious place to look for it than a line in the
  stylesheet.
- **`prefers-reduced-motion` is honoured**, which neither of the sibling's editors does.
  It is the one rule in the file with no precedent to copy, and it is there because an
  application that transitions anyway is overriding a setting the user made about their own
  body. The animation is named rather than blanket-disabled, because a blanket
  `transition: none !important` also stops the state change from appearing at all.
- **The pointer count is the whole of the multi-touch mechanism.** There is no
  `TouchEvent` in this package and no `touches[]`, because a `touchmove` has three lists
  and choosing between them is a per-handler judgement that is wrong somewhere in every
  large codebase. `pointerId` filtering is what keeps a second finger's events from moving
  or ending a first finger's drag.
- **The suite gains 27 tests in four files and loses none.** `packages/ui` is 4 files, 3 of
  them tests, because the two things worth testing here are the capture-and-release
  lifecycle and the fact that a media-query listener does not outlive its component.
