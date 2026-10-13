// A run of a section (a remote server of the server list) in the sidebar and in the run's panes:
// its row, which is the row of any run, the view of its stage while its server is not connected
// and when the run is no longer there, its delete dialog, and the lists and folders read through
// the run's server. Which server a run is on is read from its key, "<entry id>~<id>"
// (src/logic/keys.ts). The components are pinned in their source: the tests have no DOM.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLabel, applySetting, byHandLine, deliveryTitle, localRuns, runActBlock, yourFolder } from "../src/logic/runrows.ts";
import { deliveryCard, sayText } from "../src/logic/rundelivery.ts";
import { folderOn, offersChatOn, runDeleteAsk, runRemoteView, runWhere } from "../src/logic/runserver.ts";
import { runDot, runRowLine } from "../src/logic/run.ts";
import { runRowTitle } from "../src/logic/siderun.ts";
import { NOT_FOUND, SERVERS } from "../src/logic/remoteview.ts";
import { catalogFor } from "../src/logic/agentlist.ts";
import { tildeBy } from "../src/logic/chatserver.ts";
import { listsOf, serverOf, type ListsState } from "../src/logic/serverlists.ts";
import type { ServerView } from "../src/logic/servers.ts";
import { TASK_STATES, type Catalog, type RunCounts, type RunDelivery, type RunStatus, type RunView } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
/** Two entries of the server list, and the run r_1 of the first one's section and of this computer. */
const S1 = "s_aaaaaaaaaaaa", S2 = "s_bbbbbbbbbbbb";
const THERE = `${S1}~r_1`, MINE = "r_1";
const counts = (over: Partial<RunCounts> = {}): RunCounts => ({ ...Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as RunCounts, ...over });
/** A run of the section S1; `{ id: MINE }` makes it this computer's. */
const run = (status: RunStatus, over: Partial<RunView> = {}): RunView => ({
  id: THERE, name: "Checkout rewrite", group: `${S1}~g`, created: "2026-10-01T00:00:00Z",
  agent: "claude", tiers: { deep: { model: "opus" }, standard: { model: "opus" }, light: { model: "opus" } }, cwd: "/home/u/shop", git: true,
  settings: { maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 },
  ...(status === "draft" ? {} : { started: "2026-10-01T00:01:00Z" }),
  status, activeMs: 0, asOf: 0, turns: 0, idleStreak: 0, counts: counts(), cost: 0, attention: 0, ...over,
});
const entry = (id: string, name: string, state: ServerView["state"]): ServerView => ({ id, name, state } as ServerView);
const cat = (model: string): Catalog => ({ models: [], default: { model } } as unknown as Catalog);
/** Studio is connected: the local server holds its tree. Mini is not. */
const state: ListsState = {
  usable: ["claude"], catalogs: { claude: cat("local") }, home: "/Users/me", defaultCwd: "/Users/me/code",
  servers: [{ id: "local", name: "This computer", state: "connected", local: true } as ServerView, entry(S1, "Studio", "connected"), entry(S2, "Mini", "unreachable")],
  lists: { [S1]: { agents: ["claude"], catalogs: { claude: cat("studio") }, home: "/home/u", defaultCwd: "/home/u/work" } },
  sections: { [S1]: { groups: [], defaults: { groups: {} } } },
};
const HERE = { server: "local", name: "This computer", connected: true }, STUDIO = { server: S1, name: "Studio", connected: true };

// ---- the row: one row for every run, in the local part and in a section

