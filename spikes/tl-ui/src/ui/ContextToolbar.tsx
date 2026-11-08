// The contextual toolbar (goal 3.3, 7.3), minimal: it sits above the selection's screen bounds, follows pan, zoom and
// moves (useValue on the editor), is hidden while dragging, resizing or rotating, and shows the sticky palette for a
// selection that holds stickies, plus delete. The full per-type content is for board-tl (spike-ui.md).
import { useEditor, useValue } from "tldraw";
import { STICKY_COLORS, STICKY_COLOR_NAMES, StickyColorStyle, type StickyColor } from "../model/theme.ts";

/** The states in which the toolbar is hidden (a gesture is under way). */
export const BUSY_STATES = [
  "select.translating",
  "select.resizing",
  "select.rotating",
  "select.dragging_handle",
  "select.brushing",
  "select.scribble_brushing",
  "select.panning_canvas",
  "select.pointing_handle",
  "select.pointing_resize_handle",
  "select.pointing_rotate_handle",
];

export function ContextToolbar() {
  const editor = useEditor();
  const info = useValue(
    "context toolbar",
    () => {
      if (editor.getCurrentToolId() !== "select") return null;
      if (editor.isInAny(...BUSY_STATES)) return null;
      const ids = editor.getSelectedShapeIds();
      if (ids.length === 0) return null;
      const b = editor.getSelectionRotatedScreenBounds();
      if (!b) return null;
      const shapes = editor.getSelectedShapes();
      const types = [...new Set(shapes.map((s) => s.type))];
      const color = editor.getSharedStyles().get(StickyColorStyle);
      return { x: b.midX, y: b.minY, types, color: color?.type === "shared" ? color.value : null };
    },
    [editor],
  );
  if (!info) return null;
  const hasSticky = info.types.includes("sticky");
  const setColor = (c: StickyColor) => {
    editor.markHistoryStoppingPoint("color");
    editor.setStyleForSelectedShapes(StickyColorStyle, c);
    editor.setStyleForNextShapes(StickyColorStyle, c);
  };
  return (
    <div
      className="aiwb-contexttoolbar"
      data-testid="aiwb-contexttoolbar"
      data-types={info.types.join(",")}
      style={{ left: info.x, top: info.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {hasSticky &&
        STICKY_COLOR_NAMES.map((c) => (
          <button
            key={c}
            title={c}
            data-testid={`color-${c}`}
            className={"swatch" + (info.color === c ? " on" : "")}
            style={{ background: STICKY_COLORS[c] }}
            onClick={() => setColor(c)}
          />
        ))}
      <button data-testid="ctx-delete" onClick={() => { editor.markHistoryStoppingPoint("delete"); editor.deleteShapes(editor.getSelectedShapeIds()); }}>Delete</button>
    </div>
  );
}
