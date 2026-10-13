// A run by its server (src/logic/runserver.ts): what a draft run's composer reads through the server its key
// names, the view and the delete dialog of a section's run, and the rules of what is read again when a section's
// tree arrives and of the unfollow of a dropped run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Unfollows, folderOn, offersChatOn, runAgentReason, runAwayText, runDeleteAsk, runGoneText, runOffLine,
  runRemoteView, runSectionBack, runStartBlock, runUnreachableText, runWhere, withRunError } from "../src/logic/runserver.ts";
import { RUN_SERVER, RUN_SERVER_FINAL, listsOf, serverFixed, type ListsState } from "../src/logic/serverlists.ts";
import { agentChoiceOn, folderStarts, folderTitle, notConnectedLine, tildeBy } from "../src/logic/chatserver.ts";
import { catalogFor, usableAgents } from "../src/logic/agentlist.ts";
import { NOT_FOUND, type Remote } from "../src/logic/remoteview.ts";
import { keyOn } from "../src/logic/keys.ts";
import { startBlock } from "../src/logic/run.ts";
import type { ServerView } from "../src/logic/servers.ts";
import type { Catalog } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const entry = (id: string, name: string, state: ServerView["state"]): ServerView => ({ id, name, state } as ServerView);
const cat = (model: string): Catalog => ({ models: [], default: { model } } as unknown as Catalog);
// Studio is connected: the local server holds its tree. Mini and Old are not, and keep the lists they sent last.
const state: ListsState = {
  usable: ["claude", "pi"], catalogs: { claude: cat("local"), pi: cat("local-pi") }, home: "/Users/me", defaultCwd: "/Users/me/code",
  servers: [{ id: "local", name: "This computer", state: "connected", local: true } as ServerView, entry("s_1", "Studio", "connected"), entry("s_2", "Mini", "unreachable"), entry("s_3", "Old", "too_old")],
  lists: {
    s_1: { agents: ["pi"], catalogs: { pi: cat("studio-pi") }, home: "/home/u", defaultCwd: "/home/u/work" },
    s_2: { agents: ["claude"], catalogs: { claude: cat("mini") }, home: "/home/m", defaultCwd: "/home/m" },
  },
  sections: { s_1: {} },
};
/** The run r_1 of a section, and the run of this computer with the same id. */
const on = (server: string) => ({ id: keyOn(server, "r_1") });
const LOCAL = { id: "r_1" };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("runWhere: a run is on the server its key names, with the entry's name and whether the local server holds that server's tree", () => {
  assert.deepEqual(runWhere(state, LOCAL), { server: "local", name: "This computer", connected: true });
  assert.deepEqual(runWhere(state, {}), { server: "local", name: "This computer", connected: true });
  assert.deepEqual(runWhere(state, { id: "s_1~r_1" }), { server: "s_1", name: "Studio", connected: true });
  assert.deepEqual(runWhere(state, on("s_2")), { server: "s_2", name: "Mini", connected: false });
  assert.deepEqual(runWhere(state, on("s_3")), { server: "s_3", name: "Old", connected: false });
  assert.deepEqual(runWhere(state, on("s_9")), { server: "s_9", name: "Unknown server", connected: false });
  // by the tree, not by the entry's state: connected before its tree came is not connected yet
  assert.deepEqual(runWhere({ ...state, sections: {} }, on("s_1")), { server: "s_1", name: "Studio", connected: false });
  assert.deepEqual(runWhere({ ...state, sections: { s_2: {} } }, on("s_2")), { server: "s_2", name: "Mini", connected: true });
});

test("a run's server is no choice: a run is on the server it was made on, and a chat on a run on the run's (AC34)", () => {
  assert.equal(RUN_SERVER_FINAL, "A run is on the server it was made on");
  assert.equal(serverFixed({ run: "r_1" }), RUN_SERVER);
  assert.equal(serverFixed({ run: "s_1~r_1", board: undefined }), RUN_SERVER);
  // the choice of a server for a run that has not started, and all that followed a run to another server, are gone
  const logic = src("logic/runserver.ts");
  for (const gone of ["runServerChoice", "runOffersLocalOnly", "runDeleteRefused", "movedSel", "movedId", "runUnconfirmedLine", "RUN_START_UNCONFIRMED", "RUN_HAS_CHATS",
    "RUN_DELETE_UNKNOWN", "runStaysText", "runServerBack", "unconfirmed"]) assert.ok(!logic.includes(gone), gone);
});

