// The run timeline's view maths: the zoom steps and fit, zooming at the pointer, following "now",
// when to lay out again, the width of the label column, the row filter and the keyboard's steps.
// DOM-free. Zoom is in px per minute (ppm); x is from the chart's left edge, as in runtimeline.ts.
import { K, buildAxis, chainOf, taskState, type TLAxis, type TLRun, type TLTask } from "./runtimeline.ts";

/** The fixed zoom steps, in px per minute. A step at or below fit is not offered. */
export const ZOOM_STEPS = [1, 2, 4, 8, 16, 32, 64];
/** A live run is never shown smaller than this by default: once fit falls below it, the
 *  timeline stays at this zoom and follows now. */
export const LIVE_PPM = 2;
/** As a zoom: always the whole run. (Any zoom at or below fit shows the whole run; this one stays
 *  below it however long the run gets.) */
export const ZOOM_FIT = 0;

const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));
const above = (a: number, b: number) => a > b * (1 + 1e-9);

/** The label column shows the needs cell (the ids a task depends on) from this width. */
export const NEEDS_MIN = 300;
/** The width of the label column for a timeline `width` px wide: 34%, between 168 and 372; from
 *  700 px on at least NEEDS_MIN, so that what each task depends on is written there. */
export const labelWidth = (width: number): number => clamp(width >= 700 ? NEEDS_MIN : 168, Math.round(0.34 * width), 372);
/** Whether a label column `labelW` px wide shows the needs cell. */
export const needsShown = (labelW: number): boolean => labelW >= NEEDS_MIN;
/** Whether it shows the kind word ("fix", "review"): from 340 px, below that the room is the title's. */
export const kindShown = (labelW: number): boolean => labelW >= 340;
/** The room right of "now" in a live run's chart of `chartWidth` px, where open rows say why they
 *  wait: 28%, between 96 and 150. None when the run is not live. */
export const futureRoom = (chartWidth: number, live: boolean): number =>
  (live ? Math.round(clamp(K.FUTURE_MIN, chartWidth * 0.28, K.FUTURE)) : 0);

/** The zoom at which the whole run fills a chart `chartWidth` px wide. */
export const fitPpm = (run: TLRun, chartWidth: number, now: number): number => buildAxis(run, { width: chartWidth, now }).ppm;

/** The automatic zoom: the whole run; for a live run only while that is at least LIVE_PPM. */
export const defaultPpm = (fit: number, live: boolean): number => (live && fit < LIVE_PPM ? LIVE_PPM : fit);

/** What a wanted zoom comes to. */
export interface Zoom {
  /** The px per minute shown. */
  ppm: number;
  /** The whole run is shown: nothing to scroll horizontally. */
  fit: boolean;
  /** What to give the layout: null for fit. */
  layoutPpm: number | null;
  canZoomIn: boolean; canZoomOut: boolean;
}
/** Resolves the wanted zoom (null: automatic) against fit: never below it. */
export function resolveZoom(want: number | null, fit: number, live: boolean): Zoom {
  const ppm = want ?? defaultPpm(fit, live);
  const isFit = !above(ppm, fit), shown = isFit ? fit : ppm;
  return { ppm: shown, fit: isFit, layoutPpm: isFit ? null : shown, canZoomIn: zoomIn(shown, fit) !== undefined, canZoomOut: !isFit };
}

/** What to ask for to see the whole run: automatic when that is the whole run, else ZOOM_FIT. */
export const fitZoom = (fit: number, live: boolean): number | null => (defaultPpm(fit, live) === fit ? null : ZOOM_FIT);
/** The next step in from the zoom shown; undefined at the last step. */
export const zoomIn = (ppm: number, fit: number): number | undefined => ZOOM_STEPS.find((s) => above(s, ppm) && above(s, fit));
/** The next step out from the zoom shown: a step, or the whole run when no step is left above
 *  fit; undefined when the whole run is shown already. */
export function zoomOut(ppm: number, fit: number, live: boolean): number | null | undefined {
  if (!above(ppm, fit)) return undefined;
  const step = [...ZOOM_STEPS].reverse().find((s) => above(ppm, s) && above(s, fit));
  return step ?? fitZoom(fit, live);
}

/** The time under a pointer `pointerX` px right of the chart viewport's left edge. */
export const timeAt = (axis: TLAxis, scrollLeft: number, pointerX: number): number => axis.t(scrollLeft + pointerX);
/** The scrollLeft that puts time `t` under that pointer. */
export const scrollFor = (axis: TLAxis, t: number, pointerX: number): number => Math.max(0, axis.x(t) - pointerX);
/** Zooming at the pointer: the scrollLeft on the new axis that keeps the time under the pointer
 *  where it is. */
