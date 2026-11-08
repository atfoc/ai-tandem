// The agent's tools on the board host (package H2: agent.ts, roomeditor.ts) through the real TLSocketRoom, with connected
// windows (real TLSyncClients) on the fake server: an apply reaches a window as one change and is saved before the answer, an
// invalid op changes nothing, a failed save is SAVE_FAILED with the change kept, a sticky's fit equals a direct one's, read_board,
// delete_elements, the marker (and its replay to a late window), a person's edit kept by the next apply, get_image, refusals.
// (first: the page before any tldraw module, as in src/bin.ts)
import "../src/node/install-page.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toRichText } from "tldraw";
import { STICKY_TYPE } from "@aiwb/board-tl/model/palette.ts";
import { loadRuntime } from "../src/node/runtime.ts";
import { startHost, type Host } from "../src/host.ts";
import { FakeServer, until, wait, SERVER, type FakeWindow } from "./support.ts";

const BOARDS = [{ id: "b1", name: "Sprint" }];
type Rig = { server: FakeServer; host: Host; windows: FakeWindow[] };

function rig(server = new FakeServer()): Rig {
  const host = startHost({ client: server, server: SERVER, log: () => {}, sendGapMs: 5, saveDelayMs: 60_000, quietMs: 60_000 });
  server.open(BOARDS);
  return { server, host, windows: [] };
}

async function stop(r: Rig) {
  for (const w of r.windows) w.close();
  await r.host.shutdown(500);
}

/** A window on b1 whose received messages are kept (parsed), loaded. */
async function open(r: Rig, session: string) {
  const w = r.server.window("b1", session);
  r.windows.push(w);
  const got: any[] = [];
  const receive = w.socket.receive.bind(w.socket);
  w.socket.receive = (text: string) => { got.push(JSON.parse(text)); receive(text); };
  await until(() => w.loaded, `${session} loaded`);
  return { w, got };
}

/** The messages that carry a patch naming any of `ids`. */
const patchesWith = (got: any[], ids: string[]) =>
  got.filter((m) => {
    const parts = m.type === "data" ? m.data : [m];
    return parts.some((p: any) => (p.type === "patch" || p.type === "push_result") && ids.some((id) => JSON.stringify(p).includes(JSON.stringify(id))));
  });

async function call(r: Rig, name: string, args: unknown, extra: Record<string, unknown> = {}) {
  return r.server.reply(r.server.rpc(name, args, "b1", { agent: { kind: "claude", label: "Claude" }, ...extra }));
}

/** The answer of a change: its sentence and its JSON line. */
function parse(result: string) {
  const [sentence, json, ...rest] = result.split("\n");
  assert.equal(rest.length, 0, "two lines");
  return { sentence, data: JSON.parse(json) };
}

const FOUR_OPS = [
  { op: "create", type: "sticky", ref: "n1", x: 0, y: 0, text: "Idea" },
  { op: "create", type: "shape", ref: "s1", x: 300, y: 0, w: 200, h: 100, text: "API" },
  { op: "create", type: "connector", ref: "c1", from: "n1", to: "s1", text: "calls" },
  { op: "create", type: "frame", ref: "f1", name: "Plan", contains: ["n1", "s1"] },
];

test("an apply reaches a window as one change, saved before the answer, with the ids and the elements", async () => {
  const r = rig();
  try {
    const { w, got } = await open(r, "s_a");
    const before = got.length;
    const reply = await call(r, "apply", { ops: FOUR_OPS });
    assert.equal(reply.error, undefined, reply.error);
    const { sentence, data } = parse(reply.result);
    assert.equal(sentence, 'Applied 4 ops on "Sprint" (b1); saved.');
    assert.deepEqual(Object.keys(data.ids).sort(), ["c1", "f1", "n1", "s1"]);
    assert.equal(data.created.length, 4);
    assert.deepEqual(data.deleted, []);
    const ids = Object.values(data.ids) as string[];
    assert.deepEqual(data.elements.map((e: any) => e.id).sort(), [...new Set([...data.created, ...data.updated])].sort());
    const conn = data.elements.find((e: any) => e.key === "c1");
    assert.deepEqual(conn.from, { id: data.ids.n1, key: "n1" });
    assert.deepEqual(conn.to, { id: data.ids.s1, key: "s1" });
    assert.equal(data.elements.find((e: any) => e.key === "n1").parent, data.ids.f1);

    // saved, with the new records, before the reply
    const put = r.server.log.lastIndexOf("PUT snapshot b1");
    assert.ok(put >= 0 && put < r.server.log.indexOf(`reply ${reply.id} ok`), r.server.log.join(", "));
    const saved = r.server.saves.at(-1)!.json;
    for (const id of ids) assert.ok(saved.includes(JSON.stringify(id)), `${id} in the save`);
    await wait(20);
    assert.equal(r.host.rooms.info()[0].dirty, false, "the agent's save left nothing to save again");

    // one message to the window carries every new record
    await until(() => ids.every((id) => !!w.store.get(id as any)), "the records at the window");
    await wait(100);
    const patches = patchesWith(got.slice(before), ids);
    assert.equal(patches.length, 1, `one change, got ${patches.length}`);
    for (const id of ids) assert.ok(JSON.stringify(patches[0]).includes(JSON.stringify(id)), `${id} in the one change`);
    assert.deepEqual(w.errors, []);
  } finally { await stop(r); }
});

