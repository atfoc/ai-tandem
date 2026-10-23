// The sentences of an agent that is retried after a temporary error, or paused when the retries ran out
// (model.Retry, model.SubPaused). DOM-free.
import type { Retry, Subagent } from "../types.ts";

const KIND_LABELS: Record<string, string> = {
  login: "login failed", rate_limit: "rate limited", overloaded: "overloaded", server_error: "server error",
};

/** What a temporary error was (agent.Temporary): "login failed", "rate limited", "overloaded", "server error";
 *  "temporary error" for any other class, and for none. */
export const kindLabel = (kind?: string): string => Object.hasOwn(KIND_LABELS, kind ?? "") ? KIND_LABELS[kind!] : "temporary error";

/** A wait in words: "N s" below a minute, else "N min", both rounded up. */
export function waitWords(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

/** The line of an agent that is retried: "Retrying in 40 s · 2 of 4" while the attempt is due later, else
 *  "Retrying · 2 of 4" (it waits for its turn to start, or runs). now: unix ms. */
export const retryLine = (r: Retry, now: number): string =>
  r.at && r.at > now ? `Retrying in ${waitWords(r.at - now)} · ${r.attempt} of ${r.of}` : `Retrying · ${r.attempt} of ${r.of}`;

/** The line of a paused subagent: "Paused · login failed". */
export const pausedLine = (sa: Pick<Subagent, "errorKind">): string => `Paused · ${kindLabel(sa.errorKind)}`;
