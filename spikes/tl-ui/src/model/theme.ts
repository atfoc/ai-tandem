// The board's theme (goal 3.2, 7.2, 4.10): tldraw 5.6's theme registry carries the palette and the fonts. Colours added to
// the theme become values of tldraw's own `DefaultColorStyle` (`registerColorsFromThemes` adds them when the editor is
// made), so "set the colour of the selection" and "the colour of the next shape" work for stickies and shapes alike with
// tldraw's own machinery. The window and the board host must register the same theme (they share this file), or a record
// with a colour one side does not know fails validation there.
//
// The light palette is what is stored and exported; the dark one is a copy (the dark theme is out of scope, goal 5).
import { DEFAULT_THEME, type TLDefaultColor, type TLTheme } from "tldraw";

/** The sticky palette, Miro-like: 16 colours. Keys are the stored colour names (agent terms use the same names). Where a
 *  name is also one of tldraw's 13, only its sticky fill changes; the others are new colours. */
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

/** The new colour names, and the tldraw colour each one takes its shape variants (stroke, fill, frame...) from. */
const NEW_COLORS = {
  "light-yellow": "yellow",
  "dark-green": "green",
  cyan: "light-blue",
  "light-pink": "light-red",
  pink: "light-red",
  "dark-blue": "blue",
} as const;

declare module "tldraw" {
  interface TLThemeDefaultColors {
    "light-yellow": TLDefaultColor;
    "dark-green": TLDefaultColor;
    cyan: TLDefaultColor;
    "light-pink": TLDefaultColor;
    pink: TLDefaultColor;
    "dark-blue": TLDefaultColor;
  }
}

type Palette = TLTheme["colors"]["light"];

function withStickies(base: Palette): Palette {
  const out: Record<string, unknown> = { ...base };
  for (const [name, from] of Object.entries(NEW_COLORS)) out[name] = { ...(base as any)[from] };
  for (const [name, hex] of Object.entries(STICKY_COLORS)) {
    const c = out[name] as TLDefaultColor;
    out[name] = { ...c, noteFill: hex, noteText: name === "black" ? "#ffffff" : "#1a1a1a" };
  }
  return out as Palette;
}

/** The theme, registered under tldraw's `default` id (so nothing has to pick it). Fonts: tldraw's own (E in spike-ui.md);
 *  a Miro-like sans would be a change of `fonts.sans` here and of the files beside the bundle. */
export const AIWB_THEME: TLTheme = {
  ...DEFAULT_THEME,
  colors: {
    light: withStickies(DEFAULT_THEME.colors.light),
    dark: withStickies(DEFAULT_THEME.colors.dark),
  },
};

export const THEMES = { default: AIWB_THEME };
