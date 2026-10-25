// The feed of the store's `localNetworkDenied` (platform/localnetworkfeed.ts): read once at start and when the app returns to the
// foreground, iOS only. The permission and the app state are fakes; the real ones are device-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import { feedLocalNetwork } from "../src/platform/localnetworkfeed.ts";
import type { LocalNetworkState } from "../src/platform/localnetwork.types.ts";

function fakes(first: LocalNetworkState) {
  let answer: Promise<LocalNetworkState> = Promise.resolve(first);
  const reads: number[] = [];
  const listeners = new Set<(s: string) => void>();
  const sets: boolean[] = [];
  return {
    sets, reads, listeners,
    answer: (p: Promise<LocalNetworkState>) => { answer = p; },
    change: (s: string) => { for (const l of [...listeners]) l(s); },
    args: (ios: boolean) => ({
      ios,
      port: { state: () => { reads.push(reads.length); return answer; } },
      appState: { addEventListener: (_: "change", l: (s: string) => void) => { listeners.add(l); return { remove: () => { listeners.delete(l); } }; } },
      set: (d: boolean) => { sets.push(d); },
    }),
  };
}
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

test("iOS: the permission is read at start and each time the app is active again", async () => {
  const f = fakes("denied");
  const stop = feedLocalNetwork(f.args(true));
  await settle();
  assert.deepEqual([f.reads.length, f.sets], [1, [true]]);
  f.answer(Promise.resolve("granted"));
  f.change("background");
  f.change("inactive");
  await settle();
  assert.equal(f.reads.length, 1, "only coming back to the foreground reads it");
  f.change("active");
  await settle();
  assert.deepEqual([f.reads.length, f.sets], [2, [true, false]]);
  stop();
  assert.equal(f.listeners.size, 0);
  f.change("active");
  assert.equal(f.reads.length, 2, "stopped");
});

test("'unknown' (asked for nothing yet) and a failed read are not a refusal", async () => {
  const f = fakes("unknown");
  feedLocalNetwork(f.args(true));
  await settle();
  assert.deepEqual(f.sets, [false]);
  f.answer(Promise.reject(new Error("no module")));
  f.change("active");
  await settle();
  assert.deepEqual(f.sets, [false], "a read that fails changes nothing");
});

test("a slow answer does not overwrite a newer one", async () => {
  const f = fakes("granted");
  let late!: (s: LocalNetworkState) => void;
  f.answer(new Promise<LocalNetworkState>((r) => { late = r; }));
  feedLocalNetwork(f.args(true));
  f.answer(Promise.resolve("denied"));
  f.change("active");
  await settle();
  late("granted");
  await settle();
  assert.deepEqual(f.sets, [true]);
});

test("not iOS (Android, the web build): nothing is read or listened to", async () => {
  const f = fakes("denied");
  const stop = feedLocalNetwork(f.args(false));
  f.change("active");
  await settle();
  assert.deepEqual([f.reads.length, f.sets, f.listeners.size], [0, [], 0]);
  stop();
});
