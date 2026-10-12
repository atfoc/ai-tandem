// What the library popup and the insert popup (Library.tsx) show of the libraries the page holds
// (logic/library.ts): their order, the tree of each, the rows of the tree that are on screen, the
// groups an item can be put in, what the editor holds against what is saved, and the questions
// asked before something is deleted or left. The search itself is logic/promptsearch.ts. DOM-free.

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
 *  holds is shown; parent: the key of the row it is under, "" at the left edge; off: its server is
 *  not connected. */
export type TreeRow = Chosen & { key: string; name: string; depth: number; open?: boolean; parent: string; off: boolean; count?: number };

/** The rows of the tree that are on screen, top to bottom: with several libraries one row per
 *  server, each with its prompts counted; under what is open, the groups and then the prompts.
 *  closed: the keys (chosenKey) of the groups and servers that are closed. */
export function treeRows(trees: LibraryTree[], closed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = [], level = hasServerLevel(trees);
  for (const t of trees) {
    const off = !t.connected;
    const walk = (g: { groups: GroupNode[]; prompts: LibraryPrompt[] }, depth: number, parent: string) => {
      for (const sub of g.groups) {
        const key = chosenKey({ kind: "group", server: t.server, id: sub.id }), open = !closed.has(key);
        out.push({ kind: "group", server: t.server, id: sub.id, key, name: sub.name, depth, open, parent, off });
        if (open) walk(sub, depth + 1, key);
      }
      for (const p of g.prompts) out.push({ kind: "prompt", server: t.server, id: p.id, key: chosenKey({ kind: "prompt", server: t.server, id: p.id }), name: p.name, depth, parent, off });
    };
    if (!level) { walk(t, 0, ""); continue; }
    const key = chosenKey({ kind: "server", server: t.server, id: "" }), open = !closed.has(key);
    out.push({ kind: "server", server: t.server, id: "", key, name: t.name, depth: 0, open, parent: "", off, count: countPrompts(t) });
    if (open) walk(t, 1, key);
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

// ---- groups: paths, and where an item can be put

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
/** A place as the value of the editor's choice, and back. */
export const placeValue = (p: Place): string => p.server + "\n" + p.group;
export const placeOf = (value: string): Place => { const i = value.indexOf("\n"); return i < 0 ? { server: value, group: "" } : { server: value.slice(0, i), group: value.slice(i + 1) }; };

/** One library's places, for the editor's choice of a group: the top first, then the groups in the
 *  order of the tree, each by its path. without: a group that is left out with all below it (a
 *  group cannot be moved into itself or below itself). */
export type PlaceList = { server: string; name: string; places: { value: string; label: string }[] };
export function placesOf(v: LibraryView, top: string, without = ""): PlaceList {
  const skip = without ? groupWithBelow(v, without) : new Set<string>();
  const places = [{ value: placeValue({ server: v.server, group: "" }), label: top }];
  const walk = (g: { groups: GroupNode[] }, names: string[]) => {
    for (const sub of g.groups) {
      if (skip.has(sub.id)) continue;
      places.push({ value: placeValue({ server: v.server, group: sub.id }), label: [...names, sub.name].join(PATH_SEP) });
      walk(sub, [...names, sub.name]);
    }
  };
  walk(libraryTree(v), []);
  return { server: v.server, name: v.name, places };
}

/** What the top of a library is called in the choice of a group. */
export const TOP = "Top of the library";

/** The choice of a group in the editor. Of an item that is there: the places of its own library,
 *  since nothing moves between servers. Of a new one: the places of every library that is
 *  connected, each under its server's name when there are several libraries. */
export function placeChoice(libs: LibraryView[], item: { server: string; group?: string } | null): PlaceList[] {
  const lists = item ? libs.filter((v) => v.server === item.server) : libs.filter((v) => v.connected);
  return lists.map((v) => placesOf(v, TOP, item?.group));
}

/** Where a new item goes when nothing else is chosen: into the chosen group, beside the chosen
 *  prompt, at the top of the chosen server; in a library that is connected, this computer's first. */
export function newPlace(libs: LibraryView[], pick: Chosen | null): Place | null {
  const open = libs.filter((v) => v.connected);
  if (!open.length) return null;
  const v = pick ? open.find((x) => x.server === pick.server) : undefined;
  if (!v || !pick) return { server: open[0].server, group: "" };
  if (pick.kind === "group") return { server: v.server, group: groupOf(v, pick.id) ? pick.id : "" };
  if (pick.kind === "prompt") { const p = (v.prompts ?? []).find((x) => x.id === pick.id); return { server: v.server, group: p && groupOf(v, p.parent) ? p.parent : "" }; }
  return { server: v.server, group: "" };
}

// ---- the editor

/** What the editor holds of an item: its name, the group it is in, and a prompt's text. */
export type Fields = { name: string; parent: string; text: string };
/** What was typed or chosen in the editor and is not saved; a field left out is as it is saved. */
export type Edits = Partial<Fields>;

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
  if (edits.parent !== undefined && edits.parent !== saved.parent) out.parent = edits.parent;
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