test("the row of a section's run is the row of a run of this computer: its own line, dot and title, and no server's name", () => {
  const there = run("running", { turns: 2, counts: counts({ done: 1, work: 1 }) }), mine = { ...there, id: MINE, group: "g" };
  assert.equal(runRowLine(there), "Turn 2 · 1 of 2 tasks done");
  assert.deepEqual([runRowLine(there), runDot(there), runRowTitle(there, ["Shop"])], [runRowLine(mine), runDot(mine), runRowTitle(mine, ["Shop"])]);
  assert.equal(runRowTitle(there, ["Shop"]), "Shop / Checkout rewrite — Turn 2 · 1 of 2 tasks done");
  for (const r of [run("stalled", { stalledBy: "turns" }), run("error", { reason: "boom" }), run("completed", { counts: counts({ done: 3 }) }), run("stopped", { archived: true }), run("draft")]) {
    assert.doesNotMatch(runRowLine(r), /Studio/, r.status);
    const here: RunView = { ...r, id: MINE };
    assert.deepEqual([runRowLine(r), runDot(r)], [runRowLine(here), runDot(here)], r.status);
  }
  // the sidebar draws it so: the section says which server it is, and a server that is not connected has no row to draw
  const s = src("Sidebar.tsx"), node = s.slice(s.indexOf("const RunNode"), s.indexOf("const ChatRow"));
  assert.match(node, /const dot = runDot\(r\);/);
  assert.match(node, /title=\{runRowTitle\(r, groupPath\(groups, r\.group\)\)\}/);
  assert.match(node, /<div className="side-sub">\{runRowLine\(r\)\}<\/div>/);
  assert.match(node, /crow-dot st-\$\{dot\}/);
  assert.match(node, /const groups = useStore\(\(s\) => groupsOn\(s, serverOf\(r\)\)\);/, "its path is in the groups of its own server");
  assert.doesNotMatch(node, /serverName|serverConnected|row\.off|row\.gone|gone|REMOVE/);
  assert.doesNotMatch(src("logic/runrows.ts"), /export (const|function) (runRow|runRowTip)\b/);
  assert.doesNotMatch(src("remotechat.css"), /\.side-row\.is-run\.off/);
});

