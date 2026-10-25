// What the library's phone lists say (package S4, goal 3.8.6), decided without a screen: the count line of a row, the head sub-lines of the
// P1 sheets, a hit's path, the words of the delete questions, the foot lines, where "+" puts a new item and what an offline library offers.
// Pure: no React, no react-native, so Node loads it.
import type { LibraryView } from "@aiwb/core/logic/library.ts";
import { groupHolds, hasServerLevel, libraryTree, placeNames, type GroupNode, type Place } from "@aiwb/core/logic/libraryview.ts";

/** The character between the names of a path on the phone's screens. */
export const PATH_ARROW = " › ";

const count = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A place as the phone says it: the names joined with " › " (from the names, never a split path: a server's name may hold a "/"). */
export const placeWords = (libs: LibraryView[], at: Place, level: boolean): string => placeNames(libs, at, level).join(PATH_ARROW);

/** What a group holds directly, as the line under its row and the caps header of its screen: "1 group · 2 prompts", "2 prompts", "1 group", "Empty". */
export function countLine(held: { groups: unknown[]; prompts: unknown[] }): string {
  const parts = [...(held.groups.length ? [count(held.groups.length, "group")] : []), ...(held.prompts.length ? [count(held.prompts.length, "prompt")] : [])];
  return parts.length ? parts.join(" · ") : "Empty";
}

/** The line of a search hit under the prompt's name: its groups from the top joined with " › ", the server's name first when there are several
 *  libraries; "Top level" for a prompt at the top of the only library. */
export const hitPath = (libs: LibraryView[], hit: { server: string; group: string }): string =>
  placeWords(libs, { server: hit.server, group: hit.group }, hasServerLevel(libs)) || "Top level";

/** A prompt's line under its name in a list: the first line of its text, or "No text". */
export const promptLineText = (line: string): string => line || "No text";

// ---- the P1 sheets' heads

/** What a group holds directly, as the tree shows it ("" is the top of the library); nothing for a group the library does not have. */
export function heldBy(v: LibraryView, id: string): Pick<GroupNode, "groups" | "prompts"> {
  const tree = libraryTree(v);
  const find = (g: Pick<GroupNode, "groups" | "prompts">): Pick<GroupNode, "groups" | "prompts"> | null => {
    for (const s of g.groups) { if (s.id === id) return s; const r = find(s); if (r) return r; }
    return null;
  };
  return id ? find(tree) ?? { groups: [], prompts: [] } : tree;
}

const groupOf = (v: LibraryView, id: string) => v.groups.find((g) => g.id === id);

/** Where a group is, in words: "in git", "in git › review", or "at the top level" ("in Studio Mac" at the top when there are several libraries). */
export function whereWords(libs: LibraryView[], at: Place): string {
  const words = placeWords(libs, at, hasServerLevel(libs));
  return words ? `in ${words}` : "at the top level";
}

/** The sub-line of a group's P1: "Group in git · 2 prompts". `held`: what the group holds directly. */
export function groupSub(libs: LibraryView[], server: string, group: string, held: { groups: unknown[]; prompts: unknown[] }): string {
  const v = libs.find((l) => l.server === server), parent = v ? groupOf(v, group)?.parent ?? "" : "";
  return `Group ${whereWords(libs, { server, group: v && groupOf(v, parent) ? parent : "" })} · ${countLine(held)}`;
}

/** The sub-line of a prompt's P1: "Prompt in git › review" or "Prompt at the top level". */
export function promptSub(libs: LibraryView[], server: string, parent: string): string {
  const v = libs.find((l) => l.server === server);
  return `Prompt ${whereWords(libs, { server, group: v && groupOf(v, parent) ? parent : "" })}`;
}

/** The foot line of a group's screen: "In git, on Studio Mac." / "At the top level, on Studio Mac." */
export function groupFoot(libs: LibraryView[], server: string, group: string): string {
  const v = libs.find((l) => l.server === server);
  if (!v) return "";
  const parent = groupOf(v, group)?.parent ?? "", at = { server, group: groupOf(v, parent) ? parent : "" };
  const words = placeWords(libs, at, false);
  return `${words ? `In ${words}` : "At the top level"}, on ${v.name}.`;
}

/** The notices of the libraries whose file was set aside at the server's start, one per library that has one, in the order of the libraries: the library's own
 *  words (plain text), after "<server name>: " when there are several libraries, as the wide dialog says them. */
export function fileNotices(libs: LibraryView[]): { server: string; text: string }[] {
  const level = hasServerLevel(libs);
  return libs.flatMap((v) => (v.notice ? [{ server: v.server, text: `${level ? `${v.name}: ` : ""}${v.notice}` }] : []));
}

/** The foot line of the Library screen. */
export const LIBRARY_FOOT = "Each server keeps its own prompts. Insert one in a chat with the prompt button of the message box.";

// ---- "+" and the offline libraries

/** The first connected library, in the order given: where "+" puts a new item. null with none. */
export const plusPlace = (libs: LibraryView[]): Place | null => { const v = libs.find((l) => l.connected); return v ? { server: v.server, group: "" } : null; };

/** The sub-line of "+"'s P1: where a new item goes. */
export function plusSub(libs: LibraryView[]): string {
  const at = plusPlace(libs), v = at && libs.find((l) => l.server === at.server);
  return v && hasServerLevel(libs) ? `At the top level of ${v.name}` : "At the top level";
}

/** Why a change cannot be made in a library now: "" when it can. */
export const offReason = (v: Pick<LibraryView, "name" | "connected"> | undefined): string => (!v ? "No server is connected" : v.connected ? "" : `${v.name} is not connected`);

/** Why "+" has nothing to offer: "" when a library is connected; else the one library's name, or "No server is connected". */
export function plusReason(libs: LibraryView[]): string {
  if (libs.some((l) => l.connected)) return "";
  return libs.length === 1 ? offReason(libs[0]) : "No server is connected";
}

/** Whether the libraries hold no group and no prompt at all (and there is at least one). */
export const allEmpty = (libs: LibraryView[]): boolean => libs.length > 0 && libs.every((l) => !l.groups.length && !l.prompts.length);

// ---- deleting

/** The confirm button of a group's delete: "Delete group and 2 prompts" (all levels), else "and 1 group", else "Delete group". */
export function deleteGroupLabel(holds: { prompts: number; groups: number }): string {
  return holds.prompts > 0 ? `Delete group and ${count(holds.prompts, "prompt")}` : holds.groups > 0 ? `Delete group and ${count(holds.groups, "group")}` : "Delete group";
}

/** The P4 of a prompt's delete. */
export const deletePromptSheet = (name: string, server: string): { title: string; body: string; confirmLabel: string } =>
  ({ title: `Delete “${name}”?`, body: `“${name}” is deleted from ${server}'s library.`, confirmLabel: "Delete prompt" });

/** The P4 of a group's delete, from the library it is in. */
export function deleteGroupSheet(v: LibraryView, id: string): { title: string; body: string; confirmLabel: string } {
  const name = groupOf(v, id)?.name ?? "";
  return { title: `Delete “${name}”?`, body: `The group “${name}” and everything in it are deleted from ${v.name}'s library.`, confirmLabel: deleteGroupLabel(groupHolds(v, id)) };
}
