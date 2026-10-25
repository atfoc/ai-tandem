// What the library popup and the insert popup (Library.tsx) show of the libraries the page holds
// (logic/library.ts): their order, the tree of each, the rows of the tree that are on screen, the
// place a new item is made in and the places an item can be moved to, what the editor holds
// against what is saved, and the questions asked before something is deleted or left. The search
// itself is logic/promptsearch.ts. DOM-free.

import { LIBRARY_LIMITS, type LibraryGroup, type LibraryPrompt, type LibraryView } from "./library.ts";
import { PATH_SEP, byPromptName, searchPrompts, type PromptHit } from "./promptsearch.ts";

const LOCAL = "local";

/** The libraries as both popups show them: this computer's first, then those of the servers in the
 *  order of the server list. One whose server the list does not have (its event came before the
 *  list's) is at the end. */
export function orderLibraries(libs: LibraryView[], servers: { id: string }[]): LibraryView[] {
  const at = (v: LibraryView) => { if (v.server === LOCAL) return -1; const i = servers.findIndex((s) => s.id === v.server); return i < 0 ? servers.length : i; };
  return libs.map((v, i) => ({ v, i })).sort((a, b) => at(a.v) - at(b.v) || a.i - b.i).map((x) => x.v);
}

/** A group with what is in it, groups before prompts and both by name. */
export type GroupNode = { id: string; name: string; groups: GroupNode[]; prompts: LibraryPrompt[] };
/** One server's library as a tree; the search takes it as it is (promptsearch.ts PromptLibrary). */
export type LibraryTree = { server: string; name: string; connected: boolean; groups: GroupNode[]; prompts: LibraryPrompt[] };

/** The tree of a library, from its flat lists. An item whose group the library does not have is at
 *  the top; a group that is not below the top (groups that hold one another) is left out with all
 *  it holds: a server sends neither. */
export function libraryTree(v: LibraryView): LibraryTree {
  const groups = v.groups ?? [], prompts = v.prompts ?? [];
  const known = new Set(groups.map((g) => g.id)), parentOf = (x: { parent: string }) => (known.has(x.parent) ? x.parent : "");
  const seen = new Set<string>();
  const under = (parent: string): { groups: GroupNode[]; prompts: LibraryPrompt[] } => ({
    groups: groups.filter((g) => parentOf(g) === parent && !seen.has(g.id)).sort(byPromptName).map((g) => { seen.add(g.id); return { id: g.id, name: g.name, ...under(g.id) }; }),
    prompts: prompts.filter((p) => parentOf(p) === parent).sort(byPromptName),
  });
  return { server: v.server, name: v.name, connected: v.connected, ...under("") };
}

/** The trees of the libraries, in the order given. */
export const libraryTrees = (libs: LibraryView[]): LibraryTree[] => libs.map(libraryTree);

/** Whether the tree has a level of servers, and a path a server's name: with more than one library. */
export const hasServerLevel = (libs: unknown[]): boolean => libs.length > 1;

// ---- the rows of the tree

/** What is chosen in the library popup: a prompt, a group, or the top entry of a server. */
export type Chosen = { kind: "prompt" | "group" | "server"; server: string; id: string };
export const chosenKey = (p: { kind: string; server: string; id: string }): string => `${p.kind}:${p.server}:${p.id}`;
export const sameChosen = (a: Chosen | null, b: Chosen | null): boolean => !!a && !!b && chosenKey(a) === chosenKey(b);

/** A row of the tree. depth: 0 at the left edge; open: of a group or a server, whether what it
 *  holds is shown; parent: the key of the row it is under, "" at the left edge; group: the id of
 *  the group it is in, "" at the top of its library; off: its server is not connected. */
export type TreeRow = Chosen & { key: string; name: string; depth: number; open?: boolean; parent: string; group: string; off: boolean; count?: number };

