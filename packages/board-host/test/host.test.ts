// The board host's loop against a fake server: windows (real tldraw sync clients) converge through it, messages that arrive while
// a room loads are replayed, `gone` closes a session, saves follow changes, a quiet room closes with a save, agents' calls are
// answered NOT_SUPPORTED, and server_stopping saves before it answers.
// (first: the page before any tldraw module, as in src/bin.ts; rooms.ts → schema.ts imports tldraw)
import "../src/node/install-page.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startHost, type Host, type HostOptions } from "../src/host.ts";
import { FakeServer, geo, pageOf, until, wait, SERVER, type FakeWindow } from "./support.ts";

type Rig = { server: FakeServer; host: Host; lines: string[]; windows: FakeWindow[] };

function rig(o: Partial<HostOptions> = {}, server = new FakeServer()): Rig {
  const lines: string[] = [];
  const host = startHost({ client: server, server: SERVER, log: (l) => lines.push(l), sendGapMs: 5, saveDelayMs: 40, quietMs: 60_000, ...o });
  server.open();
  return { server, host, lines, windows: [] };
}

async function stop(r: Rig) {
  for (const w of r.windows) w.close();
  await r.host.shutdown(500);
}

const open = (r: Rig, board: string, session: string) => {
  const w = r.server.window(board, session);
  r.windows.push(w);
  return w;
};

const sameDocs = (a: FakeWindow, b: FakeWindow) => JSON.stringify(sorted(a.docs())) === JSON.stringify(sorted(b.docs()));
const sorted = (o: Record<string, any>) => Object.keys(o).sort().map((k) => o[k]);

test("two windows converge through the host, both ways", async () => {
  const r = rig();
  try {
    const a = open(r, "b1", "s_a"), b = open(r, "b1", "s_b");
    await until(() => a.loaded && b.loaded, "both windows loaded");
    const page = pageOf(a);
    a.store.put([geo("one", page, 10)]);
    await until(() => !!b.store.get("shape:one" as any), "a's shape at b");
    b.store.put([geo("two", page, 20)]);
    b.store.update("shape:one" as any, (s: any) => ({ ...s, x: 99 }));
    await until(() => (a.store.get("shape:one" as any) as any)?.x === 99 && !!a.store.get("shape:two" as any), "b's changes at a");
    await until(() => sameDocs(a, b), "the same documents");
    // (one call in flight: every out call carried whole batches, and no message of the host was lost)
    assert.ok(r.server.outs.length > 0);
    assert.deepEqual(a.errors, []);
    assert.deepEqual(b.errors, []);
  } finally { await stop(r); }
});

test("messages that arrive while the room loads are replayed in order", async () => {
  const server = new FakeServer();
  let release!: () => void;
  server.loadGate = new Promise((res) => { release = res; });
  const r = rig({}, server);
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.socket.sent > 0, "a's connect sent");
    await wait(20);
    assert.equal(r.host.rooms.info()[0]?.loading, true);
    assert.equal(server.outs.length, 0, "nothing answered before the load");
    release();
    await until(() => a.loaded, "a loaded after the replay");
    const b = open(r, "b1", "s_b");
    await until(() => b.loaded, "b loaded");
    a.store.put([geo("x", pageOf(a))]);
    await until(() => !!b.store.get("shape:x" as any), "the shape at b");
  } finally { await stop(r); }
});

