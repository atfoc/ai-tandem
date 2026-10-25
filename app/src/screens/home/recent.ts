// The two lists Home's search keeps on the device (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §6): the words searched
// for ("aiwb.search.recent", newest first, at most 8, no word twice whatever its case) and the boards and chats opened ("aiwb.search.opened",
// newest first, at most 10). The list helpers are pure; the kv is read once and written at each change, and a screen follows it through
// `useRecent` / `useOpened`.
import { useSyncExternalStore } from "react";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { getState, safeGet, safeSet, subscribe as onStore } from "@aiwb/core/state/store.ts";

const WORDS_KEY = "aiwb.search.recent", OPENED_KEY = "aiwb.search.opened";
export const MAX_WORDS = 8, MAX_OPENED = 10;

export type Opened = { key: string; kind: "board" | "chat" };

export function parseWords(saved: string | null): string[] {
  try {
    const v = JSON.parse(saved ?? "null");
    return Array.isArray(v) ? addWords([], ...[...v].reverse().filter((x): x is string => typeof x === "string")) : [];
  } catch { return []; }
}

export function parseOpened(saved: string | null): Opened[] {
  try {
    const v = JSON.parse(saved ?? "null");
    if (!Array.isArray(v)) return [];
    const ok = v.filter((o): o is Opened => !!o && typeof o.key === "string" && !!o.key && (o.kind === "board" || o.kind === "chat"));
    return ok.filter((o, i) => ok.findIndex((x) => x.key === o.key) === i).slice(0, MAX_OPENED).map(({ key, kind }) => ({ key, kind }));
  } catch { return []; }
}

/** `list` with each word put first, in the order given (the last is the newest): trimmed, an empty one left out, the same word of another case
 *  replaced by this one, at most MAX_WORDS. */
export function addWords(list: readonly string[], ...words: string[]): string[] {
  let out = [...list];
  for (const w of words) {
    const word = w.trim();
    if (word) out = [word, ...out.filter((x) => x.toLowerCase() !== word.toLowerCase())];
  }
  return out.slice(0, MAX_WORDS);
}

export const removeWord = (list: readonly string[], word: string): string[] => list.filter((x) => x.toLowerCase() !== word.trim().toLowerCase());

/** `list` with the thing first, nothing of its key twice, at most MAX_OPENED. */
export const addOpened = (list: readonly Opened[], o: Opened): Opened[] => [o, ...list.filter((x) => x.key !== o.key)].slice(0, MAX_OPENED);

let words: string[] | null = null, opened: Opened[] | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const getWords = (): string[] => (words ??= parseWords(safeGet(WORDS_KEY)));
const getOpened = (): Opened[] => (opened ??= parseOpened(safeGet(OPENED_KEY)));

const save = (key: string, value: unknown) => { safeSet(key, JSON.stringify(value)); emit(); };

/** Writes the word searched for (called when a result is opened). */
export function noteSearch(word: string): void {
  const next = addWords(getWords(), word);
  if (next.length === getWords().length && next.every((w, i) => w === getWords()[i])) return;
  save(WORDS_KEY, (words = next));
}

export function removeSearch(word: string): void { save(WORDS_KEY, (words = removeWord(getWords(), word))); }

export function clearSearches(): void {
  if (getWords().length > 0) save(WORDS_KEY, (words = []));
}

/** Writes a board or a chat that was opened (home/index.ts follows the selection and calls it). */
export function noteOpened(o: Opened): void { save(OPENED_KEY, (opened = addOpened(getOpened(), o))); }

/** Forgets the boards and chats of a server whose entry left the list. */
export function forgetOpenedOn(server: string): void {
  const next = getOpened().filter((o) => serverOfKey(o.key) !== server);
  if (next.length !== getOpened().length) save(OPENED_KEY, (opened = next));
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useRecent = (): string[] => useSyncExternalStore(subscribe, getWords, getWords);
export const useOpened = (): Opened[] => useSyncExternalStore(subscribe, getOpened, getOpened);

/** Forgets what was read from the kv (a test sets another kv). */
export function resetRecent(): void { words = null; opened = null; emit(); }

let watching = false;

/** Records what is opened from now on: each change of the selected board or chat to a thing, the chat when there is one, else the board. Called
 *  by Home once it is drawn (the store is read then, not at import: bootstrap gives the store its storage first, and a read before that would
 *  start it with no saved selection). What was selected when the app started is not "opened". Once is enough; later calls do nothing. */
export function watchOpened(): void {
  if (watching) return;
  watching = true;
  let seen = getState().sel;
  onStore(() => {
    const sel = getState().sel, prev = seen;
    seen = sel;
    if (sel.board === prev.board && sel.chat === prev.chat) return;
    const key = sel.chat ?? sel.board;
    if (key) noteOpened({ key, kind: sel.chat ? "chat" : "board" });
  });
}
