// What comes in of a section gets the page's keys, what goes out the server's own ids
// (src/logic/sectionwire.ts). On the wire the entry id and the id stay apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activityIn, boardIn, briefIn, chatIn, detailIn, draftIn, draftOut, groupIn, notesIn, patchIn, runIn, stateIn, toolCallIn, treeIn } from "../src/logic/sectionwire.ts";
import { normDetail, normPatch, normRun } from "../src/logic/runnorm.ts";
import { UNGROUPED, type Board, type BranchState, type ChatView, type Group, type RunDetail, type RunView } from "../src/types.ts";

const S = "s_0123456789ab";
const k = (id: string) => `${S}~${id}`;
const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chat = (o: Partial<ChatView> & { id: string }): ChatView => ({ agent: "claude", cwd: "/w", model: "m", locked: false, created: "2026-01-01T00:00:00Z", usage, status: "ready", ...o });

test("for this computer everything is given back as it came", () => {
  const c = chat({ id: "c1", group: "g_1", board: "b_1" }), b: Board = { id: "b_1", name: "B", group: "g_1", created: "" };
  const g: Group = { id: "g_1", name: "G", collapsed: true };
  for (const local of [undefined, null, "", "local"]) {
    assert.equal(chatIn(local, c), c);
    assert.equal(boardIn(local, b), b);
    assert.equal(groupIn(local, g), g, "a local group keeps its collapsed");
    assert.equal(toolCallIn(local, { chat: "c1" }).chat, "c1");
  }
});

test("a section's group gets its key and its parent's, and loses `collapsed`: that is the server's own matter", () => {
  assert.deepEqual(groupIn(S, { id: "g_1", name: "G", collapsed: true }), { id: k("g_1"), name: "G" });
  assert.deepEqual(groupIn(S, { id: "g_2", name: "Sub", parent: "g_1", collapsed: false, archived: true }), { id: k("g_2"), name: "Sub", parent: k("g_1"), archived: true });
  assert.equal("collapsed" in groupIn(S, { id: "g_3", name: "X", collapsed: true }), false);
});

test("a section's board, chat, run and branch record name every other thing of that server by its key", () => {
  assert.deepEqual(boardIn(S, { id: "b_1", name: "B", group: UNGROUPED, created: "" }), { id: k("b_1"), name: "B", group: k(UNGROUPED), created: "" });
  const c = chatIn(S, chat({ id: "c1", group: "g_1", forkedFrom: "c0", draft: { text: "@B", mentions: [{ name: "B", id: "b_1" }] } }));
  assert.equal(c.id, k("c1"));
  assert.equal(c.group, k("g_1"));
  assert.equal(c.forkedFrom, k("c0"));
  assert.deepEqual(c.draft, { text: "@B", mentions: [{ name: "B", id: k("b_1") }] });
  const onBoard = chatIn(S, chat({ id: "c2", board: "b_1" })), onRun = chatIn(S, chat({ id: "c3", run: "r_1", role: "task" }));
  assert.equal(onBoard.board, k("b_1"));
  assert.equal("group" in onBoard, false, "a field the server left out stays out");
  assert.equal(onRun.run, k("r_1"));
  const st: BranchState = { chat: "c1", branch: "main", cwd: "/w", model: "m", locked: true, usage, status: "ready", draft: { text: "x", mentions: [{ name: "B", id: "b_1" }] }, draftRev: 4 };
  assert.deepEqual(stateIn(S, st), { ...st, chat: k("c1"), draft: { text: "x", mentions: [{ name: "B", id: k("b_1") }] } });
  const r = runIn(S, normRun({ id: "r_1", name: "R", group: "g_1" } as RunView));
  assert.equal(r.id, k("r_1"));
  assert.equal(r.group, k("g_1"));
});

test("a branch id is not a thing of a server: it stays as it is", () => {
  const c = chatIn(S, chat({ id: "c1", branch: "ab12cd34", forkedBranch: "main" }));
  assert.equal(c.branch, "ab12cd34");
  assert.equal(c.forkedBranch, "main");
  assert.equal(stateIn(S, { chat: "c1", branch: "ab12cd34", cwd: "", model: "", locked: false, usage, status: "ready" }).branch, "ab12cd34");
});

