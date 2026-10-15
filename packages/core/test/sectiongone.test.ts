// What went away with the records of remote things is in no file of core any more
// (plans/remote-server-sections-goal.md, section 5 "What goes away is removed"; the contract's 3.2, 3.3, 3.8 and 3.10 "Goes away in the page"):
// every source file under packages/core/src is read, so a name that comes back anywhere fails here. This is the part of
// web/test/sectiongone.test.ts that reads core alone; the part that reads the old page's own files stays there until the old page is
// retired, and the new build's files are read by app/test/gone.test.ts (plans/rn-rewrite/parity/webtest.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceNames, sourceOf } from "./fixtures/bundle.ts";

const text = Object.fromEntries(sourceNames().filter((f) => /\.(ts|tsx|css)$/.test(f)).map((f) => [f, sourceOf(f)]));
const having = (word: string | RegExp): string[] => Object.keys(text).filter((f) => (typeof word === "string" ? text[f].includes(word) : word.test(text[f])));

test("no file of the page names a code the local server no longer sends", () => {
  for (const code of ["gone_there", "not_moved", "move_refused", "image_remote", "no_lists", "remote_start", "start_unconfirmed", "server_unusable",
    "board_local", "rename_only", "group_refused", "board_refused", "id_taken"]) assert.deepEqual(having(code), [], code);
});

test("no file of the page has an event, a field or a call that went away", () => {
  // the events
  for (const event of ["server_back", "chat_reload"]) assert.deepEqual(having(event), [], event);
  // the fields of a thing that was on another server, and what was said of the move
  for (const field of ["unmoved", "moveError", "MoveError", "remoteStart", "RemoteStart", "draftReplaced"]) assert.deepEqual(having(field), [], field);
  // the calls: a delete of the local record alone, the things of an entry counted, a draft replaced
  for (const call of ["local=1", "?local", "replace=", "/items`)"]) assert.deepEqual(having(call), [], call);
  assert.deepEqual(having(/servers\/[^`"']*\/items/), [], "GET /api/servers/{id}/items");
});

test("no type of a thing names its server, or says that it is gone, not moved, started elsewhere or was something", () => {
  const types = text["types.ts"];
  for (const name of ["Group", "Board", "ChatMeta", "ChatView", "BranchState", "Draft", "GroupDefaults", "ServerDefaults", "Defaults"]) {
    const at = types.indexOf(`export type ${name} = `);
    assert.ok(at >= 0, name);
    const body = types.slice(at, types.indexOf("\n};", at));
    for (const field of ["server", "gone", "unmoved", "moveError", "start", "was", "client", "origin"]) assert.equal(new RegExp(`^\\s+${field}\\??:`, "m").test(body), false, `${name}.${field}`);
  }
  // what a group remembers for new chats is one server's own: the key "local" alone, and no sticky server
  assert.ok(types.includes("servers?: Record<string, ServerDefaults>; // the key LOCAL_SERVER alone: in a section's defaults it means that server"));
});

