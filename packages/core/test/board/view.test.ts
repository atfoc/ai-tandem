// The board side on the board bridge (src/board/side.ts, src/board/channel.ts; AD-55): the channel checks and matches what
// the view answers; the board on screen is sent to the view and mirrored from what it tells; a write on purpose asks the
// view for its scene first; a tool works on the view's scene when the board is on screen and on the kept one through the
// engine when it is not; the selection, a point, a clicked reference, the theme and the role reach the view.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createChannel } from "../../src/board/channel.ts";
import { createBoardSide, type BoardApp } from "../../src/board/side.ts";
import { RpcError } from "../../src/board/scene.ts";
import * as store from "../../src/state/store.ts";
import { setUi, ui } from "../../src/state/ports.ts";
import { FakeApi, FakeView, newBoard, resetStore, stored, tick, until, wait } from "./fakeview.ts";
import type { ToBoard } from "@aiwb/board-bridge/messages.ts";

const st = () => store.getState();
let api: FakeApi, view: FakeView, side: BoardApp;
const selects: unknown[][] = [];
const quiet = console.error;

beforeEach(async () => {
  console.error = () => {};
  resetStore();
  api = new FakeApi();
  view = new FakeView();
  side = createBoardSide({ api, saveDebounce: 40, agentSave: 5 });
  side.attachView(view.channel);
  selects.length = 0;
  setUi({ ...ui(), select: (...a: unknown[]) => { selects.push(a); } } as any);
  await until(() => view.channel.ready(), "the view ready");
});
test.after(() => { console.error = quiet; });

/** A board this window holds, shown in the view and drawn. */
async function onScreen(rev = 0, more: any[] = []) {
  const b = newBoard();
  api.read = stored(rev, 1, more);
  store.setRole(b, "held");
  store.setState({ sel: { board: b, chat: null } });
  await side.show(b);
  await until(() => side.liveBoard() === b, "the board drawn");
  return b;
}
const call = (b: string, name: string, args: any = {}) => side.runTool({ chat: "c", board: b, target: b, name, args });
const rect = (id: string, x: number, more: Record<string, unknown> = {}) => ({ id, type: "rectangle", x, y: 0, width: 10, height: 10, version: 1, ...more });

// ---- the channel

test("the channel holds what is sent until the view is ready, then sends it in order", async () => {
  const out: ToBoard[] = [];
  const c = createChannel((m) => out.push(m), { warn: () => {} });
  c.channel.send({ t: "unload" });
  const p = c.channel.request({ op: "snapshot" });
  assert.equal(out.length, 0);
  c.receive(JSON.stringify({ t: "ready", version: "1" }));
  assert.deepEqual(out.map((m) => m.t), ["unload", "req"]);
  const id = (out[1] as any).id;
  c.receive({ t: "res", id, ok: true, value: { board: "b", elements: [], files: {}, appState: {}, style: {} } });
  assert.equal((await p).board, "b");
});

test("the channel refuses what the view sends that the bridge does not know, and a reply whose value is not the request's", async () => {
  const warned: string[] = [];
  const out: ToBoard[] = [];
  const c = createChannel((m) => out.push(m), { ready: true, warn: (t) => warned.push(t) });
  const seen: string[] = [];
  c.channel.on((m) => seen.push(m.t));
  c.receive("not json");
  c.receive({ t: "changed", board: "b", elements: [], appState: {}, style: {}, secret: "x" });
  c.receive({ t: "navigate", url: "https://example.com" });
  assert.equal(seen.length, 0);
  assert.equal(warned.length, 3);
  const p = c.channel.request({ op: "export", target: "live", ids: [], scale: 1, background: true });
  c.receive({ t: "res", id: (out[0] as any).id, ok: true, value: { png: "x" } });
  await assert.rejects(p, (e: any) => e instanceof RpcError && e.code === "VIEW_FAILED");
});