test("a section's tree: every list keyed, a list the server left out is empty, a run with no group is in that server's ungrouped area", () => {
  const t = treeIn(S, {
    groups: [{ id: "g_1", name: "G", collapsed: true }],
    boards: [{ id: "b_1", name: "B", group: "g_1", created: "" }],
    chats: [chat({ id: "c1", group: "g_1" })],
    states: [{ chat: "c1", branch: "main", cwd: "", model: "", locked: false, usage, status: "ready" }, { branch: "main" } as BranchState],
    runs: [{ id: "r_1", name: "R" } as RunView],
    defaults: { groups: { g_1: { servers: { local: { agent: "claude" } } } } },
  });
  assert.deepEqual(t.groups, [{ id: k("g_1"), name: "G" }]);
  assert.equal(t.boards[0].group, k("g_1"));
  assert.equal(t.chats[0].id, k("c1"));
  assert.deepEqual(t.states.map((st) => st.chat), [k("c1")], "a record that names no chat is left out");
  assert.equal(t.runs[0].group, k(UNGROUPED));
  assert.deepEqual(t.defaults, { groups: { g_1: { servers: { local: { agent: "claude" } } } } }, "the defaults are kept as they came");
  assert.deepEqual(treeIn(S, {}), { groups: [], boards: [], chats: [], states: [], runs: [], defaults: { groups: {} } });
  assert.deepEqual(treeIn(S, { groups: null, boards: null, chats: null, states: null, runs: null, defaults: null }), { groups: [], boards: [], chats: [], states: [], runs: [], defaults: { groups: {} } });
});

const detail = (): RunDetail => normDetail({
  run: "r_1", version: 3, status: "running", startedAt: 1, goalSize: 5,
  stops: [],
  turns: [{ n: 1, agent: "a_turn1", reason: "start", status: "done", startedAt: 1, cost: null,
    wokenBy: [{ seq: 1, t: 1, type: "chat_op", chat: "c9", text: "x" }, { seq: 2, t: 1, type: "task_done", task: "T01", text: "y" }],
    learned: [{ seq: 3, t: 2, type: "chat_op", chat: "c9", text: "z" }],
    ops: [{ i: 0, t: 1, op: "add_task", task: "T01" }] }],
  tasks: [{ id: "T01", title: "t", kind: "k", writes: true, dependsOn: [], needsReport: [], tier: "deep", tierReason: "", addedTurn: 1, addedBy: "c9", createdAt: 1, changedTurns: [], briefRev: 1,
    briefs: [{ rev: 1, at: 1, chat: "c9", size: 2 }, { rev: 2, at: 2, turn: 1, size: 2 }],
    attempts: [{ n: 1, tier: "deep", queuedTurn: 1, queuedBy: "c9", queuedAt: 1, phases: [{ k: "held", t: 1, chat: "c9" }, { k: "work", t: 2 }], agents: { work: "a_w", merge: "a_m" }, cost: null,
      cancel: { t: 3, reason: "r", chat: "c9" } }] }],
  chatOps: [{ i: 0, t: 1, op: "add_task", chat: "c9", task: "T01" }],
  agents: { a_turn1: { id: "a_turn1", name: "turn-001", role: "orchestrator", status: "done", startedAt: 1, launches: [], cost: null, tier: "deep", model: "m", tokens: null },
    a_w: { id: "a_w", name: "T01-work", role: "task", status: "running", startedAt: 1, launches: [], cost: null, tier: "deep", model: "m", tokens: null } },
  notes: [{ v: 1, at: 1, chat: "c9", size: 1 }, { v: 2, at: 2, turn: 1, size: 1 }],
} as unknown as RunDetail);

test("a run's detail: its agents and the chats it names are that server's, wherever the detail names one", () => {
  const d = detailIn(S, detail());
  assert.equal(d.run, k("r_1"));
  assert.deepEqual(Object.keys(d.agents), [k("a_turn1"), k("a_w")]);
  assert.equal(d.agents[k("a_w")].id, k("a_w"));
  assert.equal(d.turns[0].agent, k("a_turn1"));
  assert.deepEqual(d.turns[0].wokenBy.map((e) => e.chat), [k("c9"), undefined]);
  assert.equal(d.turns[0].learned[0].chat, k("c9"));
  const task = d.tasks[0], a = task.attempts[0];
  assert.equal(task.addedBy, k("c9"));
  assert.deepEqual(task.briefs.map((b) => b.chat), [k("c9"), undefined]);
  assert.equal(a.queuedBy, k("c9"));
  assert.deepEqual(a.phases.map((p) => p.chat), [k("c9"), undefined]);
  assert.deepEqual(a.agents, { work: k("a_w"), merge: k("a_m") });
  assert.equal(a.cancel?.chat, k("c9"));
  assert.equal(d.chatOps[0].chat, k("c9"));
  assert.deepEqual(d.notes.map((n) => n.chat), [k("c9"), undefined]);
  // what is no thing of a server stays: task ids, turn numbers, versions
  assert.equal(task.id, "T01");
  assert.equal(d.turns[0].ops[0].task, "T01");
  assert.equal(d.version, 3);
});

test("a run's detail of this computer is given back as it is, and one with no agent or chat named gains none", () => {
  const d = detail();
  assert.equal(detailIn("local", d), d);
  const bare = detailIn(S, normDetail({ run: "r_2", version: 1, status: "running", turns: [{ n: 1, agent: "", reason: "start", status: "running" }], tasks: [{ id: "T01", attempts: [{ n: 1 }] }] } as unknown as RunDetail));
  assert.equal(bare.turns[0].agent, "");
  assert.deepEqual(bare.tasks[0].attempts[0].agents, {});
  assert.equal("addedBy" in bare.tasks[0], false);
  assert.equal("queuedBy" in bare.tasks[0].attempts[0], false);
});

