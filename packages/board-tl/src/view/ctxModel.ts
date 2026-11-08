// The context bar's logic, without React or tldraw (goal 3.3): which controls a selection gets, how they are grouped into the
// bar's popovers, the values the selection shares ("mixed" when it does not), bold on a text's rich text, and where the bar and
// its popovers go on the screen. ContextBar.tsx draws it; contextActions.ts changes the board. Unit tests:
// test/context.test.ts.
//
// Shapes are read as plain records ({ type, props, isLocked }), so this module runs anywhere.
import { ARROWHEAD, INK, INK_NAMES, ROUNDED_GEO, SIZES, STICKY_FONT_SIZES, STICKY_NAMES, STICKY_TYPE } from "../model/palette.ts";
import type { Color } from "../model/terms.ts";

// --- the controls ---------------------------------------------------------------------------------------------------

/** One control of the bar. Most are a tldraw style prop (contextActions.ts `STYLE_OF`); the rest are a shape's own props. */
export type Key =
  | "stickyColor" // sticky: our 16 colours (aiwb:sticky-color)
  | "stickyFontSize" // sticky: 0 = auto, else px (its own prop)
  | "align" // sticky, shape: horizontal alignment of the text (tldraw's align)
  | "geo" // shape: the shape type
  | "fillColor" // shape: "none" (fill none) or a fill colour (fill "fill" + aiwb:fill-color)
  | "borderColor" // shape: tldraw's color, drawn as the border
  | "lineWidth" // shape, connector, pen: tldraw's size (the border's / line's width)
  | "dash" // shape, connector: solid / dashed / dotted
  | "labelSize" // shape: the label's font size (aiwb:label-size)
  | "color" // text, connector, frame, pen: tldraw's color
  | "fontSize" // text: tldraw's size (a text has no stroke: it is its font size)
  | "textAlign" // text: tldraw's textAlign
  | "bold" // text: every text node of the rich text has the bold mark
  | "arrowKind" // connector: straight / curved / elbow (kind + bend)
  | "arrowheadStart"
  | "arrowheadEnd"
  | "frameName"; // frame: its name

/** What each shape type shows (goal 3.3), in the bar's order. A type not listed (image, …) shows only the "always" group. */
export const SECTIONS: Record<string, readonly Key[]> = {
  [STICKY_TYPE]: ["stickyColor", "stickyFontSize", "align"],
  geo: ["geo", "fillColor", "borderColor", "lineWidth", "dash", "labelSize", "align"],
  text: ["color", "fontSize", "textAlign", "bold"],
  arrow: ["arrowKind", "lineWidth", "dash", "color", "arrowheadStart", "arrowheadEnd"],
  frame: ["frameName", "color"],
  draw: ["color", "lineWidth"],
};

export type ShapeLike = { type: string; isLocked?: boolean; props: object };

export type Controls = {
  /** The controls every selected type has (first type's order); none when the selection is locked. */
  keys: Key[];
  /** Everything selected is locked: only Unlock is shown. */
  locked: boolean;
  /** Several elements: align (2+) and distribute (3+). */
  align: boolean;
  distribute: boolean;
};

export function controlsFor(shapes: readonly ShapeLike[]): Controls {
  const locked = shapes.length > 0 && shapes.every((s) => s.isLocked);
  const types = [...new Set(shapes.map((s) => s.type))];
  const lists = types.map((t) => SECTIONS[t] ?? []);
  const keys = locked || lists.length === 0 ? [] : lists[0].filter((k) => lists.every((l) => l.includes(k)));
  return { keys, locked, align: !locked && shapes.length >= 2, distribute: !locked && shapes.length >= 3 };
}

// --- the popovers -----------------------------------------------------------------------------------------------------

