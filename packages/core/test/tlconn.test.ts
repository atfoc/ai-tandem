// conn.ts and the new boards (design 2.3, 6), the state layer as it is over a fake transport: `tl_sync`/`tl_closed` events reach the
// link of their session through the registry (for a section without a tree too), a server's `hello` and its leaving tell the links
// of that server, and an agent's get_view/show_board for a new board is answered by the registry while every other call, and every
// classic board, goes to the board side as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setBoardSide, setUi, type BoardSide, type Ui } from "../src/state/ports.ts";
import * as store from "../src/state/store.ts";
import { connect } from "../src/state/conn.ts";
import { openTlLink } from "../src/tl/link.ts";
import { tlRegistry } from "../src/tl/registry.ts";
import { envelopesOf } from "./fixtures/stream.ts";
import { FakeTransport, ok } from "./fixtures/faketransport.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fake = new FakeTransport().install();
async function ev(m: Record<string, unknown>) {
  for (const e of envelopesOf(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) })) fake.emit(e);
  await tick(); await tick();
}

const ran: unknown[] = [];
setBoardSide({
  runTool: async (call) => { ran.push(call); return "from the board side"; },
  flushAll: async () => {}, boardLost() {}, sceneMoved() {}, granted() {}, handOver: async () => {}, streamOpened() {}, afterSnapshot() {}, sectionBack() {},
  forgetBoard() {}, boardUnsaved: () => false,
} as BoardSide);
setUi({ openChat() {}, select() {}, focusComposer() {}, reportError() {}, confirm() {} } as Ui);

const S1 = "s_aaaaaaaaaaaa";
let sessions = 0;
fake.handler = (c) => (c.path.startsWith("/api/tl/") && c.path.endsWith("/open") ? ok({ session: `s_${++sessions}` }) : undefined);
const replies = () => fake.calls.filter((c) => c.path === "/api/rpc-reply").map((c) => c.body);

connect();
await ev({ type: "snapshot", boards: [{ id: "b_tl", name: "Sprint", group: "", created: "", kind: "tl" }, { id: "b_old", name: "Old", group: "", created: "" }] });
store.setState({ sel: { board: "b_tl", chat: null } });

test("the kind of a board reaches the store from the snapshot", () => {
  assert.equal(store.getState().boards.b_tl.kind, "tl");
  assert.equal(store.getState().boards.b_old.kind, undefined);
});

test("get_view and show_board of a new board are answered by the registry; the other tools and the classic boards by the board side", async () => {
  fake.reset(); ran.length = 0;
  const call = (name: string, board: string, target?: string) => ({ chat: "c_1", branch: "main", board, name, args: {}, ...(target ? { target } : {}) });
  await ev({ type: "rpc", id: "r_1", method: "tool", params: call("get_view", "b_tl") });
  await ev({ type: "rpc", id: "r_2", method: "tool", params: call("show_board", "b_old", "b_tl") });
  await ev({ type: "rpc", id: "r_3", method: "tool", params: call("get_view", "b_old") });
  await ev({ type: "rpc", id: "r_4", method: "tool", params: call("read_board", "b_tl", "b_tl") });
  await ev({ type: "rpc", id: "r_5", method: "tool", params: call("show_board", "b_tl", "b_old") });
  assert.deepEqual(replies(), [
    { id: "r_1", result: "active_board: Sprint (b_tl), kind: new\nview: the board is still opening on the user's screen\nselection: none" },
    { id: "r_2", result: "shown Sprint (b_tl)" },
    { id: "r_3", result: "from the board side" },
    { id: "r_4", result: "from the board side" },
    { id: "r_5", result: "from the board side" },
  ]);
  assert.deepEqual(ran.map((c: any) => c.name), ["get_view", "read_board", "show_board"]);
});

test("tl_sync and tl_closed events reach the link of their session; a hello of its server closes it and it opens again", async () => {
  fake.reset();
  const link = openTlLink("b_tl", { backoff: [5] });
  const got: string[][] = [], statuses: string[] = [];
  link.onMessages((m) => got.push(m));
  link.onStatus((s, r) => statuses.push(r ? `${s}:${r}` : s));
  await tick();
  assert.equal(link.status, "online");
  const session = (fake.calls.find((c) => c.path === "/api/tl/b_tl/open") && `s_${sessions}`)!;
  await ev({ type: "tl_sync", board: "b_tl", session, messages: ["{\"type\":\"connect\"}"] });
  await ev({ type: "tl_sync", board: "b_tl", session: "s_other", messages: ["not mine"] });
  assert.deepEqual(got, [["{\"type\":\"connect\"}"]]);
  link.send(["m1"]);
  await tick();
  assert.deepEqual(fake.calls.filter((c) => c.path === "/api/tl/b_tl/sync").map((c) => c.body), [{ session, messages: ["m1"] }]);
  await ev({ type: "tl_closed", board: "b_tl", session, reason: "host_stopped" });
  assert.equal(statuses.at(-1), "offline:host_stopped");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status, "online");
  await ev({ type: "hello" });
  assert.equal(statuses.at(-1), "offline:stream_reopened");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status, "online");
  link.close();
  await tick();
  assert.equal(fake.calls.filter((c) => c.path === "/api/tl/b_tl/close").length >= 1, true);
});

test("a server that is not connected any more ends the sessions of its boards until its stream is back", async () => {
  const link = openTlLink(`${S1}~b_9`, { backoff: [5] });
  await tick();
  assert.equal(link.status, "online");
  assert.equal(fake.calls.at(-1)?.server, S1);
  const session = `s_${sessions}`;
  // its events come though the page holds no tree of that server
  const got: string[][] = [];
  link.onMessages((m) => got.push(m));
  await ev({ type: "tl_sync", server: S1, board: "b_9", session, messages: ["x"] });
  assert.deepEqual(got, [["x"]]);
  await ev({ type: "server_state", server: { id: S1, name: "far", state: "unreachable" } });
  assert.equal(link.status, "offline");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status, "offline", "no reopen while it is down");
  await ev({ type: "hello", server: S1 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(link.status, "online");
  link.close();
  assert.equal(tlRegistry().isDown(S1), false);
});
