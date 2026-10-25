// What Settings' rows say (S1, goal 3.8.1): the Servers line and when it is amber, the counts of the library and of the archive,
// Voice's value and Appearance's choice.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { LibraryView } from "@aiwb/core/logic/library.ts";
import type { ServerState, ServerView } from "@aiwb/core/logic/servers.ts";

import { AUTOSEND_OFF, AUTOSEND_ON } from "../src/voice/words.ts";
import { appearanceLine, archivedValue, libraryValue, serversLine, voiceLine } from "../src/screens/settings/rows.ts";

const server = (name: string, state: ServerState): ServerView => ({ id: name, name, state });
const library = (n: number): LibraryView => ({ server: "local", name: "This computer", connected: true, groups: [], prompts: Array.from({ length: n }, (_, i) => ({ id: `p${i}` }) as LibraryView["prompts"][number]) });

test("the Servers line counts the connected and the connecting, and names one problem", () => {
  assert.deepEqual(serversLine([server("A", "connected"), server("B", "connected"), server("C", "connected")]), { text: "3 connected", attention: false });
  assert.deepEqual(serversLine([server("A", "connected"), server("B", "connecting")]), { text: "1 connected · 1 connecting…", attention: false });
  assert.deepEqual(serversLine([server("A", "connected"), server("B", "connected"), server("C", "connected"), server("Attic", "unreachable")]),
    { text: "3 connected · Attic unreachable", attention: true });
  assert.deepEqual(serversLine([server("Attic", "certificate_changed")]), { text: "Attic certificate changed · paused", attention: true });
  assert.deepEqual(serversLine([server("Old", "too_old")]), { text: "Old too old", attention: true });
});

test("the Servers line counts two or more problems, leaves out a zero, and says when there are none", () => {
  assert.deepEqual(serversLine([server("A", "connected"), server("B", "unreachable"), server("C", "too_old")]), { text: "1 connected · 2 need attention", attention: true });
  assert.deepEqual(serversLine([server("B", "unreachable"), server("C", "unreachable"), server("D", "connecting")]), { text: "1 connecting… · 2 need attention", attention: true });
  assert.deepEqual(serversLine([]), { text: "No servers", attention: false });
});

test("iOS's refusal of the local network is the word of an unreachable server", () => {
  assert.equal(serversLine([server("Home", "unreachable")], { localNetworkDenied: true }).text, "Home local network off");
});

test("the library's value is the prompts of every library together", () => {
  assert.equal(libraryValue([]), "None");
  assert.equal(libraryValue([library(0), library(0)]), "None");
  assert.equal(libraryValue([library(1)]), "1 prompt");
  assert.equal(libraryValue([library(2), library(7)]), "9 prompts");
});

test("Archived's value counts the archived chats, from a record or a list", () => {
  assert.equal(archivedValue({}), "None");
  assert.equal(archivedValue([{}, { archived: false }]), "None");
  assert.equal(archivedValue({ a: { archived: true }, b: {}, c: { archived: true } }), "2");
  assert.equal(archivedValue([{ archived: true }]), "1");
});

test("Voice says nothing until the key is known, then no key, or the voice and what a spoken turn does", () => {
  assert.equal(voiceLine({ hasKey: null, voiceName: "Rachel", autoSend: true }), "");
  assert.equal(voiceLine({ hasKey: false, voiceName: "Rachel", autoSend: true }), "No key");
  assert.equal(voiceLine({ hasKey: true, voiceName: "Rachel", autoSend: true }), `Rachel · ${AUTOSEND_ON}`);
  assert.equal(voiceLine({ hasKey: true, voiceName: "", autoSend: false }), `Key set · ${AUTOSEND_OFF}`);
});

test("Appearance names the choice, a flavour under Catppuccin", () => {
  assert.equal(appearanceLine("light"), "Light");
  assert.equal(appearanceLine("dark"), "Dark");
  assert.equal(appearanceLine("system"), "System");
  assert.equal(appearanceLine("mocha"), "Catppuccin Mocha");
  assert.equal(appearanceLine("frappe"), "Catppuccin Frappé");
});
