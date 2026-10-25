// The words of the phone's "Set up voice" sheet (screens/voice/setupwords.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import { setupAgent, setupWords } from "../src/screens/voice/setupwords.ts";

test("no key and a rejected key are Set up voice, with the agent named and the ElevenLabs note", () => {
  const w = setupWords("no_key", "Claude Code");
  assert.equal(w.title, "Set up voice");
  assert.equal(w.body, "Talk to Claude Code, or dictate into the box, with your voice.");
  assert.match(w.note ?? "", /ElevenLabs API key.*sent only to elevenlabs\.io/);
  assert.equal(w.action, "Open Settings › Voice");
  const r = setupWords("key_rejected", "Claude Code");
  assert.equal(r.body, "ElevenLabs did not accept this key.");
  assert.equal(r.note, w.note);
  assert.equal(r.action, w.action);
});

test("the other problems keep today's sentence and action under their own title", () => {
  assert.deepEqual(setupWords("no_credits", "x"), { title: "ElevenLabs", body: "Your ElevenLabs plan has no credits left.", action: "Open ElevenLabs" });
  assert.equal(setupWords("service", "x").title, "ElevenLabs");
  assert.equal(setupWords("mic_blocked", "x").title, "Microphone");
  assert.equal(setupWords("mic_blocked", "x").action, "Open system settings");
  assert.equal(setupWords("offline", "x").title, "Can't reach ElevenLabs");
  assert.equal(setupWords("offline", "x").action, "Try again");
  assert.equal(setupWords("offline", "x").note, undefined);
});

test("the agent is the chat's for dictate and speech, the board's voice chat's for the pill, else your agents", () => {
  const agent = (c: string) => ({ a: "Claude Code", b: "Cursor" })[c];
  const board = (b: string) => (b === "b1" ? "b" : null);
  assert.equal(setupAgent("dictate:a", agent, board), "Claude Code");
  assert.equal(setupAgent("speech:b", agent, board), "Cursor");
  assert.equal(setupAgent("pill:b1", agent, board), "Cursor");
  assert.equal(setupAgent("pill:none", agent, board), "your agents");
  assert.equal(setupAgent("dictate:zzz", agent, board), "your agents");
  assert.equal(setupAgent("mic-test", agent, board), "your agents");
  assert.equal(setupAgent("read:1", agent, board), "your agents");
});