test("a reply that fails validation rejects its request at once, with the validator's path; a reply to no request is only dropped", async () => {
  const warned: string[] = [];
  const out: ToBoard[] = [];
  // (the timeout is far off: the rejection must not be the timeout's)
  const c = createChannel((m) => out.push(m), { ready: true, timeout: 60_000, warn: (t) => warned.push(t) });
  const snapshot = { board: "b", elements: [], files: {}, appState: {}, style: {} };
  const ask = () => { const p = c.channel.request({ op: "snapshot" }); p.catch(() => {}); return [p, (out[out.length - 1] as any).id] as const; };
  const rejected = (p: Promise<unknown>) => p.then(() => null, (e: any) => e);
  const settled = (p: Promise<unknown>) => Promise.race([rejected(p), new Promise<string>((r) => setTimeout(() => r("pending"), 50))]);

  // a value that is not JSON-safe (an object in the page: NaN survives there)
  let [p, id] = ask();
  c.receive({ t: "res", id, ok: true, value: { ...snapshot, appState: { scrollX: NaN } } });
  let e: any = await settled(p);
  assert.ok(e instanceof RpcError, `the request is rejected at once, not left to the timeout (${String(e)})`);
  assert.equal(e.code, "VIEW_FAILED");
  assert.match(e.message, /snapshot/);
  assert.match(e.message, /message\.value\.appState\.scrollX: not a finite number/);
  // a message of the wrong shape, as text
  [p, id] = ask();
  c.receive(JSON.stringify({ t: "res", id, ok: false, code: 5, message: "x" }));
  e = await settled(p);
  assert.ok(e instanceof RpcError && e.code === "VIEW_FAILED" && /message\.code: not a string/.test(e.message), String(e?.message ?? e));
  // a reply with a key the bridge does not know
  [p, id] = ask();
  c.receive({ t: "res", id, ok: true, value: snapshot, secret: "x" });
  e = await settled(p);
  assert.ok(e instanceof RpcError && /message\.secret: unknown key/.test(e.message), String(e?.message ?? e));
  // the value is a value, but not the request's: the path is in the message too
  [p, id] = ask();
  c.receive({ t: "res", id, ok: true, value: { board: "b" } });
  e = await settled(p);
  assert.ok(e instanceof RpcError && e.code === "VIEW_FAILED" && /value\.elements: missing/.test(e.message), String(e?.message ?? e));
  // the other requests in flight go on; a reply that names no request, or is no reply, is dropped as before
  const [other, otherId] = ask();
  const before = warned.length;
  c.receive({ t: "res", id: 9999, ok: true, value: { ...snapshot, appState: { scrollX: Infinity } } });
  c.receive({ t: "changed", board: "b", elements: [], appState: { zoom: { value: NaN } }, style: {} });
  assert.equal(warned.length, before + 2);
  assert.equal(await settled(other), "pending");
  c.receive({ t: "res", id: otherId, ok: true, value: snapshot });
  assert.equal((await other).board, "b");
});

test("a failed reply rejects with the view's code and message; no reply in time, or a reset, rejects as VIEW_FAILED", async () => {
  const out: ToBoard[] = [];
  const c = createChannel((m) => out.push(m), { ready: true, timeout: 30, warn: () => {} });
  const a = c.channel.request({ op: "snapshot" });
  c.receive({ t: "res", id: (out[0] as any).id, ok: false, code: "NO_BOARD", message: "no board is shown" });
  await assert.rejects(a, { code: "NO_BOARD", message: "no board is shown" });
  await assert.rejects(c.channel.request({ op: "snapshot" }), { code: "VIEW_FAILED" });
  const b = c.channel.request({ op: "snapshot" });
  c.reset();
  await assert.rejects(b, { code: "VIEW_FAILED", message: "the board view went away" });
  assert.equal(c.channel.ready(), false);
});

// ---- showing a board

