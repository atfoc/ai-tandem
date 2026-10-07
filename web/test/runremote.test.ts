// A run on another server in the sidebar and in the run's panes (task W2b of phase 9): its row,
// the "server unreachable" and gone views of its stage, its delete dialog, and the lists and
// folders read through the run's server. The components are pinned in their source: the tests
// have no DOM.
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLabel, applySetting, byHandLine, deliveryTitle, localRuns, runActBlock, runRow, runRowTip, yourFolder } from "../src/logic/runrows.ts";
import { deliveryCard, sayText } from "../src/logic/rundelivery.ts";
import { folderOn, offersChatOn, runDeleteAsk, runDeleteRefused, runRemoteView, runWhere } from "../src/logic/runserver.ts";
import { runDot, runRowLine } from "../src/logic/run.ts";
import { runRowTitle } from "../src/logic/siderun.ts";
import { remoteRow } from "../src/logic/status.ts";
import { REMOVE, REMOVE_ONLY, SERVERS } from "../src/logic/remoteview.ts";
import { catalogFor } from "../src/logic/agentlist.ts";
import { tildeBy } from "../src/logic/chatserver.ts";
import { listsOf, serverOf, type ListsState } from "../src/logic/serverlists.ts";
import { ApiError } from "../src/api.ts";
import type { ServerView } from "../src/logic/servers.ts";
import { TASK_STATES, type Catalog, type RunCounts, type RunDelivery, type RunStatus, type RunView } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const counts = (over: Partial<RunCounts> = {}): RunCounts => ({ ...Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as RunCounts, ...over });
const run = (status: RunStatus, over: Partial<RunView> = {}): RunView => ({
  id: "r_1", name: "Checkout rewrite", group: "g", created: "2026-10-01T00:00:00Z",
  agent: "claude", tiers: { deep: { model: "opus" }, standard: { model: "opus" }, light: { model: "opus" } }, cwd: "/home/u/shop", git: true,
  settings: { maxParallel: 4, maxTurns: 60, maxCost: 0, wake: "each", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 },
  ...(status === "draft" ? {} : { started: "2026-10-01T00:01:00Z" }),
  status, activeMs: 0, asOf: 0, turns: 0, idleStreak: 0, counts: counts(), cost: 0, attention: 0, server: "s_1", ...over,
});
const entry = (id: string, name: string, state: ServerView["state"]): ServerView => ({ id, name, state } as ServerView);
const cat = (model: string): Catalog => ({ models: [], default: { model } } as unknown as Catalog);
const state: ListsState = {
  usable: ["claude"], catalogs: { claude: cat("local") }, home: "/Users/me", defaultCwd: "/Users/me/code",
  servers: [{ id: "local", name: "This computer", state: "connected", local: true } as ServerView, entry("s_1", "Studio", "connected"), entry("s_2", "Mini", "unreachable")],
  lists: { s_1: { agents: ["claude"], catalogs: { claude: cat("studio") }, home: "/home/u", defaultCwd: "/home/u/work" } },
};
const HERE = { server: "local", name: "This computer", connected: true }, STUDIO = { server: "s_1", name: "Studio", connected: true };

// ---- the row (AC17)

test("runRow: a run of this computer is as it was", () => {
  const r = run("running", { server: undefined, turns: 2, counts: counts({ done: 1, work: 1 }) });
  assert.deepEqual(runRow(r, "This computer", true), { line: "Turn 2 · 1 of 2 tasks done", dot: "thinking", off: false, gone: false, title: "" });
  assert.equal(runRow(run("completed", { server: undefined }), "This computer", true).dot, null);
  assert.equal(runRowTip(r, ["Shop"], runRow(r, "This computer", true)), runRowTitle(r, ["Shop"]));
});

