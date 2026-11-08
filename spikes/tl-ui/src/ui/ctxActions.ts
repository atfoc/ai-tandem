// What the contextual toolbar does to the board. Every change is one undo step: a history stopping point, then the editor
// API. Style props go through tldraw's own "style for the selection" (and become the style of the next shape, as tldraw's
// style panel does); the props that are not styles (the sticky's fontSize, the frame's name, the arrow's bend, bold in
// the rich text) go through `updateShapes`.
import { ArrowShapeKindStyle } from "tldraw";
import type { Editor, StyleProp, TLArrowShape, TLRichText, TLShape, TLShapeId } from "tldraw";

export function setStyle<T>(editor: Editor, style: StyleProp<T>, value: T) {
  editor.markHistoryStoppingPoint("ctx style");
  editor.setStyleForSelectedShapes(style, value);
  editor.setStyleForNextShapes(style, value);
}

/** The sticky's font size: 0 = shrink to fit, else a fixed size in px (the sticky's own prop, not a style). */
export function setStickyFontSize(editor: Editor, fontSize: number) {
  editor.markHistoryStoppingPoint("ctx sticky font size");
  const shapes = editor.getSelectedShapes().filter((s) => s.type === "sticky");
  editor.updateShapes(shapes.map((s) => ({ id: s.id, type: "sticky", props: { fontSize } }) as any));
}

/** Straight and curved are tldraw's `arc` kind with and without a bend; elbow is its own kind. */
export type ArrowLook = "straight" | "curved" | "elbow";
export function arrowLook(a: TLArrowShape): ArrowLook {
  if (a.props.kind === "elbow") return "elbow";
  return Math.abs(a.props.bend) < 0.5 ? "straight" : "curved";
}
export function setArrowLook(editor: Editor, look: ArrowLook) {
  editor.markHistoryStoppingPoint("ctx arrow kind");
  const arrows = editor.getSelectedShapes().filter((s): s is TLArrowShape => s.type === "arrow");
  editor.updateShapes(
    arrows.map((a) => {
      const len = Math.hypot(a.props.end.x - a.props.start.x, a.props.end.y - a.props.start.y);
      const bend = look === "curved" ? (arrowLook(a) === "curved" ? a.props.bend : Math.max(20, len * 0.2)) : 0;
      return { id: a.id, type: "arrow" as const, props: { kind: look === "elbow" ? ("elbow" as const) : ("arc" as const), bend } };
    }),
  );
  // the next arrow drawn takes the same kind (straight and curved are both `arc`: a new arrow starts straight)
  editor.setStyleForNextShapes(ArrowShapeKindStyle, look === "elbow" ? "elbow" : "arc");
}

/** The frame's name; called on each keystroke, after one `markHistoryStoppingPoint` when the input got the focus, so an
 *  edit of the name is one undo step. */
export function setFrameName(editor: Editor, id: TLShapeId, name: string) {
  editor.updateShapes([{ id, type: "frame", props: { name } }]);
}

// --- bold for a whole text shape, without tldraw's rich text toolbar: the TipTap JSON's text nodes get or lose the
// `bold` mark (the same mark TipTap's StarterKit writes when you press ⌘B in the text).
type Node = { type: string; text?: string; marks?: { type: string }[]; content?: Node[] };
function texts(n: Node, out: Node[] = []): Node[] {
  if (n.type === "text") out.push(n);
  n.content?.forEach((c) => texts(c, out));
  return out;
}
export function isAllBold(rt: TLRichText): boolean {
  const t = texts(rt as unknown as Node);
  return t.length > 0 && t.every((n) => n.marks?.some((m) => m.type === "bold"));
}
function withBold(n: Node, bold: boolean): Node {
  if (n.type === "text") {
    const marks = (n.marks ?? []).filter((m) => m.type !== "bold");
    if (bold) marks.push({ type: "bold" });
    const { marks: _drop, ...rest } = n;
    return marks.length ? { ...rest, marks } : rest;
  }
  return n.content ? { ...n, content: n.content.map((c) => withBold(c, bold)) } : n;
}
export function setBold(editor: Editor, bold: boolean) {
  editor.markHistoryStoppingPoint("ctx bold");
  const shapes = editor.getSelectedShapes().filter((s) => s.type === "text") as Extract<TLShape, { type: "text" }>[];
  editor.updateShapes(
    shapes.map((s) => ({ id: s.id, type: "text" as const, props: { richText: withBold(s.props.richText as unknown as Node, bold) as unknown as TLRichText } })),
  );
}

// --- the actions every selection has
export function act(editor: Editor, name: string, f: (ids: TLShapeId[]) => void) {
  editor.markHistoryStoppingPoint("ctx " + name);
  f(editor.getSelectedShapeIds());
}
