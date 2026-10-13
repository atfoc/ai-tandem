// The sections of the sidebar: one per remote server of the server list, under the local part.
// A section's head takes its name and its state from the list's entry; its rows are drawn from
// the server's tree, which the local server holds while that server is connected (the snapshot's
// `sections` and the `section` event) and from nothing else. Here are the rules, with no DOM:
// what a section says, what the store holds of a section when its tree comes and goes, what stays
// on screen without a tree, and the collapse the browser keeps.
import { LOCAL_SERVER, type Board, type BranchState, type ChatView, type Defaults, type Group } from "../types.ts";
import { inSection, serverOfKey } from "./keys.ts";
import { branchKey, chatOfKey } from "./branches.ts";
import { stateLabel, type ServerView } from "./servers.ts";
import type { Sel } from "./sel.ts";

/** What the store keeps of a section's tree besides its things, which are in the store's own maps under their keys:
 *  the groups in that server's order (never with `collapsed`), and what that server remembers per group. */
export type Section = { groups: Group[]; defaults: Defaults };

/** A server's tree with the page's keys (logic/sectionwire.ts treeIn). */
export type KeyedTree = { groups: Group[]; boards: Board[]; chats: ChatView[]; states: BranchState[]; defaults: Defaults };

/** The entries that get a section, in the order of the server list: every one but this computer's. */
export const sectionEntries = (servers: readonly ServerView[]): ServerView[] => servers.filter((v) => !v.local && v.id !== LOCAL_SERVER);

// ---- what a section says

export const SECTION_CONNECTING = "Connecting…";
/** The one line of a section whose server is not connected. */
export const SECTION_AWAY = "Its chats show when the server is back.";
export const SECTION_EMPTY = "Nothing on this server yet.";
/** The line of a connected server whose things are all archived, while archived things are not shown. */
export const SECTION_ARCHIVED = "Only archived things on this server.";

/** The server list's words for a state as a section says them. The head is one narrow line: of words with a colon
 *  ("Too old: update the server on that machine") it has what stands before it, and the rest is a line of the body. */
