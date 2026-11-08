// What the context bar (ContextBar.tsx) does to the board. Every change is one undo step: a history stopping point, then the
// editor API. Style props go through tldraw's own "style for the selection" and become the style of the next shape (what
// tldraw's style panel does); the props that are not styles (the sticky's fontSize, the frame's name, the arrow's bend, bold in
// the rich text) go through `updateShapes`. Which control is which style: `STYLE_OF`.
import {
  ArrowShapeArrowheadEndStyle,
  ArrowShapeArrowheadStartStyle,
  ArrowShapeKindStyle,
  DefaultColorStyle,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultHorizontalAlignStyle,
  DefaultSizeStyle,
  DefaultTextAlignStyle,
  GeoShapeGeoStyle,
  type Editor,
  type StyleProp,
  type TLArrowShape,
  type TLShapeId,
  type TLTextShape,
} from "tldraw";
import { STICKY_TYPE } from "../model/palette.ts";
import { FillColorStyle, LabelSizeStyle, StickyColorStyle } from "../model/styles.ts";
import { curvedBend, withBold, type ArrowLook, type Key } from "./ctxModel.ts";

/** The style prop behind each control that is one (fillColor is two: `setFill`). */
export const STYLE_OF: Partial<Record<Key, StyleProp<any>>> = {
  stickyColor: StickyColorStyle,
  align: DefaultHorizontalAlignStyle,
  geo: GeoShapeGeoStyle,
  borderColor: DefaultColorStyle,
  lineWidth: DefaultSizeStyle,
  dash: DefaultDashStyle,
  labelSize: LabelSizeStyle,
  color: DefaultColorStyle,
  fontSize: DefaultSizeStyle,
  textAlign: DefaultTextAlignStyle,
  arrowheadStart: ArrowShapeArrowheadStartStyle,
  arrowheadEnd: ArrowShapeArrowheadEndStyle,
};

function style<T>(editor: Editor, s: StyleProp<T>, value: T) {
  editor.setStyleForSelectedShapes(s, value);
  editor.setStyleForNextShapes(s, value);
}

export function setStyle<T>(editor: Editor, s: StyleProp<T>, value: T) {
  editor.markHistoryStoppingPoint("ctx style");
  style(editor, s, value);
}

/** A shape's fill: "none", or a colour (tldraw's `fill: "fill"`, which draws our fill colour itself). One undo step. */
export function setFill(editor: Editor, value: string) {
  editor.markHistoryStoppingPoint("ctx fill");
  if (value === "none") return style(editor, DefaultFillStyle, "none");
  style(editor, DefaultFillStyle, "fill");
  style(editor, FillColorStyle, value as never);
}

/** The sticky's font size: 0 = shrink to fit, else a fixed size in px (the sticky's own prop, not a style). */
export function setStickyFontSize(editor: Editor, fontSize: number) {
  editor.markHistoryStoppingPoint("ctx sticky font size");
  const shapes = editor.getSelectedShapes().filter((s) => s.type === STICKY_TYPE);
  editor.updateShapes(shapes.map((s) => ({ id: s.id, type: STICKY_TYPE, props: { fontSize } })));
}

/** Straight and curved are tldraw's `arc` kind with and without a bend; elbow is its own kind. */
export function setArrowLook(editor: Editor, look: ArrowLook) {
  editor.markHistoryStoppingPoint("ctx arrow kind");
  const arrows = editor.getSelectedShapes().filter((s): s is TLArrowShape => s.type === "arrow");
  editor.updateShapes(
    arrows.map((a) => ({
      id: a.id,
      type: "arrow" as const,
      props: { kind: look === "elbow" ? ("elbow" as const) : ("arc" as const), bend: look === "curved" ? curvedBend(a.props) : 0 },
    })),
  );
  // the next arrow drawn takes the same kind (straight and curved are both `arc`: a new arrow starts straight)
  editor.setStyleForNextShapes(ArrowShapeKindStyle, look === "elbow" ? "elbow" : "arc");
}

/** The frame's name; called on each keystroke, after one `markHistoryStoppingPoint` when the input got the focus, so an edit
 *  of the name is one undo step. */
export function setFrameName(editor: Editor, id: TLShapeId, name: string) {
  editor.updateShapes([{ id, type: "frame", props: { name } }]);
}

/** Bold for whole texts, without tldraw's rich text toolbar (ctxModel.ts `withBold`). */
export function setBold(editor: Editor, bold: boolean) {
  editor.markHistoryStoppingPoint("ctx bold");
  const shapes = editor.getSelectedShapes().filter((s): s is TLTextShape => s.type === "text");
  editor.updateShapes(shapes.map((s) => ({ id: s.id, type: "text" as const, props: { richText: withBold(s.props.richText, bold) } })));
}

/** An action on the selection's ids (arrange, duplicate, lock, delete), one undo step. */
export function act(editor: Editor, name: string, f: (ids: TLShapeId[]) => void) {
  editor.markHistoryStoppingPoint("ctx " + name);
  f(editor.getSelectedShapeIds());
}

export function toggleLock(editor: Editor) {
  act(editor, "lock", (ids) => {
    editor.toggleLock(ids); // tldraw deselects what it locks; keep it selected so Unlock stays at hand
    editor.select(...ids);
  });
}