test("runStartBlock: a server that is not connected comes first; then the folder, what blocks the run, the agent, the goal", () => {
  const up = runWhere(state, on("s_1")), off = runWhere(state, on("s_2"));
  const r = { cwd: "/home/u/work", agent: "pi" as const };
  assert.equal(runStartBlock(off, { cwd: "", agent: "" }, ""), "Mini is not connected");
  assert.equal(runStartBlock(off, r, "the goal"), "Mini is not connected");
  assert.equal(runStartBlock(off, r, "the goal", "No agent is installed on Mini."), "Mini is not connected", "before the agent's reason too");
  assert.equal(runStartBlock(up, r, "the goal"), "");
  assert.equal(runStartBlock(up, r, "  "), startBlock(r, "  "));
  assert.equal(runStartBlock(up, { ...r, cwd: "" }, "g"), startBlock({ cwd: "" }, "g"));
  assert.equal(runStartBlock(up, { ...r, folderMissing: true }, "g"), startBlock({ cwd: "/x", folderMissing: true }, "g"));
  assert.equal(runStartBlock(up, { ...r, agent: "", blocked: "Studio has no agent." }, "g"), "Studio has no agent.");
  assert.equal(runStartBlock(up, { ...r, agent: "" }, ""), "Choose an agent first.");
  assert.equal(runStartBlock(runWhere(state, LOCAL), { cwd: "/w", agent: "claude" }, "g"), "", "a run of this computer is as before");
  assert.equal(runStartBlock(runWhere(state, LOCAL), { cwd: "/w", agent: "claude", blocked: "b" }, "g"), "b");
});

test("runAgentReason: why a section's draft run has no agent that can run it, in that server's name, and before what the view says blocks it", () => {
  const up = runWhere(state, on("s_1")), off = runWhere(state, on("s_2")), here = runWhere(state, LOCAL);
  assert.equal(runAgentReason(up, ["pi"], { agent: "pi" }), "");
  assert.equal(runAgentReason(up, ["pi"], { agent: "claude" }), "Claude Code is not installed on Studio: install it there, or choose another agent.");
  assert.equal(runAgentReason(up, [], { agent: "" }), "No agent is installed on Studio. Install Claude Code, Cursor or pi on that machine.");
  assert.equal(runAgentReason(off, [], { agent: "claude" }), "", "not connected: the line says that");
  assert.equal(runAgentReason(here, [], { agent: "claude" }), "", "a run of this computer: the view's own `blocked` says it");
  const reason = runAgentReason(up, ["pi"], { agent: "claude" });
  assert.equal(runStartBlock(up, { cwd: "/home/u/work", agent: "claude", blocked: "claude is not installed on this server" }, "g", reason), reason);
});

test("the lines of a draft run of a section, and its folder with the server's name", () => {
  assert.equal(runOffLine("Mini"), "Mini is not connected: nothing can be changed or started until it is back.");
  assert.equal(folderOn(runWhere(state, on("s_1")), "~/work"), "~/work on Studio");
  assert.equal(folderOn(runWhere(state, on("s_2")), "~/work"), "~/work on Mini", "connected or not");
  assert.equal(folderOn(runWhere(state, LOCAL), "~/code"), "~/code");
  assert.equal(folderOn(runWhere(state, on("s_1")), ""), "");
});

