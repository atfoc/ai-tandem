// The agent's ops on a tldraw `Editor` (design 7.1, 7.2, 7.4 steps 2–4; D10, D15). The other half of `read.ts`: every name ↔
// stored value goes through `palette.ts`, so what is written here reads back as what was asked.
//
// Order of one apply:
// 1. `validateOps` against the editor's current records: the first invalid op is the answer, nothing is touched;
// 2. the checks that need the editor (a locked element named by an update, a delete or a frame's `contains`), also before
//    anything is touched;
// 3. every op in one `editor.run`, through the editor API (createShapes, updateShapes, reparentShapes, createBindings…),
//    never `store.put` for shapes: the sticky's fit and the geo's growY run only in the shape utils' onBeforeCreate /
//    onBeforeUpdate. The store's changes are collected as one diff (`store.extractingChanges`).
//
// Atomic. `editor.run` is a `@tldraw/state` transaction: a throw inside it aborts the transaction, which sets every atom it
// wrote (the store's records among them) back to its value before, and tldraw's history drops the changes. That alone leaves
// the store as it was (tested). As a safety net that does not depend on that internal behaviour, the document records are
// taken before the run and compared after a throw; any difference is put back with `store.applyDiff(…, { runCallbacks:
// false })`. (On a validation throw tldraw also marks the store "possibly corrupted"; only its IndexedDB persistence reads that
// flag, which neither the board host nor the window's synced store uses.)

import { createShapeId, getArrowInfo, toRichText, type BoxModel, type Editor, type RecordsDiff, type TLRecord, type TLShape, type TLShapeId } from "tldraw";
import type { Align, Arrowhead, Color, Point, ShapeKind, Size, StickyColor } from "./terms.ts";
import {
  BORDER_WIDTH_PROP,
  DASH,
  FILL_COLOR_PROP,
  FILL_STYLE,
  ARROWHEAD,
  LABEL_SIZE_PROP,
  SHAPE_GEO,
  STICKY_TYPE,
  inkToStored,
  stickyFontSizeToStored,
  stickyToStored,
  type Dash,
} from "./palette.ts";
import { elementTypeOf, keyOf, richTextToPlain, type ShapeRecord } from "./read.ts";
import { lookupFromRecords, validateOps, type ErrorCode } from "./validate.ts";

export type ApplyOk = {
  ok: true;
  /** ref → tldraw id, for every create that had a ref. */
  ids: Record<string, string>;
  created: string[];
  updated: string[];
  deleted: string[];
  /** The store's changes of the whole apply, as one diff (what the host writes to the room in one transaction). */
  diff: RecordsDiff<TLRecord>;
  /** The union of the page bounds of every created and updated element after the apply, and of every deleted one before it;
   *  null when there is none (the agent's marker, design 8). */
  bounds: { x: number; y: number; w: number; h: number } | null;
};
export type ApplyFail = { ok: false; code: ErrorCode; index?: number; error: string /* "CODE: text", as validate.ts makes them */ };

/** The padding of a frame fitted around what it contains (design 7.2). */
export const FRAME_PADDING = 40;
/** A curved connector's bend, as a share of the distance between its ends (tldraw's `bend` is in px). */
export const CURVE_BEND = 0.2;
/** The font of every element an agent makes (decision D2: tldraw's sans for every element). */
const FONT = "sans";

type AnyOp = Record<string, unknown> & { op: string };
type ShapePartial = { id: TLShapeId; type: string; x?: number; y?: number; parentId?: TLShapeId | string; props?: Record<string, unknown>; meta?: Record<string, unknown> };

class OpError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function labelOf(i: number, op: AnyOp): string {
  if (op.op === "create") return `op ${i} (create ${String(op.type)})`;
  return `op ${i} (${op.op} ${String(op.id)})`;
}

