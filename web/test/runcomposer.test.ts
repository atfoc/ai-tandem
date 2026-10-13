// The draft run's composer by the run's server (src/run/RunComposer.tsx): what it reads through the
// server the run's key names (logic/runserver.ts, logic/runcompose.ts) as pure functions, and its
// source for what only the component holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOAL_TOO_LONG, changeFailure, keptRunStarts, runFixed, runFolderChip, runLine, startErrorOld, startFailure, withRunStart,
  type RunStart, type StartFacts } from "../src/logic/runcompose.ts";
import { runAgentReason, runGoneText, runOffLine, runStartBlock, runWhere } from "../src/logic/runserver.ts";
import { agentChoiceOn, folderStarts, folderTitle, showsServer, tildeBy } from "../src/logic/chatserver.ts";
import { catalogFor, usableAgents } from "../src/logic/agentlist.ts";
import { RUN_SERVER_FINAL, listsOf, serverConnected, type ListsState } from "../src/logic/serverlists.ts";
import { serverOfKey } from "../src/logic/keys.ts";
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
  sections: { s_1: {} }, // the local server holds Studio's tree: it is connected. Mini's and Old's it does not hold
};
// The run r_1 of this computer, of the section Studio and of the section Mini: the same id on three servers.
const local = runWhere(state, { id: "r_1" }), studio = runWhere(state, { id: "s_1~r_1" }), mini = runWhere(state, { id: "s_2~r_1" });
const tildeOn = (server: string) => (p: string) => tildeBy(listsOf(state, server)?.home, p);
const repo = { cwd: "/home/u/work/app", git: true, agent: "pi" as const };

test("the run's server is the one its key names, and is no choice: a section's run names it in a chip", () => {
  assert.deepEqual(local, { server: "local", name: "This computer", connected: true });
  assert.deepEqual(studio, { server: "s_1", name: "Studio", connected: true });
  assert.deepEqual(mini, { server: "s_2", name: "Mini", connected: false });
  assert.deepEqual([showsServer(local), showsServer(studio), showsServer(mini)], [false, true, true]);
  assert.equal(RUN_SERVER_FINAL, "A run is on the server it was made on");
  assert.ok(src.includes('{showsServer(w) && <span className={`tchip static server-chip ${w.connected ? "" : "off"}`} title={`Server — ${RUN_SERVER_FINAL}`}><ChipName full={`${w.name} — ${RUN_SERVER_FINAL}`}>{w.name}</ChipName></span>}'));
  // no server is picked for a run that has not started, and none is sent with a change
  for (const gone of ["runServerChoice", "serverOptions", "configure({ server", "hasChats", "Servers…", "openServers"]) assert.ok(!src.includes(gone), gone);
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

test("the line under the box: the start's error, else not connected, else the folder's line", () => {
  const all = { cwd: "/home/m/x", folderMissing: true, blocked: "Blocked.", dirty: true };
  assert.deepEqual(runLine(mini, all, "The start failed."), { tone: "error", text: "The start failed." });
  assert.deepEqual(runLine(mini, all, ""), { tone: "error", text: "Mini is not connected: nothing can be changed or started until it is back." });
  assert.equal(runOffLine("Mini"), "Mini is not connected: nothing can be changed or started until it is back.");
  assert.deepEqual(runLine(studio, all, ""), { tone: "error", text: "Folder not found: /home/m/x. Pick another one." });
  assert.deepEqual(runLine(studio, { ...all, cwd: "/home/u/gone" }, "", tildeOn("s_1")),
    { tone: "error", text: "Folder not found: ~/gone. Pick another one." });
  // a view that still carried the mark of a start with no answer has no line of its own for it
  assert.deepEqual(runLine(studio, { cwd: "/home/u/x", git: true, start: "unconfirmed" } as Parameters<typeof runLine>[1], ""), null);
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
  // a run its server no longer has: the composer says that before anything else
  assert.ok(src.includes("const block = left ? runGoneText(w.name) : runStartBlock(w, r, text, agentReason);"));
  assert.ok(src.includes('const line = left ? { tone: "error" as const, text: runGoneText(w.name) } : runLine(w, r, err, tilde, agentReason);'));
  assert.equal(runGoneText("Studio"), "This run is no longer on Studio.");
});

test("while its server is not connected, or once that server no longer has the run, agent, folder, tiers and settings are fixed chips", () => {
  assert.equal(runFixed(mini), "Mini is not connected");
  assert.equal(runFixed(studio), "");
  assert.equal(runFixed(local), "");
  assert.equal(runFixed({ ...local, connected: false }), "This computer is not connected", "by the Where alone: nothing of the run is read");
  for (const chip of ['data-fixed="agent" title={`Agent — ${fixed}`}', 'data-fixed="tiers" title={`Models — ${fixed}`}', 'data-fixed="settings" title={`Run settings — ${fixed}`}', "locked={!!fixed}"])
    assert.ok(src.includes(chip), chip);
  assert.ok(src.includes("const fixed = left ? runGoneText(w.name) : runFixed(w);"));
  assert.ok(src.includes("const left = useStore((s) => !!s.gone[r.id]);"));
  // nor is the server asked for the folder and what blocks a start meanwhile
  assert.ok(src.includes("useFresh(runId, w.connected && !left);"));
});

test("a refused start: the sentence, and a 409 reads the run again", () => {
  assert.deepEqual(startFailure(new ApiError(504, "Studio did not answer.", true, "no_answer")), { text: "Studio did not answer.", reread: false });
  assert.deepEqual(startFailure(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), { text: "Studio is not connected.", reread: false });
  assert.deepEqual(startFailure(new ApiError(409, "Folder not found: /x", true, "folder_missing")), { text: "Folder not found: /x", reread: true });
  // (no refusal is shown apart from the others: what `goal_kept` once was is a 409 like another)
  assert.deepEqual(Object.keys(startFailure(new ApiError(409, "x", true, "goal_kept"))).sort(), ["reread", "text"]);
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
    "answerRun(r.id, () => api.configureRun(r.id, p))",
    "title={`Server — ${RUN_SERVER_FINAL}`}",
    "await startRun(runId, goal);",
  ]) assert.ok(src.includes(part), part);
  assert.ok(!src.includes("showGoalKept") && !actions.includes("GOAL_KEPT") && !actions.includes("f.kept") && !actions.includes("goal_kept"), "a start answers nothing but that it started");
  assert.ok(!src.includes("LOCAL_SERVER"), "nothing is read from this computer by name");
  assert.ok(!/tildify\(r\.cwd\)|usableAgents\(s\)/.test(src));
  // the text of a failed start is never taken out of the box: only a start that worked clears the unsaved goal
  assert.ok(!/unsavedRunDraft\([^)]*\)\.write\(null\)/.test(src));
  assert.equal(actions.split(".write(null)").length, 2);
  assert.match(actions, /const started = await api\.startRun\(id, goal\);\s*unsavedRunDraft\(id\)\.write\(null\);/);
  assert.ok(!/input\.current\?\.set\(""\)/.test(src));
});

