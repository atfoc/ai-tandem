// The zoom controls (goal 3.1), bottom left: out, the zoom level (a click resets to 100%), in, fit the whole board. Shift+1
// (fit the board) and Shift+2 (fit the selection) are tldraw's own shortcuts. The bottom right is tldraw's licence watermark,
// which nothing of ours may cover (goal 4.2). The buttons take no focus (see MainToolbar).
import type { ReactNode } from "react";
import { useEditor, useValue, type Editor } from "tldraw";
import "./toolbar.css";

// in/out/reset are immediate: tldraw computes the next step from the zoom of the moment, so quick clicks during an animation
// would all aim at the same step
const ANIM = undefined;
const noFocus = { tabIndex: -1, onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

/** The zoom level as the control shows it. */
export function zoomLabel(z: number): string {
  return `${Math.round(z * 100)}%`;
}

export function Zoom() {
  const editor = useEditor();
  const zoom = useValue("zoom", () => editor.getZoomLevel(), [editor]);
  const btn = (id: string, title: string, run: (e: Editor) => void, body: ReactNode, cls = "") => (
    <button {...noFocus} data-testid={id} title={title} aria-label={title} className={cls}
      onClick={() => { run(editor); editor.getContainer().focus(); }}>{body}</button>
  );
  const svg = (d: ReactNode) => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
  );
  return (
    <div className="aiwb-zoombar" data-testid="aiwb-zoom" onPointerDown={(e) => e.stopPropagation()}>
      {btn("zoom-out", "Zoom out (−)", (e) => e.zoomOut(undefined, ANIM), svg(<path d="M6 12h12" />))}
      {btn("zoom-reset", "Zoom to 100% (Shift+0)", (e) => e.resetZoom(undefined, ANIM), zoomLabel(zoom), "pct")}
      {btn("zoom-in", "Zoom in (+)", (e) => e.zoomIn(undefined, ANIM), svg(<path d="M6 12h12M12 6v12" />))}
      {btn("zoom-fit", "Fit the board (Shift+1)", (e) => e.zoomToFit({ animation: { duration: 200 } }),
        svg(<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />))}
    </div>
  );
}