test("show reads the scene, has the engine restore it, and sends it to the view with the role, the theme and the style", async () => {
  const b = newBoard();
  api.read = stored(4, 3);
  store.setRole(b, "held");
  await side.show(b);
  assert.deepEqual(api.asked(), ["read " + b]);
  assert.deepEqual(view.ops().map((o) => o.op), ["restore"]);
  const load = view.sent("load")[0] as Extract<ToBoard, { t: "load" }>;
  assert.equal(load.board, b);
  assert.equal(load.viewMode, false);
  assert.deepEqual(load.scene.elements.map((e) => e.id), ["e1"]);
  assert.equal(load.theme.mode, st().theme);
  assert.equal(side.scene(b)!.version, 3);
  assert.equal(side.scene(b)!.base, 4);
  await until(() => side.liveBoard() === b);
  assert.deepEqual(side.viewStatus(), { board: b, loaded: true, error: "" });
  assert.deepEqual(view.refused, []);
});

test("a board this window does not hold, or an archived one, is shown read-only, and the view follows the role", async () => {
  const b = newBoard();
  await side.show(b);
  assert.equal((view.sent("load")[0] as any).viewMode, true);
  await until(() => side.liveBoard() === b);
  store.setRole(b, "held");
  assert.deepEqual(view.sent("viewMode").map((m: any) => m.on), [false]);
  store.setState((s) => ({ boards: { ...s.boards, [b]: { ...s.boards[b], archived: true } } }));
  assert.deepEqual(view.sent("viewMode").map((m: any) => m.on), [false, true]);
});

test("while a chat of the board waits for a point the view is in view mode, and is let go when the wait ends", async () => {
  const b = newBoard();
  store.setRole(b, "held");
  store.setState((s) => ({ chats: { ...s.chats, c1: { id: "c1", name: "C", board: b, group: "" } as never, c2: { id: "c2", name: "C", board: "other", group: "" } as never } }));
  await side.show(b);
  await until(() => side.liveBoard() === b);
  assert.equal((view.sent("load")[0] as any).viewMode, false);
  store.setState({ picking: "c2" });
  assert.deepEqual(view.sent("viewMode"), [], "a wait of a chat of another board changes nothing here");
  store.setState({ picking: "c1" });
  assert.deepEqual(view.sent("viewMode").map((m: any) => m.on), [true]);
  store.setState({ picking: null });
  assert.deepEqual(view.sent("viewMode").map((m: any) => m.on), [true, false]);
});

test("the theme reaches the view: a dark theme with its canvas filter", async () => {
  await onScreen();
  store.setState({ theme: "dark", themePref: "dark" });
  const t = view.sent("theme").at(-1) as any;
  assert.equal(t.theme.mode, "dark");
  assert.equal(t.theme.filter.id, "aiwb-canvas-dark");
  store.setState({ theme: "light", themePref: "light" });
  assert.deepEqual((view.sent("theme").at(-1) as any).theme, { mode: "light", filter: null, chrome: null });
  assert.equal(t.theme.chrome, null, "plain dark has Excalidraw's own chrome");
});

test("the theme reaches the view: a flavour brings the colours of the chrome, a change of flavour sends them anew", async () => {
  await onScreen();
  store.setState({ theme: "light", themePref: "latte" });
  const latte = (view.sent("theme").at(-1) as any).theme;
  assert.equal(latte.mode, "light");
  assert.equal(latte.filter.id, "aiwb-canvas-latte");
  assert.equal(latte.chrome["--island-bg-color"], "#eff1f5");
  store.setState({ theme: "dark", themePref: "mocha" });
  const mocha = (view.sent("theme").at(-1) as any).theme;
  assert.equal(mocha.mode, "dark");
  assert.equal(mocha.chrome["--island-bg-color"], "#1e1e2e");
  const n = view.sent("theme").length;
  store.setState({ theme: "dark", themePref: "macchiato" });
  assert.equal(view.sent("theme").length, n + 1);
  assert.equal((view.sent("theme").at(-1) as any).theme.chrome["--island-bg-color"], "#24273a");
  store.setState({ theme: "dark", themePref: "dark" });
  assert.equal((view.sent("theme").at(-1) as any).theme.chrome, null);
});

