import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteRow, notConnected, noLongerOn } from "../src/logic/status.ts";
import { dotState, rowLine } from "../src/logic/labels.ts";
import { REMOVE_ONLY, deleteAsk, deleteRefused, offersLocalOnly, remoteView } from "../src/logic/remoteview.ts";
import { ApiError } from "../src/api.ts";
import type { ChatView } from "../src/types.ts";

const usage = { turns: 0 } as ChatView["usage"];
const settings = "Opus · ~/work";
type V = Parameters<typeof rowLine>[0] & Pick<ChatView, "server" | "gone" | "archived">;
const row = (c: V, connected: boolean) => remoteRow(c, "Studio", connected, rowLine(c, settings), dotState(c));

test("remoteRow: a chat of this computer is given back as it is", () => {
  const c: V = { status: "thinking", usage };
  assert.deepEqual(row(c, true), { line: "Thinking…", dot: "thinking", off: false, gone: false, title: "" });
  assert.deepEqual(remoteRow({}, "This computer", true, settings, "ready"), { line: settings, dot: "ready", off: false, gone: false, title: "" });
});

test("remoteRow: connected, the server's name follows the line and the dot is a local chat's", () => {
  assert.deepEqual(row({ status: "ready", usage, server: "s_1" }, true), { line: `${settings} · Studio`, dot: "ready", off: false, gone: false, title: "" });
  // working, approval and finished (AC17)
  assert.deepEqual(row({ status: "thinking", usage, server: "s_1" }, true), { line: "Thinking… · Studio", dot: "thinking", off: false, gone: false, title: "" });
  assert.deepEqual(row({ status: "approval", usage, approvals: 1, working: 1, server: "s_1" }, true), { line: "Needs your approval · Studio", dot: "approval", off: false, gone: false, title: "" });
  assert.deepEqual(row({ status: "stopped", usage, server: "s_1" }, true), { line: "Stopped · Studio", dot: "stopped", off: false, gone: false, title: "" });
  // archived: the settings line, as a local chat's
  assert.deepEqual(row({ status: "ready", usage, subsOwed: 1, archived: true, server: "s_1" }, true), { line: `${settings} · Studio`, dot: "ready", off: false, gone: false, title: "" });
  assert.equal(remoteRow({ server: "s_1" }, "Studio", true, "", "ready").line, "Studio");
});

test("remoteRow: not connected, the row is off with a grey dot and says so in its title", () => {
  assert.deepEqual(row({ status: "ready", usage, server: "s_1" }, false), { line: `${settings} · Studio`, dot: "off", off: true, gone: false, title: "Studio is not connected" });
  // what the chat did last stays in the line; the dot is grey whatever it was
  const busy = row({ status: "thinking", usage, server: "s_1" }, false);
  assert.equal(busy.line, "Thinking… · Studio");
  assert.equal(busy.dot, "off");
  assert.equal(row({ status: "approval", usage, approvals: 1, server: "s_1" }, false).dot, "off");
  assert.equal(row({ status: "ready", usage, archived: true, server: "s_1" }, false).off, true);
  assert.equal(notConnected("Studio"), "Studio is not connected");
});

test("remoteRow: a chat its server no longer has says that alone, connected or not", () => {
  for (const connected of [true, false])
    assert.deepEqual(row({ status: "thinking", usage, server: "s_1", gone: true }, connected), { line: "No longer on Studio", dot: "off", off: false, gone: true, title: "No longer on Studio" });
  assert.equal(noLongerOn("Studio"), "No longer on Studio");
});

const R = { server: "s_1" };

