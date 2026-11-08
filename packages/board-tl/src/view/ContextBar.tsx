// The context bar (goal 3.3, 7.3): one compact row next to the selection, Miro-like, its controls grouped into popovers
// (shape, colour, text, line, ends, arrange). It sits above the selection's screen bounds, below them when there is no room
// above, clamped into the viewport; it follows pan, zoom and moves (useValue on the editor), is hidden while a gesture is under
// way (BUSY_STATES) and stays while a text is edited (so its text controls can be used then). An open popover closes when the
// selection changes, on a click outside the bar, and on Escape.
//
// Which controls, their values, the grouping and the placement: ctxModel.ts (no React, unit-tested). What a control does:
// contextActions.ts (each change one undo step). Icons: ctxIcons.tsx. Every control has a `data-testid`.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_THEME, useEditor, useValue, type Editor, type TLShapeId } from "tldraw";
import { stickyHex } from "../model/styles.ts";
import {
  act,
  setArrowLook,
  setBold,
  setFill,
  setFrameName,
  setStickyFontSize,
  setStyle,
  STYLE_OF,
  toggleLock,
} from "./contextActions.ts";
import "./contextbar.css";
import {
  ALIGN_CHOICES,
  ARROW_KINDS,
  ARROWHEAD_CHOICES,
  controlsFor,
  DASH_CHOICES,
  GEO_CHOICES,
  groupsFor,
  INK_CHOICES,
  placeBar,
  placePopover,
  readValues,
  SIZE_CHOICES,
  STICKY_COLOR_CHOICES,
  STICKY_SIZE_CHOICES,
  type Box,
  type GroupId,
  type Key,
  type Size,
} from "./ctxModel.ts";
import { ICON, widthIcon } from "./ctxIcons.tsx";

/** The states in which the bar is hidden (a gesture is under way). */
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

// --- what the bar reads -----------------------------------------------------------------------------------------------
function read(editor: Editor) {
  if (editor.getCurrentToolId() !== "select") return null;
  if (editor.isInAny(...BUSY_STATES)) return null;
  const shapes = editor.getSelectedShapes();
  if (shapes.length === 0) return null;
  const b = editor.getSelectionRotatedScreenBounds();
  if (!b) return null;
  const vp = editor.getViewportScreenBounds();
  const sel: Box = { minX: b.minX - vp.x, minY: b.minY - vp.y, maxX: b.maxX - vp.x, maxY: b.maxY - vp.y };
  if (sel.maxX < 0 || sel.maxY < 0 || sel.minX > vp.w || sel.minY > vp.h) return null; // panned out of sight
  const c = controlsFor(shapes);
  return {
    ...c,
    selKey: shapes.map((s) => s.id).join(","),
    types: [...new Set(shapes.map((s) => s.type))],
    count: shapes.length,
    values: readValues(c.keys, shapes),
    frameId: shapes.length === 1 && shapes[0].type === "frame" ? shapes[0].id : null,
    sel,
    view: { w: vp.w, h: vp.h } as Size,
  };
}
type Info = NonNullable<ReturnType<typeof read>>;

/** Our toolbars over the canvas (the main toolbar, the zoom bar), in the viewport's coordinates: the bar and its popovers keep clear of them. */
const OBSTACLES = ['[data-testid="aiwb-maintoolbar"]', '[data-testid="aiwb-zoom"]'];
function obstacles(editor: Editor): Box[] {
  const vp = editor.getViewportScreenBounds();
  const root = editor.getContainer();
  const out: Box[] = [];
  for (const q of OBSTACLES) {
    const r = root.querySelector(q)?.getBoundingClientRect();
    if (r && r.width && r.height) out.push({ minX: r.left - vp.x, minY: r.top - vp.y, maxX: r.right - vp.x, maxY: r.bottom - vp.y });
  }
  return out;
}

