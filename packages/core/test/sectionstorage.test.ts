// What core writes into the browser's storage, as a list (plans/remote-server-sections-goal.md, 3.12, 3.13 and section 5 "Nothing on
// disk": "the browser's storage holds the collapse of 3.13 and what it holds today for any chat, and no content of a remote server").
// Every source file under packages/core/src is read: a write under a key that is not in the list, or by another way than the store's
// safeSet, fails here until it is judged and listed. This is the part of web/test/sectionstorage.test.ts that reads core alone; the part
// that reads the old page's own files stays there until the old page is retired, and the new build's files are read by
// app/test/storagescan.test.ts (plans/rn-rewrite/parity/webtest.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLLAPSE_KEY } from "../src/logic/sections.ts";
import { RECENT_KEY } from "../src/logic/serverlists.ts";
import { draftKey, legacyDraftKey } from "../src/logic/drafts.ts";
import { sourceNames, sourceOf } from "./fixtures/bundle.ts";

const text = Object.fromEntries(sourceNames().filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [f, sourceOf(f)]));
/** A file's code without its comments, so that a word in a sentence is no use of it. */
const code = (f: string) => text[f].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the page reaches the browser's storage through the store's four functions and the kv port alone (kv.ts), and has no other storage", () => {
  for (const f of Object.keys(text)) {
    const c = code(f);
    for (const word of ["sessionStorage", "indexedDB", "IndexedDB", "document.cookie", "caches.open", "navigator.storage", "showSaveFilePicker"]) assert.equal(c.includes(word), false, `${f} uses ${word}`);
    if (f !== "kv.ts") assert.equal(/\blocalStorage\b/.test(c), false, `${f} uses localStorage itself`);
  }
  // and the store reaches its kv through these four functions alone
  const kvUses = code("state/store.ts").split("\n").filter((l) => /\btheKv\(\)/.test(l)).map((l) => l.trim());
  assert.deepEqual(kvUses, [
    "export function safeGet(k: string) { try { return theKv().get(k); } catch { return null; } }",
    "export function safeSet(k: string, v: string) { try { theKv().set(k, v); } catch {} }",
    "export function safeRemove(k: string) { try { theKv().remove(k); } catch {} }",
    "const safeKeys = (): string[] => { try { return theKv().keys(); } catch { return []; } };",
  ]);
  for (const f of Object.keys(text)) if (f !== "state/store.ts" && f !== "state/ports.ts") assert.equal(/\btheKv\b/.test(code(f)), false, `${f} reaches the kv itself`);
});

test("every key the page writes, by the place that writes it: a setting, a key of a thing, or content of this computer's alone", () => {
  const writes: string[] = [];
  for (const f of Object.keys(text).sort()) for (const m of code(f).matchAll(/\bsafeSet\(([^,]+),/g)) if (m[1] !== "k: string") writes.push(`${f} ${m[1]}`);
  assert.deepEqual(writes, [
    "state/store.ts \"aiwb.sel\"",              // this computer's snapshot, the tree of a section (applySection) and an entry that left (dropServer) judge the selection
    "state/store.ts COLLAPSE_KEY",              // the collapse of 3.13: entry ids (and "local"), and the keys of groups
    "state/store.ts COLLAPSE_KEY",
    "state/store.ts \"aiwb.sel\"",
    "state/store.ts \"aiwb.sel\"",
    "state/store.ts COLLAPSE_KEY",
    "state/store.ts COLLAPSE_KEY",
    "state/store.ts \"aiwb.sel\"",
    "state/store.ts to",                        // an unsaved draft of before each branch had its own, under its branch's key: of this computer's chats (the snapshot's)
    "state/store.ts \"aiwb.lastChat\"",         // the chat a board reopens with: the board's key and the chat's key
  ]);
  assert.deepEqual([COLLAPSE_KEY, RECENT_KEY, draftKey("c", "b"), legacyDraftKey("c")], ["aiwb.collapsed", "aiwb.dirs", "aiwb.draft.c:b", "aiwb.draft.c"]);
});

test("the two keys that hold content are written for this computer's things alone: an unsaved draft and the recent folders", () => {
  const store = text["state/store.ts"];
  // an unsaved copy goes to the browser's storage or to the page's memory by the key of the chat it is of
  assert.ok(store.includes(`const copies = (of: string) => (inSection(of)
  ? { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => { memory.set(k, v); }, remove: (k: string) => { memory.delete(k); } }
  : { get: safeGet, set: safeSet, remove: safeRemove });`));
  assert.ok(store.includes("export const unsavedDraft = (chat: string, branch: string): Unsaved => unsavedAt(chat, draftKey(chat, branch), () => draftRevOf(chat, branch));"));
  // and nothing else writes a draft's key: the two functions above are the only users of the keys' makers that write
  for (const f of Object.keys(text)) {
    if (f === "state/store.ts" || f === "logic/drafts.ts" || f === "logic/draftsback.ts") continue;
    assert.equal(/\b(draftKey|legacyDraftKey)\(/.test(code(f)), false, `${f} makes a draft's key`);
  }
});

test("the board layer, the canvas, the uploads and the event layer write nothing to the browser's storage", () => {
  for (const f of ["state/uploads.ts", "state/chatdraft.ts", "state/conn.ts", "api.ts", "libraryapi.ts", "serversapi.ts"]) {
    assert.ok(f in text, f);
    assert.equal(/\bsafe(Set|Get|Remove)\b|\blocalStorage\b/.test(code(f)), false, `${f} reaches the browser's storage`);
  }
});