test("a room loads from the stored snapshot", async () => {
  const first = rig();
  let json = "";
  try {
    const a = open(first, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    a.store.put([geo("kept", pageOf(a), 7)]);
    await until(() => first.server.saves.some((s) => s.json.includes("shape:kept")), "the save");
    json = first.server.snapshots.get("b1")!;
  } finally { await stop(first); }
  const server = new FakeServer();
  server.snapshots.set("b1", json);
  const second = rig({}, server);
  try {
    const b = open(second, "b1", "s_b");
    await until(() => b.loaded, "loaded");
    assert.equal((b.store.get("shape:kept" as any) as any)?.x, 7);
    assert.deepEqual(server.log.slice(0, 1), ["GET snapshot b1"]);
  } finally { await stop(second); }
});

test("a session the server answers as gone is closed in the room", async () => {
  const r = rig();
  try {
    const a = open(r, "b1", "s_a"), b = open(r, "b1", "s_b");
    await until(() => a.loaded && b.loaded, "loaded");
    r.server.goneSessions.add("s_b");
    a.store.put([geo("y", pageOf(a))]); // (the room broadcasts it to s_b too; the out call answers s_b gone)
    await until(() => !r.host.rooms.info()[0].sessions.includes("s_b"), "s_b closed");
    assert.deepEqual(r.host.rooms.info()[0].sessions, ["s_a"]);
    // a close of the room's own (here: none) is not reported for a session the server already forgot
    assert.ok(r.server.outs.every((o) => !(o.closed ?? []).some((c) => c.session === "s_b")));
  } finally { await stop(r); }
});

test("tl_close ends a session; tl_sync for an unknown session is answered closed", async () => {
  const r = rig();
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    r.server.emit({ type: "tl_close", board: "b1", session: "s_a" });
    assert.deepEqual(r.host.rooms.info()[0].sessions, []);
    r.server.emit({ type: "tl_sync", board: "b1", session: "s_zz", messages: ["{}"] });
    await until(() => r.server.outs.some((o) => (o.closed ?? []).some((c) => c.session === "s_zz" && c.reason === "unknown_session")), "s_zz closed");
  } finally { await stop(r); }
});

test("a save follows a change within the save delay, one save for a burst", async () => {
  const r = rig({ saveDelayMs: 100 });
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    await wait(150); // (whatever the load itself saved is done)
    const before = r.server.saves.length;
    const page = pageOf(a);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) a.store.put([geo(`b${i}`, page, i)]);
    await until(() => r.server.saves.length > before && r.server.saves.at(-1)!.json.includes("shape:b4"), "the save", 4000);
    assert.ok(Date.now() - t0 >= 90, `saved after ${Date.now() - t0} ms, not before the delay`);
    await wait(250);
    assert.equal(r.server.saves.length, before + 1, "one save for the burst");
  } finally { await stop(r); }
});

test("a failed save is tried again", async () => {
  const r = rig({ saveDelayMs: 20 });
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    r.server.failSaves = 1;
    a.store.put([geo("z", pageOf(a))]);
    await until(() => r.server.saves.some((s) => s.json.includes("shape:z")), "the save after the failure", 4000);
    assert.ok(r.lines.some((l) => /saving board b1 failed/.test(l)));
  } finally { await stop(r); }
});

test("a room with no session closes after the quiet time, saved", async () => {
  const r = rig({ quietMs: 80, saveDelayMs: 60_000 });
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    a.store.put([geo("q", pageOf(a))]);
    await until(() => r.host.rooms.info()[0]?.dirty, "the change reached the room");
    r.server.emit({ type: "tl_close", board: "b1", session: "s_a" });
    await wait(30);
    assert.equal(r.host.rooms.info().length, 1, "still open within the quiet time");
    await until(() => r.host.rooms.info().length === 0, "the room closed");
    assert.ok(r.server.saves.at(-1)!.json.includes("shape:q"), "saved before it closed");
  } finally { await stop(r); }
});

test("an open within the quiet time keeps the room", async () => {
  const r = rig({ quietMs: 60 });
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    r.server.emit({ type: "tl_close", board: "b1", session: "s_a" });
    const b = open(r, "b1", "s_b");
    await until(() => b.loaded, "b loaded");
    await wait(150);
    assert.equal(r.host.rooms.info().length, 1);
  } finally { await stop(r); }
});

