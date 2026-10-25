// What the "New" sheet says of a place (ux-improvements goal 3.4, package H2; plans/ux-improvements/h2-design.md §4): the levels of one server's
// tree for its Where page (the crumb, the groups one level down), and the card's words. No React and no react-native here, so Node loads it
// (test/h2-new.test.ts); NewSheet.tsx only draws what it says. Archived groups are not in the tree it reads, as on Home.
import { buildTree, type GroupTree } from "@aiwb/core/logic/tree.ts";

import type { PlaceInput } from "./model.ts";

/** A level of the tree: a group's key (the server's top level is the empty key) and its name. */
export type Level = { key: string; name: string };

export type WhereView = {
  /** The groups from the outermost down to this level; empty at the top of the server. */
  path: Level[];
  /** The groups directly in this level, in the sidebar's order. */
  children: Level[];
};

/** The level `key` of one server's tree; the top level for "" and for a group the tree does not have (deleted since, archived). */
export function whereView(input: PlaceInput, server: string, key: string): WhereView {
  const tree = buildTree(input, false, { server, gone: input.gone });
  const level = (n: GroupTree): Level => ({ key: n.group.id, name: n.group.name });
  const walk = (nodes: GroupTree[], above: Level[]): WhereView | undefined => {
    for (const n of nodes) {
      const path = [...above, level(n)];
      if (n.group.id === key) return { path, children: n.children.map(level) };
      const inner = walk(n.children, path);
      if (inner) return inner;
    }
    return undefined;
  };
  return (key ? walk(tree.groups, []) : undefined) ?? { path: [], children: tree.groups.map(level) };
}

/** The key the sheet makes things in: `key` while the server's tree has that group, else the top ("" ). */
export const chosenKey = (input: PlaceInput, server: string, key: string): string => whereView(input, server, key).path.at(-1)?.key ?? "";

/** The card of page 1: the group's name ("<server>" at the top), and what is under it. `here`: it is the place the person opened the sheet at. */
export function cardWords(serverName: string, path: readonly Level[], here: boolean): { title: string; note: string } {
  const at = path.at(-1);
  if (!at) return { title: serverName, note: "not in a group" };
  return { title: at.name, note: here ? "the group you are in" : "the group you chose" };
}

/** The crumb of page 2: the server, then each group of the path; `key` is what a press goes to ("" = the top), `current` the last (plain, not pressable). */
export function crumbs(serverName: string, path: readonly Level[]): (Level & { current: boolean })[] {
  const all: Level[] = [{ key: "", name: serverName }, ...path];
  return all.map((l, i) => ({ ...l, current: i === all.length - 1 }));
}

/** The tinted row of page 2: "Put it in Checkout service", "Put it at the top of Studio Mac". */
export const putText = (serverName: string, path: readonly Level[]): string => {
  const at = path.at(-1);
  return at ? `Put it in ${at.name}` : `Put it at the top of ${serverName}`;
};

/** The heading over the groups of page 2: "GROUPS IN CHECKOUT SERVICE" (upper case is the screen's style, not the words'). */
export const groupsHeading = (serverName: string, path: readonly Level[]): string => `Groups in ${path.at(-1)?.name ?? serverName}`;
