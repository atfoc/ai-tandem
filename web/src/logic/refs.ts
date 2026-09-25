// References inside a board chat's message: a selection of elements (⌘L) or a
// point on the board (⌘⇧L). The composer shows them as chips; in the message
// text they are inline tags, so the agent reads them where the user put them
// and the thread can draw the chips again from the stored text:
//
//   <selection ids="a1,b2" label="rectangle “API”">rectangle id=a1 "API" (10,20 160×70); …</selection>
//   <point x="120" y="-40">near: rectangle id=a1 "API" (10,20 160×70) 20px left</point>
//
// DOM-free: board.ts builds refs from the live canvas, Composer and ChatView
// render them.

import { formatElement, nearest, type FmtElement } from "../format.ts";

export type Ref =
  | { kind: "selection"; ids: string[]; label: string; detail: string }
  | { kind: "point"; x: number; y: number; label: string; detail: string };

/** A message split into its text and its references, in order. */
export type Seg = string | Ref;

/** How many selected elements are written out in full; the rest are counted. */
export const MAX_DETAIL = 30;

const one = (e: FmtElement) => formatElement(e).replace(/\s{2,}/g, " ");
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const plural = (t: string) => (/(s|x|sh|ch)$/.test(t) ? t + "es" : t + "s");

/** The chip text for a selection: `rectangle “API”`, `3 rectangles` or `4 elements`. */
export function selectionLabel(els: FmtElement[]): string {
  if (els.length === 1) {
    const e = els[0];
    const l = e.label?.replace(/\s+/g, " ").trim();
    return l ? `${e.type} “${clip(l, 24)}”` : e.type;
  }
  const types = new Set(els.map((e) => e.type));
  return types.size === 1 ? `${els.length} ${plural(els[0].type)}` : `${els.length} elements`;
}

/** A reference to the given elements (bound text is already left out by the caller); null when empty. */
export function selectionRef(els: FmtElement[]): Ref | null {
  if (!els.length) return null;
  const lines = els.slice(0, MAX_DETAIL).map(one);
  if (els.length > MAX_DETAIL) lines.push(`… and ${els.length - MAX_DETAIL} more`);
  return { kind: "selection", ids: els.map((e) => e.id), label: selectionLabel(els), detail: lines.join("; ") };
}

export const pointLabel = (x: number, y: number) => `(${Math.round(x)}, ${Math.round(y)})`;

/** A reference to a point on the board, with the elements nearest to it. */
export function pointRef(x: number, y: number, els: FmtElement[] = []): Ref {
  const px = Math.round(x), py = Math.round(y);
  const near = nearest([px, py], els).map((n) => `${one(n.el)} ${Math.round(n.distance)}px ${n.direction}`);
  return { kind: "point", x: px, y: py, label: pointLabel(px, py), detail: near.length ? `near: ${near.join("; ")}` : "" };
}

// ---- text form

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A reference as its inline tag. One line, whatever the labels hold. */
export function serializeRef(r: Ref): string {
  if (r.kind === "selection") return `<selection ids="${escAttr(r.ids.join(","))}" label="${escAttr(r.label)}">${escText(r.detail)}</selection>`;
  return r.detail ? `<point x="${r.x}" y="${r.y}">${escText(r.detail)}</point>` : `<point x="${r.x}" y="${r.y}"/>`;
}

/** One inline tag, anywhere in a text (no capture groups: safe inside String.split). */
export const REF_SRC = String.raw`<selection\s[^<>]*>[^<]*</selection>|<point\s[^<>]*?(?:/>|>[^<]*</point>)`;
const REF_RE = new RegExp(REF_SRC, "g");

function attrs(tag: string): Record<string, string> {
  const head = tag.slice(0, tag.indexOf(">") + 1);
  const out: Record<string, string> = {};
  for (const m of head.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = unesc(m[2]);
  return out;
}

/** The reference a single tag stands for, or null when it is not one. */
export function parseRef(tag: string): Ref | null {
  if (!new RegExp(`^(?:${REF_SRC})$`).test(tag)) return null;
  const a = attrs(tag);
  const body = tag.endsWith("/>") ? "" : unesc(tag.slice(tag.indexOf(">") + 1, tag.lastIndexOf("</")));
  if (tag.startsWith("<selection")) {
    const ids = (a.ids ?? "").split(",").filter(Boolean);
    return { kind: "selection", ids, label: a.label || `${ids.length} element${ids.length === 1 ? "" : "s"}`, detail: body };
  }
  const x = Number(a.x), y = Number(a.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { kind: "point", x, y, label: pointLabel(x, y), detail: body };
}

/** A message's text and references, in order; empty text between them is left out. */
export function parseRefs(text: string): Seg[] {
  const out: Seg[] = [];
  let at = 0;
  for (const m of text.matchAll(REF_RE)) {
    const r = parseRef(m[0]);
    if (!r) continue;
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push(r);
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export const serialize = (segs: Seg[]) => segs.map((s) => (typeof s === "string" ? s : serializeRef(s))).join("");

/** The text with each reference shown as `[label]`: titles, previews, @ mention matching. */
export const plainText = (text: string) => parseRefs(text).map((s) => (typeof s === "string" ? s : `[${s.label}]`)).join("");
