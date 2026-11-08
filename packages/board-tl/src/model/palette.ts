// Our names → what is stored in tldraw records, and back (design 7.2, goal 4.10).
//
// What is stored never depends on the theme: a record keeps a colour *name* (tldraw's own style values for inks, our sticky
// names for the sticky); the theme only decides how a name is drawn. Every mapping between the agent's names and stored
// values is in the tables of this file, so `apply.ts` (writing) and `read.ts` (reading) cannot disagree; the style props of
// `styles.ts` and the sticky's util take their names and hexes from here.
//
// Pure data and functions: no tldraw runtime import, so it loads anywhere.

import type { Align, Arrowhead, Color, ShapeKind, Size, StickyColor } from "./terms.ts";

/** The type name of our sticky shape (`shapes/sticky.tsx`). tldraw's `note` is read as a sticky too. */
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
 * Sticky colours: Miro's 16 (decisions.md, window lane). `stored` is the value of our sticky's colour prop (`aiwb:sticky-color`,
 * our own names, so the sticky's palette is ours, not the theme's); `note` is the closest tldraw ink, for tldraw's `note`
 * shape; `hex` is the sticky's fill as drawn (the same in every theme, goal 4.10).
 */
export const STICKY: Record<StickyColor, { stored: string; note: TlColor; hex: string }> = {
  "light-yellow": { stored: "light-yellow", note: "yellow", hex: "#fff9b1" },
  yellow: { stored: "yellow", note: "yellow", hex: "#f5d128" },
  orange: { stored: "orange", note: "orange", hex: "#ff9d48" },
  "light-green": { stored: "light-green", note: "light-green", hex: "#d5f692" },
  green: { stored: "green", note: "green", hex: "#c9df56" },
  "dark-green": { stored: "dark-green", note: "green", hex: "#93d275" },
  cyan: { stored: "cyan", note: "light-blue", hex: "#67c6c0" },
  "light-pink": { stored: "light-pink", note: "light-red", hex: "#ffcee0" },
  pink: { stored: "pink", note: "light-red", hex: "#ea94bb" },
  violet: { stored: "violet", note: "violet", hex: "#c6a2d2" },
  red: { stored: "red", note: "red", hex: "#f0939d" },
  "light-blue": { stored: "light-blue", note: "light-blue", hex: "#a6ccf5" },
  blue: { stored: "blue", note: "blue", hex: "#6cd8fa" },
  "dark-blue": { stored: "dark-blue", note: "blue", hex: "#9ea9ff" },
  grey: { stored: "grey", note: "grey", hex: "#e6e6e6" },
  black: { stored: "black", note: "black", hex: "#1a1a1a" },
};

/** A new sticky's colour when the agent (or a person) names none. */
export const DEFAULT_STICKY: StickyColor = "light-yellow";

/** The text colour on a sticky of a colour: white on black, near-black on every other. */
export function stickyTextHex(c: StickyColor): string {
  return c === "black" ? "#ffffff" : "#1a1a1a";
}

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

/**
 * A stored sticky colour → our name. A `note`'s tldraw ink reads as the sticky colour of the same name, else as the first
 * sticky colour drawn with it (`light-red` → `light-pink`); tldraw's `light-violet` as violet, `white` as grey.
 */
export function stickyFromStored(v: unknown, recordType: string = STICKY_TYPE): StickyColor {
  if (typeof v !== "string") return DEFAULT_STICKY;
  if (recordType === NOTE_TYPE) {
    if (STICKY_NAMES.includes(v as StickyColor) && STICKY[v as StickyColor].note === v) return v as StickyColor;
    for (const name of STICKY_NAMES) if (STICKY[name].note === v) return name;
    if (v === "light-violet") return "violet";
    if (v === "white") return "grey";
    return DEFAULT_STICKY;
  }
  for (const name of STICKY_NAMES) if (STICKY[name].stored === v) return name;
  return DEFAULT_STICKY;
}

// ---- Other stored values the agent's names map onto (one table each) ----

/**
 * A shape (`geo`) in the stored props (goal 7.2: our styles are style props; `styles.ts`). tldraw's geo has one colour for
 * border and fill and one size for border width and label; ours adds two style props so they are separate (goal 3.2, 3.3):
 * - the border colour is tldraw's `color`, the text colour tldraw's `labelColor`;
 * - the fill colour is our `fillColor` (`aiwb:fill-color`, tldraw's colour names), drawn when `fill` is not `none`;
 * - the border width is tldraw's `size`;
 * - the label's font size is our `labelSize` (`aiwb:label-size`, s/m/l/xl through tldraw's label font sizes).
 */
export const FILL_COLOR_PROP = "fillColor";
export const BORDER_WIDTH_PROP = "size";
export const LABEL_SIZE_PROP = "labelSize";

/** The custom geo value of the rounded rectangle (tldraw 5.6 has none; `styles.ts` adds it to `GeoShapeGeoStyle`). */
export const ROUNDED_GEO = "rounded-rectangle";

/** Shape kinds ↔ tldraw `geo` values. */
export const SHAPE_GEO: Record<ShapeKind, string> = {
  rectangle: "rectangle",
  rounded: ROUNDED_GEO,
  ellipse: "ellipse",
  triangle: "triangle",
  diamond: "diamond",
};

export function shapeFromGeo(geo: unknown): ShapeKind | undefined {
  for (const k of Object.keys(SHAPE_GEO) as ShapeKind[]) if (SHAPE_GEO[k] === geo) return k;
  return undefined;
}

/** A filled shape's tldraw `fill` style: `fill` draws the fill colour itself (`solid` would draw a lighter tint of it). */
export const FILL_STYLE = "fill";

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
/** A sticky's side when it was not resized. */
export const STICKY_SIZE = 200;

/**
 * A sticky's font size. Stored as a number in the record's `fontSize` (0 = automatic: shrink to fit; else a fixed size in px);
 * the size it is drawn at is the record's `fitted` (written by the fit only). The agent's `"auto"` is 0 and a `Size` is the px
 * of this table; reading, 0 is `"auto"` and any other px the nearest `Size`.
 */
export const STICKY_FONT_SIZES: Record<Size, number> = { s: 16, m: 24, l: 32, xl: 48 };

export function stickyFontSizeToStored(v: "auto" | Size): number {
  return v === "auto" ? 0 : STICKY_FONT_SIZES[v];
}

export function stickyFontSizeFromStored(v: unknown): "auto" | Size {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "auto";
  let best: Size = "m";
  for (const s of SIZES) if (Math.abs(STICKY_FONT_SIZES[s] - v) < Math.abs(STICKY_FONT_SIZES[best] - v)) best = s;
  return best;
}
