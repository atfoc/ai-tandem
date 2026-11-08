// The agent's ops on the board host's editor (`@aiwb/board-tl/model/apply.ts`, package T1b-apply): each op type of design 7.2
// with its defaults and with every field, read back through `read.ts` (so apply and read agree), refs, atomic failures,
// connectors bound and free, frames, the sizes the shape utils fit, the diff and the bounds.
// (first: the page before any tldraw module, as in src/bin.ts)
import "../src/node/install-page.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createShapeId, toRichText, type Editor, type TLRecord, type TLShapeId } from "tldraw";
import { applyOps, type ApplyOk } from "@aiwb/board-tl/model/apply.ts";
import { readElementsById } from "@aiwb/board-tl/model/read.ts";
import { STICKY_TYPE } from "@aiwb/board-tl/model/palette.ts";
import type { TlElement } from "@aiwb/board-tl/model/terms.ts";
import { loadRuntime } from "../src/node/runtime.ts";

async function withEditor(f: (editor: Editor) => void | Promise<void>) {
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  try {
    await f(editor);
  } finally {
    editor.dispose();
  }
}

function ok(r: ReturnType<typeof applyOps>): ApplyOk {
  if (!r.ok) assert.fail(r.error);
  return r;
}

function read(editor: Editor, ids: string[]): TlElement[] {
  return readElementsById(editor.store.allRecords(), ids, { pageBounds: (id) => editor.getShapePageBounds(id as TLShapeId) });
}

function one(editor: Editor, id: string): TlElement {
  const [el] = read(editor, [id]);
  assert.ok(el, `no element ${id}`);
  return el;
}

/** The fields of `want` in `got` (the rest of `got` is not looked at). */
function has(got: TlElement, want: Record<string, unknown>) {
  const sub: Record<string, unknown> = {};
  for (const k of Object.keys(want)) sub[k] = (got as Record<string, unknown>)[k];
  assert.deepEqual(sub, want);
}

const docRecords = (editor: Editor) =>
  editor.store
    .allRecords()
    .filter((r) => editor.store.scopedTypes.document.has(r.typeName))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

// ---- Each op type ----

test("a sticky with defaults, and with every field", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "a", x: 10, y: 20 },
      { op: "create", type: "sticky", ref: "b", x: 300, y: 20, w: 300, text: "Hello", color: "dark-blue", fontSize: "l", align: "start" },
    ]));
    assert.deepEqual(Object.keys(r.ids), ["a", "b"]);
    has(one(editor, r.ids.a), { key: "a", type: "sticky", x: 10, y: 20, w: 200, h: 200, color: "light-yellow", fontSize: "auto", align: "middle", shownSize: 48 });
    has(one(editor, r.ids.b), { key: "b", type: "sticky", x: 300, y: 20, w: 300, h: 300, text: "Hello", color: "dark-blue", fontSize: "l", align: "start", shownSize: 32 });
    const rec = editor.getShape(r.ids.b as TLShapeId)!;
    assert.equal(rec.type, STICKY_TYPE);
    assert.equal((rec.props as { fontSize: number }).fontSize, 32);
    assert.deepEqual(rec.meta, { key: "b" });
  }));

test("a shape with defaults, and with every field", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "shape", ref: "a", x: 0, y: 0 },
      {
        op: "create", type: "shape", ref: "b", shape: "rounded", x: 200, y: 50, w: 240, h: 120, text: "API", fill: "light-blue",
        border: "red", borderWidth: "l", borderStyle: "dashed", align: "start", size: "xl",
      },
      { op: "create", type: "shape", ref: "c", shape: "ellipse", x: 0, y: 300, fill: "pink" },
    ]));
    // (fill white: what a person gets, the window's next-shape style, which the host's editor sets too)
    has(one(editor, r.ids.a), { type: "shape", shape: "rectangle", x: 0, y: 0, w: 100, h: 100, fill: "white", border: "black", borderWidth: "m", borderStyle: "solid", align: "middle", size: "m" });
    has(one(editor, r.ids.b), { type: "shape", shape: "rounded", x: 200, y: 50, w: 240, h: 120, text: "API", fill: "light-blue", border: "red", borderWidth: "l", borderStyle: "dashed", align: "start", size: "xl" });
    has(one(editor, r.ids.c), { shape: "ellipse", fill: "pink" });
    const p = editor.getShape(r.ids.b as TLShapeId)!.props as Record<string, unknown>;
    assert.equal(p.geo, "rounded-rectangle");
    assert.equal(p.fill, "fill");
    assert.equal(p.fillColor, "light-blue");
    assert.equal(p.labelSize, "xl");
    assert.equal(p.size, "l");
    assert.equal(p.font, "sans");
  }));