/** The rows of the tree that are on screen, top to bottom: with several libraries one row per
 *  server, each with its prompts counted; under what is open, the groups and then the prompts.
 *  closed: the keys (chosenKey) of the groups and servers that are closed. */
export function treeRows(trees: LibraryTree[], closed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [], level = hasServerLevel(trees);
  for (const t of trees) {
    const off = !t.connected;
    const walk = (g: { groups: GroupNode[]; prompts: LibraryPrompt[] }, depth: number, parent: string, group: string) => {
      for (const sub of g.groups) {
        const key = chosenKey({ kind: "group", server: t.server, id: sub.id }), open = !closed.has(key);
        out.push({ kind: "group", server: t.server, id: sub.id, key, name: sub.name, depth, open, parent, group, off });
        if (open) walk(sub, depth + 1, key, sub.id);
      }
      for (const p of g.prompts) out.push({ kind: "prompt", server: t.server, id: p.id, key: chosenKey({ kind: "prompt", server: t.server, id: p.id }), name: p.name, depth, parent, group, off });
    };
    if (!level) { walk(t, 0, "", ""); continue; }
    const key = chosenKey({ kind: "server", server: t.server, id: "" }), open = !closed.has(key);
    out.push({ kind: "server", server: t.server, id: "", key, name: t.name, depth: 0, open, parent: "", group: "", off, count: countPrompts(t) });
    if (open) walk(t, 1, key, "");
  }
  return out;
}

const countPrompts = (g: { groups: GroupNode[]; prompts: LibraryPrompt[] }): number => g.groups.reduce((n, s) => n + countPrompts(s), g.prompts.length);

/** Where an arrow key takes the tree's focus from the row `key`: Up and Down to the row before and
 *  after, Home and End to the first and the last; Left closes an open group or goes to the row it
 *  is under, Right opens a closed one or goes to the first row in it. toggle: the row to open or
 *  close in place of a move. Nothing for a key that does neither. */
export function treeKey(rows: TreeRow[], key: string, pressed: string): { focus?: string; toggle?: string } {
  const i = rows.findIndex((r) => r.key === key), r = rows[i];
  if (!r) return rows.length && (pressed === "ArrowDown" || pressed === "Home") ? { focus: rows[0].key } : {};
  switch (pressed) {
    case "ArrowDown": return i + 1 < rows.length ? { focus: rows[i + 1].key } : {};
    case "ArrowUp": return i > 0 ? { focus: rows[i - 1].key } : {};
    case "Home": return { focus: rows[0].key };
    case "End": return { focus: rows[rows.length - 1].key };
    case "ArrowLeft": return r.open ? { toggle: r.key } : r.parent ? { focus: r.parent } : {};
    case "ArrowRight": return r.open === false ? { toggle: r.key } : r.open && rows[i + 1]?.parent === r.key ? { focus: rows[i + 1].key } : {};
  }
  return {};
}

// ---- groups: paths, and the places of the tree

const groupOf = (v: LibraryView, id: string): LibraryGroup | undefined => (v.groups ?? []).find((g) => g.id === id);

/** The names of a group and of the groups it is in, from the top; none for "" and for a group the library has not. */
function groupNames(v: LibraryView, id: string): string[] {
  const names: string[] = [];
  for (let g = groupOf(v, id), n = 0; g && n <= LIBRARY_LIMITS.depth; g = groupOf(v, g.parent), n++) names.unshift(g.name);
  return names;
}

/** A group's path in its library: the names from the top, joined with "/". "" for the top. */
export const groupPath = (v: LibraryView, id: string): string => groupNames(v, id).join(PATH_SEP);

/** The ids of a group and of every group below it. */
export function groupWithBelow(v: LibraryView, id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of v.groups ?? []) if (out.has(g.parent) && !out.has(g.id)) { out.add(g.id); grew = true; }
  }
  return out;
}

