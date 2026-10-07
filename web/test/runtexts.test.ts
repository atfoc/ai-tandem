import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TextCache, isNone, type Held } from "../src/logic/runtexts.ts";

/** A fetch that counts its calls and answers what it is told to. */
function source<T>(answer: () => Promise<T>) {
  const s = { calls: 0, fetch: () => { s.calls++; return answer(); } };
  return s;
}
const notFound = () => Promise.reject(Object.assign(new Error("nothing recorded yet"), { status: 404 }));

test("a final text is fetched once and kept", async () => {
  const c = new TextCache(), src = source(() => Promise.resolve({ text: "the brief" }));
  assert.equal(c.peek("r/brief/T01/1"), undefined);
  assert.deepEqual(await c.load("r/brief/T01/1", src.fetch, true), { s: "ok", value: { text: "the brief" } });
  assert.deepEqual(c.peek("r/brief/T01/1"), { s: "ok", value: { text: "the brief" } });
  assert.deepEqual(await c.load("r/brief/T01/1", src.fetch, true), { s: "ok", value: { text: "the brief" } });
  assert.equal(src.calls, 1);
  // another key is another text
  await c.load("r/brief/T01/2", src.fetch, true);
  assert.equal(src.calls, 2); assert.equal(c.size, 2);
});

test("what can still change is asked for again: a running attempt's changes, and its absence of a text", async () => {
  const c = new TextCache();
  const none = source(notFound);
  assert.deepEqual(await c.load("r/report/T01/1", none.fetch, false), { s: "none" });
  assert.equal(c.peek("r/report/T01/1"), undefined, "the absence is not kept");
  assert.deepEqual(await c.load("r/report/T01/1", none.fetch, false), { s: "none" });
  assert.equal(none.calls, 2);
  const live = source(() => Promise.resolve({ files: 3 }));
  await c.load("r/changes/T01/1", live.fetch, false); await c.load("r/changes/T01/1", live.fetch, false);
  assert.equal(live.calls, 2); assert.equal(c.size, 0);
  // "there is none" is never kept, final or not: a text that is written later is found
  assert.deepEqual(await c.load("r/changes/T01/1", none.fetch, true), { s: "none" });
  assert.deepEqual(await c.load("r/changes/T01/1", none.fetch, true), { s: "none" });
  assert.equal(none.calls, 4); assert.equal(c.peek("r/changes/T01/1"), undefined);
});

test("at most `max` texts are kept, the oldest go first; a run's texts go with the run", async () => {
  const c = new TextCache(3);
  for (const k of ["r_a/goal", "r_a/notes/1", "r_b/goal", "r_b/notes/1"]) await c.load(k, () => Promise.resolve(k), true);
  assert.equal(c.size, 3);
  assert.equal(c.peek("r_a/goal"), undefined);
  assert.deepEqual(c.peek("r_b/notes/1"), { s: "ok", value: "r_b/notes/1" });
  c.drop("r_b/");
  assert.equal(c.size, 1);
  assert.deepEqual(c.peek("r_a/notes/1"), { s: "ok", value: "r_a/notes/1" });
  // a request that runs for a dropped run is not shared with the next caller
  let done!: (v: string) => void;
  const slow = c.load("r_c/goal", () => new Promise<string>((ok) => { done = ok; }), true);
  c.drop("r_c/");
  let calls = 0;
  const again = c.load("r_c/goal", () => { calls++; return Promise.resolve("new"); }, true);
  done("old");
  assert.deepEqual([await slow, await again, calls], [{ s: "ok", value: "old" }, { s: "ok", value: "new" }, 1]);
});

test("a failure is never kept: Retry asks again", async () => {
  const c = new TextCache();
  let fail = true;
  const src = source(() => (fail ? Promise.reject(new Error("the server is down")) : Promise.resolve("text")));
  assert.deepEqual(await c.load("r/notes/3", src.fetch, true), { s: "error", message: "the server is down" });
  assert.equal(c.peek("r/notes/3"), undefined);
  fail = false;
  assert.deepEqual(await c.load("r/notes/3", src.fetch, true), { s: "ok", value: "text" });
  assert.equal(src.calls, 2);
  assert.deepEqual(await new TextCache().load("k", () => Promise.reject("plain"), true), { s: "error", message: "plain" });
});

test("callers that ask while a request runs share it", async () => {
  const c = new TextCache();
  let done!: (v: string) => void;
  const src = source(() => new Promise<string>((ok) => { done = ok; }));
  const a = c.load("r/goal", src.fetch, true), b = c.load("r/goal", src.fetch, true);
  done("the goal");
  assert.deepEqual(await Promise.all([a, b]), [{ s: "ok", value: "the goal" }, { s: "ok", value: "the goal" }]);
  assert.equal(src.calls, 1);
});

test("only the server's 404 means there is no text", () => {
  assert.equal(isNone(Object.assign(new Error("x"), { status: 404 })), true);
  assert.equal(isNone(Object.assign(new Error("x"), { status: 409 })), false);
  assert.equal(isNone(new Error("x")), false); assert.equal(isNone(null), false); assert.equal(isNone("404"), false);
});

// ---- what a view shows after a drop (`server_back` drops a run's texts under the dock that shows them)

test("a view that took its text from the cache keeps showing it after a drop; one that opens after it loads", async () => {
  const c = new TextCache(), goal = { s: "ok", value: "the goal" } as const;
  await c.load("r_1/goal", () => Promise.resolve("the goal"), true); // the first visit of the Goal tab fetched it
  assert.equal(c.open("r_1/notes/1"), null, "nothing is kept of it: the view has to load");
  const own = c.open<string>("r_1/goal"); // the second visit takes the kept answer as its own copy
  assert.deepEqual(own, { key: "r_1/goal", state: goal });
  assert.deepEqual(c.shown("r_1/goal", own), goal);

  c.drop("r_1/"); // server_back
  assert.equal(c.peek("r_1/goal"), undefined);
  assert.deepEqual(c.shown("r_1/goal", own), goal, "the view on screen shows its copy: nothing would ask again");
  assert.deepEqual(c.shown("r_1/goal", null), { s: "loading" }, "a view with no copy is loading, and its effect loads");
  assert.equal(c.open("r_1/goal"), null, "a view that opens now loads");

  // a copy is only ever shown for the key it was asked with
  assert.deepEqual(c.shown("r_1/notes/2", own), { s: "loading" });
  assert.deepEqual(c.shown(null, own), { s: "loading" });
  // the kept answer comes before the copy; what is never kept (a running attempt's changes) is the view's copy alone
  await c.load("r_1/goal", () => Promise.resolve("read again"), true);
  assert.deepEqual(c.shown("r_1/goal", own), { s: "ok", value: "read again" });
  const live: Held<number> = { key: "r_1/changes/T01/1/abc", state: await c.load("r_1/changes/T01/1/abc", () => Promise.resolve(3), false) };
  assert.deepEqual(c.shown(live.key, live), { s: "ok", value: 3 });
});

test("useText holds a copy of what it takes from the cache, and shows by the cache's rule", () => {
  const src = readFileSync(new URL("../src/run/texts.ts", import.meta.url), "utf8");
  const hook = src.slice(src.indexOf("export function useText"), src.indexOf("/** The run's goal. */"));
  assert.match(hook, /const kept = cache\.open<T>\(key\);\s*if \(kept\) \{ setGot\(kept\); return; \}/);
  assert.match(hook, /return \{ \.\.\.cache\.shown\(key, got\), retry \};/);
  assert.doesNotMatch(hook, /cache\.peek/, "no path shows the cache's answer alone");
});