test("a show that another one overtook sends nothing; the board left is written first and the view unloads it", async () => {
  const a = await onScreen();
  view.draw((els) => els.map((e) => ({ ...e, version: e.version + 1 })), { tell: false });
  const b = newBoard(), c = newBoard();
  let free!: () => void;
  api.read = (id) => (id === b ? new Promise((r) => { free = () => r({ scene: {}, rev: 0 }); }) : stored(0)());
  const slow = side.show(b);
  const fast = side.show(c);
  await fast;
  free();
  await slow;
  assert.deepEqual(view.sent("load").map((m: any) => m.board), [a, c]);
  assert.equal(view.sent("unload").length, 1);
  await until(() => api.written.some((w) => w.id === a), "the left board written");
  assert.equal(api.written[0].scene.elements[0].version, 2, "the change the view had not told yet is in the write");
});

test("what the view tells is kept and saved after the debounce; the selection and the view reach the store", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("e2", 50)]);
  await until(() => side.scene(b)!.elements.length === 2);
  assert.equal(side.hasPendingSaves(), true);
  await until(() => api.written.length === 1, "the save");
  assert.deepEqual(api.written[0].scene.elements.map((e: any) => e.id), ["e1", "e2"]);
  view.select(["e2"]);
  await until(() => st().selection.count === 1);
  view.scroll({ scrollX: -10, scrollY: -20, zoom: 2, width: 800, height: 600 });
  await until(() => st().view.zoom === 2);
  assert.deepEqual(st().view, { scrollX: -10, scrollY: -20, zoom: 2, width: 800, height: 600 });
});

test("an unchanged scene is not saved; a change of an archived board is not kept", async () => {
  const b = await onScreen();
  view.draw((els) => els.map((e) => ({ ...e, x: 5 }))); // the same versions: Excalidraw did not count it a change
  await wait(80);
  assert.equal(api.written.length, 0);
  store.setState((s) => ({ boards: { ...s.boards, [b]: { ...s.boards[b], archived: true } } }));
  view.draw((els) => els.map((e) => ({ ...e, version: 9 })));
  await wait(80);
  assert.equal(side.scene(b)!.version, 1);
  assert.equal(api.written.length, 0);
});

test("flush asks the view for its scene first, so a change it has not told yet is written", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("e2", 50)], { tell: false });
  await side.flush(b);
  assert.deepEqual(view.ops("snapshot").length, 1);
  assert.deepEqual(api.written.map((w) => w.scene.elements.length), [2]);
  assert.equal(side.hasPendingSaves(), false);
});

test("flushAll writes the board on screen too, of its server only", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("e2", 50)], { tell: false });
  await side.flushAll("s_other1234567");
  assert.equal(api.written.length, 0);
  await side.flushAll();
  assert.equal(api.written.length, 1);
  assert.equal(api.written[0].id, b);
});

test("a view that is up again gets the board back from the app's copy", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("e2", 50)]);
  await until(() => side.scene(b)!.elements.length === 2);
  view.crash();
  view.ready();
  await until(() => view.sent("load").length === 2, "the second load");
  assert.deepEqual((view.sent("load")[1] as any).scene.elements.map((e: any) => e.id), ["e1", "e2"]);
  await until(() => side.liveBoard() === b);
});

test("a view that cannot draw the board: its error is the status of the board", async () => {
  const b = newBoard();
  view.autoLoad = false;
  await side.show(b);
  view.post({ t: "error", message: "the board did not start" });
  await until(() => side.viewStatus().error !== "");
  assert.deepEqual(side.viewStatus(), { board: b, loaded: false, error: "the board did not start" });
  assert.equal(side.liveBoard(), null);
});

test("a dropped scene is no longer the view's: what it tells is not kept until the board is shown again", async () => {
  const b = await onScreen();
  const gen = st().sceneGen[b] ?? 0;
  side.granted(b, 7); // granted at another revision than the one kept: the scene is dropped
  assert.equal(st().sceneGen[b], gen + 1);
  assert.equal(side.liveBoard(), null);
  view.draw((els) => [...els, rect("e2", 50)]);
  await wait(20);
  assert.equal(side.scene(b), undefined);
});

// ---- tools on the board on screen, and off it