test("runRow: connected, the server's name follows the line and the dot is a local run's: working, attention, finished, archived", () => {
  const working = run("running", { turns: 2, counts: counts({ done: 1, work: 1 }) });
  assert.deepEqual(runRow(working, "Studio", true), { line: "Turn 2 · 1 of 2 tasks done · Studio", dot: "thinking", off: false, gone: false, title: "" });
  // it is remoteRow over the run's line and dot
  assert.deepEqual(runRow(working, "Studio", true), remoteRow(working, "Studio", true, runRowLine(working), runDot(working)!));
  // attention: a stalled run is amber, an error red
  assert.deepEqual(runRow(run("stalled", { stalledBy: "turns" }), "Studio", true), { line: "Stalled: turn limit · Studio", dot: "approval", off: false, gone: false, title: "" });
  assert.deepEqual(runRow(run("error", { reason: "boom" }), "Studio", true), { line: "Error: boom · Studio", dot: "error", off: false, gone: false, title: "" });
  // finished: no dot, as a local run's
  assert.deepEqual(runRow(run("completed", { counts: counts({ done: 3 }) }), "Studio", true), { line: "Completed · 3 tasks · Studio", dot: null, off: false, gone: false, title: "" });
  // archived, and a draft
  const archived = run("stopped", { archived: true });
  assert.equal(runRow(archived, "Studio", true).line, `${runRowLine(archived)} · Studio`);
  assert.equal(runRow(run("draft"), "Studio", true).line, `${runRowLine(run("draft"))} · Studio`);
  assert.equal(runRowTip(working, ["Shop"], runRow(working, "Studio", true)), "Shop / Checkout rewrite — Turn 2 · 1 of 2 tasks done · Studio");
});

test("runRow: not connected, the row is off with a grey dot and its title says so", () => {
  const working = run("running", { turns: 2 });
  const row = runRow(working, "Studio", false);
  assert.deepEqual(row, { line: "Turn 2 · Studio", dot: "off", off: true, gone: false, title: "Studio is not connected" });
  assert.equal(runRowTip(working, ["Shop"], row), "Studio is not connected");
  // a finished run has no dot of its own: it gets the grey one too
  assert.equal(runRow(run("completed"), "Studio", false).dot, "off");
  assert.equal(runRow(run("stopped", { archived: true }), "Studio", false).off, true);
});

test("runRow: a run its server no longer has says that alone", () => {
  for (const connected of [true, false]) {
    assert.deepEqual(runRow(run("running", { gone: true, turns: 4 }), "Studio", connected),
      { line: "No longer on Studio", dot: "off", off: false, gone: true, title: "No longer on Studio" });
  }
});

