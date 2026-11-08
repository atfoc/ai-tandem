// The synced store (view/sync.ts) end to end in one process: two TlSyncs on fake links (test/fakelink.ts) into one TLSocketRoom
// of the shared schema. A put arrives at the other window; presence carries the person's name; a cut link converges again and
// keeps what was edited while cut off; the agent's custom message becomes a marker; a lone window is not in tldraw's 1 fps solo
// mode (O2); a rejected client is replaced by a fresh one, and gives up after maxRejections.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { TLSocketRoom } from "@tldraw/sync-core";
import type { TLRecord } from "tldraw";
import { tlSchema } from "../src/model/schema.ts";
import { TlSync, type TlUser } from "../src/view/sync.ts";
import { RoomLink } from "./fakelink.ts";
import { PAGE, sticky as bare } from "./records.ts";

// a full shape record (records.ts leaves out what read.ts does not look at)
const sticky = (id: string, o: Parameters<typeof bare>[1] = {}) => ({ opacity: 1, ...bare(id, o) });

after(() => setImmediate(() => process.exit(process.exitCode ?? 0)));

// tldraw's sync client throttles with requestAnimationFrame (a page has it; Node does not)
const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => unknown; cancelAnimationFrame?: (t: unknown) => void };
g.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
g.cancelAnimationFrame ??= (t) => clearTimeout(t as ReturnType<typeof setTimeout>);

type Rec = { id: string; typeName: string; [k: string]: unknown };

async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const quiet = { warn: () => {}, error: () => {} };
const ALICE: TlUser = { id: "u_alice", name: "Teal Otter", color: "#0d9488" };
const BOB: TlUser = { id: "u_bob", name: "Amber Fox", color: "#d97706" };

function setup() {
  const room = new TLSocketRoom<TLRecord, void>({ schema: tlSchema as never, log: quiet });
  const open: Array<{ sync: TlSync; link: RoomLink }> = [];
  const window = (name: string, user: TlUser, opts: Partial<ConstructorParameters<typeof TlSync>[0]> = {}) => {
    const link = new RoomLink(room, name);
    const sync = new TlSync({ link, user, ...opts });
    link.open();
    open.push({ sync, link });
    return { sync, link };
  };
  const done = () => {
    for (const w of open) w.sync.dispose();
    room.close();
  };
  return { room, window, done };
}

const shapes = (s: TlSync) => (s.store ? (s.store.allRecords() as unknown as Rec[]).filter((r) => r.typeName === "shape") : []);
const get = (s: TlSync, id: string) => s.store?.get(id as never) as unknown as Rec | undefined;
const loaded = (s: TlSync) => s.getSnapshot().loaded && s.getSnapshot().link === "online";

async function ensurePage(s: TlSync) {
  if (!s.store!.get(PAGE.id as never)) s.store!.put([PAGE as never]);
}

test("a sticky put by window A arrives at window B; B sees A's presence with A's name", async () => {
  const { window, done } = setup();
  try {
    const a = window("a", ALICE), b = window("b", BOB);
    assert.equal(a.sync.getSnapshot().store.status, "loading");
    await until(() => loaded(a.sync) && loaded(b.sync), "both loaded");
    const st = a.sync.getSnapshot().store;
    assert.equal(st.status, "synced-remote");
    assert.equal(st.status === "synced-remote" && st.connectionStatus, "online");
    await ensurePage(a.sync);
    a.sync.store!.put([sticky("shape:s1", { x: 10, y: 20, key: "idea" }) as never]);
    await until(() => !!get(b.sync, "shape:s1"), "sticky at B");
    const got = get(b.sync, "shape:s1")!;
    assert.equal(got.type, "aiwb-sticky");
    assert.equal(got.x, 10);
    assert.deepEqual(got.meta, { key: "idea" });
    // presence: ensureStoreIsUsable made the session records, so A publishes {userId, userName, color}
    const presenceOf = (s: TlSync, name: string) =>
      (s.store!.allRecords() as unknown as Rec[]).find((r) => r.typeName === "instance_presence" && r.userName === name);
    await until(() => !!presenceOf(b.sync, "Teal Otter"), "A's presence at B");
    const p = presenceOf(b.sync, "Teal Otter")!;
    assert.equal(p.userId, "user:u_alice");
    assert.equal(p.color, "#0d9488");
  } finally {
    done();
  }
});

