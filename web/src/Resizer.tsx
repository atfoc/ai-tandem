// The drag handle on a pane's right edge that resizes it: the sidebar, or a
// board's chat panel. Widths live in the store and localStorage "aiwb.widths".
import React, { useRef } from "react";
import { getState, setState, safeSet } from "./store.ts";
import { clampWidth, MIN_STAGE, PANES, type Pane } from "./logic/layout.ts";

function setWidth(pane: Pane, w: number, save: boolean) {
  const widths = { ...getState().widths, [pane]: w };
  if (widths[pane] !== getState().widths[pane]) setState({ widths });
  if (save) safeSet("aiwb.widths", JSON.stringify(widths));
}

/**
 * Drag to resize, double-click for the default width. The pointer is captured, so the drag
 * keeps going over the canvas and iframes; `body.resizing` holds the cursor meanwhile. The
 * pane cannot grow into the last MIN_STAGE pixels of the page right of it.
 */
export function Resizer({ pane }: { pane: Pane }) {
  const drag = useRef<{ x: number; w: number; room: number } | null>(null);
  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    e.currentTarget.classList.remove("active");
    setWidth(pane, getState().widths[pane], true);
  };
  return (
    <div className="resizer" role="separator" aria-orientation="vertical" title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const w = getState().widths[pane];
        const stage = document.querySelector(".app > main");
        const room = stage ? w + stage.getBoundingClientRect().width - MIN_STAGE : Infinity;
        drag.current = { x: e.clientX, w, room };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add("active");
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setWidth(pane, clampWidth(pane, d.w + e.clientX - d.x, d.room), false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setWidth(pane, PANES[pane].def, true)} />
  );
}
