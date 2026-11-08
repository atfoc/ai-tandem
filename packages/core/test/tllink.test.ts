// The window's line to a new board (src/tl/link.ts, design 2.4 and 2.5) on a virtual clock, a fake api and the real registry
// (src/tl/registry.ts) as its hub: one sync call in flight, at least the gap apart, what comes meanwhile in the next call; a
// session that ends without being asked is reopened after 0.5, 1, 2, 5, 5… s; the server's stream going down waits, coming back
// reopens; close ends it all; the order of what goes out and what comes in is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openTlLink, type TlLinkApi, type TlTimers } from "../src/tl/link.ts";
import { createTlRegistry, type TlRegistry } from "../src/tl/registry.ts";

/** A clock the test moves: tasks run in time order when it passes them. */
function clock(): TlTimers & { advance(ms: number): Promise<void>; at: number; pending(): number } {
  let at = 0, seq = 0;
  const tasks = new Map<number, { when: number; fn: () => void }>();
  const c = {
    get at() { return at; },
    now: () => at,
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; tasks.set(id, { when: at + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { tasks.delete(id as number); },
    pending: () => tasks.size,
    async advance(ms: number) {
      const end = at + ms;
      for (;;) {
        await settle();
        const next = [...tasks.entries()].filter(([, x]) => x.when <= end).sort((a, b) => a[1].when - b[1].when || a[0] - b[0])[0];
        if (!next) break;
        tasks.delete(next[0]);
        at = next[1].when;
        next[1].fn();
      }
      at = end;
      await settle();
    },
  };
  return c;
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

type Deferred<T> = { resolve(v: T): void; reject(e: unknown): void };
type Call = { what: "open" | "sync" | "close"; board: string; session?: string; messages?: string[] } & Deferred<any>;

/** An api whose calls the test answers; close is answered at once. auto: open and sync answered at once too. */
function fakeApi(o: { auto?: boolean } = {}): TlLinkApi & { calls: Call[]; last(what: Call["what"]): Call; of(what: Call["what"]): Call[]; n: number } {
  const calls: Call[] = [];
  let n = 0;
  const make = (c: Omit<Call, "resolve" | "reject">) => new Promise<any>((resolve, reject) => {
    const call = { ...c, resolve, reject } as Call;
    calls.push(call);
    if (c.what === "close") resolve(undefined);
    else if (o.auto) resolve(c.what === "open" ? { session: `s_${++n}` } : undefined);
  });
  return {
    calls, get n() { return n; }, set n(v) { n = v; },
    last: (what) => calls.filter((c) => c.what === what).at(-1)!,
    of: (what) => calls.filter((c) => c.what === what),
    open: (board) => make({ what: "open", board }),
    sync: (board, session, messages) => make({ what: "sync", board, session, messages: [...messages] }),
    close: (board, session) => make({ what: "close", board, session }),
  };
}
const gone = () => Object.assign(new Error("no such session"), { status: 410, code: "no_session" });

function setup(o: { auto?: boolean; board?: string; maxQueue?: number } = {}) {
  const t = clock(), a = fakeApi(o);
  const reg: TlRegistry = createTlRegistry({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  const link = openTlLink(o.board ?? "b_1", { api: a, hub: reg, timers: t, sendGap: 25, backoff: [500, 1000, 2000, 5000], ...(o.maxQueue ? { maxQueue: o.maxQueue } : {}) });
  const statuses: string[] = [], got: string[][] = [];
  link.onStatus((s, r) => statuses.push(r ? `${s}:${r}` : s));
  link.onMessages((m) => got.push(m));
  return { t, a, reg, link, statuses, got };
}

test("the link opens at once (connecting), and is online when the open is answered", async () => {
  const { a, link, statuses } = setup();
  assert.equal(link.status, "connecting");
  assert.deepEqual(a.calls.map((c) => [c.what, c.board]), [["open", "b_1"]]);
  a.last("open").resolve({ session: "s_1" });
  await settle();
  assert.equal(link.status, "online");
  assert.deepEqual(statuses, ["online"]);
});

test("one sync call in flight: what is sent meanwhile goes together in the next call, at least the gap after the last one started", async () => {
  const { t, a, link } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.send(["m1"]);
  assert.deepEqual(a.of("sync").map((c) => [c.session, c.messages]), [["s_1", ["m1"]]], "the first goes at once");
  link.send(["m2"]); link.send(["m3", "m4"]);
  assert.equal(a.of("sync").length, 1, "nothing while a call is in flight");
  await t.advance(100);
  assert.equal(a.of("sync").length, 1, "still in flight: nothing, however long");
  a.of("sync")[0].resolve(undefined);
  await settle();
  assert.deepEqual(a.of("sync")[1].messages, ["m2", "m3", "m4"], "coalesced, the gap long past");
  a.of("sync")[1].resolve(undefined);
  await settle();
  // answered at once: the next call still waits for the gap after the start of the one before
  link.send(["m5"]);
  assert.equal(a.of("sync").length, 2, "the gap since the last start has not passed");
  link.send(["m6"]);
  await t.advance(24);
  assert.equal(a.of("sync").length, 2);
  await t.advance(1);
  assert.deepEqual(a.of("sync")[2].messages, ["m5", "m6"]);
});

test("the order of what goes out is kept over many batches, and what comes in is handed on in order", async () => {
  const { t, a, reg, link, got } = setup({ auto: true });
  await settle();
  const sent: string[] = [];
  for (let i = 0; i < 200; i++) {
    const m = `m${i}`; sent.push(m); link.send([m]);
    if (i % 7 === 0) await t.advance(10);
  }
  await t.advance(1000);
  assert.deepEqual(a.of("sync").flatMap((c) => c.messages), sent);
  assert.ok(a.of("sync").length > 1 && a.of("sync").length < 200, "batched");
  for (let i = 0; i < 5; i++) reg.event("local", { type: "tl_sync", board: "b_1", session: "s_1", messages: [`in${i}a`, `in${i}b`] });
  assert.deepEqual(got.flat(), ["in0a", "in0b", "in1a", "in1b", "in2a", "in2b", "in3a", "in3b", "in4a", "in4b"]);
});

test("410 ends the session: offline, no close, a reopen after 0.5, 1, 2, 5, 5 s while the opens fail, and the backoff starts again after an answered open", async () => {
  const { t, a, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.send(["m1"]);
  link.send(["m2"]); // queued for s_1: dropped with it
  a.last("sync").reject(gone());
  await settle();
  assert.equal(link.status, "offline");
  assert.equal(statuses.at(-1), "offline:no_session");
  assert.equal(a.of("close").length, 0, "the server does not know the session: nothing to close");
  const opensAt: number[] = [];
  for (const wait of [500, 1000, 2000, 5000, 5000]) {
    await t.advance(wait - 1);
    assert.equal(a.of("open").length, 1 + opensAt.length, `not before ${wait} ms`);
    await t.advance(1);
    assert.equal(a.of("open").length, 2 + opensAt.length, `after ${wait} ms`);
    opensAt.push(t.at);
    assert.equal(link.status, "connecting");
    if (opensAt.length < 5) { a.last("open").reject(new Error("unreachable")); await settle(); }
  }
  a.last("open").resolve({ session: "s_2" });
  await settle();
  assert.equal(link.status, "online");
  assert.equal(a.of("sync").length, 1, "what was queued for s_1 never went out");
  link.send(["m3"]);
  assert.deepEqual([a.last("sync").session, a.last("sync").messages], ["s_2", ["m3"]]);
  a.last("sync").reject(gone());
  await settle();
  await t.advance(500);
  assert.equal(a.of("open").length, 7, "after an answered open the first wait is 0.5 s again");
});

test("a sync that fails otherwise ends the session too, and closes it on the server, which may still know it", async () => {
  const { t, a, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.send(["m1"]);
  a.last("sync").reject(new Error("no answer"));
  await settle();
  assert.equal(statuses.at(-1), "offline:no answer");
  assert.deepEqual(a.of("close").map((c) => c.session), ["s_1"]);
  await t.advance(500);
  assert.equal(a.of("open").length, 2);
});

test("a tl_closed event of the session ends it: offline with the server's reason, then a reopen", async () => {
  const { t, a, reg, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  reg.event("local", { type: "tl_closed", board: "b_1", session: "s_other", reason: "deleted" });
  assert.equal(link.status, "online", "another session's close is not this link's");
  reg.event("local", { type: "tl_closed", board: "b_1", session: "s_1", reason: "host_stopped" });
  assert.equal(statuses.at(-1), "offline:host_stopped");
  await t.advance(499);
  assert.equal(a.of("open").length, 1);
  await t.advance(1);
  assert.equal(a.of("open").length, 2);
});

test("the server's stream going down: offline and no reopen while it is down; coming back reopens", async () => {
  const { t, a, reg, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.send(["m1"]);
  reg.streamState("local", false);
  assert.equal(statuses.at(-1), "offline:stream_down");
  a.last("sync").resolve(undefined); // the answer of the session before: no harm, nothing follows
  await t.advance(60_000);
  assert.equal(a.of("open").length, 1, "nothing is opened while the stream is down");
  reg.streamState("local", true);
  await t.advance(500);
  assert.equal(a.of("open").length, 2);
  a.last("open").resolve({ session: "s_2" });
  await settle();
  assert.equal(link.status, "online");
  assert.equal(a.of("sync").length, 1);
});

test("another server's stream is not this link's; a stream that came back without a down seen counts as a close", async () => {
  const { t, a, reg, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  reg.streamState("s_aaaaaaaaaaaa", false);
  reg.streamState("s_aaaaaaaaaaaa", true);
  assert.equal(link.status, "online");
  reg.streamState("local", true); // a hello: the server dropped this window's sessions with its stream before
  assert.equal(statuses.at(-1), "offline:stream_reopened");
  await t.advance(500);
  assert.equal(a.of("open").length, 2);
});

test("a link of a section's board opens on that server and hears that server's events and stream", async () => {
  const { a, reg, link, got } = setup({ board: "s_aaaaaaaaaaaa~b_9" });
  assert.equal(a.last("open").board, "s_aaaaaaaaaaaa~b_9");
  a.last("open").resolve({ session: "s_1" });
  await settle();
  reg.event("local", { type: "tl_sync", session: "s_1", messages: ["not mine"] });
  reg.event("s_aaaaaaaaaaaa", { type: "tl_sync", session: "s_1", messages: ["mine"] });
  assert.deepEqual(got, [["mine"]]);
  reg.streamState("local", false);
  assert.equal(link.status, "online");
  reg.streamState("s_aaaaaaaaaaaa", false);
  assert.equal(link.status, "offline");
});

test("close: the session is closed on the server, nothing is reopened or sent, and the link says nothing more", async () => {
  const { t, a, reg, link, statuses, got } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.close();
  assert.deepEqual(a.of("close").map((c) => c.session), ["s_1"]);
  link.send(["late"]);
  reg.event("local", { type: "tl_sync", session: "s_1", messages: ["late"] });
  reg.event("local", { type: "tl_closed", session: "s_1", reason: "deleted" });
  reg.streamState("local", false); reg.streamState("local", true);
  await t.advance(60_000);
  assert.equal(a.of("open").length, 1);
  assert.equal(a.of("sync").length, 0);
  assert.deepEqual(got, []);
  assert.deepEqual(statuses, ["online"]);
  assert.equal(link.status, "offline");
  assert.equal(t.pending(), 0, "no timer left");
});

test("close while the open is in flight: the session it answers is closed at once, and close while offline stops the reopen", async () => {
  {
    const { t, a, link } = setup();
    link.close();
    a.last("open").resolve({ session: "s_late" });
    await settle();
    assert.deepEqual(a.of("close").map((c) => c.session), ["s_late"]);
    await t.advance(60_000);
    assert.equal(a.of("open").length, 1);
  }
  {
    const { t, a, link } = setup();
    a.last("open").reject(new Error("unreachable"));
    await settle();
    assert.equal(link.status, "offline");
    link.close();
    await t.advance(60_000);
    assert.equal(a.of("open").length, 1);
  }
});

test("restart closes the session and opens a new one at once", async () => {
  const { a, link, statuses } = setup();
  a.last("open").resolve({ session: "s_1" });
  await settle();
  link.send(["m1"]); link.send(["m2"]);
  link.restart();
  assert.deepEqual(a.of("close").map((c) => c.session), ["s_1"]);
  assert.equal(a.of("open").length, 2);
  assert.equal(link.status, "connecting");
  a.of("sync")[0].resolve(undefined);
  a.last("open").resolve({ session: "s_2" });
  await settle();
  assert.deepEqual(statuses, ["online", "connecting", "online"]);
  assert.equal(a.of("sync").length, 1, "what was queued for s_1 is not sent into s_2");
});

test("what is sent while the link is not online is not sent; a queue too long ends the session", async () => {
  const { t, a, link, statuses } = setup({ maxQueue: 3 });
  link.send(["early"]);
  a.last("open").resolve({ session: "s_1" });
  await settle();
  assert.equal(a.of("sync").length, 0);
  link.send(["m1"]); // in flight
  link.send(["m2", "m3"]);
  link.send(["m4", "m5"]);
  assert.equal(statuses.at(-1), "offline:queue_full");
  assert.deepEqual(a.of("close").map((c) => c.session), ["s_1"]);
  await t.advance(500);
  assert.equal(a.of("open").length, 2);
});

test("events of a session that come before its open is answered are handed to the link once it is online, in order", async () => {
  const { a, reg, got } = setup();
  reg.event("local", { type: "tl_sync", session: "s_1", messages: ["a"] });
  reg.event("local", { type: "tl_sync", session: "s_1", messages: ["b"] });
  a.last("open").resolve({ session: "s_1" });
  await settle();
  assert.deepEqual(got, [["a"], ["b"]]);
});
