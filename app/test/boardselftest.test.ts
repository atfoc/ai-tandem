// The cases of the board self-test (src/dev/boardSelfTest.ts) that the device runs against the real page, run against a stand-in
// page that speaks the bridge's messages (the real Excalidraw needs a browser): they pass when the page behaves, fail when it does not,
// and the touch watch counts what a finger drew from the deltas.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createChannel } from "@aiwb/core/board/channel.ts";
import { createBaseline } from "@aiwb/board-bridge/delta.ts";
import type { El, FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";

import { runBoardSelfTest, TouchWatch } from "../src/dev/boardSelfTest.ts";
import { line } from "../src/dev/selftest.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==" + "A".repeat(2000);

/** A page that keeps the scene of the board it shows and answers the way the real one does, in the order it does (`changed` before the reply). */
function standInPage(opts: { dropChanged?: boolean } = {}) {
  let board = "", els: El[] = [], baseline = createBaseline(), n = 0;
  let to: (m: FromBoard) => void = () => {};
  const tell = (m: FromBoard) => queueMicrotask(() => to(m));
  const bump = (e: El): El => ({ ...e, version: e.version + 1 });
  const changed = () => {
    const d = baseline.diff(els);
    if (!d) return;
    baseline.set(els);
    if (!opts.dropChanged) tell({ t: "changed", board, elements: d.elements, ...(d.order ? { order: d.order } : {}), appState: {}, style: {} });
  };
  const handle = (m: ToBoard) => {
    if (m.t === "load") {
      board = m.board; els = m.scene.elements.slice(); baseline = createBaseline(els);
      tell({ t: "view", board, scrollX: 0, scrollY: 0, zoom: 1, width: 800, height: 600 });
      tell({ t: "loaded", board });
    } else if (m.t === "req") {
      const op = m.op;
      const ok = (value: unknown) => tell({ t: "res", id: m.id, ok: true, value });
      if (op.op === "restore") ok({ elements: op.elements.filter((e) => e && typeof e === "object" && "id" in e) });
      else if (op.op === "apply") {
        const created: Record<string, string> = {};
        for (const c of (op.params.create ?? []) as { key?: string; type: string }[]) { const id = `new-${++n}`; if (c.key) created[c.key] = id; els = [...els, { id, type: c.type, version: 1 }]; }
        const updated = ((op.params.update ?? []) as { ref: { id: string } }[]).map((u) => u.ref.id);
        els = els.map((e) => (updated.includes(e.id) ? { ...bump(e), backgroundColor: "#a5d8ff" } : e));
        changed();
        ok({ created, updated, deleted: [], conflicts: [], rev: op.rev });
      } else if (op.op === "snapshot") ok({ board, elements: els, files: {}, appState: {}, style: {} });
      else if (op.op === "export") ok({ png: PNG_1X1, width: 400, height: 300, bounds: { x: 0, y: 0, width: 368, height: 268 }, count: 4 });
    }
  };
  return { handle, attach(f: (m: FromBoard) => void) { to = f; tell({ t: "ready", version: "0.18.1" }); } };
}

function wire(page: ReturnType<typeof standInPage>) {
  const c = createChannel((m) => page.handle(m));
  page.attach((m) => c.receive(JSON.stringify(m)));
  return c.channel;
}

test("board self-test: the cases pass against a page that speaks the bridge, and ask for both memory phases", async () => {
  const phases: string[] = [];
  const r = await runBoardSelfTest({ channel: wire(standInPage()), phase: async (p) => { phases.push(p); } });
  assert.deepEqual(r.failed.map(line), []);
  assert.ok(r.ok);
  assert.deepEqual(phases, ["memory-empty", "memory-2000"]);
});

test("board self-test: a page that never tells `changed` fails the apply case", async () => {
  const r = await runBoardSelfTest({ channel: wire(standInPage({ dropChanged: true })), phase: async () => {}, limits: { ready: 500, load: 1500, large: 3000 } });
  assert.equal(r.ok, false);
  assert.ok(r.failed.some((o) => /^apply:/.test(o.name)), r.failed.map(line).join("\n"));
});

test("the touch watch counts strokes and free texts from the deltas of its board only", () => {
  const w = new TouchWatch("t");
  const el = (id: string, type: string, extra: Record<string, unknown> = {}): El => ({ id, type, version: 1, ...extra });
  assert.equal(w.feed({ t: "changed", board: "other", elements: [el("x", "freedraw")], appState: {}, style: {} }), false);
  assert.equal(w.feed({ t: "changed", board: "t", elements: [el("a", "freedraw"), el("b", "freedraw"), el("c", "text", { text: "hello" }), el("d", "text", { text: "label", containerId: "r" })], order: ["a", "b", "c", "d"], appState: {}, style: {} }), true);
  assert.equal(w.line(), 'touch strokes: 2; texts: ["hello"]');
  w.feed({ t: "changed", board: "t", elements: [{ ...el("a", "freedraw"), version: 2, isDeleted: true }], appState: {}, style: {} });
  assert.equal(w.strokes(), 1, "a deleted stroke is not counted");
});