test("a draft run reads agents, catalog, home and default folder through its server (AC18, AC44)", () => {
  const studio = runWhere(state, on("s_1")), mini = runWhere(state, on("s_2"));
  // connected: that server's agents; the run's agent that it lacks is marked with a reason that names it
  assert.deepEqual(usableAgents(state, studio.server), ["pi"]);
  const ch = agentChoiceOn(studio, usableAgents(state, studio.server), "claude");
  assert.deepEqual([ch.options, ch.missing], [["pi"], true]);
  assert.match(ch.reason, /Studio/);
  assert.equal(agentChoiceOn(studio, usableAgents(state, studio.server), "pi").reason, "");
  // not connected: no agent is offered, the reason says why; the catalog kept still names the model
  assert.deepEqual(usableAgents(state, mini.server), []);
  assert.deepEqual(agentChoiceOn(mini, usableAgents(state, mini.server), "claude"), { options: [], current: "claude", missing: false, reason: notConnectedLine("Mini") });
  assert.equal(catalogFor(state, "s_2", "claude"), state.lists!.s_2.catalogs.claude);
  assert.equal(catalogFor(state, "s_1", "pi"), state.lists!.s_1.catalogs.pi);
  assert.equal(catalogFor(state, "s_1", "claude"), undefined, "never the local catalog of an agent that server lacks");
  // the folder: `~` by that server's home, the browser starts in its default folder, the chip's title names it
  assert.equal(tildeBy(listsOf(state, "s_1")?.home, "/home/u/work/app"), "~/work/app");
  assert.equal(tildeBy(listsOf(state, "s_1")?.home, "/Users/me/code"), "/Users/me/code");
  assert.deepEqual(folderStarts(listsOf(state, "s_1")), ["/home/u/work", "/home/u"]);
  assert.equal(folderTitle(studio, "~/work", { locked: true }), "Folder on Studio: ~/work");
});

const UP: Remote = { remote: true, connected: true }, DOWN: Remote = { remote: true, connected: false }, HERE: Remote = { remote: false, connected: true };

test("the sentences of a section's run name the server", () => {
  assert.equal(runGoneText("Studio"), "This run is no longer on Studio.");
  assert.equal(runUnreachableText("Studio"), "Studio is not connected. This run shows again when it is back.");
  assert.equal(runAwayText("Studio"), "Studio is not connected. This run is shown as it was when the connection ended.");
});

test("runRemoteView: a run of this computer, and a section's whose server is connected, loaded or loading, show the detail", () => {
  assert.deepEqual(runRemoteView(HERE, "This computer", "connected", false, { message: "x" }), { kind: "none" });
  assert.deepEqual(runRemoteView({ remote: false, connected: false, gone: true }, "This computer", undefined, false, { code: NOT_FOUND, message: "x" }), { kind: "none" });
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", false), { kind: "none" });
  assert.deepEqual(runRemoteView(UP, "Studio", "unreachable", false), { kind: "none" }, "the tree decides, not the entry's state");
});

test("runRemoteView: no detail: unreachable with the entry's state, with or without a load error; gone by not_found or the page's mark; or the server's sentence", () => {
  const err = { code: "server_unreachable", message: "Studio is not connected." };
  const away = { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "Unreachable" };
  assert.deepEqual(runRemoteView(DOWN, "Studio", "unreachable", false, err), away);
  assert.deepEqual(runRemoteView(DOWN, "Studio", "unreachable", false), away, "no load is made while the server is not connected");
  assert.equal((runRemoteView(DOWN, "Studio", undefined, false, err) as { state: string }).state, "");
  assert.equal((runRemoteView(DOWN, "Studio", "too_old", false) as { state: string }).state, "Too old: update the server on that machine");
  const gone = { kind: "gone", text: "This run is no longer on Studio." };
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", false, { code: "not_found", message: "run not found" }), gone);
  assert.deepEqual(runRemoteView({ ...DOWN, gone: true }, "Studio", "unreachable", false), gone, "gone goes before not connected");
  assert.deepEqual(runRemoteView({ ...UP, gone: true }, "Studio", "connected", false), gone);
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", false, { code: "no_answer", message: "Studio did not answer." }), { kind: "failed", text: "Studio did not answer." });
  // gone_there is no code any more
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", false, { code: "gone_there", message: "x" }), { kind: "failed", text: "x" });
});

