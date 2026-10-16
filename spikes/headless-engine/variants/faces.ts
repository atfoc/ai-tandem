// SPIKE VARIANT (work package E2): the faces a request's text needs, loaded before Excalidraw measures it. A page measures text
// with whatever faces it has loaded: one that has not drawn a text of a font in a script yet measures it with a fallback font,
// and nothing corrects the size later (measured: 320.83 px for 353.26). Excalidraw puts its faces in document.fonts only when it
// shows a board, so every face it made (fonts.ts) is put there first; document.fonts.load then fetches the pieces by
// unicode-range. In Node the stand-in page's document.fonts.load resolves at once: the same code, nothing to wait for.
import { convertToExcalidrawElements, FONT_FAMILY } from "@excalidraw/excalidraw";

const NAMES: Record<number, string> = Object.fromEntries(Object.entries(FONT_FAMILY).map(([k, v]) => [v, k]));
const BY_STYLE: Record<string, number> = { hand: FONT_FAMILY.Excalifont, normal: FONT_FAMILY.Nunito, code: FONT_FAMILY["Comic Shanns"] };

/** The families and the text of a request (`apply` params or a list of refs) and of the live text elements it may re-measure. */
export function needs(params: unknown, elements: readonly { type?: unknown; isDeleted?: unknown; fontFamily?: unknown; text?: unknown }[]) {
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
export async function loadFaces(made: readonly FontFace[], params: unknown, elements: Parameters<typeof needs>[1]): Promise<void> {
  const fonts = (globalThis as { document?: Document }).document?.fonts;
  if (!fonts) return;
  const { families, text } = needs(params, elements);
  if (!text) return;
  // Excalidraw makes its FontFaces the first time it needs a font's metrics: one text element makes it do so before the first
  // request measures anything
  if (!made.length) convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: "x" }] as never);
  for (const f of made) if (!fonts.has(f)) fonts.add(f);
  const names = families.map((id) => NAMES[id]).filter(Boolean).flatMap((n) => (n === "Excalifont" ? [n, "Xiaolai"] : [n]));
  await Promise.all(names.map((n) => fonts.load(`16px "${n}"`, text).catch(() => [])));
}
