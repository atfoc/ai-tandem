// The main toolbar's and zoom controls' logic (src/view/MainToolbar.tsx, Zoom.tsx) and the tools of navigation.ts: which
// button a tool lights, the remembered shape type, the shortcuts added to tldraw's, the zoom limits, the state overrides.
// What they do on a page was looked at in a browser (plans/better-board/win-view.md, T2a), not here.
import "./tsx-hook.ts";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import assert from "node:assert/strict";

// the components import their CSS (esbuild bundles it); in Node a stylesheet is an empty module
registerHooks({
  load(url, context, next) {
    return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
  },
});

const { SHAPE_TYPES, TOOL_BUTTONS, UI_OVERRIDES, activeButton, shownGeo } = await import("../src/view/MainToolbar.tsx");
const { zoomLabel } = await import("../src/view/Zoom.tsx");
const { CAMERA, ConnectorTool, MiroSelectTool } = await import("../src/view/navigation.ts");
const { ROUNDED_RECT } = await import("../src/model/styles.ts");

after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));

test("the toolbar has the tools of goal 3.3 and the five shape types", () => {
  assert.deepEqual(TOOL_BUTTONS.map((b) => b.id), ["select", "sticky", "text", "arrow", "frame", "draw"]);
  assert.deepEqual(SHAPE_TYPES.map((t) => t.geo), ["rectangle", ROUNDED_RECT, "ellipse", "triangle", "diamond"]);
});

test("a tool lights its button; geo the shape button; tools without a button light none", () => {
  for (const id of ["select", "sticky", "text", "arrow", "frame", "draw", "geo"]) assert.equal(activeButton(id), id);
  for (const id of ["hand", "eraser", "line", "laser", "note"]) assert.equal(activeButton(id), null);
});

test("the shape button shows the next shape's type when it is one of ours, else the remembered one", () => {
  assert.equal(shownGeo("triangle", "rectangle"), "triangle");
  assert.equal(shownGeo(ROUNDED_RECT, "rectangle"), ROUNDED_RECT);
  assert.equal(shownGeo("cloud", "diamond"), "diamond");
  assert.equal(shownGeo(undefined, "ellipse"), "ellipse");
});

test("the overrides give N and S to our sticky, take N from tldraw's note, add P to the pen", () => {
  let chosen = "";
  const editor = { setCurrentTool: (t: string) => { chosen = t; } };
  const tools = {
    note: { id: "note", label: "tool.note", icon: "tool-note", kbd: "n", onSelect() {} },
    draw: { id: "draw", label: "tool.draw", icon: "tool-pencil", kbd: "d,b,x", onSelect() {} },
    select: { id: "select", label: "tool.select", icon: "tool-pointer", kbd: "v", onSelect() {} },
  };
  const out = UI_OVERRIDES.tools!(editor as never, tools as never, {} as never);
  assert.equal(out.sticky.kbd, "n,s");
  out.sticky.onSelect("kbd");
  assert.equal(chosen, "sticky");
  assert.equal(out.note.kbd, undefined);
  assert.equal(out.draw.kbd, "d,p,b,x");
  assert.equal(out.select.kbd, "v");
  assert.equal(tools.note.kbd, "n", "the input is not changed");
});

test("zoom: limits 10%–400%, the label in percent", () => {
  assert.equal(CAMERA.zoomSteps![0], 0.1);
  assert.equal(CAMERA.zoomSteps!.at(-1), 4);
  assert.ok(CAMERA.zoomSteps!.includes(1));
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(0.848), "85%");
  assert.equal(zoomLabel(4), "400%");
});

test("the tools replace tldraw's states by id and keep the rest", () => {
  const sel = MiroSelectTool.children().map((c) => c.id);
  assert.ok(sel.includes("pointing_canvas") && sel.includes("idle") && sel.includes("panning_canvas") && sel.includes("translating"));
  assert.equal(new Set(sel).size, sel.length);
  assert.equal(ConnectorTool.id, "arrow");
  assert.deepEqual(ConnectorTool.children().map((c) => c.id).sort(), ["idle", "pointing"]);
});
