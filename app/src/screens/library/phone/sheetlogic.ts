// What the phone library's sheets decide (package S4, chunk 2): the places a move picker lists and why one cannot be picked, how a place
// reads in the Group row, what the editor and the group form hold against what is saved, and the words of the leave guard, the delete
// question and the offline notice. No React and no react-native here, so Node tests it (test/libraryphone.sheets.test.ts).
import { LIBRARY_LIMITS, type LibraryView } from "@aiwb/core/logic/library.ts";
import {
  groupPath, groupWithBelow, hasServerLevel, libraryTree, nameProblem, samePlace,
  type GroupNode, type Place,
} from "@aiwb/core/logic/libraryview.ts";
import { PATH_SEP } from "@aiwb/core/logic/promptsearch.ts";

import { placeValue } from "./ids.ts";

export const TOP_LEVEL = "Top level";
export const NOW_HERE = "Now here";
/** The step a group is set in by, per level of depth (points). */
export const INDENT = 16;

export type ItemKind = "prompt" | "group";
/** A place of the move picker: `value` is its row's value (`placeValue`), `depth` how many groups it is in (0 for a top level). */
export type PlaceOption = {
  value: string;
  place: Place;
  label: string;
  depth: number;
  /** The server's name, only when there are several libraries. */
  section?: string;
  note?: string;
  disabledReason?: string;
  top: boolean;
};

const walk = (nodes: GroupNode[], skip: ReadonlySet<string>, depth: number, out: { node: GroupNode; depth: number }[]): void => {
  for (const g of nodes) {
    if (skip.has(g.id)) continue;
    out.push({ node: g, depth });
    walk(g.groups, skip, depth + 1, out);
  }
};

/** The places a move picker lists, library by library (in the order given): "Top level", then every group depth-first by name.
 *  item: what is moved (null for a new one, which can go to any connected library); current: where it is now ("Now here").
 *  A group is not offered its own place or any below it. A library that is not connected, and (for an item that exists) every other
 *  library, are listed with the reason they cannot be picked. */
export function placeOptions(libs: LibraryView[], o: { kind: ItemKind; item: { server: string; id: string } | null; current: Place | null }): PlaceOption[] {
  const level = hasServerLevel(libs), out: PlaceOption[] = [];
  for (const v of libs) {
    const reason = !v.connected ? `${v.name} is not connected` : o.item && o.item.server !== v.server ? stays(o.kind) : undefined;
    const skip = o.kind === "group" && o.item && o.item.server === v.server ? groupWithBelow(v, o.item.id) : new Set<string>();
    const make = (group: string, label: string, depth: number): PlaceOption => {
      const place = { server: v.server, group };
      return { value: placeValue(v.server, group), place, label, depth, ...(level ? { section: v.name } : {}), ...(o.current && samePlace(o.current, place) ? { note: NOW_HERE } : {}), ...(reason ? { disabledReason: reason } : {}), top: group === "" };
    };
    out.push(make("", TOP_LEVEL, 0));
    const groups: { node: GroupNode; depth: number }[] = [];
    walk(libraryTree(v).groups, skip, 0, groups);
    for (const { node, depth } of groups) out.push(make(node.id, node.name, depth + 1));
  }
  return out;
}

const stays = (kind: ItemKind): string => `A ${kind === "group" ? "group" : "prompt"} stays in its own server's library`;

/** The title and the sub-line of the move picker: for an item that exists, "Move “name” to…"; for a new one, the choice of its group. */
export function pickerWords(kind: ItemKind, name: string | null): { title: string; sub: string } {
  return name === null ? { title: "Choose a group", sub: `Where the new ${kind} goes` } : { title: `Move “${name}” to…`, sub: "Choose its new group" };
}

