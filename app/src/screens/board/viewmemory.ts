// Where each board was last looked at on this phone (package B1, b1-design.md §4 "Open view"): the newest 50, kept in the kv under
// `aiwb.boardviews`, so a board opens again where it was left; a board never opened here is fitted (`{ fit: 16 }`). The list is
// newest first. A value that is not what was written (an older build, a damaged store) reads as less, never as an error.
import type { OpenView } from "@aiwb/board-bridge/messages.ts";
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";

export const VIEWS_KEY = "aiwb.boardviews";
export const MAX_VIEWS = 50;
/** The margin of the fitted view a new board opens with. */
export const FIT_MARGIN = 16;

export type Seen = { board: string; scrollX: number; scrollY: number; zoom: number };

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The list a kv value holds: entries with a board and a finite view (zoom above 0), the first of a board kept, at most 50. */
export function parseViews(raw: string | null | undefined): Seen[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: Seen[] = [];
  for (const e of v) {
    if (out.length >= MAX_VIEWS) break;
    const o = e as Partial<Seen> | null;
    if (!o || typeof o.board !== "string" || !o.board || !fin(o.scrollX) || !fin(o.scrollY) || !fin(o.zoom) || o.zoom <= 0) continue;
    if (out.some((s) => s.board === o.board)) continue;
    out.push({ board: o.board, scrollX: o.scrollX, scrollY: o.scrollY, zoom: o.zoom });
  }
  return out;
}

export const serialiseViews = (list: Seen[]): string => JSON.stringify(list.slice(0, MAX_VIEWS));

/** `list` with `board` seen at `v` now: first, and the oldest beyond 50 gone. A view that is not finite (or a zoom of 0) changes nothing. */
export function remember(list: Seen[], board: string, v: { scrollX: number; scrollY: number; zoom: number }): Seen[] {
  if (!board || !fin(v.scrollX) || !fin(v.scrollY) || !fin(v.zoom) || v.zoom <= 0) return list;
  return [{ board, scrollX: v.scrollX, scrollY: v.scrollY, zoom: v.zoom }, ...list.filter((s) => s.board !== board)].slice(0, MAX_VIEWS);
}

/** How `board` opens: where it was left, else fitted. */
export function openViewOf(list: Seen[], board: string): OpenView {
  const s = list.find((x) => x.board === board);
  return s ? { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom } : { fit: FIT_MARGIN };
}

/** The list in the kv now. */
export const loadViews = (): Seen[] => parseViews(safeGet(VIEWS_KEY));

/** Keeps `board`'s view in the kv (a store that refuses holds nothing, as everywhere). */
export function rememberView(board: string, v: { scrollX: number; scrollY: number; zoom: number }): void {
  const before = loadViews();
  const after = remember(before, board, v);
  if (after === before) return;
  safeSet(VIEWS_KEY, serialiseViews(after));
}

/** What `boardApp.setOpenView` is given on the phone. */
export const openViewFor = (board: string): OpenView => openViewOf(loadViews(), board);