test("a text with defaults (auto width), and with every field (fixed width, bold)", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "text", ref: "a", x: 5, y: 6, text: "Short" },
      { op: "create", type: "text", ref: "b", x: 0, y: 100, text: "A longer text that wraps\nand a second line", w: 150, size: "l", color: "violet", align: "end", bold: true },
    ]));
    const a = one(editor, r.ids.a);
    has(a, { type: "text", x: 5, y: 6, text: "Short", size: "m", color: "black", align: "start", bold: false });
    assert.equal((editor.getShape(r.ids.a as TLShapeId)!.props as { autoSize: boolean }).autoSize, true);
    // auto width: as wide as its text, which a longer text makes wider
    const longer = ok(applyOps(editor, [{ op: "create", type: "text", x: 5, y: 60, text: "Short, but not as short" }]));
    assert.ok(one(editor, longer.created[0]).w > a.w);
    const b = one(editor, r.ids.b);
    has(b, { type: "text", x: 0, y: 100, w: 150, text: "A longer text that wraps\nand a second line", size: "l", color: "violet", align: "end", bold: true });
    assert.ok(b.h > 100, `wrapped onto several lines: h ${b.h}`);
    assert.equal((editor.getShape(r.ids.b as TLShapeId)!.props as { autoSize: boolean }).autoSize, false);
  }));

test("a connector with defaults, and with every field", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "connector", ref: "a", from: { x: 0, y: 0 }, to: { x: 200, y: 100 } },
      { op: "create", type: "connector", ref: "b", from: { x: 0, y: 300 }, to: { x: 300, y: 300 }, line: "curved", start: "dot", end: "triangle", text: "calls", color: "green", width: "xl", dash: "dotted" },
      { op: "create", type: "connector", ref: "c", from: { x: 0, y: 500 }, to: { x: 300, y: 600 }, line: "elbow", start: "bar", end: "diamond" },
    ]));
    has(one(editor, r.ids.a), { type: "connector", from: { x: 0, y: 0 }, to: { x: 200, y: 100 }, line: "straight", start: "none", end: "arrow", color: "black", width: "m", dash: "solid" });
    has(one(editor, r.ids.b), { from: { x: 0, y: 300 }, to: { x: 300, y: 300 }, line: "curved", start: "dot", end: "triangle", text: "calls", color: "green", width: "xl", dash: "dotted" });
    has(one(editor, r.ids.c), { line: "elbow", start: "bar", end: "diamond" });
    const pb = editor.getShape(r.ids.b as TLShapeId)!.props as Record<string, unknown>;
    assert.equal(pb.kind, "arc");
    assert.equal(pb.bend, 60);
    assert.equal(pb.labelColor, "green");
    assert.equal((editor.getShape(r.ids.c as TLShapeId)!.props as Record<string, unknown>).kind, "elbow");
  }));

test("a frame with a size, and with every field", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "frame", ref: "a", x: 0, y: 0 },
      { op: "create", type: "frame", ref: "b", x: 500, y: 0, w: 400, h: 300, name: "Sprint", color: "blue" },
    ]));
    has(one(editor, r.ids.a), { type: "frame", x: 0, y: 0, w: 320, h: 180, name: "", color: "black" });
    has(one(editor, r.ids.b), { type: "frame", x: 500, y: 0, w: 400, h: 300, name: "Sprint", color: "blue" });
  }));

test("an element created inside a frame is given and read in page coordinates", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "frame", ref: "f", x: 1000, y: 500, w: 600, h: 400 },
      { op: "create", type: "sticky", ref: "n", parent: "f", x: 1100, y: 600 },
    ]));
    const n = editor.getShape(r.ids.n as TLShapeId)!;
    assert.equal(n.parentId, r.ids.f);
    assert.deepEqual({ x: n.x, y: n.y }, { x: 100, y: 100 });
    has(one(editor, r.ids.n), { parent: r.ids.f, x: 1100, y: 600 });
  }));