test("a link cut and opened again converges; edits made while cut off are kept", async () => {
  const { window, done } = setup();
  try {
    const a = window("a", ALICE), b = window("b", BOB);
    await until(() => loaded(a.sync) && loaded(b.sync), "both loaded");
    await ensurePage(a.sync);
    a.sync.store!.put([sticky("shape:s1", { x: 0 }) as never, sticky("shape:s2", { x: 0 }) as never, sticky("shape:gone") as never]);
    await until(() => shapes(b.sync).length === 3, "three at B");

    a.link.cut();
    assert.equal(a.sync.getSnapshot().link, "offline");
    const st = a.sync.getSnapshot().store;
    assert.equal(st.status === "synced-remote" && st.connectionStatus, "offline");
    // while A is cut off: A moves s1, makes s3, deletes gone; B moves s1 too (later on the wall clock) and recolours s2
    const s1 = get(a.sync, "shape:s1")!;
    a.sync.store!.put([{ ...s1, x: 333 } as never, sticky("shape:s3", { x: 900 }) as never]);
    a.sync.store!.remove(["shape:gone" as never]);
    const b1 = get(b.sync, "shape:s1")!, b2 = get(b.sync, "shape:s2")!;
    b.sync.store!.put([{ ...b1, x: 444 } as never, { ...b2, props: { ...(b2.props as object), color: "violet" } } as never]);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(get(b.sync, "shape:s3"), undefined, "nothing of A's crossed while cut");

    a.link.open();
    const same = () => {
      const ka = JSON.stringify(shapes(a.sync).map((r) => [r.id, r.x, (r.props as { color: string }).color]).sort());
      const kb = JSON.stringify(shapes(b.sync).map((r) => [r.id, r.x, (r.props as { color: string }).color]).sort());
      return ka === kb;
    };
    // (wait for the end state itself: right after the reconnect A holds the room's state, `gone` included, until its pending
    // changes are rebased and pushed, and on a loaded machine the two windows can match in that moment)
    await until(() => loaded(a.sync) && !!get(b.sync, "shape:s3") && !get(b.sync, "shape:gone") && same(), "converged");
    assert.equal(get(b.sync, "shape:gone"), undefined, "A's offline delete reached B");
    assert.equal(get(b.sync, "shape:s3")!.x, 900, "A's offline create reached B");
    assert.equal((get(a.sync, "shape:s2")!.props as { color: string }).color, "violet", "B's edit reached A");
    // the same property changed on both sides: A's offline value is pushed after B's, so the last to reach the room wins (A's)
    assert.equal(get(a.sync, "shape:s1")!.x, 333);
    assert.equal(get(b.sync, "shape:s1")!.x, 333);
  } finally {
    done();
  }
});

test("the agent's custom message becomes a marker (same chat replaces, other chats add)", async () => {
  const { room, window, done } = setup();
  try {
    const seen: unknown[] = [];
    const a = window("a", ALICE, { onCustomMessage: (d) => seen.push(d) });
    await until(() => loaded(a.sync), "loaded");
    const msg = { type: "aiwb_agent", label: "Claude", chat: "c_1", bounds: { x: 1, y: 2, w: 3, h: 4 }, ttlMs: 4000 };
    room.sendCustomMessage("a-1", msg);
    await until(() => a.sync.markers.getSnapshot().length === 1, "marker");
    assert.deepEqual(seen, [msg]);
    const m = a.sync.markers.getSnapshot()[0];
    assert.equal(m.label, "Claude");
    assert.deepEqual(m.bounds, msg.bounds);
    room.sendCustomMessage("a-1", { ...msg, bounds: { x: 9, y: 9, w: 1, h: 1 } });
    room.sendCustomMessage("a-1", { ...msg, chat: "c_2", label: "Cursor" });
    room.sendCustomMessage("a-1", { type: "something_else" });
    await until(() => seen.length === 4, "all four");
    assert.deepEqual(a.sync.markers.getSnapshot().map((x) => [x.chat, x.label, x.bounds.x]), [["c_1", "Claude", 9], ["c_2", "Cursor", 1]]);
  } finally {
    done();
  }
});

test("a lone window gets a change written into the room fast (presenceMode full, not 1 fps solo)", async () => {
  const { room, window, done } = setup();
  try {
    const a = window("a", ALICE);
    await until(() => loaded(a.sync), "loaded");
    await ensurePage(a.sync);
    await until(() => !!room.getRecord(PAGE.id), "page in the room");
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `shape:agent${i}`;
      const t0 = Date.now();
      await room.updateStore((store) => { store.put(sticky(id, { x: i * 300 }) as never); });
      await until(() => !!get(a.sync, id), `agent change ${i}`);
      times.push(Date.now() - t0);
    }
    // solo mode would be ~900 ms per frame; 30 fps is ~35 ms. Generous bound for a loaded machine.
    assert.ok(Math.max(...times) < 600, `latencies ${times.join(", ")} ms`);
  } finally {
    done();
  }
});

test("a rejected window gets a fresh client, shows the reason, and gives up after maxRejections", async () => {
  const { room, window, done } = setup();
  try {
    const a = window("a", ALICE, { maxRejections: 2 });
    await until(() => loaded(a.sync), "loaded");
    const first = a.sync.store;
    room.closeSession("a-1", "INVALID_RECORD");
    await until(() => a.sync.getSnapshot().error === "INVALID_RECORD", "error shown");
    assert.equal(a.sync.getSnapshot().store.status, "loading");
    assert.notEqual(a.sync.store, first, "a fresh store");
    a.link.open(); // the real link reopens by itself after its backoff
    await until(() => loaded(a.sync) && !a.sync.getSnapshot().error, "connected again, error cleared");
    // a rejection after a connect starts a new count: not fatal yet
    room.closeSession("a-2", "CLIENT_TOO_OLD");
    await until(() => a.sync.getSnapshot().error === "CLIENT_TOO_OLD", "second error");
    assert.equal(a.sync.getSnapshot().fatal, false);
    // the next session is rejected before it connects: two in a row, so fatal; the state says so and nothing is retried
    a.link.open();
    room.closeSession("a-3", "CLIENT_TOO_OLD");
    await until(() => a.sync.getSnapshot().fatal, "fatal");
    assert.equal(a.sync.getSnapshot().store.status, "error");
    assert.equal(a.sync.store, null);
    a.link.open();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(a.sync.getSnapshot().fatal, true);
    assert.equal(a.sync.store, null, "no new client after giving up");
  } finally {
    done();
  }
});
