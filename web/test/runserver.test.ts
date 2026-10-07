// A run by its server (src/logic/runserver.ts): the draft run's server choice and what its
// composer reads through that server, the view and the delete dialog of a run on another server,
// and the rules of `run` with `was`, of `server_back` for runs and of the unfollow of a dropped run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_DELETE_UNKNOWN, RUN_HAS_CHATS, RUN_START_UNCONFIRMED, Unfollows, folderOn, movedId, movedSel, offersChatOn, runDeleteAsk, runDeleteRefused, runOffLine, runOffersLocalOnly,
  runRemoteView, runServerBack, runServerChoice, runStartBlock, runUnconfirmedLine, runWhere, withRunError } from "../src/logic/runserver.ts";
import { RUN_SERVER, listsOf, serverChoice, type ListsState } from "../src/logic/serverlists.ts";
import { agentChoiceOn, folderStarts, folderTitle, notConnectedLine, tildeBy } from "../src/logic/chatserver.ts";
import { catalogFor, usableAgents } from "../src/logic/agentlist.ts";
import { REMOVE_ONLY } from "../src/logic/remoteview.ts";
import { startBlock } from "../src/logic/run.ts";
import { ApiError } from "../src/api.ts";
import type { ServerView } from "../src/logic/servers.ts";
import type { Catalog } from "../src/types.ts";

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
const tick = () => new Promise((r) => setTimeout(r, 0));

test("runWhere: a run with no server is on this computer; another server's has the entry's name and whether it is connected", () => {
  assert.deepEqual(runWhere(state, {}), { server: "local", name: "This computer", connected: true });
  assert.deepEqual(runWhere(state, { server: "s_1" }), { server: "s_1", name: "Studio", connected: true });
  assert.deepEqual(runWhere(state, { server: "s_2" }), { server: "s_2", name: "Mini", connected: false });
  assert.deepEqual(runWhere(state, { server: "s_9" }), { server: "s_9", name: "Unknown server", connected: false });
});

test("runServerChoice: this computer first, every entry by name; one that is not connected has its state, and a too_old one is disabled (AC5)", () => {
  const { options, fixed } = runServerChoice(state.servers!, {}, false);
  assert.equal(fixed, "");
  assert.deepEqual(options.map((o) => [o.id, o.label, !!o.disabled, !!o.reason]), [
    ["local", "This computer", false, false], ["s_1", "Studio", false, false], ["s_2", "Mini", false, true], ["s_3", "Old", true, true]]);
  assert.deepEqual(options, serverChoice(state.servers!, { locked: false }).options, "the options of a chat's choice");
});

test("runServerChoice: fixed with its reason while the start is unconfirmed, and while the draft has chats", () => {
  assert.equal(runServerChoice(state.servers!, { start: "unconfirmed" }, false).fixed, RUN_START_UNCONFIRMED);
  assert.equal(runServerChoice(state.servers!, {}, true).fixed, RUN_HAS_CHATS);
  assert.equal(runServerChoice(state.servers!, { start: "unconfirmed" }, true).fixed, RUN_START_UNCONFIRMED);
  assert.equal(runServerChoice(state.servers!, { start: "unconfirmed" }, true).options.length, 4);
});

test("the server choice of a chat on a run is fixed with its reason, started or not (AC34)", () => {
  assert.equal(serverChoice(state.servers!, { run: "r_1", locked: false }).fixed, RUN_SERVER);
  assert.equal(serverChoice(state.servers!, { run: "r_1", locked: true }).fixed, RUN_SERVER);
  assert.equal(serverChoice(state.servers!, { run: "r_1", locked: false, start: "unconfirmed" }).fixed, RUN_SERVER);
});

