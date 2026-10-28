// The model and effort menu: its draft (a Choice that is applied once, on Enter or Done), its search, the keys of its
// search field and ⌘E that opens it. DOM-free: used by the desktop popover and the phone sheet, tested under node:test.

import type { Catalog, CatalogModel } from "../types.ts";
import { isMac } from "./layout.ts";
import { type Choice, filterModels, groupModels, sameChoice, withEffort, withModel } from "./models.ts";

/** `base`: the choice the menu opened with, what applying diffs the draft against (the chat may change meanwhile, from another window). */
export type MenuState = { query: string; draft: Choice; base: Choice };

/** The state the menu opens with: no query, the current choice as the draft and as the base. */
export function openMenu(cur: Choice): MenuState {
  return { query: "", draft: cur, base: cur };
}

/** The listed models for a query, in render order (groupModels(filterModels(models, q)).flatMap(g => g.models)). */
export function listedModels(models: CatalogModel[], query: string): CatalogModel[] {
  return groupModels(filterModels(models, query)).flatMap((g) => g.models);
}

const listed = (s: MenuState, cat: Catalog) => listedModels(cat.models, s.query);

/** Typing: the draft's model kept when listed, else the first listed (withModel); none listed: the draft as it is. */
export function typeQuery(s: MenuState, query: string, cat: Catalog): MenuState {
  const shown = listedModels(cat.models, query);
  if (shown.length === 0 || shown.some((m) => m.id === s.draft.model)) return { ...s, query };
  return { ...s, query, draft: withModel(s.draft, shown[0].id, cat) };
}

/** ↑ (-1) / ↓ (+1) within the listed models, wrapping; draft not listed: ↓ the first, ↑ the last; none listed: unchanged. */
export function moveModel(s: MenuState, d: 1 | -1, cat: Catalog): MenuState {
  const shown = listed(s, cat);
  if (shown.length === 0) return s;
  const i = shown.findIndex((m) => m.id === s.draft.model);
  const next = i < 0 ? (d > 0 ? 0 : shown.length - 1) : (i + d + shown.length) % shown.length;
  return pickModel(s, shown[next].id, cat);
}

/** A press on a row. */
export function pickModel(s: MenuState, id: string, cat: Catalog): MenuState {
  return { ...s, draft: withModel(s.draft, id, cat) };
}

/** Tab (+1) / Shift+Tab (-1) over the drafted model's efforts, wrapping; an effort not in the list: +1 the first, -1 the last; no efforts: unchanged. */
export function stepEffort(s: MenuState, d: 1 | -1, cat: Catalog): MenuState {
  const efforts = cat.models.find((m) => m.id === s.draft.model)?.efforts ?? [];
  if (efforts.length === 0) return s;
  const i = s.draft.effort ? efforts.indexOf(s.draft.effort) : -1;
  const next = i < 0 ? (d > 0 ? 0 : efforts.length - 1) : (i + d + efforts.length) % efforts.length;
  return pickEffort(s, efforts[next]);
}

/** A press on a segment. */
export function pickEffort(s: MenuState, effort: string): MenuState {
  return { ...s, draft: withEffort(s.draft, effort) };
}

/** Whether Enter / Done may apply: the drafted model is listed under the current query. */
export function canApply(s: MenuState, cat: Catalog): boolean {
  return listed(s, cat).some((m) => m.id === s.draft.model);
}

/** What applying writes: the fields of `draft` that differ from `cur` (the menu's `base`) ({ model?, effort? }); null when nothing differs (sameChoice).
 *  A new model without an effort is `{ model }` alone; the same model with its effort taken away is `{ effort: "" }`. */
export function applyPatch(cur: Choice, draft: Choice): { model?: string; effort?: string } | null {
  if (sameChoice(cur, draft)) return null;
  const patch: { model?: string; effort?: string } = {};
  if (draft.model !== cur.model) patch.model = draft.model;
  if ((draft.effort || "") !== (cur.effort || "") && (draft.effort || patch.model === undefined)) patch.effort = draft.effort || "";
  return patch;
}

export type MenuKeyAction = "next" | "prev" | "effortNext" | "effortPrev" | "apply" | "cancel" | null;

/** ArrowDown next, ArrowUp prev, Tab effortNext, Shift+Tab effortPrev, Enter apply (not with Shift / Alt / ⌘ / Ctrl), Escape cancel; anything
 *  else null. Every key is null while an input method composes (`isComposing`): its Esc, arrows and Enter belong to it. */
export function menuKey(e: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean }): MenuKeyAction {
  if (e.isComposing) return null;
  switch (e.key) {
    case "ArrowDown":
      return "next";
    case "ArrowUp":
      return "prev";
    case "Tab":
      return e.shiftKey ? "effortPrev" : "effortNext";
    case "Enter":
      return e.shiftKey || e.altKey || e.metaKey || e.ctrlKey ? null : "apply";
    case "Escape":
      return "cancel";
    default:
      return null;
  }
}

/** ⌘E (Mac, iPhone, iPad) / Ctrl+E (elsewhere), no Shift, no Alt, code KeyE. */
export function isModelMenuKey(e: { code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, platform: string): boolean {
  return e.code === "KeyE" && !e.shiftKey && !e.altKey && (isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
}

/** "⌘E" / "Ctrl+E", for titles and hints. */
export function modelMenuKeyName(platform: string): string {
  return isMac(platform) ? "⌘E" : "Ctrl+E";
}
