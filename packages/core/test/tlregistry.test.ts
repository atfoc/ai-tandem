// The page's registry of new boards (src/tl/registry.ts, design 2.3, 2.5, 6): `tl_sync`/`tl_closed` events go to the port of the
// session they name on their server (and wait a moment for one that is not claimed yet); the stream's state goes to every port
// of that server; the tl views' handles answer an agent's get_view and show_board; usesTl picks those calls for new boards only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTlRegistry, usesTl, isTl, type TlViewHandle } from "../src/tl/registry.ts";
import type { TlLinkPort } from "../src/tl/link.ts";
import { setUi, type Ui } from "../src/state/ports.ts";
import * as store from "../src/state/store.ts";

function port() {
  const seen: unknown[][] = [];
  const p: TlLinkPort = { messages: (m) => seen.push(["messages", m]), closed: (r) => seen.push(["closed", r]), stream: (up) => seen.push(["stream", up]) };
  return { p, seen };
}
/** Timers the test runs by hand. */
function timers() {
  const tasks = new Map<number, () => void>();
  let seq = 0;
  return { tasks, setTimeout: (fn: () => void) => { tasks.set(++seq, fn); return seq; }, clearTimeout: (id: unknown) => { tasks.delete(id as number); },
    runAll() { for (const [id, fn] of [...tasks]) { tasks.delete(id); fn(); } } };
}

const S1 = "s_aaaaaaaaaaaa";
const board = (id: string, name: string, o: Record<string, unknown> = {}) => ({ id, name, group: "", created: "", ...o });
function boards() {
  store.setState({
    boards: { b_tl: board("b_tl", "Sprint", { kind: "tl" }), b_old: board("b_old", "Old"), [`${S1}~b_tl`]: board(`${S1}~b_tl`, "Far", { kind: "tl" }) } as any,
    sel: { board: "b_tl", chat: null },
  });
}
const selected: unknown[] = [];
setUi({ openChat() {}, select: (s) => { selected.push(s); }, focusComposer() {}, reportError() {}, confirm() {} } as Ui);

test("events go to the port of the session they name, on their server; tl_closed with its reason", () => {
  const r = createTlRegistry();
  const a = port(), b = port(), c = port();
  r.attach("local", "s_1", a.p);
  r.attach("local", "s_2", b.p);
  r.attach(S1, "s_1", c.p); // the same session id on another server is another session
  r.event("local", { type: "tl_sync", board: "b_tl", session: "s_1", messages: ["x", "y"] });
  r.event("local", { type: "tl_sync", board: "b_tl", session: "s_2", messages: ["z"] });
  r.event(S1, { type: "tl_closed", board: "b_tl", session: "s_1", reason: "archived" });
  r.event("local", { type: "tl_closed", session: "s_2" });
  r.event("local", { type: "tl_sync", session: "s_1", messages: "not a list" });
  r.event("local", { type: "tl_sync", messages: ["no session"] } as any);
  assert.deepEqual(a.seen, [["messages", ["x", "y"]]]);
  assert.deepEqual(b.seen, [["messages", ["z"]], ["closed", "closed"]]);
  assert.deepEqual(c.seen, [["closed", "archived"]]);
  r.detach("local", "s_1", a.p);
  r.event("local", { type: "tl_sync", session: "s_1", messages: ["after"] });
  assert.equal(a.seen.length, 1, "a detached port hears nothing");
});

