import { test } from "node:test";
import assert from "node:assert/strict";
import { applies, applyResultOf, canResetTiers, goalLine, sentence, limitText, limitValue, settingsChange, setupValue, tiersReset, withoutGit,
  LIMITS, NOT_GIT, SETUP_MAX, TIER_ROWS, UNCOMMITTED, WAKES } from "../src/logic/rungoal.ts";
import { limitsLabel, startBlock } from "../src/logic/run.ts";
import { TIERS, type RunSettings, type RunTiers } from "../src/types.ts";

const settings: RunSettings = { maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 };
const folder = { cwd: "/Users/demo/projects/shop", git: true };
const tilde = (p: string) => p.replace("/Users/demo", "~");

test("limitValue: a number in range is taken as typed", () => {
  assert.equal(limitValue("maxParallel", "8", 4), 8);
  assert.equal(limitValue("maxParallel", " 1 ", 4), 1);
  assert.equal(limitValue("maxParallel", "16", 4), 16);
  assert.equal(limitValue("maxTurns", "500", 60), 500);
  assert.equal(limitValue("maxCost", "20", 0), 20);
  assert.equal(limitValue("maxCost", "12.5", 0), 12.5);
});

test("limitValue: a number outside the range becomes the nearest end", () => {
  assert.equal(limitValue("maxParallel", "0", 4), 1);
  assert.equal(limitValue("maxParallel", "-3", 4), 1);
  assert.equal(limitValue("maxParallel", "17", 4), 16);
  assert.equal(limitValue("maxParallel", "1e9", 4), 16);
  assert.equal(limitValue("maxTurns", "0", 60), 1);
  assert.equal(limitValue("maxTurns", "501", 60), 500);
  assert.equal(limitValue("maxCost", "-5", 20), 0);
  assert.equal(limitValue("maxCost", "1000000", 20), 1000000); // a cost has no upper end
});

test("limitValue: whole limits are rounded, a cost is rounded to cents", () => {
  assert.equal(limitValue("maxParallel", "2.4", 4), 2);
  assert.equal(limitValue("maxParallel", "2.5", 4), 3);
  assert.equal(limitValue("maxParallel", "0.4", 4), 1);
  assert.equal(limitValue("maxTurns", "59.9", 60), 60);
  assert.equal(limitValue("maxCost", "19.999", 0), 20);
  assert.equal(limitValue("maxCost", "0.004", 5), 0);
  assert.equal(limitValue("maxCost", "7.255", 0), 7.26);
});

test("limitValue: an emptied Cost is 0, any other empty field keeps what is saved", () => {
  assert.equal(limitValue("maxCost", "", 20), 0);
  assert.equal(limitValue("maxCost", "   ", 20), 0);
  assert.equal(limitValue("maxParallel", "", 4), 4);
  assert.equal(limitValue("maxTurns", " ", 60), 60);
});

test("limitValue: what is not a number keeps what is saved", () => {
  for (const typed of ["abc", "4x", "1,5", "--2", "NaN", "Infinity", "-Infinity", "1e999"]) {
    assert.equal(limitValue("maxParallel", typed, 4), 4, typed);
    assert.equal(limitValue("maxCost", typed, 20), 20, typed);
  }
});

test("limitValue: every result is in the server's range", () => {
  for (const key of ["maxParallel", "maxTurns", "maxCost"] as const) {
    for (const typed of ["-1", "0", "0.5", "1", "3.7", "16", "17", "500", "501", "1e6", "", "x"]) {
      const v = limitValue(key, typed, key === "maxCost" ? 0 : 4), o = LIMITS[key];
      assert.ok(v >= o.min && v <= (o.max ?? Infinity), `${key} ${typed} → ${v}`);
      if (o.whole) assert.ok(Number.isInteger(v), `${key} ${typed} → ${v}`);
    }
  }
});

test("limitText: no cost limit is an empty field", () => {
  assert.equal(limitText("maxCost", 0), "");
  assert.equal(limitText("maxCost", 20), "20");
  assert.equal(limitText("maxCost", 12.5), "12.5");
  assert.equal(limitText("maxParallel", 4), "4");
  assert.equal(limitText("maxTurns", 60), "60");
});

test("setupValue: one line, trimmed, at most 2,000 characters", () => {
  assert.equal(setupValue("  npm ci  "), "npm ci");
  assert.equal(setupValue(""), "");
  assert.equal(setupValue("   "), "");
  assert.equal(setupValue("cd web\n  npm ci\r\n"), "cd web npm ci");
  assert.equal(setupValue("a".repeat(SETUP_MAX + 50)).length, SETUP_MAX);
  assert.equal(setupValue("a".repeat(SETUP_MAX - 1) + " b"), "a".repeat(SETUP_MAX - 1)); // the cut leaves no space at the end
  assert.equal(SETUP_MAX, 2000);
});

