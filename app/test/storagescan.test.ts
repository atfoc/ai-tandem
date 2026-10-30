// What the new build writes into the app's storage, as a list (plans/remote-server-sections-goal.md, 3.12, 3.13 and section 5 "Nothing on disk":
// "the browser's storage holds the collapse of 3.13 and what it holds today for any chat, and no content of a remote server"). Every source file of
// app/src and of packages/core/src is read: a write under a key that is not in the list, or by another way than the store's safeSet or the
// theme's kv key, fails here until it is judged and listed. The old page's files were read by web/test/sectionstorage.test.ts (which stays until
// the old page is retired), core's alone by packages/core/test/sectionstorage.test.ts; this is the new build's, whole. What each key holds for a
// thing of a section is shown by packages/core/test/sectionstore.test.ts and, in a browser, by web/dev/checks/SEC.9-storage.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COLLAPSE_KEY } from "@aiwb/core/logic/sections.ts";
import { RECENT_KEY } from "@aiwb/core/logic/serverlists.ts";
import { draftKey, legacyDraftKey } from "@aiwb/core/logic/drafts.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots = { app: path.join(here, "../src"), core: path.join(here, "../../packages/core/src") };
/** Every ts and tsx file of the new build by its path from its folder, with the folder in front ("app/screens/composer/recent.ts"). */
const text: Record<string, string> = {};
for (const [name, root] of Object.entries(roots)) {
  for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
    if (/\.tsx?$/.test(f) && fs.statSync(path.join(root, f)).isFile()) text[`${name}/${f}`] = fs.readFileSync(path.join(root, f), "utf8");
  }
}
/** A file's code without its comments, so that a word in a sentence is no use of it. */
const code = (f: string) => text[f].replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the page reaches the browser's storage through the store's four functions and the kv port alone (kv.ts), and has no other storage", () => {
  assert.ok(Object.keys(text).length > 150, "the build was found");
  for (const f of Object.keys(text)) {
    const c = code(f);
    for (const word of ["sessionStorage", "indexedDB", "IndexedDB", "document.cookie", "caches.open", "navigator.storage", "showSaveFilePicker"]) assert.equal(c.includes(word), false, `${f} uses ${word}`);
    if (f !== "app/platform/kv.web.ts") assert.equal(/\blocalStorage\b/.test(c), false, `${f} uses localStorage itself`);
  }
  // the app's kv on the web is the browser's storage, and nothing else is; on a phone it is MMKV, and the servers' list is the secure storage's, and so is voice's key (voice/platform/keystore.native.ts, test/voice.keystore.test.ts)
  const uses = code("app/platform/kv.web.ts").split("\n").filter((l) => /\blocalStorage\b/.test(l)).map((l) => l.trim());
  assert.deepEqual(uses, ['try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }']);
  for (const f of Object.keys(text)) if (/react-native-mmkv|expo-secure-store/.test(code(f))) assert.ok(["app/platform/kv.native.ts", "app/platform/serverstore.native.ts", "app/platform/serverstorecore.ts", "app/dev/StorageProbe.tsx", "app/voice/platform/keystore.native.ts"].includes(f), `${f} reaches the native storage itself`);
  // (the device test's probe, V4: a development build with EXPO_PUBLIC_AIWB_PROBE=1 alone; it reads the storage and writes nothing to it)
  assert.ok(code("app/App.tsx").includes('const probe = __DEV__ && process.env.EXPO_PUBLIC_AIWB_PROBE === "1";'));
  assert.equal(/\.(set|remove|delete|clearAll|recrypt)\w*\(|setItem|deleteItem/.test(code("app/dev/StorageProbe.tsx")), false, "the probe writes to the storage");
  // and the store reaches its kv through these four functions alone
  const kvUses = code("core/state/store.ts").split("\n").filter((l) => /\btheKv\(\)/.test(l)).map((l) => l.trim());
  assert.deepEqual(kvUses, [
    "export function safeGet(k: string) { try { return theKv().get(k); } catch { return null; } }",
    "export function safeSet(k: string, v: string) { try { theKv().set(k, v); } catch {} }",
    "export function safeRemove(k: string) { try { theKv().remove(k); } catch {} }",
    "const safeKeys = (): string[] => { try { return theKv().keys(); } catch { return []; } };",
  ]);
  for (const f of Object.keys(text)) if (f !== "core/state/store.ts" && f !== "core/state/ports.ts") assert.equal(/\btheKv\b/.test(code(f)), false, `${f} reaches the kv itself`);
});

