// The main toolbar (goal 3.3): ours, not tldraw's. A compact vertical bar on the left (Miro-like): select, sticky, shape
// (its types in a flyout; the chosen type shows on the button and is remembered), text, connector, frame, pen. Reads the
// editor with useValue and changes it only through its API.
//
// Placing is tldraw's own: with a tool chosen a click places an element at its default size and a drag sizes it, then the
// tool returns to select (the pen stays). Shortcuts are tldraw's kept ones (V, R, O, T, A, F, D) plus `UI_OVERRIDES` below:
// N and S choose our sticky (tldraw's N chose its `note`), P the pen.
//
// Focus: the buttons never take focus (mouse down is prevented, tabIndex -1), and a click hands DOM focus back to tldraw's
// container, so Space-to-pan and the shortcuts keep working after a click on the toolbar.
import { useEffect, useState, type ReactNode } from "react";
import { GeoShapeGeoStyle, useEditor, useValue, type Editor, type TLGeoShape, type TLUiOverrides } from "tldraw";
import { STICKY_TOOL } from "../model/shapes/sticky.tsx";
import { ROUNDED_RECT } from "../model/styles.ts";
import { localRedo, localUndo } from "./localundo.ts";
import "./toolbar.css";

export type Geo = TLGeoShape["props"]["geo"];

/** The shape types of the flyout, in order (goal 3.2). */
export const SHAPE_TYPES: { geo: Geo; label: string; kbd?: string }[] = [
  { geo: "rectangle", label: "Rectangle", kbd: "R" },
  { geo: ROUNDED_RECT as Geo, label: "Rounded rectangle" },
  { geo: "ellipse", label: "Ellipse", kbd: "O" },
  { geo: "triangle", label: "Triangle" },
  { geo: "diamond", label: "Diamond" },
];

type ToolButton = { id: string; label: string; kbd: string };
/** The buttons other than the shape button (which sits after the sticky). */
export const TOOL_BUTTONS: ToolButton[] = [
  { id: "select", label: "Select", kbd: "V" },
  { id: STICKY_TOOL, label: "Sticky note", kbd: "N" },
  { id: "text", label: "Text", kbd: "T" },
  { id: "arrow", label: "Connector", kbd: "A" },
  { id: "frame", label: "Frame", kbd: "F" },
  { id: "draw", label: "Pen", kbd: "P" },
];

/** Which of our buttons a tldraw tool lights up: the tool's own id, `geo` for the shape button; tldraw tools we show no
 *  button for (hand, eraser, line, laser… still reachable by their keys) light none. */
export function activeButton(toolId: string): string | null {
  return toolId === "geo" || TOOL_BUTTONS.some((b) => b.id === toolId) ? toolId : null;
}

/** The shape type the shape button shows: the next shape's geo when it is one of ours, else the one remembered. */
export function shownGeo(next: string | undefined, remembered: Geo): Geo {
  return SHAPE_TYPES.some((t) => t.geo === next) ? (next as Geo) : remembered;
}

/** The shortcuts tldraw lacks for our tools (passed as `<Tldraw overrides>`; tldraw's keyboard hook reads the tools list). */
export const UI_OVERRIDES: TLUiOverrides = {
  tools(editor, tools) {
    const next = { ...tools };
    next[STICKY_TOOL] = {
      id: STICKY_TOOL,
      label: "tool.note",
      icon: "tool-note",
      kbd: "n,s",
      onSelect() { editor.setCurrentTool(STICKY_TOOL); },
    };
    // tldraw's note stays registered (old records) but is not reachable by a key; N is ours
    if (next.note) next.note = { ...next.note, kbd: undefined };
    if (next.draw) next.draw = { ...next.draw, kbd: "d,p,b,x" };
    return next;
  },
  // every undo and redo touches only what this window did (goal 3.3, localundo.ts); ⌘Z, Ctrl+Z, ⇧⌘Z and Ctrl+⇧Z come here
  actions(editor, actions) {
    const next = { ...actions };
    if (next.undo) next.undo = { ...next.undo, onSelect() { localUndo(editor); } };
    if (next.redo) next.redo = { ...next.redo, onSelect() { localRedo(editor); } };
    return next;
  },
};

// remembered across remounts of the board (a module, not component, value); the next shape's geo is the editor's
let rememberedGeo: Geo = "rectangle";

