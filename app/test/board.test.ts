// The board screen's logic that needs no screen (B4): what the web view may navigate to, the host channel's count of requests in
// flight and its drain, the engine view's life (AD-52: one web view first), and the board's own key, ⌘⇧L.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardChannel } from "@aiwb/core/board/channel.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import type { HostChannel } from "../src/platform/board.types.ts";
import { navigation, schemeOf } from "../src/platform/boardnav.ts";
import { createHostChannel, drained, tracked } from "../src/platform/boardchannel.ts";
import type { KeyLike } from "../src/platform/keys.types.ts";
import { boardKeyHandler, pickEscape, pickableChat } from "../src/screens/board/boardkeys.ts";
import { awayNow, composerGone, finishPick, holdRef, insertRef, pickPoint, registerInserter, resetPick, setPickGo, startPick, takeHeld, type Place } from "../src/screens/board/refs.ts";
import { tapWatch } from "../src/screens/board/taps.ts";
import type { Ref } from "@aiwb/core/logic/refs.ts";
import { createEngine } from "../src/screens/board/engine.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- navigation

test("the web view may load its own page and nothing else: an http(s) address is offered to the user, any other is dropped", () => {
  const page = "file:///data/app/assets/board.html";
  assert.deepEqual(navigation(page, page), { allow: true });
  assert.deepEqual(navigation(page + "#top", page), { allow: true }, "a fragment is the same page");
  assert.deepEqual(navigation("https://example.com/a?b=1", page), { allow: false, open: "https://example.com/a?b=1", scheme: "https" });
  assert.deepEqual(navigation("HTTP://example.com", page), { allow: false, open: "HTTP://example.com", scheme: "http" });
  for (const u of ["file:///etc/passwd", "file:///data/app/assets/other.html", "javascript:alert(1)", "data:text/html,x", "intent://x#Intent;end", "about:blank", "mailto:a@b.c", "blob:null/1", "ftp://x/y", ""]) {
    const n = navigation(u, page);
    assert.equal(n.allow, false, `${u} is refused`);
    assert.equal("open" in n, false, `${u} is not offered`);
  }
  assert.equal(schemeOf("HTTPS://x"), "https");
  assert.equal(schemeOf("no scheme"), "");
});

// ---- the host's channel

