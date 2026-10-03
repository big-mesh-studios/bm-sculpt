# 0028 — A colour is a property of the operation, and the model is a boolean fold

## Context

Two things were asked for and turned out to be the same piece of work.

The first was colour: props and NPCs must not be one colour. The second was a boolean on
each shape — union or difference, with a softness that switches to the soft version — which
is the "and no extrusion, and no revolution" line in ADR 0027 coming back with the one
subtraction it said was a single step away.

Both run through the same three lines: `Operation`, `Field`, and the mesher's `onVertex`.

## What already existed, which was most of it

**Colour was already a first-class part of the field.** `Operation` has `colour` and
`opacity`; the serialiser writes both; `OperationBVH.evalPaint` resolves a colour per point;
`Field.colourAt` reads it; `ChunkMeshBuilder` has a four-byte `colour` attribute and a
`setColour`; and `surfaceNets` has the `onVertex` hook the landscape uses to fill both normal
and colour per vertex.

That machinery is a faithful port of `randoms-3d-paint`, whose fold does
`if (sdf <= 1.0) colour = op.colour` and whose `paint()` **overwrites** rather than blends.
So "last writer wins" was not a choice to revisit — it was what the original did, and it is
the right answer for parts of a figure: a red sphere and a blue sphere overlapping should
stay red and blue rather than go purple.

## The one real gap

**A solid operation could not carry colour at all.** `applyOperation` makes `Paint` a
no-op on the distance — it returns the field untouched — and `evalPaint` skipped anything
that was not `combine === "Paint"`. So `Add` with a colour was solid and colourless, `Paint`
with a colour was coloured and invisible, and a model of coloured parts had nowhere to go.

### And the obvious fix was a full-terrain repaint

The natural repair — honour any operation that carries a colour — would have painted the
entire landscape with the brush colour, because **`brush.ts` wrote a colour onto every
operation** including `Add` and `Subtract`, with a comment saying the other modes ignored it.
They did ignore it. `host.ts` did the same for every `shape-add`.

So the change is only safe with **producer discipline**: a colour means something wherever it
is written, and therefore a producer writes one only where it means it.

### Which meant `makeOperation`'s default had to go

`makeOperation` defaulted `colour` to white, on the reasoning that "optional fields would
make every reader carry a check for a case decided once, here, by the combine mode." Under
the new rule that reasoning inverts: a default of white means **every `Add` in the model
paints**, and "no colour means no say in appearance" is not enforceable by anybody. The
absence is the default now, and the reader that cares checks for it — one check, in
`evalPaint`, which had to check anyway to reject a colourless `Paint`.

## Decision

### `combine` decides geometry, `colour` decides appearance

**`evalPaint` honours any operation with a colour.** Three consequences, each recorded
because each is a trap:

1. **The version went to 3.** Every operation this build wrote before version 3 carries a
   colour, and on the brush that produced it was the brush's current colour. The bytes all
   still parse; what changed is what they _mean_, which is the one thing a version byte
   cannot leave ambiguous. Version 2 files are refused rather than migrated.
2. **The brush writes a colour only in paint mode**, and so does `shape-add`. Two tests say
   so, one per producer, because the failure is silent and total rather than partial.
3. **`Paint` is no longer reachable from the modeller.** It adds no material and only
   colours, and a coloured `Add` now expresses it — so offering `Paint` would be a third
   option that does strictly less than `Add`.

### Opacity reaches a vertex, and `setColour` grew an argument

`ChunkMeshBuilder.vertex` pushes 255 for alpha and `setColour` wrote only three channels, so
opacity was carried in the file and read by nothing. **Alpha is now a separate argument with
a default of 255** rather than part of `Rgb8`: the packed vertex was always four bytes, and
widening the colour type would have made every colour in the repository four-wide to serve
one of them. `Field.colourAt` returns a `SurfaceColour` — a colour and an opacity — because a
function returning an `Rgb8` had to be asked a second time for the second half, which meant
walking the operation list twice per vertex.

A painted _tile_ is still opaque and says so: tiles store three bytes per sample and there
is nowhere in that layout for a fourth.

### A part carries its boolean, its softness and its colour

`Part` gained `combine`, `softness`, `colour?` and `opacity?`. `combine` is **required**, which
is the visible consequence of ADR 0027 being reversed:

