// What a chat of another server shows where its thread is (src/logic/remoteview.ts). The bar stays only over a thread the app holds:
// a server that drops before the chat's list arrived leaves nothing to keep, and the thread's place says "not connected" instead
// (a browser check that drops a server for the bar waits for the list first: dev/checks/sel.mjs act).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./fixtures/bundle.ts";
import { notConnected } from "../src/logic/status.ts";
import { NOT_FOUND, SERVERS, TRY_AGAIN, awayText, deleteAsk, goneText, remoteView, stateSaid, unreachableText, type Remote } from "../src/logic/remoteview.ts";
import { stateLabel, type ServerState } from "../src/logic/servers.ts";

const src = sourceOf;
const away = { connected: false };

/** A chat: its server holds its tree (UP), or not (DOWN). This computer's server is a server like the others. */
const UP: Remote = { connected: true };
const DOWN: Remote = { connected: false };

test("remoteView: a server that is not connected, with the thread kept: the bar over it", () => {
  const v = remoteView(away, "Studio Mac", "unreachable", true);
  assert.equal(v.kind, "bar");
  assert.equal(v.kind === "bar" && v.text, awayText("Studio Mac"));
  assert.equal(v.kind === "bar" && v.gone, false);
});

test("remoteView: the same server before the list arrived: the sentence in the thread's place, no bar", () => {
  const v = remoteView(away, "Studio Mac", "unreachable", false);
  assert.equal(v.kind, "unreachable");
  assert.equal(v.kind === "unreachable" && v.text, unreachableText("Studio Mac"));
});

test("remoteView: a failed load does not make a bar of a server that is not connected", () => {
  assert.equal(remoteView(away, "Studio Mac", "unreachable", false, { code: "x", message: "boom" } as never).kind, "unreachable");
});

test("remoteView: connected, the thread is as usual, also while its load runs", () => {
  assert.equal(remoteView({ connected: true }, "Studio Mac", "connected", true).kind, "none");
  assert.equal(remoteView({ connected: true }, "Studio Mac", "connected", false).kind, "none");
});

test("remoteView: a chat that is gone: the bar over a kept thread, the sentence alone without one", () => {
  const bar = remoteView({ connected: true, gone: true }, "Studio Mac", "connected", true);
  assert.deepEqual(bar, { kind: "bar", text: goneText("Studio Mac"), gone: true });
  assert.deepEqual(remoteView({ connected: true, gone: true }, "Studio Mac", "connected", false), { kind: "gone", text: goneText("Studio Mac") });
});

test("the sentences name the server", () => {
  assert.equal(notConnected("Studio"), "Studio is not connected");
  assert.equal(goneText("Studio"), "This chat is no longer on Studio.");
  assert.equal(unreachableText("Studio"), "Studio is not connected. This chat shows again when it is back.");
  assert.equal(awayText("Studio"), "Studio is not connected. This chat is shown as it was when the connection ended.");
  assert.equal(SERVERS, "Servers…");
  assert.equal(TRY_AGAIN, "Try again");
});

test("remoteView: a chat of this computer is judged as any other: away, or gone from this computer", () => {
  assert.deepEqual(remoteView(UP, "This computer", "connected", true), { kind: "none" });
  assert.deepEqual(remoteView(DOWN, "This computer", "not_started", false), { kind: "unreachable", text: "This computer is not connected. This chat shows again when it is back.", state: "Not started" });
  assert.deepEqual(remoteView(DOWN, "This computer", "unreachable", true), { kind: "bar", text: awayText("This computer"), gone: false, state: "Unreachable" });
  assert.deepEqual(remoteView({ connected: true, gone: true }, "This computer", "connected", true), { kind: "bar", text: goneText("This computer"), gone: true });
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

test("deleteAsk: the dialog a chat's Delete opens", () => {
  assert.deepEqual(deleteAsk("Notes"), { title: "Delete Notes?", body: "Its history is removed. This can't be undone." });
  assert.deepEqual(deleteAsk("Notes", ""), { title: "Delete Notes?", body: "Its history is removed. This can't be undone." });
  assert.deepEqual(deleteAsk("Notes", "Studio"), { title: "Delete Notes?", body: "Its history is removed on Studio, for everyone who uses that server. This can't be undone." });
});

test("a chat is deleted on its server or not at all: nothing offers to remove it from this sidebar only", () => {
  assert.deepEqual(Object.keys(deleteAsk("Notes", "Studio")).sort(), ["body", "title"], "no action of its own and no `local`");
});