export function applyOps(editor: Editor, ops: unknown): ApplyOk | ApplyFail {
  // 1. validation
  const v = validateOps(ops, lookupFromRecords(editor.store.allRecords()));
  if (!v.ok) return v;
  const list = ops as AnyOp[];

  // 2. locked elements, before anything is touched
  for (let i = 0; i < list.length; i++) {
    const op = list[i];
    const named: string[] = [];
    if (op.op === "update" || op.op === "delete") named.push(op.id as string);
    if (Array.isArray(op.contains)) named.push(...(op.contains as string[]));
    for (const ref of named) {
      const s = existingShape(editor, ref);
      if (s?.isLocked) {
        const error = `INVALID_OP: ${labelOf(i, op)}: ${s.id} is locked`;
        return { ok: false, code: "INVALID_OP", index: i, error };
      }
    }
  }

  // 3. the run
  const docTypes = editor.store.scopedTypes.document;
  const before = new Map<string, TLRecord>();
  for (const r of editor.store.allRecords()) if (docTypes.has(r.typeName)) before.set(r.id, r);

  const run = new Run(editor);
  let current = -1;
  let diff: RecordsDiff<TLRecord>;
  try {
    diff = editor.store.extractingChanges(() => {
      editor.run(
        () => {
          for (let i = 0; i < list.length; i++) {
            current = i;
            run.op(list[i]);
          }
          current = -1;
        },
        // the agent's change is not a person's undo step; locked elements were refused above, so what is left to touch
        // (a locked child of a deleted frame moved to the page, a connector's end on a locked element) is allowed
        { history: "ignore", ignoreShapeLock: true },
      );
    });
  } catch (e) {
    restore(editor, before);
    const message = e instanceof Error ? e.message : String(e);
    const code: ErrorCode = e instanceof OpError ? e.code : "APPLY_FAILED";
    if (current >= 0) {
      return { ok: false, code, index: current, error: `${code}: ${labelOf(current, list[current])}: ${message}` };
    }
    return { ok: false, code, error: `${code}: ${message}` };
  }

  diff = {
    added: filter(diff.added, (r) => docTypes.has(r.typeName)),
    updated: filter(diff.updated, ([, r]) => docTypes.has(r.typeName)),
    removed: filter(diff.removed, (r) => docTypes.has(r.typeName)),
  };
  const isShape = (r: TLRecord) => r.typeName === "shape";
  const created = Object.values(diff.added).filter(isShape).map((r) => r.id);
  const updated = Object.values(diff.updated).filter(([, r]) => isShape(r)).map(([, r]) => r.id);
  const deleted = Object.values(diff.removed).filter(isShape).map((r) => r.id);

  const boxes: BoxModel[] = [];
  for (const id of [...created, ...updated]) {
    const b = editor.getShapePageBounds(id as TLShapeId);
    if (b) boxes.push(b);
  }
  for (const id of deleted) {
    const b = run.deletedBounds.get(id);
    if (b) boxes.push(b);
  }

  return { ok: true, ids: { ...run.ids }, created, updated, deleted, diff, bounds: union(boxes) };
}

/** A shape on the board named by a `shape:` id or a key (no refs of this apply: they cannot be locked). */
function existingShape(editor: Editor, ref: string): TLShape | undefined {
  if (ref.startsWith("shape:")) return editor.getShape(ref as TLShapeId);
  for (const s of editor.getCurrentPageShapes()) if (keyOf(s) === ref) return s;
  return undefined;
}

/** Puts the document records back as they were, if the aborted transaction did not. */
function restore(editor: Editor, before: Map<string, TLRecord>) {
  const docTypes = editor.store.scopedTypes.document;
  const back: RecordsDiff<TLRecord> = { added: {}, updated: {}, removed: {} };
  const now = new Map<string, TLRecord>();
  for (const r of editor.store.allRecords()) if (docTypes.has(r.typeName)) now.set(r.id, r);
  let any = false;
  for (const [id, r] of now) {
    const old = before.get(id);
    if (!old) {
      (back.removed as Record<string, TLRecord>)[id] = r;
      any = true;
    } else if (old !== r) {
      (back.updated as Record<string, [TLRecord, TLRecord]>)[id] = [r, old];
      any = true;
    }
  }
  for (const [id, r] of before) {
    if (!now.has(id)) {
      (back.added as Record<string, TLRecord>)[id] = r;
      any = true;
    }
  }
  if (any) editor.store.applyDiff(back, { runCallbacks: false });
}

