// The context bar (goal 3.3, 7.3; lifted from the UI spike's ContextToolbar.tsx): it sits above the selection's screen bounds
// (below them near the top edge), follows pan, zoom and moves (useValue on the editor), is hidden while a gesture is under way
// (BUSY_STATES), and shows what fits the selection. Which controls: `SECTIONS` per shape type; for a selection of several
// types, the controls every type has (with tldraw's shared value, or none for "mixed"), plus align and distribute. Every
// change is one undo step (contextActions.ts). The controls are plain buttons and selects (a prototype); spike-ui-ctx.md has
// the mapping.
//
// A shape (geo) has a fill colour (our `fillColor`) separate from its border colour (tldraw's `color`), and a text size (our
// `labelSize`) separate from its border width (tldraw's `size`): model/styles.ts.
import {
  ArrowShapeArrowheadEndStyle,
  ArrowShapeArrowheadStartStyle,
  DEFAULT_THEME,
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultHorizontalAlignStyle,
  DefaultSizeStyle,
  DefaultTextAlignStyle,
  GeoShapeGeoStyle,
  useEditor,
  useValue,
  type Editor,
  type StyleProp,
  type TLArrowShape,
  type TLFrameShape,
  type TLShape,
  type TLTextShape,
} from "tldraw";
import { STICKY_FONT_SIZES, STICKY_NAMES, STICKY_TYPE } from "../model/palette.ts";
import { FillColorStyle, LabelSizeStyle, StickyColorStyle, stickyHex } from "../model/styles.ts";
import { act, arrowLook, isAllBold, setArrowLook, setBold, setFrameName, setStickyFontSize, setStyle, type ArrowLook } from "./contextActions.ts";

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

// --- the controls -------------------------------------------------------------------------------------------------
type ColorKey = "stickyColor" | "color" | "fillColor" | "borderColor";
type StyleKey =
  | ColorKey | "geo" | "fill" | "size" | "borderWidth" | "labelSize" | "dash" | "align" | "textAlign" | "arrowheadStart" | "arrowheadEnd";
type Key = StyleKey | "stickyFontSize" | "bold" | "arrowKind" | "frameName"; // the last four: the shape's own props, not styles

const SIZE_VALUES = () => ["s", "m", "l", "xl"];
const STYLE: Record<StyleKey, { style: StyleProp<any>; label: string; values?: () => readonly string[] }> = {
  // the sticky's colour is its own style prop (styles.ts: tldraw keeps one "next" value per style prop)
  stickyColor: { style: StickyColorStyle, label: "Colour" },
  color: { style: DefaultColorStyle, label: "Colour" },
  fillColor: { style: FillColorStyle, label: "Fill colour" },
  borderColor: { style: DefaultColorStyle, label: "Border colour" },
  geo: { style: GeoShapeGeoStyle, label: "Shape", values: () => GeoShapeGeoStyle.values },
  fill: { style: DefaultFillStyle, label: "Fill", values: () => ["fill", "none", "semi", "solid", "pattern", "lined-fill"] },
  // text, arrow, pen: tldraw's size (a text's font size, a line's width)
  size: { style: DefaultSizeStyle, label: "Size", values: SIZE_VALUES },
  // a shape: tldraw's size is its border width only; its text size is our labelSize
  borderWidth: { style: DefaultSizeStyle, label: "Border", values: SIZE_VALUES },
  labelSize: { style: LabelSizeStyle, label: "Text", values: SIZE_VALUES },
  dash: { style: DefaultDashStyle, label: "Line", values: () => ["solid", "dashed", "dotted", "draw"] },
  align: { style: DefaultHorizontalAlignStyle, label: "Align text", values: () => ["start", "middle", "end"] },
  textAlign: { style: DefaultTextAlignStyle, label: "Align text", values: () => ["start", "middle", "end"] },
  arrowheadStart: { style: ArrowShapeArrowheadStartStyle, label: "Start", values: () => ArrowShapeArrowheadStartStyle.values },
  arrowheadEnd: { style: ArrowShapeArrowheadEndStyle, label: "End", values: () => ArrowShapeArrowheadEndStyle.values },
};

/** What each shape type shows (goal 3.3). */
const SECTIONS: Record<string, Key[]> = {
  [STICKY_TYPE]: ["stickyColor", "stickyFontSize", "align"],
  geo: ["geo", "fill", "fillColor", "borderColor", "borderWidth", "dash", "labelSize", "align"],
  text: ["size", "color", "textAlign", "bold"],
  arrow: ["arrowKind", "dash", "size", "color", "arrowheadStart", "arrowheadEnd"],
  frame: ["frameName", "color"],
  draw: ["color", "size", "dash"],
};

