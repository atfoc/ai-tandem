// What went away with the records of remote things is in no file of the page any more
// (plans/remote-server-sections-goal.md, section 5 "What goes away is removed"; the contract's 3.2,
// 3.3, 3.8 and 3.10 "Goes away in the page"): every source file under web/src is read, so a name
// that comes back anywhere fails here. What stays for this computer's things is not in the lists.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const files = walk(src).filter((f) => /\.(ts|tsx|css)$/.test(f));
const text = Object.fromEntries(files.map((f) => [path.relative(src, f), fs.readFileSync(f, "utf8")]));
const having = (word: string | RegExp): string[] => Object.keys(text).filter((f) => (typeof word === "string" ? text[f].includes(word) : word.test(text[f])));

test("no file of the page names a code the local server no longer sends", () => {
  for (const code of ["gone_there", "not_moved", "move_refused", "image_remote", "no_lists", "remote_start", "run_not_started", "start_unconfirmed", "server_unusable",
    "runs_unsupported", "run_has_chats", "board_local", "rename_only", "group_refused", "board_refused", "id_taken"]) assert.deepEqual(having(code), [], code);
});

test("no file of the page has an event, a field or a call that went away", () => {
  // the events
  for (const event of ["server_back", "chat_reload"]) assert.deepEqual(having(event), [], event);
  // the fields of a thing that was on another server, and what was said of the move
  for (const field of ["unmoved", "moveError", "MoveError", "remoteStart", "RemoteStart", "draftReplaced"]) assert.deepEqual(having(field), [], field);
  // the calls: a delete of the local record alone, the things of an entry counted, a draft replaced, the check and the start call of a run
  for (const call of ["local=1", "?local", "replace=", "runs/check", "/items`)"]) assert.deepEqual(having(call), [], call);
  assert.deepEqual(having(/servers\/[^`"']*\/items/), [], "GET /api/servers/{id}/items");
  // (a run is started with POST …/start; the only PUT of a run is the goal being typed)
  const puts = [...text["api.ts"].matchAll(/call(?:<[^>]*>)?\("PUT", `\$\{pathOf\("runs", \w+\)\}([^`?]*)/g)].map((m) => m[1]);
  assert.deepEqual(puts, ["/draft"]);
  assert.ok(text["api.ts"].includes('startRun: (id: string, goal: string) => call<RunView>("POST", `${pathOf("runs", id)}/start`, { goal })'));
});

test("the views that went away are not there: the question about the place, the row of a thing that was gone, the removal from the sidebar alone", () => {
  for (const file of ["BoardChoice.tsx", "boardchoice.css", "BoardTag.tsx", "boardrow.css", "logic/boarddraft.ts"]) assert.equal(file in text, false, file);
  for (const words of ["BoardChoice", "boarddraft", "Where should this live", "Remove from this sidebar", "this sidebar only", "noLongerOn", "menu-more", "remoteRow"]) assert.deepEqual(having(words), [], words);
  // a dialog's action has no other dialog to answer its refusal with (it was the removal of a chat from the sidebar alone)
  assert.equal(/refused\??:/.test(text["Dialogs.tsx"]), false);
  // a picker has its options and nothing under them (it was the "Servers…" of the server choice of a run that had not started)
  const composer = text["Composer.tsx"], picker = composer.indexOf("export function Picker(");
  const body = composer.slice(picker, composer.indexOf("\nexport ", picker + 1));
  assert.ok(picker >= 0 && body.includes("onPick(o.id)"), "the picker's own body is what is read");
  assert.equal(/\bmore\b/.test(body), false);
});

test("no type of a thing names its server, or says that it is gone, not moved, started elsewhere or was something", () => {
  const types = text["types.ts"];
  for (const name of ["Group", "Board", "ChatMeta", "ChatView", "BranchState", "RunView", "Draft", "GroupDefaults", "ServerDefaults", "Defaults"]) {
    const at = types.indexOf(`export type ${name} = `);
    assert.ok(at >= 0, name);
    const body = types.slice(at, types.indexOf("\n};", at));
    for (const field of ["server", "gone", "unmoved", "moveError", "start", "was", "client", "origin"]) assert.equal(new RegExp(`^\\s+${field}\\??:`, "m").test(body), false, `${name}.${field}`);
  }
  // what a group remembers for new chats is one server's own: the key "local" alone, and no sticky server
  assert.ok(types.includes("servers?: Record<string, ServerDefaults>; // the key LOCAL_SERVER alone: in a section's defaults it means that server"));
});