// ---- Updates ----

test("update: every field of each type", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "n", x: 0, y: 0 },
      { op: "create", type: "shape", ref: "s", x: 300, y: 0, w: 200, h: 100 },
      { op: "create", type: "text", ref: "t", x: 0, y: 300, text: "Old" },
      { op: "create", type: "shape", ref: "s2", x: 700, y: 0 },
      { op: "create", type: "connector", ref: "c", from: "n", to: "s" },
      { op: "create", type: "frame", ref: "f", x: -100, y: 600, w: 300, h: 200 },
    ]));
    const u = ok(applyOps(editor, [
      { op: "update", id: "n", x: 10, y: 20, w: 250, text: "New idea", color: "pink", fontSize: "s", align: "end" },
      { op: "update", id: r.ids.s, shape: "diamond", x: 400, y: 10, w: 220, h: 140, text: "Svc", fill: "green", border: "blue", borderWidth: "s", borderStyle: "dotted", align: "end", size: "l" },
      { op: "update", id: "t", x: 20, y: 320, w: 200, text: "New", size: "xl", color: "red", align: "middle", bold: true },
      { op: "update", id: "c", to: "s2", line: "curved", start: "arrow", end: "none", text: "uses", color: "orange", width: "s", dash: "dashed" },
      { op: "update", id: "f", name: "Done", x: -50, y: 650, w: 350, h: 250, color: "red" },
    ]));
    assert.deepEqual(new Set(u.updated), new Set([r.ids.n, r.ids.s, r.ids.t, r.ids.c, r.ids.f]));
    has(one(editor, r.ids.n), { x: 10, y: 20, w: 250, h: 250, text: "New idea", color: "pink", fontSize: "s", align: "end", shownSize: 16 });
    has(one(editor, r.ids.s), { shape: "diamond", x: 400, y: 10, w: 220, h: 140, text: "Svc", fill: "green", border: "blue", borderWidth: "s", borderStyle: "dotted", align: "end", size: "l" });
    has(one(editor, r.ids.t), { x: 20, y: 320, w: 200, text: "New", size: "xl", color: "red", align: "middle", bold: true });
    has(one(editor, r.ids.c), { from: { id: r.ids.n, key: "n" }, to: { id: r.ids.s2, key: "s2" }, line: "curved", start: "arrow", end: "none", text: "uses", color: "orange", width: "s", dash: "dashed" });
    has(one(editor, r.ids.f), { name: "Done", x: -50, y: 650, w: 350, h: 250, color: "red" });
    // bold alone keeps the text; a text alone keeps the bold
    ok(applyOps(editor, [{ op: "update", id: "t", text: "Newer" }]));
    has(one(editor, r.ids.t), { text: "Newer", bold: true });
    ok(applyOps(editor, [{ op: "update", id: "t", bold: false }]));
    has(one(editor, r.ids.t), { text: "Newer", bold: false });
    // the fill back to none; the connector straight and free at a point
    ok(applyOps(editor, [{ op: "update", id: "s", fill: "none" }, { op: "update", id: "c", line: "straight", from: { x: -200, y: -200 } }]));
    has(one(editor, r.ids.s), { fill: "none" });
    has(one(editor, r.ids.c), { from: { x: -200, y: -200 }, line: "straight" });
    assert.equal(editor.getBindingsFromShape(r.ids.c as TLShapeId, "arrow").length, 1);
  }));

test("update: parent and contains reparent, keeping page positions; parent null moves to the page", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "frame", ref: "f", x: 100, y: 100, w: 800, h: 600 },
      { op: "create", type: "sticky", ref: "a", x: 200, y: 200 },
      { op: "create", type: "shape", ref: "b", x: 500, y: 200 },
    ]));
    ok(applyOps(editor, [{ op: "update", id: "a", parent: "f" }, { op: "update", id: "f", contains: ["b"] }]));
    for (const [k, x] of [["a", 200], ["b", 500]] as const) {
      assert.equal(editor.getShape(r.ids[k] as TLShapeId)!.parentId, r.ids.f);
      has(one(editor, r.ids[k]), { parent: r.ids.f, x, y: 200 });
    }
    ok(applyOps(editor, [{ op: "update", id: "a", parent: null, x: 0 }]));
    assert.equal(editor.getShape(r.ids.a as TLShapeId)!.parentId, editor.getCurrentPageId());
    has(one(editor, r.ids.a), { parent: undefined, x: 0, y: 200 });
  }));