// ---- a draft of a section with no agent that can run it (the view's `blocked` says "this server")

test("a draft of a section with no agent: the line and Send's title take the agent choice's reason before the view's `blocked`", () => {
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
  // what comes before it stays before it: the start's error, a folder that is gone
  assert.equal(runLine(studio, r, "The start failed.", (p) => p, none)!.text, "The start failed.");
  assert.match(runLine(studio, { ...r, folderMissing: true }, "", (p) => p, none)!.text, /^Folder not found/);
  assert.equal(runStartBlock(studio, { ...r, folderMissing: true }, "goal", none), "Pick a folder that exists first");
});

// ---- refusals the start route and a draft's PATCH and DELETE answer while the run is being started

test("a start refused with run_changed, busy or a code the page does not know: the server's sentence once under the box, the goal kept", () => {
  const changed = "The run was changed while it was being started; it was not started on Studio.";
  assert.deepEqual(startFailure(new ApiError(409, changed, true, "run_changed")), { text: changed, reread: true });
  assert.deepEqual(startFailure(new ApiError(409, "The run is being started.", true, "busy")), { text: "The run is being started.", reread: true });
  assert.deepEqual(startFailure(new ApiError(409, "Something new.", true, "a_code_of_tomorrow")), { text: "Something new.", reread: true });
  assert.deepEqual(startFailure(new ApiError(502, "Studio could not start the run.", true, "another_new_code")), { text: "Studio could not start the run.", reread: false });
  // once: the sentence is the one line under the box, before anything the view says
  const r = { cwd: "/home/u/x", git: true, blocked: "Blocked." };
  assert.deepEqual(runLine(studio, r, changed), { tone: "error", text: changed });
  assert.deepEqual(runLine(mini, r, changed), { tone: "error", text: changed }, "also before the server that is not connected");
  // kept: startRun puts the sentence in the store and takes nothing out of the box or of the unsaved goal
  assert.match(actions, /setRunStart\(id, \{ starting: false, error: f\.text \}\);/);
  assert.match(actions, /if \(f\.reread\) void refreshRun\(id\);/);
  const failed = actions.slice(actions.indexOf("} catch (e) {", actions.indexOf("export async function startRun")), actions.indexOf("/** Asks again while"));
  assert.doesNotMatch(failed, /unsavedRunDraft|write\(/);
});

test("a change (PATCH) of a draft refused 409 busy shows its sentence where the other refusals of that action show", () => {
  const busy = new ApiError(409, "The run is being started.", true, "busy");
  // a change: the sentence, shown as any refused change's (under the box, or in the settings form), and the run is read again
  assert.equal(changeFailure, startFailure, "a refused change leaves what a refused start leaves");
  assert.deepEqual(changeFailure(busy), { text: "The run is being started.", reread: true });
  assert.deepEqual(changeFailure(new ApiError(503, "Studio is not connected.", true, "server_unreachable")), { text: "Studio is not connected.", reread: false });
  assert.ok(src.includes("(e) => { onError(changeFailure(e).text); failed(e); }"));
  assert.ok(src.includes("const failed = (e: unknown) => { if (changeFailure(e).reread) void refreshRun(r.id); };"));
  assert.ok(src.includes("if (shown.current) setErr(e.message); else onError(e.message);"));
});

// ---- the start's state is the store's, by run id (State.runStarts)

const facts = (o: Partial<StartFacts> = {}): StartFacts => ({ cwd: "/home/u/x", connected: true, ...o });

test("what the server said about a start is old when the run's folder or what blocks it changed, or its server is connected again", () => {
  assert.equal(startErrorOld(facts(), facts()), false);
  assert.equal(startErrorOld(facts({ folderMissing: false, blocked: "" }), facts()), false, "absent and empty are the same");
  assert.equal(startErrorOld(facts(), facts({ folderMissing: false, blocked: "" })), false);
  assert.equal(startErrorOld(facts(), facts({ cwd: "/home/u/y" })), true);
  assert.equal(startErrorOld(facts(), facts({ folderMissing: true })), true);
  assert.equal(startErrorOld(facts({ folderMissing: true }), facts()), true);
  assert.equal(startErrorOld(facts(), facts({ blocked: "Blocked." })), true);
  assert.equal(startErrorOld(facts({ blocked: "Blocked." }), facts({ blocked: "Blocked otherwise." })), true);
  // the run's server: back, not away
  assert.equal(startErrorOld(facts({ connected: false }), facts()), true);
  assert.equal(startErrorOld(facts(), facts({ connected: false })), false);
  assert.equal(startErrorOld(facts({ connected: false }), facts({ connected: false })), false);
  assert.equal(startErrorOld(facts({ connected: false }), facts({ connected: false, cwd: "/home/u/y" })), true, "another folder, with the server still away");
  // nothing else of the run is compared: neither a server (its key says it, and a key does not change) nor a start mark
  assert.equal(startErrorOld(facts({ server: "s_1", start: "unconfirmed" } as Partial<StartFacts>), facts({ server: "s_2" } as Partial<StartFacts>)), false);
});

test("the starts by run: set, cleared, and dropped when old", () => {
  const none: Record<string, RunStart> = {};
  const going = withRunStart(none, "s_1~r_1", { starting: true, error: "" });
  assert.deepEqual(going, { "s_1~r_1": { starting: true, error: "" } });
  assert.equal(withRunStart(going, "s_1~r_1", { starting: true }), going, "the map itself when nothing changes");
  const failed = withRunStart(going, "s_1~r_1", { starting: false, error: "Studio did not answer." });
  assert.deepEqual(failed, { "s_1~r_1": { starting: false, error: "Studio did not answer." } });
  assert.deepEqual(withRunStart(failed, "s_1~r_1", { error: "" }), {}, "nothing left to say: no entry");
  assert.deepEqual(withRunStart(failed, "s_1~r_1", null), {});
  assert.equal(withRunStart(none, "s_1~r_1", null), none);
  assert.deepEqual(withRunStart(going, "s_1~r_1", { error: "x" }), { "s_1~r_1": { starting: true, error: "x" } });
  // the run of this computer with the same id has a start of its own
  assert.deepEqual(withRunStart(failed, "r_1", { starting: true }), { "s_1~r_1": failed["s_1~r_1"], r_1: { starting: true, error: "" } });

  // what the store does whenever a run or the sections change: r_1 failed, r_2 is on its way, both of the section s_1
  const A = "s_1~r_1", B = "s_1~r_2";
  const draft = { cwd: "/home/u/x" };
  const starts = { [A]: failed[A], [B]: going[A] };
  const runs = { [A]: draft, [B]: draft };
  const up = { runs, connected: () => true }, down = { runs, connected: () => false };
  assert.equal(keptRunStarts(starts, up, up), starts);
  assert.equal(keptRunStarts(starts, up, { runs: { [A]: { ...draft }, [B]: draft }, connected: () => true }), starts, "the same facts in another object");
  // the red line of a start that got no answer goes when the server is back
  assert.deepEqual(keptRunStarts(starts, down, up), { [B]: going[A] }, "the server is connected again");
  assert.equal(keptRunStarts(starts, up, down), starts, "a server that goes away drops nothing");
  assert.equal(keptRunStarts(starts, down, down), starts, "nor one that stays away");
  // connected is asked by run: the tree of another section coming back drops nothing of this one
  const asked: string[] = [];
  const other = { runs, connected: (run: string) => { asked.push(run); return serverOfKey(run) !== "s_1"; } };
  assert.equal(keptRunStarts(starts, down, other), starts);
  assert.deepEqual(asked, [A], "only for a run with a sentence to drop");
  const changed = { [A]: { ...draft, cwd: "/home/u/y" }, [B]: { ...draft, cwd: "/home/u/y" } };
  assert.deepEqual(keptRunStarts(starts, up, { runs: changed, connected: () => true }), { [B]: going[A] }, "a start on its way stays: its answer ends it");
  assert.deepEqual(keptRunStarts(starts, up, { runs: { ...runs, [A]: { ...draft, blocked: "Blocked." } }, connected: () => true }), { [B]: going[A] });
  // a run that is gone takes its start with it; one that is new under its key keeps what was set for it
  assert.deepEqual(keptRunStarts(starts, up, { runs: { [A]: draft }, connected: () => true }), { [A]: failed[A] });
  assert.deepEqual(keptRunStarts(starts, up, { runs: {}, connected: () => true }), {});
  assert.equal(keptRunStarts({ "s_1~r_9": failed[A] }, up, { runs: { ...runs, "s_1~r_9": draft }, connected: () => true })["s_1~r_9"], failed[A]);
});

test("the store asks whether a run's server is connected by the run's key, against the sections before and after", () => {
  const sections = { s_1: {} };
  const at = (s: Record<string, unknown>) => (run: string) => serverConnected({ sections: s }, serverOfKey(run));
  assert.deepEqual([at(sections)("s_1~r_1"), at(sections)("s_2~r_1"), at(sections)("r_1"), at({})("s_1~r_1"), at({})("r_1")], [true, false, true, false, true]);
  const starts = { "s_1~r_1": { starting: false, error: "Studio is not connected." }, r_1: { starting: false, error: "Folder not found: /x" } };
  const runs = { "s_1~r_1": { cwd: "/home/u/x" }, r_1: { cwd: "/x" } };
  // the section's tree arrives: the sentence of the section's run goes, the local run's stays
  assert.deepEqual(keptRunStarts(starts, { runs, connected: at({}) }, { runs, connected: at(sections) }), { r_1: starts.r_1 });
  assert.equal(keptRunStarts(starts, { runs, connected: at(sections) }, { runs, connected: at({}) }), starts, "and nothing goes when the tree does");
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
  assert.match(store, /if \(p\.runs \|\| p\.sections\) \{\s*const from = p\.runStarts \?\? state\.runStarts;\s*const at = \(sections: State\["sections"\]\) => \(run: string\) => serverConnected\(\{ sections \}, serverOfKey\(run\)\);\s*const runStarts = keptRunStarts\(from, \{ runs: state\.runs, connected: at\(state\.sections\) \}, \{ runs: p\.runs \?\? state\.runs, connected: at\(p\.sections \?\? state\.sections\) \}\);/);
  // a run keeps its key from the moment it is made: no start is moved to another id
  assert.ok(!store.includes("movedRunStart") && !readFileSync(new URL("../src/logic/runcompose.ts", import.meta.url), "utf8").includes("movedRunStart"));
});