test("apply on the board on screen goes to the view's scene; its change is kept and saved soon", async () => {
  const b = await onScreen();
  const out = JSON.parse(await call(b, "apply", { create: [{ type: "rectangle", key: "k", x: 100, y: 0 }] }) as string);
  assert.equal(out.board, `Board ${b}`);
  assert.equal(out.id, b);
  assert.deepEqual(Object.keys(out), ["board", "id", "created", "updated", "deleted", "conflicts", "rev"]);
  assert.equal(out.rev, 1);
  const req = view.ops("apply")[0] as any;
  assert.equal(req.target, "live");
  assert.ok(side.scene(b)!.elements.some((e) => e.customData?.key === "k"), "the change is mirrored before the answer");
  assert.ok(view.shown!.elements.some((e: any) => e.customData?.key === "k"));
  await until(() => api.written.length === 1);
  assert.ok(st().flashes.some((f) => f.board === b));
});

test("apply on a board that is not on screen goes to the engine with the kept elements, and keeps what it answers", async () => {
  await onScreen();
  const b = newBoard();
  store.setRole(b, "held");
  api.read = stored(2);
  const out = JSON.parse(await call(b, "apply", { update: [{ ref: { id: "e1" }, x: 40 }] }) as string);
  assert.deepEqual(out.updated, ["e1"]);
  assert.equal("elements" in out, false);
  const req = view.ops("apply")[0] as any;
  assert.deepEqual(req.target.elements.map((e: any) => e.id), ["e1"]);
  assert.equal(side.scene(b)!.elements[0].x, 40);
  assert.equal(side.scene(b)!.version, 2);
  await until(() => api.written.some((w) => w.id === b));
  assert.equal(view.shown!.board === b, false, "the view still shows the other board");
});

test("an edit of an agent flashes the box of what it changed, in board coordinates, for the board on screen only; a delete flashes Removed in the danger tone (D-AG-13)", async () => {
  store.setState({ chats: { c: { id: "c", agent: "claude" } } } as any);
  const b = await onScreen(0, [rect("e2", 300, { x: 300, y: 40, width: 80, height: 60 })]);
  await call(b, "apply", { update: [{ ref: { id: "e2" }, x: 310, y: 45 }, { ref: { id: "e1" }, x: 0 }] });
  const edit = st().flashes.filter((f) => f.board === b);
  assert.equal(edit.length, 1);
  assert.deepEqual([edit[0].tone, edit[0].agent], ["edit", "claude"]);
  assert.deepEqual(edit[0].box, { x: 0, y: 0, width: 390, height: 105 }, "one box around the two elements, in the board's own coordinates (the view's scroll and zoom are not in it)");
  view.scroll({ scrollX: -500, scrollY: -500, zoom: 2, width: 800, height: 600 });
  await until(() => st().view.zoom === 2);
  assert.deepEqual(st().flashes.filter((f) => f.board === b)[0].box, edit[0].box, "scrolling and zooming leave the box where it is on the board: the screen puts it where the view is");
  await call(b, "delete_elements", { refs: [{ id: "e2" }] });
  const gone = st().flashes.find((f) => f.label === "Removed");
  assert.deepEqual([gone?.tone, gone?.box], ["danger", { x: 310, y: 45, width: 80, height: 60 }]);
  // a board that is not on screen is edited with no flash: there is no canvas to draw it on
  const other = newBoard();
  store.setRole(other, "held");
  api.read = stored(0);
  const before = st().flashes.length;
  await call(other, "apply", { update: [{ ref: { id: "e1" }, x: 40 }] });
  assert.equal(st().flashes.length, before);
  assert.equal(st().flashes.some((f) => f.board === other), false);
});

test("an engine of the platform's own takes the work on boards that are not on screen", async () => {
  const engine = new FakeView();
  side.setEngine(async () => engine.channel);
  const b = newBoard();
  store.setRole(b, "held");
  api.read = stored(0);
  await call(b, "apply", { create: [{ type: "ellipse" }] });
  assert.deepEqual(engine.ops().map((o) => o.op), ["restore", "apply"]);
  assert.deepEqual(view.ops(), []);
});