test("update: the shape kind changes the geo, and a new text re-fits the sticky", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [{ op: "create", type: "shape", ref: "s", x: 0, y: 0 }, { op: "create", type: "sticky", ref: "n", x: 0, y: 300, text: "Hi" }]));
    ok(applyOps(editor, [{ op: "update", id: "s", shape: "triangle" }]));
    assert.equal((editor.getShape(r.ids.s as TLShapeId)!.props as { geo: string }).geo, "triangle");
    const short = one(editor, r.ids.n).shownSize!;
    ok(applyOps(editor, [{ op: "update", id: "n", text: "A much longer text that does not fit at the largest size, so the sticky shrinks it" }]));
    assert.ok(one(editor, r.ids.n).shownSize! < short);
  }));

// ---- Refs ----

test("refs: of this apply, by shape id, by key across two applies", () =>
  withEditor((editor) => {
    const r1 = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "n1", x: 0, y: 0 },
      { op: "create", type: "sticky", ref: "n2", x: 400, y: 0 },
      { op: "create", type: "connector", ref: "c1", from: "n1", to: "n2" },
    ]));
    has(one(editor, r1.ids.c1), { from: { id: r1.ids.n1, key: "n1" }, to: { id: r1.ids.n2, key: "n2" } });
    const r2 = ok(applyOps(editor, [
      { op: "create", type: "connector", from: r1.ids.n1, to: "n2" },
      { op: "update", id: "n1", text: "by key" },
    ]));
    assert.deepEqual(r2.ids, {});
    has(one(editor, r2.created[0]), { from: { id: r1.ids.n1, key: "n1" }, to: { id: r1.ids.n2, key: "n2" } });
    has(one(editor, r1.ids.n1), { text: "by key" });
  }));

test("refs: REF_EXISTS, UNKNOWN_REF and INVALID_OP with the op's index", () =>
  withEditor((editor) => {
    ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "n1", x: 0, y: 0 }]));
    const before = docRecords(editor);
    const exists = applyOps(editor, [{ op: "create", type: "sticky", x: 0, y: 0 }, { op: "create", type: "sticky", ref: "n1", x: 0, y: 0 }]);
    assert.equal(exists.ok, false);
    assert.equal(!exists.ok && exists.code, "REF_EXISTS");
    assert.equal(!exists.ok && exists.index, 1);
    const unknown = applyOps(editor, [{ op: "create", type: "connector", from: "n1", to: "n9" }]);
    assert.deepEqual(unknown, { ok: false, code: "UNKNOWN_REF", index: 0, error: 'UNKNOWN_REF: op 0 (create connector): "n9" names no element of this board or of this call' });
    const invalid = applyOps(editor, [{ op: "create", type: "sticky", x: 0, y: 0 }, { op: "create", type: "shape", x: 0, y: 0, color: "red" }]);
    assert.equal(!invalid.ok && invalid.code, "INVALID_OP");
    assert.equal(!invalid.ok && invalid.index, 1);
    assert.match(!invalid.ok ? invalid.error : "", /^INVALID_OP: op 1 \(create shape\): color does not apply/);
    assert.deepEqual(docRecords(editor), before);
  }));

test("a locked element: an update, a delete or a contains of it fails before anything is applied", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "n", x: 0, y: 0 }, { op: "create", type: "frame", ref: "f", x: 500, y: 0 }]));
    editor.updateShapes([{ id: r.ids.n as TLShapeId, type: STICKY_TYPE, isLocked: true }]);
    const before = docRecords(editor);
    for (const [i, op] of [
      [1, { op: "update", id: "n", text: "x" }],
      [1, { op: "delete", id: r.ids.n }],
      [1, { op: "update", id: "f", contains: ["n"] }],
    ] as const) {
      const res = applyOps(editor, [{ op: "create", type: "sticky", x: 0, y: 0 }, op]);
      assert.equal(res.ok, false);
      assert.equal(!res.ok && res.index, i);
      assert.match(!res.ok ? res.error : "", new RegExp(`^INVALID_OP: op 1 \\(${op.op} [^)]+\\): ${r.ids.n} is locked$`));
      assert.deepEqual(docRecords(editor), before);
    }
  }));