/** How many prompts and groups go with a group that is deleted: those in it and below it. */
export function groupHolds(v: LibraryView, id: string): { prompts: number; groups: number } {
  const ids = groupWithBelow(v, id);
  return { prompts: (v.prompts ?? []).filter((p) => ids.has(p.parent)).length, groups: ids.size - 1 };
}

/** A place an item can be in: a library and a group of it ("" = its top). */
export type Place = { server: string; group: string };
export const samePlace = (a: Place | null, b: Place | null): boolean => (!a || !b ? a === b : a.server === b.server && a.group === b.group);

/** The place a row of the tree stands for, for what is made or dropped on it: a group is itself, a
 *  server the top of its library, and a prompt the group it is in (what lands on it lands beside it). */
export const rowPlace = (r: { kind: Chosen["kind"]; server: string; id: string; group: string }): Place => ({ server: r.server, group: r.kind === "group" ? r.id : r.group });

/** A place as the libraries have it now: with the top in place of a group that is gone; null when
 *  its library is gone. */
export function heldPlace(libs: LibraryView[], at: Place | null): Place | null {
  const v = at ? libs.find((x) => x.server === at.server) : undefined;
  return v && at ? { server: v.server, group: groupOf(v, at.group) ? at.group : "" } : null;
}

/** Where the buttons under the tree make a new item: into the chosen group, beside the chosen
 *  prompt, at the top of the chosen server, and with nothing chosen at the top; in a library that
 *  is connected, this computer's first. */
export function newPlace(libs: LibraryView[], pick: Chosen | null): Place | null {
  const open = libs.filter((v) => v.connected);
  if (!open.length) return null;
  const v = pick ? open.find((x) => x.server === pick.server) : undefined;
  if (!v || !pick) return { server: open[0].server, group: "" };
  if (pick.kind === "group") return { server: v.server, group: groupOf(v, pick.id) ? pick.id : "" };
  if (pick.kind === "prompt") { const p = (v.prompts ?? []).find((x) => x.id === pick.id); return { server: v.server, group: p && groupOf(v, p.parent) ? p.parent : "" }; }
  return { server: v.server, group: "" };
}

/** Whether a prompt or a group can be moved to a place, as far as the page can tell: inside its
 *  own library, which is connected, to a place it is not in already, and a group not into itself
 *  or below itself. The names of the place and the depth are the server's to check. */
export function canMove(libs: LibraryView[], item: Chosen | null, to: Place | null): boolean {
  if (!item || !to || item.kind === "server" || item.server !== to.server) return false;
  const v = libs.find((x) => x.server === item.server), now = chosenItem(libs, item);
  if (!v || !v.connected || !now || now.parent === to.group) return false;
  if (to.group && !groupOf(v, to.group)) return false;
  return item.kind === "prompt" || !groupWithBelow(v, item.id).has(to.group);
}

/** A place as names: its server's name when the tree has a level of servers, then the names of its group from the top. None for the top
 *  of the only library. (A server's name may hold a "/": a screen that joins the names its own way keeps them apart.) */
export function placeNames(libs: LibraryView[], at: Place, level: boolean): string[] {
  const v = libs.find((x) => x.server === at.server);
  return [...(level && v ? [v.name] : []), ...(v ? groupNames(v, at.group) : [])];
}

/** A place in words: the path of its group, after its server's name when the tree has a level of
 *  servers. "" for the top of the only library. */
export const placePath = (libs: LibraryView[], at: Place, level: boolean): string => placeNames(libs, at, level).join(PATH_SEP);

/** Where an item is or goes, as the editor and the tree's menu say it. */
export const placeText = (libs: LibraryView[], at: Place, level: boolean): string => { const path = placePath(libs, at, level); return path ? `In ${path}` : "At the top level"; };

/** What the top of a library is called where a moved item can be put there. */
export const topText = (name: string, level: boolean): string => (level ? `Move to the top of ${name}` : "Move to the top level");

/** The key of the row that heads a place: its group's, or its server's at the top; "" for the top
 *  of the only library, which no row heads. */
