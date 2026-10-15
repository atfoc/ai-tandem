// A board of a section: what a failed save does, what shows for the board, and the texts (src/logic/boardsave.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveFailure, saveOutage, saveRefusal, notSaved, notSavedYet, bannerText, droppedText, DROPPED_TEXT, boardView, offText, takeoverText, serverNameOf } from "../src/logic/boardsave.ts";
import { inSection, keyOn } from "../src/logic/keys.ts";

/** The board b_1 of this computer, and the board with the same id of the section s_1. */
const LOCAL = "b_1", FAR = keyOn("s_1", "b_1");

test("saveFailure: only a refusal drops the edit", () => {
  assert.equal(saveFailure(409, "stale"), "drop");
  assert.equal(saveFailure(409, "not_holder"), "drop");
  assert.equal(saveFailure(503, "server_unreachable"), "keep");
  assert.equal(saveFailure(503, "not_held_there"), "keep");
  assert.equal(saveFailure(504, "no_answer"), "keep");
  assert.equal(saveFailure(413, "too_large"), "keep");
  assert.equal(saveFailure(500, undefined), "keep");
  assert.equal(saveFailure(undefined, undefined), "keep"); // no answer at all
});

test("saveOutage: a 503 and a 504 of a board raise the banner, this computer's included, nothing else does", () => {
  assert.equal(saveOutage(503), true);
  assert.equal(saveOutage(504), true);  // the link broke while the write was on its way: no_answer
  for (const status of [409, 413, 500, undefined]) assert.equal(saveOutage(status), false);
});

test("a save answered 503 not_held_there (the board is being taken again on its server) is \"not yet\": the edit is kept under the banner, which does not say that the server is unreachable", () => {
  assert.equal(saveFailure(503, "not_held_there"), "keep"); // never a lost edit
  assert.equal(saveOutage(503), true);                       // the banner: the edit waits for the board's server
  assert.equal(bannerText("Studio", true), "Not saved yet, waiting for Studio"); // that server is connected: the held event that follows saves or drops by the revision
  assert.equal(bannerText("Studio", false), notSaved("Studio"));
  assert.equal(notSavedYet("Studio"), "Not saved yet, waiting for Studio");
});

test("a save of a board that is refused for another reason than an outage (413 too_large, 502 bad_answer): the edit is kept, and the canvas says the server's sentence", () => {
  assert.equal(saveFailure(413, "too_large"), "keep");
  assert.equal(saveOutage(413), false, "it is no outage: waiting does not mend it");
  assert.equal(saveRefusal(413, "too_large", "the drawing is larger than 128 MB"), "Not saved: the drawing is larger than 128 MB");
  assert.equal(saveRefusal(502, "bad_answer", "Studio gave an answer that cannot be read."), "Not saved: Studio gave an answer that cannot be read.");
  assert.equal(saveRefusal(404, "not_found", "no such board"), "Not saved: no such board");
  // an outage has its own banner, a dropped edit its notice, and a page with no stream its own sentence elsewhere; no answer, or one with no sentence, says nothing
  for (const [status, code] of [[503, "server_unreachable"], [503, "not_held_there"], [504, "no_answer"], [409, "stale"], [409, "not_holder"], [undefined, undefined]] as const)
    assert.equal(saveRefusal(status, code, "x"), "", `${status} ${code}`);
  assert.equal(saveRefusal(500, undefined, "Internal Server Error", false), "", "a status line is no sentence of the server's");
});

test("the banner and the notice", () => {
  assert.equal(notSaved("Studio"), "Not saved, Studio unreachable");
  assert.equal(droppedText(true, "Studio"), "This board was changed while Studio was unreachable. Your unsaved changes were dropped.");
  assert.equal(droppedText(false, "Studio"), DROPPED_TEXT);
  assert.equal(DROPPED_TEXT, "A change made here was not saved in time and was dropped.");
});

test("boardView: a board of this computer is judged as any other", () => {
  assert.equal(inSection(LOCAL), false);
  assert.equal(boardView({ connected: false }, false), "unreachable");
  assert.equal(boardView({ connected: false }, true), "canvas");
  assert.equal(boardView({ connected: true, gone: true }, true), "gone");
});

test("boardView: a board of a section", () => {
  assert.equal(inSection(FAR), true);
  const up = { connected: true }, down = { connected: false };
  assert.equal(boardView(up, false), "canvas");       // it is read
  assert.equal(boardView(up, true), "canvas");
  assert.equal(boardView(down, true), "canvas");       // an outage: the scene kept here stays in use, and can still be drawn on
  assert.equal(boardView(down, false), "unreachable"); // never loaded in this window: a board that is not open cannot be opened
  assert.equal(boardView({ ...up, gone: false }, false), "canvas");
  for (const connected of [true, false]) for (const hasScene of [true, false])
    assert.equal(boardView({ connected, gone: true }, hasScene), "gone");
});

test("the view in place of the canvas", () => {
  assert.deepEqual(offText("unreachable", "Studio"),
    { title: "Studio is not connected", body: "This whiteboard is on Studio. It opens when the server is connected again." });
  assert.deepEqual(offText("gone", "Studio"), { title: "No longer on Studio", body: "This whiteboard was on Studio and is not there any more." });
});

test("takeoverText: a local board, and a board of a section, which another computer that uses that server may hold", () => {
  assert.deepEqual(takeoverText(false, "Studio"),
    { title: "Open in another window", body: "This whiteboard is in use in another tab or window. Only one can draw on it at a time." });
  assert.deepEqual(takeoverText(inSection(LOCAL), "This computer"),
    { title: "Open in another window", body: "This whiteboard is in use in another tab or window. Only one can draw on it at a time." });
  assert.deepEqual(takeoverText(true, "Studio"),
    { title: "In use elsewhere", body: "This whiteboard is in use in another window or on Studio. Only one can draw on it at a time." });
  assert.deepEqual(takeoverText(inSection(FAR), "Studio"), takeoverText(true, "Studio"));
});

test("serverNameOf: the name of the entry the board's key names", () => {
  const servers = [{ id: "local", name: "This computer" }, { id: "s_1", name: "Studio" }];
  assert.equal(serverNameOf(FAR, servers), "Studio");
  assert.equal(serverNameOf("s_1~b_9", servers), "Studio");
  assert.equal(serverNameOf(LOCAL, servers), "This computer", "the same id on this computer");
  assert.equal(serverNameOf(keyOn("s_9", "b_1"), servers), "the server", "an entry the list no longer has");
  assert.equal(serverNameOf(undefined, servers), "This computer");
  assert.equal(serverNameOf(FAR, []), "the server");
});
