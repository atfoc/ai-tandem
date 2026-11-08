// Our style props (goal 7.2: our styles are style props; design 7.2). A style prop, not a plain prop, so tldraw's own
// "set the style of the selection", shared styles and "the style of the next shape" work with it, with no code of ours.
//
// DOM-free: imports only `@tldraw/tlschema`, so `schema.ts` (and the board host) can load it in plain Node. Names and hexes
// come from `palette.ts` (the one source of truth).
//
// Importing this module adds the rounded rectangle to tldraw's `GeoShapeGeoStyle` (a module-level enum that every geo record
// is validated against), so the value validates wherever the schema is used, also without `GeoShapeUtil.configure`.

import { DefaultColorStyle, GeoShapeGeoStyle, StyleProp } from "@tldraw/tlschema";
import { DEFAULT_STICKY, ROUNDED_GEO, SIZES, STICKY, STICKY_NAMES, stickyTextHex } from "./palette.ts";
import type { Size, StickyColor } from "./terms.ts";

/** The sticky's colour: our 16 names (palette.ts `STICKY`), its own prop so a sticky's last colour is not the next shape's. */
export const StickyColorStyle = StyleProp.defineEnum("aiwb:sticky-color", {
  defaultValue: DEFAULT_STICKY,
  values: STICKY_NAMES,
});

/** A geo's fill colour, separate from its border colour (tldraw's `color`). tldraw's colour names; default white. */
export const FillColorStyle = StyleProp.defineEnum("aiwb:fill-color", {
  defaultValue: "white",
  values: [...DefaultColorStyle.values],
});

/** A geo's label size, separate from its border width (tldraw's `size`). Drawn with tldraw's label font sizes. */
export const LabelSizeStyle = StyleProp.defineEnum("aiwb:label-size", {
  defaultValue: "m",
  values: SIZES,
});

export type FillColor = (typeof FillColorStyle.values)[number];
export type LabelSize = Size;

/** The geo value of the rounded rectangle. */
export const ROUNDED_RECT = ROUNDED_GEO;
GeoShapeGeoStyle.addValues(ROUNDED_RECT as never);

/** A sticky colour's fill as drawn (theme-independent, goal 4.10); an unknown name draws as the default. */
export function stickyHex(c: string): string {
  return (STICKY[c as StickyColor] ?? STICKY[DEFAULT_STICKY]).hex;
}

/** The text colour on a sticky of a colour. */
export function stickyTextColor(c: string): string {
  return stickyTextHex(STICKY_NAMES.includes(c as StickyColor) ? (c as StickyColor) : DEFAULT_STICKY);
}
