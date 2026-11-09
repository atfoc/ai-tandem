// The hanging indent of the web chip input, its DOM side: finds the indented lines of the box, measures where their text is drawn, and
// gives the box's ::before float the size and shape hanging.ts computes from that (the why and the how are written there). No React here;
// ChipInput.web.tsx calls layoutHanging after every change of the box and when its width, its font or its tab width changed.
//
// What is written are three CSS custom properties on the box element, `--cin-hang-w`, `--cin-hang-h` and `--cin-hang-shape`, which the
// box's ::before rule reads (STYLES in ChipInput.web.tsx). React does not own them (they are not in its style object), and no node of the
// box is touched, so the browser's undo and the offset mapping see the box exactly as they did.
//
// A band shortens the lines beside it, so a line can wrap into more visual lines once the shape is on: the layout measures, applies and
// measures again until the bands stay the same (two passes in practice, six at most). The bands last applied to a box are kept, so a call
// when nothing changed costs one measuring pass and writes no style. Only lines that start with white space and have text after it are
// measured (a Range each, from their first unit that is not white space to their end): measuring every line costs too much in long boxes.
import { bandOf, hangOf, sameBands, type Band } from "./hanging.ts";

const PROPS = ["--cin-hang-w", "--cin-hang-h", "--cin-hang-shape"] as const;

/** The most passes of measure and apply in one layout (a layout that has not settled by then keeps its last shape). */
const MAX_PASSES = 6;

/** The bands applied to each box now. */
const applied = new WeakMap<HTMLElement, Band[]>();

const isWhite = (c: string) => c === " " || c === "\t" || c === "\u00a0";

/** A point in the box: before or after a node, or an offset in a text node. */
type Point = { node: Node; offset: number } | { before: Node } | { after: Node };

/** The lines of the box that start with white space and have something else after it: for each, a Range from before its first unit that
 *  is not white space to the end of its last unit. The box is read as textOf in ChipInput.web.tsx reads it: text character by character
 *  ("\n" ends a line, U+200B is nothing), a chip (an element with `data-ref`) one unit that is not white space, a <br> the end of a line,
 *  a <div> or <p> block (a paste of lines can leave them) the end of the line before it and of its own last line; other elements are read
 *  through. */
export function indentedLines(root: HTMLElement): Range[] {
  const out: Range[] = [];
  let indented = false, first: Point | null = null, end: Point | null = null, any = false;
  const close = () => {
    if (indented && first && end) {
      const r = document.createRange();
      if ("node" in first) r.setStart(first.node, first.offset); else if ("before" in first) r.setStartBefore(first.before); else r.setStartAfter(first.after);
      if ("node" in end) r.setEnd(end.node, end.offset); else if ("after" in end) r.setEndAfter(end.after); else r.setEndBefore(end.before);
      out.push(r);
    }
    indented = false; first = end = null; any = false;
  };
  /** One unit of the line: the first decides whether the line is indented, the first that is not white space is where its text starts. */
  const unit = (white: boolean, start: Point, after: Point) => {
    if (!any) { any = true; indented = white; }
    if (!indented) return;
    if (!white && !first) first = start;
    end = after;
  };
  const walk = (parent: Node) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        const s = (n as Text).data;
        for (let i = 0; i < s.length; i++) {
          const c = s[i]!;
          if (c === "\n") close();
          else if (c !== "\u200b") unit(isWhite(c), { node: n, offset: i }, { node: n, offset: i + 1 });
        }
      } else if (n.nodeType !== Node.ELEMENT_NODE) continue;
      else if ((n as HTMLElement).dataset?.ref) unit(false, { before: n }, { after: n });
      else if (n.nodeName === "BR") close();
      else if (n.nodeName === "DIV" || n.nodeName === "P") { close(); walk(n); close(); }
      else walk(n);
    }
  };
  walk(root);
  close();
  return out;
}

/** The bands of the box as it is drawn now. */
function measure(root: HTMLElement): Band[] {
  const cs = getComputedStyle(root), box = root.getBoundingClientRect();
  const padLeft = parseFloat(cs.paddingLeft) || 0, padRight = parseFloat(cs.paddingRight) || 0;
  const origin = { left: box.left + root.clientLeft + padLeft, top: box.top + root.clientTop + (parseFloat(cs.paddingTop) || 0) - root.scrollTop };
  const maxIndent = (root.clientWidth - padLeft - padRight) / 2;
  const bands: Band[] = [];
  for (const r of indentedLines(root)) {
    const band = bandOf(Array.from(r.getClientRects(), (c) => ({ top: c.top, bottom: c.bottom, left: c.left })), origin, maxIndent);
    if (band) bands.push(band);
  }
  return bands;
}

/** Gives the box's float the shape of these bands (none: the properties are removed). */
function apply(root: HTMLElement, bands: Band[]) {
  const hang = hangOf(bands);
  if (!hang) for (const p of PROPS) root.style.removeProperty(p);
  else {
    root.style.setProperty("--cin-hang-w", `${hang.width.toFixed(2)}px`);
    root.style.setProperty("--cin-hang-h", `${hang.height.toFixed(2)}px`);
    root.style.setProperty("--cin-hang-shape", hang.shape);
  }
  applied.set(root, bands);
}

/** Lays out the hanging indent of the box: on, its wrapped indented lines continue at their indent; off, the shape is removed (nothing is
 *  written if there was none). */
export function layoutHanging(root: HTMLElement, on: boolean): void {
  if (!on) {
    if (applied.has(root)) { for (const p of PROPS) root.style.removeProperty(p); applied.delete(root); }
    return;
  }
  let now = applied.get(root) ?? [];
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const bands = measure(root);
    if (sameBands(bands, now)) return;
    apply(root, bands);
    now = bands;
  }
}