// ---- Atomic ----

test("atomic: an invalid third op applies nothing", () =>
  withEditor((editor) => {
    ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "n", x: 0, y: 0 }]));
    const before = docRecords(editor);
    const res = applyOps(editor, [
      { op: "create", type: "sticky", x: 300, y: 0 },
      { op: "update", id: "n", text: "changed" },
      { op: "create", type: "shape", x: 0, y: 0, fill: "purple" },
    ]);
    assert.equal(!res.ok && res.index, 2);
    assert.deepEqual(docRecords(editor), before);
  }));

test("atomic: tldraw throwing in the middle → APPLY_FAILED and the store exactly as before", () =>
  withEditor((editor) => {
    ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "n", x: 0, y: 0 }, { op: "create", type: "shape", ref: "s", x: 300, y: 0 }]));
    const before = docRecords(editor);
    // a value tldraw's record validator refuses, in the fourth op: the geo util's default width made negative
    const util = editor.getShapeUtil("geo") as unknown as { getDefaultProps: () => Record<string, unknown> };
    const orig = util.getDefaultProps;
    util.getDefaultProps = () => ({ ...orig.call(util), w: -1 });
    try {
      const res = applyOps(editor, [
        { op: "create", type: "sticky", x: 600, y: 0 },
        { op: "update", id: "n", text: "changed", x: 50 },
        { op: "delete", id: "s" },
        { op: "create", type: "shape", x: 0, y: 400 },
      ]);
      assert.equal(res.ok, false);
      assert.equal(!res.ok && res.code, "APPLY_FAILED");
      assert.equal(!res.ok && res.index, 3);
      assert.match(!res.ok ? res.error : "", /^APPLY_FAILED: op 3 \(create shape\): .*non-zero positive number/);
    } finally {
      util.getDefaultProps = orig;
    }
    assert.deepEqual(docRecords(editor), before);
    // and the editor still works
    ok(applyOps(editor, [{ op: "update", id: "n", text: "after" }]));
    has(one(editor, before.find((r) => r.typeName === "shape" && (r as { meta: { key?: string } }).meta.key === "n")!.id), { text: "after" });
  }));

test("atomic: a method that throws after changes → APPLY_FAILED and the store deep-equal to before", () =>
  withEditor((editor) => {
    ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "n", x: 0, y: 0 }, { op: "create", type: "frame", ref: "f", contains: ["n"] }]));
    const before = structuredClone(docRecords(editor)) as TLRecord[];
    const orig = editor.deleteShapes;
    editor.deleteShapes = (() => { throw new Error("boom"); }) as typeof editor.deleteShapes;
    try {
      const res = applyOps(editor, [{ op: "update", id: "n", text: "x" }, { op: "delete", id: "f" }]);
      assert.deepEqual(res, { ok: false, code: "APPLY_FAILED", index: 1, error: `APPLY_FAILED: op 1 (delete f): boom` });
    } finally {
      editor.deleteShapes = orig;
    }
    assert.deepEqual(docRecords(editor), before);
  }));

// ---- Connectors ----

test("a connector bound at both ends follows its targets; a Point end is free", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "shape", ref: "a", x: 0, y: 0, w: 100, h: 100 },
      { op: "create", type: "shape", ref: "b", x: 400, y: 0, w: 100, h: 100 },
      { op: "create", type: "connector", ref: "c", from: "a", to: "b" },
      { op: "create", type: "connector", ref: "d", from: "a", to: { x: 50, y: 400 } },
    ]));
    const bindings = editor.getBindingsFromShape(r.ids.c as TLShapeId, "arrow");
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map((b) => [(b.props as { terminal: string }).terminal, b.toId]).sort(), [["end", r.ids.b], ["start", r.ids.a]]);
    const before = one(editor, r.ids.c);
    ok(applyOps(editor, [{ op: "update", id: "b", y: 300 }]));
    const after = one(editor, r.ids.c);
    assert.ok(after.h > before.h + 200, `the connector followed: h ${before.h} → ${after.h}`);
    const d = editor.getBindingsFromShape(r.ids.d as TLShapeId, "arrow");
    assert.deepEqual(d.map((b) => (b.props as { terminal: string }).terminal), ["start"]);
    has(one(editor, r.ids.d), { from: { id: r.ids.a, key: "a" }, to: { x: 50, y: 400 } });
  }));