/** A group of the bar: a popover behind one button, or (name, bold) a control shown in the row itself. */
export type GroupId = "name" | "shape" | "color" | "text" | "bold" | "line" | "ends";
export const GROUP_OF: Record<Key, GroupId> = {
  frameName: "name",
  geo: "shape",
  stickyColor: "color",
  fillColor: "color",
  borderColor: "color",
  color: "color",
  stickyFontSize: "text",
  labelSize: "text",
  fontSize: "text",
  align: "text",
  textAlign: "text",
  bold: "bold",
  arrowKind: "line",
  lineWidth: "line",
  dash: "line",
  arrowheadStart: "ends",
  arrowheadEnd: "ends",
};
const GROUP_ORDER: GroupId[] = ["name", "shape", "color", "text", "bold", "line", "ends"];
/** Groups that are popovers (the others sit in the row). */
export const POPOVER_GROUPS: readonly GroupId[] = ["shape", "color", "text", "line", "ends"];

/** The groups of a list of controls, in the bar's order, each with its controls in their section's order. */
export function groupsFor(keys: readonly Key[]): { id: GroupId; keys: Key[] }[] {
  return GROUP_ORDER.map((id) => ({ id, keys: keys.filter((k) => GROUP_OF[k] === id) })).filter((g) => g.keys.length > 0);
}

// --- the choices ------------------------------------------------------------------------------------------------------

export const GEO_CHOICES = ["rectangle", ROUNDED_GEO, "ellipse", "triangle", "diamond"] as const;
export const SIZE_CHOICES = SIZES;
export const DASH_CHOICES = ["solid", "dashed", "dotted"] as const;
export const ALIGN_CHOICES = ["start", "middle", "end"] as const;
export const ARROW_KINDS = ["straight", "curved", "elbow"] as const;
export const ARROWHEAD_CHOICES = Object.values(ARROWHEAD); // none, arrow, triangle, dot, diamond, bar
/** The sticky's font sizes: 0 = auto, then the px of the agent's sizes (so a pick reads back as a Size). */
export const STICKY_SIZE_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: "Auto" },
  ...SIZES.map((s) => ({ value: STICKY_FONT_SIZES[s], label: s.toUpperCase() })),
];
export const STICKY_COLOR_CHOICES = STICKY_NAMES;
/** An ink a person picks: our agent's name, stored as tldraw's colour name (palette.ts `INK`). */
export const INK_CHOICES: { name: Color; stored: string }[] = INK_NAMES.map((name) => ({ name, stored: INK[name] }));

// --- the values the selection shares ----------------------------------------------------------------------------------

/** The value when every item has the same one, else null ("mixed"). */
export function shared<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

export type ArrowLook = (typeof ARROW_KINDS)[number];
/** Straight and curved are tldraw's `arc` kind without and with a bend; elbow is its own kind. */
export function arrowLook(props: { kind?: unknown; bend?: unknown }): ArrowLook {
  if (props.kind === "elbow") return "elbow";
  return Math.abs(Number(props.bend) || 0) < 0.5 ? "straight" : "curved";
}
/** The bend of an arrow made curved: kept when it already is, else a fifth of its length (at least 20). */
export function curvedBend(props: { kind?: unknown; bend?: unknown; start: { x: number; y: number }; end: { x: number; y: number } }): number {
  if (arrowLook(props) === "curved") return Number(props.bend);
  return Math.max(20, Math.hypot(props.end.x - props.start.x, props.end.y - props.start.y) * 0.2);
}

/** One shape's value for a control (the stored value; the view maps inks to our names). */
export function valueOf(key: Key, s: ShapeLike): string | number | boolean | undefined {
  const p = s.props as Record<string, unknown>;
  switch (key) {
    case "stickyColor":
    case "borderColor":
    case "color":
      return p.color as string;
    case "fillColor":
      return p.fill === "none" ? "none" : (p.fillColor as string);
    case "lineWidth":
    case "fontSize":
      return p.size as string;
    case "stickyFontSize":
      return p.fontSize as number;
    case "bold":
      return isAllBold(p.richText);
    case "arrowKind":
      return arrowLook(p as { kind?: unknown; bend?: unknown });
    case "frameName":
      return p.name as string;
    default:
      return p[key] as string; // geo, dash, labelSize, align, textAlign, arrowheadStart, arrowheadEnd
  }
}