function stateWords(state: ServerView["state"]): { head: string; rest: string } {
  const label = stateLabel(state), at = label.indexOf(": ");
  if (at < 0) return { head: label, rest: "" };
  const rest = label.slice(at + 2);
  return { head: label.slice(0, at), rest: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}.` };
}

/** What a section shows.
 *  state: the words after the name, the server list's own for the entry's state (stateWords).
 *  tone: "ok" connected with its tree, "wait" connecting, "bad" every other state.
 *  rows: the tree is drawn (the local server holds it). Rows are decided by the tree and words by the state: the two
 *    come in separate events, in no fixed order.
 *  lines: what the body says in the place of rows, or under them: for a server that is too old that it must be
 *    updated on that machine, and the version it reports; else the one line of a server that is not connected; with
 *    a tree that holds nothing, that it is empty; with a tree that shows nothing because all it holds is archived
 *    (archived: "Show archived" is off and would show something), that. A section that is connecting says so in its
 *    head alone.
 *  add: the head's "+" shows: things can be made on that server. */
export type SectionView = { state: string; tone: "ok" | "wait" | "bad"; rows: boolean; lines: string[]; add: boolean };

export function sectionView(v: Pick<ServerView, "state" | "version">, hasTree: boolean, empty: boolean, archived = false): SectionView {
  const waiting = v.state === "connecting" || (v.state === "connected" && !hasTree);
  const words = stateWords(v.state);
  const state = waiting ? SECTION_CONNECTING : words.head;
  const tone = waiting ? "wait" : v.state === "connected" ? "ok" : "bad";
  if (hasTree) return { state, tone, rows: true, lines: empty ? [archived ? SECTION_ARCHIVED : SECTION_EMPTY] : [], add: true };
  if (waiting) return { state, tone, rows: false, lines: [], add: false };
  if (v.state === "too_old") return { state, tone, rows: false, lines: [words.rest, ...(v.version ? [`Version ${v.version}`] : [])], add: false };
  return { state, tone, rows: false, lines: [SECTION_AWAY], add: false };
}

// ---- the things of one server

/** The entries of a map by key that are on one server. */
export function thingsOn<V>(map: Record<string, V>, server: string): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k in map) if (serverOfKey(k) === server) out[k] = map[k];
  return out;
}

// ---- what the store holds of a section

/** What these rules read and write of the store. */
export type Things = {
  sections: Record<string, Section>;
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;
  states: Record<string, BranchState>; // by branch key
  gone: Record<string, true>;
  sel: Sel;
};

/** Whether a thing is on screen: the board or the chat that is selected. */
export const onScreen = (s: Pick<Things, "sel">, key: string): boolean => key === s.sel.board || key === s.sel.chat;

const byId = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

/** A server's tree arrives (tree), or the local server holds none of it any more (null).
 *
 *  With a tree: it replaces everything the store had of that server. What is on screen and is not in the new tree
 *  stays, marked gone: the view says that it is no longer on that server, and no row is drawn for it.
 *
 *  With none: nothing of that server is known any more, and its section draws no row. What is on screen stays as the
 *  page has it, from the page's memory: an open chat read-only under a warning, an open board
 *  still drawn on. So does a board whose edit waits to be saved (unsaved), on screen or not: the drawing is in this
 *  window alone, and is saved or dropped by its revision when the server is back.
 *
 *  left: the keys of the boards and chats that went, whose threads and scenes the caller drops. */
export function withSection<S extends Things>(s: S, server: string, tree: KeyedTree | null, unsaved: (board: string) => boolean = () => false):
  { next: Pick<S, "sections" | "boards" | "chats" | "states" | "gone">; left: string[] } {
  const on = (key: string) => serverOfKey(key) === server;
  const boards = byId(tree?.boards ?? []);
  const chats = byId((tree?.chats ?? []).filter((c) => !c.run)); // (a server that still has runs: their chats are not kept)
  const left: string[] = [];
  const gone = { ...s.gone };
  /** One of the store's maps after the change: the other servers' as they are, this server's from the tree, and of
   *  what it had before what stays (stays). With a tree, what stays is no longer on its server. */
  const merge = <V,>(had: Record<string, V>, got: Record<string, V>, stays: (key: string) => boolean): Record<string, V> => {
    const out: Record<string, V> = {};
    for (const k in had) {
      if (!on(k)) out[k] = had[k];
      else if (k in got) delete gone[k];
      else if (stays(k)) { out[k] = had[k]; if (tree) gone[k] = true; }
      else { left.push(k); delete gone[k]; }
    }
    return Object.assign(out, got);
  };
  const nextBoards = merge(s.boards, boards, (k) => onScreen(s, k) || (!tree && unsaved(k)));
  const nextChats = merge(s.chats, chats, (k) => onScreen(s, k));
  // The branch records: the tree's own, and those of the chats that stay.
  const states: Record<string, BranchState> = {};
  for (const k in s.states) {
    const chat = chatOfKey(k);
    if (!on(chat) || (nextChats[chat] && !chats[chat])) states[k] = s.states[k];
  }
  for (const st of tree?.states ?? []) if (st?.chat) states[branchKey(st.chat, st.branch)] = st;
  const sections = { ...s.sections };
  if (tree) sections[server] = { groups: tree.groups, defaults: tree.defaults }; else delete sections[server];
  return { next: { sections, boards: nextBoards, chats: nextChats, states, gone } as Pick<S, "sections" | "boards" | "chats" | "states" | "gone">, left };
}

/** The things of sections that are no longer kept once the user has left them: what is not on screen of a section
 *  the local server holds no tree of, or that is gone from its server. A board whose edit waits to be saved stays
 *  while its section has no tree. */
export function leftBehind(s: Things, unsaved: (board: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const stale = (key: string) => inSection(key) && (!s.sections[serverOfKey(key)] || !!s.gone[key]);
  for (const k in s.boards) if (stale(k) && !onScreen(s, k) && !(unsaved(k) && !s.sections[serverOfKey(k)])) out.push(k);
  for (const k in s.chats) if (stale(k) && !onScreen(s, k)) out.push(k);
  return out;
}

/** The entries that left the server list: the ids of the sections `before` had and `after` has not. Such a server
 *  was removed from the list (the Servers dialog), which is not an outage: it never comes back to bring a view
 *  level, or to take a draft or a drawing. */
export function entriesGone(before: readonly ServerView[], after: readonly ServerView[]): string[] {
  const now = new Set(sectionEntries(after).map((v) => v.id));
  return sectionEntries(before).map((v) => v.id).filter((id) => !now.has(id));
}

/** Everything the store has of one server (boards and chats, by key): what goes when that
 *  server's entry is removed from the list, what is on screen and a board with an unsaved edit too. */
export function thingsOf(s: Pick<Things, "boards" | "chats">, server: string): string[] {
  const out: string[] = [];
  if (server === LOCAL_SERVER) return out; // this computer is no entry that can be removed
  for (const m of [s.boards, s.chats]) for (const k in m) if (serverOfKey(k) === server) out.push(k);
  return out;
}

/** Whether a thing of a section can take a call now: the local server holds its server's tree, and the thing is
 *  still on that server. A thing of this computer always can. */
export const reachable = (s: Pick<Things, "sections" | "gone">, key: string): boolean => {
  const server = serverOfKey(key);
  return server === LOCAL_SERVER || (!!s.sections[server] && !s.gone[key]);
};

// ---- a change of a section's groups that is shown before its server answered

/** A rename or a move of a group is shown at once, before the call that makes it on the group's server is answered.
 *  shown: the list the page set for it; truth: the list that server told last, before every change that is still
 *  shown ahead of it. */
export type Ahead = { shown: Group[]; truth: Group[] };

/** A change shown ahead. had: the section's groups as the store has them; was: what was noted at the change before
 *  this one. While the store still has the list that one set, no word of the server came since, and its truth is
 *  this one's too. */
export const shownAhead = (had: Group[], was: Ahead | undefined, change: (groups: Group[]) => Group[]): Ahead =>
  ({ shown: change(had), truth: was && was.shown === had ? was.truth : had });

/** The call of a change shown ahead was refused, or its answer was lost (that server is not connected, did not
 *  answer, no longer has the group): the list to put back, which is what that server told last. null when the
 *  store's list (now) is no longer the one shown ahead: the server told its groups since (a `groups` event, a tree),
 *  and its word stands. A change that was made there after all, its answer lost, arrives the same way. */
export const putBack = (now: Group[] | undefined, was: Ahead | undefined): Group[] | null => (was && now === was.shown ? was.truth : null);

// ---- collapse: kept in the browser, per browser, and sent nowhere

/** The localStorage key of the collapse of the sections and of the groups inside them. */
export const COLLAPSE_KEY = "aiwb.collapsed";

/** What is collapsed, as stored: the entry ids of the collapsed sections and the keys of the collapsed groups of
 *  sections. Anything unreadable is nothing collapsed. */
export function parseCollapsed(raw: string | null | undefined): Record<string, true> {
  try {
    const v = JSON.parse(raw ?? "[]");
    if (!Array.isArray(v)) return {};
    return Object.fromEntries(v.filter((x): x is string => typeof x === "string" && !!x).map((k) => [k, true as const]));
  } catch { return {}; }
}

export const collapsedSaved = (c: Record<string, true>): string => JSON.stringify(Object.keys(c).sort());

/** The collapse with one section or group set; the map itself when nothing changes. */
export function withCollapsed(c: Record<string, true>, key: string, on: boolean): Record<string, true> {
  if (!!c[key] === on) return c;
  if (on) return { ...c, [key]: true };
  const { [key]: _, ...rest } = c;
  return rest;
}

/** The collapse without what no longer exists: a section whose entry left the server list, with its groups, and,
 *  for each server whose tree is held, a group that tree no longer has. The groups of a server whose tree is not
 *  held stay: they are not known now, and are collapsed again when the server is back. The map itself when nothing
 *  goes. */
export function prunedCollapsed(c: Record<string, true>, servers: readonly ServerView[], sections: Record<string, Section>): Record<string, true> {
  const entries = new Set(sectionEntries(servers).map((v) => v.id));
  const keys = Object.keys(c).filter((k) => {
    if (entries.has(k)) return true;                 // a section
    const server = serverOfKey(k);
    if (!entries.has(server)) return false;          // a group, or a section, of an entry that is gone
    const tree = sections[server];
    return !tree || tree.groups.some((g) => g.id === k);
  });
  return keys.length === Object.keys(c).length ? c : Object.fromEntries(keys.map((k) => [k, true as const]));
}
