// The host's sender (design 2.4): one `out` call in flight, the gap between starts, everything queued meanwhile in the next call,
// order per session, closes after their messages, a failed call sent again in front, a refused one dropped, `gone` reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLink, NoRetry, type OutBody } from "../src/link.ts";
import { until, wait } from "./support.ts";

function rig(o: { gap?: number; answer?: (b: OutBody, n: number) => Promise<string[]> } = {}) {
  const bodies: OutBody[] = [];
  const starts: number[] = [];
  let inFlight = 0, maxInFlight = 0;
  const gone: string[][] = [];
  const lines: string[] = [];
  const link = createLink({
    sendGapMs: o.gap ?? 0, retryMs: 10, log: (l) => lines.push(l), onGone: (s) => gone.push(s),
    post: async (b) => {
      bodies.push(structuredClone(b));
      starts.push(Date.now());
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { return o.answer ? await o.answer(b, bodies.length) : (await wait(5), []); } finally { inFlight--; }
    },
  });
  return { link, bodies, starts, gone, lines, max: () => maxInFlight };
}

const messagesOf = (bodies: OutBody[], session: string) => bodies.flatMap((b) => (b.out ?? []).filter((o) => o.session === session).flatMap((o) => o.messages));

test("one call in flight; what is queued meanwhile goes together, in order per session", async () => {
  const r = rig({ answer: async () => { await wait(30); return []; } });
  for (let i = 0; i < 50; i++) { r.link.queue("s_a", `a${i}`); r.link.queue("s_b", `b${i}`); await wait(i % 10 ? 0 : 3); }
  await r.link.flush();
  assert.equal(r.max(), 1);
  assert.ok(r.bodies.length < 20, `${r.bodies.length} calls for 100 messages`);
  assert.deepEqual(messagesOf(r.bodies, "s_a"), Array.from({ length: 50 }, (_, i) => `a${i}`));
  assert.deepEqual(messagesOf(r.bodies, "s_b"), Array.from({ length: 50 }, (_, i) => `b${i}`));
  assert.equal(r.link.busy(), false);
});

test("calls start at least the gap apart", async () => {
  const r = rig({ gap: 40, answer: async () => [] });
  for (let i = 0; i < 4; i++) { r.link.queue("s_a", `m${i}`); await until(() => r.bodies.length === i + 1, `call ${i + 1}`); }
  for (let i = 1; i < r.starts.length; i++) assert.ok(r.starts[i] - r.starts[i - 1] >= 35, `gap ${r.starts[i] - r.starts[i - 1]} ms`);
});

test("a close goes after the session's messages, and nothing of the session after it", async () => {
  const r = rig();
  r.link.queue("s_a", "1");
  r.link.closed("s_a", "CLIENT_TOO_OLD");
  r.link.queue("s_a", "2");
  await r.link.flush();
  assert.deepEqual(r.bodies, [{ out: [{ session: "s_a", messages: ["1"] }], closed: [{ session: "s_a", reason: "CLIENT_TOO_OLD" }] }]);
});

test("a failed call is sent again with its messages in front; a refused one is dropped", async () => {
  const r = rig({ answer: async (_b, n) => {
    if (n === 1) throw new Error("no answer");
    if (n === 3) throw new NoRetry("not_board_host");
    return [];
  } });
  r.link.queue("s_a", "1");
  await until(() => r.bodies.length >= 1, "the first call");
  r.link.queue("s_a", "2");
  await until(() => r.bodies.length >= 2, "the retry");
  await r.link.flush();
  assert.deepEqual(r.bodies[1], { out: [{ session: "s_a", messages: ["1", "2"] }] });
  r.link.queue("s_a", "3");
  await r.link.flush();
  r.link.queue("s_a", "4");
  await r.link.flush();
  assert.deepEqual(messagesOf(r.bodies, "s_a"), ["1", "1", "2", "3", "4"]);
  assert.ok(r.lines.some((l) => /trying again/.test(l)) && r.lines.some((l) => /refused/.test(l)));
});

test("gone sessions are reported", async () => {
  const r = rig({ answer: async () => ["s_b"] });
  r.link.queue("s_b", "x");
  await r.link.flush();
  assert.deepEqual(r.gone, [["s_b"]]);
});

test("flush does not wait for the gap", async () => {
  const r = rig({ gap: 10_000, answer: async () => [] });
  r.link.queue("s_a", "1");
  await until(() => r.bodies.length === 1, "the first call");
  r.link.queue("s_a", "2");
  const t0 = Date.now();
  await r.link.flush();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.bodies.length, 2);
  r.link.stop();
});