test("settingsChange: only what differs from what is saved, one key at a time", () => {
  assert.equal(settingsChange(settings, "maxParallel", 4), null);
  assert.deepEqual(settingsChange(settings, "maxParallel", 8), { maxParallel: 8 });
  assert.deepEqual(settingsChange(settings, "maxTurns", 12), { maxTurns: 12 });
  assert.equal(settingsChange(settings, "maxCost", 0), null);
  assert.deepEqual(settingsChange(settings, "maxCost", 20), { maxCost: 20 });
  assert.deepEqual(settingsChange({ ...settings, maxCost: 20 }, "maxCost", 0), { maxCost: 0 }); // an emptied Cost saves 0
  assert.equal(settingsChange(settings, "setup", ""), null); // no setup command is saved, none is typed
  assert.deepEqual(settingsChange(settings, "setup", "npm ci"), { setup: "npm ci" });
  assert.equal(settingsChange({ ...settings, setup: "npm ci" }, "setup", "npm ci"), null);
  assert.deepEqual(settingsChange({ ...settings, setup: "npm ci" }, "setup", ""), { setup: "" });
});

test("a field left as typed: the value, the chip and what is saved agree", () => {
  const leave = (s: RunSettings, key: "maxParallel" | "maxTurns" | "maxCost", typed: string) => {
    const v = limitValue(key, typed, s[key]);
    return { field: limitText(key, v), change: settingsChange(s, key, v), chip: limitsLabel({ ...s, [key]: v }) };
  };
  assert.deepEqual(leave(settings, "maxParallel", "99"), { field: "16", change: { maxParallel: 16 }, chip: "16 parallel · 60 turns" });
  assert.deepEqual(leave(settings, "maxTurns", ""), { field: "60", change: null, chip: "4 parallel · 60 turns" });
  assert.deepEqual(leave(settings, "maxCost", "20"), { field: "20", change: { maxCost: 20 }, chip: "4 parallel · 60 turns · $20" });
  assert.deepEqual(leave({ ...settings, maxCost: 20 }, "maxCost", ""), { field: "", change: { maxCost: 0 }, chip: "4 parallel · 60 turns" });
});

test("withoutGit: a folder that is there and is no repository; an absent git is false", () => {
  assert.equal(withoutGit(folder), false);
  assert.equal(withoutGit({ cwd: "/tmp/x", git: false }), true);
  assert.equal(withoutGit({ cwd: "/tmp/x" }), true); // the server leaves a false `git` out
  assert.equal(withoutGit({ cwd: "/tmp/x", folderMissing: true }), false); // unknown: the folder is gone
  assert.equal(withoutGit({ cwd: "" }), false);
});

test("goalLine: nothing for a git folder", () => {
  assert.equal(goalLine(folder, ""), null);
});

test("goalLine: each state's line and tone", () => {
  assert.deepEqual(goalLine({ ...folder, folderMissing: true, git: false }, "", tilde),
    { tone: "error", text: "Folder not found: ~/projects/shop. Pick another one." });
  assert.deepEqual(goalLine({ ...folder, blocked: "This repository has no commit yet." }, ""),
    { tone: "error", text: "This repository has no commit yet." });
  assert.deepEqual(goalLine({ cwd: "/tmp/x", git: false }, ""), { tone: "note", text: NOT_GIT });
  assert.deepEqual(goalLine({ cwd: "/tmp/x" }, ""), { tone: "note", text: NOT_GIT });
  assert.equal(NOT_GIT, "Not a git repository: the agents work straight in this folder, one change on top of the other, and there is nothing to apply at the end.");
  assert.deepEqual(goalLine({ ...folder, dirty: true }, ""), { tone: "note", text: UNCOMMITTED });
  assert.equal(UNCOMMITTED, "This folder has uncommitted changes. The agents start from the last commit and will not see them; the result is applied at the end only if it does not touch them.");
});

test("the server's sentence gets a capital and a full stop; one that starts with a path keeps its first letter", () => {
  assert.equal(sentence("this repository has no commit yet: make a first commit, then start the run"), "This repository has no commit yet: make a first commit, then start the run.");
  assert.equal(sentence("This repository has no commit yet."), "This repository has no commit yet.");
  assert.equal(sentence("is it there?"), "Is it there?");
  assert.equal(sentence("  git is not installed \n"), "Git is not installed.");
  assert.equal(sentence("/Users/demo/projects/shop is no longer the git repository this run started in"), "/Users/demo/projects/shop is no longer the git repository this run started in.");
  assert.equal(sentence("~/shop is gone"), "~/shop is gone.");
  assert.equal(sentence("c:\\work\\shop is gone"), "c:\\work\\shop is gone.");
  assert.equal(sentence(""), "");
});

test("goalLine: what blocks the start is said as a sentence", () => {
  assert.deepEqual(goalLine({ ...folder, blocked: "this repository has no commit yet: make a first commit, then start the run" }, ""),
    { tone: "error", text: "This repository has no commit yet: make a first commit, then start the run." });
  // the start's own error is the server's answer to a click: as it came
  assert.deepEqual(goalLine(folder, "the run is archived"), { tone: "error", text: "the run is archived" });
});