test("an invalid op changes nothing: no message to the window, no save, the error names the op", async () => {
  const r = rig();
  try {
    const { w, got } = await open(r, "s_a");
    const ok = await call(r, "apply", { ops: [FOUR_OPS[0]] });
    assert.equal(ok.error, undefined);
    await wait(100);
    const docs = JSON.stringify(w.docs()), before = got.length, puts = r.server.saves.length;
    const reply = await call(r, "apply", { ops: [
      { op: "create", type: "sticky", ref: "x1", x: 0, y: 400 },
      { op: "update", id: "n1", text: "changed" },
      { op: "update", id: "n1", fill: "blue" },
    ] });
    assert.match(reply.error!, /^INVALID_OP: op 2 \(update n1\): /);
    await wait(150);
    assert.equal(r.server.saves.length, puts, "no save");
    const patches = got.slice(before).filter((m) => (m.type === "data" ? m.data : [m]).some((p: any) => p.type === "patch"));
    assert.deepEqual(patches, [], "no change sent");
    assert.equal(JSON.stringify(w.docs()), docs);
    // the next call still works on the room as it is
    const again = await call(r, "apply", { ops: [{ op: "update", id: "n1", text: "now" }] });
    assert.equal(again.error, undefined, again.error);
  } finally { await stop(r); }
});

test("apply without ops, and delete_elements with a bad form, are BAD_ARGS", async () => {
  const r = rig();
  try {
    assert.equal((await call(r, "apply", {})).error,
      "BAD_ARGS: this is a new board; apply takes ops (a list of create, update and delete operations; see the tool description)");
    assert.match((await call(r, "delete_elements", { refs: [] })).error!, /^BAD_ARGS: refs is a non-empty list of \{"id": "shape:…"\} or \{"key": "…"\}$/);
    assert.match((await call(r, "delete_elements", { refs: ["n1"] })).error!, /^BAD_ARGS: refs\[0\] is not/);
    assert.equal((await call(r, "delete_elements", { refs: [{ key: "zz" }] })).error, 'UNKNOWN_REF: refs[0] {"key":"zz"} names no element of this board');
    assert.equal((await call(r, "list_boards", {})).error, "NOT_SUPPORTED: the board host does not answer list_boards");
  } finally { await stop(r); }
});

test("a failed save is SAVE_FAILED; the window keeps the change", async () => {
  const r = rig();
  try {
    const { w } = await open(r, "s_a");
    r.server.failSaves = 1;
    const reply = await call(r, "apply", { ops: [{ op: "create", type: "sticky", ref: "n1", x: 0, y: 0, text: "kept" }] });
    assert.match(reply.error!, /^SAVE_FAILED: the change was made but could not be saved: /);
    await until(() => w.store.allRecords().some((x: any) => x.meta?.key === "n1"), "the change at the window");
  } finally { await stop(r); }
});

test("a long text in a sticky through apply is fitted as a sticky created directly", async () => {
  const text = "A long sticky text that has to shrink: " + "several words that wrap over many lines ".repeat(8);
  const rt = await loadRuntime();
  const editor = rt.createEditor();
  let direct: number;
  try {
    editor.createShapes([{ type: STICKY_TYPE, x: 0, y: 0, props: { richText: toRichText(text) } } as any]);
    direct = (editor.getCurrentPageShapes()[0].props as any).fitted;
  } finally { editor.dispose(); }
  const r = rig();
  try {
    const { w } = await open(r, "s_a");
    const reply = await call(r, "apply", { ops: [{ op: "create", type: "sticky", ref: "n1", x: 0, y: 0, text }] });
    assert.equal(reply.error, undefined, reply.error);
    const id = parse(reply.result).data.ids.n1;
    await until(() => !!w.store.get(id), "the sticky at the window");
    const fitted = (w.store.get(id) as any).props.fitted;
    assert.equal(fitted, direct);
    assert.ok(fitted < 48, `shrunk (${fitted})`);
  } finally { await stop(r); }
});

