// The texts of a run that are loaded on demand (its goal, a brief revision, an attempt's report and
// changes, a notes version): what is kept once it was fetched, and what is asked for again.
// DOM-free.

/** What a view has of a text: nothing yet, the text, the server's "there is none" (a 404: no
 *  report yet, a task with no changes), or a failure it can try again. */
export type TextState<T> = { s: "loading" } | { s: "ok"; value: T } | { s: "none" } | { s: "error"; message: string };

/** Whether a failed request means "there is no such text": the server's 404. */
export const isNone = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { status?: unknown }).status === 404;

/**
 * The answers kept for the life of the page, by key (run + what). An answer is kept only when it
 * is `final` and a text: the text of something that never changes (a brief revision, a notes
 * version, the report of an attempt that has its result). What can still change is asked for again
 * every time: a running attempt's changes, and the absence of a text (a 404). A failure is never
 * kept. At most `max` answers are kept, and a run's go when the run is left (drop). Callers that
 * ask for the same key while its request runs share that request.
 */
export class TextCache {
  private kept = new Map<string, TextState<unknown>>();
  private flying = new Map<string, Promise<TextState<unknown>>>();
  private max: number;
  /** max: how many answers are kept at most. */
  constructor(max = 300) { this.max = max; }

  /** The kept answer of `key`; undefined when it has to be loaded. */
  peek<T>(key: string): TextState<T> | undefined {
    return this.kept.get(key) as TextState<T> | undefined;
  }

  /** The answer of `key`: the kept one, else the request's (one request per key at a time). */
  load<T>(key: string, fetch: () => Promise<T>, final: boolean): Promise<TextState<T>> {
    const hit = this.kept.get(key);
    if (hit) return Promise.resolve(hit as TextState<T>);
    const run = this.flying.get(key);
    if (run) return run as Promise<TextState<T>>;
    const p: Promise<TextState<T>> = fetch().then(
      (value): TextState<T> => ({ s: "ok", value }),
      (e): TextState<T> => (isNone(e) ? { s: "none" } : { s: "error", message: e instanceof Error && e.message ? e.message : String(e) }),
    ).then((state) => {
      if (this.flying.get(key) !== p) return state; // dropped meanwhile: the answer goes to who asked, and is not kept
      this.flying.delete(key);
      // only a text is kept: "there is none" may change (a report that is written later), a failure is tried again
      if (final && state.s === "ok") {
        this.kept.set(key, state);
        for (const old of this.kept.keys()) { if (this.kept.size <= this.max) break; this.kept.delete(old); } // the oldest go first
      }
      return state;
    });
    this.flying.set(key, p);
    return p;
  }

  /** Forgets every answer whose key starts with `prefix` (a run that was left or removed). */
  drop(prefix: string): void {
    for (const k of [...this.kept.keys()]) if (k.startsWith(prefix)) this.kept.delete(k);
    for (const k of [...this.flying.keys()]) if (k.startsWith(prefix)) this.flying.delete(k);
  }

  /** How many answers are kept. */
  get size(): number { return this.kept.size; }
}
