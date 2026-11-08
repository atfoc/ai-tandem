// tldraw records → the agent's elements and the `read_board` text (design 7.3). Works on records alone (no `Editor`), so it
// runs anywhere and is tested in Node.
//
// Bounds. A record says where a shape is relative to its parent, and its size for most types; page bounds come from the
// parents' transforms, and a rotated shape gives its axis-aligned bounds. Two sizes are not in the records: a text element's
// height (and its width when auto-sized), which tldraw measures, and the exact line of a connector whose ends are clipped to
// the shapes they attach to. Here they are estimated. A caller that has an `Editor` (the board host, the window) passes
// `pageBounds` (e.g. `id => editor.getShapePageBounds(id)`) and gets tldraw's own numbers for every element.

import type { TLBinding, TLRecord, TLShape } from "tldraw";
import { b64Vecs } from "@tldraw/tlschema";
import type { Align, Point, Size, TlElement } from "./terms.ts";
import {
  BASE_FONT_SIZE,
  BORDER_WIDTH_PROP,
  FILL_COLOR_PROP,
  LABEL_FONT_SIZES,
  LINE_HEIGHT,
  NOTE_TYPE,
  STICKY_SIZE,
  STICKY_TYPE,
  TEXT_FONT_SIZES,
  alignFromStored,
  arrowheadFromStored,
  dashFromStored,
  inkFromStored,
  shapeFromGeo,
  sizeFromStored,
  stickyFromStored,
} from "./palette.ts";

export type Box = { x: number; y: number; w: number; h: number };

/** A shape record as read here: tldraw's or one of ours (the sticky), with props we look into by name. */
export type ShapeRecord = {
  id: string;
  typeName: "shape";
  type: string;
  x: number;
  y: number;
  rotation: number;
  index: string;
  parentId: string;
  isLocked?: boolean;
  props: Record<string, unknown>;
  meta?: Record<string, unknown>;
};
export type BindingRecord = {
  id: string;
  typeName: "binding";
  type: string;
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
};
/** Anything with a `typeName`: a store's records, a snapshot's `documents[].state`, or a mix. */
export type AnyRecord = TLRecord | TLShape | TLBinding | ShapeRecord | BindingRecord | { typeName: string; id: string };

export type ReadOptions = {
  /** Only the shapes of this page. Absent: the first page (by index) when page records are given, else every shape. */
  pageId?: string;
  /** Page bounds from an `Editor`. Returning undefined falls back to the bounds computed from the records. */
  pageBounds?: (id: string) => Box | undefined;
};

export type BoardInfo = { id: string; name: string };

// ---- Small geometry: a 2D affine matrix [a b c d e f] maps (x, y) to (a x + c y + e, b x + d y + f) ----

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function local(s: ShapeRecord): Mat {
  const cos = Math.cos(s.rotation || 0);
  const sin = Math.sin(s.rotation || 0);
  return [cos, sin, -sin, cos, s.x, s.y];
}

