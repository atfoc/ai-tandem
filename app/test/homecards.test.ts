// The sentences of Home's state cards (H1 chunk 3): the problem card's, the first run's steps and the empty Home's agents line.
import assert from "node:assert/strict";
import { test } from "node:test";

import { SERVER_WORDS } from "@aiwb/core/logic/statewords.ts";

import { FIRST_RUN_STEPS, SETUP_GUIDE_URL, agentsLine, problemSentence, stepText, wordSince } from "../src/screens/home/cards.ts";

test("the problem sentences of each word", () => {
  const w = SERVER_WORDS;
  assert.equal(problemSentence(w.unreachable.key, "Attic"), "Can't reach Attic. Its boards and chats come back when it does.");
  assert.equal(problemSentence(w.offline.key, "Attic"), problemSentence(w.unreachable.key, "Attic"));
  assert.equal(problemSentence(w.certChanged.key, "Build box"), "Build box's certificate changed. Nothing is sent until you review it.");
  assert.equal(problemSentence(w.tooOld.key, "Attic", "v0.9.1"), "Attic runs an older server (version v0.9.1). Update the server on that computer.");
  assert.equal(problemSentence(w.tooOld.key, "Attic"), "Attic runs an older server. Update the server on that computer.");
  assert.equal(problemSentence(w.localNetworkOff.key, "Attic"), "Local network access is off for AI Whiteboard. Turn it on in Settings › Privacy › Local Network.");
  assert.equal(problemSentence(w.connected.key, "Attic"), "");
  assert.equal(problemSentence(w.connecting.key, "Attic"), "");
});

test("the word with its time", () => {
  const at = new Date(2026, 9, 23, 9, 12).getTime(), now = new Date(2026, 9, 23, 11, 0).getTime();
  assert.equal(wordSince("Unreachable", at, now), "Unreachable · since 9:12");
  assert.equal(wordSince("Unreachable", undefined, now), "Unreachable");
});

test("the first run's steps and guide", () => {
  assert.equal(FIRST_RUN_STEPS.length, 3);
  assert.equal(stepText(FIRST_RUN_STEPS[0]!), "Set up the server once: run setup-remote.sh (in the Mac app, or in the server folder).");
  assert.equal(stepText(FIRST_RUN_STEPS[1]!), "Paste what it printed into Add a server, or show it as a code with server-code.sh and scan it.");
  assert.equal(stepText(FIRST_RUN_STEPS[2]!), "Allow Local Network when the phone asks.");
  assert.deepEqual(FIRST_RUN_STEPS[0]!.filter((p) => p.code).map((p) => p.text), ["setup-remote.sh"]);
  assert.match(SETUP_GUIDE_URL, /^https:\/\/github\.com\/.+\/docs\/remote-servers\.md$/);
});

test("the agents line", () => {
  assert.equal(agentsLine(["claude", "cursor", "pi"], "Studio Mac"), "Claude Code, Cursor and pi are ready on Studio Mac.");
  assert.equal(agentsLine(["claude", "pi"], "Studio Mac"), "Claude Code and pi are ready on Studio Mac.");
  assert.equal(agentsLine(["cursor"], "Build box"), "Cursor is ready on Build box.");
  assert.equal(agentsLine([], "Build box"), "No agent is installed on Build box.");
});
