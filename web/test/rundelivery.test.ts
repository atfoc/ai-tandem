import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryCard, deliveryWord, deliveryWords, sayText, tilde, type DeliveryFacts } from "../src/logic/rundelivery.ts";
import type { RunDelivery, RunDeliveryReason, RunStatus } from "../src/types.ts";

const facts = (over: Partial<DeliveryFacts> = {}): DeliveryFacts =>
  ({ cwd: "/home/me/shop", home: "/home/me", startBranch: "main", resultBranch: "run/shop/integration", status: "completed", ...over });
const card = (d: RunDelivery, over: Partial<DeliveryFacts> = {}) => { const c = deliveryCard(d, facts(over)); assert.ok(c); return c; };
const say = (d: RunDelivery, over: Partial<DeliveryFacts> = {}) => sayText(card(d, over).sentence);
const SHA = "cac8e17a0b1c2d3e4f5061728394a5b6c7d8e9f0";

test("tilde: the home folder as ~", () => {
  assert.equal(tilde("/home/me/shop", "/home/me"), "~/shop");
  assert.equal(tilde("/home/me", "/home/me"), "~");
  assert.equal(tilde("/home/meow/shop", "/home/me"), "/home/meow/shop");
  assert.equal(tilde("/srv/shop"), "/srv/shop");
});

test("no card for a draft, a live run, or a run with no delivery", () => {
  const d: RunDelivery = { state: "pending", reason: "manual" };
  for (const status of ["draft", "running", "stopping"] as RunStatus[]) assert.equal(deliveryCard(d, facts({ status })), null, status);
  assert.equal(deliveryCard(undefined, facts()), null);
  for (const status of ["stopped", "stalled", "error", "completed", "gave_up"] as RunStatus[]) assert.ok(deliveryCard(d, facts({ status })), status);
});

test("mark, tone and title by state", () => {
  const pick = (d: RunDelivery) => { const c = card(d); return [c.tone, c.mark, c.title, c.action]; };
  assert.deepEqual(pick({ state: "none", reason: "no_git" }), ["muted", "✓", "Already in your folder", false]);
  assert.deepEqual(pick({ state: "none", reason: "no_changes" }), ["muted", "✓", "Nothing to apply", false]);
  assert.deepEqual(pick({ state: "applied", how: "ff", branch: "main", commit: SHA }), ["ok", "✓", "Applied to your folder", false]);
  assert.deepEqual(pick({ state: "blocked", reason: "local_changes" }), ["warn", "!", "Not applied yet", true]);
  assert.deepEqual(pick({ state: "pending", reason: "manual" }), ["muted", "→", "Ready to apply", true]);
});

test("the sentence of an applied result and of nothing to apply", () => {
  assert.equal(say({ state: "applied", how: "ff", branch: "main", commit: SHA }), "The result is in ~/shop (main is now at cac8e17).");
  assert.equal(say({ state: "applied", how: "already", branch: "main", commit: SHA }), "The result is in ~/shop (main is now at cac8e17).");
  assert.equal(say({ state: "applied", how: "merge", branch: "dev", commit: SHA }), "The result was merged into dev with your own commits (merge commit cac8e17).");
  assert.equal(say({ state: "none", reason: "no_git" }), "This folder is not a git repository: the agents worked directly in ~/shop.");
  assert.equal(say({ state: "none", reason: "no_changes" }), "The run changed no files.");
  // the folder, the branch and the commit are code
  assert.deepEqual(card({ state: "applied", how: "ff", branch: "main", commit: SHA }).sentence,
    ["The result is in ", { code: "~/shop" }, " (", { code: "main" }, " is now at ", { code: "cac8e17" }, ")", "."]);
});

