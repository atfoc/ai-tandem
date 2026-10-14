// What the page writes into the browser's storage, as a list (plans/remote-server-sections-goal.md, 3.12, 3.13 and
// section 5 "Nothing on disk": "the browser's storage holds the collapse of 3.13 and what it holds today for any
// chat, and no content of a remote server"). Every source file under web/src is read: a write under a key that is
// not in the list, or by another way than the store's safeSet, fails here until it is judged and listed.
// What each key holds for a thing of a section is shown by sectionstore.test.ts (a draft, the
// selection, the collapse, the recent folders), by saves.test.ts (a drawing) and, in a browser, by
// dev/checks/SEC.9-storage.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLLAPSE_KEY } from "../src/logic/sections.ts";
import { RECENT_KEY } from "../src/logic/serverlists.ts";
import { draftKey, legacyDraftKey } from "../src/logic/drafts.ts";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const text = Object.fromEntries(walk(src).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => [path.relative(src, f), fs.readFileSync(f, "utf8")]));
/** A file's code without its comments, so that a word in a sentence is no use of it. */
const code = (f: string) => text[f].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the page reaches the browser's storage through the store's four functions alone, and has no other storage", () => {
  for (const f of Object.keys(text)) {
    const c = code(f);
    for (const word of ["sessionStorage", "indexedDB", "IndexedDB", "document.cookie", "caches.open", "navigator.storage", "showSaveFilePicker"]) assert.equal(c.includes(word), false, `${f} uses ${word}`);
    if (f !== "store.ts") assert.equal(/\blocalStorage\b/.test(c), false, `${f} uses localStorage itself`);
  }
  const uses = code("store.ts").split("\n").filter((l) => /\blocalStorage\b/.test(l)).map((l) => l.trim());
  assert.deepEqual(uses, [
    "export function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }",
    "export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }",
    "export function safeRemove(k: string) { try { localStorage.removeItem(k); } catch {} }",
    "const safeKeys = (): string[] => { try { return Object.keys(localStorage); } catch { return []; } };",
  ]);
});

test("every key the page writes, by the place that writes it: a setting, a key of a thing, or content of this computer's alone", () => {
  const writes: string[] = [];
  for (const f of Object.keys(text).sort()) for (const m of code(f).matchAll(/\bsafeSet\(([^,]+),/g)) if (m[1] !== "k: string") writes.push(`${f} ${m[1]}`);
  assert.deepEqual(writes, [
    "Composer.tsx RECENT_KEY",            // this computer's recent folders: content, of this computer alone (below)
    "Resizer.tsx \"aiwb.widths\"",        // a setting
    "Sidebar.tsx \"aiwb.sel\"",           // what is selected: the keys of a board and a chat (entry id and id)
    "Sidebar.tsx \"aiwb.side\"",          // a setting
    "Sidebar.tsx \"aiwb.archived\"",      // a setting
    "store.ts \"aiwb.sel\"",              // this computer's snapshot, the tree of a section (applySection) and an entry that left (dropServer) judge the selection
    "store.ts COLLAPSE_KEY",              // the collapse of 3.13: entry ids (and "local"), and the keys of groups
    "store.ts COLLAPSE_KEY",
    "store.ts \"aiwb.sel\"",
    "store.ts \"aiwb.sel\"",
    "store.ts COLLAPSE_KEY",
    "store.ts COLLAPSE_KEY",
    "store.ts \"aiwb.sel\"",
    "store.ts to",                        // an unsaved draft of before each branch had its own, under its branch's key: of this computer's chats (the snapshot's)
    "store.ts \"aiwb.lastChat\"",         // the chat a board reopens with: the board's key and the chat's key
    "theme.ts \"aiwb.theme\"",            // a setting
  ]);
  assert.deepEqual([COLLAPSE_KEY, RECENT_KEY, draftKey("c", "b"), legacyDraftKey("c")], ["aiwb.collapsed", "aiwb.dirs", "aiwb.draft.c:b", "aiwb.draft.c"]);
});

test("the two keys that hold content are written for this computer's things alone: an unsaved draft and the recent folders", () => {
  const store = text["store.ts"];
  // an unsaved copy goes to the browser's storage or to the page's memory by the key of the chat it is of
  assert.ok(store.includes(`const copies = (of: string) => (inSection(of)
  ? { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => { memory.set(k, v); }, remove: (k: string) => { memory.delete(k); } }
  : { get: safeGet, set: safeSet, remove: safeRemove });`));
  assert.ok(store.includes("export const unsavedDraft = (chat: string, branch: string): Unsaved => unsavedAt(chat, draftKey(chat, branch), () => draftRevOf(chat, branch));"));
  // and nothing else writes a draft's key: the two functions above are the only users of the keys' makers that write
  for (const f of Object.keys(text)) {
    if (f === "store.ts" || f === "logic/drafts.ts" || f === "logic/draftsback.ts") continue;
    assert.equal(/\b(draftKey|legacyDraftKey)\(/.test(code(f)), false, `${f} makes a draft's key`);
  }
  // the recent folders of a section's server are in the page's memory
  assert.ok(text["Composer.tsx"].includes("if (server === LOCAL_SERVER) safeSet(RECENT_KEY, JSON.stringify(next)); else recentThere.set(server, next);"));
  assert.ok(text["Composer.tsx"].includes("(server === LOCAL_SERVER ? recentFrom(safeGet(RECENT_KEY)) : recentThere.get(server) ?? [])"));
});

test("the board layer, the canvas, the uploads and the event layer write nothing to the browser's storage", () => {
  for (const f of ["board.ts", "Canvas.tsx", "apply.ts", "uploads.ts", "chatdraft.ts", "conn.ts", "api.ts", "ComposerImages.tsx", "MessageImages.tsx", "Library.tsx", "libraryapi.ts", "serversapi.ts", "Servers.tsx"]) {
    assert.ok(f in text, f);
    assert.equal(/\bsafe(Set|Get|Remove)\b|\blocalStorage\b/.test(code(f)), false, `${f} reaches the browser's storage`);
  }
  // the canvas is given no library and no persistence of its own: what Excalidraw is asked to keep is nothing
  for (const word of ["useHandleLibrary", "LibraryIndexedDBAdapter", "onLibraryChange", "libraryReturnUrl"]) assert.equal(text["Canvas.tsx"].includes(word), false, word);
});
