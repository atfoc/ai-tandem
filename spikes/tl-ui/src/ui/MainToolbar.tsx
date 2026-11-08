// The main toolbar (goal 3.3): ours, not tldraw's. Reads the editor with useValue, changes it only through its API.
import { GeoShapeGeoStyle, useEditor, useValue, type TLGeoShape } from "tldraw";

type Geo = TLGeoShape["props"]["geo"];
const TOOLS: { id: string; label: string; geo?: Geo }[] = [
  { id: "select", label: "Select" },
  { id: "sticky", label: "Sticky" },
  { id: "geo", label: "Rect", geo: "rectangle" },
  { id: "geo", label: "Ellipse", geo: "ellipse" },
  { id: "text", label: "Text" },
  { id: "arrow", label: "Connector" },
  { id: "frame", label: "Frame" },
  { id: "draw", label: "Pen" },
];

export function MainToolbar() {
  const editor = useEditor();
  const current = useValue("tool", () => editor.getCurrentToolId(), [editor]);
  const geo = useValue("geo", () => editor.getStyleForNextShape(GeoShapeGeoStyle), [editor]);
  const zoom = useValue("zoom", () => Math.round(editor.getZoomLevel() * 100), [editor]);
  return (
    <div className="aiwb-maintoolbar" data-testid="aiwb-maintoolbar" onPointerDown={(e) => e.stopPropagation()}>
      {TOOLS.map((t) => {
        const active = current === t.id && (!t.geo || geo === t.geo);
        return (
          <button
            key={t.label}
            data-testid={`tool-${t.label.toLowerCase()}`}
            aria-pressed={active}
            className={active ? "on" : ""}
            onClick={() => {
              if (t.geo) editor.setStyleForNextShapes(GeoShapeGeoStyle, t.geo);
              editor.setCurrentTool(t.id);
            }}
          >
            {t.label}
          </button>
        );
      })}
      <span className="sep" />
      <button data-testid="zoom-out" onClick={() => editor.zoomOut(undefined, { animation: { duration: 120 } })}>−</button>
      <button data-testid="zoom-reset" onClick={() => editor.resetZoom(undefined, { animation: { duration: 120 } })}>{zoom}%</button>
      <button data-testid="zoom-in" onClick={() => editor.zoomIn(undefined, { animation: { duration: 120 } })}>+</button>
      <button data-testid="zoom-fit" onClick={() => editor.zoomToFit({ animation: { duration: 200 } })}>Fit</button>
    </div>
  );
}
