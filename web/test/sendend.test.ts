import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SERVER_UNREACHABLE, putsBack, refusalShown, sentNothing, underComposer } from "../src/logic/sendend.ts";

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("refusalShown: a Send refused for a server not connected says so only while that server is not connected (the browser run T109)", () => {
  // the Send woke the connection, and the news of it was here before the refusal: nothing would take the sentence away
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, true), false);
  // still not connected: the sentence is shown, and goes when the server connects
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, false), true);
  // any other refusal is about something else than the connection
  assert.equal(refusalShown(503, "agent_unavailable", true), true);
  assert.equal(refusalShown(409, "busy", true), true);
  assert.equal(refusalShown(502, SERVER_UNREACHABLE, true), true); // (only the answer that tells that nothing was sent)
  assert.equal(refusalShown(undefined, undefined, true), true); // no answer: the network
  // a Send with no answer, a first message's too: the sentence that it is not known whether it arrived
  assert.equal(refusalShown(504, "send_unknown", true), true);
  assert.equal(refusalShown(504, "send_unknown", false), true);
});

test("sentNothing: a refusal below 500 took no message, and neither did the 503 of a server that is not connected; another 5xx may hide one that was taken", () => {
  assert.equal(SERVER_UNREACHABLE, "server_unreachable");
  // refused: the server removed no draft for it
  for (const [status, code] of [[400, undefined], [404, "not_found"], [404, "no_server"], [409, "busy"], [409, "stale"], [409, "image_missing"], [413, undefined], [429, "cap"], [499, undefined]] as const)
    assert.equal(sentNothing(status, code), true, `${status} ${code}`);
  // a chat of a section whose server is not connected, or too old: nothing was sent
  assert.equal(sentNothing(503, SERVER_UNREACHABLE), true);
  assert.equal(sentNothing(undefined, SERVER_UNREACHABLE), true, "by the code, whatever the status");
  // sent, and no answer came in time, or one that cannot be read: the message may have been taken
  for (const [status, code] of [[504, "send_unknown"], [504, "no_answer"], [502, "bad_answer"], [503, "agent_unavailable"], [503, undefined], [500, undefined]] as const)
    assert.equal(sentNothing(status, code), false, `${status} ${code}`);
  assert.equal(sentNothing(undefined), false, "no answer at all: the network");
  assert.equal(sentNothing(undefined, undefined), false);
});

test("the refusals of the move that carried a chat over to its server are gone with it", () => {
  const logic = source("logic/sendend.ts"), composer = source("Composer.tsx");
  for (const gone of ["NOT_MOVED", "MOVE_REFUSED", "not_moved", "move_refused", "moveError", "unmoved"]) {
    assert.ok(!logic.includes(gone), `logic/sendend.ts has ${gone}`);
    assert.ok(!composer.includes(gone), `Composer.tsx has ${gone}`);
  }
});

test("underComposer: the last refusal's sentence, else the chat's own error, and nothing else", () => {
  assert.equal(underComposer("Studio is not connected.", { status: "ready" }), "Studio is not connected.");
  assert.equal(underComposer("refused", { status: "error", error: "the agent stopped" }), "refused", "the refusal goes first");
  assert.equal(underComposer("", { status: "error", error: "the agent stopped" }), "the agent stopped");
  assert.equal(underComposer("", { status: "ready", error: "an error of before" }), "", "only while the chat is in that state");
  assert.equal(underComposer("", { status: "error" }), "");
  assert.equal(underComposer("", {}), "");
  // a view that still carried the sentence of a move that failed has no line for it
  assert.equal(underComposer("", { status: "ready", moveError: "Studio refused the chat." } as { status: string }), "");
  assert.ok(source("Composer.tsx").includes('const under = underComposer([err, up.error].filter(Boolean).join(" "), c);'));
});

test("putsBack: a failed Send's message goes back unless its draft was removed on the server meanwhile", () => {
  assert.equal(putsBack(false), true);
  assert.equal(putsBack(true), false); // another window sent that draft, or the Send was taken after all
});

test("the composer shows a refusal by refusalShown, and nothing stands in the thread's place for a message on its way", () => {
  const composer = source("Composer.tsx"), chatView = source("ChatView.tsx"), store = source("store.ts");
  for (const text of [composer, chatView, store]) assert.ok(!text.includes("startingAfter") && !text.includes("STARTING_LINGER") && !/\bstarting[:\[]/.test(text));
  // the server's state is read from the store as the answer is handled, not as the Send began
  assert.ok(composer.includes("if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) setErr("));
  assert.ok(composer.includes("if (putsBack(removed)) {"));
  // whether the saver is told that the message was not taken
  assert.ok(composer.includes("refused = e instanceof ApiError && sentNothing(e.status, e.code); // (a 5xx may hide a message that was taken)"));
});