test("runStartBlock: a server that is not connected comes first; then the folder, what blocks the run, the agent, the goal", () => {
  const on = runWhere(state, { server: "s_1" }), off = runWhere(state, { server: "s_2" });
  const r = { cwd: "/home/u/work", agent: "pi" as const };
  assert.equal(runStartBlock(off, { cwd: "", agent: "" }, ""), "Mini is not connected");
  assert.equal(runStartBlock(off, r, "the goal"), "Mini is not connected");
  assert.equal(runStartBlock(on, r, "the goal"), "");
  assert.equal(runStartBlock(on, r, "  "), startBlock(r, "  "));
  assert.equal(runStartBlock(on, { ...r, cwd: "" }, "g"), startBlock({ cwd: "" }, "g"));
  assert.equal(runStartBlock(on, { ...r, folderMissing: true }, "g"), startBlock({ cwd: "/x", folderMissing: true }, "g"));
  assert.equal(runStartBlock(on, { ...r, agent: "", blocked: "Studio has no agent." }, "g"), "Studio has no agent.");
  assert.equal(runStartBlock(on, { ...r, agent: "" }, ""), "Choose an agent first.");
  assert.equal(runStartBlock(runWhere(state, {}), { cwd: "/w", agent: "claude" }, "g"), "", "a run of this computer is as before");
  assert.equal(runStartBlock(runWhere(state, {}), { cwd: "/w", agent: "claude", blocked: "b" }, "g"), "b");
});

test("the lines of a draft run on another server, and its folder with the server's name", () => {
  assert.equal(runOffLine("Mini"), "Mini is not connected: its folders and agents are not known.");
  assert.equal(runUnconfirmedLine("Mini"), "Mini did not answer: it is not known whether the run started. Start again: it starts only once.");
  assert.equal(folderOn(runWhere(state, { server: "s_1" }), "~/work"), "~/work on Studio");
  assert.equal(folderOn(runWhere(state, {}), "~/code"), "~/code");
  assert.equal(folderOn(runWhere(state, { server: "s_1" }), ""), "");
});

test("a draft run reads agents, catalog, home and default folder through its server (AC18, AC44)", () => {
  const studio = runWhere(state, { server: "s_1" }), mini = runWhere(state, { server: "s_2" });
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

test("runRemoteView: a run of this computer, and a remote one that is connected or loading, show the detail", () => {
  assert.deepEqual(runRemoteView({}, "This computer", "connected", false, { message: "x" }), { kind: "none" });
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "connected", true), { kind: "none" });
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "unreachable", false), { kind: "none" });
});

test("runRemoteView: no detail and a failed load: unreachable with the entry's state, gone, or the server's sentence", () => {
  const err = { code: "server_unreachable", message: "Studio is not connected." };
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "unreachable", false, err),
    { kind: "unreachable", text: "Studio is not connected. This run shows again when it is back.", state: "Unreachable" });
  assert.equal((runRemoteView({ server: "s_1" }, "Studio", undefined, false, err) as { state: string }).state, "");
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "connected", false, { code: "gone_there", message: "x" }), { kind: "gone", text: "This run is no longer on Studio." });
  assert.deepEqual(runRemoteView({ server: "s_1", gone: true }, "Studio", "unreachable", false), { kind: "gone", text: "This run is no longer on Studio." });
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "connected", false, { code: "no_answer", message: "Studio did not answer." }), { kind: "failed", text: "Studio did not answer." });
});

test("runRemoteView: a detail on screen stays, with a bar", () => {
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "unreachable", true), { kind: "bar", text: "Studio is not connected.", gone: false });
  assert.deepEqual(runRemoteView({ server: "s_1", gone: true }, "Studio", "connected", true), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
  assert.deepEqual(runRemoteView({ server: "s_1" }, "Studio", "connected", true, { code: "gone_there", message: "x" }), { kind: "bar", text: "This run is no longer on Studio.", gone: true });
});

test("runDeleteAsk: a local run's dialog is as before; a remote one names its server beside the folder; a gone one offers this sidebar only", () => {
  assert.deepEqual(runDeleteAsk({ started: "t", status: "completed" }, "Tidy", "This computer", "~/code"),
    { title: "Delete Tidy?", body: "The run's tasks, reports, notes, agent transcripts and chats are removed. What its agents changed in ~/code stays. This can't be undone.", action: "Delete", local: false });
  assert.deepEqual(runDeleteAsk({ server: "s_1", started: "t", status: "running" }, "Tidy", "Studio", "~/work"),
    { title: "Delete Tidy?", body: "This run is working: its agents are stopped. The run's tasks, reports, notes, agent transcripts and chats are removed on Studio. What its agents changed in ~/work on Studio stays. This can't be undone.", action: "Delete", local: false });
  assert.equal(runDeleteAsk({ server: "s_1", status: "draft" }, "Tidy", "Studio", "~/work").body, "The run's tasks, reports, notes, agent transcripts and chats are removed on Studio. This can't be undone.");
  assert.equal(runDeleteAsk({ server: "s_1", started: "t", status: "running", archived: true }, "Tidy", "Studio").body.startsWith("The run's"), true);
  assert.deepEqual(runDeleteAsk({ server: "s_1", gone: true, started: "t", status: "running" }, "Tidy", "Studio", "~/work"),
    { title: "Remove Tidy from this sidebar?", body: "This run is no longer on Studio.", action: REMOVE_ONLY, local: true });
});