// --- colours as tldraw's light theme draws them -----------------------------------------------------------------------
const THEME = DEFAULT_THEME.colors.light as unknown as Record<string, { solid?: string; fill?: string } | string>;
function inkHex(stored: string, variant: "solid" | "fill" = "solid"): string {
  const e = THEME[stored];
  return (typeof e === "object" && e[variant]) || "#ccc";
}
const MIXED_BG = "conic-gradient(#f0939d, #f5d128, #93d275, #6cd8fa, #c6a2d2, #f0939d)";

// --- small parts ------------------------------------------------------------------------------------------------------
type Option = { v: string; title: string; icon?: ReactNode; text?: string };

function Choice({ id, label, value, options, onPick, className }: {
  id: string; label: string; value: unknown; options: readonly Option[]; onPick: (v: string) => void; className?: string;
}) {
  return (
    <div className="aiwb-ctx-sec" data-testid={id}>
      <div className="aiwb-ctx-lbl">{label}</div>
      <div className={"aiwb-ctx-opts " + (className ?? "")}>
        {options.map((o) => (
          <button key={o.v} data-testid={`${id}-${o.v}`} title={o.title} aria-pressed={String(value) === o.v}
            className={"aiwb-ctx-btn" + (o.text ? " txt" : "") + (String(value) === o.v ? " on" : "")} onClick={() => onPick(o.v)}>
            {o.icon ?? o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Swatches({ id, label, value, colors, onPick }: {
  id: string; label: string; value: unknown; colors: readonly { name: string; stored: string; hex: string }[]; onPick: (stored: string) => void;
}) {
  return (
    <div className="aiwb-ctx-sec" data-testid={id}>
      <div className="aiwb-ctx-lbl">{label}</div>
      <div className={"aiwb-ctx-swatches" + (colors.length <= 13 ? " inks" : "")}>
        {colors.map((c) => (
          <button key={c.name} data-testid={`color-${c.name}`} title={c.name} aria-pressed={value === c.stored}
            className={"aiwb-ctx-swatch" + (value === c.stored ? " on" : "") + (c.name === "none" ? " none" : "")}
            style={c.name === "none" ? undefined : { background: c.hex }} onClick={() => onPick(c.stored)} />
        ))}
      </div>
    </div>
  );
}

const INKS = INK_CHOICES.map((c) => ({ ...c, hex: inkHex(c.stored) }));
const FILLS = [{ name: "none", stored: "none", hex: "" }, ...INK_CHOICES.map((c) => ({ ...c, hex: inkHex(c.stored, "fill") }))];
const STICKIES = STICKY_COLOR_CHOICES.map((n) => ({ name: n, stored: n, hex: stickyHex(n) }));
const SIZE_LABEL: Record<string, string> = { s: "Small", m: "Medium", l: "Large", xl: "Extra large" };
const WIDTH_PX: Record<string, number> = { s: 1.2, m: 2.2, l: 3.4, xl: 5 };
const ALIGN_TITLE: Record<string, string> = { start: "Left", middle: "Centre", end: "Right" };
const GEO_TITLE: Record<string, string> = {
  rectangle: "Rectangle", "rounded-rectangle": "Rounded rectangle", ellipse: "Ellipse", triangle: "Triangle", diamond: "Diamond",
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The controls of one key, as they appear in a popover. */
function control(editor: Editor, k: Key, info: Info): ReactNode {
  const v = info.values[k];
  const style = (val: string) => setStyle(editor, STYLE_OF[k]!, val);
  const sizes = SIZE_CHOICES.map((s) => ({ v: s, title: SIZE_LABEL[s], text: s.toUpperCase() }));
  const aligns = ALIGN_CHOICES.map((a) => ({ v: a, title: ALIGN_TITLE[a], icon: ICON[a] }));
  switch (k) {
    case "stickyColor":
      return <Swatches key={k} id="ctx-sticky-color" label="Colour" value={v} colors={STICKIES} onPick={style} />;
    case "fillColor":
      return <Swatches key={k} id="ctx-fill-color" label="Fill" value={v} colors={FILLS} onPick={(c) => setFill(editor, c)} />;
    case "borderColor":
      return <Swatches key={k} id="ctx-border-color" label="Border" value={v} colors={INKS} onPick={style} />;
    case "color":
      return <Swatches key={k} id="ctx-color" label={info.types.includes("frame") && info.types.length === 1 ? "Background" : "Colour"}
        value={v} colors={INKS} onPick={style} />;
    case "stickyFontSize":
      return <Choice key={k} id="ctx-sticky-font-size" label="Font size" value={v}
        options={STICKY_SIZE_CHOICES.map((o) => ({ v: String(o.value), title: o.value ? `${o.value} px` : "Shrink to fit", text: o.label }))}
        onPick={(n) => setStickyFontSize(editor, Number(n))} />;
    case "labelSize":
    case "fontSize":
      return <Choice key={k} id={`ctx-${k}`} label="Font size" value={v} options={sizes} onPick={style} />;
    case "align":
    case "textAlign":
      return <Choice key={k} id={`ctx-${k}`} label="Alignment" value={v} options={aligns} onPick={style} />;
    case "geo":
      return <Choice key={k} id="ctx-geo" label="Shape" value={v}
        options={GEO_CHOICES.map((g) => ({ v: g, title: GEO_TITLE[g], icon: ICON[g] }))} onPick={style} />;
    case "arrowKind":
      return <Choice key={k} id="ctx-arrow-kind" label="Line" value={v}
        options={ARROW_KINDS.map((a) => ({ v: a, title: cap(a), icon: ICON[a] }))} onPick={(a) => setArrowLook(editor, a as never)} />;
    case "lineWidth":
      return <Choice key={k} id="ctx-lineWidth" label="Width" value={v}
        options={SIZE_CHOICES.map((s) => ({ v: s, title: SIZE_LABEL[s], icon: widthIcon(WIDTH_PX[s]) }))} onPick={style} />;
    case "dash":
      return <Choice key={k} id="ctx-dash" label="Style" value={v}
        options={DASH_CHOICES.map((d) => ({ v: d, title: cap(d), icon: ICON[d] }))} onPick={style} />;
    case "arrowheadStart":
    case "arrowheadEnd":
      return <Choice key={k} id={`ctx-${k}`} label={k === "arrowheadStart" ? "Start" : "End"} value={v}
        className={k === "arrowheadStart" ? "mirror" : ""}
        options={ARROWHEAD_CHOICES.map((h) => ({ v: h, title: cap(h), icon: ICON[`head_${h}` as keyof typeof ICON] }))} onPick={style} />;
    default:
      return null;
  }
}

/** What a popover's button shows: the current shape, colour, line… */
function face(id: GroupId, info: Info): ReactNode {
  const v = info.values;
  switch (id) {
    case "shape":
      return ICON[(v.geo as keyof typeof ICON) ?? "rectangle"] ?? ICON.rectangle;
    case "color": {
      if (info.keys.includes("stickyColor"))
        return <span className="aiwb-ctx-dot" style={{ background: v.stickyColor ? stickyHex(String(v.stickyColor)) : MIXED_BG }} />;
      if (info.keys.includes("fillColor") || info.keys.includes("borderColor")) {
        const fill = v.fillColor === "none" ? "transparent" : v.fillColor ? inkHex(String(v.fillColor), "fill") : MIXED_BG;
        const border = v.borderColor ? inkHex(String(v.borderColor)) : "#888";
        return <span className="aiwb-ctx-dot ring" style={{ background: fill, boxShadow: `inset 0 0 0 3px ${border}` }} />;
      }
      return <span className="aiwb-ctx-dot" style={{ background: v.color ? inkHex(String(v.color)) : MIXED_BG }} />;
    }
    case "text":
      return ICON.text;
    case "line":
      return v.arrowKind ? ICON[v.arrowKind as "straight"] : info.keys.includes("dash") && v.dash ? ICON[v.dash as "solid"] : ICON.line;
    case "ends":
      return ICON.ends;
    default:
      return null;
  }
}
const GROUP_TITLE: Record<string, string> = { shape: "Shape", color: "Colour", text: "Text", line: "Line", ends: "Arrowheads", more: "Arrange" };

function Popover({ group, anchor, bar, view, avoid, children }: {
  group: string; anchor: () => HTMLElement | null; bar: { left: number; top: number }; view: Size; avoid: readonly Box[]; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const a = anchor();
    if (!el || !a) return;
    const ax = bar.left + a.offsetLeft;
    const ay = bar.top + a.offsetTop;
    const p = placePopover({ minX: ax, minY: ay, maxX: ax + a.offsetWidth, maxY: ay + a.offsetHeight }, { w: el.offsetWidth, h: el.offsetHeight }, view, avoid);
    const next = { left: p.left - bar.left, top: p.top - bar.top };
    if (!pos || pos.left !== next.left || pos.top !== next.top) setPos(next);
  });
  return (
    <div ref={ref} className="aiwb-ctx-pop" data-testid="ctx-popover" data-group={group}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}>
      {children}
    </div>
  );
}

// --- the bar ----------------------------------------------------------------------------------------------------------
export function ContextBar() {
  const editor = useEditor();
  const info = useValue("context bar", () => read(editor), [editor]);
  const barRef = useRef<HTMLDivElement>(null);
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({});
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [open, setOpen] = useState<{ sel: string; id: string } | null>(null);
  // a popover belongs to the selection it was opened on: another selection closes it
  const openId = open && info && open.sel === info.selKey ? open.id : null;

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (el.offsetWidth !== size.w || el.offsetHeight !== size.h) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });

  useEffect(() => {
    if (!openId) return;
    const down = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Escape closes the popover only, the selection stays
      setOpen(null);
    };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [openId]);

  if (!info) return null;
  const avoid = obstacles(editor);
  const pos = placeBar(info.sel, size, info.view, avoid);
  const toggle = (id: string) => setOpen(openId === id ? null : { sel: info.selKey, id });
  const popover = (id: string, children: ReactNode) =>
    openId === id ? (
      <Popover group={id} anchor={() => anchors.current[id]} bar={pos} view={info.view} avoid={avoid}>{children}</Popover>
    ) : null;
  const trigger = (id: string, content: ReactNode) => (
    <button ref={(el) => { anchors.current[id] = el; }} data-testid={`ctx-pop-${id}`} title={GROUP_TITLE[id]}
      aria-expanded={openId === id} className={"aiwb-ctx-btn trig" + (openId === id ? " open" : "")} onClick={() => toggle(id)}>
      {content}{ICON.chevron}
    </button>
  );

  const parts: ReactNode[] = [];
  for (const g of groupsFor(info.keys)) {
    if (g.id === "name") {
      if (info.frameId) parts.push(
        <input key="name" data-testid="ctx-frame-name" className="aiwb-ctx-name" value={String(info.values.frameName ?? "")}
          placeholder="Frame name" title="Frame name"
          onFocus={() => editor.markHistoryStoppingPoint("ctx frame name")}
          onChange={(e) => setFrameName(editor, info.frameId as TLShapeId, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />,
      );
    } else if (g.id === "bold") {
      parts.push(
        <button key="bold" data-testid="ctx-bold" title="Bold" aria-pressed={!!info.values.bold}
          className={"aiwb-ctx-btn" + (info.values.bold ? " on" : "")} onClick={() => setBold(editor, !info.values.bold)}>{ICON.bold}</button>,
      );
    } else {
      parts.push(
        <span key={g.id} className="aiwb-ctx-group">
          {trigger(g.id, face(g.id, info))}
          {popover(g.id, g.keys.map((k) => control(editor, k, info)))}
        </span>,
      );
    }
  }

  const always = info.locked ? (
    <button key="lock" data-testid="ctx-lock" title="Unlock" className="aiwb-ctx-btn txt" onClick={() => toggleLock(editor)}>
      {ICON.unlock}<span>Unlock</span>
    </button>
  ) : (
    <>
      <span className="aiwb-ctx-group">
        {trigger("more", ICON.more)}
        {popover("more", (
          <>
            <div className="aiwb-ctx-sec" data-testid="ctx-order">
              <div className="aiwb-ctx-lbl">Order</div>
              <div className="aiwb-ctx-opts">
                <button data-testid="ctx-front" title="Bring to front" className="aiwb-ctx-btn"
                  onClick={() => act(editor, "front", (ids) => editor.bringToFront(ids))}>{ICON.front}</button>
                <button data-testid="ctx-back" title="Send to back" className="aiwb-ctx-btn"
                  onClick={() => act(editor, "back", (ids) => editor.sendToBack(ids))}>{ICON.back}</button>
              </div>
            </div>
            {info.align && (
              <div className="aiwb-ctx-sec" data-testid="ctx-align-shapes">
                <div className="aiwb-ctx-lbl">Align</div>
                <div className="aiwb-ctx-opts">
                  {(["left", "center-horizontal", "right", "top", "center-vertical", "bottom"] as const).map((a) => (
                    <button key={a} data-testid={`ctx-align-shapes-${a}`} title={`Align ${a.replace("-", " ")}`} className="aiwb-ctx-btn"
                      onClick={() => act(editor, "align", (ids) => editor.alignShapes(ids, a))}>{ICON[a]}</button>
                  ))}
                </div>
              </div>
            )}
            {info.align && (
              <div className="aiwb-ctx-sec" data-testid="ctx-distribute">
                <div className="aiwb-ctx-lbl">Distribute</div>
                <div className="aiwb-ctx-opts">
                  <button data-testid="ctx-distribute-h" disabled={!info.distribute}
                    title={info.distribute ? "Distribute horizontally" : "Distribute: select three or more"} className="aiwb-ctx-btn"
                    onClick={() => act(editor, "distribute", (ids) => editor.distributeShapes(ids, "horizontal"))}>{ICON.distributeH}</button>
                  <button data-testid="ctx-distribute-v" disabled={!info.distribute}
                    title={info.distribute ? "Distribute vertically" : "Distribute: select three or more"} className="aiwb-ctx-btn"
                    onClick={() => act(editor, "distribute", (ids) => editor.distributeShapes(ids, "vertical"))}>{ICON.distributeV}</button>
                </div>
              </div>
            )}
          </>
        ))}
      </span>
      <button data-testid="ctx-duplicate" title="Duplicate" className="aiwb-ctx-btn"
        onClick={() => act(editor, "duplicate", (ids) => editor.duplicateShapes(ids, { x: 20, y: 20 }))}>{ICON.duplicate}</button>
      <button data-testid="ctx-lock" title="Lock" className="aiwb-ctx-btn" onClick={() => toggleLock(editor)}>{ICON.lock}</button>
      <button data-testid="ctx-delete" title="Delete" className="aiwb-ctx-btn"
        onClick={() => act(editor, "delete", (ids) => editor.deleteShapes(ids))}>{ICON.delete}</button>
    </>
  );

  return (
    <div
      ref={barRef}
      className="aiwb-ctx"
      data-testid="aiwb-contexttoolbar"
      data-types={info.types.join(",")}
      data-controls={info.keys.join(",")}
      data-below={info.sel && pos.below ? "1" : "0"}
      style={{ left: pos.left, top: pos.top, visibility: size.w ? "visible" : "hidden" }}
      // the canvas must not see a press on the bar (no deselect, no pan); and a press does not take the focus (a text being
      // edited keeps it, and so do tldraw's keys), except in the frame name's input
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (!(e.target as HTMLElement).closest("input")) e.preventDefault(); }}
    >
      {parts}
      {parts.length > 0 && <span className="aiwb-ctx-sep" />}
      {always}
    </div>
  );
}
