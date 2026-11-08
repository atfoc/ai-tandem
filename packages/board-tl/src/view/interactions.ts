// Interactions of our own on the editor (goal 3.3), beside what tldraw already does with `hideUi` (its shortcuts, clipboard and
// actions: arrow nudges, Shift+arrow, copy/cut/paste, ⌘D, delete, select all, ⌘Z/⇧⌘Z, Enter and double-click to edit, Escape,
// Alt+drag to clone in its translating state, all checked in win-view.md "T2c").
//
// `installInteractions` (called once by Board at mount) adds, on the document in the capture phase so they come before
// tldraw's single-key tool shortcuts (r, o, a, t, …) and its own key handling:
// - typing a printable character while exactly one sticky or shape is selected (select tool idle, not read-only, the focus not
//   in an input of ours) starts editing it with that character as its text (Miro-like; tldraw only has this for its note,
//   behind a debug flag);
// - Ctrl+Y redoes (tldraw binds only ⇧⌘Z / Ctrl+⇧Z).
//
// The quick-add actions (QuickAdd.tsx's "+"): a copy next to an element joined by a connector, and a connector dragged out of
// an element. Each is one undo step (one history stopping point before the first change).
import {
  createShapeId,
  startEditingShapeWithRichText,
  toRichText,
  type Editor,
  type TLArrowShape,
  type TLShape,
  type TLShapeId,
  type VecLike,
} from "tldraw";
import {
  capturesKeys,
  centredAt,
  copyProps,
  copySize,
  freeCopyPosition,
  isCtrlYRedo,
  isQuickAddType,
  isTypingKey,
  QUICK_ADD_GAP,
  type Point,
  type Rect,
  type Side,
} from "./quickadd-logic.ts";

