// Undo and redo touch only what this window did (goal 3.3; view/localundo.ts, view/localundo-logic.ts). The merge alone, then
// two synced stores on one in-process TLSocketRoom (as sync.test.ts), each with tldraw's own HistoryManager (what the Editor's
// undo/redo run): window A changes a sticky's colour, window B (another person, or the agent) its position and font size, A
// undoes and redoes.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { TLSocketRoom } from "@tldraw/sync-core";
import { HistoryManager, type TLRecord, type TLStore } from "tldraw";
import { tlSchema } from "../src/model/schema.ts";
import { deepEqual, mergeReplay } from "../src/view/localundo-logic.ts";
import { installLocalUndo, replay } from "../src/view/localundo.ts";
import { TlSync, type TlUser } from "../src/view/sync.ts";
import { RoomLink } from "./fakelink.ts";
import { PAGE, rich, sticky as bare } from "./records.ts";

// ---- the merge ----

test("deepEqual compares rich text and nested values by value", () => {
  assert.ok(deepEqual(rich("hello"), rich("hello")));
  assert.ok(!deepEqual(rich("hello"), rich("hellO")));
  assert.ok(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(deepEqual(null, null) && !deepEqual(null, {}));
});

const rec = (o: { x?: number; color?: string; fontSize?: number; text?: string; key?: string } = {}) => ({
  id: "shape:p", typeName: "shape", x: o.x ?? 0, y: 0,
  props: { color: o.color ?? "yellow", fontSize: o.fontSize ?? 0, richText: rich(o.text ?? "") },
  meta: o.key ? { key: o.key } : {},
});

test("mergeReplay: the history's value only where the current value is the one this window left", () => {
  // this window turned it blue; someone else then moved it and set its font size; undo targets the record before blue
  const left = rec({ color: "blue" });
  const current = rec({ color: "blue", x: 300, fontSize: 40 });
  const target = rec({ color: "yellow" });
  assert.deepEqual(mergeReplay(current, target, left), rec({ color: "yellow", x: 300, fontSize: 40 }));
});

test("mergeReplay: a property both changed keeps the other's value; rich text is compared deeply", () => {
  const left = rec({ color: "blue", text: "mine" });
  const current = rec({ color: "green", text: "mine" }); // someone else recoloured it; the text is still this window's
  const target = rec({ color: "yellow", text: "before" });
  const got = mergeReplay(current, target, left);
  assert.equal(got.props.color, "green");
  assert.deepEqual(got.props.richText, rich("before"));
});

test("mergeReplay: nothing known of this window's record takes the history's; no change returns current itself", () => {
  const current = rec({ x: 5 }), target = rec({ x: 9 });
  assert.equal(mergeReplay(current, target, undefined), target);
  const left = rec({ color: "blue" });
  const others = rec({ color: "red" }); // only the colour differs, and someone else set it
  assert.equal(mergeReplay(others, rec({ color: "yellow" }), left), others);
});

test("mergeReplay: meta is merged field by field, and a field the history lacks is removed when it is this window's", () => {
  const left = { ...rec(), meta: { key: "a", tag: "t" } };
  const current = { ...rec(), meta: { key: "b", tag: "t" } }; // someone else renamed the key
  const target = { ...rec(), meta: { key: "z" } }; // before this window added the tag
  assert.deepEqual(mergeReplay(current, target, left).meta, { key: "b" });
});

// ---- two windows on one room ----

after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));
const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => unknown; cancelAnimationFrame?: (t: unknown) => void };
g.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame ??= (t) => clearTimeout(t as ReturnType<typeof setTimeout>);

type Rec = { id: string; x: number; props: Record<string, unknown> };
const quiet = { warn: () => {}, error: () => {} };
const ALICE: TlUser = { id: "u_alice", name: "Teal Otter", color: "#0d9488" };
const BOB: TlUser = { id: "u_bob", name: "Amber Fox", color: "#d97706" };
const sticky = (id: string, o: Parameters<typeof bare>[1] = {}) => ({ opacity: 1, ...bare(id, o) });