export const zoomAt = (before: TLAxis, after: TLAxis, pointerX: number, scrollLeft: number): number =>
  scrollFor(after, timeAt(before, scrollLeft, pointerX), pointerX);

/** Where following keeps "now" in a chart viewport `viewWidth` px wide: `future` + PAD_R px from
 *  its right edge, which is all the content has right of now, so the texts there end inside the
 *  viewport. */
export const followOffset = (viewWidth: number, future: number): number => Math.max(0, viewWidth - future - K.PAD_R);
/** The follow rule: the scrollLeft that keeps now `offset` px from the viewport's left edge; with
 *  the offset above, scrollLeft = nowX + future + PAD_R − viewWidth: the content's end. */
export const followLeft = (nowX: number, offset: number): number => Math.max(0, nowX - offset);
/** Whether the now line is inside the chart viewport. */
export const nowInView = (nowX: number, scrollLeft: number, viewWidth: number): boolean =>
  nowX >= scrollLeft && nowX <= scrollLeft + viewWidth;
/** What a horizontal scroll by the user does to following: while now stays in view following goes
 *  on, keeping now where the user put it (`offset`); once now is out of view it ends. */
export function followAfterScroll(nowX: number, scrollLeft: number, viewWidth: number): { follow: boolean; offset: number | null } {
  return nowInView(nowX, scrollLeft, viewWidth) ? { follow: true, offset: nowX - scrollLeft } : { follow: false, offset: null };
}

/** The scrollLeft that brings the marks from x1 to x2 into a viewport `viewWidth` px wide, moving
 *  as little as it can; the same scrollLeft when they are in view already. Marks wider than the
 *  viewport are left alone while a part of them shows, else shown from their end. */
export function revealLeft(x1: number, x2: number, scrollLeft: number, viewWidth: number, pad = 24): number {
  const a = scrollLeft + pad, b = scrollLeft + viewWidth - pad;
  if (x1 >= a && x2 <= b) return scrollLeft;
  if (x2 - x1 > b - a) return x2 > a && x1 < b ? scrollLeft : Math.max(0, x2 - viewWidth + pad);
  return Math.max(0, x1 < a ? x1 - pad : x2 - viewWidth + pad);
}

/** How long a live timeline keeps its layout: the time of half a pixel, at least a second. */
export const relayoutQuantum = (ppm: number): number => Math.max(1000, 30000 / ppm);
/** Whether a layout made at `last` is due again at `now`: the two are in different quanta. */
export function relayoutDue(last: number, now: number, ppm: number): boolean {
  const q = relayoutQuantum(ppm);
  return Math.floor(now / q) !== Math.floor(last / q);
}

// ---- the row filter

/** Which tasks are listed: all, those not done / failed / cancelled, or the selected task with
 *  everything it needs and everything that needs it. */
export type RowFilter = "all" | "open" | "related";
const isOpen = (t: TLTask) => { const s = taskState(t); return s !== "done" && s !== "failed" && s !== "cancelled"; };
const relatedTo = (run: Pick<TLRun, "tasks">, id: string | null | undefined): Set<string> | null => {
  if (!id || !run.tasks.some((t) => t.id === id)) return null;
  const c = chainOf(run, id), have = new Set(run.tasks.map((t) => t.id));
  return new Set([id, ...c.up, ...c.down].filter((x) => have.has(x))); // a dependency on a task the run does not have is no row
};
/** The ids the filter leaves, for the layout's `only`; null for all. "related" without a selected
 *  task of the run is all. */
export function rowFilter(run: Pick<TLRun, "tasks">, rows: RowFilter, selTask?: string | null): Set<string> | null {
  if (rows === "open") return new Set(run.tasks.filter(isOpen).map((t) => t.id));
  return rows === "related" ? relatedTo(run, selTask) : null;
}
/** How many rows each filter leaves; `related` is null without a selected task of the run. */
export function rowCounts(run: Pick<TLRun, "tasks">, selTask?: string | null): { all: number; open: number; related: number | null } {
  return { all: run.tasks.length, open: run.tasks.filter(isOpen).length, related: relatedTo(run, selTask)?.size ?? null };
}

// ---- the keyboard

/** ↑ / ↓ through a list (the visible rows, or the turns): the item `by` places after `cur`, the
 *  first or last one when `cur` is not in the list, and `cur` itself at either end. */
export function stepIn<T>(list: readonly T[], cur: T | null | undefined, by: 1 | -1): T | null {
  if (!list.length) return null;
  const i = cur == null ? -1 : list.indexOf(cur);
  if (i < 0) return by > 0 ? list[0] : list[list.length - 1];
  return list[clamp(0, i + by, list.length - 1)];
}
