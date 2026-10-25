import assert from "node:assert/strict";
import { test } from "node:test";

import { branchesWord, contextValue, infoRules, infoSub, offlineWhy, startedLine } from "../src/screens/chat/infomodel.ts";

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = at(2026, 10, 24, 14, 5);

test("startedLine: today, yesterday and an older day, in 24 h local time", () => {
  assert.equal(startedLine(iso(at(2026, 10, 24, 9, 12)), NOW), "started today at 09:12");
  assert.equal(startedLine(iso(at(2026, 10, 23, 18, 40)), NOW), "started yesterday at 18:40");
  assert.equal(startedLine(iso(at(2026, 10, 3, 7, 0)), NOW), "started Oct 3");
  assert.equal(startedLine(iso(at(2025, 12, 31, 7, 0)), NOW), "started Dec 31, 2025");
  assert.equal(startedLine(iso(at(2026, 10, 24, 0, 0)), NOW), "started today at 00:00");
});

test("startedLine: a time in the future reads as today; a bad time is nothing", () => {
  assert.equal(startedLine(iso(at(2026, 10, 25, 9, 12)), NOW), "started today at 09:12");
  assert.equal(startedLine("", NOW), "");
  assert.equal(infoSub("nonsense", NOW), "Chat info");
  assert.equal(infoSub(iso(at(2026, 10, 24, 9, 12)), NOW), "Chat info · started today at 09:12");
});

test("contextValue: share and tokens, or Unavailable", () => {
  assert.equal(contextValue({ used: 72_800, win: 200_000 }), "36% · 73k of 200k");
  assert.equal(contextValue({ used: 0, win: 200_000 }), "0 of 200k");
  assert.equal(contextValue({ used: 4200, win: 0 }), "4.2k tokens");
  assert.equal(contextValue({ used: 0, win: 0 }), "Unavailable");
  assert.equal(contextValue({ used: 100, win: 200, error: "no usage" }), "Unavailable");
});

test("branchesWord", () => {
  assert.equal(branchesWord(1), "1 branch");
  assert.equal(branchesWord(3), "3 branches");
});

test("infoRules: a chat that takes a call has every row live", () => {
  const r = infoRules({ archived: false, legacy: false, gone: false, connected: true, server: "Studio Mac" });
  assert.deepEqual(r, { rename: { disabled: false, why: "" }, archive: { disabled: false, why: "" }, delete: { disabled: false, why: "" } });
});

test("infoRules: a server that is not connected fades Rename, Archive and Delete and says so", () => {
  const r = infoRules({ archived: false, legacy: false, gone: false, connected: false, server: "Studio Mac" });
  for (const k of ["rename", "archive", "delete"] as const) {
    assert.equal(r[k].disabled, true);
    assert.equal(r[k].why, "Studio Mac is offline: you can do this when it is back.");
  }
  assert.equal(offlineWhy({ gone: false, connected: true, server: "x" }), "");
});

test("infoRules: a chat gone from its server says that, and wins over the archived reason", () => {
  const r = infoRules({ archived: true, legacy: false, gone: true, connected: true, server: "Studio Mac" });
  assert.equal(r.rename.why, "This chat is no longer on Studio Mac.");
  assert.equal(r.delete.why, "This chat is no longer on Studio Mac.");
});

test("infoRules: an archived chat is not renamed but can be unarchived and deleted; a legacy chat only archives and deletes", () => {
  const a = infoRules({ archived: true, legacy: false, gone: false, connected: true, server: "This computer" });
  assert.deepEqual(a.rename, { disabled: true, why: "Unarchive the chat to rename it." });
  assert.equal(a.archive.disabled, false);
  assert.equal(a.delete.disabled, false);
  const l = infoRules({ archived: false, legacy: true, gone: false, connected: true, server: "This computer" });
  assert.equal(l.rename.disabled, true);
  assert.equal(l.archive.disabled, false);
});
