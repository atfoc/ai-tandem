// The recent prompts of the Prompt sheet: this computer's kept in the app's storage, a remote server's in memory alone, three at most, newest first.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { setKv } from "@aiwb/core/state/ports.ts";

import { PROMPT_RECENT_KEY, forgetRecentPrompts, recentIds, recentPrompts, rememberPrompt } from "../src/screens/library/phone/promptrecent.ts";

let kvMap: Map<string, string>;

beforeEach(() => {
  kvMap = new Map();
  setKv({ get: (k) => kvMap.get(k) ?? null, set: (k, v) => { kvMap.set(k, v); }, remove: (k) => { kvMap.delete(k); }, keys: () => [...kvMap.keys()] });
  forgetRecentPrompts();
});

test("nothing is recent at first", () => {
  assert.deepEqual(recentIds(), []);
  assert.deepEqual(recentPrompts(), []);
});

test("this computer's prompts are kept in the storage as a list of ids, newest first, once, three at most", () => {
  for (const id of ["a", "b", "c", "b", "d"]) rememberPrompt("local", id);
  assert.deepEqual(recentIds("local"), ["d", "b", "c"]);
  assert.equal(kvMap.get(PROMPT_RECENT_KEY), JSON.stringify(["d", "b", "c"]));
  assert.equal(PROMPT_RECENT_KEY, "aiwb.prompts.recent");
});

test("a reload keeps this computer's list and drops a remote server's", () => {
  rememberPrompt("local", "p1");
  rememberPrompt("s_studio", "q1");
  assert.deepEqual(recentPrompts(), [{ server: "s_studio", id: "q1" }, { server: "local", id: "p1" }], "the remote one was inserted last");
  forgetRecentPrompts(); // (the page's memory is gone, the storage stays)
  assert.deepEqual(recentPrompts(), [{ server: "local", id: "p1" }]);
  assert.deepEqual(recentIds("s_studio"), []);
});

test("nothing of a remote server is written to the storage", () => {
  rememberPrompt("s_studio", "q1");
  assert.equal(kvMap.size, 0);
  assert.deepEqual(recentIds("s_studio"), ["q1"]);
});

test("the servers' prompts are listed together by when they were inserted, kept ones after those of this session", () => {
  kvMap.set(PROMPT_RECENT_KEY, JSON.stringify(["old1", "old2"]));
  rememberPrompt("s_studio", "q1");
  rememberPrompt("local", "old2"); // inserted again: now the newest
  rememberPrompt("s_studio", "q2");
  assert.deepEqual(recentPrompts().map((r) => `${r.server}/${r.id}`), ["s_studio/q2", "local/old2", "s_studio/q1", "local/old1"]);
});

test("a storage that holds anything but a list of ids is no list", () => {
  kvMap.set(PROMPT_RECENT_KEY, "{\"a\":1}");
  assert.deepEqual(recentIds(), []);
  kvMap.set(PROMPT_RECENT_KEY, "not json");
  assert.deepEqual(recentIds(), []);
  kvMap.set(PROMPT_RECENT_KEY, JSON.stringify(["a", 3, null, "b"]));
  assert.deepEqual(recentIds(), ["a", "b"]);
});
