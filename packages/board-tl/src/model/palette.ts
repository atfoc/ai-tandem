// Our names → what is stored in tldraw records, and back (design 7.2, goal 4.10).
//
// What is stored never depends on the theme: a record keeps a colour *name* (tldraw's own style values for inks, our sticky
// names for the sticky); the theme only decides how a name is drawn. Every mapping between the agent's names and stored
// values is in the tables of this file, so `apply.ts` (writing) and `read.ts` (reading) cannot disagree, and the tables can be
// aligned with the sticky's style prop (T1b) in one place.
//
// Pure data and functions: no tldraw runtime import, so it loads anywhere.

import type { Align, Arrowhead, Color, ShapeKind, Size, StickyColor } from "./terms.ts";

/** The placeholder type name of our sticky shape until T1b defines it. tldraw's `note` is read as a sticky too. */
export const STICKY_TYPE = "aiwb-sticky";
/** tldraw's own sticky, also read as a sticky (its colour is one of tldraw's inks). */
export const NOTE_TYPE = "note";

/** tldraw's default colour style values (tlschema `DefaultColorStyle`). */
export type TlColor =
  | "black" | "grey" | "light-violet" | "violet" | "blue" | "light-blue" | "yellow" | "orange" | "green" | "light-green"
  | "light-red" | "red" | "white";

/**
 * Inks: the colour of text, connectors, pens, frames, a shape's border and fill. Stored in tldraw's `color` style (and, for a
 * shape's fill, in the fill colour prop below), as tldraw's colour name.
 */
export const INK: Record<Color, TlColor> = {
  black: "black",
  grey: "grey",
  white: "white",
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  "light-green": "light-green",
  blue: "blue",
  "light-blue": "light-blue",
  violet: "violet",
  pink: "light-red",
};

/** Stored inks that are no agent name, read as the nearest one. */
const INK_EXTRA: Partial<Record<string, Color>> = { "light-violet": "violet" };

/**
 * Sticky colours. `stored` is the value of our sticky's colour prop (our own name, so the sticky's palette is ours, not the
 * theme's); `note` is the closest tldraw ink, for tldraw's `note` shape; `hex` is the note's fill as drawn (a proposal until
 * the sticky's look is settled, S-UI).
 */
export const STICKY: Record<StickyColor, { stored: string; note: TlColor; hex: string }> = {
  yellow: { stored: "yellow", note: "yellow", hex: "#fff176" },
  "light-yellow": { stored: "light-yellow", note: "yellow", hex: "#fff9b1" },
  orange: { stored: "orange", note: "orange", hex: "#ffc06e" },
  red: { stored: "red", note: "red", hex: "#ff8a80" },
  pink: { stored: "pink", note: "light-red", hex: "#f8bbd9" },
  violet: { stored: "violet", note: "violet", hex: "#d4b8f0" },
  blue: { stored: "blue", note: "blue", hex: "#8fb8f5" },
  "light-blue": { stored: "light-blue", note: "light-blue", hex: "#c6e4fb" },
  green: { stored: "green", note: "green", hex: "#9be29b" },
  "light-green": { stored: "light-green", note: "light-green", hex: "#d5f6c8" },
  grey: { stored: "grey", note: "grey", hex: "#e0e0e0" },
  white: { stored: "white", note: "white", hex: "#ffffff" },
};

/** A new sticky's colour when the agent names none. */
export const DEFAULT_STICKY: StickyColor = "yellow";

export const INK_NAMES = Object.keys(INK) as Color[];
export const STICKY_NAMES = Object.keys(STICKY) as StickyColor[];

export function inkToStored(c: Color): TlColor {
  return INK[c];
}

/** A stored ink → our name. An unknown value reads as black (tldraw's default). */
export function inkFromStored(v: unknown): Color {
  if (typeof v !== "string") return "black";
  for (const name of INK_NAMES) if (INK[name] === v) return name;
  return INK_EXTRA[v] ?? "black";
}

/** The stored colour of a sticky of the given record type. */
export function stickyToStored(c: StickyColor, recordType: string = STICKY_TYPE): string {
  return recordType === NOTE_TYPE ? STICKY[c].note : STICKY[c].stored;
}

