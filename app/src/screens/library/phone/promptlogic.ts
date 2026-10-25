// What the Prompt sheet shows: the sections and the rows from the libraries' trees, the recent prompts and the typed search. No React and no react-native here.
//   no search   Recent (the last inserted prompts that still exist), then the prompts by folder, one section per path in the tree's order (a library's groups
//               first, its top-level prompts last, as the Library screen lists them); the prompts at the top of a single library are under "Top level"
//   a search    the hits of promptList in their ranks, each run of one path under its head; no Recent
import { promptList, type GroupNode, type Hit, type LibraryTree } from "@aiwb/core/logic/libraryview.ts";
import { hasSearch } from "@aiwb/core/logic/promptsearch.ts";

import { RECENT_PROMPTS, type RecentRef } from "./promptrecent.ts";

export const RECENT_HEAD = "Recent";
/** The head of the prompts at the top of a single library (with several, the head is the server's name: the path says it). */
export const TOP_HEAD = "Top level";
/** The mark between the parts of a section's head. */
export const HEAD_SEP = " › ";

/** A row of the sheet: `id` is unique in the list (a recent prompt is listed twice), `hit` the prompt as the library's lists have it. */
export type PromptRow = { id: string; hit: Hit; recent: boolean };
/** A section: `head` is "" for the run that has none. */
export type PromptSection = { id: string; head: string; recent: boolean; rows: PromptRow[] };

/** The head of every place of the trees, by `${server}\n${group}`: the server's name when there are several libraries, then the group's names from the
 *  top, joined with " › " (from the names, never a split path: a server's name may hold a "/"); "" for the top of the only library. */
export function headsOf(trees: LibraryTree[]): Map<string, string> {
  const out = new Map<string, string>(), level = trees.length > 1;
  for (const t of trees) {
    const top = level ? [t.name] : [];
    out.set(`${t.server}\n`, top.join(HEAD_SEP));
    const walk = (gs: GroupNode[], above: string[]) => { for (const g of gs) { const names = [...above, g.name]; out.set(`${t.server}\n${g.id}`, names.join(HEAD_SEP)); walk(g.groups, names); } };
    walk(t.groups, top);
  }
  return out;
}

/** The runs of hits that share one place (server and group), in order. */
function runsOf(hits: Hit[]): Hit[][] {
  const runs: Hit[][] = [];
  for (const h of hits) {
    const last = runs[runs.length - 1];
    if (last && last[0].server === h.server && last[0].group === h.group) last.push(h); else runs.push([h]);
  }
  return runs;
}

export function promptSections(trees: LibraryTree[], recent: RecentRef[], query: string): PromptSection[] {
  const searching = hasSearch(query);
  const hits = promptList(trees, searching ? query : "");
  const runs = runsOf(hits), heads = headsOf(trees);
  const sections: PromptSection[] = runs.map((r, at) => ({
    id: `s${at}:${r[0].server}/${r[0].group}`, head: heads.get(`${r[0].server}\n${r[0].group}`) || TOP_HEAD, recent: false,
    rows: r.map((h) => ({ id: h.key, hit: h, recent: false })),
  }));
  if (searching) return sections;
  const byKey = new Map(hits.map((h) => [`${h.server}\n${h.prompt.id}`, h]));
  const last = recent.flatMap((r) => byKey.get(`${r.server}\n${r.id}`) ?? []).slice(0, RECENT_PROMPTS);
  return last.length ? [{ id: "recent", head: RECENT_HEAD, recent: true, rows: last.map((h) => ({ id: `recent:${h.key}`, hit: h, recent: true })) }, ...sections] : sections;
}

/** The rows of the sections in the order they are drawn: the order the arrow keys go. */
export const rowsOf = (sections: PromptSection[]): PromptRow[] => sections.flatMap((s) => s.rows);