export const placeKey = (at: Place, level: boolean): string =>
  (at.group ? chosenKey({ kind: "group", server: at.server, id: at.group }) : level ? chosenKey({ kind: "server", server: at.server, id: "" }) : "");

/** The keys of the rows that must be open for a place to show what is in it: its server's, its
 *  group's and those of the groups that group is in. */
export function keysAbove(libs: LibraryView[], at: Place): string[] {
  const v = libs.find((x) => x.server === at.server), out = [chosenKey({ kind: "server", server: at.server, id: "" })];
  for (let g = v && groupOf(v, at.group), n = 0; v && g && n <= LIBRARY_LIMITS.depth; g = groupOf(v, g.parent), n++) out.push(chosenKey({ kind: "group", server: at.server, id: g.id }));
  return out;
}

/** A place among the rows of the tree, to light it up: head, the key of the row that heads it
 *  ("" when it is not on screen, or no row heads it); inside, the keys of the rows in it, at any
 *  depth; all: it is the top of the only library, the whole tree. */
export function placeRows(rows: TreeRow[], at: Place, level: boolean): { head: string; inside: Set<string>; all: boolean } {
  const key = placeKey(at, level), inside = new Set<string>();
  if (!key) return { head: "", inside, all: true };
  const i = rows.findIndex((r) => r.key === key);
  if (i < 0) return { head: "", inside, all: false };
  for (let k = i + 1; k < rows.length && rows[k].depth > rows[i].depth; k++) inside.add(rows[k].key);
  return { head: key, inside, all: false };
}

/** The key of the row that stands for an item being made. */
export const NEW_ROW = "new";

/** The rows with one more for an item that is being made, so that the tree shows where it goes: in
 *  its place, a group before the groups there and a prompt before the prompts. The rows as they
 *  are when the place is not on screen (its group is closed). */
export function withNewRow(rows: TreeRow[], fresh: { kind: "prompt" | "group"; at: Place; name: string } | null, level: boolean): TreeRow[] {
  if (!fresh) return rows;
  const head = placeKey(fresh.at, level), i = rows.findIndex((r) => r.key === head);
  if (head && (i < 0 || !rows[i].open)) return rows;
  const depth = head ? rows[i].depth + 1 : 0;
  let end = i + 1;
  while (end < rows.length && rows[end].depth >= depth) end++;
  let at = i + 1;
  if (fresh.kind === "prompt") for (at = i + 1; at < end && !(rows[at].depth === depth && rows[at].kind === "prompt"); ) at++;
  const row: TreeRow = { kind: fresh.kind, server: fresh.at.server, id: "", key: NEW_ROW, name: fresh.name, depth, parent: head, group: fresh.at.group, off: false };
  return [...rows.slice(0, at), row, ...rows.slice(at)];
}

/** How far a row is set in for each level of its depth, in pixels: less in a tree so deep that
 *  the names would have no room left. */
export const indentStep = (rows: { depth: number }[], step = 18, room = 150): number => Math.min(step, Math.floor(room / Math.max(1, ...rows.map((r) => r.depth))));

// ---- the editor

/** What the editor shows of an item: its name, a prompt's text, and the group it is in, which is
 *  changed in the tree and not in the editor. */
export type Fields = { name: string; parent: string; text: string };
/** What was typed in the editor and is not saved; a field left out is as it is saved. */
export type Edits = { name?: string; text?: string };

/** The chosen item as the library has it; undefined when it is gone (deleted, or its library with it). */
export function chosenItem(libs: LibraryView[], pick: Chosen | null): Fields | undefined {
  const v = pick ? libs.find((x) => x.server === pick.server) : undefined;
  if (!v || !pick) return undefined;
  if (pick.kind === "prompt") { const p = (v.prompts ?? []).find((x) => x.id === pick.id); return p && { name: p.name, parent: groupOf(v, p.parent) ? p.parent : "", text: p.text }; }
  if (pick.kind === "group") { const g = groupOf(v, pick.id); return g && { name: g.name, parent: groupOf(v, g.parent) ? g.parent : "", text: "" }; }
  return undefined;
}

