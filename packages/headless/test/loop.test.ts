// The writer's loop over a fake stream, a fake engine and the app's real board side: what it answers, in which order it
// writes and replies, and when it lets a board go.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as store from "@aiwb/core/state/store.ts";
import { rig, stop, until, wait, SCENE, type Rig } from "./support.ts";

let r: Rig | null = null;
const quiet = console.error;
console.error = () => {}; // (the board side logs a failed save)
test.after(() => { console.error = quiet; });
afterEach(async () => { if (r) await stop(r); r = null; });

const NAME = "Board (b1)";

test("held, then rpc: read_board gives the result the window gives", async () => {
  r = await rig();
  r.server.held("b1", 3);
  const id = r.server.rpc("read_board");
  const reply = await r.server.reply(id);
  assert.equal(reply.error, undefined);
  assert.match(reply.result, /^Board \(b1\) \(rev 0, 1 elements\)\n/);
  assert.deepEqual(r.fake.asked, ["restore"]);
  assert.deepEqual(r.server.log.slice(0, 2), ["GET scene b1", `reply ${id} ok`]);
});

test("a call on a board the server did not give is NOT_HOLDER, and takes nothing", async () => {
  r = await rig();
  const id = r.server.rpc("read_board");
  const reply = await r.server.reply(id);
  assert.equal(reply.error, "NOT_HOLDER: this window does not hold the board");
  assert.ok(!r.server.calls.some((c) => c.path.endsWith("/take")), "no take call");
  assert.deepEqual(r.loop.holds(), []);
});

test("apply is saved before the reply, on the revision of the grant", async () => {
  r = await rig();
  r.server.held("b1", 3);
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b", x: 5, y: 5, width: 20, height: 20 }] });
  const reply = await r.server.reply(id);
  assert.equal(reply.error, undefined);
  const out = JSON.parse(reply.result);
  assert.equal(out.board, "Board");
  assert.equal(out.id, "b1");
  assert.deepEqual(Object.keys(out.created), ["b"]);
  // the fake client saw the PUT of the scene before the reply, and the PUT named the stored revision
  assert.deepEqual(r.server.log, ["GET scene b1", "PUT scene b1 on 3", `reply ${id} ok`]);
  assert.equal(r.server.written[0].scene.elements.length, 2);
  assert.equal(r.loop.side.boardUnsaved("b1"), false);
});

test("delete_elements is saved before the reply too", async () => {
  r = await rig();
  r.server.held("b1", 3);
  const id = r.server.rpc("delete_elements", { refs: [{ key: "a" }] });
  const reply = await r.server.reply(id);
  assert.equal(reply.error, undefined);
  assert.deepEqual(JSON.parse(reply.result).deleted, ["e1"]);
  assert.deepEqual(r.server.log.slice(1), ["PUT scene b1 on 3", `reply ${id} ok`]);
  assert.equal(r.server.written[0].scene.elements[0].isDeleted, true);
});

test("a save that fails answers SAVE_FAILED, not the result; the next call saves the change again", async () => {
  r = await rig();
  r.server.held("b1", 3);
  let fail = true;
  r.server.routes.set("PUT /api/boards/b1/scene", async (req) => {
    if (fail) return { status: 500, json: { error: "disk full" } };
    return { json: { rev: 4 } };
  });
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  const reply = await r.server.reply(id);
  assert.match(reply.error!, /^SAVE_FAILED: the change was made but could not be saved: /);
  assert.equal(reply.result, undefined);
  assert.equal(r.loop.side.boardUnsaved("b1"), true);
  fail = false;
  const id2 = r.server.rpc("apply", { create: [{ type: "rectangle", key: "c" }] });
  const reply2 = await r.server.reply(id2);
  assert.equal(reply2.error, undefined);
  assert.equal(r.loop.side.boardUnsaved("b1"), false);
});

test("a save the server refuses as not_holder answers SAVE_FAILED and the board is not kept", async () => {
  r = await rig();
  r.server.held("b1", 3);
  r.server.routes.set("PUT /api/boards/b1/scene", async () => ({ status: 409, json: { error: "another window holds this board", code: "not_holder" } }));
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  const reply = await r.server.reply(id);
  assert.match(reply.error!, /^SAVE_FAILED: the change was made but could not be saved: .*taken over/);
  assert.deepEqual(r.loop.holds(), []);
});

test("an error of the engine is answered as the window answers it", async () => {
  r = await rig();
  r.server.held("b1", 3);
  r.fake.fail = { code: "BAD_REF", message: "no live element for {\"key\":\"zz\"}" };
  const id = r.server.rpc("apply", { update: [{ ref: { key: "zz" } }] });
  const reply = await r.server.reply(id);
  assert.equal(reply.error, 'BAD_REF: no live element for {"key":"zz"}');
  assert.ok(!r.server.log.some((l) => l.startsWith("PUT")), "nothing was written");
});