test("remoteView: a chat of this computer, and a remote one that is connected or loading, show the thread", () => {
  assert.deepEqual(remoteView({}, "This computer", "connected", false, { message: "x" }), { kind: "none" });
  assert.deepEqual(remoteView(R, "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(remoteView(R, "Studio", "connected", false), { kind: "none" });
  assert.deepEqual(remoteView(R, "Studio", "unreachable", false), { kind: "none" }); // the load has not answered yet
});

test("remoteView: not connected with no thread", () => {
  const err = { code: "server_unreachable", message: "Studio is not connected." };
  assert.deepEqual(remoteView(R, "Studio", "unreachable", false, err),
    { kind: "unreachable", text: "Studio is not connected. This chat shows again when it is back.", state: "Unreachable" });
  assert.equal((remoteView(R, "Studio", "connecting", false, err) as { state: string }).state, "Connecting…");
  // an entry the list no longer has
  assert.deepEqual(remoteView(R, "Unknown server", undefined, false, err),
    { kind: "unreachable", text: "Unknown server is not connected. This chat shows again when it is back.", state: "" });
});

test("remoteView: gone, by the load's code or the view's mark", () => {
  const gone = { kind: "gone", text: "This chat is no longer on Studio." };
  assert.deepEqual(remoteView(R, "Studio", "connected", false, { code: "gone_there", message: "This chat is no longer on Studio." }), gone);
  assert.deepEqual(remoteView({ ...R, gone: true }, "Studio", "connected", false), gone);
  assert.deepEqual(remoteView({ ...R, gone: true }, "Studio", "unreachable", false, { code: "server_unreachable", message: "x" }), gone);
});

test("remoteView: a thread on screen stays, with a bar", () => {
  assert.deepEqual(remoteView(R, "Studio", "unreachable", true), { kind: "bar", text: "Studio is not connected.", gone: false });
  assert.deepEqual(remoteView(R, "Studio", "secret_not_accepted", true, { message: "x" }), { kind: "bar", text: "Studio is not connected.", gone: false });
  assert.deepEqual(remoteView({ ...R, gone: true }, "Studio", "connected", true), { kind: "bar", text: "This chat is no longer on Studio.", gone: true });
});

test("remoteView: a load that failed while the server is connected shows the server's sentence", () => {
  assert.deepEqual(remoteView(R, "Studio", "connected", false, { code: "no_answer", message: "Studio did not answer." }), { kind: "failed", text: "Studio did not answer." });
});

test("offersLocalOnly: for a gone chat, and after a delete answered 503", () => {
  assert.equal(offersLocalOnly(R), false);
  assert.equal(offersLocalOnly({ ...R, gone: true }), true);
  assert.equal(offersLocalOnly(R, new ApiError(503, "Studio is not connected.", true, "server_unreachable")), true);
  assert.equal(offersLocalOnly(R, new ApiError(503, "Service Unavailable", false)), true);
  // no answer, the refusal of "this sidebar only", any other error
  assert.equal(offersLocalOnly(R, new ApiError(504, "Studio did not answer.", true, "no_answer")), false);
  assert.equal(offersLocalOnly(R, new ApiError(409, "the server is connected: delete the chat there", true, "server_connected")), false);
  assert.equal(offersLocalOnly(R, new Error("network")), false);
  // never for a chat of this computer
  assert.equal(offersLocalOnly({}, new ApiError(503, "x", true, "server_unreachable")), false);
  assert.equal(offersLocalOnly({ gone: true }), false);
});

test("deleteAsk: the dialog a chat's Delete opens", () => {
  assert.deepEqual(deleteAsk({}, "Notes", "This computer"), { title: "Delete Notes?", body: "Its history is removed. This can't be undone.", action: "Delete", local: false });
  assert.deepEqual(deleteAsk(R, "Notes", "Studio"), { title: "Delete Notes?", body: "Its history is removed on Studio. This can't be undone.", action: "Delete", local: false });
  assert.deepEqual(deleteAsk({ ...R, gone: true }, "Notes", "Studio"),
    { title: "Remove Notes from this sidebar?", body: "This chat is no longer on Studio.", action: REMOVE_ONLY, local: true });
});

test("deleteRefused: what follows a refused delete", () => {
  assert.deepEqual(deleteRefused(R, "Notes", "Studio", new ApiError(503, "Studio is not connected.", true, "server_unreachable")), {
    title: "Remove Notes from this sidebar?",
    body: "Studio is not connected. The chat was not deleted. Removing it from this sidebar leaves the chat on Studio.",
    action: "Remove from this sidebar only", local: true,
  });
  assert.equal(deleteRefused(R, "Notes", "Studio", new ApiError(504, "Studio did not answer.", true, "no_answer")), null);
  assert.equal(deleteRefused(R, "Notes", "Studio", new ApiError(409, "the server is connected: delete the chat there", true, "server_connected")), null);
  assert.equal(deleteRefused({}, "Notes", "This computer", new ApiError(503, "x", true)), null);
  assert.equal(deleteRefused({ ...R, gone: true }, "Notes", "Studio", new ApiError(503, "x", true)), null);
});