test("every key the page writes, by the place that writes it: a setting, a key of a thing, or content of this computer's alone", () => {
  const writes: string[] = [];
  for (const f of Object.keys(text).sort()) {
    for (const m of code(f).matchAll(/\bsafeSet\(([^,]+),/g)) if (m[1] !== "k: string") writes.push(`${f} ${m[1]}`);
    if (f !== "app/platform/kv.web.ts" && f !== "app/platform/kv.native.ts") for (const m of code(f).matchAll(/\bkv\??\.set\(([^,]+),/g)) writes.push(`${f} ${m[1]}`);
  }
  assert.deepEqual(writes, [
    "app/platform/serverstorecore.ts PENDING_KEY",          // the app's list of servers (no secret in it: those are the secure storage's, test/serverstore.test.ts): the secrets still to delete,
    "app/platform/serverstorecore.ts LIST_KEY",             // the list itself,
    "app/platform/serverstorecore.ts name",                 // a list set aside under a name not taken yet (the key is made by the function),
    "app/platform/serverstorecore.ts CLIENT_ID_KEY",        // and the id of this client
    "app/screens/board/viewmemory.ts VIEWS_KEY",            // the phone's open view of a board: where each of the newest 50 was last looked at (numbers, by board key; B1)
    "app/screens/composer/recent.ts RECENT_KEY",            // this computer's recent folders: content, of this computer alone (below)
    "app/screens/home/recent.ts key",                       // Home's search (H2): the words searched for and the boards and chats opened, kept on the device (keys of this server's things)
    "app/screens/library/phone/promptrecent.ts PROMPT_RECENT_KEY", // this computer's recent prompts (their ids): of this computer alone, a remote server's are in memory
    "app/screens/shell/Pane.tsx \"aiwb.widths\"",           // a setting
    "app/screens/shell/homeplace.ts KEY",                   // the phone's Home place: the entry id of the server Home shows and the keys of the groups browsed
    "app/screens/shell/nav.ts \"aiwb.sel\"",                // what is selected: the keys of a board and a chat (entry id and id)
    "app/screens/shell/nav.ts \"aiwb.side\"",               // a setting
    "app/screens/sidebar/Foot.tsx \"aiwb.archived\"",       // a setting
    "app/screens/voice/pill/collapse.ts PILL_KEY",          // a setting: whether the board's voice pill is collapsed to the orb
    "app/state/editing.ts EDITING_KEY",                     // a setting: what Tab puts in a composer and the tab width
    "app/ui/theme.tsx THEME_KEY",                           // a setting
    "app/voice/engine/marks.ts MARKS_KEY",                  // the mic marks: which of this device's chat messages were sent by voice (chat keys, branches, item indexes)
    "app/voice/engine/state.ts SETTINGS_KEY",               // the voice settings (voice, models, speeds, Auto-send): settings, and never the ElevenLabs key
    "core/state/store.ts \"aiwb.sel\"",                     // this computer's snapshot, the tree of a section (applySection) and an entry that left (dropServer) judge the selection
    "core/state/store.ts COLLAPSE_KEY",                     // the collapse of 3.13: entry ids (and "local"), and the keys of groups
    "core/state/store.ts COLLAPSE_KEY",
    "core/state/store.ts \"aiwb.sel\"",
    "core/state/store.ts \"aiwb.sel\"",
    "core/state/store.ts COLLAPSE_KEY",
    "core/state/store.ts COLLAPSE_KEY",
    "core/state/store.ts \"aiwb.sel\"",
    "core/state/store.ts to",                               // an unsaved draft of before each branch had its own, under its branch's key: of this computer's chats (the snapshot's)
    "core/state/store.ts \"aiwb.lastChat\"",                // the chat a board reopens with: the board's key and the chat's key
  ]);
  assert.deepEqual([COLLAPSE_KEY, RECENT_KEY, draftKey("c", "b"), legacyDraftKey("c")], ["aiwb.collapsed", "aiwb.dirs", "aiwb.draft.c:b", "aiwb.draft.c"]);
});

test("the two keys that hold content are written for this computer's things alone: an unsaved draft and the recent folders", () => {
  const store = text["core/state/store.ts"];
  // an unsaved copy goes to the storage or to the page's memory by the key of the chat it is of
  assert.ok(store.includes(`const copies = (of: string) => (inSection(of)
  ? { get: (k: string) => memory.get(k) ?? null, set: (k: string, v: string) => { memory.set(k, v); }, remove: (k: string) => { memory.delete(k); } }
  : { get: safeGet, set: safeSet, remove: safeRemove });`));
  assert.ok(store.includes("export const unsavedDraft = (chat: string, branch: string): Unsaved => unsavedAt(chat, draftKey(chat, branch), () => draftRevOf(chat, branch));"));
  // and nothing else writes a draft's key: the two functions above are the only users of the keys' makers that write
  for (const f of Object.keys(text)) {
    if (f === "core/state/store.ts" || f === "core/logic/drafts.ts" || f === "core/logic/draftsback.ts") continue;
    assert.equal(/\b(draftKey|legacyDraftKey)\(/.test(code(f)), false, `${f} makes a draft's key`);
  }
  // the recent folders of a section's server are in the page's memory
  const recent = text["app/screens/composer/recent.ts"];
  assert.ok(recent.includes("if (server === LOCAL_SERVER) safeSet(RECENT_KEY, JSON.stringify(next)); else recentThere.set(server, next);"));
  assert.ok(recent.includes("(server === LOCAL_SERVER ? recentFrom(safeGet(RECENT_KEY)) : recentThere.get(server) ?? [])"));
});

test("the board layer, the canvas, the uploads and the event layer write nothing to the browser's storage", () => {
  const mine = (prefix: string) => Object.keys(text).filter((f) => f.startsWith(prefix));
  const board = [...mine("app/screens/board/"), ...mine("app/screens/composerimages/"), ...mine("app/screens/images/"), ...mine("app/screens/library/").filter((f) => f !== "app/screens/library/phone/promptrecent.ts"), ...mine("app/screens/servers/"), ...mine("core/board/")];
  assert.ok(board.length > 20, "the files were found");
  // (the phone's open view, viewmemory.ts, is the one place the board layer keeps something: numbers of a view, by board key)
  for (const f of ["core/state/uploads.ts", "core/state/chatdraft.ts", "core/state/conn.ts", "core/api.ts", "core/libraryapi.ts", "core/serversapi.ts", ...board.filter((f) => f !== "app/screens/board/viewmemory.ts")]) {
    assert.ok(f in text, f);
    assert.equal(/\bsafe(Set|Get|Remove)\b|\blocalStorage\b|\bkv\??\.(get|set|remove)\b/.test(code(f)), false, `${f} reaches the storage`);
  }
  // the canvas is given no library and no persistence of its own: what Excalidraw is asked to keep is nothing
  const view = fs.readdirSync(path.join(here, "../../packages/board-view/src"), { recursive: true }).filter((f) => /\.tsx?$/.test(String(f))).map((f) => fs.readFileSync(path.join(here, "../../packages/board-view/src", String(f)), "utf8")).join("\n");
  for (const word of ["useHandleLibrary", "LibraryIndexedDBAdapter", "onLibraryChange", "libraryReturnUrl"]) assert.equal(view.includes(word), false, word);
});