/** The fields the editor shows: what was typed over what is saved. */
export const shownFields = (saved: Fields, edits: Edits): Fields => ({ ...saved, ...edits });

/** The fields that differ from what is saved: what a save sends, so that a field nobody touched
 *  keeps what another window gave it meanwhile. Empty when nothing is to save. */
export function changeOf(saved: Fields, edits: Edits, kind: "prompt" | "group"): Edits {
  const out: Edits = {};
  if (edits.name !== undefined && edits.name.trim() !== saved.name) out.name = edits.name.trim();
  if (kind === "prompt" && edits.text !== undefined && edits.text !== saved.text) out.text = edits.text;
  return out;
}

/** Whether the editor holds something that is not saved. */
export const isDirty = (saved: Fields, edits: Edits, kind: "prompt" | "group"): boolean => Object.keys(changeOf(saved, edits, kind)).length > 0;

/** "" or what is wrong with a name, as the library's server says it. The server checks the same again. */
export function nameProblem(name: string): string {
  const n = name.trim();
  if (!n) return "A name cannot be empty.";
  if ([...n].length > LIBRARY_LIMITS.name) return `A name can have at most ${LIBRARY_LIMITS.name} characters.`;
  if (n.includes(PATH_SEP)) return `A name cannot contain "/".`;
  if (/[\n\r]/.test(n)) return "A name cannot contain a line break.";
  return "";
}

// ---- questions

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The question before a prompt is deleted. */
export const deletePromptText = (name: string): { title: string; body: string } => ({ title: "Delete prompt", body: `“${name}” is deleted from the library.` });

/** The question before a group is deleted: it says how many prompts go with it, and how many groups. */
export function deleteGroupText(name: string, holds: { prompts: number; groups: number }): { title: string; body: string } {
  const what = [count(holds.prompts, "prompt"), ...(holds.groups ? [count(holds.groups, "group")] : [])].join(" and ");
  return { title: "Delete group", body: holds.prompts + holds.groups === 0 ? `“${name}” is deleted. It holds no prompts.` : `“${name}” is deleted with everything in it: ${what}.` };
}

/** The question before an item with unsaved changes is left. */
export const leaveText = (kind: "prompt" | "group", name: string): { title: string; body: string } =>
  ({ title: "Discard changes?", body: name.trim() ? `The changes to the ${kind} “${name.trim()}” are not saved.` : `The new ${kind} is not saved.` });

/** Why nothing of a library can be changed while its server is not connected. */
export const offText = (name: string): string => `${name} is not connected: these are the prompts it last sent. They can be inserted, and changed once it is back.`;

// ---- the lists

/** A prompt found, with whether its server is connected. */
export type Hit = PromptHit<LibraryPrompt> & { off: boolean };

/** The prompts of the libraries as a list: all of them in the order of the tree for an empty
 *  search, else those the search finds, in its three ranks (promptsearch.ts). */
export function promptList(trees: LibraryTree[], query: string): Hit[] {
  const off = new Set(trees.filter((t) => !t.connected).map((t) => t.server));
  return searchPrompts<LibraryPrompt>(trees, query).map((h) => ({ ...h, off: off.has(h.server) }));
}

/** The index a list's highlight moves to: d rows on, around the ends. -1 for an empty list. */
export const moveIn = (n: number, at: number, d: number): number => (n ? (at < 0 ? (d > 0 ? 0 : n - 1) : (at + d + n) % n) : -1);

/** A prompt's text as one line of a list: its first line that says something, cut. */
export function textLine(text: string, max = 120): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l) ?? "";
  return [...line].length > max ? [...line].slice(0, max).join("") + "…" : line;
}
