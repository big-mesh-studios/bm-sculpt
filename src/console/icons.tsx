// The glyphs the console's buttons draw in their centres, as inline vector art
// so they take the button's own foreground colour and need no image request.
import type { JSX } from "@solidjs/web/jsx-runtime";

/** The shared stroke setup: a 24-unit grid, drawn in the button's colour. */
const stroke: JSX.SvgSVGAttributes<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "2",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** Four corners pulled apart, for entering and leaving fullscreen. */
export function FullscreenIcon() {
  return (
    <svg {...stroke}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
