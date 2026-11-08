// Our sticky's shrink-to-fit (`fitted`) and our geo's `labelSize` (`growY`) on the board host's editor (linkedom + skia-canvas
// measuring) store what Chromium stored (reference.ts STICKY_REFERENCE; goal 3.5, 4.12). The shapes are made as apply.ts makes
// them: editor.createShapes, so the sticky's onBeforeCreate fits and the geo measures its label.
// (first: the page before any tldraw module, as in src/bin.ts)
import "../src/node/install-page.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createShapeId, toRichText } from "tldraw";
import { TEXTS } from "../../board-tl/src/model/corpus.ts";
import { STICKY_FONT_SIZES } from "../../board-tl/src/model/palette.ts";
import { loadRuntime } from "../src/node/runtime.ts";
import { STICKY_TYPE } from "../src/schema.ts";
import { STICKY_REFERENCE } from "./reference.ts";

test("stickies and our geo store what Chromium stored (fitted, growY)", async () => {
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  try {
    const got: Record<string, Record<string, number>> = {};
    for (const caseId of Object.keys(STICKY_REFERENCE)) {
      const [kind, tid, a, b] = caseId.split(":");
      const id = createShapeId();
      const richText = toRichText(TEXTS[tid]);
      if (kind === "sticky") {
        const w = Number(a);
        const fontSize = b === "auto" ? 0 : STICKY_FONT_SIZES[b as keyof typeof STICKY_FONT_SIZES];
        editor.createShapes([{ id, type: STICKY_TYPE, x: 0, y: 0, props: { font: "sans", w, h: w, richText, fontSize } } as never]);
        const p = editor.getShape(id)!.props as { fitted: number; w: number; h: number };
        got[caseId] = { fitted: p.fitted, w: p.w, h: p.h };
      } else {
        editor.createShapes([{ id, type: "geo", x: 0, y: 0, props: { font: "sans", dash: "solid", geo: "rectangle", w: 200, h: 100, richText, labelSize: a } } as never]);
        const p = editor.getShape(id)!.props as { growY: number; w: number; h: number };
        got[caseId] = { growY: Math.round(p.growY * 1000) / 1000, w: p.w, h: p.h };
      }
      editor.deleteShapes([id]);
    }
    assert.deepEqual(got, STICKY_REFERENCE);
  } finally {
    editor.dispose();
  }
});