**A union-only list folds the same however it is ordered, so a part's position was
bookkeeping. A list containing a subtraction does not.** `A`, `B`, then a difference of `C` is
a different solid from the same three parts in another order, and nothing recovers which was
meant. Making `combine` required is the cheapest way to keep that visible at every
construction site, and it is why `barePart` — a second name for `placedPart` — was deleted
rather than updated.

The soft operations needed no porting: `smoothMin` is behaviourally identical to the
original's polynomial smooth minimum and `smoothMax` derives from it as the original's soft
difference does.

### The model is meshed with real normals, which it was not before

`meshModel` passed **no `onVertex`**, so every vertex got the builder's `+Y` normal
placeholder and a white colour. The builder's own comment says that placeholder was chosen to
be "a real direction rather than an obvious sentinel" — which means a mesh built without an
`onVertex` shades as though it were right. That was the modeller's state before this phase.

### The picker is ported; the palette is new

The picker is rm-stacker's `ColorPicker.tsx` nearly unchanged, with `pointer` from
`packages/ui`, `HSVA`/`RGBA` from `core`, `--margin` renamed to `--ui-margin`, and the file
spelled `colour-picker.tsx` because this repository spells it that way everywhere else. Its
alpha slider would have been a control that visibly did nothing, which is why `setColour`
grew an argument in the same phase rather than the slider being dropped.

**The palette is the colours this model has used, and it is not in the sibling.** It is held
by the application rather than the panel, because a panel's memory dies with the panel — and
on a phone a width query tears the layout down on every rotation. It is capped at 32, dropping
the **oldest**, because refusing the newest would make a colour that happens to be the
hundredth unpickable, which is the one case where a cap is felt.

### Two panels on a phone cannot overlap if they are siblings

The transform panel grew down into the parts panel on a narrow screen, and the reason is
worth recording because it is not "the panels are too big": **two absolutely-positioned boxes
on opposite edges of a short screen have no relationship to each other at all.** Neither is
clipped, neither scrolls away, and no adjustment to either one helps, because nothing in CSS
is relating them.

So below 640px **the root becomes a flex column, the canvas is a child that flexes, and the
panels are siblings below it** — two siblings in a flex column cannot overlap, because the
column gives each a share of the height. One panel at a time, chosen by a tab bar, since two
side by side on a phone is neither of them. `min-height: 0` on the canvas and the panels is
load-bearing: a flex item's default `min-height: auto` refuses to shrink below its content,
so without it the canvas pushes the panels off the window instead of giving up height.

This is the arrangement `big-mesh-studios`'s voxelscape level editor already uses, and the
reason to copy an arrangement rather than invent one is that this class of bug does not
announce itself in review.

## Consequences

- **A model can now express colour, subtraction and blends**, which is what "props and NPCs
  are not one colour" required, and it required no new geometry.
- **The file format is version 3 and version 2 files are refused.** That is the price of the
  semantics changing under bytes that still parse, and it was paid deliberately rather than
  by hoping nobody had a saved model.
- **The landscape is unchanged in appearance and by construction**: the two producers that
  would have painted it are tested not to.
- **Transparency has no depth sorting.** The modeller's material sets `transparent` with
  `NormalBlending` and depth-write off, so interpenetrating translucent parts composite in
  submission order rather than back to front. That is wrong for a render and acceptable for a
  preview; sorting draw calls per frame is real work for a property the modeller is not trying
  to show off. The landscape's material still ends in `vec4(albedo, float(1))` and discards
  vertex alpha on purpose — terrain is opaque.
- **`Operation.colour` is now genuinely optional**, which is a wider change than it looks:
  every reader of it must now handle absence, and the one that matters is `evalPaint`.
- **Solid 2 batches signal writes until `flush()`,** so every test in this application that
  mutates state and reads it settles first. `createPalette.remember` composes through the
  setter's updater for the same reason: reading the signal and then assigning would compose
  against a stale value and the second colour remembered in one batch would replace the
  first.
- **The suite is 1560 passing with 3 expected failures**, from 1535: 20 colour tests in
  `core` (the sibling had none), 7 palette tests, and 4 in the modeller's meshing tests —
  one of which exists only to assert that no vertex is still the `+Y` placeholder.
