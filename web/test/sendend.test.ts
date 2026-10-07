import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SERVER_UNREACHABLE, putsBack, refusalShown, startingAfter } from "../src/logic/sendend.ts";
import { FIRST_TEXT_KEPT } from "../src/logic/chatserver.ts";

const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

test("refusalShown: a Send refused for a server not connected says so only while that server is not connected (the browser run T109)", () => {
  // the Send woke the connection, and the news of it was here before the refusal: nothing would take the sentence away
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, true), false);
  // still not connected: the sentence is shown, and goes when the server connects
  assert.equal(refusalShown(503, SERVER_UNREACHABLE, false), true);
  // any other refusal is about something else than the connection
  assert.equal(refusalShown(503, "agent_unavailable", true), true);
  assert.equal(refusalShown(409, "busy", true), true);
  assert.equal(refusalShown(409, FIRST_TEXT_KEPT, true), true);
  assert.equal(refusalShown(502, SERVER_UNREACHABLE, true), true); // (only the answer that tells that nothing was sent)
  assert.equal(refusalShown(undefined, undefined, true), true); // no answer: the network
  // a first message with no answer has its own line (errShown)
  assert.equal(refusalShown(504, "start_unconfirmed", true), false);
  assert.equal(refusalShown(504, "start_unconfirmed", false), false);
});

test("putsBack: a failed Send's message goes back unless its draft was removed on the server meanwhile; a kept first text always does", () => {
  assert.equal(putsBack(false), true);
  assert.equal(putsBack(false, "busy"), true);
  assert.equal(putsBack(true), false); // another window sent that draft, or the Send was taken after all
  assert.equal(putsBack(true, "busy"), false);
  assert.equal(putsBack(true, FIRST_TEXT_KEPT), true); // the removal is the one of the chat's start with an earlier text
  assert.equal(putsBack(false, FIRST_TEXT_KEPT), true);
});

test("startingAfter: a first message's text stays in the thread's place only after a call that was taken, until the thread has items", () => {
  assert.equal(startingAfter(true, false), true); // taken: until the thread read again has the message
  assert.equal(startingAfter(true, true), false); // the thread has it
  assert.equal(startingAfter(false, false), false); // refused or failed: the text is in the composer again
  assert.equal(startingAfter(false, true), false);
});

test("the composer and the thread clear the text of a first message by startingAfter, and the composer shows a refusal by refusalShown", () => {
  const composer = source("Composer.tsx"), chatView = source("ChatView.tsx");
  assert.ok(composer.includes("        if (!startingAfter(taken, !!threadOf(getState(), chatId)?.items.length)) setStarting(chatId, null);\n        else setTimeout(() => { if (getState().starting[chatId] === t) setStarting(chatId, null); }, STARTING_LINGER);"));
  assert.ok(chatView.includes("useEffect(() => { if (starting !== undefined && !startingAfter(true, !!all.length)) setStarting(chatId, null); }, [starting, chatId, !all.length]);"));
  // the server's state is read from the store as the answer is handled, not as the Send began
  assert.ok(composer.includes("if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) { errKept.current = errStays(code); setErr("));
});