test("get_image answers the picture", async () => {
  r = await rig();
  r.server.held("b1", 3);
  const id = r.server.rpc("get_image", { scope: "all" });
  const reply = await r.server.reply(id);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.image.mimeType, "image/png");
  assert.match(reply.result.text, /Board \(b1\)/);
  assert.ok(!r.server.log.some((l) => l.startsWith("PUT")), "a picture writes nothing");
});

test("the screen tools and the selection scope give the words of 2.10", async () => {
  r = await rig();
  r.server.held("b1", 3);
  const view = await r.server.reply(r.server.rpc("get_view"));
  assert.equal(view.error, undefined);
  assert.equal(view.result, `No window shows ${NAME} now, so there is no view and no selection to read. The board itself can be read and changed as usual: use read_board, and get_image for a picture.`);
  const show = await r.server.reply(r.server.rpc("show_board"));
  assert.equal(show.error, undefined);
  assert.equal(show.result, `No window shows this chat's board now, so ${NAME} could not be put on a screen. Your changes are saved in the board; the user sees them when they open it.`);
  const sel = await r.server.reply(r.server.rpc("get_image", { scope: "selection" }));
  assert.equal(sel.error, `NO_SELECTION: no window shows ${NAME} now, so nothing is selected on it; use scope all, refs or rect`);
  assert.deepEqual(r.fake.asked, [], "none of them reached the engine");
});

test("a call on a board that is not on the server's list is NO_BOARD, in the side's words", async () => {
  r = await rig();
  const reply = await r.server.reply(r.server.rpc("read_board", {}, { target: "nope", board: "b1" }));
  assert.equal(reply.error, "NO_BOARD: no board with id nope; call list_boards to find ids");
});

test("a quiet time after the last call releases the board with ifIdle; kept keeps it and waits again", async () => {
  r = await rig({ quietMs: 120 });
  let releases = 0;
  r.server.routes.set("POST /api/boards/b1/release", async (_req, body) => {
    releases++;
    assert.deepEqual(body, { ifIdle: true });
    r!.server.log.push("POST release b1 ifIdle");
    return { json: { state: releases === 1 ? "kept" : "free" } };
  });
  r.server.held("b1", 3);
  const reply = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }));
  assert.equal(reply.error, undefined);
  await until(() => releases === 2, "two releases");
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
  assert.equal(r.loop.side.scene("b1"), undefined, "its scene is gone");
  await wait(300);
  assert.equal(releases, 2, "after free it does not ask again");
});

test("a board granted and never called is let go after the quiet time", async () => {
  r = await rig({ quietMs: 60 });
  r.server.held("b1", 3);
  await until(() => r!.server.log.includes("POST release b1 ifIdle"), "the release");
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
});

test("a call in progress holds the quiet time back, and the end of the call starts it again", async () => {
  r = await rig({ quietMs: 80 });
  let open!: () => void;
  r.fake.gate = new Promise<void>((res) => { open = res; });
  r.server.held("b1", 3);
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await wait(250); // several quiet times
  assert.ok(!r.server.log.some((l) => l.startsWith("POST release")), "no release while the call runs");
  r.fake.gate = null; open();
  await r.server.reply(id);
  await until(() => r!.server.log.includes("POST release b1 ifIdle"), "the release after the call");
});

test("a release_request waits for the call in progress, saves, releases and forgets", async () => {
  r = await rig();
  let open!: () => void;
  r.fake.gate = new Promise<void>((res) => { open = res; });
  r.server.held("b1", 3);
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.fake.asked.includes("apply"), "the apply asked");
  r.server.emit({ type: "release_request", board: "b1" });
  await wait(100);
  assert.ok(!r.server.log.some((l) => l.startsWith("POST release")), "not released while the call runs");
  r.fake.gate = null; open();
  const reply = await r.server.reply(id);
  assert.equal(reply.error, undefined, "the call in progress finished and was answered");
  await until(() => r!.server.log.includes("POST release b1"), "the release");
  // the finished change is in the board before the board is let go
  assert.deepEqual(r.server.log, ["GET scene b1", "PUT scene b1 on 3", `reply ${id} ok`, "POST release b1"]);
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
});

test("a release_request does not wait longer than the hand-off time for a call that does not finish", async () => {
  r = await rig({ handoverMs: 150 });
  r.fake.gate = new Promise<void>(() => {}); // never
  r.server.held("b1", 3);
  r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.fake.asked.includes("apply"), "the apply asked");
  r.server.emit({ type: "release_request", board: "b1" });
  await until(() => r!.server.log.includes("POST release b1"), "the release");
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
});