function filter<T>(o: Record<string, T>, keep: (v: T) => boolean): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(o)) if (keep(v)) out[k] = v;
  return out;
}

function union(boxes: BoxModel[]): ApplyOk["bounds"] {
  if (boxes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Rich text from plain text (lines → paragraphs), bold over the whole text when asked. */
function richText(text: string, bold = false) {
  const rt = toRichText(text);
  if (!bold) return rt;
  const mark = (n: Record<string, unknown>): Record<string, unknown> => {
    if (n.type === "text") return { ...n, marks: [{ type: "bold" }] };
    return Array.isArray(n.content) ? { ...n, content: (n.content as Record<string, unknown>[]).map(mark) } : n;
  };
  return mark(rt as unknown as Record<string, unknown>) as unknown as typeof rt;
}

/** True when the rich text has text and every piece of it is bold. */
function isAllBold(rt: unknown): boolean {
  let seen = false;
  let bold = true;
  const walk = (n: { type?: string; text?: string; marks?: { type?: string }[]; content?: unknown[] } | undefined) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "text" && (n.text ?? "") !== "") {
      seen = true;
      if (!(n.marks ?? []).some((m) => m.type === "bold")) bold = false;
    }
    for (const c of n.content ?? []) walk(c as typeof n);
  };
  walk(rt as Parameters<typeof walk>[0]);
  return seen && bold;
}

/** The ops of one apply, run inside the editor's `run`. */
class Run {
  readonly editor: Editor;
  /** ref → id, refs of this apply. */
  readonly ids: Record<string, string> = {};
  /** Page bounds of the shapes deleted, just before their delete. */
  readonly deletedBounds = new Map<string, BoxModel>();

  constructor(editor: Editor) {
    this.editor = editor;
  }

  op(op: AnyOp) {
    if (op.op === "create") this.create(op);
    else if (op.op === "update") this.update(op);
    else if (op.op === "delete") this.remove(op);
  }

  // ---- References ----

  resolve(ref: string): TLShape {
    const own = this.ids[ref];
    const editor = this.editor;
    let s: TLShape | undefined;
    if (own !== undefined) s = editor.getShape(own as TLShapeId);
    else if (ref.startsWith("shape:")) s = editor.getShape(ref as TLShapeId);
    else for (const sh of editor.getCurrentPageShapes()) if (keyOf(sh) === ref) { s = sh; break; }
    if (!s) throw new OpError("UNKNOWN_REF", `${JSON.stringify(ref)} names no element of this board or of this call`);
    return s;
  }

  /** The parent id for a create's `parent`: a frame, or the page. */
  parentFor(parent: unknown): TLShapeId | string {
    if (typeof parent === "string") return this.resolve(parent).id;
    return this.editor.getCurrentPageId();
  }

  /** Page point → the local point in `parentId` (a shape or the page). */
  toLocal(parentId: string, p: Point): Point {
    if (parentId.startsWith("shape:")) return this.editor.getPointInShapeSpace(parentId as TLShapeId, p);
    return { x: p.x, y: p.y };
  }

  /** A connector end's page point: the centre of the element it names, or the point. */
  endPoint(end: unknown): Point {
    if (typeof end === "string") {
      const b = this.editor.getShapePageBounds(this.resolve(end).id);
      if (b) return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      return { x: 0, y: 0 };
    }
    const p = end as Point;
    return { x: p.x, y: p.y };
  }

  // ---- Create ----

