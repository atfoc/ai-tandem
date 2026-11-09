// Settings › Claude accounts (screens/settings/accounts/model.ts): the Settings row's line and the add/edit sheet's form.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Alias, AliasList } from "@aiwb/core/aliasesapi.ts";

import { accountsRowLine, formDirty, formOf, inputOf, withFolder } from "../src/screens/settings/accounts/model.ts";

const IMAGE = "aiwb/claude:dev";
const alias = (o: Partial<Alias> = {}): Alias => ({
  id: "a_work0001", name: "Claude · Work", mounts: ["/w"], created: "", kind: "claude:a_work0001", login: { known: true, loggedIn: false },
  container: { name: "aiwb-alias-a_work0001", state: "stopped" }, restartNeeded: false, pending: [], busy: 0, ...o,
});
const list = (aliases: Alias[], o: Partial<AliasList> = {}): AliasList => ({ docker: { ok: true }, defaultImage: IMAGE, host: { known: true, loggedIn: true }, aliases, ...o });

test("the Settings row counts the accounts, those that need a restart, and says when Docker cannot be used", () => {
  assert.deepEqual(accountsRowLine([]), { text: "No accounts", attention: false });
  assert.deepEqual(accountsRowLine([list([])]), { text: "No accounts", attention: false });
  assert.deepEqual(accountsRowLine([list([alias()])]), { text: "1 account", attention: false });
  assert.deepEqual(accountsRowLine([list([alias(), alias({ restartNeeded: true }), alias()])]), { text: "3 accounts · 1 needs a restart", attention: true });
  assert.deepEqual(accountsRowLine([list([alias({ restartNeeded: true }), alias({ restartNeeded: true })])]).text, "2 accounts · 2 need a restart");
  const down = list([alias()], { docker: { ok: false, kind: "not_running", reason: "Docker is not running" } });
  assert.deepEqual(accountsRowLine([list([alias(), alias()]), down]), { text: "3 accounts · Docker not running", attention: true });
  // (a server whose Docker is down but that has no account says nothing of it)
  assert.deepEqual(accountsRowLine([list([alias()]), list([], { docker: { ok: false, kind: "not_installed" } })]), { text: "1 account", attention: false });
});

test("a folder is put at the end of the list once", () => {
  assert.deepEqual(withFolder(["/a"], "/b"), ["/a", "/b"]);
  assert.deepEqual(withFolder(["/a", "/b"], "/b/"), ["/a", "/b"]);
  assert.deepEqual(withFolder(["/a"], "  "), ["/a"]);
});

test("the sheet starts from the account, or empty with the default image, and a prefilled folder makes it changed", () => {
  assert.deepEqual(formOf(undefined, list([])), { name: "", mounts: [], image: IMAGE });
  assert.deepEqual(formOf(alias(), list([])), { name: "Claude · Work", mounts: ["/w"], image: IMAGE });
  assert.deepEqual(formOf(alias({ image: "my/img:1" }), list([])), { name: "Claude · Work", mounts: ["/w"], image: "my/img:1" });
  const a = alias(), start = formOf(a, list([a])), pre = formOf(a, list([a]), "/notes");
  assert.deepEqual(pre.mounts, ["/w", "/notes"]);
  assert.equal(formDirty(pre, start), true);
  assert.equal(formDirty(formOf(a, list([a]), "/w/"), start), false);
  assert.deepEqual(formOf(undefined, list([]), "/notes").mounts, ["/notes"]);
});

test("the form is changed by a name, a folder or the image, not by blanks", () => {
  const start = { name: "Claude · Work", mounts: ["/w"], image: IMAGE };
  assert.equal(formDirty({ ...start }, start), false);
  assert.equal(formDirty({ ...start, name: "Claude · Work " }, start), false);
  assert.equal(formDirty({ ...start, mounts: ["/w", " "] }, start), false);
  assert.equal(formDirty({ ...start, name: "Work" }, start), true);
  assert.equal(formDirty({ ...start, mounts: [] }, start), true);
  assert.equal(formDirty({ ...start, image: "x" }, start), true);
});

test("Save sends the name trimmed, the folders without blanks, and an empty image for the default", () => {
  assert.deepEqual(inputOf({ name: " Claude · Work ", mounts: [" /w ", "", "/x"], image: IMAGE }, IMAGE), { name: "Claude · Work", mounts: ["/w", "/x"], image: "" });
  assert.deepEqual(inputOf({ name: "A", mounts: [], image: "  " }, IMAGE), { name: "A", mounts: [], image: "" });
  assert.deepEqual(inputOf({ name: "A", mounts: [], image: "my/img:2" }, IMAGE), { name: "A", mounts: [], image: "my/img:2" });
});
