import { test } from "node:test";
import assert from "node:assert/strict";

import { checkPlanUsage, forgetPlanUsage, planUsageEvent, planUsageOf, planUsagePending } from "../src/state/planusage.ts";
import type { PlanUsage } from "../src/types.ts";
import { installFake, ok } from "./fixtures/faketransport.ts";

const plan = (percent: number, minutes = 0): PlanUsage => ({
  plan: true,
  fetchedAt: new Date(Date.UTC(2026, 10, 21, 12, minutes)).toISOString(),
  limits: [{ kind: "session", label: "Session", percent }],
});

function heldAnswer() {
  let resolve!: (answer: ReturnType<typeof ok>) => void;
  const promise = new Promise<ReturnType<typeof ok>>((finish) => { resolve = finish; });
  return { promise, resolve };
}

test("per-agent results arrive before the batch finishes and refresh keeps the last numbers", async () => {
  const fake = installFake();
  const response = heldAnswer();
  fake.handler = () => response.promise;

  const server = "s_test";
  const first = checkPlanUsage(server, ["claude", "codex"], false);
  assert.equal(planUsagePending(server), true);
  assert.equal(planUsageOf(server).codex?.loading, true);
  await checkPlanUsage(server, ["claude", "codex"], false);
  assert.equal(fake.calls.length, 1);
  const request = new URL(fake.calls[0].path, "https://test.invalid").searchParams.get("request")!;
  planUsageEvent(server, request, { agent: "codex", usage: plan(82) });
  planUsageEvent(server, "old-request", { agent: "claude", usage: plan(0) });
  assert.equal(planUsageOf(server).codex?.usage?.limits[0].percent, 82);
  assert.equal(planUsageOf(server).codex?.loading, false);
  assert.equal(planUsageOf(server).claude?.usage, undefined);
  planUsageEvent(server, undefined, { agent: "codex", usage: plan(85, 1) });

  response.resolve(ok([{ agent: "claude", error: "Offline" }, { agent: "codex", usage: plan(82) }]));
  await first;
  assert.equal(planUsagePending(server), false);
  assert.equal(planUsageOf(server).claude?.error, "Offline");
  assert.equal(planUsageOf(server).codex?.usage?.limits[0].percent, 85);

  const second = heldAnswer();
  fake.handler = () => second.promise;
  const refresh = checkPlanUsage(server, ["claude", "codex"], true);
  assert.equal(planUsageOf(server).codex?.loading, true);
  assert.equal(planUsageOf(server).codex?.usage?.limits[0].percent, 85);
  assert.match(fake.calls[1].path, /fresh=1/);
  forgetPlanUsage(server);
  assert.equal(fake.calls[1].signal?.aborted, true);
  second.resolve(ok([{ agent: "codex", usage: plan(90) }]));
  await refresh;
  assert.deepEqual(planUsageOf(server), {});
});