  create(op: AnyOp) {
    const editor = this.editor;
    const id = createShapeId();
    const meta = typeof op.ref === "string" ? { key: op.ref } : {};
    switch (op.type) {
      case "sticky":
      case "shape":
      case "text": {
        const parentId = this.parentFor(op.parent);
        const at = this.toLocal(parentId, { x: op.x as number, y: op.y as number });
        const type = op.type === "sticky" ? STICKY_TYPE : op.type === "shape" ? "geo" : "text";
        // (every element in our font, explicitly: createShapes fills a style prop left out from the editor's next-shape style, whose
        // font default is tldraw's draw font; the window sets sans as people's next-shape font, O5)
        const base: Record<string, unknown> = { font: FONT };
        if (op.type === "shape") base.dash = DASH.solid;
        if (op.type === "shape" && op.shape === undefined) base.geo = SHAPE_GEO.rectangle;
        if (op.type === "text") base.richText = richText(op.text as string, op.bold === true);
        const props = { ...base, ...this.props(op.type as string, op, undefined) };
        editor.createShapes([{ id, type, parentId: parentId as TLShapeId, x: at.x, y: at.y, props, meta } as never]);
        break;
      }
      case "connector":
        this.createConnector(id, op, meta);
        break;
      case "frame":
        this.createFrame(id, op, meta);
        break;
    }
    if (typeof op.ref === "string") this.ids[op.ref] = id;
  }

  createConnector(id: TLShapeId, op: AnyOp, meta: Record<string, unknown>) {
    const editor = this.editor;
    const from = this.endPoint(op.from);
    const to = this.endPoint(op.to);
    const props: Record<string, unknown> = {
      font: FONT,
      dash: DASH.solid,
      start: { x: 0, y: 0 },
      end: { x: to.x - from.x, y: to.y - from.y },
      ...this.props("connector", op, undefined),
    };
    if (op.line === "curved") props.bend = curveBend(from, to);
    editor.createShapes([{ id, type: "arrow", parentId: editor.getCurrentPageId(), x: from.x, y: from.y, props, meta } as never]);
    this.bindEnd(id, "start", op.from);
    this.bindEnd(id, "end", op.to);
  }