test("delete: a connector bound to the deleted element keeps a free end", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "a", x: 0, y: 0 },
      { op: "create", type: "sticky", ref: "b", x: 400, y: 0 },
      { op: "create", type: "connector", ref: "c", from: "a", to: "b" },
    ]));
    const res = ok(applyOps(editor, [{ op: "delete", id: "b" }]));
    assert.deepEqual(res.deleted, [r.ids.b]);
    assert.ok(editor.getShape(r.ids.c as TLShapeId));
    const c = one(editor, r.ids.c);
    assert.deepEqual(c.from, { id: r.ids.a, key: "a" });
    assert.ok(c.to && "x" in c.to, "the end is a point");
  }));

// ---- Frames ----

test("frame: contains reparents keeping page positions; without a size it fits its contents + 40 px", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "a", x: 100, y: 100 },
      { op: "create", type: "shape", ref: "b", x: 400, y: 150, w: 200, h: 100 },
      { op: "create", type: "frame", ref: "f", name: "Group", contains: ["a", "b"] },
    ]));
    for (const [k, x, y] of [["a", 100, 100], ["b", 400, 150]] as const) {
      assert.equal(editor.getShape(r.ids[k] as TLShapeId)!.parentId, r.ids.f);
      has(one(editor, r.ids[k]), { parent: r.ids.f, x, y });
    }
    has(one(editor, r.ids.f), { x: 60, y: 60, w: 580, h: 280 });
  }));

test("frame: deleting it keeps its children at their page positions, on the page", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "frame", ref: "f", x: 1000, y: 1000, w: 600, h: 400 },
      { op: "create", type: "sticky", ref: "a", parent: "f", x: 1100, y: 1100 },
      { op: "create", type: "text", ref: "t", parent: "f", x: 1350, y: 1150, text: "note" },
    ]));
    const res = ok(applyOps(editor, [{ op: "delete", id: "f" }]));
    assert.deepEqual(res.deleted, [r.ids.f]);
    assert.deepEqual(new Set(res.updated), new Set([r.ids.a, r.ids.t]));
    for (const [k, x, y] of [["a", 1100, 1100], ["t", 1350, 1150]] as const) {
      assert.equal(editor.getShape(r.ids[k] as TLShapeId)!.parentId, editor.getCurrentPageId());
      has(one(editor, r.ids[k]), { parent: undefined, x, y });
    }
    assert.deepEqual(res.bounds, { x: 1000, y: 1000, w: 600, h: 400 });
  }));

// ---- Sizes ----

test("sizes: a long text shrinks the sticky to what the util gives a person; a geo grows; a text without w is auto width", () =>
  withEditor((editor) => {
    const long = "A long text on a sticky note that cannot be shown at the largest size, so it is shrunk to fit inside the note";
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "empty", x: 0, y: 0 },
      { op: "create", type: "sticky", ref: "long", x: 300, y: 0, text: long },
      { op: "create", type: "shape", ref: "g", x: 0, y: 300, w: 200, h: 100, text: `${long}. ${long}` },
      { op: "create", type: "text", ref: "t", x: 0, y: 600, text: "auto" },
    ]));
    const fitted = (id: string) => (editor.getShape(id as TLShapeId)!.props as { fitted: number }).fitted;
    assert.ok(fitted(r.ids.long) < fitted(r.ids.empty), `${fitted(r.ids.long)} < ${fitted(r.ids.empty)}`);
    const person = createShapeId("person");
    editor.createShapes([{ id: person, type: STICKY_TYPE, x: 600, y: 0, props: { richText: toRichText(long) } } as never]);
    assert.equal(fitted(r.ids.long), fitted(person));
    assert.ok((editor.getShape(r.ids.g as TLShapeId)!.props as { growY: number }).growY > 0);
    assert.equal((editor.getShape(r.ids.t as TLShapeId)!.props as { autoSize: boolean }).autoSize, true);
    // a geo made taller than its text loses its growY
    ok(applyOps(editor, [{ op: "update", id: "g", h: 600 }]));
    assert.equal((editor.getShape(r.ids.g as TLShapeId)!.props as { growY: number }).growY, 0);
    has(one(editor, r.ids.g), { h: 600 });
  }));

// ---- Diff and bounds ----