test("a yield with no call in progress still flushes what a failed save left, then releases", async () => {
  r = await rig();
  r.server.held("b1", 3);
  let fail = true;
  r.server.routes.set("PUT /api/boards/b1/scene", async (_req, body) => {
    if (fail) return { status: 500, json: { error: "disk full" } };
    r!.server.log.push("PUT scene b1 (late)");
    return { json: { rev: 4 } };
  });
  assert.match((await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }))).error!, /^SAVE_FAILED/);
  fail = false;
  r.server.emit({ type: "release_request", board: "b1" });
  await until(() => r!.server.log.includes("POST release b1"), "the release");
  assert.ok(r.server.log.indexOf("PUT scene b1 (late)") >= 0 && r.server.log.indexOf("PUT scene b1 (late)") < r.server.log.indexOf("POST release b1"), r.server.log.join(" | "));
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
});

test("a yield whose wait ends with a change made and not saved writes nothing and still releases", async () => {
  r = await rig({ handoverMs: 100, holdBeforeSave: 2 });
  r.server.held("b1", 3);
  const first = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "a2" }] }));
  assert.equal(first.error, undefined);
  r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }); // changes the scene, then waits before its save
  await until(() => r!.printed.length > 0, "the HOLD line");
  assert.ok(r.loop.side.boardUnsaved("b1"), "the change is in the scene and not written");
  r.server.emit({ type: "release_request", board: "b1" });
  await until(() => r!.server.log.includes("POST release b1"), "the release");
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
  assert.equal(r.server.log.filter((l) => l.startsWith("PUT")).length, 1, r.server.log.join(" | "));
  assert.equal(r.server.written.length, 1);
  assert.equal(r.server.written[0].scene.elements.length, 2, "the store has the earlier change only");
  assert.equal(r.server.scenes.get("b1")!.rev, 4);
  assert.equal(r.loop.side.scene("b1"), undefined);
});

test("a call cut off by a yield answers TAKEN when it gets to its save, and writes nothing", async () => {
  r = await rig({ handoverMs: 100 });
  let open!: () => void;
  r.server.held("b1", 3);
  const first = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "a2" }] }));
  assert.equal(first.error, undefined);
  r.fake.gate = new Promise<void>((res) => { open = res; });
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.fake.asked.filter((a) => a === "apply").length === 2, "the second apply asked");
  r.server.emit({ type: "release_request", board: "b1" });
  await until(() => r!.server.log.includes("POST release b1"), "the release");
  await until(() => r!.loop.holds().length === 0, "the board forgotten");
  assert.equal(r.server.log.filter((l) => l.startsWith("PUT")).length, 1, "the yield wrote nothing");
  r.fake.gate = null; open(); // the change is made now, after the release
  const reply = await r.server.reply(id);
  assert.equal(reply.error, `TAKEN: ${NAME} is being taken over in a window; call again in a moment and that window answers.`);
  assert.equal(reply.result, undefined);
  await wait(50);
  assert.equal(r.server.log.filter((l) => l.startsWith("PUT")).length, 1, "the call wrote nothing");
  assert.equal(r.server.written[0].scene.elements.length, 2);
  assert.equal(r.loop.side.scene("b1"), undefined, "nothing of the cut call is kept");
  assert.equal(r.loop.side.boardUnsaved("b1"), false);
  await r.loop.shutdown(500);
  assert.equal(r.server.log.filter((l) => l.startsWith("PUT")).length, 1, "nor does the shutdown");
});

test("a call that comes while the board yields is TAKEN", async () => {
  r = await rig();
  let open!: () => void;
  r.fake.gate = new Promise<void>((res) => { open = res; });
  r.server.held("b1", 3);
  const first = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.fake.asked.includes("apply"), "the apply asked");
  r.server.emit({ type: "release_request", board: "b1" });
  const second = r.server.rpc("read_board");
  const reply = await r.server.reply(second);
  assert.equal(reply.error, `TAKEN: ${NAME} is being taken over in a window; call again in a moment and that window answers.`);
  r.fake.gate = null; open();
  assert.equal((await r.server.reply(first)).error, undefined);
});

test("superseded: the board is let go, and a later call on it is NOT_HOLDER", async () => {
  r = await rig();
  r.server.held("b1", 3);
  assert.equal((await r.server.reply(r.server.rpc("read_board"))).error, undefined);
  r.server.emit({ type: "superseded", board: "b1" });
  assert.deepEqual(r.loop.holds(), []);
  assert.equal(r.loop.side.scene("b1"), undefined);
  const reply = await r.server.reply(r.server.rpc("read_board"));
  assert.match(reply.error!, /^NOT_HOLDER/);
});