test("a `run_detail` patch and a `run_activity` are keyed the same way, and name only what they brought", () => {
  const p = patchIn(S, normPatch({ status: "stopped", agents: { a_w: { id: "a_w", name: "T01-work", role: "task", status: "done", startedAt: 1, launches: [], cost: null, tier: "deep", model: "m", tokens: null } },
    chatOps: [{ i: 1, t: 2, op: "cancel_task", chat: "c9", task: "T01" }] } as never));
  assert.deepEqual(Object.keys(p).sort(), ["agents", "chatOps", "status"]);
  assert.deepEqual(Object.keys(p.agents!), [k("a_w")]);
  assert.equal(p.agents![k("a_w")].id, k("a_w"));
  assert.equal(p.chatOps![0].chat, k("c9"));
  assert.deepEqual(activityIn(S, { a_w: { activity: "Reading", tools: 3 } }), { [k("a_w")]: { activity: "Reading", tools: 3 } });
  const local = { a_w: { activity: "x" } };
  assert.equal(activityIn("local", local), local);
});

test("a brief and a version of the notes name the chat that wrote them by its key", () => {
  assert.equal(briefIn(S, { task: "T01", text: "b", rev: 1, at: 1, chat: "c9", size: 1 }).chat, k("c9"));
  assert.equal(briefIn(S, { task: "T01", text: "b", rev: 1, at: 1, turn: 2, size: 1 }).chat, undefined);
  assert.equal(notesIn(S, { v: 1, at: 1, chat: "c9", size: 1, text: "n" }).chat, k("c9"));
});

test("a board tool's call: the calling chat, its board and the board the call is for are that server's; the arguments stay", () => {
  const call = { chat: "c1", branch: "main", board: "b_1", target: "b_2", name: "apply", args: { board: "b_2", create: [{ id: "e1" }] } };
  assert.deepEqual(toolCallIn(S, call), { ...call, chat: k("c1"), board: k("b_1"), target: k("b_2") });
  assert.deepEqual(toolCallIn(S, { chat: "c1", board: "b_1", name: "get_view", args: {} }), { chat: k("c1"), board: k("b_1"), target: undefined, name: "get_view", args: {} });
});

test("a draft goes out with the boards picked in it by their own ids, and comes in with their keys", () => {
  const out = draftOut(S, { text: "@B @C", mentions: [{ name: "B", id: k("b_1") }, { name: "C", id: k("b_2") }], references: [{ quote: "q", item: 1, start: 0, end: 1 }] });
  assert.deepEqual(out.mentions, [{ name: "B", id: "b_1" }, { name: "C", id: "b_2" }]);
  assert.deepEqual(out.references, [{ quote: "q", item: 1, start: 0, end: 1 }]);
  const plain = { text: "hello" };
  assert.equal(draftOut(S, plain), plain);
  assert.equal(draftOut("local", plain), plain);
  assert.deepEqual(draftIn(S, out), { ...out, mentions: [{ name: "B", id: k("b_1") }, { name: "C", id: k("b_2") }] });
  assert.equal(draftIn(S, null), null);
  assert.equal(draftIn(S, undefined), undefined);
  assert.equal(draftIn(S, plain), plain);
});

test("a board of another server picked in a draft is not sent as if it were that server's: the same id here and there are two boards", () => {
  const OTHER = "s_ffffffffffff";
  const picks = [{ name: "Here", id: "b_1" }, { name: "There", id: k("b_1") }, { name: "Elsewhere", id: `${OTHER}~b_1` }];
  const d = { text: "@Here @There @Elsewhere", mentions: picks, references: [{ quote: "q", item: 1, start: 0, end: 1 }] };
  // each server gets its own board alone, by its own id; the text, with every name, and the quotes go as they are
  assert.deepEqual(draftOut(S, d), { text: d.text, mentions: [{ name: "There", id: "b_1" }], references: d.references });
  assert.deepEqual(draftOut("local", d), { text: d.text, mentions: [{ name: "Here", id: "b_1" }], references: d.references });
  assert.deepEqual(draftOut(undefined, d).mentions, [{ name: "Here", id: "b_1" }], "no server is this computer");
  assert.deepEqual(draftOut(OTHER, d).mentions, [{ name: "Elsewhere", id: "b_1" }]);
  // a draft whose picks are all of another server has none
  const none = draftOut(S, { text: "@Here", mentions: [{ name: "Here", id: "b_1" }] });
  assert.deepEqual(none, { text: "@Here" });
  assert.equal("mentions" in none, false);
});