test("the sentence of a pending result", () => {
  assert.equal(say({ state: "pending", reason: "manual" }), "Automatic applying is off for this run. The result is ready: apply it to ~/shop.");
  assert.equal(say({ state: "pending", reason: "not_achieved" }), "The run did not reach its goal. What was finished can be applied to ~/shop.");
  assert.equal(say({ state: "pending", reason: "halted" }), "The run is not finished. What was merged so far can be applied to ~/shop.");
  assert.equal(say({ state: "pending", reason: "other_branch", branch: "feature" }), "The folder is on feature; the run started on main. Apply merges the result into feature.");
  // a dry run may answer no reason: the setting says whether applying was off
  assert.equal(say({ state: "pending" }), "The result is ready: apply it to ~/shop.");
  assert.equal(say({ state: "pending" }, { settings: { applyResult: "manual" } }), "Automatic applying is off for this run. The result is ready: apply it to ~/shop.");
});

test("the sentence of a blocked result", () => {
  const b = (reason: RunDeliveryReason, over: Partial<RunDelivery> = {}) => say({ state: "blocked", reason, ...over });
  assert.equal(b("local_changes"), "These files have uncommitted changes or are in the way. Commit, stash or move them, then apply.");
  assert.equal(b("conflict"), "Your commits and the result change the same lines. Merge by hand with the command below.");
  assert.equal(b("busy"), "A merge, rebase or other git operation is in progress in the folder. Finish or abort it, then apply.");
  assert.equal(b("folder_missing"), "~/shop is gone or is no longer the repository. The result is on the branch shown below.");
  assert.equal(b("not_repo"), "~/shop is gone or is no longer the repository. The result is on the branch shown below.");
  assert.equal(b("result_missing"), "The result's commit no longer exists in the repository.");
  assert.equal(b("git", { detail: "fatal: unable to write new index file" }), "Git refused: fatal: unable to write new index file.");
  assert.equal(b("git"), "Git refused.");
});

test("history_changed: the sentence says what Apply brings back, and Apply is offered as for manual", () => {
  const d: RunDelivery = { state: "pending", reason: "history_changed", auto: true, branch: "main", result: SHA };
  assert.equal(say(d), "Your branch no longer contains the commit this run started from (it was amended, rebased or reset). Apply brings that commit and its changes back along with the result.");
  const c = card(d), manual = card({ state: "pending", reason: "manual", branch: "main", result: SHA });
  assert.deepEqual({ ...c, sentence: null }, { ...manual, sentence: null });
  assert.equal(c.canApply, true); assert.equal(c.applyTitle, "Apply the result to main"); assert.equal(c.title, "Ready to apply");
  assert.equal(deliveryWord("pending"), "not applied");
});

test("partial adds that the run has not finished, but not to the halted sentence, which says it", () => {
  assert.equal(say({ state: "pending", reason: "halted", partial: true }, { status: "stopped" }),
    "The run is not finished. What was merged so far can be applied to ~/shop.");
  assert.equal(say({ state: "pending", reason: "other_branch", branch: "feature", partial: true }, { status: "stopped" }),
    "The folder is on feature; the run started on main. Apply merges the result into feature. The run has not finished: this is what was merged so far.");
  assert.equal(say({ state: "applied", how: "ff", branch: "main", commit: SHA, partial: true }, { status: "stopped" }),
    "The result is in ~/shop (main is now at cac8e17). The run has not finished: this is what was merged so far.");
});

test("the server's detail is shown whenever there is one, for every reason, and once", () => {
  const moved = "the result's files are in the folder, staged, but the branch could not be moved: ref is locked; remove the cause and apply again";
  const busy = card({ state: "blocked", reason: "busy", detail: moved });
  assert.equal(sayText(busy.sentence), "A merge, rebase or other git operation is in progress in the folder. Finish or abort it, then apply.");
  assert.equal(busy.detail, moved);
  for (const reason of ["local_changes", "conflict", "busy", "folder_missing", "not_repo", "result_missing"] as RunDeliveryReason[])
    assert.equal(card({ state: "blocked", reason, detail: "x: y" }).detail, "x: y", reason);
  assert.equal(card({ state: "pending", reason: "manual", detail: "x: y" }).detail, "x: y");
  // git, and a reason this client does not know: the sentence has the detail, the line does not repeat it
  for (const reason of ["git", "later_reason"] as RunDeliveryReason[]) {
    const c = card({ state: "blocked", reason, detail: "fatal: bad object" });
    assert.ok(sayText(c.sentence).includes("fatal: bad object"), reason);
    assert.equal(c.detail, "", reason);
  }
  assert.equal(card({ state: "blocked", reason: "busy" }).detail, "");
});

