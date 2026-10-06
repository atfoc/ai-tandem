import { test } from "node:test";
import assert from "node:assert/strict";
import { runChat, runChatState, runChatText } from "../src/logic/runchat.ts";
import type { RunStatus } from "../src/types.ts";

test("runChatState: the four states", () => {
  const want: Record<RunStatus, string> = {
    draft: "draft", running: "live", stopping: "live", stopped: "halted", stalled: "halted", error: "halted",
    completed: "ended", gave_up: "ended",
  };
  for (const [status, state] of Object.entries(want)) assert.equal(runChatState(status as RunStatus), state, status);
  assert.equal(runChatState(undefined), "draft"); // a run the client does not have
});

test("runChat: a draft says the run has not started and suggests nothing", () => {
  const c = runChat("draft", "QA");
  assert.equal(runChatText(c), "This chat can read QA once it runs. The run has not started: type its goal on the right.");
  assert.deepEqual(c.suggestions, []);
});

test("runChat: a live run", () => {
  for (const status of ["running", "stopping"] as const) {
    const c = runChat(status, "QA");
    assert.equal(runChatText(c), "Ask what QA is doing, what a task found or why something failed. This chat reads the run's state, and can steer it: add, cancel or retry tasks, or pass a message to the orchestrator.");
    assert.deepEqual(c.suggestions, ["What is the run doing right now?", "Summarize what is done and what is left", "Did anything fail or get stuck? Why?"]);
  }
});

test("runChat: a stopped, stalled or failed run", () => {
  for (const status of ["stopped", "stalled", "error"] as const) {
    const c = runChat(status, "QA");
    assert.equal(runChatText(c), "QA is stopped. Ask why, what is left, or what a task found.");
    assert.deepEqual(c.suggestions, ["Why did the run stop, and what is left?", "What should change before I resume it?"]);
  }
});

test("runChat: an ended run does not offer to steer it", () => {
  for (const status of ["completed", "gave_up"] as const) {
    const c = runChat(status, "QA");
    assert.equal(runChatText(c), "QA has ended. Ask what it did, what a task found, or what to check before using the result.");
    assert.deepEqual(c.suggestions, ["Summarize what the run did", "Which tasks failed or were retried, and why?", "What should I check before using the result?"]);
    assert.ok(!c.suggestions.includes("What is the run doing right now?"));
  }
});

test("runChat: the name is the one bold part, with a fallback", () => {
  for (const status of ["draft", "running", "stopped", "completed"] as const) {
    assert.deepEqual(runChat(status, "QA").text.filter((p) => typeof p !== "string"), [{ b: "QA" }], status);
  }
  assert.match(runChatText(runChat("draft", undefined)), /^This chat can read this run once it runs\./);
  assert.match(runChatText(runChat("running", "")), /^Ask what this run is doing/);
  assert.match(runChatText(runChat("error", undefined)), /^This run is stopped\./);
  assert.match(runChatText(runChat("gave_up", undefined)), /^This run has ended\./);
});
