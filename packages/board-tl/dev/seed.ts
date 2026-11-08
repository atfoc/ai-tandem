// TEMPORARY (deleted at the end of the window lane): mock elements for the dev page (no server). Called by the entry once the
// fonts are loaded, so the stickies' fit measures the real font.
import { createShapeId, toRichText, type Editor } from "tldraw";
import { STICKY_TYPE } from "../src/model/palette.ts";
import { ROUNDED_RECT } from "../src/model/styles.ts";

export function seed(editor: Editor) {
  const id = (n: string) => createShapeId(n);
  const shape = { font: "sans", dash: "solid" } as const;
  editor.run(() => {
    editor.createShapes([
      { id: id("frame"), type: "frame", x: -40, y: -60, props: { w: 760, h: 320, name: "Sprint", color: "light-blue" } },
      { id: id("s1"), type: STICKY_TYPE, x: 0, y: 0, props: { richText: toRichText("Idea") } },
      { id: id("s2"), type: STICKY_TYPE, x: 240, y: 0, props: { color: "light-green", richText: toRichText("The quick brown fox jumps over the lazy dog, and then writes a much longer note than anyone should put on one sticky, so the text has to shrink to fit") } },
      { id: id("s3"), type: STICKY_TYPE, x: 480, y: 0, props: { color: "light-pink", richText: toRichText("Ship it") } },
      { id: id("r1"), type: "geo", x: 0, y: 400, props: { ...shape, geo: "rectangle", w: 200, h: 100, richText: toRichText("API"), fill: "fill", fillColor: "light-blue", color: "blue" } },
      { id: id("e1"), type: "geo", x: 400, y: 400, props: { ...shape, geo: "ellipse", w: 180, h: 120, richText: toRichText("DB"), fill: "fill", fillColor: "light-green", color: "green", size: "l" } },
      { id: id("q1"), type: "geo", x: 200, y: 560, props: { ...shape, geo: ROUNDED_RECT as never, w: 220, h: 90, richText: toRichText("Rounded, big label"), fill: "fill", fillColor: "yellow", color: "black", labelSize: "l" } },
      { id: id("t1"), type: "text", x: 0, y: 700, props: { font: "sans", richText: toRichText("Free text, no box"), autoSize: true } },
      { id: id("a1"), type: "arrow", x: 200, y: 450, props: { dash: "solid", start: { x: 0, y: 0 }, end: { x: 200, y: 10 } } },
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
