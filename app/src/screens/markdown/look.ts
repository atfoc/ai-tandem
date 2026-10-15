// How a message's text looks where it is drawn: the size of its text, its colour, and whether it is a user's (a user's
// message has its own code and mention colours). No React Native here; look.tsx holds the context.
export type Look = {
  /** The body text's size in points (styles.css gives the thread's text 13). Headings, code and tables scale with it. */
  size: number;
  /** The colour of the text. */
  color: string;
  /** A user's message: single line breaks are kept and @mentions link to boards. */
  user: boolean;
};

/** A "#rrggbb" or "#rgb" colour with an alpha (color-mix(in srgb, c a%, transparent) of the page). */
export function alpha(colour: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour);
  if (!m) return colour;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${a})`;
}

/** Headings' sizes of styles.css `.md h1 … h6` at the page's 13 px, as a share of the body size. */
export const HEADING = [16, 15, 14, 13, 13, 13].map((px) => px / 13);