async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Two windows on a room with stickies P and Q; A has the local undo (unless `plain`) and tldraw's history. */
async function twoWindows(plain = false) {
  const room = new TLSocketRoom<TLRecord, void>({ schema: tlSchema as never, log: quiet });
  const open = (name: string, user: TlUser) => {
    const link = new RoomLink(room, name);
    const sync = new TlSync({ link, user });
    link.open();
    return sync;
  };
  const a = open("a", ALICE), b = open("b", BOB);
  const ready = (s: TlSync) => s.getSnapshot().loaded && s.getSnapshot().link === "online";
  await until(() => ready(a) && ready(b), "both loaded");
  const A = a.store as TLStore, B = b.store as TLStore;
  if (!A.get(PAGE.id as never)) A.put([PAGE as never]);
  A.put([sticky("shape:p", { x: 0, props: { fontSize: 0 } }) as never, sticky("shape:q", { x: 0 }) as never]);
  await until(() => !!B.get("shape:q" as never), "stickies at B");
  // installed after the setup, as the Board installs it on mount, and the history starts empty (the setup is not A's step)
  const uninstall = plain ? () => {} : installLocalUndo(A);
  const history = new HistoryManager<TLRecord>({ store: A });
  const get = (s: TLStore, id: string) => s.get(id as never) as unknown as Rec;
  const update = (s: TLStore, id: string, f: (r: Rec) => Rec) => s.put([f(get(s, id)) as never]);
  const synced = (what: string, cond: () => boolean) => until(cond, what);
  const done = () => {
    uninstall();
    history.dispose();
    a.dispose();
    b.dispose();
    room.close();
  };
  return { A, B, history, get, update, synced, done };
}

test("A recolours P and moves Q; B moves P and sets its font size; A's undo and redo touch only A's changes", async () => {
  const { A, B, history, get, update, synced, done } = await twoWindows();
  try {
    update(A, "shape:p", (r) => ({ ...r, props: { ...r.props, color: "blue" } }));
    update(A, "shape:q", (r) => ({ ...r, x: 50 }));
    await synced("A's changes at B", () => get(B, "shape:p").props.color === "blue" && get(B, "shape:q").x === 50);
    update(B, "shape:p", (r) => ({ ...r, x: 300, props: { ...r.props, fontSize: 40 } }));
    await synced("B's change at A", () => get(A, "shape:p").x === 300);

    replay(A, () => history.undo());
    let p = get(A, "shape:p");
    assert.equal(p.props.color, "light-yellow", "A's colour undone");
    assert.equal(p.x, 300, "B's position kept");
    assert.equal(p.props.fontSize, 40, "B's font size kept");
    assert.equal(get(A, "shape:q").x, 0, "an element only A changed undoes as usual");
    await synced("the undo at B", () => get(B, "shape:p").props.color === "light-yellow" && get(B, "shape:q").x === 0);
    assert.equal(get(B, "shape:p").x, 300);

    replay(A, () => history.redo());
    p = get(A, "shape:p");
    assert.equal(p.props.color, "blue", "A's colour again");
    assert.equal(p.x, 300, "B's position still kept");
    assert.equal(p.props.fontSize, 40, "B's font size still kept");
    assert.equal(get(A, "shape:q").x, 50);
  } finally {
    done();
  }
});

test("a change B makes between A's undo and redo is kept by the redo", async () => {
  const { A, B, history, get, update, synced, done } = await twoWindows();
  try {
    update(A, "shape:p", (r) => ({ ...r, x: 70, props: { ...r.props, color: "blue" } }));
    await synced("A's change at B", () => get(B, "shape:p").x === 70);
    replay(A, () => history.undo());
    await synced("the undo at B", () => get(B, "shape:p").x === 0);
    update(B, "shape:p", (r) => ({ ...r, x: 500 }));
    await synced("B's change at A", () => get(A, "shape:p").x === 500);
    replay(A, () => history.redo());
    assert.equal(get(A, "shape:p").x, 500, "B's position kept");
    assert.equal(get(A, "shape:p").props.color, "blue", "A's colour redone");
  } finally {
    done();
  }
});

test("a property both changed: A's undo and redo leave B's later value", async () => {
  const { A, B, history, get, update, synced, done } = await twoWindows();
  try {
    update(A, "shape:p", (r) => ({ ...r, props: { ...r.props, color: "blue" } }));
    await synced("A's change at B", () => get(B, "shape:p").props.color === "blue");
    update(B, "shape:p", (r) => ({ ...r, props: { ...r.props, color: "green" } }));
    await synced("B's change at A", () => get(A, "shape:p").props.color === "green");
    replay(A, () => history.undo());
    assert.equal(get(A, "shape:p").props.color, "green");
    replay(A, () => history.redo());
    assert.equal(get(A, "shape:p").props.color, "green");
  } finally {
    done();
  }
});

test("without the local undo, tldraw's undo puts back B's position and font size (the failure this fixes)", async () => {
  const { A, B, history, get, update, synced, done } = await twoWindows(true);
  try {
    update(A, "shape:p", (r) => ({ ...r, props: { ...r.props, color: "blue" } }));
    await synced("A's change at B", () => get(B, "shape:p").props.color === "blue");
    update(B, "shape:p", (r) => ({ ...r, x: 300, props: { ...r.props, fontSize: 40 } }));
    await synced("B's change at A", () => get(A, "shape:p").x === 300);
    history.undo();
    assert.equal(get(A, "shape:p").x, 0);
    assert.equal(get(A, "shape:p").props.fontSize, 0);
  } finally {
    done();
  }
});