test("tool calls on one board run one after another: the second starts from what the first left", async () => {
  const b = newBoard();
  store.setRole(b, "held");
  api.read = stored(0);
  const [x, y] = await Promise.all([
    call(b, "apply", { create: [{ type: "rectangle", key: "a" }] }),
    call(b, "apply", { create: [{ type: "rectangle", key: "b" }] }),
  ]);
  assert.ok(x && y);
  assert.deepEqual(side.scene(b)!.elements.map((e) => e.customData?.key ?? e.id), ["e1", "a", "b"]);
});

test("an id the agent shortened is expanded before the view gets it; a bad ref is the view's BAD_REF", async () => {
  const b = await onScreen(0, [rect("abcdef123", 30)]);
  await call(b, "apply", { update: [{ ref: { id: "abc" }, x: 1 }] });
  assert.deepEqual((view.ops("apply")[0] as any).params.update[0].ref, { id: "abcdef123" });
  await assert.rejects(call(b, "apply", { update: [{ ref: { id: "zzz" }, x: 1 }] }), { code: "BAD_REF", message: 'no live element for {"id":"zzz"}' });
});

test("delete_elements: refs that are no refs are refused with apply.ts's words, and nothing is sent", async () => {
  const b = await onScreen();
  await assert.rejects(call(b, "delete_elements", { refs: ["e1"] }), {
    code: "BAD_REF", message: 'delete[0].ref: a ref is {"key": "..."} or {"id": "..."}, not "e1"',
  });
  assert.deepEqual(view.ops("delete"), []);
  const out = JSON.parse(await call(b, "delete_elements", { refs: [{ id: "e1" }], cascade: true }) as string);
  assert.deepEqual(out, { board: `Board ${b}`, id: b, deleted: ["e1"] });
  assert.deepEqual(view.ops("delete")[0], { op: "delete", target: "live", refs: [{ id: "e1" }], cascade: true, rev: 1 });
  assert.ok(st().flashes.some((f) => f.board === b && f.label === "Removed"));
});

test("a change an agent makes to an archived board is refused ARCHIVED, and nothing is sent to the view or written (D-AG-16)", async () => {
  const b = await onScreen();
  const archive = (on: boolean) => store.setState((s) => ({ boards: { ...s.boards, [b]: { ...s.boards[b], archived: on } } }));
  archive(true); // (the window still holds it: the screen clears the role of the board it shows; one off screen keeps it)
  await assert.rejects(call(b, "apply", { create: [{ type: "rectangle", key: "n" }] }), { code: "ARCHIVED", message: `Board ${b} is archived` });
  await assert.rejects(call(b, "delete_elements", { refs: [{ id: "e1" }] }), { code: "ARCHIVED", message: `Board ${b} is archived` });
  await wait(80);
  assert.deepEqual(view.ops("apply", "delete"), [], "the view was asked for nothing");
  assert.equal(api.written.length, 0);
  assert.deepEqual(side.scene(b)!.elements.map((e) => e.id), ["e1"], "the kept scene is as it was");
  // the read tools still work on it
  assert.match(await call(b, "read_board") as string, /^Board b_\d+ .*rev 0, 1 elements/);
  // unarchived, the same call goes through
  archive(false);
  assert.ok(JSON.parse(await call(b, "apply", { create: [{ type: "rectangle", key: "n" }] }) as string).created.n);
  // an archived board this window does not hold (the screen clears the role of the one it shows) is not asked for, and the call is NOT_HOLDER, as on the old page:
  // the check of the role comes first (heldTarget)
  const idle = newBoard({ archived: true });
  api.read = stored(0);
  await assert.rejects(call(idle, "apply", { create: [{ type: "rectangle" }] }), { code: "NOT_HOLDER" });
  assert.equal(api.asked().filter((l) => l.startsWith("take")).length, 0, "an archived board is not asked for");
});

test("read_board on the board on screen reads the view's scene as it is now, a change not told yet included", async () => {
  const b = await onScreen();
  view.draw((els) => [...els, rect("e2", 50, { customData: { key: "late" } })], { tell: false });
  const text = await call(b, "read_board") as string;
  assert.match(text, /^Board b_\d+ \(b_\d+\) \(rev 0, 2 elements\)/);
  assert.match(text, /late/);
});