test("the sidebar's run row: the menu and the + of any run, whatever its server", () => {
  const s = src("Sidebar.tsx"), node = s.slice(s.indexOf("const RunNode"), s.indexOf("const ChatRow"));
  // rename, archive and delete, each made on the run's server; no "Remove from this sidebar"
  assert.match(node, /\[\{ label: "Rename", run: \(\) => setEditing\(key\) \},\s*\{ label: "Archive", run: \(\) => archiveRun\(r\) \},\s*\{ label: "Delete", tone: "danger" as const, run: \(\) => deleteRun\(r\) \}\]/);
  assert.match(node, /onDoubleClick=\{\(\) => \{ if \(!r\.archived\) setEditing\(key\); \}\}/);
  assert.doesNotMatch(s, /Remove from this sidebar/);
  // "+" where a chat can be made on the run: on a run that has not started too, which is on its server from the moment it is made
  assert.match(node, /\{offersChatOn\(r\) && \(\s*<AddChat title="New chat on this run"/);
  assert.equal(offersChatOn(run("draft")), true);
  assert.equal(offersChatOn(run("running")), true);
  assert.equal(offersChatOn(run("draft", { id: MINE })), true);
  assert.equal(offersChatOn(run("stopped", { archived: true })), false);
  // the bar above the run's stage offers "+ Chat on this run" by the same rule, and not for a run that takes no call now: its server is not
  // connected, or no longer has it
  const bar = src("run/RunBar.tsx");
  assert.match(bar, /const offersChat = useStore\(\(s\) => \{ const r = s\.runs\[run\]; return !!r && offersChatOn\(r\) && reachable\(s, run\); \}\);/);
  assert.match(bar, /\{offersChat && \(\s*<button className="btn sm run-bar-chat"[^>]*onClick=\{\(\) => void newChat\(\{ run \}\)\}>/);
  assert.doesNotMatch(bar, /\{!r\.archived && \(/);
});

test("an archive of a run that its server refuses shows the error: the row is never marked archived here", () => {
  const s = src("Sidebar.tsx"), f = s.slice(s.indexOf("function archiveRun"), s.indexOf("export function deleteRun"));
  assert.match(f, /const run = \(\) => api\.archive\("runs", r\.id\);/);
  assert.match(f, /if \(!ask\) return attempt\("Couldn't archive the run", run\);/); // reportError
  assert.match(f, /confirm\(\{ title: ask\.title, body: ask\.body, actions: \[\{ label: ask\.action, tone: "primary", run \}\] \}\);/); // the dialog shows what run throws
  assert.doesNotMatch(f, /upsertRun|archived: true|setState/);
  assert.match(s, /const attempt = \(title: string, f: \(\) => Promise<unknown>\) => \{ f\(\)\.catch\(\(e\) => reportError\(title, e\)\); \};/);
});

// ---- the delete dialog

test("the delete dialog of a section's run names the server, for everyone who uses it, and beside the folder; there is no delete of this sidebar alone", () => {
  const r = run("completed");
  assert.deepEqual(runDeleteAsk(r, r.name, "Studio", "~/shop"), {
    title: "Delete Checkout rewrite?",
    body: "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. What its agents changed in ~/shop on Studio stays. This can't be undone.",
  });
  // a run of this computer
  const here: RunView = { ...r, id: MINE };
  assert.deepEqual(runDeleteAsk(here, r.name, "", "~/shop"), {
    title: "Delete Checkout rewrite?",
    body: "The run's tasks, reports, notes, agent transcripts and chats are removed. What its agents changed in ~/shop stays. This can't be undone.",
  });
  // a working run is stopped first; one that has not started changed nothing in its folder
  assert.equal(runDeleteAsk(run("running"), r.name, "Studio", "~/shop").body,
    "This run is working: its agents are stopped. The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. What its agents changed in ~/shop on Studio stays. This can't be undone.");
  assert.equal(runDeleteAsk(run("draft"), r.name, "Studio", "~/shop").body,
    "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. This can't be undone.");
  assert.doesNotMatch(src("logic/runserver.ts"), /runDeleteRefused|REMOVE_ONLY|this sidebar/);
  assert.doesNotMatch(src("logic/remoteview.ts"), /REMOVE|this sidebar/);
});

test("the sidebar's deleteRun: the dialog by runDeleteAsk, the server's name and the folder by the run's key, and the one call, made on the run's server", () => {
  const s = src("Sidebar.tsx"), f = s.slice(s.indexOf("export function deleteRun"), s.indexOf("function deleteChat"));
  assert.match(f, /const ask = runDeleteAsk\(r, r\.name, there\(r\.id\), tildify\(r\.cwd, serverOf\(r\)\)\);/);
  assert.match(s, /const there = \(key: string\): string => \(inSection\(key\) \? serverName\(getState\(\), serverOfKey\(key\)\) : ""\);/);
  assert.match(f, /confirm\(\{ title: ask\.title, body: ask\.body, actions: \[\{ label: "Delete", tone: "danger", run: \(\) => api\.deleteRun\(r\.id\) \}\] \}\);/);
  assert.doesNotMatch(f, /local|refused/);
  assert.match(src("api.ts"), /deleteRun: \(id: string\) => call\("DELETE", pathOf\("runs", id\)\),/);
  assert.doesNotMatch(src("api.ts"), /local=1/);
  assert.doesNotMatch(src("Sidebar.tsx"), /tildify\(r\.cwd\)/);
});

// ---- the stage of a run whose server is not connected, or that is no longer there (run/RunView.tsx)

test("the stage of a section's run: what shows in place of its detail, and over a detail that stays", () => {
  const there = { remote: true, connected: true }, away = { remote: true, connected: false };
  const off = { code: "server_unreachable", message: "Studio is not connected." };
  // 1. no detail, and its server is not connected: the sentence, the entry's state and "Servers…"
  assert.deepEqual(runRemoteView(away, "Studio", "unreachable", false, off),
    { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "Unreachable" });
  assert.deepEqual(runRemoteView(away, "Studio", undefined, false), { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "" });
  // 2. no detail, and the run is no longer there: the page's mark, or the load's answer
  assert.equal(NOT_FOUND, "not_found");
  assert.deepEqual(runRemoteView(there, "Studio", "connected", false, { code: NOT_FOUND, message: "no such run" }), { kind: "gone", text: "This run is no longer on Studio." });
  assert.deepEqual(runRemoteView({ ...away, gone: true }, "Studio", "unreachable", false), { kind: "gone", text: "This run is no longer on Studio." });
  // 3. a detail on screen stays as it was, read-only, under a warning
  assert.deepEqual(runRemoteView(away, "Studio", "unreachable", true, off), { kind: "bar", text: "Studio is not connected. This run is shown as it was when the connection ended.", gone: false, state: "Unreachable" });
  assert.deepEqual(runRemoteView(away, "Studio", "too_old", true), { kind: "bar", text: "Studio is not connected. This run is shown as it was when the connection ended.", gone: false, state: "Too old: update the server on that machine" });
  assert.deepEqual(runRemoteView(away, "Studio", "certificate_changed", false), { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "Certificate changed" });
  assert.deepEqual(runRemoteView({ ...there, gone: true }, "Studio", "connected", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  assert.deepEqual(runRemoteView({ ...away, gone: true }, "Studio", "unreachable", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  // 4. connected, and the load failed for another reason: that server's sentence, as for a run of this computer
  assert.deepEqual(runRemoteView(there, "Studio", "connected", false, { code: "bad_answer", message: "Studio gave an answer that cannot be read." }), { kind: "failed", text: "Studio gave an answer that cannot be read." });
  // none: connected with its detail, or while it loads; and a run of this computer whatever failed
  assert.deepEqual(runRemoteView(there, "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(runRemoteView(there, "Studio", "connected", false), { kind: "none" });
  assert.deepEqual(runRemoteView({ remote: false, connected: true }, "This computer", "connected", false, off), { kind: "none" });
  assert.equal(SERVERS, "Servers…");
});

test("run/RunView.tsx shows the view by runRemoteView, and asks nothing of a server that cannot answer for the run", () => {
  const s = src("run/RunView.tsx");
  assert.match(s, /const server = serverOfKey\(runId\);/);
  assert.match(s, /const loadErr = useStore\(\(s\) => s\.runErrors\[runId\]\);/);
  assert.match(s, /const state = useStore\(\(s\) => serverState\(s, server\)\);/);
  assert.match(s, /const left = useStore\(\(s\) => !!s\.gone\[runId\]\);/);
  assert.match(s, /const there = useStore\(\(s\) => serverConnected\(s, server\)\);/);
  assert.match(s, /const remote = runRemoteView\(\{ remote: inSection\(runId\), connected: there, gone: left \}, serverIs, state, !!detail, loadErr\);/);
  // the detail is read only while the run's server is connected and has the run
  assert.match(s, /if \(d\) \{ setFails\(0\); return; \}\s*if \(!there \|\| left\) return;\s*let gone = false, timer = 0;\s*void loadRun\(runId\)/);
  // in place of the detail
  assert.match(s, /if \(remote\.kind === "unreachable" \|\| remote\.kind === "gone"\) return \(\s*<div className="run-view run-loading run-remote">\s*<div className=\{`remote-off \$\{remote\.kind\}`\} role="status">/);
  assert.match(s, /<p className="remote-off-text">\{remote\.text\}<\/p>/);
  assert.match(s, /remote\.kind === "unreachable" && remote\.state && <p className="remote-off-state">\{remote\.state\}<\/p>/);
  assert.match(s, /\{remote\.kind === "unreachable" && <button type="button" className="btn sm remote-servers" onClick=\{\(\) => openServers\(\)\}>\{SERVERS\}<\/button>\}/);
  assert.doesNotMatch(s, /RemoveHere|remote-remove|local: true/, "a run that is gone there has nothing to remove here");
  // over a detail that stays
  assert.match(s, /remote\.kind === "bar" && \(\s*<div className=\{`remote-bar run-remote-bar \$\{remote\.gone \? "gone" : "off"\}`\} role="status">\s*<span className="remote-bar-text">\{remote\.text\}<\/span>/);
  assert.match(s, /\{stale && connected && remote\.kind !== "bar" && <div className="run-stale note"/); // the bar says why it is not current
  assert.match(src("remotechat.css"), /\.remote-bar\.run-remote-bar \{/);
});

test("the run bar: no Stop and no Resume while the run's server is not connected, none for a run that is no longer there", () => {
  assert.equal(runActBlock(HERE), "");
  assert.equal(runActBlock(STUDIO), "");
  assert.deepEqual(runWhere(state, { id: THERE }), STUDIO);
  assert.deepEqual(runWhere(state, { id: MINE }), HERE);
  assert.deepEqual(runWhere(state, { id: `${S2}~r_1` }), { server: S2, name: "Mini", connected: false });
  assert.equal(runActBlock(runWhere(state, { id: `${S2}~r_1` })), "Mini is not connected");
  // the entry's state says the words; whether a call works is whether the local server holds the tree
  assert.equal(runWhere({ ...state, sections: {} }, { id: THERE }).connected, false);
  const s = src("run/RunBarStatus.tsx");
  assert.match(s, /runActBlock\(runWhere\(s, v\)\)/);
  assert.match(s, /const left = useStore\(\(s\) => !!s\.gone\[runId\]\);/);
  assert.match(s, /acts = !r\.archived && !left/);
  assert.equal((s.match(/\|\| !!off\}/g) ?? []).length, 2);
});

// ---- lists and folders by the run's server

test("the run's panes read the catalog of the run's server, never this computer's", () => {
  assert.equal(catalogFor(state, serverOf(run("running")), "claude")?.default.model, "studio");
  assert.equal(catalogFor(state, serverOf(run("running", { id: MINE })), "claude")?.default.model, "local");
  for (const f of ["AgentPane", "RunGoal", "RunHead", "RunTask", "RunUsage", "RunView"]) {
    const s = src(`run/${f}.tsx`);
    assert.doesNotMatch(s, /LOCAL_SERVER/, f);
    assert.match(s, /catalogFor\(s, (serverOf\(r\)|server), r\.agent\)/, f);
    if (/catalogFor\(s, server,/.test(s)) assert.match(s, /const server = serverOf\(r\);/, f);
    assert.doesNotMatch(s, /\br\.server\b/, f); // a run has no such field: its key says where it is
  }
});

test("head and goal show the folder with the server's home as ~ and name another server", () => {
  const folder = (r: RunView) => folderOn(runWhere(state, r), tildeBy(listsOf(state, serverOf(r))?.home, r.cwd));
  assert.equal(folder(run("running")), "~/shop on Studio");
  assert.equal(folder(run("running", { id: MINE, cwd: "/Users/me/shop" })), "~/shop");
  assert.equal(folder(run("running", { id: MINE })), "/home/u/shop"); // the same path here is not under this computer's home
  for (const f of ["RunHead", "RunGoal"]) {
    const s = src(`run/${f}.tsx`);
    assert.match(s, /folderOn\(runWhere\(s, r\), tildify\(r\.cwd, server\)\)/, f);
    assert.doesNotMatch(s, /tildify\(r\.cwd\)/, f);
  }
  assert.match(src("run/RunGoal.tsx"), /<span className="mono rd-wrap rd-folder" title=\{r\.cwd\}>\{folder\}<\/span>/);
  assert.equal((src("run/RunHead.tsx").match(/, in \$\{folder\}\. /g) ?? []).length, 2);
});

test("the delivery card and the head's chip name the server where a local run says \"your folder\"", () => {
  assert.equal(yourFolder(HERE), "your folder");
  assert.equal(yourFolder(STUDIO), "the folder on Studio");
  assert.equal(deliveryTitle(HERE, "Applied to your folder"), "Applied to your folder");
  assert.equal(deliveryTitle(STUDIO, "Applied to your folder"), "Applied to the folder on Studio");
  assert.equal(deliveryTitle(STUDIO, "Already in your folder"), "Already in the folder on Studio");
  assert.equal(deliveryTitle(STUDIO, "Ready to apply"), "Ready to apply");
  assert.equal(applyLabel(HERE), "Apply to my folder");
  assert.equal(applyLabel(STUDIO), "Apply to the folder on Studio");
  const d = src("run/Delivery.tsx");
  assert.match(d, /const home = useStore\(\(s\) => listsOf\(s, serverOf\(r\)\)\?\.home\);/); // "~" by the run's server
  assert.match(d, /\{deliveryTitle\(where, card\.title\)\}/);
  assert.match(d, /\{busy \? "Applying…" : applyLabel\(where\)\}/);
  assert.doesNotMatch(d, /my folder|s\.home\b/);
  const h = src("run/RunHead.tsx");
  assert.match(h, /const yours = useStore\(\(s\) => yourFolder\(runWhere\(s, r\)\)\);/);
  assert.doesNotMatch(h, /of your folder|: "your folder"/);
});

test("the settings switch, the card's sentences and the hand-merge line speak of the folder on the run's server, not of \"my\" or \"your\"", () => {
  assert.equal(applySetting(HERE), "Apply the result to my folder when the run ends");
  assert.equal(applySetting(STUDIO), "Apply the result to the folder on Studio when the run ends");
  const c = src("run/RunComposer.tsx");
  assert.match(c, /<span className="run-field-name">\{applySetting\(w\)\}/);
  assert.doesNotMatch(c, /my folder/);
  // the delivery card's sentences
  const facts = { cwd: "/home/u/shop", home: "/home/u", startBranch: "main", resultBranch: "aiwb/r_1/result", status: "completed" as const };
  const say = (d: RunDelivery, where?: typeof STUDIO) => sayText(deliveryCard(d, { ...facts, where })!.sentence);
  const merged: RunDelivery = { state: "applied", how: "merge", branch: "dev", commit: "cac8e17aa0" };
  assert.equal(say(merged, STUDIO), "The result was merged into dev with the commits of the folder on Studio (merge commit cac8e17).");
  assert.equal(say({ state: "pending", reason: "history_changed" }, STUDIO),
    "The branch of the folder on Studio no longer contains the commit this run started from (it was amended, rebased or reset). Apply brings that commit and its changes back along with the result.");
  assert.equal(say({ state: "blocked", reason: "conflict" }, STUDIO),
    "The commits of the folder on Studio and the result change the same lines. Merge by hand with the command below, run on Studio.");
  // a run of this computer, named or not, reads as before
  for (const where of [undefined, HERE]) {
    assert.equal(say(merged, where), "The result was merged into dev with your own commits (merge commit cac8e17).");
    assert.match(say({ state: "pending", reason: "history_changed" }, where), /^Your branch no longer contains /);
    assert.equal(say({ state: "blocked", reason: "conflict" }, where), "Your commits and the result change the same lines. Merge by hand with the command below.");
  }
  for (const d of [merged, { state: "pending", reason: "history_changed" }, { state: "blocked", reason: "conflict" }] as RunDelivery[])
    assert.doesNotMatch(say(d, STUDIO), /\byour\b/i);
  assert.match(src("run/Delivery.tsx"), /status: detail\.status, where \}\);/);
  // the command under "Do it by hand" is run where the folder is
  assert.equal(byHandLine(HERE), "To take it into the branch you are on:");
  assert.equal(byHandLine(STUDIO), "To take it into the branch the folder on Studio is on, run this on Studio:");
  const res = src("run/RunResult.tsx");
  assert.match(res, /const line = useStore\(\(s\) => byHandLine\(runWhere\(s, s\.runs\[runId\] \?\? \{\}\)\)\);/);
  assert.match(res, /that branch is the run's result\. \{line\}/);
  assert.doesNotMatch(res, /the branch you are on/);
});

test("localRuns: the runs of this computer, by their keys", () => {
  assert.deepEqual(localRuns([{ id: "a" }, { id: `${S1}~b` }, { id: "c" }, { id: `${S2}~a` }]).map((r) => r.id), ["a", "c"]);
});
