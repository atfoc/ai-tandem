// A chat of a section where its thread is, and in the delete dialog (src/logic/remoteview.ts): what is shown
// while that server is not connected, and when the chat is no longer on it. The view through the real event
// layer is in remotechat.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { notConnected } from "../src/logic/status.ts";
import { NOT_FOUND, SERVERS, TRY_AGAIN, awayText, deleteAsk, goneText, remoteView, stateSaid, unreachableText, type Remote } from "../src/logic/remoteview.ts";
import { stateLabel, type ServerState } from "../src/logic/servers.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

/** A chat of a section: its server holds its tree (UP), or not (DOWN). */
const UP: Remote = { remote: true, connected: true };
const DOWN: Remote = { remote: true, connected: false };
const HERE: Remote = { remote: false, connected: true };

test("the sentences name the server", () => {
  assert.equal(notConnected("Studio"), "Studio is not connected");
  assert.equal(goneText("Studio"), "This chat is no longer on Studio.");
  assert.equal(unreachableText("Studio"), "Studio is not connected. This chat shows again when it is back.");
  assert.equal(awayText("Studio"), "Studio is not connected. This chat is shown as it was when the connection ended.");
  assert.equal(SERVERS, "Servers…");
  assert.equal(TRY_AGAIN, "Try again");
});

test("remoteView: a chat of this computer shows the thread, whatever else is said of it", () => {
  assert.deepEqual(remoteView(HERE, "This computer", "connected", false, { message: "x" }), { kind: "none" });
  assert.deepEqual(remoteView(HERE, "This computer", "connected", true), { kind: "none" });
  assert.deepEqual(remoteView({ remote: false, connected: false, gone: true }, "This computer", undefined, false, { code: NOT_FOUND, message: "x" }), { kind: "none" }, "it is never away and never gone");
});

