# 0029 — The site root is a front page, and the applications sit beside it

## Context

The site publishes two applications from one GitHub Pages branch, and until now it had no
front page at all. `bm-sculpt` was published _at_ the site root and `sdf-modeller` in a
subdirectory of its own, and the workflow said why:

> The landscape stays at the root so its existing URL keeps working.

That was the right arrangement when the root was the only page worth arriving at. There was
one application to open and it was already open.

It stops being right the moment there are two. A reader who follows a link to the site now
lands in the landscape, which is a perfectly good page that says nothing about the existence
of the modeller sitting one directory away. The modeller was discoverable only by somebody
who already knew it existed — which is not what a front page is for, and not what a public
address is either.

The sibling repository solves this with a front page of its own, and its shape is worth
copying rather than reinventing: one prerendered file, two dependencies, a card per
application. Three things about it are _not_ worth copying, and the reasons are recorded
below rather than left as an unexamined port.

## Decision

### One Pages site, a front page at the root, the applications as siblings

```
/bm-sculpt/                the front page
/bm-sculpt/bm-sculpt/      the landscape
/bm-sculpt/sdf-modeller/   the modeller
```

Still one site rather than three. The alternative is a Pages site per application, which
would let each be deployed and rolled back independently; what argues against it here is
that the applications share six packages and a file format, and a reader following a link
from a model's documentation to the model itself should not have to cross a hostname.

**If the modeller grows client-side routing, or the applications need independent deploys,
this is the line to move.**

### The front page is a file, not an application

**`apps/homepage` is prerendered at build time to a single `dist/index.html` with no
JavaScript in it.** Solid compiles the markup on the server, the stylesheet is inlined, and
the document is written out.

The page holds no state and answers no events. A client-rendered application here would ship
a bundle whose only work was to produce markup already known at build time, and would
produce _no_ markup until it had downloaded and run. For the one page whose entire job is to
be a set of links, that is the wrong failure mode: a reader on a bad connection, or with a
script blocker, would get a blank page instead of two links.

The stylesheet is inlined rather than linked because a second request is the entire cost
being argued about, and the links are in the first byte the browser reads.

**"Ships no JavaScript" is enforced by the build.** `scripts/prerender.ts` throws if the
rendered body contains a `<script`. A reason is worth nothing unless something checks it: a
stray client-side effect would quietly add a bundle and quietly undo the decision, with a
green build and nothing in review to notice.

### Its links are relative, where the sibling's are absolute

**Every address on the front page is `./<folder>/`, and its Vite config has no `base` at
all.**

The sibling's front page hardcodes `base: "/big-mesh-studios/"` and builds its addresses
from `import.meta.env.BASE_URL`. That is correct there. It is also one more value that has
to be right, and one more that differs between the local build and the deployed one.

Both of _our_ applications are already built with `base: "./"`, for a reason recorded in the
deploy workflow: so that the same `dist` is correct served from `/bm-sculpt/`, from any
other subdirectory, and from a static server at the root of a checkout. The front page
follows that rule rather than making an exception of itself. `./sdf-modeller/` is right in
all three of those places and needs nothing configured to say so.

**This also means the front page must be published at the root.** Its links are relative, so
they resolve against whatever directory the page was served from — a front page published at
`/front-page/` would link to `/front-page/sdf-modeller/` and 404, with a green build,
because both files would be exactly where the workflow put them. A test asserts the copy
step, for that reason.

### The list of applications is data, and the data is checked

**`apps/homepage/src/apps.ts` holds the list; `tools/homepage.test.ts` compares its `path`
fields against the directories actually in `apps/`.**

The page and the site are described in two files — the card list and the collect step in the
deploy workflow — and nothing made them agree. Adding an application means touching both,
and forgetting the second produces a card that leads to a 404 while the build stays green.

That is not hypothetical. The sibling repository has to edit its front page and its workflow
in the same commit to add or retire an application, and its page metadata still describes
two applications after one was retired, because nothing checks a hand-written list against
the directories beside it.

The list imports nothing — not even Solid — because the test loads it from Node, and a
module that pulled in the framework would need the JSX transform to be read at all. `href`
is derived from `path` rather than written, so a link and a folder name cannot disagree.

## Consequences

**The landscape's address changes.** `/bm-sculpt/` becomes the front page and the landscape
moves to `/bm-sculpt/bm-sculpt/`.

This is the cost, and it is cheaper than it sounds: the old address becomes the front page,
which links straight to the landscape, so a bookmark or a link already in the wild arrives
somewhere useful and one tap from where it was going rather than at a 404. Nothing in this
repository referenced the live address, so nothing here has to be edited — but a person who
has bookmarked it will be one tap from where they were.

**Moving an application one directory deeper is the only behavioural change to a shipped
application.** Relative bases are supposed to make that a non-event, and the meshing workers
— emitted as URLs resolved against the importing module — are the one thing that could
plausibly notice. It is worth one look at the live site after the first deploy.

**The drift guard is a substring search, not a YAML parse.** `homepage.test.ts` checks that
the workflow contains `cp -r apps/<name>/dist/. dist/<name>/` as text. Reformatting the
workflow can therefore break it. That is the trade made on purpose: a test that failed
because a comment mentioned a path in a different way would be a test that got turned off.

**Adding an application is now two edits plus a green build**, not two edits and a hope. The
test fails if the card list and the directory listing disagree.

**The front page has no `dev` script to speak of**, only `node scripts/prerender.ts &&
vite preview`. It is one file with no assets, so there is nothing to hot-reload and a
rebuild is instant. The sibling's front page has no working local server at all — it has no
`index.html` for Vite to serve and no root `dev:homepage` script — which is a small thing to
copy and an easy one not to.

## Alternatives

### A second Pages site per application

Rejected. It would let each be deployed and rolled back independently, which is a real
advantage, and it costs a hostname crossing on every link between the landscape and the
models it serves. The two share six packages and a file format; they are one project.

### The landscape stays at the root and the front page goes in a subdirectory

Rejected, and this is the arrangement being replaced. Nothing breaks — which is its only
merit — but there is no front page at the root, so a reader arriving at the address has to
know to visit `/front-page/` to discover that there is anything to discover. It is a front
page that cannot be found.

### The landscape published at both the root and its own folder

Rejected. It does break nothing _and_ leaves a front page at the root, which sounds like the
best of both. The cost is shipping two copies of a large WebAssembly bundle, maintaining two
addresses for one application, and leaving a question — which is the real one — that has no
good answer.

### A client-rendered Solid application, built like the other two

Rejected, and it was the closest call. It would share every bit of existing configuration and
add no build machinery at all, which is a real argument. Against it: a bundle for a page that
does nothing, and a blank page until it arrives. The prerender is thirty lines and the
failure mode it avoids is the one that matters most on the page.

### Astro, as the sibling's front page originally was

Rejected. The sibling's own history has this: it was built with Astro, and rewritten to Solid
fifteen minutes later because Astro's Solid renderer imports `solid-js/store` and
`solid-js/web`, which do not exist in Solid 2, and no Solid 2 renderer is published. This
repository already builds Solid directly, so the question does not arise.

### Generating the card list and the copy step from one source

Rejected. It would be genuinely drift-free, and it puts a build step in charge of describing
the shape of the deploy workflow — where a mistake publishes the wrong tree. Two hand-edited
lines plus a test that fails when they disagree is the arrangement that fails loudly.