/** The selection's value per control: shared, or null when mixed. Bold is on only when every text is all bold. */
export function readValues(keys: readonly Key[], shapes: readonly ShapeLike[]): Partial<Record<Key, string | number | boolean | null>> {
  const out: Partial<Record<Key, string | number | boolean | null>> = {};
  for (const k of keys) {
    const vs = shapes.map((s) => valueOf(k, s));
    out[k] = k === "bold" ? vs.every(Boolean) : (shared(vs) ?? null);
  }
  return out;
}

// --- bold on rich text (tldraw's TipTap JSON) ---------------------------------------------------------------------------
// The mark TipTap's StarterKit writes on ⌘B; no TipTap editor is needed to set it on a whole text.

type RtNode = { type: string; text?: string; marks?: { type: string; attrs?: unknown }[]; content?: RtNode[] };
function textNodes(n: RtNode | undefined, out: RtNode[] = []): RtNode[] {
  if (!n || typeof n !== "object") return out;
  if (n.type === "text") out.push(n);
  n.content?.forEach((c) => textNodes(c, out));
  return out;
}
/** Every text node is bold (an empty text is not bold). */
export function isAllBold(richText: unknown): boolean {
  const t = textNodes(richText as RtNode);
  return t.length > 0 && t.every((n) => n.marks?.some((m) => m.type === "bold"));
}
/** The rich text with every text node bold, or with no bold mark anywhere; other marks are kept. */
export function withBold<T>(richText: T, bold: boolean): T {
  const walk = (n: RtNode): RtNode => {
    if (n.type === "text") {
      const marks = (n.marks ?? []).filter((m) => m.type !== "bold");
      if (bold) marks.push({ type: "bold" });
      const { marks: _drop, ...rest } = n;
      return marks.length ? { ...rest, marks } : rest;
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  return walk(richText as unknown as RtNode) as unknown as T;
}

// --- where it goes --------------------------------------------------------------------------------------------------------

export type Box = { minX: number; minY: number; maxX: number; maxY: number };
export type Size = { w: number; h: number };
/** Gap between the selection and the bar (clear of the quick-add "+" handles, 18 px out, about 10 px in radius), and the bar's least distance to the viewport's edges. */
export const GAP = 36;
export const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.min(Math.max(v, lo), hi));

/**
 * The bar's top-left, in the viewport's coordinates: centred above the selection, below it when there is no room above,
 * clamped into the viewport (a selection that fills it gets the bar inside, at the top or bottom).
 */
export function placeBar(sel: Box, bar: Size, view: Size): { left: number; top: number; below: boolean } {
  const left = clamp((sel.minX + sel.maxX) / 2 - bar.w / 2, MARGIN, view.w - MARGIN - bar.w);
  const above = sel.minY - GAP - bar.h;
  if (above >= MARGIN) return { left, top: Math.min(above, view.h - MARGIN - bar.h), below: false };
  return { left, top: clamp(sel.maxY + GAP, MARGIN, view.h - MARGIN - bar.h), below: true };
}

/** A popover's top-left, in the viewport's coordinates: under its button, above it when there is no room below, clamped. */
export function placePopover(anchor: Box, pop: Size, view: Size): { left: number; top: number; up: boolean } {
  const left = clamp(anchor.minX, MARGIN, view.w - MARGIN - pop.w);
  const down = anchor.maxY + 6;
  if (down + pop.h <= view.h - MARGIN) return { left, top: down, up: false };
  const up = anchor.minY - 6 - pop.h;
  if (up >= MARGIN) return { left, top: up, up: true };
  return { left, top: clamp(down, MARGIN, view.h - MARGIN - pop.h), up: false };
}
