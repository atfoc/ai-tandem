// What the run view does to a run (stop, resume), and the one thing it remembers between visits:
// the dock's height (localStorage "aiwb.run.ui").
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { api } from "../api.ts";
import { answerRun, getState, runNow, safeGet, safeSet, setRunStart, unsavedRunDraft } from "../store.ts";
import { startFailure } from "../logic/runcompose.ts";

/** The run's view again, with its folder and what blocks it checked again (the server checks them
 *  when it is asked, not by itself). Never rejects. */
export const refreshRun = (id: string): Promise<void> => answerRun(id, () => api.run(id)).then(() => {}, () => {});

/** Starts a draft run with its goal. Not optimistic: the stage changes when the server has
 *  recorded the start, and the goal's text stays in the box all along, so a start that fails has
 *  nothing to put back. The start's state is the store's, by run id (State.runStarts), and not
 *  the composer's: a draft that gets a new id while its start is on its way (a `run` event with
 *  `was`) takes it along, so the composer of the new id shows the start still running, and a
 *  refusal leaves its sentence, and reads the run again, under the id the run has by then
 *  (runNow). Returns the sentence of a refusal that is shown apart from the composer (goal_kept:
 *  the run has started with an earlier goal, and the composer goes away), else "". Never rejects. */
export async function startRun(id: string, goal: string): Promise<string> {
  if (getState().runStarts[id]?.starting) return "";
  setRunStart(id, { starting: true, error: "" });
  try {
    await answerRun(id, async () => {
      const started = await api.startRun(id, goal);
      unsavedRunDraft(runNow(id)).write(null); // only a start that worked clears the unsaved goal
      return started; // it has `started`: the stage changes to the follow view
    });
    setRunStart(runNow(id), null);
    return "";
  } catch (e) {
    const f = startFailure(e), now = runNow(id);
    setRunStart(now, { starting: false, error: f.kept ? "" : f.text });
    if (f.reread) void refreshRun(now); // it started, was archived, is being started, or its folder changed
    return f.kept ? f.text : "";
  }
}

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
