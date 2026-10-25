// What a row's action sheet says and offers (package H2 chunk 2; h2-design.md §3), with no React and no react-native, so Node loads it
// (test/h2-rows.test.ts): the head's sub-line, the note of "Move to…", the places an item may be moved to, the words of a delete.
import { boardDeleteBody } from "@aiwb/core/logic/boardrow.ts";
import { isUngrouped, ungroupedOn } from "@aiwb/core/logic/keys.ts";
import { groupPath, subtree } from "@aiwb/core/logic/tree.ts";
import type { Group } from "@aiwb/core/types.ts";

import type { RowKind } from "./model.ts";

/** The place's words between the groups of a path. */
export const PATH_SEP = " › ";

/** The value of "Top level" in the picker of a group's places (a group's parent is "" there; a picker value must be a word). */
export const TOP_LEVEL = "__top__";

export const kindWord = (kind: RowKind): string => (kind === "chat" ? "Chat" : kind === "board" ? "Whiteboard" : "Group");

/** The noun of the go button of a delete and of the sheet's last row: "chat", "whiteboard", "group". */
export const deleteNoun = (kind: RowKind): string => (kind === "chat" ? "chat" : kind === "board" ? "whiteboard" : "group");

/** The head's sub-line: "Chat · Checkout service · Studio Mac". place: the names of the groups the item is in (outermost first; for a
 *  group, its parents), board: the board a chat is on (its name stands for the place); an item in no group names the server alone. */
export function headSub(kind: RowKind, place: readonly string[], board: string | null, server: string): string {
  return [kindWord(kind), board ?? (place.length ? place.join(PATH_SEP) : ""), server].filter(Boolean).join(" · ");
}

/** The note of "Move to…": the group the item is in, or "Not in a group" (a group's: its parent, or "Top level"). */
export function moveNote(kind: RowKind, place: readonly string[]): string {
  return place.length ? place[place.length - 1] : kind === "group" ? "Top level" : "Not in a group";
}

export type MoveTarget = { value: string; label: string };

/** Where a board or a chat may be moved: its server's ungrouped area first, then every group that is not archived, by its path
 *  (groups: the groups of the item's own server). The group it is in is listed too, so the picker can tick it. */
export function placesFor(groups: readonly Group[], server: string, current: string): MoveTarget[] {
  const all = groups as Group[];
  return [
    { value: ungroupedOn(server), label: "Not in a group" },
    ...all.filter((g) => !g.archived || g.id === current).map((g) => ({ value: g.id, label: groupPath(all, g.id).join(PATH_SEP) })),
  ];
}

/** Where a group may go: the top level first, then every group that is not archived and is not the group itself or inside it. Its own
 *  parent is listed too (ticked). The value of the top level is TOP_LEVEL. */
export function placesForGroup(groups: readonly Group[], id: string): MoveTarget[] {
  const all = groups as Group[], inside = subtree(all, id);
  return [{ value: TOP_LEVEL, label: "Top level" }, ...all.filter((g) => !inside.has(g.id) && !g.archived).map((g) => ({ value: g.id, label: groupPath(all, g.id).join(PATH_SEP) }))];
}

/** The value of the picker that is ticked: the group the item is in (a board's or chat's ungrouped key for none; TOP_LEVEL for a group
 *  at the top). */
export const currentPlace = (kind: RowKind, server: string, group: string | undefined): string =>
  kind === "group" ? group || TOP_LEVEL : group && !isUngrouped(group) ? group : ungroupedOn(server);

/** The picker's sub-line: "Fix the flaky cart test is in Checkout service". */
export function moveSub(kind: RowKind, name: string, place: readonly string[]): string {
  const where = place.length ? `in ${place.join(PATH_SEP)}` : kind === "group" ? "at the top level" : "not in a group";
  return `${name} is ${where}`;
}

const ARCHIVE_HINT = "To keep it out of the way instead, archive it.";

/** The sentence under a delete's title: what is lost, and where (`server` is "" on this computer), and the way out. A board that an agent
 *  works on says so first. */
export function deleteBody(kind: RowKind, server: string, busy = false): string {
  if (kind === "board") return `${boardDeleteBody(busy, server)}\n\n${ARCHIVE_HINT}`;
  const lost = server ? `Its history is removed on ${server}, for everyone who uses that server.` : "Its history is removed from this computer.";
  return `${lost} This can't be undone.\n\n${ARCHIVE_HINT}`;
}
