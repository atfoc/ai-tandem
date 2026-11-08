// Mock data for the spike page: a few elements of each kind (no server).
import { DefaultFontFaces, createShapeId, toRichText, type Editor } from "tldraw";

/** The sticky's fit measures with the font, so the faces of the sans font are loaded before any text is fitted (otherwise
 *  the first fit measures a fallback font and stores a wrong size). board-tl does this before it shows a board. */
export async function fontsReady(editor: Editor) {
  const sans = DefaultFontFaces.tldraw_sans;
  await Promise.all([sans.normal.normal, sans.normal.bold, sans.italic.normal, sans.italic.bold].map((f) => editor.fonts.ensureFontIsLoaded(f)));
}

export async function seed(editor: Editor) {
  await fontsReady(editor);
  const id = (n: string) => createShapeId(n);
  editor.run(() => {
    editor.createShapes([
      { id: id("frame"), type: "frame", x: -40, y: -60, props: { w: 760, h: 320, name: "Sprint" } },
      { id: id("s1"), type: "sticky", x: 0, y: 0, props: { richText: toRichText("Idea") } },
      { id: id("s2"), type: "sticky", x: 240, y: 0, props: { color: "light-green", richText: toRichText("The quick brown fox jumps over the lazy dog, and then writes a much longer note than anyone should put on one sticky, so the text has to shrink to fit") } },
      { id: id("s3"), type: "sticky", x: 480, y: 0, props: { color: "light-pink", richText: toRichText("Ship it") } },
      { id: id("r1"), type: "geo", x: 0, y: 400, props: { geo: "rectangle", w: 200, h: 100, richText: toRichText("API"), fill: "solid", color: "blue" } },
      { id: id("e1"), type: "geo", x: 400, y: 400, props: { geo: "ellipse", w: 180, h: 120, richText: toRichText("DB"), fill: "semi", color: "green" } },
      { id: id("t1"), type: "text", x: 0, y: 580, props: { richText: toRichText("Free text, no box"), autoSize: true } },
      { id: id("a1"), type: "arrow", x: 200, y: 450, props: { start: { x: 0, y: 0 }, end: { x: 200, y: 10 } } },
    ]);
    for (const s of ["s1", "s2", "s3"]) editor.reparentShapes([id(s)], id("frame"));
    editor.createBindings([
      { type: "arrow", fromId: id("a1"), toId: id("r1"), props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
      { type: "arrow", fromId: id("a1"), toId: id("e1"), props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
    ]);
  });
  editor.clearHistory();
  editor.zoomToFit({ animation: { duration: 0 } });
}