test("runRemoteView: a detail on screen stays, read-only, under a warning", () => {
  assert.deepEqual(runRemoteView(DOWN, "Studio", "unreachable", true), { kind: "bar", text: "Studio is not connected. This run is shown as it was when the connection ended.", gone: false, state: "Unreachable" });
  assert.deepEqual(runRemoteView(DOWN, "Studio", "connecting", true, { message: "x" }), { kind: "bar", text: runAwayText("Studio"), gone: false, state: "Connecting…" });
  assert.deepEqual(runRemoteView({ ...UP, gone: true }, "Studio", "connected", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  assert.deepEqual(runRemoteView({ ...DOWN, gone: true }, "Studio", "unreachable", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", true, { code: "not_found", message: "x" }), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  assert.deepEqual(runRemoteView(UP, "Studio", "connected", true, { message: "boom" }), { kind: "none" });
});

test("runDeleteAsk: a local run's dialog is as before; a section's names its server, says that it is removed for everyone, and names the server beside the folder", () => {
  assert.deepEqual(runDeleteAsk({ started: "t", status: "completed" }, "Tidy", "", "~/code"),
    { title: "Delete Tidy?", body: "The run's tasks, reports, notes, agent transcripts and chats are removed. What its agents changed in ~/code stays. This can't be undone." });
  assert.deepEqual(runDeleteAsk({ started: "t", status: "running" }, "Tidy", "Studio", "~/work"),
    { title: "Delete Tidy?", body: "This run is working: its agents are stopped. The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. What its agents changed in ~/work on Studio stays. This can't be undone." });
  // a run that has not started changed nothing there
  assert.equal(runDeleteAsk({ status: "draft" }, "Tidy", "Studio", "~/work").body, "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. This can't be undone.");
  assert.equal(runDeleteAsk({ status: "draft" }, "Tidy", "", "~/code").body, "The run's tasks, reports, notes, agent transcripts and chats are removed. This can't be undone.");
  // an archived run is not working; a run with no folder names none
  assert.equal(runDeleteAsk({ started: "t", status: "running", archived: true }, "Tidy", "Studio").body, "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio, for everyone who uses that server. This can't be undone.");
  assert.deepEqual(runDeleteAsk({}, "Tidy"), { title: "Delete Tidy?", body: "The run's tasks, reports, notes, agent transcripts and chats are removed. This can't be undone." });
  // the sidebar names the server of a section's run alone, and shortens the folder by that server's home
  assert.ok(src("Sidebar.tsx").includes("const ask = runDeleteAsk(r, r.name, there(r.id), tildify(r.cwd, serverOf(r)));"));
  assert.deepEqual(Object.keys(runDeleteAsk({}, "Tidy", "Studio")).sort(), ["body", "title"], "no action of its own and no `local`: a run is deleted on its server or not at all");
});

test("offersChatOn: not on an archived run; a section's run takes a chat before it starts, as a local one", () => {
  assert.equal(offersChatOn({}), true, "a draft takes a chat");
  assert.equal(offersChatOn({ archived: false }), true);
  assert.equal(offersChatOn({ archived: true }), false);
  // (a run made in a section is on that server from the moment it is made: nothing of it is asked but its archive mark)
  assert.ok(src("logic/runserver.ts").includes('export const offersChatOn = (r: Pick<RunView, "archived">): boolean => !r.archived;'));
});

// r_1 is a run of this computer, of s_1 and of s_2: three runs
const back = {
  runs: { "s_1~r_1": { started: "t" }, "s_1~r_2": { started: "t" }, r_1: { started: "t" }, "s_2~r_1": { started: "t" }, "s_1~r_5": {}, "s_1~r_6": { started: "t" } },
  runDetail: { "s_1~r_1": {}, r_1: {}, "s_2~r_1": {} },
  runErrors: { "s_1~r_6": { message: "x" }, "s_2~r_1": { message: "y" } },
  agents: { "s_1~a_1": { run: "s_1~r_1" }, a_1: { run: "r_1" }, "s_2~a_1": { run: "s_2~r_1" }, "s_1~a_4": { run: "s_1~r_2" } },
  sel: { run: "s_1~r_1" as string | null },
};

test("runSectionBack: the runs of that server with a detail, a load error or a fetch; their kept agents; the run on screen to read again", () => {
  assert.deepEqual(runSectionBack(back, "s_1", ["s_1~r_2", "r_1"]), { runs: ["s_1~r_1", "s_1~r_2", "s_1~r_6"], agents: ["s_1~a_1", "s_1~a_4"], load: "s_1~r_1" });
  assert.deepEqual(runSectionBack(back, "s_1"), { runs: ["s_1~r_1", "s_1~r_6"], agents: ["s_1~a_1", "s_1~a_4"], load: "s_1~r_1" });
  assert.deepEqual(runSectionBack(back, "s_2"), { runs: ["s_2~r_1"], agents: ["s_2~a_1"], load: null });
  assert.deepEqual(runSectionBack(back, "s_9"), { runs: [], agents: [], load: null });
  // the run of this computer with the same id is none of a section's
  assert.deepEqual(runSectionBack(back, "local"), { runs: ["r_1"], agents: ["a_1"], load: null });
  // a run the page no longer has is none of them, whatever is still kept under its key
  assert.deepEqual(runSectionBack({ ...back, runDetail: { ...back.runDetail, "s_1~r_9": {} } }, "s_1").runs, ["s_1~r_1", "s_1~r_6"]);
});

test("runSectionBack: nothing is read for a draft on screen, a run of another server, or none; the agent the panel shows counts before its view came", () => {
  assert.equal(runSectionBack({ ...back, sel: { run: "s_1~r_5" } }, "s_1").load, null);
  assert.equal(runSectionBack({ ...back, sel: { run: "r_1" } }, "s_1").load, null, "the local run with the same id");
  assert.equal(runSectionBack({ ...back, sel: { run: "s_2~r_1" } }, "s_1").load, null);
  assert.equal(runSectionBack({ ...back, sel: { run: null } }, "s_1").load, null);
  assert.equal(runSectionBack({ ...back, sel: { run: "s_1~r_2" } }, "s_1").load, "s_1~r_2", "a run with nothing kept yet is read too");
  assert.deepEqual(runSectionBack({ ...back, runAgent: { run: "s_1~r_2", agent: "s_1~a_9" } }, "s_1").agents, ["s_1~a_1", "s_1~a_4", "s_1~a_9"]);
  assert.deepEqual(runSectionBack({ ...back, runAgent: { run: "s_1~r_1", agent: "s_1~a_1" } }, "s_1").agents, ["s_1~a_1", "s_1~a_4"]);
  assert.deepEqual(runSectionBack({ ...back, runAgent: { run: "r_1", agent: "a_9" } }, "s_1").agents, ["s_1~a_1", "s_1~a_4"]);
});

test("withRunError: set with its code, cleared, and the same map when nothing changes", () => {
  const one = withRunError({}, "s_1~r_1", { code: "not_found", message: "m" });
  assert.deepEqual(one, { "s_1~r_1": { code: "not_found", message: "m" } });
  assert.deepEqual(withRunError(one, "s_1~r_1", null), {});
  assert.equal(withRunError(one, "r_1", null), one, "the local run with the same id has no error");
});

test("Unfollows: a read waits for the unfollow of the same id that is under way, the last one started; another id's does not", async () => {
  const u = new Unfollows();
  assert.equal(u.wait("r_1"), undefined);
  let end1!: () => void, end2!: () => void;
  const order: string[] = [];
  u.start("r_1", () => new Promise<void>((r) => { end1 = r; }));
  await tick();
  assert.equal(u.wait("r_2"), undefined);
  void u.wait("r_1")!.then(() => order.push("first"));
  u.start("r_1", () => new Promise<void>((r) => { end2 = r; })); // dropped again before the first one ended
  await tick();
  const last = u.wait("r_1")!;
  void last.then(() => order.push("last"));
  end1();
  await tick();
  assert.deepEqual(order, ["first"]);
  assert.equal(u.wait("r_1"), last, "the first one's end does not end the wait for the second");
  end2();
  await tick();
  assert.deepEqual(order, ["first", "last"]);
  assert.equal(u.wait("r_1"), undefined);
});

test("Unfollows: an unfollow that fails, or throws, counts as answered", async () => {
  const u = new Unfollows();
  u.start("r_1", () => Promise.reject(new Error("503")));
  u.start("r_2", () => { throw new Error("no stream"); });
  await Promise.all([u.wait("r_1"), u.wait("r_2")]);
  await tick();
  assert.deepEqual([u.wait("r_1"), u.wait("r_2")], [undefined, undefined]);
});