/** 0 = auto (shrink to fit), then the px of the agent's sizes (palette.ts), so what a person picks reads back as a Size. */
const STICKY_SIZES = [0, ...Object.values(STICKY_FONT_SIZES)];
const THEME_COLORS = DEFAULT_THEME.colors.light as unknown as Record<string, Record<string, string> | string>;
const TL_COLORS = Object.keys(THEME_COLORS).filter((k) => typeof THEME_COLORS[k] === "object");
/** A swatch as the colour is drawn: a sticky's own hex; a fill colour as tldraw draws `fill: "fill"`; else the solid ink. */
function swatchHex(key: ColorKey, c: string): string {
  if (key === "stickyColor") return stickyHex(c);
  const entry = THEME_COLORS[c];
  if (typeof entry !== "object") return "#ccc";
  return (key === "fillColor" ? entry.fill : entry.solid) ?? "#ccc";
}
const COLOR_NAMES: Record<ColorKey, () => readonly string[]> = {
  stickyColor: () => STICKY_NAMES,
  color: () => TL_COLORS,
  fillColor: () => FillColorStyle.values,
  borderColor: () => TL_COLORS,
};
const COLOR_TESTID: Record<ColorKey, string> = {
  stickyColor: "ctx-sticky-color",
  color: "ctx-color",
  fillColor: "ctx-fill-color",
  borderColor: "ctx-border-color",
};

// --- what the bar reads ---------------------------------------------------------------------------------------------
function read(editor: Editor) {
  if (editor.getCurrentToolId() !== "select") return null;
  if (editor.isInAny(...BUSY_STATES)) return null;
  const shapes = editor.getSelectedShapes();
  if (shapes.length === 0) return null;
  const b = editor.getSelectionRotatedScreenBounds();
  if (!b) return null;
  const types = [...new Set(shapes.map((s) => s.type))];
  // the controls every selected type has, in the order of the first type's section
  const lists = types.map((t) => SECTIONS[t] ?? []);
  const keys = lists[0].filter((k) => lists.every((l) => l.includes(k)));
  const shared = editor.getSharedStyles();
  const values: Partial<Record<Key, string | number | boolean | null>> = {};
  for (const k of keys) {
    if (k in STYLE) {
      const v = shared.get(STYLE[k as StyleKey].style);
      values[k] = v?.type === "shared" ? (v.value as string) : null; // null: mixed
    }
  }
  const one = <T,>(f: (s: TLShape) => T): T | null => {
    const vs = [...new Set(shapes.map(f))];
    return vs.length === 1 ? vs[0] : null;
  };
  if (keys.includes("stickyFontSize")) values.stickyFontSize = one((s) => (s.props as { fontSize?: number }).fontSize ?? null);
  if (keys.includes("bold")) values.bold = shapes.every((s) => isAllBold((s as TLTextShape).props.richText));
  if (keys.includes("arrowKind")) values.arrowKind = one((s) => arrowLook(s as TLArrowShape));
  if (keys.includes("frameName")) values.frameName = shapes.length === 1 ? (shapes[0] as TLFrameShape).props.name : null;
  const below = b.minY < 90; // no room above: under the selection
  return {
    x: b.midX,
    y: below ? b.maxY : b.minY,
    below,
    types,
    count: shapes.length,
    frameId: shapes.length === 1 && shapes[0].type === "frame" ? shapes[0].id : null,
    locked: shapes.every((s) => s.isLocked),
    keys: shapes.every((s) => s.isLocked) ? [] : keys,
    values,
  };
}

// --- the view -----------------------------------------------------------------------------------------------------
function Select({ id, label, value, options, onChange }: {
  id: string; label: string; value: string | null; options: readonly { v: string; t: string }[]; onChange: (v: string) => void;
}) {
  return (
    <label className="ctl" title={label}>
      <span>{label}</span>
      <select data-testid={id} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        {value === null && <option value="">mixed</option>}
        {options.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}
      </select>
    </label>
  );
}