/** A place as the Group row says it: "git › pull requests", "Top level"; with several libraries the server's name first. */
export function placeLine(libs: LibraryView[], at: Place): string {
  const v = libs.find((x) => x.server === at.server);
  if (!v) return TOP_LEVEL;
  const path = groupPath(v, at.group), names = path ? path.split(PATH_SEP) : [];
  const parts = [...(hasServerLevel(libs) ? [v.name] : []), ...(names.length ? names : hasServerLevel(libs) ? [TOP_LEVEL] : [])];
  return parts.length ? parts.join(" › ") : TOP_LEVEL;
}

/** The place the library has now: the top in place of a group that is gone. */
export const placeIn = (libs: LibraryView[], at: Place): Place => {
  const v = libs.find((x) => x.server === at.server);
  return v && at.group && !(v.groups ?? []).some((g) => g.id === at.group) ? { server: at.server, group: "" } : at;
};

// ---- the prompt editor

/** What the editor shows of a prompt, or of the one being made. */
export type Draft = { name: string; text: string; place: Place };
export type PromptChange = { name?: string; text?: string; parent?: string };

/** What a save of a saved prompt sends: only the fields that differ from what is saved (a field nobody touched keeps what another window gave it). */
export function editorChange(saved: Draft, draft: Draft): PromptChange {
  const out: PromptChange = {};
  if (draft.name.trim() !== saved.name) out.name = draft.name.trim();
  if (draft.text !== saved.text) out.text = draft.text;
  if (draft.place.group !== saved.place.group) out.parent = draft.place.group;
  return out;
}

export type EditorState = { dirty: boolean; canSave: boolean; problem: string; change: PromptChange };

/** saved: the prompt as saved, null for a new one; start: where a new one began (its Group row can change it); off: its library is not connected. */
export function editorState(o: { saved: Draft | null; start: Place; draft: Draft; off: boolean }): EditorState {
  const { saved, draft, off } = o, bad = nameProblem(draft.name);
  if (saved) {
    const change = editorChange(saved, draft), dirty = Object.keys(change).length > 0;
    // (a name problem is said once the name was touched)
    return { dirty, canSave: !off && dirty && !bad, problem: draft.name !== saved.name ? bad : "", change };
  }
  const dirty = draft.name !== "" || draft.text !== "" || !samePlace(draft.place, o.start);
  return { dirty, canSave: !off && !bad, problem: draft.name !== "" ? bad : "", change: {} };
}

/** The words of the leave guard (06b-f). */
export const guardWords = (savedName: string | null): { title: string; body: string; saveAndClose: true } =>
  savedName === null
    ? { title: "Discard the new prompt?", body: "It is not saved yet.", saveAndClose: true }
    : { title: `Discard changes to “${savedName}”?`, body: `The changes to the prompt “${savedName}” are not saved. Discarding goes back to the saved text.`, saveAndClose: true };

/** The question before a prompt is deleted. */
export const deleteWords = (name: string, server: string): { title: string; body: string; confirm: string } =>
  ({ title: `Delete “${name}”?`, body: `“${name}” is deleted from ${server}'s library.`, confirm: "Delete prompt" });

/** Why nothing of a prompt can be changed while its server is not connected. */
export const offNotice = (server: string): string => `${server} is not connected: this prompt can be changed once it is back.`;

// ---- the group form

export type GroupFormState = { dirty: boolean; canSave: boolean; problem: string };

/** saved: a group's name for a rename, null for a new group (start: where it began; place: where it is now). */
export function groupFormState(o: { saved: string | null; start: Place; name: string; place: Place }): GroupFormState {
  const bad = nameProblem(o.name);
  if (o.saved !== null) {
    const dirty = o.name.trim() !== o.saved;
    return { dirty, canSave: dirty && !bad, problem: o.name !== o.saved ? bad : "" };
  }
  return { dirty: o.name !== "" || !samePlace(o.place, o.start), canSave: !bad, problem: o.name !== "" ? bad : "" };
}

export const NAME_MAX = LIBRARY_LIMITS.name;