test("read_board prints each element's label and the two ends of an arrow, a board with nothing says so (D-AG-18)", async () => {
  const labelled = (id: string, text: string, containerId: string) => ({ id, type: "text", x: 0, y: 0, width: 10, height: 10, version: 1, containerId, text });
  const b = await onScreen(0, [
    rect("a", 100, { customData: { key: "A" }, boundElements: [{ id: "ta", type: "text" }, { id: "ab", type: "arrow" }] }), labelled("ta", "Start here", "a"),
    rect("b", 400, { customData: { key: "B" }, boundElements: [{ id: "ab", type: "arrow" }] }),
    { id: "ab", type: "arrow", x: 110, y: 5, width: 290, height: 0, points: [[0, 0], [290, 0]], version: 1, startBinding: { elementId: "a" }, endBinding: { elementId: "b" } },
    { id: "loose", type: "arrow", x: 0, y: 300, width: 50, height: 0, points: [[0, 0], [50, 0]], version: 1 },
  ]);
  const lines = (await call(b, "read_board") as string).split("\n");
  assert.match(lines[0], /\(rev 0, 5 elements\)$/, "the bound text is not counted: it is its container's label");
  const rows = Object.fromEntries(lines.slice(1).map((l) => [/id=(\w+)/.exec(l)![1], l]));
  assert.match(rows.a, /^rectangle\s+key=A\s+id=a\s+"Start here"\s+\(100,0 10×10\)$/, "the label of a container is on its line, with its key and its box");
  assert.ok(!lines.some((l) => /id=ta\b/.test(l)), "the bound text has no line of its own");
  assert.match(rows.ab, /^arrow\s+id=ab\s+\(110,5 290×0\) {2}A → B$/, "an arrow names its two ends by their keys");
  assert.match(rows.loose, / {2}· → ·$/, "an end bound to nothing is a dot");

  const empty = newBoard();
  api.read = async () => ({ scene: { elements: [], appState: {}, files: {} }, rev: 0 });
  store.setRole(empty, "held");
  assert.equal(await call(empty, "read_board"), `Board ${empty} (${empty}) (rev 0, 0 elements)\n(empty board)`);
});

test("get_view tells the visible area the view told, in board coordinates, and the zoom (D-SL-01)", async () => {
  const b = await onScreen();
  view.scroll({ scrollX: -120, scrollY: -40, zoom: 2, width: 800, height: 600 });
  await until(() => st().view.zoom === 2, "the view told");
  const text = await side.runTool({ chat: "c", board: b, name: "get_view", args: {} }) as string;
  assert.equal(text.split("\n")[1], "viewport   (120,40 400×300) zoom 2", "x and y are where the screen's corner lies on the board; width and height are the screen's over the zoom");
  view.scroll({ scrollX: 50, scrollY: 0, zoom: 0.5, width: 1000, height: 500 });
  await until(() => st().view.zoom === 0.5, "the view told again");
  assert.equal((await side.runTool({ chat: "c", board: b, name: "get_view", args: {} }) as string).split("\n")[1], "viewport   (-50,0 2000×1000) zoom 0.5");
});

test("get_view names the selection the view told", async () => {
  const b = await onScreen(0, [rect("e2", 50, { customData: { key: "two" } })]);
  view.select(["e2"]);
  await until(() => st().selection.count === 1);
  const text = await side.runTool({ chat: "c", board: b, name: "get_view", args: {} }) as string;
  assert.match(text, /selection \(1\):\n {2}.*two/);
});

test("get_image: the view draws the chosen elements of the board on screen; its bounds and the count are in the text", async () => {
  const b = await onScreen(0, [rect("e2", 50)]);
  const r = await call(b, "get_image", { scope: "all", scale: 2 }) as any;
  const req = view.ops("export")[0] as any;
  assert.deepEqual(req, { op: "export", target: "live", ids: ["e1", "e2"], scale: 2, background: true });
  assert.equal(r.image.mimeType, "image/png");
  assert.equal(r.image.data, "iVBORw0KGgo=");
  assert.match(r.text, /2 elements/);
});

