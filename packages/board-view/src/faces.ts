// The faces a request's text needs, loaded before Excalidraw measures it (8.1 of plans/headless-board/engine.md). A page measures
// text with whatever faces it has loaded: one that has not drawn a text of a font in a script yet measures it with a fallback font,
// and nothing corrects the size later (measured: 320.83 px for 353.26). Excalidraw puts its faces in document.fonts only when it
// shows a board, so every face it made (fonts.ts `madeFaces`) is put there first; document.fonts.load then fetches the pieces by
// unicode-range. DOM-free: with no `document.fonts` (Node, a stand-in page whose `load` resolves at once) there is nothing to wait for.
import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";

const NAMES: Record<number, string> = Object.fromEntries(Object.entries(FONT_FAMILY).map(([k, v]) => [v, k]));
const BY_STYLE: Record<string, number | undefined> = { hand: FONT_FAMILY.Excalifont, normal: FONT_FAMILY.Nunito, code: FONT_FAMILY["Comic Shanns"] };

type Texty = { type?: unknown; isDeleted?: unknown; fontFamily?: unknown; text?: unknown };

/** The families and the text of a request (`apply` params or a list of refs) and of the live text elements it may re-measure.
 *  Nunito, the normal font, is always among the families: it is the font of a text that names none. */
export function needs(params: unknown, elements: readonly Texty[]): { families: number[]; text: string } {
  const families = new Set<number>([FONT_FAMILY.Nunito]);
  const texts: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "fontFamily") { const id = typeof x === "string" ? BY_STYLE[x] : x; if (typeof id === "number") families.add(id); }
      else if ((k === "text" || k === "label" || k === "name") && typeof x === "string") texts.push(x);
      else walk(x);
    }
  };
  walk(params);
  for (const e of elements) if (!e.isDeleted && e.type === "text") { if (typeof e.fontFamily === "number") families.add(e.fontFamily); if (typeof e.text === "string") texts.push(e.text); }
  return { families: [...families], text: texts.join("") };
}

/** Puts every face Excalidraw made in document.fonts and loads, for each family the request uses, the pieces its text needs. */
export async function loadFaces(made: readonly FontFace[], params: unknown, elements: readonly Texty[]): Promise<void> {
  const fonts = (globalThis as { document?: Document }).document?.fonts;
  if (!fonts) return;
  const { families, text } = needs(params, elements);
  if (!text) return;
  // Excalidraw makes its FontFaces the first time it needs a font's metrics: one text element makes it do so before the first
  // request measures anything
  if (!made.length) convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: "x" }] as never);
  // (not one that failed to parse, as a `local:` family's can: Excalidraw leaves those out of document.fonts too, and its own load of a
  // font string that names one would reject)
  for (const f of made) if (f.status !== "error" && !fonts.has(f)) fonts.add(f);
  // (Excalifont's Chinese, Japanese and Korean pieces are Xiaolai's, which is the same text in another family name)
  const names = families.map((id) => NAMES[id]).filter(Boolean).flatMap((n) => (n === "Excalifont" ? [n, "Xiaolai"] : [n]));
  await Promise.all(names.map((n) => fonts.load(`16px "${n}"`, text).catch(() => [])));
}