test("the sidebar's run row: classes, line, title, menu and + by the run's server", () => {
  const s = src("Sidebar.tsx"), node = s.slice(s.indexOf("const RunNode"), s.indexOf("const ChatRow"));
  assert.match(node, /const row = runRow\(r, serverIs, connected\);/);
  assert.match(node, /serverName\(s, server\)/);
  assert.match(node, /serverConnected\(s, server\)/);
  assert.match(node, /\$\{row\.off \? "off" : ""\} \$\{row\.gone \? "gone" : ""\}/);
  assert.match(node, /title=\{runRowTip\(r, groupPath\(groups, r\.group\), row\)\}/);
  assert.match(node, /<div className="side-sub">\{row\.line\}<\/div>/);
  assert.match(node, /crow-dot st-\$\{dot\}/);
  // gone: "Remove from this sidebar" alone, no rename and no drag
  assert.match(node, /const menu = row\.gone\s*\? \[\{ label: REMOVE, run: \(\) => deleteRun\(r\) \}\]/);
  assert.equal(REMOVE, "Remove from this sidebar");
  assert.match(node, /if \(!r\.archived && !row\.gone\) setEditing\(key\)/);
  // "+" only where a chat can be made on the run
  assert.match(node, /\{offersChatOn\(r\) && !row\.gone && \(\s*<AddChat title="New chat on this run"/);
  assert.equal(offersChatOn(run("draft")), false);
  assert.equal(offersChatOn(run("running")), true);
  assert.equal(offersChatOn(run("draft", { server: undefined })), true);
  assert.equal(offersChatOn(run("stopped", { archived: true })), false);
  // the bar above the run's stage offers "+ Chat on this run" by the same rule: not on a draft of another server, not on a gone run
  const bar = src("run/RunBar.tsx");
  assert.match(bar, /const offersChat = useStore\(\(s\) => \{ const r = s\.runs\[run\]; return !!r && offersChatOn\(r\) && !r\.gone; \}\);/);
  assert.match(bar, /\{offersChat && \(\s*<button className="btn sm run-bar-chat"[^>]*onClick=\{\(\) => void newChat\(\{ run \}\)\}>/);
  assert.doesNotMatch(bar, /\{!r\.archived && \(/);
  const css = src("remotechat.css");
  assert.match(css, /\.side-row\.is-run\.off \.side-run-icon/);
  assert.match(src("styles.css"), /\.crow-dot\.st-off \{/);
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

test("the delete dialog of a remote run names the server beside the folder, and offers this sidebar only for a gone run or after 503 and 504", () => {
  const r = run("completed");
  assert.deepEqual(runDeleteAsk(r, r.name, "Studio", "~/shop"), {
    title: "Delete Checkout rewrite?", action: "Delete", local: false,
    body: "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio. What its agents changed in ~/shop on Studio stays. This can't be undone.",
  });
  assert.deepEqual(runDeleteAsk(run("running", { gone: true }), r.name, "Studio", "~/shop"),
    { title: "Remove Checkout rewrite from this sidebar?", body: "This run is no longer on Studio.", action: REMOVE_ONLY, local: true });
  assert.equal(REMOVE_ONLY, "Remove from this sidebar only");
  // while the server is not connected: 503, nothing was sent; 504, no answer came and it is not known what became of the run
  for (const [status, code, said, what] of [[503, "server_unreachable", "Studio is not connected.", "The run was not deleted."], [504, "no_answer", "Studio did not answer.", "It is not known whether the run was deleted."]] as const) {
    assert.deepEqual(runDeleteRefused(r, r.name, "Studio", new ApiError(status, said, true, code), false), {
      title: "Remove Checkout rewrite from this sidebar?", action: REMOVE_ONLY, local: true,
      body: `${said} ${what} Removing it from this sidebar leaves the run on Studio.`,
    });
  }
  // a 504 while the server is connected: no offer the server would refuse, and no "was not deleted"
  assert.deepEqual(runDeleteRefused(r, r.name, "Studio", new ApiError(504, "Studio did not answer.", true, "no_answer"), true),
    { title: "Delete Checkout rewrite?", body: "Studio did not answer. It is not known whether the run was deleted.", action: "Delete", local: false });
  assert.equal(runDeleteRefused(r, r.name, "Studio", new ApiError(409, "Studio is connected: delete the run there.", true, "server_connected"), true), null);
  assert.equal(runDeleteRefused(run("completed", { server: undefined }), r.name, "This computer", new ApiError(503, "x", true, "server_unreachable"), false), null);
});

test("the sidebar's deleteRun: the dialog by runDeleteAsk, the folder by the run's server, and the local-only call after a refusal", () => {
  const s = src("Sidebar.tsx"), f = s.slice(s.indexOf("export function deleteRun"), s.indexOf("function deleteChat"));
  assert.match(f, /server = serverOf\(r\), name = serverName\(s, server\), folder = tildify\(r\.cwd, server\)/);
  assert.match(f, /run: \(\) => api\.deleteRun\(r\.id, \{ local: ask\.local \}\)/);
  assert.match(f, /refused: \(err\) => \{ const next = ask\.local \? null : runDeleteRefused\(r, r\.name, name, err, serverConnected\(getState\(\), server\)\); return next && dialog\(next\); \}/);
  assert.match(f, /confirm\(dialog\(runDeleteAsk\(r, r\.name, name, folder\)\)\);/);
  assert.match(src("api.ts"), /deleteRun: \(id: string, o: \{ local\?: boolean \} = \{\}\) => call\("DELETE", `\/api\/runs\/\$\{id\}\$\{o\.local \? "\?local=1" : ""\}`\)/);
  assert.doesNotMatch(src("Sidebar.tsx"), /tildify\(r\.cwd\)/);
});

// ---- "Server unreachable" (run/RunView.tsx)

test("the stage of a remote run: the three cases of its view", () => {
  const err = { code: "server_unreachable", message: "Studio is not connected." };
  // 1. no detail and an error: the sentence, the entry's state and "Servers…"
  assert.deepEqual(runRemoteView(run("running"), "Studio", "unreachable", false, err),
    { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "Unreachable" });
  // 2. gone there (the load's answer) or gone (the record's mark): the sentence and "Remove from this sidebar"
  assert.deepEqual(runRemoteView(run("running"), "Studio", "connected", false, { code: "gone_there", message: "This run is no longer on Studio." }), { kind: "gone", text: "This run is no longer on Studio." });
  assert.deepEqual(runRemoteView(run("running", { gone: true }), "Studio", "unreachable", false), { kind: "gone", text: "This run is no longer on Studio." });
  // 3. a detail on screen stays, with a bar
  assert.deepEqual(runRemoteView(run("running"), "Studio", "unreachable", true, err), { kind: "bar", text: "Studio is not connected.", gone: false });
  assert.deepEqual(runRemoteView(run("running", { gone: true }), "Studio", "connected", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  // none: connected with its detail, and a run of this computer whatever failed
  assert.deepEqual(runRemoteView(run("running"), "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(runRemoteView(run("running", { server: undefined }), "This computer", "connected", false, err), { kind: "none" });
  assert.equal(SERVERS, "Servers…");
});

test("run/RunView.tsx shows the view by runRemoteView", () => {
  const s = src("run/RunView.tsx");
  assert.match(s, /const loadErr = useStore\(\(s\) => s\.runErrors\[runId\]\);/);
  assert.match(s, /const state = useStore\(\(s\) => serverState\(s, server\)\);/);
  assert.match(s, /const remote = runRemoteView\(r, serverIs, state, !!detail, loadErr\);/);
  // in place of the detail
  assert.match(s, /if \(remote\.kind === "unreachable" \|\| remote\.kind === "gone"\) return \(\s*<div className="run-view run-loading run-remote">\s*<div className=\{`remote-off \$\{remote\.kind\}`\} role="status">/);
  assert.match(s, /<p className="remote-off-text">\{remote\.text\}<\/p>/);
  assert.match(s, /remote\.kind === "unreachable" && remote\.state && <p className="remote-off-state">\{remote\.state\}<\/p>/);
  assert.match(s, /<button type="button" className="btn sm remote-servers" onClick=\{\(\) => openServers\(\)\}>\{SERVERS\}<\/button> : <RemoveHere runId=\{runId\} \/>/);
  assert.match(s, /className="btn sm remote-remove" onClick=\{\(\) => api\.deleteRun\(runId, \{ local: true \}\)/);
  // over a detail that stays
  assert.match(s, /remote\.kind === "bar" && \(\s*<div className=\{`remote-bar run-remote-bar \$\{remote\.gone \? "gone" : "off"\}`\} role="status">\s*<span className="remote-bar-text">\{remote\.text\}<\/span>/);
  assert.match(s, /\{stale && connected && remote\.kind !== "bar" && <div className="run-stale note"/); // the bar says why it is not current
  assert.match(src("remotechat.css"), /\.remote-bar\.run-remote-bar \{/);
});

test("the run bar: no Stop and no Resume while the run's server is not connected, none for a gone run", () => {
  assert.equal(runActBlock(HERE), "");
  assert.equal(runActBlock(STUDIO), "");
  assert.equal(runActBlock(runWhere(state, { server: "s_2" })), "Mini is not connected");
  const s = src("run/RunBarStatus.tsx");
  assert.match(s, /runActBlock\(runWhere\(s, v\)\)/);
  assert.match(s, /acts = !r\.archived && !r\.gone/);
  assert.equal((s.match(/\|\| !!off\}/g) ?? []).length, 2);
});

// ---- lists and folders by the run's server (AC18)

test("the run's panes read the catalog of the run's server, never this computer's", () => {
  assert.equal(catalogFor(state, serverOf(run("running")), "claude")?.default.model, "studio");
  assert.equal(catalogFor(state, serverOf(run("running", { server: undefined })), "claude")?.default.model, "local");
  for (const f of ["AgentPane", "RunGoal", "RunHead", "RunTask", "RunUsage", "RunView"]) {
    const s = src(`run/${f}.tsx`);
    assert.doesNotMatch(s, /LOCAL_SERVER/, f);
    assert.match(s, /catalogFor\(s, (serverOf\(r\)|server), r\.agent\)/, f);
    if (/catalogFor\(s, server,/.test(s)) assert.match(s, /const server = serverOf\(r\);/, f);
  }
});

test("head and goal show the folder with the server's home as ~ and name another server", () => {
  const folder = (r: RunView) => folderOn(runWhere(state, r), tildeBy(listsOf(state, serverOf(r))?.home, r.cwd));
  assert.equal(folder(run("running")), "~/shop on Studio");
  assert.equal(folder(run("running", { server: undefined, cwd: "/Users/me/shop" })), "~/shop");
  assert.equal(folder(run("running", { server: undefined })), "/home/u/shop"); // the same path here is not under this computer's home
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

test("localRuns: the runs with no server", () => {
  assert.deepEqual(localRuns([{ id: "a" }, { id: "b", server: "s_1" }, { id: "c", server: "" }]).map((r) => r.id), ["a", "c"]);
});
