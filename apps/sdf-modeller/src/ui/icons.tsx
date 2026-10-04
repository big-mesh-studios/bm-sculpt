/**
 * The glyphs the interface draws, as inline vector art.
 *
 * ## Why inline SVG rather than an icon font or a sprite sheet
 *
 * **Because a glyph that takes `currentColor` needs no second request and no second colour.**
 * A button's icon that does not follow the button's text colour — because it is in a font with
 * its own palette, or in a sheet with a fixed one — is a thing that has to be corrected in every
 * state the button has. `stroke="currentColor"` makes that correction impossible to get wrong,
 * because there is nothing to correct.
 *
 * The sibling draws the same way for the same reason (`apps/bm-sculpt/src/console/icons.tsx`),
 * and this is that file with the glyphs this application needs.
 *
 * ## The shared setup
 *
 * **A 24-unit grid, 2-wide round strokes, no fill.** One set of attributes on the `<svg>` rather
 * than on every path, so a glyph is its shape and nothing else — which is what makes a new one a
 * single function rather than a dozen decorated elements.
 */
import type { JSX } from "@solidjs/web/jsx-runtime";

/**
 * The shared stroke setup: a 24-unit grid, drawn in the button's own colour.
 *
 * **`width`/`height` of 24 and they are not decoration.** An `<svg>` with a `viewBox` and
 * no `width`/`height` attributes has an intrinsic *ratio* but no intrinsic *size*, so a
 * stylesheet asking for `width: 100%` inside an `auto`-width box is asking for nothing in
 * particular and the browser falls back to the replaced-element default of 300×150 — which
 * is how a 24-unit glyph ends up drawn 300px wide over the buttons beside it. The
 * attributes give every glyph a size of its own, so it is the right size wherever it is
 * dropped, and a stylesheet that does want it bigger still wins over them.
 */
const stroke: JSX.SvgSVGAttributes<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  width: 24,
  height: 24,
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
};

/** Two strokes crossing, for starting over. */
export const PlusIcon = () => (
  <svg {...stroke}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** A folder with its front pulled down, for opening what is on disk. */
export const FolderOpenIcon = () => (
  <svg {...stroke}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
    <path d="M3 9h18l-2 9a2 2 0 0 1-2 1H5a2 2 0 0 1-2-1z" />
  </svg>
);

/** A floppy disk, for a document that came from a file. */
export const FloppyIcon = () => (
  <svg {...stroke}>
    <path d="M5 3h11l3 3v15H5z" />
    <path d="M8 3v6h8V3" />
    <path d="M8 14h8v7H8z" />
  </svg>
);

/** A wireframe box, for a solid rather than a document — the 3D print export. */
export const CubeIcon = () => (
  <svg {...stroke}>
    <path d="M12 2 3 7v10l9 5 9-5V7z" />
    <path d="M3 7l9 5 9-5" />
    <path d="M12 12v10" />
  </svg>
);

/** Two strokes crossing, for closing and for forgetting. */
export const CrossIcon = () => (
  <svg {...stroke}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** A lid and a body, for forgetting a file. The file itself is untouched. */
export const TrashIcon = () => (
  <svg {...stroke}>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M10 11v6M14 11v6" />
  </svg>
);

/** A grid of squares, for a list of files. */
export const GridIcon = () => (
  <svg {...stroke}>
    <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
  </svg>
);

/** Every glyph this application has, so a caller can name one rather than import it. */
export const ICONS = {
  plus: PlusIcon,
  folderOpen: FolderOpenIcon,
  floppy: FloppyIcon,
  cube: CubeIcon,
  cross: CrossIcon,
  trash: TrashIcon,
  grid: GridIcon,
} as const;

export type IconKind = keyof typeof ICONS;

/** One glyph, by name. */
export const Icon = (props: { kind: IconKind }) => {
  const Glyph = ICONS[props.kind];
  return <Glyph />;
};
