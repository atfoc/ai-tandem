// A new whiteboard's draft and its server choice (src/logic/boarddraft.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHOICE_TITLE, DRAFT_NAME, boardOptions, createError, hasRemote, type BoardDraft } from "../src/logic/boarddraft.ts";
import { LOCAL_ENTRY, stateLabel, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { ApiError } from "../src/api.ts";
import { LOCAL_SERVER } from "../src/types.ts";

const entry = (id: string, state: ServerState, name = "Studio"): ServerView => ({ id, name, state });
const ALL: ServerState[] = ["connecting", "connected", "unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed",
  "certificate_not_accepted", "name_not_known", "not_aiwb", "too_old", "another_server"];

test("the texts of the draft and the choice", () => {
  assert.equal(DRAFT_NAME, "Untitled");
  assert.equal(CHOICE_TITLE, "Where should this board live?");
  const d: BoardDraft = { group: "", busy: true, error: "x" };
  assert.deepEqual(Object.keys(d), ["group", "busy", "error"]);
});

test("hasRemote: only an entry besides this computer counts, whatever its state", () => {
  assert.equal(hasRemote([]), false);
  assert.equal(hasRemote([LOCAL_ENTRY]), false);
  assert.equal(hasRemote([{ id: LOCAL_SERVER, name: "This computer", state: "connected" }]), false); // the local entry without its flag
  for (const state of ALL) assert.equal(hasRemote([LOCAL_ENTRY, entry("s_1", state)]), true, state);
  assert.equal(hasRemote([entry("s_1", "unreachable")]), true);
});

test("boardOptions: this computer first, then every entry in the list's order", () => {
  assert.deepEqual(boardOptions([]), [{ id: LOCAL_SERVER, label: "This computer" }]);
  assert.deepEqual(boardOptions([LOCAL_ENTRY]), [{ id: LOCAL_SERVER, label: "This computer" }]);
  assert.deepEqual(boardOptions([entry("s_2", "connected", "Zed"), LOCAL_ENTRY, entry("s_1", "connected", "Attic")]), [
    { id: LOCAL_SERVER, label: "This computer" },
    { id: "s_2", label: "Zed" },
    { id: "s_1", label: "Attic" },
  ]);
});

test("boardOptions: every state other than connected is disabled with its label as the reason", () => {
  for (const state of ALL) {
    const [first, o, ...rest] = boardOptions([LOCAL_ENTRY, entry("s_1", state)]);
    assert.deepEqual(first, { id: LOCAL_SERVER, label: "This computer" }, state);
    assert.equal(rest.length, 0);
    if (state === "connected") assert.deepEqual(o, { id: "s_1", label: "Studio" });
    else assert.deepEqual(o, { id: "s_1", label: "Studio", disabled: true, reason: stateLabel(state) }, state);
  }
  // stricter than a chat's choice: a server that may come back by itself is disabled too
  assert.equal(boardOptions([entry("s_1", "unreachable")])[1].disabled, true);
  assert.equal(boardOptions([entry("s_1", "connecting")])[1].reason, stateLabel("connecting"));
});

test("createError: the answer's own sentence after the fixed text", () => {
  assert.equal(createError(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), "Couldn't create the whiteboard: Studio is not connected.");
  assert.equal(createError(new Error("Failed to fetch")), "Couldn't create the whiteboard: Failed to fetch");
  assert.equal(createError("no such group"), "Couldn't create the whiteboard: no such group");
  for (const e of [undefined, null, "", new Error(""), {}, 7]) assert.equal(createError(e), "Couldn't create the whiteboard");
});
