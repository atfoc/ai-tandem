// The zoom controls (goal 3.1): out, the zoom level (a click resets to 100%), in, fit. Split out of the spike's main toolbar.
import { useEditor, useValue } from "tldraw";

export function Zoom() {
  const editor = useEditor();
  const zoom = useValue("zoom", () => Math.round(editor.getZoomLevel() * 100), [editor]);
  return (
    <div className="aiwb-zoom" data-testid="aiwb-zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button data-testid="zoom-out" title="Zoom out" onClick={() => editor.zoomOut(undefined, { animation: { duration: 120 } })}>−</button>
      <button data-testid="zoom-reset" title="Zoom to 100%" onClick={() => editor.resetZoom(undefined, { animation: { duration: 120 } })}>{zoom}%</button>
      <button data-testid="zoom-in" title="Zoom in" onClick={() => editor.zoomIn(undefined, { animation: { duration: 120 } })}>+</button>
      <button data-testid="zoom-fit" title="Fit the board" onClick={() => editor.zoomToFit({ animation: { duration: 200 } })}>Fit</button>
    </div>
  );
}