const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICONS: Record<string, ReactNode> = {
  select: I(<path d="M6 3.5l12 8.2-5.3 1.1 3 5.6-2.3 1.2-3-5.6L6.5 18z" />),
  [STICKY_TOOL]: I(<><path d="M4.5 4.5h15v10l-5 5h-10z" /><path d="M19.5 14.5h-5v5" /></>),
  text: I(<><path d="M5 6V4.5h14V6" /><path d="M12 4.5v15" /><path d="M9 19.5h6" /></>),
  arrow: I(<><path d="M5 19L19 5" /><path d="M11 5h8v8" /></>),
  frame: I(<><path d="M7 3v18M17 3v18M3 7h18M3 17h18" /></>),
  draw: I(<><path d="M4 20c2-1 3-4 5-6s4-1 4.5-3S12 8 14 6s5-1 6-2" /></>),
  rectangle: I(<rect x="4" y="6" width="16" height="12" />),
  [ROUNDED_RECT]: I(<rect x="4" y="6" width="16" height="12" rx="3.5" />),
  ellipse: I(<ellipse cx="12" cy="12" rx="8.5" ry="6.5" />),
  triangle: I(<path d="M12 4.5l8.5 15h-17z" />),
  diamond: I(<path d="M12 3.5l8.5 8.5-8.5 8.5-8.5-8.5z" />),
};

/** Props that keep focus on the board: no focus on mouse down, out of the tab order. */
const noFocus = { tabIndex: -1, onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

function choose(editor: Editor, tool: string) {
  editor.setCurrentTool(tool);
  editor.getContainer().focus();
}

export function MainToolbar() {
  const editor = useEditor();
  const tool = useValue("tool", () => editor.getCurrentToolId(), [editor]);
  const nextGeo = useValue("geo", () => editor.getStyleForNextShape(GeoShapeGeoStyle), [editor]);
  const [open, setOpen] = useState(false);
  const geo = shownGeo(nextGeo, rememberedGeo);
  if (SHAPE_TYPES.some((t) => t.geo === nextGeo)) rememberedGeo = nextGeo as Geo;
  const active = activeButton(tool);

  // the flyout closes when the tool leaves geo (an element was placed, Escape, another tool or key)
  useEffect(() => { if (tool !== "geo") setOpen(false); }, [tool]);

  const button = (b: ToolButton) => (
    <button
      key={b.id}
      {...noFocus}
      data-testid={`tool-${b.id}`}
      title={`${b.label} (${b.kbd})`}
      aria-label={b.label}
      aria-pressed={active === b.id}
      className={active === b.id ? "on" : ""}
      onClick={() => choose(editor, b.id)}
    >
      {ICONS[b.id]}
    </button>
  );
  const shapeLabel = SHAPE_TYPES.find((t) => t.geo === geo)!.label;

  return (
    <div className="aiwb-tools" data-testid="aiwb-maintoolbar" onPointerDown={(e) => e.stopPropagation()}>
      {button(TOOL_BUTTONS[0])}
      {button(TOOL_BUTTONS[1])}
      <div className="aiwb-tools-shape">
        <button
          {...noFocus}
          data-testid="tool-geo"
          data-geo={geo}
          title={`Shape: ${shapeLabel} (R, O)`}
          aria-label={`Shape: ${shapeLabel}`}
          aria-pressed={active === "geo"}
          aria-expanded={open}
          className={(active === "geo" ? "on " : "") + "more"}
          onClick={() => {
            editor.setStyleForNextShapes(GeoShapeGeoStyle, geo);
            choose(editor, "geo");
            setOpen((o) => (tool === "geo" ? !o : true));
          }}
        >
          {ICONS[geo]}
        </button>
        {open && (
          <div className="aiwb-tools-flyout" data-testid="shape-flyout" role="menu">
            {SHAPE_TYPES.map((t) => (
              <button
                key={t.geo}
                {...noFocus}
                role="menuitemradio"
                aria-checked={t.geo === geo}
                data-testid={`shape-${t.geo}`}
                title={t.kbd ? `${t.label} (${t.kbd})` : t.label}
                aria-label={t.label}
                className={t.geo === geo ? "on" : ""}
                onClick={() => {
                  rememberedGeo = t.geo;
                  editor.setStyleForNextShapes(GeoShapeGeoStyle, t.geo);
                  choose(editor, "geo");
                  setOpen(false);
                }}
              >
                {ICONS[t.geo]}
              </button>
            ))}
          </div>
        )}
      </div>
      {TOOL_BUTTONS.slice(2).map(button)}
    </div>
  );
}
