// The texts a run's dock loads on demand, through one cache for the life of the page
// (logic/runtexts.ts has the rule): a view names what it wants by key and gets what there is of
// it now. Nothing is fetched for a view that is not shown, and an answer is only ever shown for
// the key it was asked with.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { TextCache, type TextState } from "../logic/runtexts.ts";
import type { AttemptChanges, AttemptReport, RunGoal, RunNotes, TaskBrief } from "../types.ts";

const cache = new TextCache();

/** Forgets the texts of a run: it was left for another item, or removed. */
export const dropTexts = (run: string): void => cache.drop(run + "/");
const LOADING: TextState<never> = { s: "loading" };

export type Text<T> = TextState<T> & { retry(): void };

/**
 * The text of `key` (null: none is wanted, nothing is fetched). `final`: the text never changes,
 * so the answer is kept; otherwise it is fetched again whenever a view asks. `fetch` may be a new
 * function every render.
 */
export function useText<T>(key: string | null, fetch: () => Promise<T>, final: boolean): Text<T> {
  const [got, setGot] = useState<{ key: string; state: TextState<T> } | null>(null);
  const [again, setAgain] = useState(0);
  const load = useRef(fetch);
  load.current = fetch;
  useEffect(() => {
    if (!key || cache.peek(key)) return;
    let gone = false;
    void cache.load<T>(key, () => load.current(), final).then((state) => { if (!gone) setGot({ key, state }); });
    return () => { gone = true; };
  }, [key, final, again]);
  const retry = useCallback(() => { setGot(null); setAgain((n) => n + 1); }, []);
  const state: TextState<T> = (key ? cache.peek<T>(key) : undefined) ?? (key && got?.key === key ? got.state : LOADING);
  return { ...state, retry };
}

/** The run's goal. */
export const useGoal = (run: string): Text<RunGoal> => useText(`${run}/goal`, () => api.runGoal(run), true);

/** One revision of a task's brief. */
export const useBrief = (run: string, task: string, rev: number): Text<TaskBrief> =>
  useText(`${run}/brief/${task}/${rev}`, () => api.taskBrief(run, task, rev), true);

/** An attempt's report. `want`: the attempt has one (its result is in the detail). */
export const useReport = (run: string, task: string, n: number, want: boolean): Text<AttemptReport> =>
  useText(want ? `${run}/report/${task}/${n}` : null, () => api.attemptReport(run, task, n), true);

/** An attempt's changes as of its commit `head` (null: it has committed nothing, nothing is
 *  asked). They are final once the attempt has ended: until then the merge is still to come. */
export const useChanges = (run: string, task: string, n: number, head: string | null, ended: boolean): Text<AttemptChanges> =>
  useText(head ? `${run}/changes/${task}/${n}/${head}` : null, () => api.attemptChanges(run, task, n), ended);

/** One version of the orchestrator's notes (0: none). */
export const useNotes = (run: string, v: number): Text<RunNotes> =>
  useText(v > 0 ? `${run}/notes/${v}` : null, () => api.runNotes(run, v), true);
