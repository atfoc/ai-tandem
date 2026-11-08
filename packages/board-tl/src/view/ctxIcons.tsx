// The context bar's icons: inline SVG (no network, no icon font), 20×20, drawn in the current colour.
import type { ReactNode } from "react";

const svg = (body: ReactNode, fill = false) => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill={fill ? "currentColor" : "none"} stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{body}</svg>
);

export const ICON = {
  chevron: <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 3.5l3 3 3-3" /></svg>,
  // shape types
  rectangle: svg(<rect x="3" y="5" width="14" height="10" />),
  "rounded-rectangle": svg(<rect x="3" y="5" width="14" height="10" rx="3.5" />),
  ellipse: svg(<ellipse cx="10" cy="10" rx="7" ry="5.5" />),
  triangle: svg(<path d="M10 3.5l7 12.5H3z" />),
  diamond: svg(<path d="M10 2.5l7.5 7.5-7.5 7.5L2.5 10z" />),
  // text
  text: svg(<><path d="M3.5 15l4-10 4 10M5 11.5h5" /><path d="M12.5 15v-3.2a2 2 0 0 1 4 0V15M12.5 13.4h4" /></>),
  start: svg(<path d="M3 5h14M3 10h9M3 15h12" />),
  middle: svg(<path d="M3 5h14M5.5 10h9M4 15h12" />),
  end: svg(<path d="M3 5h14M8 10h9M5 15h12" />),
  bold: svg(<path d="M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z" strokeWidth="2.2" />),
  // lines
  line: svg(<path d="M3 15L17 5" />),
  straight: svg(<path d="M3 15L17 5" />),
  curved: svg(<path d="M3 15C6 5 12 4 17 5" />),
  elbow: svg(<path d="M3 15h7V5h7" />),
  solid: svg(<path d="M2.5 10h15" />),
  dashed: svg(<path d="M2.5 10h15" strokeDasharray="3.5 2.5" strokeLinecap="butt" />),
  dotted: svg(<path d="M3 10h14" strokeDasharray="0.1 3.2" strokeWidth="2.2" />),
  // arrowheads (drawn at the right end of a line)
  ends: svg(<><path d="M3 10h13" /><path d="M12 6l4.5 4-4.5 4" /></>),
  head_none: svg(<path d="M3 10h14" />),
  head_arrow: svg(<><path d="M3 10h13" /><path d="M12 6l4.5 4-4.5 4" /></>),
  head_triangle: svg(<><path d="M3 10h9" /><path d="M11 5.5l6 4.5-6 4.5z" fill="currentColor" /></>),
  head_dot: svg(<><path d="M3 10h10" /><circle cx="14" cy="10" r="3" fill="currentColor" /></>),
  head_diamond: svg(<><path d="M3 10h7" /><path d="M13.5 6.5L17 10l-3.5 3.5L10 10z" fill="currentColor" /></>),
  head_bar: svg(<><path d="M3 10h13.5" /><path d="M16.5 5.5v9" /></>),
  // arrange
  more: svg(<><circle cx="5" cy="10" r="1.3" fill="currentColor" stroke="none" /><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" /><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none" /></>),
  front: svg(<><rect x="3" y="3" width="9" height="9" strokeDasharray="2 2" /><rect x="8" y="8" width="9" height="9" fill="currentColor" /></>),
  back: svg(<><rect x="8" y="8" width="9" height="9" strokeDasharray="2 2" /><rect x="3" y="3" width="9" height="9" fill="currentColor" /></>),
  left: svg(<><path d="M3 3v14" /><rect x="6" y="5" width="9" height="3.5" /><rect x="6" y="11.5" width="5" height="3.5" /></>),
  "center-horizontal": svg(<><path d="M10 3v14" /><rect x="4.5" y="5" width="11" height="3.5" /><rect x="7" y="11.5" width="6" height="3.5" /></>),
  right: svg(<><path d="M17 3v14" /><rect x="5" y="5" width="9" height="3.5" /><rect x="9" y="11.5" width="5" height="3.5" /></>),
  top: svg(<><path d="M3 3h14" /><rect x="5" y="6" width="3.5" height="9" /><rect x="11.5" y="6" width="3.5" height="5" /></>),
  "center-vertical": svg(<><path d="M3 10h14" /><rect x="5" y="4.5" width="3.5" height="11" /><rect x="11.5" y="7" width="3.5" height="6" /></>),
  bottom: svg(<><path d="M3 17h14" /><rect x="5" y="5" width="3.5" height="9" /><rect x="11.5" y="9" width="3.5" height="5" /></>),
  distributeH: svg(<><path d="M3 3v14M17 3v14" /><rect x="7.5" y="6" width="5" height="8" /></>),
  distributeV: svg(<><path d="M3 3h14M3 17h14" /><rect x="6" y="7.5" width="8" height="5" /></>),
  // always
  duplicate: svg(<><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M13 4.5V4.2A1.2 1.2 0 0 0 11.8 3H4.2A1.2 1.2 0 0 0 3 4.2v7.6A1.2 1.2 0 0 0 4.2 13h.3" /></>),
  lock: svg(<><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" /></>),
  unlock: svg(<><rect x="4" y="9" width="12" height="8" rx="1.5" /><path d="M6.5 9V6.5a3.5 3.5 0 0 1 6.8-1.2" /></>),
  delete: svg(<><path d="M3.5 5.5h13M8 5.5V3.8h4v1.7M5 5.5l.8 11h8.4l.8-11M8.3 8.5v5M11.7 8.5v5" /></>),
} satisfies Record<string, ReactNode>;

/** A line of a width (the line width choices). */
export function widthIcon(px: number) {
  return svg(<path d="M3 10h14" strokeWidth={px} strokeLinecap="butt" />);
}
