// The sticky palette (goal 3.2, 7.2, 4.10): a tldraw style prop of our own, `aiwb:sticky-color`, with 16 Miro-like colours.
// A style prop, so tldraw's "set the style of the selection" and "the style of the next shape" work with it: a new
// sticky gets the colour last used (goal 3.2) with no code of ours. It is its own prop, not tldraw's `DefaultColorStyle`,
// because tldraw keeps one "next" value per style prop: with the shared colour, choosing a sticky colour would also colour
// the next rectangle, arrow and text (and the first sticky would be tldraw's default black).
//
// (tldraw 5.6 can also add colour names to `DefaultColorStyle` through its theme registry — `themes` prop,
// `registerColorsFromThemes` — which is the way to give shapes a Miro-like palette; spike-ui.md.)
//
// The stored value is the name; the window and the board host map it to the same hex here. Theme-independent (4.10).
import { StyleProp } from "tldraw";

export const STICKY_COLORS = {
  "light-yellow": "#fff9b1",
  yellow: "#f5d128",
  orange: "#ff9d48",
  "light-green": "#d5f692",
  green: "#c9df56",
  "dark-green": "#93d275",
  cyan: "#67c6c0",
  "light-pink": "#ffcee0",
  pink: "#ea94bb",
  violet: "#c6a2d2",
  "light-red": "#f0939d",
  "light-blue": "#a6ccf5",
  blue: "#6cd8fa",
  "dark-blue": "#9ea9ff",
  grey: "#e6e6e6",
  black: "#1a1a1a",
} as const;

export type StickyColor = keyof typeof STICKY_COLORS;
export const STICKY_COLOR_NAMES = Object.keys(STICKY_COLORS) as StickyColor[];
export const DEFAULT_STICKY_COLOR: StickyColor = "light-yellow";

export const StickyColorStyle = StyleProp.defineEnum("aiwb:sticky-color", {
  defaultValue: DEFAULT_STICKY_COLOR,
  values: STICKY_COLOR_NAMES,
});

/** The text colour on a sticky of colour `c`. */
export const stickyTextColor = (c: StickyColor) => (c === "black" ? "#ffffff" : "#1a1a1a");
