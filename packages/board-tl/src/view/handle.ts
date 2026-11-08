// The handle a mounted view gives the app for an agent's `get_view` and `show_board` (design 6; core's `TlViewHandle`):
// - getView(): the visible area in page coordinates, the zoom (1 = 100 %) and the selected elements in the agent terms
//   (model/read.ts, with tldraw's own page bounds);
// - zoomTo(refs): the shapes the refs name (`{id}`, with or without the `shape:` prefix, or `{key}`, the ref they were created
//   with, `meta.key`), and the camera fitted to their bounds; false when none of them names a shape.
// The editor is typed structurally (HandleEditor) so the pure parts are tested without a DOM.
import type { TlRef, TlViewHandle } from "@aiwb/core/tl/registry.ts";
import type { TLShapeId } from "tldraw";
import { keyOf, readElementsById, type AnyRecord, type Box } from "../model/read.ts";

/** What the handle needs of tldraw's `Editor`. */
export interface HandleEditor {
  getViewportPageBounds(): Box;
  getZoomLevel(): number;
  getSelectedShapeIds(): readonly string[];
  getCurrentPageId(): string;
  getShapePageBounds(id: TLShapeId): Box | undefined;
  zoomToBounds(bounds: Box, opts?: { inset?: number; animation?: { duration: number } }): unknown;
  store: { allRecords(): readonly unknown[] };
}

type ShapeLike = { typeName: "shape"; id: string; meta?: unknown };
const isShape = (r: unknown): r is ShapeLike => !!r && typeof r === "object" && (r as { typeName?: unknown }).typeName === "shape";

/** The ids of the shapes the refs name, in the refs' order, each once. */
export function resolveRefs(records: Iterable<unknown>, refs: readonly TlRef[]): string[] {
  const byId = new Map<string, ShapeLike>();
  const byKey = new Map<string, ShapeLike>();
  for (const r of records) {
    if (!isShape(r)) continue;
    byId.set(r.id, r);
    const k = keyOf(r);
    if (k !== undefined) byKey.set(k, r);
  }
  const out: string[] = [];
  for (const ref of refs) {
    let s: ShapeLike | undefined;
    if ("id" in ref && typeof ref.id === "string") s = byId.get(ref.id) ?? byId.get(`shape:${ref.id}`);
    else if ("key" in ref && typeof ref.key === "string") s = byKey.get(ref.key);
    if (s && !out.includes(s.id)) out.push(s.id);
  }
  return out;
}

/** The smallest box around the boxes (null for none). */
export function unionBounds(boxes: Iterable<Box | undefined>): Box | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const box = (b: Box | undefined): Box | undefined => (b ? { x: b.x, y: b.y, w: b.w, h: b.h } : undefined);

/** The handle for a mounted editor. */
export function createViewHandle(editor: HandleEditor, opts: { animationMs?: number; inset?: number } = {}): TlViewHandle {
  const animationMs = opts.animationMs ?? 300;
  return {
    getView() {
      const v = editor.getViewportPageBounds();
      const selected = readElementsById(editor.store.allRecords() as AnyRecord[], editor.getSelectedShapeIds(), {
        pageId: editor.getCurrentPageId(),
        pageBounds: (id) => box(editor.getShapePageBounds(id as TLShapeId)),
      });
      return { bounds: { x: v.x, y: v.y, w: v.w, h: v.h }, zoom: editor.getZoomLevel(), selected };
    },
    zoomTo(refs) {
      const ids = resolveRefs(editor.store.allRecords(), refs);
      const b = unionBounds(ids.map((id) => editor.getShapePageBounds(id as TLShapeId)));
      if (!b) return false;
      editor.zoomToBounds(b, { ...(opts.inset !== undefined ? { inset: opts.inset } : {}), ...(animationMs > 0 ? { animation: { duration: animationMs } } : {}) });
      return true;
    },
  };
}
