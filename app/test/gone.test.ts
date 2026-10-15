// What went away with the records of remote things is in no file of the new build any more (plans/remote-server-sections-goal.md, section 5
// "What goes away is removed"; the contract's 3.2, 3.3, 3.8 and 3.10 "Goes away in the page"): every source file of app/src and of
// packages/core/src is read, so a name that comes back anywhere fails here. The old page's own files were read by web/test/sectiongone.test.ts
// (which stays until the old page is retired), core's alone by packages/core/test/sectiongone.test.ts; this is the new build's, whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = { app: path.join(here, "../src"), core: path.join(here, "../../packages/core/src") };
/** Every ts, tsx and css file of the new build by its path from its folder, with the folder in front ("app/screens/composer/Composer.tsx"). */
const text: Record<string, string> = {};
for (const [name, root] of Object.entries(roots)) {
  for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (/\.(ts|tsx|css)$/.test(f) && fs.statSync(path.join(root, f)).isFile()) text[`${name}/${f}`] = fs.readFileSync(path.join(root, f), "utf8");
  }
}
const having = (word: string | RegExp): string[] => Object.keys(text).filter((f) => (typeof word === "string" ? text[f].includes(word) : word.test(text[f])));

test("no file of the new build names a code the local server no longer sends", () => {
  assert.ok(Object.keys(text).length > 150, "the build was found");
  for (const code of ["gone_there", "not_moved", "move_refused", "image_remote", "no_lists", "remote_start", "start_unconfirmed", "server_unusable",
    "board_local", "rename_only", "group_refused", "board_refused", "id_taken"]) assert.deepEqual(having(code), [], code);
});

test("no file of the new build has an event, a field or a call that went away", () => {
  // the events
  for (const event of ["server_back", "chat_reload"]) assert.deepEqual(having(event), [], event);
  // the fields of a thing that was on another server, and what was said of the move
  for (const field of ["unmoved", "moveError", "MoveError", "remoteStart", "RemoteStart", "draftReplaced"]) assert.deepEqual(having(field), [], field);
  // the calls: a delete of the local record alone, the things of an entry counted, a draft replaced
  for (const call of ["local=1", "?local", "replace=", "/items`)"]) assert.deepEqual(having(call), [], call);
  assert.deepEqual(having(/servers\/[^`"']*\/items/), [], "GET /api/servers/{id}/items");
});

test("the views that went away are not there: the question about the place, the row of a thing that was gone, the removal from the sidebar alone", () => {
  const names = Object.keys(text).map((f) => path.basename(f));
  for (const file of ["BoardChoice.tsx", "boardchoice.css", "BoardTag.tsx", "boardrow.css", "boarddraft.ts"]) assert.equal(names.includes(file), false, file);
  for (const words of ["BoardChoice", "boarddraft", "Where should this live", "Remove from this sidebar", "this sidebar only", "noLongerOn", "menu-more", "remoteRow"]) assert.deepEqual(having(words), [], words);
  // a dialog's action has no other dialog to answer its refusal with (it was the removal of a chat from the sidebar alone)
  const confirm = text["app/screens/shell/ConfirmDialog.tsx"];
  assert.ok(confirm, "the confirm dialog was found");
  assert.equal(/refused\??:/.test(confirm), false);
  assert.equal(having(/\brefused\??:/).filter((f) => /ConfirmDialog|confirm/i.test(f)).length, 0);
  // a picker has its options and nothing under them (it was the "Servers…" of a server choice)
  const picker = text["app/screens/composer/Picker.tsx"];
  assert.ok(picker && picker.includes("onPick(o.id)"), "the picker's own body is what is read");
  assert.equal(/\bmore\b/.test(picker.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), false);
});