test("events of a session nobody claimed wait a moment, are handed over on attach in order, and go when their time is up or the stream changes", () => {
  const t = timers();
  const r = createTlRegistry({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  r.event("local", { type: "tl_sync", session: "s_1", messages: ["a"] });
  r.event("local", { type: "tl_sync", session: "s_1", messages: ["b"] });
  const a = port();
  r.attach("local", "s_1", a.p);
  assert.deepEqual(a.seen, [["messages", ["a"]], ["messages", ["b"]]]);
  assert.equal(t.tasks.size, 0);
  r.event("local", { type: "tl_sync", session: "s_2", messages: ["late"] });
  t.runAll(); // time is up
  const b = port();
  r.attach("local", "s_2", b.p);
  assert.deepEqual(b.seen, []);
  r.event("local", { type: "tl_sync", session: "s_3", messages: ["old stream"] });
  r.streamState("local", true);
  const c = port();
  r.attach("local", "s_3", c.p);
  assert.deepEqual(c.seen, []);
});

test("the stream's state goes to every port watching that server, and isDown says it", () => {
  const r = createTlRegistry();
  const a = port(), b = port();
  const stop = r.watch("local", a.p);
  r.watch(S1, b.p);
  r.streamState("local", false);
  assert.equal(r.isDown("local"), true);
  assert.equal(r.isDown(S1), false);
  r.streamState("local", true);
  stop();
  r.streamState("local", false);
  assert.deepEqual(a.seen, [["stream", false], ["stream", true]]);
  assert.deepEqual(b.seen, []);
});

test("usesTl: get_view when the chat's board is a new board, show_board when its target (or the chat's board) is one; nothing else", () => {
  boards();
  assert.equal(isTl("b_tl"), true);
  assert.equal(isTl("b_old"), false);
  assert.equal(isTl(`${S1}~b_tl`), true);
  const call = (name: string, b: string, target?: string) => ({ chat: "c_1", board: b, name, args: {}, ...(target ? { target } : {}) });
  assert.equal(usesTl(call("get_view", "b_tl")), true);
  assert.equal(usesTl(call("get_view", "b_old")), false);
  assert.equal(usesTl(call("show_board", "b_old", "b_tl")), true);
  assert.equal(usesTl(call("show_board", "b_tl", "b_old")), false, "the target decides");
  assert.equal(usesTl(call("show_board", "b_tl")), true);
  assert.equal(usesTl(call("show_board", "b_old")), false);
  for (const name of ["read_board", "apply", "delete_elements", "get_image"]) assert.equal(usesTl(call(name, "b_tl", "b_tl")), false, name);
  assert.equal(usesTl(call("get_view", "b_unknown")), false);
  assert.equal(usesTl(null), false);
});

const handle = (o: Partial<{ zoomed: unknown[]; found: boolean }> = {}): TlViewHandle & { zoomed: unknown[] } => {
  const zoomed: unknown[] = [];
  return {
    zoomed,
    getView: () => ({ bounds: { x: -10.4, y: 20.6, w: 1200, h: 800.2 }, zoom: 0.755,
      selected: [{ id: "shape:a", key: "n1", type: "sticky", x: 0, y: 0, w: 200, h: 200, text: "Idea" }, { id: "shape:b", type: "text", x: 5, y: 5, w: 10, h: 10 }] }),
    zoomTo: (refs) => { zoomed.push(refs); return o.found ?? true; },
  };
};

test("get_view on the new board on screen: its name and id, kind new, the visible area, the zoom and the selection as element lines", async () => {
  boards();
  const r = createTlRegistry();
  const call = { chat: "c_1", board: "b_tl", name: "get_view", args: {} };
  assert.equal(await r.answer(call), "active_board: Sprint (b_tl), kind: new\nview: the board is still opening on the user's screen\nselection: none");
  r.setHandle("b_tl", handle());
  assert.equal(await r.answer(call), [
    "active_board: Sprint (b_tl), kind: new",
    "view: x=-10 y=21 w=1200 h=800 (page px), zoom 76%",
    "selection (2):",
    `  {"id":"shape:a","key":"n1","type":"sticky","x":0,"y":0,"w":200,"h":200,"text":"Idea"}`,
    `  {"id":"shape:b","type":"text","x":5,"y":5,"w":10,"h":10}`,
  ].join("\n"));
  r.setHandle("b_tl", { ...handle(), getView: () => ({ bounds: { x: 0, y: 0, w: 1, h: 1 }, zoom: 1, selected: [] }) });
  assert.match(await r.answer(call) as string, /zoom 100%\nselection: none$/);
  // another board on screen, or none: the board side's words
  store.setState({ sel: { board: "b_old", chat: null } });
  assert.equal(await r.answer(call), "The user is looking at Old (b_old), not Sprint (b_tl).");
  store.setState({ sel: { board: null, chat: null } });
  assert.equal(await r.answer(call), "The user is looking at no board, not Sprint (b_tl).");
});

test("show_board selects the board, waits for its view to fit the refs, and answers shown <name> (<id>)", async () => {
  boards();
  store.setState({ sel: { board: "b_old", chat: null } });
  const t = timers();
  const r = createTlRegistry({ setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });
  selected.length = 0;
  assert.equal(await r.answer({ chat: "c_1", board: "b_old", target: "b_tl", name: "show_board", args: {} }), "shown Sprint (b_tl)");
  assert.deepEqual(selected, [{ board: "b_tl", chat: null }]);
  // with refs: the answer waits for the view of the board to mount
  const refs = [{ key: "n1" }, { id: "shape:b" }, { bogus: 1 }];
  const answer = r.answer({ chat: "c_1", board: "b_old", target: "b_tl", name: "show_board", args: { refs } });
  let done = false; void answer.then(() => { done = true; });
  await new Promise((res) => setImmediate(res));
  assert.equal(done, false);
  const h = handle();
  r.setHandle("b_tl", h);
  assert.equal(await answer, "shown Sprint (b_tl)");
  assert.deepEqual(h.zoomed, [[{ key: "n1" }, { id: "shape:b" }]]);
  assert.equal(t.tasks.size, 0, "the wait's timer is gone");
  // the view mounted already: at once; refs matching nothing say so
  r.setHandle("b_tl", handle({ found: false }));
  assert.match(await r.answer({ chat: "c_1", board: "b_tl", name: "show_board", args: { refs } }) as string, /^shown Sprint \(b_tl\); no element/);
  // a view that never mounts: the wait ends, the board was shown
  r.setHandle("b_tl", null);
  const late = r.answer({ chat: "c_1", board: "b_tl", name: "show_board", args: { refs } });
  await new Promise((res) => setImmediate(res));
  t.runAll();
  assert.match(await late as string, /^shown Sprint \(b_tl\); it did not open in time/);
  await assert.rejects(r.answer({ chat: "c_1", board: "b_old", target: "b_nope", name: "show_board", args: {} }), (e: any) => e.code === "NO_BOARD");
});

test("show_board of the chat's own board keeps the chat open", async () => {
  boards();
  store.setState((s) => ({ chats: { ...s.chats, c_1: { id: "c_1", board: "b_tl" } as any }, sel: { board: "b_tl", chat: "c_1" } }));
  selected.length = 0;
  await createTlRegistry().answer({ chat: "c_1", board: "b_tl", target: "b_tl", name: "show_board", args: {} });
  assert.deepEqual(selected, [{ board: "b_tl", chat: "c_1" }]);
});
