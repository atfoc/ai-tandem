// What the device self-tests share (architecture AD-83): a way to run cases one after the other and say what each did, with
// no test framework (Hermes has none; node:test is not there). The logic files (connSelfTest.ts, netSelfTest.ts) import
// nothing of React Native, so the same cases also run under Node (app/test/selftest.test.ts, `run.mjs --platform node`).

export type Outcome = { name: string; status: "pass" | "fail" | "skip"; detail?: string; ms: number };
/** `skip(reason)` skips the case; `note(text)` says something about a case that passed (a measurement), shown beside it. */
export type CaseContext = { skip(reason: string): void; note(text: string): void };
export type Case = { name: string; fn: (t: CaseContext) => Promise<void> | void };

/** The `env.test` of `runConnectorContract` (and a small `test` of our own): it collects the cases, `run` runs them. */
export function collector() {
  const cases: Case[] = [];
  return { cases, test: (name: string, fn: Case["fn"]) => { cases.push({ name, fn }); } };
}

export class Failure extends Error {}
const show = (v: unknown) => { try { return JSON.stringify(v); } catch { return String(v); } };
export const ok = (v: unknown, msg: string) => { if (!v) throw new Failure(msg); };
export const equal = (a: unknown, b: unknown, msg: string) => { if (a !== b) throw new Failure(`${msg}: got ${show(a)}, want ${show(b)}`); };

const messageOf = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Runs the cases in order; `say` is told each outcome as it happens. A case that throws fails; one that calls `skip` is skipped. */
export async function run(cases: Case[], say: (o: Outcome) => void = () => {}): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const c of cases) {
    const t0 = Date.now();
    let skipped: string | null = null;
    const noted: string[] = [];
    let o: Outcome;
    try {
      await c.fn({ skip: (reason) => { skipped = reason; }, note: (text) => { noted.push(text); } });
      o = skipped === null
        ? { name: c.name, status: "pass", ...(noted.length ? { detail: noted.join("; ") } : {}), ms: Date.now() - t0 }
        : { name: c.name, status: "skip", detail: skipped, ms: Date.now() - t0 };
    } catch (e) {
      o = { name: c.name, status: "fail", detail: messageOf(e), ms: Date.now() - t0 };
    }
    out.push(o);
    say(o);
  }
  return out;
}

export type Summary = { ok: boolean; pass: number; fail: number; skip: number; failed: Outcome[] };
export function summarize(outcomes: Outcome[], minimum = 1): Summary {
  const count = (s: Outcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const failed = outcomes.filter((o) => o.status === "fail");
  // A run that ran nothing proves nothing.
  return { ok: failed.length === 0 && count("pass") >= minimum, pass: count("pass"), fail: failed.length, skip: count("skip"), failed };
}

/** One line per outcome, the form the runner's collector prints. */
export const line = (o: Outcome) => `${o.status.toUpperCase().padEnd(4)} ${o.name}${o.detail ? ` -- ${o.detail}` : ""} (${o.ms} ms)`;