test("read_board, delete_elements by key, the marker and its replay, and a person's edit kept by the next apply", async () => {
  const r = rig();
  try {
    const { w: a } = await open(r, "s_a");
    const applied = await call(r, "apply", { ops: FOUR_OPS });
    const { data } = parse(applied.result);

    // the marker at the connected window
    await until(() => a.customs.length > 0, "the marker");
    const m = a.customs[0].data;
    assert.deepEqual(Object.keys(m).sort(), ["bounds", "chat", "label", "ttlMs", "type"]);
    assert.equal(m.type, "aiwb_agent");
    assert.equal(m.label, "Claude");
    assert.equal(m.chat, "c1");
    assert.equal(m.ttlMs, 4000);
    assert.deepEqual(Object.keys(m.bounds).sort(), ["h", "w", "x", "y"]);
    assert.ok(m.bounds.w > 500 && m.bounds.h > 100, JSON.stringify(m.bounds));

    // a window that connects 1 s later gets it too, with what is left of the ttl
    await wait(1000);
    const { w: b } = await open(r, "s_b");
    await until(() => b.customs.length > 0, "the marker at the late window");
    const late = b.customs[0].data;
    assert.deepEqual(late.bounds, m.bounds);
    assert.ok(late.ttlMs > 0 && late.ttlMs <= 3000, `ttl left ${late.ttlMs}`);

    // read_board names the connector's ends
    const read = await call(r, "read_board", {});
    assert.equal(read.error, undefined, read.error);
    const lines = (read.result as string).split("\n");
    assert.equal(lines[0], 'Board "Sprint" (b1), a new board. 4 elements. Coordinates are page px; parent names the frame that holds an element.');
    const els = lines.slice(1).map((l) => JSON.parse(l));
    assert.equal(els[0].type, "frame");
    const conn = els.find((e) => e.type === "connector");
    assert.deepEqual(conn.from, { id: data.ids.n1, key: "n1" });
    assert.deepEqual(conn.to, { id: data.ids.s1, key: "s1" });

    // a person moves the shape in a window; the next apply (another field of the same shape) keeps the move
    a.store.update(data.ids.s1, (s: any) => ({ ...s, x: 345 }));
    await until(() => (b.store.get(data.ids.s1) as any)?.x === 345, "the person's edit through the room");
    const upd = await call(r, "apply", { ops: [{ op: "update", id: "s1", text: "API v2" }] });
    assert.equal(upd.error, undefined, upd.error);
    const el = parse(upd.result).data.elements.find((e: any) => e.key === "s1");
    assert.equal(el.text, "API v2");
    await until(() => JSON.stringify((a.store.get(data.ids.s1) as any)?.props.richText).includes("API v2"), "the update at a");
    assert.equal((a.store.get(data.ids.s1) as any).x, 345, "the person's move kept");

    // delete_elements by key: the window loses it, the connector keeps a free end
    const del = await call(r, "delete_elements", { refs: [{ key: "n1" }], cascade: true });
    assert.equal(del.error, undefined, del.error);
    const d = parse(del.result);
    assert.equal(d.sentence, 'Deleted 1 element on "Sprint" (b1); saved.');
    assert.deepEqual(d.data.deleted, [data.ids.n1]);
    await until(() => !a.store.get(data.ids.n1) && !b.store.get(data.ids.n1), "the sticky gone at both windows");
    assert.ok(a.store.get(data.ids.c1), "the connector stays");
    const after = (await call(r, "read_board", {})).result as string;
    assert.match(after, /3 elements/);
  } finally { await stop(r); }
});

test("get_image answers text and a PNG", async () => {
  const r = rig();
  try {
    await call(r, "apply", { ops: FOUR_OPS });
    const reply = await call(r, "get_image", {});
    assert.equal(reply.error, undefined, reply.error);
    assert.match(reply.result.text, /4 elements/);
    assert.equal(reply.result.image.mimeType, "image/png");
    assert.equal(Buffer.from(reply.result.image.data, "base64").subarray(1, 4).toString("latin1"), "PNG");
  } finally { await stop(r); }
});

test("timings: an apply of 10 ops, a read_board, a get_image (end to end on the fake server)", async (t) => {
  const r = rig();
  try {
    await open(r, "s_a");
    await call(r, "read_board", {}); // (the editor made, the runtime warm)
    const ops: unknown[] = [];
    for (let i = 0; i < 8; i++) ops.push({ op: "create", type: i % 2 ? "sticky" : "shape", ref: `e${i}`, x: i * 250, y: 0, text: `Element ${i}` });
    ops.push({ op: "create", type: "connector", from: "e0", to: "e1" }, { op: "create", type: "frame", ref: "f", contains: ["e0", "e1", "e2"] });
    const time = async (name: string, args: unknown) => {
      const t0 = performance.now();
      const reply = await call(r, name, args);
      assert.equal(reply.error, undefined, reply.error);
      return Math.round(performance.now() - t0);
    };
    const apply = await time("apply", { ops });
    const read = await time("read_board", {});
    const image = await time("get_image", {});
    t.diagnostic(`apply 10 ops: ${apply} ms; read_board: ${read} ms; get_image: ${image} ms`);
  } finally { await stop(r); }
});