test("held again after a release: the board is read anew at the revision it was given", async () => {
  r = await rig();
  r.server.held("b1", 3);
  await r.server.reply(r.server.rpc("read_board"));
  r.server.emit({ type: "superseded", board: "b1" });
  r.server.scenes.set("b1", SCENE(7));
  r.server.held("b1", 7);
  const reply = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }));
  assert.equal(reply.error, undefined);
  assert.equal(r.server.written.at(-1)!.base, 7);
});

test("board events keep the list of boards; a removed board is forgotten", async () => {
  r = await rig();
  r.server.emit({ type: "board", board: { id: "b2", name: "Second", group: "" } });
  assert.equal(store.getState().boards.b2.name, "Second");
  r.server.held("b1", 3);
  await r.server.reply(r.server.rpc("read_board"));
  r.server.emit({ type: "board_removed", id: "b1" });
  assert.equal(store.getState().boards.b1, undefined);
  assert.equal(r.loop.side.scene("b1"), undefined);
});

test("server_stopping saves what waits, then posts flushed", async () => {
  r = await rig();
  r.server.held("b1", 3);
  let fail = true;
  r.server.routes.set("PUT /api/boards/b1/scene", async (_req, body) => {
    if (fail) return { status: 500, json: { error: "disk full" } };
    r!.server.log.push("PUT scene b1 (late)");
    return { json: { rev: 4 } };
  });
  const reply = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }));
  assert.match(reply.error!, /^SAVE_FAILED/);
  fail = false;
  r.server.emit({ type: "server_stopping" });
  await until(() => r!.server.log.includes("POST flushed"), "flushed");
  const at = r.server.log.indexOf("PUT scene b1 (late)");
  assert.ok(at >= 0 && at < r.server.log.indexOf("POST flushed"), r.server.log.join(" | "));
});

test("the stream ending after it was connected ends the loop, once, and it does not listen again", async () => {
  r = await rig();
  r.server.state("unreachable", "The connection to the server ended");
  r.server.state("connecting");
  assert.equal(r.ended.length, 1);
  assert.match(r.ended[0], /the connection to the server ended/);
  assert.equal(r.server.closed, 1, "the subscription was closed: the client does not reconnect");
});

test("a connection state before the snapshot does not end the loop", async () => {
  const { FakeServer } = await import("./support.ts");
  void FakeServer;
  r = await rig();
  assert.equal(r.ended.length, 0);
  assert.equal(r.loop.lastState().state, "connected");
});

test("the test knob prints HOLD after the apply and before the save, and waits", async () => {
  r = await rig({ holdBeforeSave: true });
  r.server.held("b1", 3);
  const id = r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.printed.length > 0, "the HOLD line");
  assert.deepEqual(r.printed, ["HOLD apply b1"]);
  await wait(150);
  assert.ok(!r.server.log.some((l) => l.startsWith("PUT")), "nothing was written");
  assert.equal(r.server.replies.length, 0, "nothing was answered");
  void id;
});

test("the knob with a number holds that apply: the ones before it are saved and answered", async () => {
  r = await rig({ holdBeforeSave: 2 });
  r.server.held("b1", 3);
  const first = await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "a" }] }));
  assert.equal(first.error, undefined);
  assert.deepEqual(r.printed, []);
  assert.ok(r.server.log.some((l) => l.startsWith("PUT")), "the first apply was saved");
  const puts = r.server.log.filter((l) => l.startsWith("PUT")).length;
  r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] });
  await until(() => r!.printed.length > 0, "the HOLD line");
  assert.deepEqual(r.printed, ["HOLD apply b1"]);
  await wait(150);
  assert.equal(r.server.log.filter((l) => l.startsWith("PUT")).length, puts, "the second apply was not written");
  assert.equal(r.server.replies.length, 1, "only the first was answered");
});

test("the knob does not hold a read", async () => {
  r = await rig({ holdBeforeSave: true });
  r.server.held("b1", 3);
  assert.equal((await r.server.reply(r.server.rpc("read_board"))).error, undefined);
  assert.deepEqual(r.printed, []);
});

test("shutdown writes what waits, within its limit, and stops answering", async () => {
  r = await rig();
  r.server.held("b1", 3);
  let fail = true;
  r.server.routes.set("PUT /api/boards/b1/scene", async () => (fail ? { status: 500, json: { error: "x" } } : { json: { rev: 4 } }));
  await r.server.reply(r.server.rpc("apply", { create: [{ type: "rectangle", key: "b" }] }));
  fail = false;
  await r.loop.shutdown(2000);
  assert.equal(r.loop.side.boardUnsaved("b1"), false);
  assert.equal(r.server.closed, 1);
  const before = r.server.replies.length;
  r.server.rpc("read_board"); // (the subscription is closed: the fake delivers nothing)
  await wait(50);
  assert.equal(r.server.replies.length, before);
});