test("get_image off screen sends the kept scene; a refusal of the view keeps its code, any other failure is RENDER_FAILED", async () => {
  const b = newBoard();
  store.setRole(b, "held");
  api.read = stored(0);
  view.script = (op) => (op.op === "export" ? { code: "TOO_LARGE", message: "the picture would be 9000x10 px" } : undefined);
  await assert.rejects(call(b, "get_image", { scope: "all" }), { code: "TOO_LARGE", message: "the picture would be 9000x10 px" });
  const req = view.ops("export")[0] as any;
  assert.deepEqual(req.target.elements.map((e: any) => e.id), ["e1"]);
  view.script = (op) => (op.op === "export" ? { code: "FAILED", message: "canvas lost" } : undefined);
  await assert.rejects(call(b, "get_image", { scope: "all" }), { code: "RENDER_FAILED", message: "the picture could not be drawn: canvas lost" });
});

test("get_image selection: the selection the view told, on the board on screen", async () => {
  const b = await onScreen(0, [rect("e2", 50)]);
  await assert.rejects(call(b, "get_image", { scope: "selection" }), { code: "NO_SELECTION" });
  view.select(["e2"]);
  await until(() => st().selection.count === 1);
  await call(b, "get_image", {});
  assert.deepEqual((view.ops("export")[0] as any).ids, ["e2"]);
});

test("show_board selects the board if free and brings the refs into view once it is drawn", async () => {
  const b = newBoard();
  api.read = stored(0);
  assert.equal(await call(b, "show_board", { refs: [{ id: "e1" }] }), `showing Board ${b}`);
  assert.deepEqual(selects, [[{ board: b, chat: null }, { ifFree: true }]]);
  await side.show(b); // the screen shows what was selected
  await until(() => view.sent("scrollTo").length === 1, "the scroll");
  assert.deepEqual(view.sent("scrollTo")[0], { t: "scrollTo", ids: ["e1"], animate: true });
});

// ---- the selection, a point and a clicked reference

test("the selection and a point on the board on screen become references; on another board, nothing", async () => {
  const b = await onScreen(0, [rect("e2", 50, { customData: { key: "box" } })]);
  assert.equal(side.selectionRefOn(b), null);
  view.select(["e2"]);
  await until(() => st().selection.count === 1);
  const ref = side.selectionRefOn(b) as any;
  assert.equal(ref.kind, "selection");
  assert.deepEqual(ref.ids, ["e2"]);
  assert.equal(side.selectionRefOn("b_other"), null);
  const p = side.pointRefOn(b, 55, 5) as any;
  assert.equal(p.kind, "point");
  assert.deepEqual(side.selectionLines().length, 1);
});

test("a clicked reference selects its elements and brings them into view; a point flashes", async () => {
  const b = await onScreen();
  side.showRef(b, { kind: "selection", ids: ["e1", "gone"] } as any, "claude");
  assert.deepEqual(view.sent("select", "scrollTo"), [{ t: "select", ids: ["e1"] }, { t: "scrollTo", ids: ["e1"], animate: true }]);
  side.showRef(b, { kind: "point", x: 10, y: 20, label: "(10, 20)" } as any, "claude");
  assert.ok(st().flashes.some((f) => f.board === b && f.box.x === 4));
  side.showRef("b_elsewhere", { kind: "selection", ids: ["e1"] } as any, "claude");
  assert.equal(view.sent("select").length, 1);
});

test("the style the user chose is carried to the next board shown", async () => {
  await onScreen();
  view.draw((els) => [...els, rect("e2", 50)]);
  await tick(); await tick();
  const b = newBoard();
  await side.show(b);
  assert.deepEqual((view.sent("load").at(-1) as any).style, { currentItemStrokeColor: "#1e1e1e" });
});

test("nothing the app sent was refused by the bridge's validator", async () => {
  const b = await onScreen();
  await call(b, "apply", { create: [{ type: "text", text: "hi" }] });
  await call(b, "get_image", { scope: "all" });
  side.hide();
  await tick();
  assert.deepEqual(view.refused, []);
});