function apply(m: Mat, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function boundsOf(points: Point[]): Box {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function corners(b: Box): Point[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

const round = (n: number) => Math.round(n * 10) / 10 + 0; // + 0: no -0 in the JSON

// ---- Rich text ----

type RichNode = { type?: string; text?: string; content?: RichNode[]; marks?: { type?: string }[] };

const INLINE_PARENTS = new Set(["paragraph", "heading", "codeBlock"]);

/** tldraw's rich text (a TipTap document) → plain text: one line per paragraph, joined with "\n". */
export function richTextToPlain(rt: unknown): string {
  if (typeof rt === "string") return rt;
  const lines: string[] = [];
  const inline = (n: RichNode): string => {
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    return (n.content ?? []).map(inline).join("");
  };
  const block = (n: RichNode) => {
    if (!n || typeof n !== "object") return;
    if (INLINE_PARENTS.has(n.type ?? "")) lines.push(inline(n));
    else if (n.type === "text" || n.type === "hardBreak") lines.push(inline(n));
    else for (const c of n.content ?? []) block(c);
  };
  block(rt as RichNode);
  return lines.join("\n");
}

/** True when the rich text has text and every piece of it is bold. */
function allBold(rt: unknown): boolean {
  let seen = false;
  let bold = true;
  const walk = (n: RichNode) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && (n.text ?? "") !== "") {
      seen = true;
      if (!(n.marks ?? []).some((m) => m.type === "bold")) bold = false;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(rt as RichNode);
  return seen && bold;
}

// ---- Element types ----

/** The agent's type of a shape record. */
export function elementTypeOf(s: { type: string; props?: Record<string, unknown> }): TlElement["type"] {
  switch (s.type) {
    case STICKY_TYPE:
    case NOTE_TYPE:
      return "sticky";
    case "geo":
      return shapeFromGeo(s.props?.geo) ? "shape" : "other";
    case "text":
      return "text";
    case "arrow":
      return "connector";
    case "frame":
      return "frame";
    case "draw":
      return "pen";
    case "image":
      return "image";
    default:
      return "other";
  }
}

/** The key an element was created with (`meta.key`, design D10). */
export function keyOf(s: { meta?: unknown }): string | undefined {
  const k = (s.meta as Record<string, unknown> | undefined)?.key;
  return typeof k === "string" && k !== "" ? k : undefined;
}

// ---- The board as records ----

class Board {
  shapes = new Map<string, ShapeRecord>();
  children = new Map<string, ShapeRecord[]>();
  arrowEnds = new Map<string, { start?: BindingRecord; end?: BindingRecord }>();
  pages: { id: string; index: string }[] = [];
  private transforms = new Map<string, Mat>();
  private bounds = new Map<string, Box>();
  private busy = new Set<string>();
  private opts: ReadOptions;

  constructor(records: Iterable<AnyRecord>, opts: ReadOptions) {
    this.opts = opts;
    for (const r of records) {
      if (r.typeName === "shape") this.shapes.set(r.id, r as ShapeRecord);
      else if (r.typeName === "page") this.pages.push({ id: r.id, index: String((r as { index?: string }).index ?? "") });
      else if (r.typeName === "binding" && (r as BindingRecord).type === "arrow") {
        const b = r as BindingRecord;
        const ends = this.arrowEnds.get(b.fromId) ?? {};
        if (b.props.terminal === "start") ends.start = b;
        else if (b.props.terminal === "end") ends.end = b;
        this.arrowEnds.set(b.fromId, ends);
      }
    }
    for (const s of this.shapes.values()) {
      const list = this.children.get(s.parentId) ?? [];
      list.push(s);
      this.children.set(s.parentId, list);
    }
    for (const list of this.children.values()) list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    this.pages.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  }

  /** The page's shapes in z-order, back to front, each parent before what it holds. */
  ordered(): ShapeRecord[] {
    const roots: string[] = this.opts.pageId
      ? [this.opts.pageId]
      : this.pages.length > 0
        ? [this.pages[0].id]
        : [...this.children.keys()].filter((id) => !this.shapes.has(id)).sort();
    const out: ShapeRecord[] = [];
    const walk = (id: string) => {
      for (const c of this.children.get(id) ?? []) {
        out.push(c);
        walk(c.id);
      }
    };
    for (const r of roots) walk(r);
    return out;
  }

  pageTransform(s: ShapeRecord): Mat {
    const known = this.transforms.get(s.id);
    if (known) return known;
    const parent = this.shapes.get(s.parentId);
    const m = parent && !this.busy.has(parent.id) ? multiply(this.withBusy(s.id, () => this.pageTransform(parent)), local(s)) : local(s);
    this.transforms.set(s.id, m);
    return m;
  }

  /** The nearest frame that holds a shape. */
  frameOf(s: ShapeRecord): ShapeRecord | undefined {
    let p = this.shapes.get(s.parentId);
    const seen = new Set<string>();
    while (p && !seen.has(p.id)) {
      if (p.type === "frame") return p;
      seen.add(p.id);
      p = this.shapes.get(p.parentId);
    }
    return undefined;
  }

  pageBounds(s: ShapeRecord): Box {
    const known = this.bounds.get(s.id);
    if (known) return known;
    const given = this.opts.pageBounds?.(s.id);
    const b = given ?? this.withBusy(s.id, () => this.computeBounds(s));
    this.bounds.set(s.id, b);
    return b;
  }

  private withBusy<T>(id: string, f: () => T): T {
    this.busy.add(id);
    try {
      return f();
    } finally {
      this.busy.delete(id);
    }
  }

  private computeBounds(s: ShapeRecord): Box {
    if (s.type === "arrow") return boundsOf(this.arrowPoints(s).all);
    if (s.type === "draw") return boundsOf(drawPoints(s).map((p) => apply(this.pageTransform(s), p)));
    if (s.type === "group") {
      const kids = (this.children.get(s.id) ?? []).filter((k) => !this.busy.has(k.id));
      return boundsOf(kids.flatMap((k) => corners(this.pageBounds(k))));
    }
    const size = localSize(s);
    return boundsOf(corners({ x: 0, y: 0, ...size }).map((p) => apply(this.pageTransform(s), p)));
  }

  /** A connector's two ends and the points its bounds are made of, in page coordinates. */
  arrowPoints(s: ShapeRecord): { start: Point; end: Point; all: Point[] } {
    const m = this.pageTransform(s);
    const ends = this.arrowEnds.get(s.id) ?? {};
    const at = (which: "start" | "end"): Point => {
      const b = ends[which];
      const target = b && this.shapes.get(b.toId);
      if (b && target && !this.busy.has(target.id)) {
        const precise = b.props.isPrecise === true;
        const anchor = (precise ? b.props.normalizedAnchor : undefined) as Point | undefined;
        const a = anchor ?? { x: 0.5, y: 0.5 };
        if (target.type === "arrow" || target.type === "draw" || target.type === "group") {
          const tb = this.pageBounds(target);
          return { x: tb.x + a.x * tb.w, y: tb.y + a.y * tb.h };
        }
        const size = localSize(target);
        return apply(this.pageTransform(target), { x: a.x * size.w, y: a.y * size.h });
      }
      return apply(m, (s.props[which] as Point | undefined) ?? { x: 0, y: 0 });
    };
    const start = at("start");
    const end = at("end");
    const all = [start, end];
    const bend = Number(s.props.bend) || 0;
    if (s.props.kind !== "elbow" && bend !== 0) {
      // tldraw's middle handle: the chord's middle moved by -bend along the chord's perpendicular (y, -x).
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const per = { x: dy / len, y: -dx / len };
      all.push({ x: (start.x + end.x) / 2 - per.x * bend, y: (start.y + end.y) / 2 - per.y * bend });
    }
    return { start, end, all };
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function labelFontSize(s: ShapeRecord): number {
  return BASE_FONT_SIZE * LABEL_FONT_SIZES[sizeFromStored(s.props.size)];
}

/** A shape's size in its own coordinates, from its record alone. */
function localSize(s: ShapeRecord): { w: number; h: number } {
  const p = s.props;
  const scale = num(p.scale, 1);
  switch (s.type) {
    case STICKY_TYPE:
    case NOTE_TYPE: {
      const w = num(p.w, STICKY_SIZE * scale);
      return { w, h: num(p.h, (STICKY_SIZE + num(p.growY, 0)) * scale) };
    }
    case "geo":
      return { w: num(p.w, 100), h: num(p.h, 100) + num(p.growY, 0) };
    case "text": {
      // Estimated (tldraw measures text): see the head of the file.
      const size = BASE_FONT_SIZE * TEXT_FONT_SIZES[sizeFromStored(p.size)];
      const lines = richTextToPlain(p.richText).split("\n");
      const charW = size * 0.55;
      if (p.autoSize !== false) {
        const longest = Math.max(1, ...lines.map((l) => l.length));
        return { w: (longest * charW + 1) * scale, h: Math.max(1, lines.length) * size * LINE_HEIGHT * scale };
      }
      const w = Math.max(16, Math.floor(num(p.w, 16)));
      const perLine = Math.max(1, Math.floor(w / charW));
      const count = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
      return { w: w * scale, h: count * size * LINE_HEIGHT * scale };
    }
    default:
      return { w: num(p.w, 1), h: num(p.h, 1) };
  }
}

function drawPoints(s: ShapeRecord): Point[] {
  const sx = num(s.props.scaleX, 1) * num(s.props.scale, 1);
  const sy = num(s.props.scaleY, 1) * num(s.props.scale, 1);
  const out: Point[] = [];
  for (const seg of (s.props.segments as { path?: unknown; points?: unknown; dim?: 2 | 3 }[] | undefined) ?? []) {
    let pts: Point[] = [];
    if (typeof seg.path === "string") {
      try {
        pts = b64Vecs.decodePoints(seg.path, seg.dim);
      } catch {
        pts = [];
      }
    } else if (Array.isArray(seg.points)) pts = seg.points as Point[];
    for (const p of pts) out.push({ x: p.x * sx, y: p.y * sy });
  }
  return out;
}

// ---- Records → elements ----

function elementOf(board: Board, s: ShapeRecord): TlElement {
  const type = elementTypeOf(s);
  const b = board.pageBounds(s);
  const p = s.props;
  // Built in the design's field order: id, key, type, parent, [shape], x, y, w, h, then the type's own fields.
  const out = { id: s.id } as TlElement;
  const key = keyOf(s);
  if (key) out.key = key;
  out.type = type;
  const frame = board.frameOf(s);
  if (frame) out.parent = frame.id;
  if (type === "shape") out.shape = shapeFromGeo(p.geo);
  out.x = round(b.x);
  out.y = round(b.y);
  out.w = round(b.w);
  out.h = round(b.h);
  const text = richTextToPlain(p.richText);

  switch (type) {
    case "sticky": {
      if (text) out.text = text;
      out.color = stickyFromStored(p.color, s.type);
      out.align = alignFromStored(p.align, "middle");
      const fixed = s.type === STICKY_TYPE && p.fontSize !== "auto" && sizeFromStored(p.fontSize) === p.fontSize;
      out.fontSize = fixed ? (p.fontSize as TlElement["fontSize"]) : "auto";
      const shown =
        typeof p.shownSize === "number"
          ? p.shownSize
          : fixed
            ? BASE_FONT_SIZE * LABEL_FONT_SIZES[p.fontSize as Size] * num(p.scale, 1)
            : labelFontSize(s) * num(p.fontSizeAdjustment, 1) * num(p.scale, 1);
      out.shownSize = round(shown);
      break;
    }
    case "shape": {
      if (text) out.text = text;
      const fillColor = p[FILL_COLOR_PROP] ?? p.color;
      out.fill = p.fill === "none" || p.fill === undefined ? "none" : inkFromStored(fillColor);
      out.border = inkFromStored(p.color);
      out.borderWidth = sizeFromStored(p[BORDER_WIDTH_PROP] ?? p.size);
      out.borderStyle = dashFromStored(p.dash);
      out.align = alignFromStored(p.align, "middle");
      out.size = sizeFromStored(p.size);
      break;
    }
    case "text": {
      out.text = text;
      out.size = sizeFromStored(p.size);
      out.color = inkFromStored(p.color);
      out.align = alignFromStored(p.textAlign, "start") as Align;
      out.bold = typeof p.bold === "boolean" ? p.bold : allBold(p.richText);
      break;
    }
    case "connector": {
      const ends = board.arrowEnds.get(s.id) ?? {};
      const pts = board.arrowPoints(s);
      const endOf = (which: "start" | "end", pt: Point): TlElement["from"] => {
        const bnd = ends[which];
        const target = bnd && board.shapes.get(bnd.toId);
        if (bnd && target) {
          const k = keyOf(target);
          return k ? { id: target.id, key: k } : { id: target.id };
        }
        return { x: round(pt.x), y: round(pt.y) };
      };
      out.from = endOf("start", pts.start);
      out.to = endOf("end", pts.end);
      out.line = p.kind === "elbow" ? "elbow" : (Number(p.bend) || 0) === 0 ? "straight" : "curved";
      out.start = arrowheadFromStored(p.arrowheadStart, "none");
      out.end = arrowheadFromStored(p.arrowheadEnd, "arrow");
      if (text) out.text = text;
      out.color = inkFromStored(p.color);
      out.width = sizeFromStored(p.size);
      out.dash = dashFromStored(p.dash);
      break;
    }
    case "frame": {
      out.name = typeof p.name === "string" ? p.name : "";
      out.color = inkFromStored(p.color);
      break;
    }
    case "pen": {
      out.color = inkFromStored(p.color);
      out.width = sizeFromStored(p.size);
      break;
    }
    default:
      if (text) out.text = text;
  }
  if (s.isLocked) out.locked = true;
  return out;
}

/** The elements of a board's page, in z-order (back to front), frames before what they hold. */
export function readElements(records: Iterable<AnyRecord>, opts: ReadOptions = {}): TlElement[] {
  const board = new Board(records, opts);
  return board.ordered().map((s) => elementOf(board, s));
}

/** Some elements by id (an `apply` answer's created and updated ones), in z-order. */
export function readElementsById(records: Iterable<AnyRecord>, ids: Iterable<string>, opts: ReadOptions = {}): TlElement[] {
  const want = new Set(ids);
  const board = new Board(records, opts);
  return board
    .ordered()
    .filter((s) => want.has(s.id))
    .map((s) => elementOf(board, s));
}

/** One element as one line of JSON. */
export function elementLine(el: TlElement): string {
  return JSON.stringify(el);
}

/** The header line of `read_board` on a new board. */
export function boardHeader(board: BoardInfo, count: number): string {
  return (
    `Board ${JSON.stringify(board.name)} (${board.id}), a new board. ${count} element${count === 1 ? "" : "s"}. ` +
    "Coordinates are page px; parent names the frame that holds an element."
  );
}

/** The whole answer of `read_board` on a new board: the header and one JSON line per element (design 7.3, D13). */
export function readBoardText(board: BoardInfo, records: Iterable<AnyRecord>, opts: ReadOptions = {}): string {
  const els = readElements(records, opts);
  return [boardHeader(board, els.length), ...els.map(elementLine)].join("\n");
}