test("runDeleteRefused: after a 503 the offer of this sidebar only; nothing after another refusal, for a local run or a gone one", () => {
  const r = { server: "s_1" };
  assert.deepEqual(runDeleteRefused(r, "Tidy", "Studio", new ApiError(503, "Studio is not connected.", true, "server_unreachable"), false),
    { title: "Remove Tidy from this sidebar?", body: "Studio is not connected. The run was not deleted. Removing it from this sidebar leaves the run on Studio.", action: REMOVE_ONLY, local: true });
  // connected again by the time the refusal is read: the local server would refuse ?local=1 (409 server_connected), so the first dialog stays with the sentence
  assert.equal(runDeleteRefused(r, "Tidy", "Studio", new ApiError(503, "Studio is not connected.", true, "server_unreachable"), true), null);
  assert.equal(runDeleteRefused(r, "Tidy", "Studio", new ApiError(409, "Studio is connected: delete the run there.", true, "server_connected"), true), null);
  assert.equal(runDeleteRefused(r, "Tidy", "Studio", new ApiError(409, "The run is being started.", true, "busy"), true), null);
  assert.equal(runDeleteRefused({}, "Tidy", "This computer", new ApiError(503, "x"), false), null);
  assert.equal(runDeleteRefused({ server: "s_1", gone: true }, "Tidy", "Studio", new ApiError(503, "x"), false), null);
  assert.deepEqual([runOffersLocalOnly(r), runOffersLocalOnly({ server: "s_1", gone: true }), runOffersLocalOnly({ gone: true })], [false, true, false]);
});

test("runDeleteRefused: a delete that got no answer (504) may have happened: it is not known, and this sidebar only is offered only while the server is not connected", () => {
  const r = { server: "s_1" }, none = new ApiError(504, "Studio did not answer.", true, "no_answer");
  assert.equal(RUN_DELETE_UNKNOWN, "It is not known whether the run was deleted.");
  // connected: no offer (the local server refuses to remove the record alone); the same Delete can be made again
  assert.deepEqual(runDeleteRefused(r, "Tidy", "Studio", none, true),
    { title: "Delete Tidy?", body: "Studio did not answer. It is not known whether the run was deleted.", action: "Delete", local: false });
  assert.equal(runOffersLocalOnly(r, none, true), false);
  // not connected: the offer, with the same sentence
  assert.deepEqual(runDeleteRefused(r, "Tidy", "Studio", none, false),
    { title: "Remove Tidy from this sidebar?", body: "Studio did not answer. It is not known whether the run was deleted. Removing it from this sidebar leaves the run on Studio.", action: REMOVE_ONLY, local: true });
  assert.equal(runOffersLocalOnly(r, none, false), true);
  for (const connected of [true, false]) assert.doesNotMatch(runDeleteRefused(r, "Tidy", "Studio", none, connected)!.body, /was not deleted/);
  // by the status alone, and never for a run of this computer
  assert.equal(runDeleteRefused(r, "Tidy", "Studio", new ApiError(504, "Gateway Timeout", false), true)?.local, false);
  assert.equal(runDeleteRefused({}, "Tidy", "This computer", none, true), null);
});

test("movedId: the id a draft has now, through every new id it got", () => {
  const moves = new Map([["r_a", "r_b"], ["r_b", "r_c"], ["r_x", "r_y"]]);
  assert.deepEqual(["r_a", "r_b", "r_c", "r_x", "r_q"].map((id) => movedId(moves, id)), ["r_c", "r_c", "r_c", "r_y", "r_q"]);
  assert.ok(movedId(new Map([["r_a", "r_b"], ["r_b", "r_a"]]), "r_a"), "a ring ends");
});