/** A base channel that answers nothing: requests stay in flight until `reply`. */
function fakeBase() {
  const waiting: { op: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const base: BoardChannel = {
    send() {},
    request: ((op: { op: string }) => new Promise<unknown>((resolve, reject) => { waiting.push({ op: op.op, resolve, reject }); })) as unknown as BoardChannel["request"],
    on: () => () => {},
    ready: () => true,
  };
  return { base, waiting };
}

test("a tracked channel counts its requests in flight, and is idle when the last is answered or refused", async () => {
  const { base, waiting } = fakeBase();
  const ch = tracked(base);
  let idle = false;
  assert.equal(ch.inflight(), 0);
  await ch.idle(); // (idle at once when nothing waits)
  const a = ch.request({ op: "snapshot" }), b = ch.request({ op: "restore", elements: [] });
  void ch.idle().then(() => { idle = true; });
  assert.equal(ch.inflight(), 2);
  waiting[0].resolve({ board: "x" });
  await a;
  await wait(5);
  assert.equal(ch.inflight(), 1);
  assert.equal(idle, false);
  waiting[1].reject(new Error("gone"));
  await assert.rejects(b);
  await wait(5);
  assert.equal(ch.inflight(), 0);
  assert.equal(idle, true);
});

test("a host that goes away waits for the requests in flight, but not past its limit", async () => {
  const { base, waiting } = fakeBase();
  const ch = tracked(base);
  const p = ch.request({ op: "snapshot" });
  p.catch(() => {});
  let done = false;
  void drained(ch, 40).then(() => { done = true; });
  await wait(10);
  assert.equal(done, false, "it waits for the answer");
  waiting[0].resolve({});
  await wait(10);
  assert.equal(done, true);
  const q = ch.request({ op: "snapshot" });
  q.catch(() => {});
  const t0 = Date.now();
  await drained(ch, 30);
  assert.ok(Date.now() - t0 >= 25 && Date.now() - t0 < 500, "an unanswered request is waited for only up to the limit");
});

test("the host channel holds what is sent until the view says ready, and a reset refuses the requests waiting", async () => {
  const sent: unknown[] = [];
  const link = createHostChannel((m) => sent.push(m), { warn() {} });
  link.channel.send({ t: "unload" });
  const r = link.channel.request({ op: "snapshot" });
  assert.deepEqual(sent, [], "nothing goes before ready");
  link.receive({ t: "ready", version: "1" });
  assert.equal(sent.length, 2);
  link.reset("the web view's process ended");
  await assert.rejects(r, /process ended/);
  assert.equal(link.channel.inflight(), 0);
  link.channel.send({ t: "unload" });
  assert.equal(sent.length, 2, "a view loaded anew has to say ready again");
});

// ---- the engine view

/** A host channel that is the same object every time, with a count of what was asked. */
function fakeHost(): HostChannel & { asked: number } {
  const { base } = fakeBase();
  const t = tracked({ ...base, request: ((op: unknown) => { h.asked++; return Promise.resolve({ elements: [], op }); }) as BoardChannel["request"] });
  const h = Object.assign(t, { asked: 0 });
  return h;
}

test("with a view on screen the engine's work goes to it, and no hidden view is made", async () => {
  const e = createEngine(30);
  const visible = fakeHost();
  e.setVisible(visible);
  assert.equal(await e.channel(), visible);
  assert.deepEqual(e.state(), { on: false, gen: 0 });
});

test("with no view the hidden engine is made, answers the work and ends after its idle time; a later need makes a new one", async () => {
  const e = createEngine(40);
  let changes = 0;
  e.subscribe(() => { changes++; });
  const waiting = e.channel();
  assert.deepEqual(e.state(), { on: true, gen: 1 }, "a hidden view is wanted");
  const host = fakeHost();
  e.hostChannel(host); // (its host mounted and made its channel)
  const ch = await waiting;
  await ch.request({ op: "restore", elements: [] });
  assert.equal(host.asked, 1, "the request reached the hidden view");
  assert.equal((await e.channel()).ready(), true);
  assert.equal(e.state().on, true);
  await wait(15);
  await ch.request({ op: "restore", elements: [] }); // (a request is use: the time starts again)
  await wait(25);
  assert.equal(e.state().on, true, "not yet ended: its last request was 25 ms ago");
  await wait(60);
  assert.deepEqual(e.state(), { on: false, gen: 1 }, "ended 40 ms after its last request");
  e.hostChannel(null);
  const again = e.channel();
  assert.deepEqual(e.state(), { on: true, gen: 2 }, "a new view has a new generation, so its host is drawn anew");
  e.hostChannel(fakeHost());
  await again;
  assert.ok(changes >= 3);
});

test("a view that comes on screen while the engine is waited for answers that wait, and the engine view ends once its requests are", async () => {
  const e = createEngine(10_000);
  const waiting = e.channel();
  const visible = fakeHost();
  e.setVisible(visible);
  assert.equal(await waiting, visible, "what waited for a hidden view is served by the visible one");

  const e2 = createEngine(10_000);
  const first = e2.channel();
  const hidden = fakeHost();
  e2.hostChannel(hidden);
  const ch = await first;
  const slow = (() => { const { base, waiting } = fakeBase(); return { ch: tracked(base), waiting }; })();
  e2.hostChannel(slow.ch); // (the hidden view has a request that is not answered)
  const p = (await e2.channel()).request({ op: "snapshot" });
  p.catch(() => {});
  void ch;
  e2.setVisible(fakeHost());
  assert.equal(e2.state().on, true, "a request of the hidden view is still on its way");
  slow.waiting[0].resolve({});
  await wait(10);
  assert.equal(e2.state().on, false, "the hidden view ended when it was answered");
});

// ---- ⌘⇧L

function key(code: string, o: Partial<KeyLike> = {}): KeyLike & { stopped: boolean } {
  const k = { key: code.replace("Key", "").toLowerCase(), code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, stopped: false,
    preventDefault() { (k as { defaultPrevented: boolean }).defaultPrevented = true; }, stopPropagation() { k.stopped = true; }, ...o };
  return k;
}

function boardChat(over: Record<string, unknown> = {}) {
  setState({
    connected: true, sections: {}, gone: {}, panel: true, picking: null,
    sel: { board: "b1", chat: "c1" },
    boards: { b1: { id: "b1", name: "B", group: "" } } as never,
    chats: { c1: { id: "c1", name: "C", board: "b1", group: "" } as never },
    roles: { b1: "held" },
  });
  if (Object.keys(over).length) setState((s) => ({ chats: { ...s.chats, c1: { ...s.chats.c1, ...over } as never } }));
}

test("⌘⇧L waits for a point on the board of the chat beside it, and again ends the wait; the key is taken before the canvas hears it", () => {
  boardChat();
  const handle = boardKeyHandler();
  const k = key("KeyL", { metaKey: true, shiftKey: true });
  handle(k);
  assert.equal(getState().picking, "c1");
  assert.ok(k.defaultPrevented && k.stopped, "taken: Excalidraw's ⌘⇧L locks the selected shapes");
  handle(key("KeyL", { ctrlKey: true, shiftKey: true }));
  assert.equal(getState().picking, null);
  handle(key("KeyL", { metaKey: true, shiftKey: true, repeat: true }));
  assert.equal(getState().picking, null, "a key held down toggles nothing");
});

test("⌘L is the composer's, and ⌘⇧L is left to the canvas where no chat beside the board takes a point", () => {
  boardChat();
  const handle = boardKeyHandler();
  const l = key("KeyL", { metaKey: true });
  handle(l);
  assert.equal(l.defaultPrevented, false, "⌘L: the composer chooses between a quote and the selection");
  assert.equal(getState().picking, null);
  const left = (name: string, setup: () => void) => {
    boardChat(); setup();
    const k = key("KeyL", { metaKey: true, shiftKey: true });
    handle(k);
    assert.equal(k.defaultPrevented, false, `${name}: the canvas hears ⌘⇧L`);
    assert.equal(getState().picking, null, name);
  };
  left("the chat panel is away (⌘J)", () => setState({ panel: false }));
  left("no chat is open", () => setState({ sel: { board: "b1", chat: null } }));
  left("the chat is of another board", () => setState({ sel: { board: "b2", chat: "c1" } }));
  left("the chat is archived", () => setState((s) => ({ chats: { ...s.chats, c1: { ...s.chats.c1, archived: true } as never } })));
  left("the board is another window's", () => setState({ roles: { b1: "other" } }));
  left("the board is archived", () => setState((s) => ({ boards: { b1: { ...s.boards.b1, archived: true } as never } })));
  left("the chat's server is not connected", () => setState({ connected: false }));
  const alt = key("KeyL", { metaKey: true, shiftKey: true, altKey: true });
  boardChat();
  handle(alt);
  assert.equal(alt.defaultPrevented, false);
  assert.equal(pickableChat(getState()), "c1");
});

test("Esc ends the wait for a point, and is left alone otherwise", () => {
  boardChat();
  const esc = key("Escape", { key: "Escape" });
  assert.equal(pickEscape(esc), false, "nothing is waited for");
  assert.equal(esc.defaultPrevented, false);
  setState({ picking: "c1" });
  const e2 = key("Escape", { key: "Escape" });
  assert.equal(pickEscape(e2), true);
  assert.ok(e2.defaultPrevented && e2.stopped);
  assert.equal(getState().picking, null);
});

// ---- the phone's wait for a point (AD-52, AD-71)

const POINT: Ref = { kind: "point", x: 10, y: 20, label: "(10, 20)", near: [] } as never;
const SEL: Ref = { kind: "selection", ids: ["e1"], label: "1 element", count: 1 } as never;

/** The chat screen is over the board: the shell's `select` is the store's selection here, as the stack follows it. */
function phone() {
  boardChat();
  resetPick();
  const went: unknown[] = [];
  setPickGo((sel) => { went.push(sel); setState({ sel }); });
  return went;
}

test("on the phone \"Point at\" takes the user to the board with the wait kept, and the caret of the box is remembered", () => {
  const went = phone();
  registerInserter("c1", () => {}, () => ({ start: 5, end: 5 }));
  startPick("c1", true);
  assert.equal(getState().picking, "c1");
  assert.deepEqual(getState().sel, { board: "b1", chat: null }, "the chat screen went back: the board is on screen");
  assert.deepEqual(went, [{ board: "b1", chat: null }]);
  assert.deepEqual(awayNow(), { chat: "c1", board: "b1", caret: { start: 5, end: 5 } });
});

test("beside the board (desktop, tablet) \"Point at\" leaves the chat where it is", () => {
  const went = phone();
  startPick("c1", false);
  assert.equal(getState().picking, "c1");
  assert.deepEqual(getState().sel, { board: "b1", chat: "c1" });
  assert.deepEqual(went, []);
  assert.equal(awayNow(), null);
  startPick("c1", false);
  assert.equal(getState().picking, null, "the second press ends the wait");
});

test("the composer's unmount ends a wait for a point, except the phone's, which shows the board meanwhile", () => {
  phone();
  startPick("c1", false);
  composerGone("c1");
  assert.equal(getState().picking, null, "beside the board: the composer went, the wait ends with it");
  composerGone("c1");
  assert.equal(getState().picking, null, "nothing waits: nothing changes");

  startPick("c1", true); // the composer goes because the chat screen did
  composerGone("c1");
  assert.equal(getState().picking, "c1", "the phone's wait goes on");
  assert.deepEqual(getState().sel, { board: "b1", chat: null });

  boardChat(); resetPick(); setPickGo((sel) => setState({ sel }));
  startPick("c1", false);
  composerGone("c2");
  assert.equal(getState().picking, "c1", "another chat's composer is not this wait's");
});

test("Cancel, Esc and the key end the phone's wait with the chat open again and nothing added", () => {
  const went = phone();
  registerInserter("c1", () => assert.fail("nothing is put in"));
  for (const end of [() => pickPoint(null), () => pickEscape(key("Escape", { key: "Escape" })), () => boardKeyHandler(() => true)(key("KeyL", { metaKey: true, shiftKey: true }))]) {
    went.length = 0;
    setState({ sel: { board: "b1", chat: "c1" } });
    startPick("c1", true);
    assert.deepEqual(went, [{ board: "b1", chat: null }]);
    end();
    assert.equal(getState().picking, null);
    assert.deepEqual(getState().sel, { board: "b1", chat: "c1" }, "the chat is open again");
    assert.deepEqual(went.at(-1), { board: "b1", chat: "c1" });
    assert.equal(awayNow(), null);
    assert.deepEqual(takeHeld("c1"), []);
  }
});

test("⌘⇧L on the phone goes to the board from the chat, and ends the wait from the board, where no chat is open", () => {
  phone();
  const handle = boardKeyHandler(() => true);
  handle(key("KeyL", { metaKey: true, shiftKey: true }));
  assert.equal(getState().picking, "c1");
  assert.deepEqual(getState().sel, { board: "b1", chat: null });
  const k = key("KeyL", { metaKey: true, shiftKey: true });
  handle(k);
  assert.ok(k.defaultPrevented, "taken on the board screen too: the canvas does not lock shapes");
  assert.equal(getState().picking, null);
  assert.deepEqual(getState().sel, { board: "b1", chat: "c1" });
});

test("a point made while the chat's box is not there is held and put in when it is, at the caret it had; the wait ends and the chat opens", () => {
  const went = phone();
  const put: [Ref, Place | null | undefined][] = [];
  const off = registerInserter("c1", (r, at) => put.push([r, at]), () => ({ start: 5, end: 5 }));
  startPick("c1", true);
  off(); // the chat screen went: its composer with it
  finishPick("c1", POINT);
  assert.deepEqual(put, [], "no box to take it");
  assert.equal(getState().picking, null);
  assert.deepEqual(getState().sel, { board: "b1", chat: "c1" });
  assert.deepEqual(went.at(-1), { board: "b1", chat: "c1" });
  // the composer is there again
  assert.deepEqual(takeHeld("c1"), [{ ref: POINT, at: { start: 5, end: 5 } }]);
  assert.deepEqual(takeHeld("c1"), [], "taken once");
});

test("a point made with the box there goes in at once; two points held for a box come in the order they were made", () => {
  phone();
  const put: [Ref, Place | null | undefined][] = [];
  registerInserter("c1", (r, at) => put.push([r, at]));
  startPick("c1", false);
  finishPick("c1", POINT);
  assert.deepEqual(put, [[POINT, null]]);
  assert.deepEqual(takeHeld("c1"), []);
  assert.equal(getState().picking, null);

  resetPick();
  holdRef("c2", POINT);
  holdRef("c2", SEL, { start: 1, end: 3 });
  assert.deepEqual(takeHeld("c2"), [{ ref: POINT, at: null }, { ref: SEL, at: { start: 1, end: 3 } }]);
  assert.equal(insertRef("c2", POINT), false, "no box registered");
});

test("a wait that ended another way leaves no phone flow behind", () => {
  const went = phone();
  startPick("c1", true);
  setState({ picking: null }); // (the store's own end: the chat is gone)
  assert.equal(awayNow(), null);
  went.length = 0;
  pickPoint(null);
  assert.deepEqual(went, [], "nothing is opened again");
});

// ---- the tap

test("a tap is one pointer down and up in its place: a pan, a pinch and a second finger are none", () => {
  const w = tapWatch(10);
  w.down(1, { x: 50, y: 50 });
  assert.deepEqual(w.up(1, { x: 53, y: 48 }), { x: 53, y: 48 }, "a tap, a little unsteady");

  w.down(1, { x: 50, y: 50 });
  w.move(1, { x: 90, y: 50 });
  assert.equal(w.up(1, { x: 50, y: 50 }), null, "a pan that came back is a pan");

  w.down(1, { x: 50, y: 50 });
  assert.equal(w.up(1, { x: 120, y: 50 }), null, "moved away");

  w.down(1, { x: 50, y: 50 });
  w.down(2, { x: 90, y: 50 });
  assert.equal(w.up(2, { x: 90, y: 50 }), null, "a second finger");
  assert.equal(w.up(1, { x: 50, y: 50 }), null, "and the first one lifted after it");
  w.down(1, { x: 50, y: 50 });
  assert.deepEqual(w.up(1, { x: 50, y: 50 }), { x: 50, y: 50 }, "the next gesture is judged on its own");

  w.down(1, { x: 5, y: 5 });
  w.cancel(1);
  assert.equal(w.up(1, { x: 5, y: 5 }), null, "a pointer taken away makes none");
  w.down(3, { x: 5, y: 5 });
  assert.deepEqual(w.up(3, { x: 5, y: 5 }), { x: 5, y: 5 });
});