/** A stored sticky colour → our name. A `note`'s tldraw ink maps to the first sticky colour drawn with it. */
export function stickyFromStored(v: unknown, recordType: string = STICKY_TYPE): StickyColor {
  if (typeof v !== "string") return DEFAULT_STICKY;
  if (recordType === NOTE_TYPE) {
    for (const name of STICKY_NAMES) if (STICKY[name].note === v) return name;
    if (v === "light-violet") return "violet";
    if (v === "black") return "grey";
    return DEFAULT_STICKY;
  }
  for (const name of STICKY_NAMES) if (STICKY[name].stored === v) return name;
  return DEFAULT_STICKY;
}

// ---- Other stored values the agent's names map onto (one table each) ----

/**
 * Our shape's own props (goal 7.2: our styles are style props). Until T1b defines them, `read.ts` falls back to tldraw's: the
 * fill colour to the border colour (`color`), the border width to `size`.
 */
export const FILL_COLOR_PROP = "fillColor";
export const BORDER_WIDTH_PROP = "borderWidth";

/** Shape kinds ↔ tldraw `geo` values. `rounded` is a geo value our schema adds (T1b); tldraw has no rounded rectangle. */
export const SHAPE_GEO: Record<ShapeKind, string> = {
  rectangle: "rectangle",
  rounded: "rounded",
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
};

export function shapeFromGeo(geo: unknown): ShapeKind | undefined {
  for (const k of Object.keys(SHAPE_GEO) as ShapeKind[]) if (SHAPE_GEO[k] === geo) return k;
  return undefined;
}

/** A filled shape's tldraw `fill` style (a fill colour of its own is the prop above). */
export const FILL_STYLE = "solid";

/** Arrowheads ↔ tldraw's. tldraw has more; they read as the nearest of ours. */
export const ARROWHEAD: Record<Arrowhead, string> = {
  none: "none",
  arrow: "arrow",
  triangle: "triangle",
  dot: "dot",
  diamond: "diamond",
  bar: "bar",
};
const ARROWHEAD_EXTRA: Partial<Record<string, Arrowhead>> = { square: "diamond", pipe: "bar", inverted: "triangle" };

export function arrowheadFromStored(v: unknown, fallback: Arrowhead): Arrowhead {
  for (const k of Object.keys(ARROWHEAD) as Arrowhead[]) if (ARROWHEAD[k] === v) return k;
  return (typeof v === "string" && ARROWHEAD_EXTRA[v]) || fallback;
}

export type Dash = "solid" | "dashed" | "dotted";
/** Dashes ↔ tldraw's `dash` style. tldraw's hand-drawn `draw` and `none` read as solid. */
export const DASH: Record<Dash, string> = { solid: "solid", dashed: "dashed", dotted: "dotted" };

export function dashFromStored(v: unknown): Dash {
  return v === "dashed" || v === "dotted" ? v : "solid";
}

/** tldraw's horizontal align has legacy values; they read as their plain one. */
export function alignFromStored(v: unknown, fallback: Align): Align {
  if (typeof v !== "string") return fallback;
  const base = v.replace(/-legacy$/, "");
  return base === "start" || base === "middle" || base === "end" ? base : fallback;
}

export const SIZES: Size[] = ["s", "m", "l", "xl"];

export function sizeFromStored(v: unknown): Size {
  return SIZES.includes(v as Size) ? (v as Size) : "m";
}

/** tldraw's font sizes (theme `fontSize` 16 × its multipliers): labels of stickies and shapes, and free text. */
export const BASE_FONT_SIZE = 16;
export const LINE_HEIGHT = 1.35;
export const LABEL_FONT_SIZES: Record<Size, number> = { s: 1.125, m: 1.375, l: 1.625, xl: 2 };
export const TEXT_FONT_SIZES: Record<Size, number> = { s: 1.125, m: 1.5, l: 2.25, xl: 2.75 };
/** A sticky's side when it was not resized (tldraw's note). */
export const STICKY_SIZE = 200;