test("offersChatOn: not on an archived run, and not on a draft of another server", () => {
  assert.equal(offersChatOn({}), true, "a local draft takes a chat, as before");
  assert.equal(offersChatOn({ started: "t" }), true);
  assert.equal(offersChatOn({ server: "s_1" }), false);
  assert.equal(offersChatOn({ server: "s_1", started: "t" }), true);
  assert.equal(offersChatOn({ server: "s_1", started: "t", archived: true }), false);
  assert.equal(offersChatOn({ archived: true }), false);
});

test("movedSel: the selection follows a draft to its new id, with the rest kept; another selection is the same object", () => {
  const sel = { board: null, run: "r_old", chat: null };
  assert.deepEqual(movedSel(sel, "r_old", "r_new"), { board: null, run: "r_new", chat: null });
  const other = { board: null, run: "r_x", chat: "c_1" };
  assert.equal(movedSel(other, "r_old", "r_new"), other);
  assert.equal(movedSel(sel, "", "r_new"), sel);
  const none = { board: "b_1", run: null, chat: null };
  assert.equal(movedSel(none, "r_old", "r_new"), none);
});

const back = {
  runs: { r_1: { server: "s_1", started: "t" }, r_2: { server: "s_1", started: "t" }, r_3: { started: "t" }, r_4: { server: "s_2", started: "t" }, r_5: { server: "s_1" }, r_6: { server: "s_1", started: "t" } },
  runDetail: { r_1: {}, r_3: {}, r_4: {} },
  runErrors: { r_6: { message: "x" }, r_4: { message: "y" } },
  agents: { a_1: { run: "r_1" }, a_2: { run: "r_3" }, a_3: { run: "r_4" }, a_4: { run: "r_2" } },
  sel: { run: "r_1" as string | null },
};

test("runServerBack: the runs of that server with a detail, a load error or a fetch; their kept agents; the run on screen to read again", () => {
  assert.deepEqual(runServerBack(back, "s_1", ["r_2", "r_3"]), { runs: ["r_1", "r_2", "r_6"], agents: ["a_1", "a_4"], load: "r_1" });
  assert.deepEqual(runServerBack(back, "s_1"), { runs: ["r_1", "r_6"], agents: ["a_1", "a_4"], load: "r_1" });
  assert.deepEqual(runServerBack(back, "s_2"), { runs: ["r_4"], agents: ["a_3"], load: null });
  assert.deepEqual(runServerBack(back, "s_9"), { runs: [], agents: [], load: null });
});

test("runServerBack: nothing is read for a draft on screen, a run of another server, or none; the agent the panel shows counts before its view came", () => {
  assert.equal(runServerBack({ ...back, sel: { run: "r_5" } }, "s_1").load, null);
  assert.equal(runServerBack({ ...back, sel: { run: "r_3" } }, "s_1").load, null);
  assert.equal(runServerBack({ ...back, sel: { run: null } }, "s_1").load, null);
  assert.equal(runServerBack({ ...back, sel: { run: "r_2" } }, "s_1").load, "r_2", "a run with nothing kept yet is read too");
  assert.deepEqual(runServerBack({ ...back, runAgent: { run: "r_2", agent: "a_9" } }, "s_1").agents, ["a_1", "a_4", "a_9"]);
  assert.deepEqual(runServerBack({ ...back, runAgent: { run: "r_1", agent: "a_1" } }, "s_1").agents, ["a_1", "a_4"]);
  assert.deepEqual(runServerBack({ ...back, runAgent: { run: "r_3", agent: "a_9" } }, "s_1").agents, ["a_1", "a_4"]);
});

test("withRunError: set with its code, cleared, and the same map when nothing changes", () => {
  const one = withRunError({}, "r_1", { code: "gone_there", message: "m" });
  assert.deepEqual(one, { r_1: { code: "gone_there", message: "m" } });
  assert.deepEqual(withRunError(one, "r_1", null), {});
  assert.equal(withRunError(one, "r_2", null), one);
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