test("tl_drop: archived saves and closes, deleted closes unsaved", async () => {
  const r = rig({ saveDelayMs: 60_000 });
  try {
    const a = open(r, "b1", "s_a"), b = open(r, "b2", "s_b");
    await until(() => a.loaded && b.loaded, "loaded");
    a.store.put([geo("arch", pageOf(a))]);
    b.store.put([geo("del", pageOf(b))]);
    await until(() => r.host.rooms.info().every((i) => i.dirty), "both dirty");
    r.server.emit({ type: "tl_drop", board: "b1", reason: "archived" });
    r.server.emit({ type: "tl_drop", board: "b2", reason: "deleted" });
    await until(() => r.host.rooms.info().length === 0, "both closed");
    assert.ok(r.server.snapshots.get("b1")?.includes("shape:arch"));
    assert.ok(!r.server.log.includes("PUT snapshot b2"));
    // the server closed the sessions itself: the host reports none
    assert.ok(r.server.outs.every((o) => !o.closed));
  } finally { await stop(r); }
});

test("an agent's tool is answered NOT_SUPPORTED on the loaded room; get_view in plain words", async () => {
  const seen: string[] = [];
  const r = rig({ handleTool: async (room, p) => { seen.push(`${room.board} ${p.name} ${!!room.room}`); throw Object.assign(new Error("not yet"), { code: "NOT_SUPPORTED" }); } });
  try {
    const id = r.server.rpc("read_board", {}, "b9");
    assert.match((await r.server.reply(id)).error!, /^NOT_SUPPORTED: /);
    assert.deepEqual(seen, ["b9 read_board true"]);
    assert.ok(r.server.log.includes("GET snapshot b9"));
    const v = await r.server.reply(r.server.rpc("get_view", {}, "b9"));
    assert.equal(v.error, undefined);
    assert.match(v.result, /no view/i);
  } finally { await stop(r); }
});

test("the default seam answers every tool NOT_SUPPORTED", async () => {
  const r = rig();
  try {
    for (const name of ["read_board", "apply", "delete_elements", "get_image"]) {
      const reply = await r.server.reply(r.server.rpc(name));
      assert.match(reply.error!, /^NOT_SUPPORTED: /, name);
    }
  } finally { await stop(r); }
});

test("an agent's save writes the room at once; a room an agent used closes after the quiet time", async () => {
  const r = rig({ quietMs: 80, saveDelayMs: 60_000, handleTool: async (room) => {
    await room.room.updateStore((s) => {
      const page = s.getAll().find((x: any) => x.typeName === "page") as any;
      s.put(geo("agent", page.id));
    });
    await room.save();
    return "done";
  } });
  try {
    const reply = await r.server.reply(r.server.rpc("apply"));
    assert.equal(reply.result, "done");
    assert.ok(r.server.snapshots.get("b1")?.includes("shape:agent"), "saved before the answer");
    assert.ok(r.server.log.indexOf("PUT snapshot b1") < r.server.log.indexOf(`reply ${reply.id} ok`));
    await until(() => r.host.rooms.info().length === 0, "closed after quiet");
  } finally { await stop(r); }
});

test("server_stopping saves every dirty room, then answers flushed", async () => {
  const r = rig({ saveDelayMs: 60_000 });
  try {
    const a = open(r, "b1", "s_a");
    await until(() => a.loaded, "loaded");
    a.store.put([geo("s", pageOf(a))]);
    await until(() => r.host.rooms.info()[0].dirty, "dirty");
    r.server.emit({ type: "server_stopping" });
    await until(() => r.server.log.includes("POST flushed"), "flushed");
    assert.ok(r.server.log.lastIndexOf("PUT snapshot b1") < r.server.log.indexOf("POST flushed"));
    assert.ok(r.server.snapshots.get("b1")!.includes("shape:s"));
  } finally { await stop(r); }
});

test("the end of the connection ends the host", async () => {
  const ended: string[] = [];
  const r = rig({ onEnd: (why) => ended.push(why) });
  try {
    await r.host.connected;
    r.server.state("unreachable", "gone");
    assert.deepEqual(ended, ["the connection to the server ended (gone)"]);
  } finally { await stop(r); }
});