  /** Binds a connector's end to the element it names, or frees it at the point. */
  bindEnd(arrowId: TLShapeId, terminal: "start" | "end", end: unknown) {
    const editor = this.editor;
    const existing = editor.getBindingsFromShape(arrowId, "arrow").filter((b) => (b.props as { terminal?: string }).terminal === terminal);
    if (typeof end === "string") {
      const target = this.resolve(end);
      const props = { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" };
      if (existing.length > 0) {
        if (existing.length > 1) editor.deleteBindings(existing.slice(1));
        editor.updateBinding({ ...existing[0], toId: target.id, props } as never);
      } else {
        editor.createBinding({ type: "arrow", fromId: arrowId, toId: target.id, props } as never);
      }
      return;
    }
    if (existing.length > 0) editor.deleteBindings(existing);
    const local = editor.getPointInShapeSpace(arrowId, end as Point);
    editor.updateShapes([{ id: arrowId, type: "arrow", props: { [terminal]: { x: local.x, y: local.y } } } as never]);
  }

  createFrame(id: TLShapeId, op: AnyOp, meta: Record<string, unknown>) {
    const editor = this.editor;
    const contains = Array.isArray(op.contains) ? (op.contains as string[]).map((r) => this.resolve(r)) : [];
    let box: BoxModel | null = null;
    if (contains.length > 0) {
      const b = union(contains.map((s) => editor.getShapePageBounds(s.id)).filter((x): x is NonNullable<typeof x> => !!x));
      if (b) box = { x: b.x - FRAME_PADDING, y: b.y - FRAME_PADDING, w: b.w + 2 * FRAME_PADDING, h: b.h + 2 * FRAME_PADDING };
    }
    const x = (op.x as number | undefined) ?? box?.x ?? 0;
    const y = (op.y as number | undefined) ?? box?.y ?? 0;
    const props: Record<string, unknown> = this.props("frame", op, undefined);
    if (op.w === undefined && box) props.w = box.w;
    if (op.h === undefined && box) props.h = box.h;
    editor.createShapes([{ id, type: "frame", parentId: editor.getCurrentPageId(), x, y, props, meta } as never]);
    if (contains.length > 0) editor.reparentShapes(contains.map((s) => s.id), id);
  }

  // ---- Update ----

  update(op: AnyOp) {
    const editor = this.editor;
    const shape = this.resolve(op.id as string);
    const kind = elementTypeOf(shape as unknown as ShapeRecord);
    const props = this.props(kind, op, shape);
    // A geo's size goes in after its other props: tldraw's geo, given a first label, sizes the shape from its previous w/h
    // (expandShapeForFirstLabel) and would drop a w/h of the same update.
    const size: Record<string, unknown> = {};
    if (kind === "shape") for (const k of ["w", "h"]) if (k in props) { size[k] = props[k]; delete props[k]; }
    if (Object.keys(props).length > 0) editor.updateShapes([{ id: shape.id, type: shape.type, props } as never]);
    if (Object.keys(size).length > 0) editor.updateShapes([{ id: shape.id, type: shape.type, props: size } as never]);

    if (kind === "shape" && (op.w !== undefined || op.h !== undefined)) this.settleGrowY(shape.id);

    if (kind === "connector") {
      if (op.from !== undefined) this.bindEnd(shape.id, "start", op.from);
      if (op.to !== undefined) this.bindEnd(shape.id, "end", op.to);
      if (op.line === "curved" || ((op.from !== undefined || op.to !== undefined) && op.line === undefined && (shape.props as { bend?: number }).bend)) {
        // a curved connector keeps a bend in proportion to its new length
        const info = this.arrowEnds(shape.id);
        if (info) editor.updateShapes([{ id: shape.id, type: "arrow", props: { bend: curveBend(info.start, info.end) } } as never]);
      }
    }

    if (op.parent !== undefined) {
      editor.reparentShapes([shape.id], op.parent === null ? editor.getCurrentPageId() : this.resolve(op.parent as string).id);
    }
    if (Array.isArray(op.contains) && op.contains.length > 0) {
      editor.reparentShapes((op.contains as string[]).map((r) => this.resolve(r).id), shape.id);
    }
    if (op.x !== undefined || op.y !== undefined) this.moveTo(shape.id, op.x as number | undefined, op.y as number | undefined);
  }

  /** Moves a shape so its page bounds' top-left is at (x, y) (either may be left out). */
  moveTo(id: TLShapeId, x: number | undefined, y: number | undefined) {
    const editor = this.editor;
    const b = editor.getShapePageBounds(id);
    if (!b) return;
    const dx = x === undefined ? 0 : x - b.x;
    const dy = y === undefined ? 0 : y - b.y;
    if (dx === 0 && dy === 0) return;
    const origin = editor.getShapePageTransform(id).applyToPoint({ x: 0, y: 0 });
    const local = editor.getPointInParentSpace(id, { x: origin.x + dx, y: origin.y + dy });
    const s = editor.getShape(id)!;
    editor.updateShapes([{ id, type: s.type, x: local.x, y: local.y } as never]);
  }

  /** A geo's growY after its size changed: tldraw re-measures only on a change of the text, so the util's own creation rule
   *  (grow to the label, else none) is applied to the shape as it is now. */
  settleGrowY(id: TLShapeId) {
    const editor = this.editor;
    const s = editor.getShape(id);
    if (!s) return;
    const util = editor.getShapeUtil(s) as { onBeforeCreate?: (s: TLShape) => TLShape | void };
    const next = util.onBeforeCreate?.(s);
    if (next && next !== s) editor.updateShapes([{ id, type: s.type, props: { growY: (next.props as { growY: number }).growY } } as never]);
  }

  /** A connector's two ends in page coordinates, as tldraw computes them (`getArrowInfo`, arrow space). */
  arrowEnds(id: TLShapeId): { start: Point; end: Point } | undefined {
    const editor = this.editor;
    const info = getArrowInfo(editor, id);
    if (!info) return undefined;
    const m = editor.getShapePageTransform(id);
    return { start: m.applyToPoint(info.start.point), end: m.applyToPoint(info.end.point) };
  }

  // ---- Delete ----

  remove(op: AnyOp) {
    const editor = this.editor;
    const shape = this.resolve(op.id as string);
    const b = editor.getShapePageBounds(shape.id);
    if (b) this.deletedBounds.set(shape.id, { x: b.x, y: b.y, w: b.w, h: b.h });
    // a frame's contents stay, moved to the frame's parent (the page) at the same page positions
    const children = editor.getSortedChildIdsForParent(shape.id);
    if (children.length > 0) editor.reparentShapes(children, shape.parentId);
    editor.deleteShapes([shape.id]);
  }

  // ---- Fields → props ----

  /** The props an op's fields set on an element of the agent's type `kind` (`shape` is the current record, on update). */
  props(kind: string, op: AnyOp, shape: TLShape | undefined): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    const has = (f: string) => op[f] !== undefined;
    switch (kind) {
      case "sticky": {
        const type = shape?.type ?? STICKY_TYPE;
        if (has("w")) {
          if (type === STICKY_TYPE) {
            p.w = op.w;
            p.h = op.w;
          } else {
            // tldraw's note has a fixed size and a scale
            p.scale = (op.w as number) / 200;
          }
        }
        if (has("text")) p.richText = richText(op.text as string);
        if (has("color")) p.color = stickyToStored(op.color as StickyColor, type);
        if (has("fontSize") && type === STICKY_TYPE) p.fontSize = stickyFontSizeToStored(op.fontSize as "auto" | Size);
        if (has("align")) p.align = op.align as Align;
        break;
      }
      case "shape": {
        if (has("shape")) p.geo = SHAPE_GEO[op.shape as ShapeKind];
        if (has("w")) p.w = op.w;
        if (has("h")) p.h = op.h;
        if (has("text")) p.richText = richText(op.text as string);
        if (has("fill")) {
          if (op.fill === "none") p.fill = "none";
          else {
            p.fill = FILL_STYLE;
            p[FILL_COLOR_PROP] = inkToStored(op.fill as Color);
          }
        }
        if (has("border")) p.color = inkToStored(op.border as Color);
        if (has("borderWidth")) p[BORDER_WIDTH_PROP] = op.borderWidth;
        if (has("borderStyle")) p.dash = DASH[op.borderStyle as Dash];
        if (has("align")) p.align = op.align;
        if (has("size")) p[LABEL_SIZE_PROP] = op.size;
        break;
      }
      case "text": {
        if (has("w")) {
          p.autoSize = false;
          p.w = op.w;
        }
        if (shape && (has("text") || has("bold"))) {
          const cur = (shape.props as { richText?: unknown }).richText;
          const text = has("text") ? (op.text as string) : richTextToPlain(cur);
          const bold = has("bold") ? op.bold === true : isAllBold(cur);
          p.richText = richText(text, bold);
        }
        if (has("size")) p.size = op.size;
        if (has("color")) p.color = inkToStored(op.color as Color);
        if (has("align")) p.textAlign = op.align;
        break;
      }
      case "connector": {
        if (has("line")) {
          p.kind = op.line === "elbow" ? "elbow" : "arc";
          if (op.line !== "curved") p.bend = 0;
        }
        if (has("start")) p.arrowheadStart = ARROWHEAD[op.start as Arrowhead];
        if (has("end")) p.arrowheadEnd = ARROWHEAD[op.end as Arrowhead];
        if (has("text")) p.richText = richText(op.text as string);
        if (has("color")) {
          p.color = inkToStored(op.color as Color);
          p.labelColor = p.color;
        }
        if (has("width")) p.size = op.width;
        if (has("dash")) p.dash = DASH[op.dash as Dash];
        break;
      }
      case "frame": {
        if (has("name")) p.name = op.name;
        if (has("w")) p.w = op.w;
        if (has("h")) p.h = op.h;
        if (has("color")) p.color = inkToStored(op.color as Color);
        break;
      }
    }
    return p;
  }
}

function curveBend(a: Point, b: Point): number {
  return Math.round(Math.hypot(b.x - a.x, b.y - a.y) * CURVE_BEND);
}
