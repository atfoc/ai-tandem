// The draft run's composer with a server (src/run/RunComposer.tsx): what it reads through the
// run's server (logic/runserver.ts, logic/runcompose.ts) as pure functions, and its source for
// what only the component holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOAL_TOO_LONG, RUN_FIXED_UNCONFIRMED, changeFailure, keptRunStarts, movedRunStart, runFixed, runFolderChip, runHasChats, runLine, startErrorOld, startFailure, withRunStart,
  type RunStart, type StartFacts } from "../src/logic/runcompose.ts";
import { RUN_HAS_CHATS, RUN_START_UNCONFIRMED, runAgentReason, runDeleteRefused, runOffLine, runServerChoice, runStartBlock, runUnconfirmedLine, runWhere } from "../src/logic/runserver.ts";
import { agentChoiceOn, folderStarts, folderTitle, tildeBy } from "../src/logic/chatserver.ts";
import { catalogFor, usableAgents } from "../src/logic/agentlist.ts";
import { listsOf, type ListsState } from "../src/logic/serverlists.ts";
import { NOT_GIT, UNCOMMITTED } from "../src/logic/rungoal.ts";
import { ApiError } from "../src/api.ts";
import type { ServerView } from "../src/logic/servers.ts";
import type { Catalog } from "../src/types.ts";

