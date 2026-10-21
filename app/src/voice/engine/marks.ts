// The mic marks as a store (architecture VC-23): which user messages this app sent by voice, kept in the kv (`aiwb.voice.spoken`) on this
// device only. The session notes a turn when it sends it (`noteSpoken`); the store then watches core's store, and when the turn's message
// arrives in its branch's list, marks it (`logic/marks.ts` decides which item that is). `useSpokenMark` of `../index.ts` reads it.
//
// The turn is noted with the words it sent; the message may carry more in front of them (the pill puts the board's selection tag before
// the words, as ⌘L does in a typed message), so both are compared without the reference tags they start with. The marks of a chat that
// is gone are pruned once the tree of its server is in (this computer's snapshot, or a section's tree), never before it: a section that
// has not connected yet does not lose its marks.
import { REF_SRC } from "@aiwb/core/logic/refs.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { getState, safeGet, safeSet, subscribe, threadAt } from "@aiwb/core/state/store.ts";
import type { State } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";
import { isMarked, MARKS_KEY, matchArrived, noteSent, parseMarks, prune, serialiseMarks } from "../logic/marks.ts";
import type { Marks, Pending } from "../logic/marks.ts";
import { createStore, onReset } from "./state.ts";

const LEADING_REFS = new RegExp(String.raw`^(?:\s*(?:${REF_SRC}))+`);

/** A message's text as a turn is compared by: without the reference tags it starts with, and without the spaces around it. */
export const turnWords = (text: string): string => text.replace(LEADING_REFS, "").trim();

/** Whether a user message's text is the text a turn sent. */
export const sameTurnText = (itemText: string, sent: string): boolean => turnWords(itemText) === turnWords(sent);

/** The marks; read from the kv when first asked for. */
export const marksStore = createStore<Marks>(() => parseMarks(safeGet(MARKS_KEY)));

let watching: (() => void) | null = null;
let lastChats: State["chats"] | null = null;

function save(next: Marks): void {
  const was = marksStore.get();
  if (next === was) return;
  if (next.marks !== was.marks) safeSet(MARKS_KEY, serialiseMarks(next)); // a storage that refuses: the marks hold for this run
  marksStore.set(next);
}

/** The chats whose marks may be kept: every chat that exists, and every chat of a server whose tree is not in yet. */
function pruned(m: Marks, s: State): Marks {
  const live = new Set(Object.keys(s.chats));
  for (const x of [...m.marks, ...m.pending]) {
    const server = serverOfKey(x.chat);
    const treeIn = server === LOCAL_SERVER ? s.connected : !!s.sections[server];
    if (!treeIn) live.add(x.chat);
  }
  return prune(m, live);
}

/** After a change of core's store: the noted turns that arrived are marked, and the marks of chats that are gone are dropped. */
function look(): void {
  const s = getState();
  let m = marksStore.get();
  if (s.chats !== lastChats) {
    lastChats = s.chats;
    m = pruned(m, s);
  }
  const seen = new Set<string>();
  for (const p of m.pending) {
    const k = branchKey(p.chat, p.branch);
    if (seen.has(k)) continue;
    seen.add(k);
    const items = threadAt(s, k)?.items;
    if (!items) continue;
    m = matchArrived(m, p.chat, p.branch, items.map((it) => (it.kind === "user" ? { kind: it.kind, text: turnWords(it.text ?? "") } : { kind: it.kind })));
  }
  save(m);
}

/** Watches core's store from the first use of the marks on (a mark shown, a turn noted); never at start-up. */
export function watchMarks(): void {
  if (watching) return;
  watching = subscribe(look);
  look();
}

/** A turn sent by voice: `before` is the branch's item count when it was sent, `text` the words it sent. */
export function noteSpoken(sent: Pending): void {
  watchMarks();
  save(noteSent(marksStore.get(), { ...sent, text: turnWords(sent.text) }));
  look();
}

/** Whether the item at `index` of the branch is a turn this device sent by voice. */
export const spokenMark = (chat: string, branch: string, index: number): boolean => isMarked(marksStore.get(), chat, branch, index);

onReset(() => {
  watching?.();
  watching = null;
  lastChats = null;
  marksStore.set(parseMarks(safeGet(MARKS_KEY)));
});