test("which states offer Apply, and the title of the button", () => {
  for (const reason of ["manual", "not_achieved", "halted", "other_branch"] as RunDeliveryReason[]) assert.equal(card({ state: "pending", reason }).canApply, true, reason);
  for (const reason of ["local_changes", "busy", "conflict", "git"] as RunDeliveryReason[]) {
    const c = card({ state: "blocked", reason, branch: "main" });
    assert.equal(c.action, true, reason); assert.equal(c.canApply, true, reason);
    assert.equal(c.applyTitle, "Try again: apply the result to main");
  }
  for (const reason of ["folder_missing", "not_repo", "result_missing"] as RunDeliveryReason[]) {
    const c = card({ state: "blocked", reason });
    assert.equal(c.action, true, reason); assert.equal(c.canApply, false, reason);
    assert.equal(c.applyTitle, sayText(c.sentence), "the disabled button says why");
  }
  assert.equal(card({ state: "pending", reason: "other_branch", branch: "feature" }).applyTitle, "Apply the result to feature");
  for (const d of [{ state: "applied", how: "ff" }, { state: "none", reason: "no_git" }, { state: "none", reason: "no_changes" }] as RunDelivery[]) {
    const c = card(d);
    assert.equal(c.action, false); assert.equal(c.canApply, false); assert.equal(c.command, ""); assert.equal(c.applyTitle, "");
  }
});

test("the command, and when the block under the summary starts open", () => {
  assert.equal(card({ state: "pending", reason: "manual" }).command, "git merge run/shop/integration");
  assert.equal(card({ state: "blocked", reason: "conflict" }).command, "git merge run/shop/integration");
  assert.equal(card({ state: "pending", reason: "manual" }, { resultBranch: undefined }).command, "");
  for (const reason of ["conflict", "folder_missing", "not_repo"] as RunDeliveryReason[]) assert.equal(card({ state: "blocked", reason }).byHand, true, reason);
  for (const reason of ["local_changes", "busy", "git", "result_missing"] as RunDeliveryReason[]) assert.equal(card({ state: "blocked", reason }).byHand, false, reason);
  assert.equal(card({ state: "pending", reason: "manual" }).byHand, false);
});

test("the files in the way", () => {
  assert.equal(card({ state: "blocked", reason: "local_changes" }).files, null);
  assert.deepEqual(card({ state: "blocked", reason: "local_changes", files: ["a.md", "b.md", "c.md"] }).files, { list: ["a.md", "b.md", "c.md"], more: 0, label: "the 3 files" });
  assert.equal(card({ state: "blocked", reason: "local_changes", files: ["a.md", "b.md"], more: 14 }).files?.label, "the 2 files and 14 more");
  assert.equal(card({ state: "blocked", reason: "conflict", files: ["a.md"] }).files?.label, "the file");
  assert.equal(card({ state: "applied", how: "ff", files: ["a.md"] }).files, null, "only a blocked result lists files");
});

test("a state this client does not know is nothing to apply", () => {
  const c = card({ state: "later" as RunDelivery["state"] });
  assert.equal(c.title, "Nothing to apply"); assert.equal(c.action, false);
});

test("the short words", () => {
  assert.deepEqual(deliveryWords({ state: "applied", branch: "main" }), { applied: true, text: "applied to", branch: "main" });
  assert.deepEqual(deliveryWords({ state: "applied" }), { applied: true, text: "applied" });
  assert.deepEqual(deliveryWords({ state: "pending" }), { applied: false, text: "not applied" });
  assert.deepEqual(deliveryWords({ state: "blocked", branch: "main" }), { applied: false, text: "not applied" });
  assert.equal(deliveryWords({ state: "none" }), null);
  assert.equal(deliveryWords(undefined), null);
  assert.equal(deliveryWord("pending"), "not applied"); assert.equal(deliveryWord("blocked"), "not applied");
  assert.equal(deliveryWord("applied"), ""); assert.equal(deliveryWord("none"), ""); assert.equal(deliveryWord(undefined), "");
});
