// What the run view does to a run (stop, resume), and the one thing it remembers between visits:
// the dock's height (localStorage "aiwb.run.ui").
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { api } from "../api.ts";
import { answerRun, safeGet, safeSet } from "../store.ts";

/** The run's view again, with its folder and what blocks it checked again (the server checks them
 *  when it is asked, not by itself). Never rejects. */
export const refreshRun = (id: string): Promise<void> => answerRun(id, () => api.run(id)).then(() => {}, () => {});

/** Asks again while the page shows a fact that the user can change outside the app (a folder, a
 *  commit, an installed program): now, and whenever the window gets the focus. */
export function useFresh(id: string, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const f = () => void refreshRun(id);
    f();
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [id, on]);
}

/** Stops a running run. The answer is the run "stopping"; `run` events follow. */
export async function stopRun(id: string): Promise<void> {
  await answerRun(id, () => api.stopRun(id));
}

/** Resumes a stopped, stalled or failed run; `raise` sets the one limit that stalled it higher. */
export async function resumeRun(id: string, raise?: { maxTurns: number } | { maxCost: number }): Promise<void> {
  await answerRun(id, () => api.resumeRun(id, raise));
}

/** dockH: the open dock's height in px (absent: 46% of its area). */
export type RunUi = { dockH?: number };
const KEY = "aiwb.run.ui";

export function loadUi(): RunUi {
  try {
    const v = JSON.parse(safeGet(KEY) ?? "{}");
    return typeof v?.dockH === "number" && v.dockH > 0 ? { dockH: v.dockH } : {};
  } catch { return {}; }
}

/** Sets it; `dockH: undefined` forgets the height. */
export function saveUi(patch: RunUi): void {
  const next: RunUi = { ...loadUi(), ...patch };
  if (next.dockH === undefined) delete next.dockH;
  safeSet(KEY, JSON.stringify(next));
}

/** The size of an element, kept current: of the one the ref holds, or of what `pick` finds from
 *  it (its parent, the stage it is in). 0 × 0 until measured. `on`: the element is rendered (it
 *  is measured from the render in which it appears). */
export function useSize(ref: RefObject<HTMLElement | null>, pick?: (el: HTMLElement) => HTMLElement | null, on = true): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current && (pick ? pick(ref.current) : ref.current);
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [on]);
  return size;
}

/** Under this stage width the run's bar, meters and chips say less. */
export const NARROW = 760;
/** Under this one (the side panel open in a small window) buttons lose their words and the head its slots meter and apply chip. */
export const TIGHT = 480;