export function ContextBar() {
  const editor = useEditor();
  const info = useValue("context bar", () => read(editor), [editor]);
  if (!info) return null;
  const { values } = info;
  const controls = info.keys.map((k) => {
    switch (k) {
      case "stickyColor":
      case "color":
      case "fillColor":
      case "borderColor": {
        return (
          <span key={k} className="group" data-testid={COLOR_TESTID[k]} title={STYLE[k].label}>
            {COLOR_NAMES[k]().map((c) => (
              <button
                key={c}
                title={c}
                data-testid={`color-${c}`}
                className={"swatch" + (values[k] === c ? " on" : "")}
                style={{ background: swatchHex(k, c) }}
                onClick={() => setStyle(editor, STYLE[k].style, c)}
              />
            ))}
          </span>
        );
      }
      case "stickyFontSize":
        return (
          <Select key={k} id="ctx-sticky-font-size" label="Text" value={values.stickyFontSize == null ? null : String(values.stickyFontSize)}
            options={STICKY_SIZES.map((n) => ({ v: String(n), t: n === 0 ? "Auto" : `${n}px` }))}
            onChange={(v) => setStickyFontSize(editor, Number(v))} />
        );
      case "bold":
        return (
          <button key={k} data-testid="ctx-bold" aria-pressed={!!values.bold} className={values.bold ? "on" : ""}
            style={{ fontWeight: 700 }} onClick={() => setBold(editor, !values.bold)}>B</button>
        );
      case "arrowKind":
        return (
          <Select key={k} id="ctx-arrow-kind" label="Kind" value={(values.arrowKind as string) ?? null}
            options={["straight", "curved", "elbow"].map((v) => ({ v, t: v }))}
            onChange={(v) => setArrowLook(editor, v as ArrowLook)} />
        );
      case "frameName":
        return info.frameId ? (
          <input key={k} data-testid="ctx-frame-name" className="name" value={(values.frameName as string) ?? ""} placeholder="Frame name"
            onFocus={() => editor.markHistoryStoppingPoint("ctx frame name")}
            onChange={(e) => setFrameName(editor, info.frameId!, e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur(); }} />
        ) : null;
      default: {
        const s = STYLE[k];
        return (
          <Select key={k} id={`ctx-${k}`} label={s.label} value={(values[k] as string) ?? null}
            options={(s.values?.() ?? []).filter((v) => !v.endsWith("-legacy")).map((v) => ({ v, t: v }))}
            onChange={(v) => setStyle(editor, s.style, v)} />
        );
      }
    }
  });
  const multi = info.count > 1 && !info.locked;
  return (
    <div
      className={"aiwb-contexttoolbar" + (info.below ? " below" : "")}
      data-testid="aiwb-contexttoolbar"
      data-types={info.types.join(",")}
      data-controls={info.keys.join(",")}
      style={{ left: info.x, top: info.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {controls}
      {multi && (
        <span className="group" data-testid="ctx-arrange">
          <Select id="ctx-align-shapes" label="Align" value={null}
            options={["left", "center-horizontal", "right", "top", "center-vertical", "bottom"].map((v) => ({ v, t: v }))}
            onChange={(v) => act(editor, "align", (ids) => editor.alignShapes(ids, v as any))} />
          <button data-testid="ctx-distribute-h" disabled={info.count < 3} title="Distribute horizontally"
            onClick={() => act(editor, "distribute", (ids) => editor.distributeShapes(ids, "horizontal"))}>↔</button>
          <button data-testid="ctx-distribute-v" disabled={info.count < 3} title="Distribute vertically"
            onClick={() => act(editor, "distribute", (ids) => editor.distributeShapes(ids, "vertical"))}>↕</button>
        </span>
      )}
      <span className="group" data-testid="ctx-always">
        {!info.locked && <button data-testid="ctx-front" title="Bring to front" onClick={() => act(editor, "front", (ids) => editor.bringToFront(ids))}>Front</button>}
        {!info.locked && <button data-testid="ctx-back" title="Send to back" onClick={() => act(editor, "back", (ids) => editor.sendToBack(ids))}>Back</button>}
        {!info.locked && (
          <button data-testid="ctx-duplicate" onClick={() => act(editor, "duplicate", (ids) => {
            editor.duplicateShapes(ids, { x: 20, y: 20 }); // selects the copies
          })}>Duplicate</button>
        )}
        <button data-testid="ctx-lock" onClick={() => act(editor, "lock", (ids) => {
          editor.toggleLock(ids); // tldraw deselects what it locks; keep it selected so Unlock stays at hand
          editor.select(...ids);
        })}>{info.locked ? "Unlock" : "Lock"}</button>
        {!info.locked && <button data-testid="ctx-delete" onClick={() => act(editor, "delete", (ids) => editor.deleteShapes(ids))}>Delete</button>}
      </span>
    </div>
  );
}
