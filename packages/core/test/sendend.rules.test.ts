// What the end of a Send leaves under a chat's composer and in its box (src/logic/sendend.ts, and status.ts for the re-read): the pure logic that
// Composer.tsx asks. The wiring on the new build is proved by the browser checks (web/dev/checks/L16: a Send put back, a refusal's sentence, a 409
// that reads the chat again; L23: a Send answered "not_found"). Ported from web/test/sendend.test.ts without the assertions that read the old page's
// source, which goes with the old page (C-TX-08, C-TX-09, C-CH-06, C-RO-09, C-RO-12, C-RO-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_UNREACHABLE, goneBySend, putsBack, refusalShown, sentNothing, underComposer } from "../src/logic/sendend.ts";
import { refreshAfterRefusal } from "../src/logic/status.ts";

test("refusalShown: a Send refused for a server not connected says so only while that server is not connected", () => {
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, true), false, "the Send woke the connection, and the news of it was here before the refusal");
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, false), true);
  assert.equal(refusalShown(503, "agent_unavailable", true), true);
  assert.equal(refusalShown(409, "busy", true), true);
  assert.equal(refusalShown(502, SERVER_UNREACHABLE, true), true, "only the answer that tells that nothing was sent");
  assert.equal(refusalShown(undefined, undefined, true), true, "no answer: the network");
  assert.equal(refusalShown(504, "send_unknown", true), true);
  assert.equal(refusalShown(504, "send_unknown", false), true);
});

test("sentNothing: a refusal below 500 took no message, and neither did the 503 of a server that is not connected; another 5xx may hide one that was taken", () => {
  assert.equal(SERVER_UNREACHABLE, "server_unreachable");
  for (const [status, code] of [[400, undefined], [404, "not_found"], [404, "no_server"], [409, "busy"], [409, "stale"], [409, "image_missing"], [413, undefined], [429, "cap"], [499, undefined]] as const)
    assert.equal(sentNothing(status, code), true, `${status} ${code}`);
  assert.equal(sentNothing(503, SERVER_UNREACHABLE), true);
  assert.equal(sentNothing(undefined, SERVER_UNREACHABLE), true, "by the code, whatever the status");
  for (const [status, code] of [[504, "send_unknown"], [504, "no_answer"], [502, "bad_answer"], [503, "agent_unavailable"], [503, undefined], [500, undefined]] as const)
    assert.equal(sentNothing(status, code), false, `${status} ${code}`);
  assert.equal(sentNothing(undefined), false, "no answer at all: the network");
});

test("goneBySend: only a 404 with the code not_found tells that the chat is no longer on its server", () => {
  assert.equal(goneBySend("not_found"), true);
  assert.equal(goneBySend("no_branch"), false, "a part of the chat is missing, not the chat");
  assert.equal(goneBySend("no_server"), false);
  assert.equal(goneBySend(undefined), false);
});

test("refreshAfterRefusal: a 409 reads the chat again, unless it is a refusal that leaves the message in the box", () => {
  assert.equal(refreshAfterRefusal(409, "busy"), true);
  assert.equal(refreshAfterRefusal(409, undefined), true, "the chat is archived: no code");
  for (const code of ["window", "agent_missing", "no_agent", "image_missing"]) assert.equal(refreshAfterRefusal(409, code), false, code);
  assert.equal(refreshAfterRefusal(429, "cap"), false);
  assert.equal(refreshAfterRefusal(404, "not_found"), false);
  assert.equal(refreshAfterRefusal(504, "send_unknown"), false);
});

test("underComposer: the last refusal's sentence, else the chat's own error, and nothing else", () => {
  assert.equal(underComposer("Studio is not connected.", { status: "ready" }), "Studio is not connected.");
  assert.equal(underComposer("refused", { status: "error", error: "the agent stopped" }), "refused", "the refusal goes first");
  assert.equal(underComposer("", { status: "error", error: "the agent stopped" }), "the agent stopped");
  assert.equal(underComposer("", { status: "ready", error: "an error of before" }), "", "only while the chat is in that state");
  assert.equal(underComposer("", { status: "error" }), "");
  assert.equal(underComposer("", {}), "");
});

test("putsBack: a failed Send's message goes back unless its draft was removed on the server meanwhile", () => {
  assert.equal(putsBack(false), true);
  assert.equal(putsBack(true), false, "another window sent that draft, or the Send was taken after all");
});