const src = readFileSync(new URL("../src/run/RunComposer.tsx", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/run/actions.ts", import.meta.url), "utf8");
const entry = (id: string, name: string, state: ServerView["state"]): ServerView => ({ id, name, state } as ServerView);
const cat = (model: string): Catalog => ({ models: [], default: { model } } as unknown as Catalog);
const state: ListsState = {
  usable: ["claude", "pi"], catalogs: { claude: cat("local"), pi: cat("local-pi") }, home: "/Users/me", defaultCwd: "/Users/me/code",
  servers: [{ id: "local", name: "This computer", state: "connected", local: true } as ServerView, entry("s_1", "Studio", "connected"), entry("s_2", "Mini", "unreachable"), entry("s_3", "Old", "too_old")],
  lists: {
    s_1: { agents: ["pi"], catalogs: { pi: cat("studio-pi") }, home: "/home/u", defaultCwd: "/home/u/work" },
    s_2: { agents: ["claude"], catalogs: { claude: cat("mini") }, home: "/home/m", defaultCwd: "/home/m" },
  },
};
const local = runWhere(state, {}), studio = runWhere(state, { server: "s_1" }), mini = runWhere(state, { server: "s_2" });
const tildeOn = (server: string) => (p: string) => tildeBy(listsOf(state, server)?.home, p);
const repo = { cwd: "/home/u/work/app", git: true, agent: "pi" as const };

test("the server choice: every entry by name, this computer first, one that waits for the user disabled with its state", () => {
  const { options, fixed } = runServerChoice(state.servers!, {}, false);
  assert.equal(fixed, "");
  assert.deepEqual(options.map((o) => o.label), ["This computer", "Studio", "Mini", "Old"]);
  assert.deepEqual(options.map((o) => !!o.disabled), [false, false, false, true]);
  assert.ok(options[3].reason, "the disabled entry says its state");
});

test("the server choice is fixed with its reason while the start is unconfirmed or the draft has chats", () => {
  assert.equal(runServerChoice(state.servers!, { start: "unconfirmed" }, false).fixed, RUN_START_UNCONFIRMED);
  assert.equal(runServerChoice(state.servers!, {}, true).fixed, RUN_HAS_CHATS);
  assert.equal(runServerChoice(state.servers!, { start: "unconfirmed" }, true).fixed, RUN_START_UNCONFIRMED);
});

test("runHasChats: the user's chats on the run count, its own agents' and other runs' do not", () => {
  assert.equal(runHasChats({}, "r_1"), false);
  assert.equal(runHasChats({ a: { run: "r_2" }, b: { run: "r_1", role: "orchestrator" } as any, c: {} }, "r_1"), false);
  assert.equal(runHasChats({ a: { run: "r_1" } }, "r_1"), true);
});

test("the agent choice, the catalog and the default folder are the run's server's (AC44, AC18)", () => {
  assert.deepEqual(agentChoiceOn(local, usableAgents(state, local.server), "claude").options, ["claude", "pi"]);
  const on = agentChoiceOn(studio, usableAgents(state, studio.server), "claude");
  assert.deepEqual(on.options, ["pi"]);
  assert.equal(on.missing, true);
  assert.match(on.reason, /Claude.* is not installed on Studio/);
  // not connected: no agent is offered and none is marked, with the reason
  const off = agentChoiceOn(mini, usableAgents(state, mini.server), "claude");
  assert.deepEqual([off.options, off.missing], [[], false]);
  assert.match(off.reason, /^Mini is not connected/);
  assert.equal(catalogFor(state, studio.server, "pi")!.default.model, "studio-pi");
  assert.equal(catalogFor(state, local.server, "pi")!.default.model, "local-pi");
  assert.equal(catalogFor(state, studio.server, "claude"), undefined);
  assert.equal(catalogFor(state, mini.server, "claude")!.default.model, "mini"); // the models keep their names while it is away
  assert.deepEqual(folderStarts(listsOf(state, "s_1")), ["/home/u/work", "/home/u"]);
  assert.deepEqual(folderStarts(listsOf(state, "local")), ["/Users/me/code", "/Users/me"]);
});

test("the folder chip: ~ by the run's server's home, \" on <Name>\" for another server, git from the view (AC18)", () => {
  assert.deepEqual(runFolderChip(studio, repo, tildeOn("s_1")),
    { text: "~/work/app on Studio", git: true, missing: false, title: "The folder on Studio the run's agents work in" });
  assert.deepEqual(runFolderChip(local, { cwd: "/Users/me/code/x", git: false }, tildeOn("local")),
    { text: "~/code/x", git: false, missing: false, title: "The folder the run's agents work in" });
  // this computer's home shortens nothing of another server's path
  assert.equal(runFolderChip(studio, { cwd: "/Users/me/code/x" }, tildeOn("s_1")).text, "/Users/me/code/x on Studio");
  assert.deepEqual(runFolderChip(studio, { cwd: "/home/u/gone", git: true, folderMissing: true }, tildeOn("s_1")),
    { text: "~/gone on Studio", git: false, missing: true, title: "The folder on Studio the run's agents work in" });
  assert.equal(runFolderChip(studio, { cwd: "" }).text, "No folder");
  assert.equal(folderTitle(studio, "/home/u/work", { hint: "h" }), "Folder on Studio: /home/u/work — h");
});

test("the line under the box: the start's error, else not connected, else unconfirmed, else the folder's line", () => {
  const all = { cwd: "/home/m/x", folderMissing: true, blocked: "Blocked.", dirty: true, start: "unconfirmed" as const };
  assert.deepEqual(runLine(mini, all, "The start failed."), { tone: "error", text: "The start failed." });
  assert.deepEqual(runLine(mini, all, ""), { tone: "error", text: runOffLine("Mini") });
  assert.deepEqual(runLine(studio, all, ""), { tone: "note", text: runUnconfirmedLine("Studio") });
  assert.deepEqual(runLine(studio, { ...all, start: undefined, cwd: "/home/u/gone" }, "", tildeOn("s_1")),
    { tone: "error", text: "Folder not found: ~/gone. Pick another one." });
  assert.deepEqual(runLine(studio, { cwd: "/home/u/x", blocked: "Studio cannot run runs: update it." }, ""), { tone: "error", text: "Studio cannot run runs: update it." });
  assert.deepEqual(runLine(studio, { cwd: "/home/u/x" }, ""), { tone: "note", text: NOT_GIT });
  assert.deepEqual(runLine(local, { cwd: "/x", git: true, dirty: true }, ""), { tone: "note", text: UNCOMMITTED });
  assert.equal(runLine(studio, repo, ""), null);
});

test("Send is disabled by runStartBlock: a server that is not connected first", () => {
  assert.equal(runStartBlock(mini, { cwd: "", agent: "" }, ""), "Mini is not connected");
  assert.equal(runStartBlock(studio, repo, "goal"), "");
  assert.ok(runStartBlock(studio, { ...repo, agent: "" }, "goal"));
  assert.ok(runStartBlock(studio, { ...repo, folderMissing: true }, "goal"));
  assert.equal(runStartBlock(studio, { ...repo, blocked: "Studio cannot run runs: update it." }, "goal"), "Studio cannot run runs: update it.");
  assert.equal(runStartBlock(studio, repo, " "), "Type a goal first");
  // a start that got no answer can be made again
  assert.equal(runStartBlock(studio, { ...repo, start: "unconfirmed" } as any, "goal"), "");
});

test("while the start is unconfirmed agent, folder, tiers and settings are fixed chips", () => {
  assert.equal(runFixed({ start: "unconfirmed" }), RUN_FIXED_UNCONFIRMED);
  assert.equal(runFixed({}), "");
  for (const chip of ['data-fixed="agent" title={`Agent — ${fixed}`}', 'data-fixed="tiers" title={`Models — ${fixed}`}', 'data-fixed="settings" title={`Run settings — ${fixed}`}', "locked={!!fixed}"])
    assert.ok(src.includes(chip), chip);
  assert.ok(src.includes("const fixed = runFixed(r);"));
});

test("a refused start: the sentence, a 409 reads the run again, goal_kept is shown apart", () => {
  assert.deepEqual(startFailure(new ApiError(504, "Studio did not answer: it is not known whether the run started. Start again: it starts only once.", true, "start_unconfirmed")),
    { text: "Studio did not answer: it is not known whether the run started. Start again: it starts only once.", reread: false, kept: false });
  assert.deepEqual(startFailure(new ApiError(409, "Folder not found: /x", true, "folder_missing")), { text: "Folder not found: /x", reread: true, kept: false });
  const kept = "Studio had already started the run with the earlier goal; this text was not sent.";
  assert.deepEqual(startFailure(new ApiError(409, kept, true, "goal_kept")), { text: kept, reread: true, kept: true });
  assert.equal(startFailure(new ApiError(413, "413 Request Entity Too Large", false)).text, GOAL_TOO_LONG);
  assert.equal(startFailure(new ApiError(413, "Too long, says the server.")).text, "Too long, says the server.");
  assert.equal(startFailure(new Error("Failed to fetch")).text, "Failed to fetch");
});

test("the component reads through the run's server", () => {
  for (const part of [
    "const w = useWhere(r);",
    "catalogFor(s, w.server, r.agent)",
    "usableAgents(s, w.server)",
    "agentChoiceOn(w, usable, r.agent)",
    "server={w.server}",
    "tildify(p, w.server)",
    "runAgentReason(w, usableAgents(s, w.server), r)",
    "runStartBlock(w, r, text, agentReason)",
    "runLine(w, r, err, tilde, agentReason)",
    "runFolderChip(w, r, tilde)",
    "runServerChoice(servers, r, hasChats)",
    'more={{ label: "Servers…", onClick: () => openServers() }}',
    "onPick={(id) => configure({ server: id })}",
    "answerRun(r.id, () => api.configureRun(r.id, p))",
    "title={`Server — ${fixed}`}",
    "const kept = await startRun(runId, goal);",
    "if (kept) showGoalKept(kept, goal);",
  ]) assert.ok(src.includes(part), part);
  assert.ok(!src.includes("LOCAL_SERVER"), "nothing is read from this computer by name");
  assert.ok(!/tildify\(r\.cwd\)|usableAgents\(s\)/.test(src));
  // the text of a failed start is never taken out of the box: only a start that worked clears the unsaved goal
  assert.ok(!/unsavedRunDraft\([^)]*\)\.write\(null\)/.test(src));
  assert.equal(actions.split(".write(null)").length, 2);
  assert.match(actions, /const started = await api\.startRun\(id, goal\);\s*unsavedRunDraft\(runNow\(id\)\)\.write\(null\);/);
  assert.ok(!/input\.current\?\.set\(""\)/.test(src));
});

// ---- a draft on another server with no agent that can run it (the view's `blocked` says "this server")

test("a draft on another server with no agent: the line and Send's title take the agent choice's reason before the view's `blocked`", () => {
  const blocked = "No agent can be used on this server: none of the programs of Claude Code, Cursor and pi was found.";
  const none = runAgentReason(studio, [], { agent: "" });
  assert.equal(none, "No agent is installed on Studio. Install Claude Code, Cursor or pi on that machine.");
  assert.equal(none, agentChoiceOn(studio, [], "").reason, "it is the reason the agent chip gives");
  const r = { cwd: "/home/u/work/app", git: true, agent: "" as const, blocked };
  assert.deepEqual(runLine(studio, r, "", tildeOn("s_1"), none), { tone: "error", text: none });
  assert.equal(runStartBlock(studio, r, "goal", none), none);
  assert.doesNotMatch(runLine(studio, r, "", tildeOn("s_1"), none)!.text + runStartBlock(studio, r, "goal", none), /this server/);
  // the run's agent is one that server lacks: its `blocked` speaks of "this server" too
  const lacks = runAgentReason(studio, ["pi"], { agent: "claude" });
  assert.match(lacks, /Claude.* is not installed on Studio/);
  assert.equal(runStartBlock(studio, { ...r, agent: "claude", blocked: "Claude Code's program was not found on this server: install it, or choose another agent" }, "goal", lacks), lacks);
  // an agent that server can run: no reason, and what the server says blocks the run shows as before
  assert.equal(runAgentReason(studio, ["pi"], { agent: "pi" }), "");
  assert.equal(runAgentReason(studio, ["pi"], { agent: "" }), "", "one can be chosen: Send says so");
  assert.equal(runStartBlock(studio, { ...r, agent: "pi", blocked: "Studio cannot run runs: update it." }, "goal", ""), "Studio cannot run runs: update it.");
  // this computer: the view's sentence is right there; not connected: the line says that
  assert.equal(runAgentReason(local, [], { agent: "" }), "");
  assert.equal(runAgentReason(mini, [], { agent: "" }), "");
  assert.deepEqual(runLine(local, { ...r, cwd: "/x" }, "", (p) => p, runAgentReason(local, [], r)), { tone: "error", text: blocked });
  // what comes before it stays before it: the start's error, a folder that is gone, an unconfirmed start
  assert.equal(runLine(studio, r, "The start failed.", (p) => p, none)!.text, "The start failed.");
  assert.match(runLine(studio, { ...r, folderMissing: true }, "", (p) => p, none)!.text, /^Folder not found/);
  assert.equal(runStartBlock(studio, { ...r, folderMissing: true }, "goal", none), "Pick a folder that exists first");
  assert.equal(runLine(studio, { ...r, start: "unconfirmed" }, "", (p) => p, none)!.text, runUnconfirmedLine("Studio"));
});

// ---- refusals the start route and a draft's PATCH and DELETE answer while the run is being started

test("a start refused with run_changed, busy or a code the page does not know: the server's sentence once under the box, the goal kept", () => {
  const changed = "The run was changed while it was being started; it was not started on Studio.";
  assert.deepEqual(startFailure(new ApiError(409, changed, true, "run_changed")), { text: changed, reread: true, kept: false });
  assert.deepEqual(startFailure(new ApiError(409, "The run is being started.", true, "busy")), { text: "The run is being started.", reread: true, kept: false });
  assert.deepEqual(startFailure(new ApiError(409, "Something new.", true, "a_code_of_tomorrow")), { text: "Something new.", reread: true, kept: false });
  assert.deepEqual(startFailure(new ApiError(502, "Studio could not start the run.", true, "another_new_code")), { text: "Studio could not start the run.", reread: false, kept: false });
  // once: the sentence is the one line under the box, before anything the view says
  const r = { cwd: "/home/u/x", git: true, blocked: "Blocked.", start: "unconfirmed" as const };
  assert.deepEqual(runLine(studio, r, changed), { tone: "error", text: changed });
  // kept: startRun puts the sentence in the store and takes nothing out of the box or of the unsaved goal
  assert.match(actions, /setRunStart\(now, \{ starting: false, error: f\.kept \? "" : f\.text \}\);/);
  assert.match(actions, /if \(f\.reread\) void refreshRun\(now\);/);
  const failed = actions.slice(actions.indexOf("} catch (e) {", actions.indexOf("export async function startRun")), actions.indexOf("/** Asks again while"));
  assert.doesNotMatch(failed, /unsavedRunDraft|write\(/);
});

test("a change (PATCH) or a delete of a draft refused 409 busy shows its sentence where the other refusals of that action show", () => {
  const busy = new ApiError(409, "The run is being started.", true, "busy");
  // a change: the sentence, shown as any refused change's (under the box, or in the settings form), and the run is read again
  assert.deepEqual(changeFailure(busy), { text: "The run is being started.", reread: true });
  assert.deepEqual(changeFailure(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), { text: "Studio is not connected.", reread: false });
  assert.ok(src.includes("(e) => { onError(changeFailure(e).text); failed(e); }"));
  assert.ok(src.includes("const failed = (e: unknown) => { if (changeFailure(e).reread) void refreshRun(r.id); };"));
  assert.ok(src.includes("if (shown.current) setErr(e.message); else onError(e.message);"));
  // a delete: no other dialog takes its place, so the delete dialog shows the sentence, as for any error
  for (const connected of [true, false]) assert.equal(runDeleteRefused({ server: "s_1" }, "Tidy", "Studio", busy, connected), null);
  assert.equal(runDeleteRefused({}, "Tidy", "This computer", busy, true), null);
});

// ---- the start's state is the store's, by run id (State.runStarts)

const facts = (o: Partial<StartFacts> = {}): StartFacts => ({ cwd: "/home/u/x", server: "s_1", connected: true, ...o });

test("what the server said about a start is old when the run's folder, what blocks it, its server or its start mark changed, or its server is connected again", () => {
  assert.equal(startErrorOld(facts(), facts()), false);
  assert.equal(startErrorOld(facts({ folderMissing: false, blocked: "", start: undefined }), facts()), false, "absent and empty are the same");
  assert.equal(startErrorOld(facts(), facts({ cwd: "/home/u/y" })), true);
  assert.equal(startErrorOld(facts(), facts({ folderMissing: true })), true);
  assert.equal(startErrorOld(facts(), facts({ blocked: "Blocked." })), true);
  assert.equal(startErrorOld(facts(), facts({ server: "s_2" })), true);
  assert.equal(startErrorOld(facts({ server: undefined }), facts({ server: "local" })), false);
  // the start mark leaving "unconfirmed": a start that got no answer is known now, either way
  assert.equal(startErrorOld(facts({ start: "unconfirmed" }), facts()), true);
  // the mark becoming "unconfirmed" is not old: it says what the sentence of that start says, and its event can come after the start's answer (T128;
  // T114 had this as old, which dropped the sentence in that order)
  assert.equal(startErrorOld(facts(), facts({ start: "unconfirmed" })), false);
  assert.equal(startErrorOld(facts({ start: undefined }), facts({ start: "unconfirmed" })), false);
  assert.equal(startErrorOld(facts({ start: "unconfirmed" }), facts({ start: "unconfirmed" })), false);
  assert.equal(startErrorOld(facts({ connected: false }), facts({ start: "unconfirmed" })), true, "with its server back the sentence is old all the same");
  assert.equal(startErrorOld(facts(), facts({ start: "unconfirmed", cwd: "/home/u/y" })), true, "and with another folder");
  // the run's server: back, not away
  assert.equal(startErrorOld(facts({ connected: false }), facts()), true);
  assert.equal(startErrorOld(facts(), facts({ connected: false })), false);
});

test("the starts by run id: set, cleared, moved to a draft's new id, and dropped when old", () => {
  const none: Record<string, RunStart> = {};
  const going = withRunStart(none, "r_1", { starting: true, error: "" });
  assert.deepEqual(going, { r_1: { starting: true, error: "" } });
  assert.equal(withRunStart(going, "r_1", { starting: true }), going, "the map itself when nothing changes");
  const failed = withRunStart(going, "r_1", { starting: false, error: "Studio did not answer." });
  assert.deepEqual(failed, { r_1: { starting: false, error: "Studio did not answer." } });
  assert.deepEqual(withRunStart(failed, "r_1", { error: "" }), {}, "nothing left to say: no entry");
  assert.deepEqual(withRunStart(failed, "r_1", null), {});
  assert.equal(withRunStart(none, "r_1", null), none);
  assert.deepEqual(withRunStart(going, "r_1", { error: "x" }), { r_1: { starting: true, error: "x" } });
  // a new id
  assert.deepEqual(movedRunStart({ ...going, r_2: failed.r_1 }, "r_1", "r_9"), { r_2: failed.r_1, r_9: going.r_1 });
  assert.equal(movedRunStart(going, "r_3", "r_9"), going);
  assert.equal(movedRunStart(going, "r_1", "r_1"), going);

  // what the store does whenever a run or the server list changes
  const off = [entry("s_1", "Studio", "unreachable")], on = [entry("s_1", "Studio", "connected")];
  const draft = { cwd: "/home/u/x", server: "s_1" };
  const starts = { r_1: failed.r_1, r_2: going.r_1 };
  const before = { runs: { r_1: draft, r_2: draft }, servers: on };
  assert.equal(keptRunStarts(starts, before, before), starts);
  assert.equal(keptRunStarts(starts, before, { runs: { r_1: { ...draft }, r_2: draft }, servers: on }), starts, "the same facts in another object");
  // the T109 case: the red line of a start that got no answer goes when the start mark changes, and when the server is back
  const lost = { runs: { r_1: { ...draft, start: "unconfirmed" as const }, r_2: draft }, servers: off };
  assert.deepEqual(keptRunStarts(starts, lost, { ...lost, servers: on }), { r_2: going.r_1 }, "the server is connected again");
  assert.deepEqual(keptRunStarts(starts, lost, { ...before, servers: off }), { r_2: going.r_1 }, "the start mark changed");
  assert.equal(keptRunStarts(starts, { ...before, servers: on }, { ...before, servers: off }), starts, "a server that goes away drops nothing");
  // the start's answer first, the mark's event second (T128): the sentence stays, and goes as in the other order
  assert.equal(keptRunStarts(starts, { ...before, servers: off }, lost), starts, "the mark becomes what the sentence says");
  assert.equal(keptRunStarts(starts, before, { ...lost, servers: on }), starts, "also on a server still shown connected");
  assert.deepEqual(keptRunStarts(starts, before, { runs: { r_1: { ...draft, cwd: "/home/u/y" }, r_2: { ...draft, cwd: "/home/u/y" } }, servers: on }), { r_2: going.r_1 },
    "a start on its way stays: its answer ends it");
  // a run that is gone takes its start with it; one that is new under its id keeps what was moved to it
  assert.deepEqual(keptRunStarts(starts, before, { runs: { r_1: draft }, servers: on }), { r_1: failed.r_1 });
  assert.equal(keptRunStarts({ r_9: failed.r_1 }, before, { runs: { ...before.runs, r_9: { ...draft, start: "unconfirmed" } }, servers: on })["r_9"], failed.r_1);
});

test("the composer reads the start's state from the store and holds none of its own", () => {
  for (const part of [
    "const starting = useStore((s) => !!s.runStarts[runId]?.starting);",
    'const err = useStore((s) => s.runStarts[runId]?.error ?? "");',
    "const setErr = (msg: string) => setRunStart(runId, { error: msg });",
  ]) assert.ok(src.includes(part), part);
  assert.ok(!/useState\(false\);\s*\/\/ starting|setStarting\(/.test(src));
  assert.doesNotMatch(src, /useEffect\(\(\) => \{ setErr\(""\); \}/, "the store drops a sentence that is old, not an effect of the composer");
  const store = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  assert.match(store, /if \(p\.runs \|\| p\.servers\) \{\s*const from = p\.runStarts \?\? state\.runStarts;\s*const runStarts = keptRunStarts\(from, state, \{ runs: p\.runs \?\? state\.runs, servers: p\.servers \?\? state\.servers \}\);/);
  assert.match(store, /runStarts: movedRunStart\(s\.runStarts, was, r\.id\)/);
});
