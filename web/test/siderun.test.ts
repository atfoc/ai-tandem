import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUP_ARCHIVE_RUN, GROUP_DELETE_RUN, groupCount, runArchiveConfirm, runDraftTag, runLightsGroup, runRowTitle,
  workingRunIn } from "../src/logic/siderun.ts";
import { runRowLine } from "../src/logic/run.ts";
import { runDeleteAsk } from "../src/logic/runserver.ts";

// the delete dialog of a run of this computer (Sidebar.tsx deleteRun): the run, its name, "This computer", its folder
const runDeleteConfirm = (r: RunView, folder: string) => runDeleteAsk(r, r.name, "This computer", folder);
import { buildTree, contents, subtree } from "../src/logic/tree.ts";
import { TASK_STATES, type Board, type ChatView, type Group, type RunCounts, type RunStatus, type RunView } from "../src/types.ts";

const counts = (over: Partial<RunCounts> = {}): RunCounts =>
  ({ ...Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as RunCounts, ...over });
const run = (id: string, status: RunStatus, over: Partial<RunView> = {}): RunView => ({
  id, name: "Checkout rewrite", group: "g_shop", created: "2026-10-01T00:00:00Z",
  agent: "claude", tiers: { deep: { model: "opus" }, standard: { model: "opus" }, light: { model: "opus" } }, cwd: "/home/me/shop", git: true,
  settings: { maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 },
  ...(status === "draft" ? {} : { started: "2026-10-01T00:01:00Z" }),
  status, activeMs: 0, asOf: 0, turns: 0, idleStreak: 0, counts: counts(), cost: 0, attention: 0, ...over,
});
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (id: string, over: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", cwd: "/home/me/shop", model: "opus", locked: false, created: "2026-10-01T00:00:00Z", usage, status: "ready", ...over });
const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
const STATUSES: RunStatus[] = ["draft", "running", "stopping", "stopped", "stalled", "error", "completed", "gave_up"];
const WORKING: RunStatus[] = ["running", "stopping"];

test("runDraftTag: a typed goal on a draft run that is not open", () => {
  const typed = { text: "Rewrite the checkout" };
  assert.equal(runDraftTag(run("r", "draft", { draft: typed }), false), true);
  assert.equal(runDraftTag(run("r", "draft", { draft: typed }), true), false, "the open run shows it in its goal box");
  assert.equal(runDraftTag(run("r", "draft", { draft: typed, archived: true }), false), false);
  assert.equal(runDraftTag(run("r", "draft"), false), false);
  assert.equal(runDraftTag(run("r", "draft", { draft: { text: "" } }), false), false);
  // a started run has no goal box; a draft the server did not clear yet shows no tag
  for (const s of STATUSES.slice(1)) assert.equal(runDraftTag(run("r", s, { draft: typed }), false), false, s);
});

test("runRowTitle: the group path, the name and the second line", () => {
  assert.equal(runRowTitle(run("r", "draft", { name: "New run" }), []), "New run — Not started");
  assert.equal(runRowTitle(run("r", "running", { turns: 7, counts: counts({ done: 12, work: 3, held: 5 }) }), ["Shop", "Web"]),
    "Shop / Web / Checkout rewrite — Turn 7 · 12 of 20 tasks done");
  assert.equal(runRowTitle(run("r", "stalled", { stalledBy: "turns" }), ["Shop"]), "Shop / Checkout rewrite — Stalled: turn limit");
});

test("groupCount: boards, runs and plain chats", () => {
  assert.equal(groupCount({ boards: [], runs: [], chats: [] }), 0);
  assert.equal(groupCount({ boards: [1], runs: [1, 2], chats: [1, 2, 3] }), 6);
  assert.equal(groupCount({ boards: [], runs: [1], chats: [] }), 1);
});

test("groupCount and the order of a group, on a built tree", () => {
  const groups: Group[] = [{ id: "g_shop", name: "Shop" }, { id: "g_web", name: "Web", parent: "g_shop" }];
  const boards: Record<string, Board> = byId([{ id: "b_1", name: "arch", group: "g_shop" } as Board]);
  const runs = byId([
    run("r_old", "completed", { created: "2026-10-01T00:00:00Z" }),
    run("r_new", "running", { created: "2026-10-03T00:00:00Z" }),
    run("r_mid_b", "draft", { created: "2026-10-02T00:00:00Z" }),
    run("r_mid_a", "draft", { created: "2026-10-02T00:00:00Z" }),
    run("r_sub", "stopped", { group: "g_web" }),
    run("r_arch", "stopped", { archived: true }),
    run("r_loose", "draft", { group: "__ungrouped__" }),
  ]);
  const chats = byId([
    chat("c_plain", { group: "g_shop" }),
    chat("c_on_run", { run: "r_new" }),            // nested under its run: not counted by the group
    chat("a_agent", { run: "r_new", role: "task" }), // a run's own agent: nowhere
    chat("c_on_board", { board: "b_1" }),
  ]);
  const tree = buildTree({ groups, boards, chats, runs }, false);
  const shop = tree.groups[0];
  assert.deepEqual(shop.runs.map((r) => r.id), ["r_new", "r_mid_a", "r_mid_b", "r_old"], "newest first, the id breaks ties");
  assert.deepEqual(shop.chats.map((c) => c.id), ["c_plain"]);
  assert.deepEqual(tree.loose.runs.map((r) => r.id), ["r_loose"]);
  assert.equal(groupCount(contents(shop)), 1 + 5 + 1, "one board, four runs and the subgroup's one, one plain chat");
  assert.equal(groupCount(contents(shop.children[0])), 1);
  assert.equal(groupCount(contents(buildTree({ groups, boards, chats, runs }, true).groups[0])), 8, "with the archived run");
});

test("runLightsGroup: a working run, or a busy chat on it that shows", () => {
  for (const s of STATUSES) assert.equal(runLightsGroup(run("r", s), {}, false), WORKING.includes(s), s);
  assert.equal(runLightsGroup(run("r", "running", { archived: true }), {}, true), false);
  const stopped = run("r", "stopped");
  assert.equal(runLightsGroup(stopped, byId([chat("c1", { run: "r", status: "ready" })]), false), false);
  assert.equal(runLightsGroup(stopped, byId([chat("c1", { run: "r", status: "thinking" })]), false), true);
  assert.equal(runLightsGroup(stopped, byId([chat("c1", { run: "r", status: "approval" })]), false), true);
  assert.equal(runLightsGroup(stopped, byId([chat("c1", { run: "other", status: "thinking" })]), false), false, "another run's chat");
  assert.equal(runLightsGroup(stopped, byId([chat("c1", { status: "thinking" })]), false), false, "a plain chat");
  assert.equal(runLightsGroup(stopped, byId([chat("a1", { run: "r", role: "task", status: "thinking" })]), false), false, "the run's own agent");
});

test("workingRunIn: a working run in the group's subtree", () => {
  const groups: Group[] = [{ id: "g_shop", name: "Shop" }, { id: "g_web", name: "Web", parent: "g_shop" }, { id: "g_other", name: "Other" }];
  const shop = subtree(groups, "g_shop"), web = subtree(groups, "g_web"), other = subtree(groups, "g_other");
  const runs = [run("r1", "completed"), run("r2", "running", { group: "g_web" }), run("r3", "stopped", { group: "g_other" })];
  assert.equal(workingRunIn(runs, shop), true, "in a subgroup");
  assert.equal(workingRunIn(runs, web), true);
  assert.equal(workingRunIn(runs, other), false);
  assert.equal(workingRunIn([run("r2", "stopping")], shop), true);
  assert.equal(workingRunIn([run("r2", "running", { archived: true })], shop), false, "an archived run does not work");
  assert.equal(workingRunIn([run("r2", "running", { group: "__ungrouped__" })], shop), false);
  assert.equal(workingRunIn([], shop), false);
  for (const s of STATUSES) assert.equal(workingRunIn([run("r", s)], shop), WORKING.includes(s), s);
});

test("the group confirmations' texts", () => {
  assert.equal(GROUP_ARCHIVE_RUN, "A run in this group is working. Stop it and archive the group?");
  assert.equal(GROUP_DELETE_RUN, "A run in this group is working: deleting everything stops it.");
});

test("runArchiveConfirm: asks only when something works", () => {
  const working = {
    title: "This run is working. Stop it and archive?",
    body: "Its agents are stopped and the tasks in progress are left unfinished. Unarchive the run to resume it.",
    action: "Stop and archive",
  };
  assert.deepEqual(runArchiveConfirm(run("r", "running"), {}), working);
  assert.deepEqual(runArchiveConfirm(run("r", "stopping"), {}), working);
  for (const s of STATUSES.filter((x) => !WORKING.includes(x))) assert.equal(runArchiveConfirm(run("r", s), {}), null, s);
  // a chat on the run works: another title, and no body (the run's own agents are not at work)
  const busy = byId([chat("c1", { run: "r", status: "tool" })]);
  assert.deepEqual(runArchiveConfirm(run("r", "stopped"), busy),
    { title: "An agent is working in a chat on this run. Stop it and archive?", action: "Stop and archive" });
  assert.deepEqual(runArchiveConfirm(run("r", "draft"), byId([chat("c1", { run: "r", subsRunning: 1 })])),
    { title: "An agent is working in a chat on this run. Stop it and archive?", action: "Stop and archive" }, "waiting on its subagents counts");
  // the run's own state wins when both work
  assert.deepEqual(runArchiveConfirm(run("r", "running"), busy), working);
  // what does not count: an idle chat, an archived one, another run's, the run's own agents
  assert.equal(runArchiveConfirm(run("r", "stopped"), byId([chat("c1", { run: "r" })])), null);
  assert.equal(runArchiveConfirm(run("r", "stopped"), byId([chat("c1", { run: "r", status: "tool", archived: true })])), null);
  assert.equal(runArchiveConfirm(run("r", "stopped"), byId([chat("c1", { run: "x", status: "tool" })])), null);
  assert.equal(runArchiveConfirm(run("r", "stopped"), byId([chat("a1", { run: "r", role: "task", status: "tool" })])), null);
});

test("runDeleteConfirm: always asks; the folder sentence only for a started run", () => {
  const removed = "The run's tasks, reports, notes, agent transcripts and chats are removed.";
  assert.deepEqual(runDeleteConfirm(run("r", "draft", { name: "New run" }), "~/shop"),
    { title: "Delete New run?", body: `${removed} This can't be undone.`, action: "Delete", local: false });
  assert.deepEqual(runDeleteConfirm(run("r", "completed"), "~/shop"),
    { title: "Delete Checkout rewrite?", body: `${removed} What its agents changed in ~/shop stays. This can't be undone.`, action: "Delete", local: false });
  assert.equal(runDeleteConfirm(run("r", "running"), "~/shop").body,
    `This run is working: its agents are stopped. ${removed} What its agents changed in ~/shop stays. This can't be undone.`);
  assert.equal(runDeleteConfirm(run("r", "stopping"), "/srv/shop").body,
    `This run is working: its agents are stopped. ${removed} What its agents changed in /srv/shop stays. This can't be undone.`);
  // an archived run does not work, whatever its status says
  assert.equal(runDeleteConfirm(run("r", "running", { archived: true }), "~/shop").body, `${removed} What its agents changed in ~/shop stays. This can't be undone.`);
  // no folder to name: the sentence is left out
  assert.equal(runDeleteConfirm(run("r", "stopped"), "").body, `${removed} This can't be undone.`);
  for (const s of STATUSES.slice(1)) assert.match(runDeleteConfirm(run("r", s), "~/shop").body, / stays\. This can't be undone\.$/, s);
});

test("runRowLine: a finished run whose result is not in the folder says so", () => {
  const c = counts({ done: 20 });
  assert.equal(runRowLine(run("r", "completed", { counts: c, delivery: "pending" })), "Completed · not applied");
  assert.equal(runRowLine(run("r", "completed", { counts: c, delivery: "blocked" })), "Completed · not applied");
  assert.equal(runRowLine(run("r", "gave_up", { counts: c, delivery: "pending" })), "Gave up · not applied");
  assert.equal(runRowLine(run("r", "completed", { delivery: "blocked" })), "Completed · not applied");
  // applied and nothing to apply add nothing
  assert.equal(runRowLine(run("r", "completed", { counts: c, delivery: "applied" })), "Completed · 20 tasks");
  assert.equal(runRowLine(run("r", "completed", { counts: c, delivery: "none" })), "Completed · 20 tasks");
  assert.equal(runRowLine(run("r", "completed", { counts: c })), "Completed · 20 tasks");
  // a halted run's line is about why it halted
  assert.equal(runRowLine(run("r", "stopped", { counts: c, delivery: "pending" })), "Stopped");
  assert.equal(runRowLine(run("r", "stalled", { stalledBy: "turns", delivery: "pending" })), "Stalled: turn limit");
  assert.equal(runRowTitle(run("r", "completed", { counts: c, delivery: "pending" }), ["Shop"]), "Shop / Checkout rewrite — Completed · not applied");
});
