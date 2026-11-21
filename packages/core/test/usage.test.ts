import { test } from "node:test";
import assert from "node:assert/strict";
import { resetIn, resetAt, limitTone, updatedAgo, isStale, sortLimits, tightestLimit, gaugeState, usedWords, usageCheckAt, type AgentPlan } from "../src/logic/usage.ts";

const now = Date.parse("2026-09-26T18:54:40Z");
const at = (ms: number) => new Date(now + ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN;

test("resetIn", () => {
  assert.equal(resetIn(undefined, now), "");
  assert.equal(resetIn("nonsense", now), "");
  assert.equal(resetIn(at(-5000), now), "any moment");
  assert.equal(resetIn(at(30_000), now), "any moment");
  assert.equal(resetIn(at(12 * MIN + 5000), now), "in 12m");
  assert.equal(resetIn(at(4 * HOUR + 15 * MIN), now), "in 4h 15m");
  assert.equal(resetIn(at(3 * HOUR), now), "in 3h");
  assert.equal(resetIn(at(2 * 24 * HOUR + 3 * HOUR + 20 * MIN), now), "in 2d 3h");
  assert.equal(resetIn(at(24 * HOUR), now), "in 1d");
});

test("resetAt: in the given zone", () => {
  const z = "Europe/Belgrade"; // now is 20:54 there, Saturday
  assert.equal(resetAt("2026-09-26T21:30:00Z", now, "en-US", z), "11:30 PM");
  assert.equal(resetAt("2026-09-26T23:09:59Z", now, "en-US", z), "Sun 1:09 AM");
  assert.equal(resetAt("2026-09-28T16:59:59Z", now, "en-US", z), "Mon 6:59 PM");
  assert.equal(resetAt("2026-10-03T16:59:00Z", now, "en-US", z), "Oct 3, 6:59 PM");
  assert.equal(resetAt(undefined, now), "");
});

test("limitTone", () => {
  assert.equal(limitTone({ percent: 8, severity: "normal" }), "ok");
  assert.equal(limitTone({ percent: 8 }), "ok");
  assert.equal(limitTone({ percent: 8, severity: "warning" }), "warn");
  assert.equal(limitTone({ percent: 51 }), "warn");
  assert.equal(limitTone({ percent: 81, severity: "normal" }), "danger");
});

test("updatedAgo", () => {
  assert.equal(updatedAgo(at(-3000), now), "just now");
  assert.equal(updatedAgo(at(-12_000), now), "12s ago");
  assert.equal(updatedAgo(at(-3 * MIN), now), "3m ago");
  assert.equal(updatedAgo(at(-2 * HOUR), now), "2h ago");
});

test("isStale", () => {
  assert.equal(isStale(at(-3 * MIN), now), false);
  assert.equal(isStale(at(-10 * MIN), now), false);
  assert.equal(isStale(at(-11 * MIN), now), true);
  assert.equal(isStale("nonsense", now), false);
});

test("sortLimits: session, week, then the rest in order", () => {
  const l = (kind: string, label = kind) => ({ kind, label, percent: 0 });
  const got = sortLimits([l("weekly_scoped", "Fable"), l("weekly_all"), l("weekly_scoped", "Opus"), l("session"), l("new_kind")]);
  assert.deepEqual(got.map((x) => x.label), ["session", "weekly_all", "Fable", "Opus", "new_kind"]);
});

test("tightest plan limit compares used share and then the latest reset", () => {
  const plan = (agent: AgentPlan["agent"], percent: number, resetsAt?: string): AgentPlan => ({
    agent, usage: { plan: true, fetchedAt: at(0), limits: [{ kind: "session", label: "Session", percent, resetsAt }] },
  });
  const noPlan: AgentPlan = { agent: "pi", usage: { plan: false, fetchedAt: at(0), limits: [] } };
  const codex = plan("codex", 82, at(2 * HOUR));
  const claude = plan("claude", 82);
  const account = plan("claude:a_work0001", 82, at(3 * HOUR));
  assert.equal(tightestLimit([noPlan, claude, codex, account])?.agent, account.agent);
  assert.equal(tightestLimit([account, plan("cursor", 83)])?.agent, "cursor");
  assert.equal(tightestLimit([{ ...account, error: "Unavailable" }, noPlan, codex])?.agent, "codex");
  assert.equal(tightestLimit([noPlan, { ...account, error: "Unavailable" }]), undefined);
  assert.equal(gaugeState([{ ...account, error: "Unavailable" }, { ...codex, error: "Offline" }, noPlan]), "failed");
  assert.equal(gaugeState([noPlan]), "hidden");
  assert.equal(gaugeState([{ agent: "claude", loading: true }, noPlan]), "empty");
  assert.equal(gaugeState([claude, account, noPlan]), "ready");
  assert.equal(tightestLimit([plan("codex", 106), plan("cursor", 110, at(HOUR))])?.agent, "cursor");
});

test("percent used is clamped and changes tone at the established boundaries", () => {
  for (let percent = 0; percent <= 100; percent++) assert.equal(usedWords(percent), `${percent}% used`);
  assert.equal(usedWords(-5), "0% used");
  assert.equal(usedWords(102), "100% used");
  assert.equal(usedWords(37.5), "38% used");
  assert.equal(limitTone({ percent: 50 }), "ok");
  assert.equal(limitTone({ percent: 50.1 }), "warn");
  assert.equal(limitTone({ percent: 80 }), "warn");
  assert.equal(limitTone({ percent: 80.1 }), "danger");
  assert.equal(limitTone({ percent: 0, severity: "warning" }), "warn");
});

test("foreground plan checks use the working, idle and turn-end intervals", () => {
  const next = (working: boolean, turnEnded: boolean, foreground = true, last: number | undefined = now) =>
    usageCheckAt({ foreground, working, turnEnded, last });
  assert.equal(next(true, false), now + 5 * MIN);
  assert.equal(next(false, false), now + 30 * MIN);
  assert.equal(next(false, true), now + MIN);
  assert.equal(next(true, true), now + MIN);
  assert.equal(next(true, true, false), Infinity);
  assert.equal(usageCheckAt({ foreground: true, working: false, turnEnded: false }), 0);
});