test("goalLine: the first that applies wins", () => {
  const all = { cwd: "/tmp/x", folderMissing: true, blocked: "refused", git: false };
  assert.equal(goalLine(all, "claude is not installed")?.text, "claude is not installed");
  assert.equal(goalLine(all, "")?.text, "Folder not found: /tmp/x. Pick another one.");
  assert.equal(goalLine({ ...all, folderMissing: false }, "")?.text, "Refused."); // a "refuse" policy for a folder that is no repository: no note
  assert.equal(goalLine({ ...all, folderMissing: false, blocked: undefined }, "")?.tone, "note");
  assert.equal(goalLine({ ...all, folderMissing: false, blocked: undefined, git: true }, ""), null);
});

test("goalLine and startBlock together: what Send says in each folder state", () => {
  const state = (r: Parameters<typeof goalLine>[0], text: string, err = "") => [goalLine(r, err)?.tone ?? "", startBlock(r, text)];
  assert.deepEqual(state(folder, "a goal"), ["", ""]);
  assert.deepEqual(state(folder, "  "), ["", "Type a goal first"]);
  assert.deepEqual(state({ ...folder, folderMissing: true }, "a goal"), ["error", "Pick a folder that exists first"]);
  assert.deepEqual(state({ ...folder, blocked: "refused" }, "a goal"), ["error", "refused"]);
  assert.deepEqual(state({ cwd: "/tmp/x", git: false }, "a goal"), ["note", ""]); // the warning does not stop the start
  assert.deepEqual(state(folder, "a goal", "claude is not installed"), ["error", ""]); // after a failed start Send works again
});

test("goalLine: start error, folder missing, blocked, not git, uncommitted changes, in that order", () => {
  const all = { cwd: "/tmp/x", folderMissing: true, blocked: "refused", git: false, dirty: true };
  assert.equal(goalLine(all, "claude is not installed")?.text, "claude is not installed");
  assert.equal(goalLine(all, "")?.text, "Folder not found: /tmp/x. Pick another one.");
  assert.equal(goalLine({ ...all, folderMissing: false }, "")?.text, "Refused.");
  assert.equal(goalLine({ ...all, folderMissing: false, blocked: undefined }, "")?.text, NOT_GIT);
  assert.equal(goalLine({ ...all, folderMissing: false, blocked: undefined, git: true }, "")?.text, UNCOMMITTED);
  assert.equal(goalLine({ ...all, folderMissing: false, git: true }, "")?.text, "Refused."); // blocked comes before the note
  assert.equal(goalLine({ ...all, folderMissing: false, blocked: undefined, git: true, dirty: false }, ""), null);
});

const tiers: RunTiers = { deep: { model: "opus", effort: "high" }, standard: { model: "sonnet", effort: "medium" }, light: { model: "haiku" } };

test("canResetTiers: only with defaults that a tier differs from", () => {
  assert.equal(canResetTiers({ tiers }), false); // a started run, or an old server: no defaults
  assert.equal(canResetTiers({ tiers, tierDefaults: structuredClone(tiers) }), false);
  assert.equal(canResetTiers({ tiers, tierDefaults: { ...tiers, light: { model: "sonnet", effort: "low" } } }), true);
  assert.equal(canResetTiers({ tiers, tierDefaults: { ...tiers, deep: { model: "opus", effort: "max" } } }), true); // the effort alone
  assert.equal(canResetTiers({ tiers, tierDefaults: { ...tiers, light: { model: "haiku", effort: "" } } }), false); // no effort is no effort
});

test("tiersReset: every tier's default model and effort", () => {
  assert.deepEqual(tiersReset(tiers), { deep: { model: "opus", effort: "high" }, standard: { model: "sonnet", effort: "medium" }, light: { model: "haiku" } });
});

test("TIER_ROWS: the three tiers in order, named", () => {
  assert.deepEqual(TIER_ROWS.map((r) => r[0]), TIERS);
  assert.deepEqual(TIER_ROWS.map((r) => r[1]), ["Deep", "Standard", "Light"]);
});

test("wake: the three options and what each saves", () => {
  assert.deepEqual(WAKES, [["declared", "when its wait is met"], ["each", "after every task"], ["idle", "when nothing is running"]]);
  assert.deepEqual(settingsChange(settings, "wake", "idle"), { wake: "idle" });
  assert.equal(settingsChange(settings, "wake", "each"), null);
});

test("apply result: absent is auto, the checkbox saves auto or manual", () => {
  assert.equal(applies(settings), true);
  assert.equal(applies({ applyResult: "auto" }), true);
  assert.equal(applies({ applyResult: "manual" }), false);
  assert.equal(applyResultOf(true), "auto");
  assert.equal(applyResultOf(false), "manual");
  assert.equal(settingsChange(settings, "applyResult", "auto"), null); // absent is auto: nothing to save
  assert.deepEqual(settingsChange(settings, "applyResult", "manual"), { applyResult: "manual" });
  assert.deepEqual(settingsChange({ ...settings, applyResult: "manual" }, "applyResult", "auto"), { applyResult: "auto" });
  assert.equal(settingsChange({ ...settings, applyResult: "manual" }, "applyResult", "manual"), null);
});