export function installInteractions(editor: Editor): () => void {
  const container = editor.getContainer();
  const doc = container.ownerDocument;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    // characters typed while the text editor of a type-to-edit is still mounting: kept for it, in order
    if (typing && editor.getEditingShapeId() === typing.id && [...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typing.buffer += e.key;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement | null;
    // only keys meant for the board: on the board's container or on the page itself, never in an input of ours
    if (target && target !== doc.body && !container.contains(target)) return;
    if (capturesKeys(target) || capturesKeys(doc.activeElement as HTMLElement | null)) return;
    if (editor.getEditingShapeId() !== null || editor.menus.hasAnyOpenMenus()) return;
    if (isCtrlYRedo(e)) {
      e.preventDefault();
      e.stopPropagation();
      editor.redo();
      return;
    }
    if (isTypingKey(e) && startTyping(editor, e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  doc.addEventListener("keydown", onKeyDown, true);
  return () => {
    doc.removeEventListener("keydown", onKeyDown, true);
    typing = null;
  };
}

/** A type-to-edit whose text editor is not ready yet: the shape and the characters typed since the first. */
let typing: { id: TLShapeId; buffer: string } | null = null;

/** The one selected sticky or shape that typing or quick add works on, if there is exactly one and it can be edited. */
export function quickAddTarget(editor: Editor): TLShape | null {
  const s = editor.getOnlySelectedShape();
  if (!s || !isQuickAddType(s.type) || editor.getIsReadonly() || editor.isShapeOrAncestorLocked(s)) return null;
  return s;
}

/**
 * Starts editing the one selected sticky or shape with `text` as its whole text, the caret after it. False: not applicable.
 * tldraw's text editor mounts a few frames later (focused, the caret at the start); the characters typed until then are kept
 * (`typing`) and inserted once it is there, with the caret at the end, so fast typing keeps its order. One undo step.
 */
export function startTyping(editor: Editor, text: string): boolean {
  if (!editor.isIn("select.idle")) return false;
  const s = quickAddTarget(editor);
  if (!s || !editor.canEditShape(s)) return false;
  editor.markHistoryStoppingPoint("typing to edit");
  editor.updateShape({ id: s.id, type: s.type, props: { richText: toRichText(text) } } as never);
  startEditingShapeWithRichText(editor, s.id);
  const pending = { id: s.id, buffer: "" };
  typing = pending;
  const win = editor.getContainer().ownerDocument.defaultView ?? window;
  let frames = 0;
  const ready = () => {
    if (typing !== pending) return;
    if (editor.getEditingShapeId() !== s.id) {
      typing = null;
      return;
    }
    const rte = editor.getRichTextEditor();
    const dom = rte && !rte.isDestroyed ? (rte.view.dom as HTMLElement) : null;
    if (rte && dom?.isConnected && dom.closest(`[data-shape-id="${s.id}"]`)) {
      typing = null;
      const chain = rte.chain().focus("end");
      (pending.buffer ? chain.insertContent(pending.buffer) : chain).run();
    } else if (frames++ < 120) win.requestAnimationFrame(ready);
    else {
      // no text editor came (should not happen): keep what was typed anyway
      typing = null;
      if (pending.buffer) editor.updateShape({ id: s.id, type: s.type, props: { richText: toRichText(text + pending.buffer) } } as never);
    }
  };
  win.requestAnimationFrame(ready);
  return true;
}

function pageRect(editor: Editor, id: TLShapeId): Rect | null {
  const b = editor.getShapePageBounds(id);
  return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
}

/** Other elements a copy should not land on: everything but connectors, pens, the source and the frames it is in. */
function obstacles(editor: Editor, source: TLShape): Rect[] {
  const ancestors = new Set(editor.getShapeAncestors(source).map((a) => a.id));
  const out: Rect[] = [];
  for (const s of editor.getCurrentPageShapes()) {
    if (s.id === source.id || ancestors.has(s.id) || s.type === "arrow" || s.type === "draw" || s.type === "line") continue;
    const r = pageRect(editor, s.id);
    if (r) out.push(r);
  }
  return out;
}

/** Creates a copy of `source` (empty text) with its top-left at page point `at`, in the source's frame when it fits there. */
function createCopy(editor: Editor, source: TLShape, at: Point): TLShapeId {
  const id = createShapeId();
  const props = copyProps(source.type, source.props as Record<string, unknown>, toRichText(""));
  editor.createShape({ id, type: source.type, x: at.x, y: at.y, rotation: 0, opacity: source.opacity, props } as never);
  const parent = editor.getShape(source.parentId);
  const pb = parent ? editor.getShapePageBounds(parent) : null;
  const cb = editor.getShapePageBounds(id);
  if (parent && pb && cb && pb.contains(cb)) editor.reparentShapes([id], parent.id);
  return id;
}

const ANCHOR = { normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false };

function bind(editor: Editor, arrow: TLShapeId, to: TLShapeId, terminal: "start" | "end") {
  editor.createBinding({ type: "arrow", fromId: arrow, toId: to, props: { ...ANCHOR, terminal } } as never);
}

/** A connector from page point `from` to `to`, bound at its start to `source`; the end is bound by the caller. */
function createConnector(editor: Editor, source: TLShapeId, from: VecLike, to: VecLike): TLShapeId {
  const id = createShapeId();
  editor.createShape<TLArrowShape>({
    id, type: "arrow", x: from.x, y: from.y,
    props: { start: { x: 0, y: 0 }, end: { x: to.x - from.x, y: to.y - from.y } },
  });
  bind(editor, id, source, "start");
  return id;
}

function centre(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Quick add: a copy of `sourceId` next to it on `side` (QUICK_ADD_GAP away, moved across the side if the place is taken),
 * joined to it by a connector bound at both ends, and selected (typing then fills it). One undo step. Returns the copy's id.
 */
export function quickAdd(editor: Editor, sourceId: TLShapeId, side: Side): TLShapeId | null {
  const source = editor.getShape(sourceId);
  const r = source && pageRect(editor, sourceId);
  if (!source || !r) return null;
  const size = copySize(source.props as { w?: unknown; h?: unknown }, r);
  const at = freeCopyPosition(r, side, obstacles(editor, source), QUICK_ADD_GAP, size);
  editor.markHistoryStoppingPoint("quick add");
  let copy: TLShapeId | null = null;
  editor.run(() => {
    copy = createCopy(editor, source, at);
    const arrow = createConnector(editor, sourceId, centre(r), centre({ ...at, ...size }));
    bind(editor, arrow, copy, "end");
    editor.select(copy);
  });
  return copy;
}

/** The element under page point `p` a dragged connector would bind to (not connectors, pens, the source or the connector). */
export function connectorTargetAt(editor: Editor, p: VecLike, exclude: TLShapeId[]): TLShape | null {
  return (
    editor.getShapeAtPoint(p, {
      hitInside: true,
      margin: 0,
      renderingOnly: true,
      filter: (s) => !exclude.includes(s.id) && s.type !== "arrow" && s.type !== "draw" && s.type !== "line" && !editor.isShapeOrAncestorLocked(s),
    }) ?? null
  );
}

/**
 * A connector dragged out of an element's "+": `start` (on the first move past the threshold) creates it, bound to the source,
 * `move` puts its end at the pointer and hints the element under it, `end` binds it to that element or, on empty canvas,
 * makes a copy of the source centred where it was dropped (Miro's way) and binds to it. `cancel` undoes it all. One undo step.
 */
export class ConnectorDrag {
  private arrow: TLShapeId | null = null;
  private mark = "";
  private editor: Editor;
  private sourceId: TLShapeId;
  constructor(editor: Editor, sourceId: TLShapeId) {
    this.editor = editor;
    this.sourceId = sourceId;
  }

  start(p: VecLike) {
    const r = pageRect(this.editor, this.sourceId);
    if (!r) return;
    this.mark = this.editor.markHistoryStoppingPoint("quick add connector");
    this.arrow = createConnector(this.editor, this.sourceId, centre(r), p);
    this.editor.select(this.arrow);
  }

  move(p: VecLike) {
    const a = this.arrow && this.editor.getShape<TLArrowShape>(this.arrow);
    if (!a) return;
    this.editor.updateShape<TLArrowShape>({ id: a.id, type: "arrow", props: { end: { x: p.x - a.x, y: p.y - a.y } } });
    const t = connectorTargetAt(this.editor, p, [this.sourceId, a.id]);
    this.editor.setHintingShapes(t ? [t.id] : []);
  }

  end(p: VecLike): TLShapeId | null {
    const id = this.arrow;
    this.editor.setHintingShapes([]);
    if (!id) return null;
    this.move(p);
    const source = this.editor.getShape(this.sourceId);
    const t = connectorTargetAt(this.editor, p, [this.sourceId, id]);
    if (t) {
      bind(this.editor, id, t.id, "end");
      this.editor.select(id);
      return t.id;
    }
    if (!source) return null;
    const size = copySize(source.props as { w?: unknown; h?: unknown }, pageRect(this.editor, this.sourceId) ?? { x: 0, y: 0, w: 100, h: 100 });
    const copy = createCopy(this.editor, source, centredAt(p, size.w, size.h));
    bind(this.editor, id, copy, "end");
    this.editor.select(copy);
    return copy;
  }

  cancel() {
    this.editor.setHintingShapes([]);
    if (this.arrow) this.editor.bailToMark(this.mark);
    this.arrow = null;
  }

  get started() {
    return this.arrow !== null;
  }
}
