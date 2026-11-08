// Pure helpers of quick add and the keyboard behaviours (goal 3.3): where the "+" handles sit, where a copy goes, which keys
// start editing. No tldraw runtime import, so the tests load it in Node.
import { STICKY_TYPE } from "../model/palette.ts";

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];
export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

/** The gap between an element and its quick-add copy, in page units (Miro-like). */
export const QUICK_ADD_GAP = 60;
/** How far outside the element's edge a "+" sits, in screen px (its centre). */
export const HANDLE_OFFSET = 18;
/** The pointer within this many screen px of the element (or on a "+") keeps the handles shown. */
export const HOVER_MARGIN = 36;
/** A pointer that moves more than this (screen px) from where it went down on a "+" drags a connector. */
export const DRAG_THRESHOLD = 4;

/** The element types quick add and type-to-edit work on: our sticky and the shape (geo). */
export function isQuickAddType(type: string): boolean {
  return type === STICKY_TYPE || type === "geo";
}

/** The centre of each "+", in the same (screen) space as `r`. */
export function handlePositions(r: Rect, offset = HANDLE_OFFSET): { side: Side; x: number; y: number }[] {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return [
    { side: "top", x: cx, y: r.y - offset },
    { side: "right", x: r.x + r.w + offset, y: cy },
    { side: "bottom", x: cx, y: r.y + r.h + offset },
    { side: "left", x: r.x - offset, y: cy },
  ];
}

/** Whether `p` is within `margin` of `r` (the hover area of the handles). */
export function nearRect(p: Point, r: Rect, margin = HOVER_MARGIN): boolean {
  return p.x >= r.x - margin && p.x <= r.x + r.w + margin && p.y >= r.y - margin && p.y <= r.y + r.h + margin;
}

/** The unit direction of a side. */
export function sideVector(side: Side): Point {
  return side === "top" ? { x: 0, y: -1 } : side === "bottom" ? { x: 0, y: 1 } : side === "left" ? { x: -1, y: 0 } : { x: 1, y: 0 };
}

export type Size = { w: number; h: number };

/** The top-left of a copy of size `size` (default: `r`'s) placed `gap` away from `r` on `side`, centred across that side. */
export function copyPosition(r: Rect, side: Side, gap = QUICK_ADD_GAP, size: Size = r): Point {
  const cx = r.x + r.w / 2 - size.w / 2;
  const cy = r.y + r.h / 2 - size.h / 2;
  switch (side) {
    case "top": return { x: cx, y: r.y - gap - size.h };
    case "bottom": return { x: cx, y: r.y + r.h + gap };
    case "left": return { x: r.x - gap - size.w, y: cy };
    case "right": return { x: r.x + r.w + gap, y: cy };
  }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Where the copy goes: next to `r` on `side`; if that place overlaps another element, shifted across the side (down/up for
 * left and right, right/left for top and bottom) by one size plus gap at a time, alternating, so copies fan out like Miro's.
 * Gives up after `tries` and returns the first place.
 */
export function freeCopyPosition(r: Rect, side: Side, obstacles: Rect[], gap = QUICK_ADD_GAP, size: Size = r, tries = 8): Point {
  const base = copyPosition(r, side, gap, size);
  const across = side === "left" || side === "right" ? { x: 0, y: size.h + gap } : { x: size.w + gap, y: 0 };
  for (let i = 0; i <= tries; i++) {
    // 0, +1, -1, +2, -2, ...
    const k = i === 0 ? 0 : i % 2 === 1 ? (i + 1) / 2 : -i / 2;
    const p = { x: base.x + across.x * k, y: base.y + across.y * k };
    if (!obstacles.some((o) => overlaps({ ...p, w: size.w, h: size.h }, o))) return p;
  }
  return base;
}

/**
 * The props of a quick-add copy: the source's (type, size, colours, font, alignment), with the text emptied. A shape's label
 * growth (`growY`) goes back to 0 with its text; a sticky's fitted size is refitted by its util on create.
 */
export function copyProps<P extends Record<string, unknown>>(type: string, props: P, emptyText: unknown): P {
  const out: Record<string, unknown> = { ...props, richText: emptyText };
  if (type === "geo" && "growY" in out) out.growY = 0;
  return out as P;
}

/** The size of a copy of an element with these props (a shape's `growY` is dropped with its text). */
export function copySize(props: { w?: unknown; h?: unknown }, fallback: Size): Size {
  return typeof props.w === "number" && typeof props.h === "number" ? { w: props.w, h: props.h } : fallback;
}

/** The top-left of an element of size `w`×`h` centred on `p` (a copy dropped on empty canvas). */
export function centredAt(p: Point, w: number, h: number): Point {
  return { x: p.x - w / 2, y: p.y - h / 2 };
}

/** Keys that never start editing: Space pans (tldraw's Space+drag). */
const NOT_TYPING = new Set([" "]);

export type KeyLike = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * Whether a key press is typing (it starts editing the selected sticky or shape with that character): one printable
 * character (one code point, so emoji count), no Ctrl/⌘/Alt, not Space, and not Shift+0/1/2 (tldraw's zoom to 100%, fit
 * the board, fit the selection, which the board keeps).
 */
export function isTypingKey(e: KeyLike): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if ([...e.key].length !== 1 || NOT_TYPING.has(e.key)) return false;
  if (e.shiftKey && (e.code === "Digit0" || e.code === "Digit1" || e.code === "Digit2")) return false;
  return true;
}

/** Ctrl+Y (not with Shift, Alt or ⌘): redo, the Windows shortcut tldraw does not bind. */
export function isCtrlYRedo(e: KeyLike): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y";
}

/** Whether a DOM element takes key presses itself (an input, a select, a text area, editable text). */
export function capturesKeys(el: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  const t = el.tagName.toLowerCase();
  return !!el.isContentEditable || t === "input" || t === "textarea" || t === "select";
}
