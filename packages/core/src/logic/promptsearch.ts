// The search of the prompt library, for the library popup and the insert popup: the prompts of
// the libraries of several servers as one flat list in the order of the tree, and the prompts a
// typed search finds, in three ranks. Only prompts are found, by path and name; a prompt's text
// is not searched. The terms are matched as the model picker matches them (terms.ts). DOM-free.

import { hasTerms, leadingTerms, searchTerms } from "./terms.ts";

/** What the search reads of a prompt, of a group and of one server's library. A real library
 *  fits as it is or with a trivial adapter; a hit gives the caller's own prompt object back. */
export type PromptItem = { id: string; name: string };
export type PromptGroup<P extends PromptItem = PromptItem> = {
  id: string;
  name: string;
  groups?: PromptGroup<P>[] | null;
  prompts?: P[] | null;
};
/** One server's library: the server's entry id, its name as the tree shows it, and what is at
 *  the top of its library. */
export type PromptLibrary<P extends PromptItem = PromptItem> = {
  server: string;
  name: string;
  groups?: PromptGroup<P>[] | null;
  prompts?: P[] | null;
};

/** 1: the first terms are in the path and the rest in the name; 2: all in the name; 3: all in
 *  the path. 0 in a list that no search made. */
export type PromptRank = 0 | 1 | 2 | 3;

export type PromptHit<P extends PromptItem = PromptItem> = {
  /** Unique in a list: the server's entry id and the prompt's id. */
  key: string;
  /** The entry id of the prompt's server. */
  server: string;
  /** The id of the group the prompt is in; "" at the top of its library. */
  group: string;
  /** The names of the groups the prompt is in, from the top, joined with "/"; the server's name
   *  comes first when there are several libraries. "" for a prompt at the top of the only one. */
  path: string;
  prompt: P;
  rank: PromptRank;
};

/** The character between the parts of a path, and between the path and the name. */
export const PATH_SEP = "/";

/** The order inside a group: by name, as the board tree sorts. Groups come before prompts. */
export const byPromptName = (a: PromptItem, b: PromptItem): number =>
  a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A path and a name as one line, as a row of a list shows a prompt. */
export const promptLine = (h: { path: string; prompt: { name: string } }): string =>
  h.path ? h.path + PATH_SEP + h.prompt.name : h.prompt.name;

/** True when the typed search has a term: the popups then show what searchPrompts finds, else
 *  the tree (library popup) or every prompt (insert popup). */
export const hasSearch = (query: string): boolean => searchTerms(query).length > 0;

/** Every prompt of the libraries in the order of the tree: the libraries as given (this computer
 *  first, then the servers in the order of the server list), and in each group its groups with
 *  all they hold before its own prompts, both by name. The server's name is in the path only
 *  when more than one library is given, so the caller gives a library for every top entry of
 *  the tree, also for a server whose library is empty. */
export function listPrompts<P extends PromptItem>(libs: PromptLibrary<P>[]): PromptHit<P>[] {
  const out: PromptHit<P>[] = [];
  const named = libs.length > 1;
  for (const lib of libs) {
    const walk = (g: { groups?: PromptGroup<P>[] | null; prompts?: P[] | null }, group: string, names: string[]) => {
      for (const sub of [...(g.groups ?? [])].sort(byPromptName)) walk(sub, sub.id, [...names, sub.name]);
      const path = names.join(PATH_SEP);
      for (const prompt of [...(g.prompts ?? [])].sort(byPromptName))
        out.push({ key: lib.server + PATH_SEP + prompt.id, server: lib.server, group, path, prompt, rank: 0 });
    };
    walk(lib, "", named ? [lib.name] : []);
  }
  return out;
}

/** The rank the terms give a prompt, 0 when they do not find it. The terms are lowercased, and
 *  there is at least one. A term that lies across the "/" between the path and the name (as in
 *  "git/com" for "commit message" in "git") is in both, so it counts as rank 1. */
export function promptRank(path: string, name: string, terms: string[]): PromptRank {
  const p = path.toLowerCase();
  const n = name.toLowerCase();
  const count = terms.length;
  const inPath = leadingTerms(p, terms); // every shorter start of the terms is in the path too
  let fromName = 0; // the name holds the terms from here on, and from every later one
  while (!hasTerms(n, terms.slice(fromName))) fromName++;
  if (Math.max(fromName, 1) <= Math.min(inPath, count - 1)) return 1;
  if (fromName === 0) return 2;
  if (inPath === count) return 3;
  return p !== "" && hasTerms(p + PATH_SEP + n, terms) ? 1 : 0;
}

/** The prompts a typed search finds: rank 1 first, then 2, then 3, and inside a rank the order
 *  of listPrompts. An empty or whitespace-only search gives every prompt, as listPrompts does. */
export function searchPrompts<P extends PromptItem>(libs: PromptLibrary<P>[], query: string): PromptHit<P>[] {
  const all = listPrompts(libs);
  const terms = searchTerms(query);
  if (!terms.length) return all;
  const ranks: PromptHit<P>[][] = [[], [], []];
  for (const h of all) {
    const rank = promptRank(h.path, h.prompt.name, terms);
    if (rank) ranks[rank - 1].push({ ...h, rank });
  }
  return ranks.flat();
}