test("the diff holds exactly the changed records; bounds is the union of created, updated and deleted", () =>
  withEditor((editor) => {
    const r = ok(applyOps(editor, [
      { op: "create", type: "sticky", ref: "a", x: 0, y: 0 },
      { op: "create", type: "sticky", ref: "b", x: 1000, y: 0 },
      { op: "create", type: "sticky", ref: "c", x: 0, y: 1000 },
    ]));
    const before = new Map<string, TLRecord>(docRecords(editor).map((x) => [x.id, x]));
    const res = ok(applyOps(editor, [
      { op: "create", type: "shape", ref: "s", x: 500, y: 500 },
      { op: "update", id: "a", x: -100, y: -50 },
      { op: "delete", id: "c" },
    ]));
    const after = new Map<string, TLRecord>(docRecords(editor).map((x) => [x.id, x]));
    const changed = {
      added: [...after.keys()].filter((id) => !before.has(id)).sort(),
      updated: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)).sort(),
      removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
    };
    assert.deepEqual(
      { added: Object.keys(res.diff.added).sort(), updated: Object.keys(res.diff.updated).sort(), removed: Object.keys(res.diff.removed).sort() },
      changed,
    );
    assert.deepEqual(changed, { added: [res.ids.s], updated: [r.ids.a], removed: [r.ids.c] });
    for (const [id, [from, to]] of Object.entries(res.diff.updated)) {
      assert.equal(from, before.get(id));
      assert.equal(to, after.get(id));
    }
    assert.deepEqual(res.created, [res.ids.s]);
    assert.deepEqual(res.updated, [r.ids.a]);
    assert.deepEqual(res.deleted, [r.ids.c]);
    // a: -100,-50 to 100,150; s: 500,500 to 600,600; c (before): 0,1000 to 200,1200
    assert.deepEqual(res.bounds, { x: -100, y: -50, w: 700, h: 1250 });
  }));

test("an update that changes nothing: no updated element, an empty diff, bounds null", () =>
  withEditor((editor) => {
    ok(applyOps(editor, [{ op: "create", type: "sticky", ref: "a", x: 0, y: 0 }]));
    const res = ok(applyOps(editor, [{ op: "update", id: "a", x: 0 }]));
    assert.deepEqual(res.updated, []);
    assert.equal(res.bounds, null);
    assert.deepEqual(res.diff, { added: {}, updated: {}, removed: {} });
  }));

// ---- Time ----

test("one apply of 10 ops (warm): the time", () =>
  withEditor((editor) => {
    const ops = (n: number) => [
      { op: "create", type: "frame", ref: `f${n}`, x: 0, y: n * 1000, w: 1200, h: 800, name: "Sprint" },
      { op: "create", type: "sticky", ref: `a${n}`, parent: `f${n}`, x: 50, y: n * 1000 + 50, text: "An idea that takes a few words" },
      { op: "create", type: "sticky", ref: `b${n}`, parent: `f${n}`, x: 300, y: n * 1000 + 50, text: "Another one", color: "pink" },
      { op: "create", type: "shape", ref: `s${n}`, parent: `f${n}`, x: 600, y: n * 1000 + 50, w: 200, h: 100, text: "Service", fill: "light-blue" },
      { op: "create", type: "shape", ref: `e${n}`, parent: `f${n}`, shape: "ellipse", x: 900, y: n * 1000 + 50, text: "DB" },
      { op: "create", type: "text", ref: `t${n}`, parent: `f${n}`, x: 50, y: n * 1000 + 400, text: "A heading", size: "xl", bold: true },
      { op: "create", type: "connector", from: `a${n}`, to: `b${n}` },
      { op: "create", type: "connector", from: `b${n}`, to: `s${n}`, text: "calls" },
      { op: "create", type: "connector", from: `s${n}`, to: `e${n}`, line: "curved" },
      { op: "update", id: `a${n}`, color: "yellow" },
    ];
    for (let n = 0; n < 5; n++) ok(applyOps(editor, ops(n)));
    const times: number[] = [];
    for (let n = 5; n < 25; n++) {
      const t0 = performance.now();
      ok(applyOps(editor, ops(n)));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`# apply of 10 ops (warm, a board of up to 250 elements): median ${times[10].toFixed(1)} ms, min ${times[0].toFixed(1)} ms, max ${times[19].toFixed(1)} ms`);
  }));
