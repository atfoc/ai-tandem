// Quick add (goal 3.3): hovering a selected sticky or shape shows a "+" on each of its four sides. A click on a "+" adds a copy
// on that side joined by a connector (interactions.ts `quickAdd`); dragging it draws a connector that binds to the element it
// is dropped on, or, dropped on empty canvas, makes a copy there (Miro's way; `ConnectorDrag`).
//
// A screen-space overlay (a child of <Tldraw>, like the main toolbar): the handles are placed from the element's page bounds
// and the camera, read with useValue, so they follow pan, zoom and moves. Shown only with the select tool idle (so not while
// dragging, resizing, rotating, brushing, panning or editing), with exactly one sticky or shape selected and the pointer near
// it; on a touch screen (no hover) whenever one is selected.
import { useRef, useState } from "react";
import { useEditor, useValue, type Editor, type TLShapeId } from "tldraw";
import { ConnectorDrag, quickAdd, quickAddTarget } from "./interactions.ts";
import { DRAG_THRESHOLD, HOVER_MARGIN, handlePositions, nearRect, type Side } from "./quickadd-logic.ts";
import "./quickadd.css";

type Shown = { id: TLShapeId; handles: { side: Side; x: number; y: number }[] } | null;

function read(editor: Editor, overHandle: boolean): Shown {
  if (!editor.isIn("select.idle")) return null;
  const s = quickAddTarget(editor);
  if (!s) return null;
  const b = editor.getShapePageBounds(s.id);
  if (!b) return null;
  const { x: cx, y: cy, z } = editor.getCamera();
  if (!overHandle && !editor.getInstanceState().isCoarsePointer) {
    const p = editor.inputs.getCurrentPagePoint();
    if (!nearRect(p, b, HOVER_MARGIN / z)) return null;
  }
  // viewport coordinates (relative to the board's container, where this overlay is placed)
  const r = { x: (b.x + cx) * z, y: (b.y + cy) * z, w: b.w * z, h: b.h * z };
  return { id: s.id, handles: handlePositions(r) };
}

export function QuickAdd() {
  const editor = useEditor();
  const [overHandle, setOverHandle] = useState(false);
  const busy = useRef(false);
  const shown = useValue("quick add", () => read(editor, overHandle), [editor, overHandle]);
  if (!shown) return null;

  const onPointerDown = (e: React.PointerEvent, side: Side) => {
    if (e.button !== 0 || busy.current) return;
    // ours alone: no tldraw gesture, no focus moved to the button (the board keeps the keys)
    e.preventDefault();
    e.stopPropagation();
    busy.current = true;
    const source = shown.id;
    const win = editor.getContainer().ownerDocument.defaultView ?? window;
    const start = { x: e.clientX, y: e.clientY };
    const drag = new ConnectorDrag(editor, source);
    const page = (ev: PointerEvent) => editor.screenToPage({ x: ev.clientX, y: ev.clientY });
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!drag.started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) <= DRAG_THRESHOLD) return;
        drag.start(page(ev));
      }
      drag.move(page(ev));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      done();
      if (drag.started) drag.end(page(ev));
      else quickAdd(editor, source, side);
      editor.getContainer().focus();
    };
    const cancel = (ev: PointerEvent | KeyboardEvent) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      if (ev instanceof PointerEvent && ev.pointerId !== e.pointerId) return;
      done();
      drag.cancel();
    };
    const done = () => {
      busy.current = false;
      setOverHandle(false);
      win.removeEventListener("pointermove", move, true);
      win.removeEventListener("pointerup", up, true);
      win.removeEventListener("pointercancel", cancel, true);
      win.removeEventListener("keydown", cancel, true);
    };
    win.addEventListener("pointermove", move, true);
    win.addEventListener("pointerup", up, true);
    win.addEventListener("pointercancel", cancel, true);
    win.addEventListener("keydown", cancel, true);
  };

  return (
    <div className="aiwb-quickadd" data-testid="aiwb-quickadd">
      {shown.handles.map((h) => (
        <button
          key={h.side}
          type="button"
          tabIndex={-1}
          className={`aiwb-quickadd-plus ${h.side}`}
          data-testid={`quickadd-${h.side}`}
          aria-label={`Add on the ${h.side}`}
          style={{ left: h.x, top: h.y }}
          onPointerEnter={() => setOverHandle(true)}
          onPointerLeave={() => { if (!busy.current) setOverHandle(false); }}
          onPointerDown={(e) => onPointerDown(e, h.side)}
        >
          +
        </button>
      ))}
    </div>
  );
}