test("remoteView: a section's chat whose server is connected shows the thread, loaded or loading", () => {
  assert.deepEqual(remoteView(UP, "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(remoteView(UP, "Studio", "connected", false), { kind: "none" });
  assert.deepEqual(remoteView({ ...UP, gone: false }, "Studio", "connected", true), { kind: "none" });
  // the tree decides, not the entry's state: its event comes in no fixed order with the tree's
  assert.deepEqual(remoteView(UP, "Studio", "unreachable", false), { kind: "none" });
  assert.deepEqual(remoteView(UP, "Studio", "unreachable", true), { kind: "none" });
});

test("remoteView: not connected with no thread says so with the entry's state, with or without a load error", () => {
  const err = { code: "server_unreachable", message: "Studio is not connected." };
  const want = { kind: "unreachable", text: "Studio is not connected. This chat shows again when it is back.", state: "Unreachable" };
  assert.deepEqual(remoteView(DOWN, "Studio", "unreachable", false, err), want);
  assert.deepEqual(remoteView(DOWN, "Studio", "unreachable", false), want, "no load is made while the server is not connected: no error is waited for");
  assert.deepEqual(remoteView(DOWN, "Studio", "unreachable", false, { code: "no_answer", message: "Studio did not answer." }), want, "whatever the load said");
  assert.equal((remoteView(DOWN, "Studio", "connecting", false, err) as { state: string }).state, "Connecting…");
  for (const state of ["connecting", "unreachable", "secret_not_accepted", "certificate_changed", "too_old"] as ServerState[])
    assert.deepEqual(remoteView(DOWN, "Studio", state, false), { kind: "unreachable", text: unreachableText("Studio"), state: stateLabel(state) }, state);
  // the entry's state came before its tree: it is connecting, as its section says, never "is not connected … Connected"
  assert.deepEqual(remoteView(DOWN, "Studio", "connected", false), { kind: "unreachable", text: unreachableText("Studio"), state: "Connecting…" });
  // an entry the list no longer has
  assert.deepEqual(remoteView(DOWN, "Unknown server", undefined, false, err),
    { kind: "unreachable", text: "Unknown server is not connected. This chat shows again when it is back.", state: "" });
});

test("remoteView: gone, by the load's code not_found or the page's mark", () => {
  assert.equal(NOT_FOUND, "not_found");
  const gone = { kind: "gone", text: "This chat is no longer on Studio." };
  assert.deepEqual(remoteView(UP, "Studio", "connected", false, { code: "not_found", message: "chat not found" }), gone, "the sentence is the page's, not the server's");
  assert.deepEqual(remoteView({ ...UP, gone: true }, "Studio", "connected", false), gone);
  assert.deepEqual(remoteView({ ...DOWN, gone: true }, "Studio", "unreachable", false, { code: "server_unreachable", message: "x" }), gone, "gone goes before not connected");
  assert.deepEqual(remoteView(DOWN, "Studio", "unreachable", false, { code: "not_found", message: "x" }), gone);
});

test("remoteView: gone_there is no code any more: such a load is a failed load like another", () => {
  assert.deepEqual(remoteView(UP, "Studio", "connected", false, { code: "gone_there", message: "This chat is no longer on Studio." }), { kind: "failed", text: "This chat is no longer on Studio." });
  assert.deepEqual(remoteView(UP, "Studio", "connected", true, { code: "gone_there", message: "x" }), { kind: "none" });
  assert.ok(!src("logic/remoteview.ts").includes("gone_there"));
});

test("remoteView: a thread on screen stays, read-only, under a warning that says the entry's state in the server list's words", () => {
  const away = { kind: "bar", text: "Studio is not connected. This chat is shown as it was when the connection ended.", gone: false };
  assert.deepEqual(remoteView(DOWN, "Studio", "unreachable", true), { ...away, state: "Unreachable" });
  assert.deepEqual(remoteView(DOWN, "Studio", "secret_not_accepted", true, { message: "x" }), { ...away, state: "Secret not accepted" }, "whatever the last load said");
  // a server that was replaced by an older one, and a state that waits for the user: waiting mends neither, and the warning says which it is
  assert.deepEqual(remoteView(DOWN, "Studio", "too_old", true), { ...away, state: "Too old: update the server on that machine" });
  assert.deepEqual(remoteView(DOWN, "Studio", "certificate_changed", true), { ...away, state: "Certificate changed" });
  assert.deepEqual(remoteView(DOWN, "Studio", "connecting", true), { ...away, state: "Connecting…" });
  assert.deepEqual(remoteView(DOWN, "Studio", undefined, true), { ...away, state: "" }, "an entry the list no longer has");
  for (const state of ["connecting", "unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "certificate_not_accepted", "name_not_known", "not_aiwb", "too_old", "another_server"] as ServerState[])
    assert.equal(stateSaid(state), stateLabel(state), `${state}: the server list's own words`);
  assert.equal(stateSaid("connected"), "Connecting…");
  assert.equal(stateSaid(undefined), "");
  const gone = { kind: "bar", text: "This chat is no longer on Studio.", gone: true };
  assert.deepEqual(remoteView({ ...UP, gone: true }, "Studio", "connected", true), gone);
  assert.deepEqual(remoteView({ ...DOWN, gone: true }, "Studio", "unreachable", true), gone, "gone goes before not connected");
  assert.deepEqual(remoteView(UP, "Studio", "connected", true, { code: "not_found", message: "chat not found" }), gone, "a read answered not_found");
});

test("remoteView: a load that failed while the server is connected shows the server's sentence", () => {
  assert.deepEqual(remoteView(UP, "Studio", "connected", false, { code: "no_answer", message: "Studio did not answer." }), { kind: "failed", text: "Studio did not answer." });
  assert.deepEqual(remoteView(UP, "Studio", "connected", false, { message: "boom" }), { kind: "failed", text: "boom" });
  assert.deepEqual(remoteView(UP, "Studio", "connected", true, { message: "boom" }), { kind: "none" }, "a thread that is kept stays");
});

test("the chat view reads the three from the chat's key, the section's tree and the page's mark", () => {
  const view = src("ChatView.tsx");
  assert.ok(view.includes("const remote = remoteView({ remote: inSection(chatId), connected, gone }, serverIs, state, !!loaded || !!wait.kept, loadErr);"));
  assert.ok(view.includes("const connected = useStore((s) => serverConnected(s, server));"));
  assert.ok(view.includes("const gone = useStore((s) => !!s.gone[chatId]);"));
  assert.ok(view.includes("{!remote.gone && <button type=\"button\" className=\"link remote-servers\" onClick={() => openServers()}>{SERVERS}</button>}"));
});

test("deleteAsk: the dialog a chat's Delete opens", () => {
  assert.deepEqual(deleteAsk("Notes"), { title: "Delete Notes?", body: "Its history is removed. This can't be undone." });
  assert.deepEqual(deleteAsk("Notes", ""), { title: "Delete Notes?", body: "Its history is removed. This can't be undone." });
  assert.deepEqual(deleteAsk("Notes", "Studio"), { title: "Delete Notes?", body: "Its history is removed on Studio, for everyone who uses that server. This can't be undone." });
  // the sidebar names the server of a section's chat alone
  const side = src("Sidebar.tsx");
  assert.ok(side.includes('const there = (key: string): string => (inSection(key) ? serverName(getState(), serverOfKey(key)) : "");'));
  assert.ok(side.includes("const ask = deleteAsk(chatTitle(c, threadOf(getState(), c.id)?.items), there(c.id));"));
});

test("a chat is deleted on its server or not at all: nothing offers to remove it from this sidebar only", () => {
  const logic = src("logic/remoteview.ts"), side = src("Sidebar.tsx");
  for (const gone of ["REMOVE_ONLY", "offersLocalOnly", "deleteRefused", "staysText", "this sidebar"]) {
    assert.ok(!logic.includes(gone), `logic/remoteview.ts has ${gone}`);
    assert.ok(!side.includes(gone), `Sidebar.tsx has ${gone}`);
  }
  assert.deepEqual(Object.keys(deleteAsk("Notes", "Studio")).sort(), ["body", "title"], "no action of its own and no `local`");
});
