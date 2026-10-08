// A board on another server: what a failed save does, what shows for the board, and the texts (src/logic/boardsave.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveFailure, saveOutage, notSaved, droppedText, DROPPED_TEXT, boardView, offText, takeoverText, serverNameOf } from "../src/logic/boardsave.ts";
import type { Board } from "../src/types.ts";

const local: Board = { id: "b_1", name: "Plan", group: "", created: "" };
const far: Board = { ...local, id: "b_2", server: "s_1" };

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

test("saveOutage: a 503 and a 504 of a board on another server raise the banner, nothing else does", () => {
  assert.equal(saveOutage(503, true), true);
  assert.equal(saveOutage(504, true), true);  // the link broke while the write was on its way: no_answer
  assert.equal(saveOutage(503, false), false); // a local board
  assert.equal(saveOutage(504, false), false);
  for (const status of [409, 413, 500, undefined]) assert.equal(saveOutage(status, true), false);
});

test("the banner and the notice", () => {
  assert.equal(notSaved("Studio"), "Not saved, Studio unreachable");
  assert.equal(droppedText(true, "Studio"), "This board was changed while Studio was unreachable. Your unsaved changes were dropped.");
  assert.equal(droppedText(false, "Studio"), DROPPED_TEXT);
  assert.equal(DROPPED_TEXT, "A change made here was not saved in time and was dropped.");
});

test("boardView: a local board is always its canvas", () => {
  for (const connected of [true, false]) for (const hasScene of [true, false]) {
    assert.equal(boardView(local, connected, hasScene), "canvas");
    assert.equal(boardView({ ...local, gone: true }, connected, hasScene), "canvas");
  }
});

test("boardView: a board on another server", () => {
  assert.equal(boardView(far, true, false), "canvas");       // it is read
  assert.equal(boardView(far, true, true), "canvas");
  assert.equal(boardView(far, false, true), "canvas");       // an outage: the scene kept here stays in use
  assert.equal(boardView(far, false, false), "unreachable"); // never loaded in this window
  for (const connected of [true, false]) for (const hasScene of [true, false])
    assert.equal(boardView({ ...far, gone: true }, connected, hasScene), "gone");
});

test("the view in place of the canvas", () => {
  assert.deepEqual(offText("unreachable", "Studio"),
    { title: "Studio is not connected", body: "This whiteboard is on Studio. It opens when the server is connected again." });
  assert.match(offText("gone", "Studio").title, /Studio/);
});

test("takeoverText: local and remote", () => {
  assert.deepEqual(takeoverText(local, "Studio"),
    { title: "Open in another window", body: "This whiteboard is in use in another tab or window. Only one can draw on it at a time." });
  assert.deepEqual(takeoverText(far, "Studio"),
    { title: "In use elsewhere", body: "This whiteboard is in use in another window or on Studio. Only one can draw on it at a time." });
});

test("serverNameOf: the entry's name", () => {
  const servers = [{ id: "local", name: "This computer" }, { id: "s_1", name: "Studio" }];
  assert.equal(serverNameOf(far, servers), "Studio");
  assert.equal(serverNameOf({ ...far, server: "s_9" }, servers), "the server");
});
