import { test } from "node:test";
import assert from "node:assert/strict";
import { kindLabel, pausedLine, retryLine, waitWords } from "../src/logic/retry.ts";
import type { Retry } from "../src/types.ts";

const NOW = 1_000_000;
const r = (extra: Partial<Retry> = {}): Retry => ({ attempt: 2, of: 4, kind: "login", ...extra });

test("waitWords: seconds below a minute, minutes from it, both rounded up", () => {
  assert.equal(waitWords(1), "1 s");
  assert.equal(waitWords(40_000), "40 s");
  assert.equal(waitWords(40_001), "41 s");
  assert.equal(waitWords(59_000), "59 s");
  assert.equal(waitWords(59_001), "1 min");
  assert.equal(waitWords(60_000), "1 min");
  assert.equal(waitWords(60_001), "2 min");
  assert.equal(waitWords(180_000), "3 min");
  assert.equal(waitWords(0), "0 s");
  assert.equal(waitWords(-5), "0 s");
});

test("retryLine: the time to the attempt while it is due later, else just the attempt", () => {
  assert.equal(retryLine(r({ at: NOW + 41_000 }), NOW), "Retrying in 41 s · 2 of 4");
  assert.equal(retryLine(r({ at: NOW + 40_000 }), NOW), "Retrying in 40 s · 2 of 4");
  assert.equal(retryLine(r({ at: NOW + 180_000 }), NOW), "Retrying in 3 min · 2 of 4");
  assert.equal(retryLine(r({ at: NOW }), NOW), "Retrying · 2 of 4", "due now");
  assert.equal(retryLine(r({ at: NOW - 5_000 }), NOW), "Retrying · 2 of 4", "in the past: it waits for the limiter or runs");
  assert.equal(retryLine(r(), NOW), "Retrying · 2 of 4", "no time");
  assert.equal(retryLine(r({ attempt: 1, at: NOW + 20_000 }), NOW), "Retrying in 20 s · 1 of 4");
});

test("kindLabel: the labels of the classes, a general one for the rest", () => {
  assert.equal(kindLabel("login"), "login failed");
  assert.equal(kindLabel("rate_limit"), "rate limited");
  assert.equal(kindLabel("overloaded"), "overloaded");
  assert.equal(kindLabel("server_error"), "server error");
  assert.equal(kindLabel("retried"), "temporary error");
  assert.equal(kindLabel("something new"), "temporary error");
  assert.equal(kindLabel(""), "temporary error");
  assert.equal(kindLabel(undefined), "temporary error");
  assert.equal(kindLabel("toString"), "temporary error", "not a property of the table's prototype");
});

test("pausedLine: Paused, then why", () => {
  assert.equal(pausedLine({ errorKind: "login" }), "Paused · login failed");
  assert.equal(pausedLine({ errorKind: "rate_limit" }), "Paused · rate limited");
  assert.equal(pausedLine({}), "Paused · temporary error");
});
