// What a chat's composer says and offers by the chat's server (src/logic/chatserver.ts): the texts
// that name the server, the line under the toolbar, the Send that is off, `~` by that server's
// home, the folder titles, the recent folders and the plan usage's key; and the components read
// as source for what they pass on (the unit tests have no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./fixtures/bundle.ts";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, agentLine, noAgentReason, usableAgents } from "../src/logic/agentlist.ts";
import { goneText } from "../src/logic/remoteview.ts";
import { emptyReason, offWhy, sendingLine, showsServer } from "../src/logic/chatserver.ts";
import { agentChoiceOn, folderHead, folderStarts, folderTitle, noAgentOn, noAgentReasonOn, notConnectedLine, offPlaceholder, recentFrom, sendOff,
  sendTitleOn, tildeBy, toolbarLine, usageKey, usageTitleOn, withRecent, type Where } from "../src/logic/chatserver.ts";
import { RECENT_KEY, listsOf, serverConnected, serverName, serverOf } from "../src/logic/serverlists.ts";
import { keyOn } from "../src/logic/keys.ts";
import type { ServerState } from "../src/logic/servers.ts";
import { LOCAL_SERVER, type AgentKind, type ChatView, type ServerLists } from "../src/types.ts";

const src = sourceOf;

const HERE: Where = { server: LOCAL_SERVER, name: "This computer", connected: true };
const THERE: Where = { server: "s_1", name: "Studio", connected: true };
const DOWN: Where = { ...THERE, connected: false };
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", status: "ready", locked: false, ...o }) as ChatView;
/** A chat of the section s_1: its key names the server, and its own id there is the one a local chat has too. */
const FAR = keyOn("s_1", "c_1");
const far = (o: Partial<ChatView> = {}) => chat({ id: FAR, ...o });
const LISTS: ServerLists = { agents: ["pi"], catalogs: {}, home: "/home/u", defaultCwd: "/home/u/work" };
/** tree: the local server holds that server's tree (a `section` event with a tree came). */
const store = (state: ServerState, tree = state === "connected") => ({
  usable: ["claude"] as AgentKind[], catalogs: {}, home: "/Users/me", defaultCwd: "/Users/me/code",
  lists: { s_1: LISTS }, servers: [{ id: "s_1", name: "Studio", state }], sections: tree ? { s_1: {} } : {},
});

test("every message names its branch, the first one of a section's chat too", () => {
  assert.ok(src("state/actions.ts").includes("try { await post(branch); }"));
  assert.ok(src("api.ts").includes('thing("chats", id, "POST", `/messages${target ? "" : onBranch(branch)}`, {'));
  for (const [name, text] of [["state/actions.ts", src("state/actions.ts")], ["api.ts", src("api.ts")], ["logic/chatserver.ts", src("logic/chatserver.ts")]] as const) assert.ok(!text.includes("firstThere"), name);
});

test("the composer's Where is the chat's server, its name and whether it is connected", () => {
  const s = store("unreachable");
  const c = { id: FAR };
  assert.equal(FAR, "s_1~c_1");
  assert.deepEqual({ server: serverOf(c), name: serverName(s, serverOf(c)), connected: serverConnected(s, serverOf(c)) }, DOWN);
  assert.deepEqual({ server: serverOf({ id: "c_1" }), name: serverName(s, serverOf({ id: "c_1" })), connected: serverConnected(s, serverOf({ id: "c_1" })) }, HERE, "the same id on this computer");
  assert.deepEqual({ server: serverOf({}), name: serverName(s, serverOf({})), connected: serverConnected(s, serverOf({})) }, HERE);
  const up = store("connected");
  assert.deepEqual({ server: serverOf(c), name: serverName(up, serverOf(c)), connected: serverConnected(up, serverOf(c)) }, THERE);
  // connected is "the page holds that server's tree", whatever the entry's state says meanwhile
  assert.equal(serverConnected(store("connected", false), "s_1"), false, "connected, and its tree has not come yet");
  assert.equal(serverConnected(store("unreachable", true), "s_1"), true, "the state's event came before the tree went");
  // the toolbar names the server of a section's chat alone
  assert.deepEqual([showsServer(HERE), showsServer(THERE), showsServer(DOWN)], [false, true, true]);
  // the agents are the chat's server's: none while it is not connected
  assert.deepEqual(usableAgents(s, "s_1"), []);
  assert.deepEqual(usableAgents(store("connected"), "s_1"), ["pi"]);
  assert.deepEqual(usableAgents(store("connected", false), "s_1"), [], "nor before its tree came");
});

test("on this computer the texts are the ones from before", () => {
  for (const usable of [[], ["claude"], ["claude", "pi"]] as AgentKind[][]) {
    for (const agent of ["", "claude", "cursor"] as (AgentKind | "")[]) {
      assert.deepEqual(agentChoiceOn(HERE, usable, agent), agentChoice(usable, agent));
      assert.equal(toolbarLine(HERE, usable, { agent }).text, agentLine(usable, agent));
    }
    assert.equal(noAgentReasonOn(HERE, usable), noAgentReason(usable));
  }
  assert.equal(noAgentOn(HERE), NO_AGENT);
  assert.deepEqual(toolbarLine(HERE, ["claude"], { agent: "claude" }), { text: "", tone: "" });
  assert.deepEqual(toolbarLine(HERE, ["claude"], { agent: "" }), { text: CHOOSE_AGENT, tone: "" });
  assert.deepEqual(toolbarLine(HERE, [], { agent: "" }), { text: NO_AGENT, tone: "missing" });
  assert.equal(toolbarLine(HERE, ["claude"], { agent: "cursor" }).tone, "missing");
});

test("on another server the not installed and no agent texts name the server", () => {
  assert.match(noAgentOn(THERE), /^No agent is installed on Studio\./);
  assert.equal(agentChoiceOn(THERE, [], "").reason, noAgentOn(THERE));
  assert.equal(noAgentReasonOn(THERE, []), noAgentOn(THERE));
  assert.equal(noAgentReasonOn(THERE, ["pi"]), CHOOSE_AGENT);
  const c = agentChoiceOn(THERE, ["pi"], "cursor");
  assert.deepEqual([c.options, c.missing], [["pi"], true]);
  assert.equal(c.reason, "Cursor is not installed on Studio: install it there, or choose another agent.");
  assert.deepEqual(toolbarLine(THERE, ["pi"], { agent: "cursor" }), { text: c.reason, tone: "missing" });
  assert.deepEqual(toolbarLine(THERE, ["pi"], { agent: "pi" }), { text: "", tone: "" });
  assert.ok(!/this computer/i.test(noAgentOn(THERE) + c.reason));
});

test("a server that is not connected: no agent is offered, the line says why, and Send is off with that title", () => {
  const line = "Studio is not connected: nothing can be sent or changed until it is back.";
  assert.equal(notConnectedLine("Studio"), line);
  // also with an agent the chat has from before, and with a list kept from before
  for (const agent of ["", "pi"] as (AgentKind | "")[]) {
    assert.deepEqual(agentChoiceOn(DOWN, [], agent), { options: [], current: agent, missing: false, reason: line });
    assert.deepEqual(toolbarLine(DOWN, [], { agent }), { text: line, tone: "missing" });
  }
  assert.equal(noAgentReasonOn(DOWN, []), line);
  const c = far({ agent: "pi" });
  assert.equal(sendOff(DOWN), true);
  assert.equal(sendTitleOn(DOWN, [], c, false), line);
  assert.equal(sendTitleOn(DOWN, [], far({ agent: "" }), true), line);
  assert.equal(offPlaceholder(DOWN, [], c), "Studio is not connected");
  assert.equal(offPlaceholder(DOWN, [], far({ agent: "" })), "Studio is not connected", "before the agent's own placeholder");
  // connected: as any chat
  assert.equal(sendOff(THERE), false);
  assert.equal(sendTitleOn(THERE, ["pi"], c, false), "Send");
  assert.equal(sendTitleOn(THERE, [], chat({ agent: "" }), true), noAgentOn(THERE));
  assert.equal(sendTitleOn(THERE, ["pi"], chat({ status: "thinking" }), true), "The agent is working");
  assert.equal(offPlaceholder(THERE, ["pi"], c), "");
  assert.equal(offPlaceholder(THERE, ["pi"], chat({ agent: "" })), "Choose an agent…");
  assert.equal(sendOff(HERE), false);
  assert.equal(sendOff({ ...HERE, connected: false }), true, "by the Where alone");
});

test("a started chat's Send is off too while its server is not connected: the view is read-only as it was", () => {
  for (const started of [{ locked: true }, { forkedFrom: "c_0" }, { branch: "b_1" }, { branches: 2 }, { status: "thinking" }] as Partial<ChatView>[]) {
    const c = far({ agent: "pi", ...started });
    assert.equal(sendTitleOn(DOWN, [], c, false), notConnectedLine("Studio"));
    assert.equal(sendTitleOn(DOWN, [], c, true), notConnectedLine("Studio"), "before what else blocks it");
    assert.equal(offPlaceholder(DOWN, [], c), "Studio is not connected");
    assert.deepEqual(toolbarLine(DOWN, [], c), { text: notConnectedLine("Studio"), tone: "missing" });
    assert.equal(emptyReason(DOWN, [], c), notConnectedLine("Studio"));
  }
  // (sendOff reads nothing of the chat: whether it has started is no question any more)
  assert.equal(sendOff.length, 1);
  assert.ok(src("logic/chatserver.ts").includes("export const sendOff = (w: Where): boolean => !w.connected;"));
});

test("a chat of a section before its first message is a chat like any other: no line of its own, its agent open, its Send by the connection", () => {
  {
    const c = far({ agent: "pi" });
    assert.deepEqual(toolbarLine(THERE, ["pi"], c), { text: "", tone: "" });
    assert.deepEqual(toolbarLine(DOWN, [], c), { text: notConnectedLine("Studio"), tone: "missing" });
    assert.equal(sendTitleOn(THERE, ["pi"], c, false), "Send");
    assert.equal(offPlaceholder(THERE, ["pi"], c), "");
    assert.deepEqual(agentChoiceOn(THERE, ["pi", "claude"], c.agent).options, ["pi", "claude"]); // its agent can be changed until it starts
  }
});

test("a path is shortened with the home of the chat's server", () => {
  assert.equal(tildeBy("/home/u", "/home/u/work/app"), "~/work/app");
  assert.equal(tildeBy("/home/u", "/home/u"), "~");
  assert.equal(tildeBy("/home/u", "/home/user2/x"), "/home/user2/x");
  assert.equal(tildeBy("/home/u", "/Users/me/code"), "/Users/me/code"); // this computer's home is not that server's
  assert.equal(tildeBy(undefined, "/home/u/x"), "/home/u/x");
  assert.equal(tildeBy("", "/home/u/x"), "/home/u/x");
  assert.equal(tildeBy("/home/u"), "");
  const s = store("unreachable");
  assert.equal(tildeBy(listsOf(s, "s_1")?.home, "/home/u/work"), "~/work"); // also while it is not connected
  assert.equal(tildeBy(listsOf(s, LOCAL_SERVER)?.home, "/Users/me/code"), "~/code");
  assert.equal(tildeBy(listsOf(s, "s_9")?.home, "/home/u/work"), "/home/u/work");
});

test("the folder picker reads the chat's server, is titled by it and starts at its default folder", () => {
  assert.equal(folderHead(THERE), "Folder on Studio");
  assert.equal(folderHead(HERE), "Start the agent in");
  assert.equal(folderTitle(THERE, "/home/u/work", { hint: "h" }), "Folder on Studio: /home/u/work — h");
  assert.equal(folderTitle(THERE, "/home/u/work", { locked: true }), "Folder on Studio: /home/u/work");
  assert.equal(folderTitle(THERE, "/home/u/work", { missing: true }), "Folder not found on Studio: /home/u/work");
  // this computer's titles are the ones the scripts select by
  assert.equal(folderTitle(HERE, "/x", { hint: "h" }), "Working directory: /x — h");
  assert.equal(folderTitle(HERE, "/x", { locked: true }), "Working directory: /x");
  assert.equal(folderTitle(HERE, "/x", { missing: true, hint: "h" }), "Folder not found: /x");
  assert.deepEqual(folderStarts(LISTS), ["/home/u/work", "/home/u"]);
  assert.deepEqual(folderStarts({ home: "/home/u", defaultCwd: "" }), ["/home/u", "/home/u"]);
  assert.deepEqual(folderStarts(undefined), ["", ""]);
});

test("recent folders are kept per server: this computer's in the browser, a section's in the page's memory alone", () => {
  assert.deepEqual(recentFrom(null), []);
  assert.deepEqual(recentFrom("not json"), []);
  assert.deepEqual(recentFrom('{"a":1}'), []);
  assert.deepEqual(recentFrom('["/a","/b",3]'), ["/a", "/b"]);
  assert.deepEqual(withRecent(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(withRecent(["1", "2", "3", "4", "5", "6"], "7"), ["7", "1", "2", "3", "4", "5"]);
  assert.equal(RECENT_KEY, "aiwb.dirs");
});

test("plan usage asks the chat's server, is kept by server and agent, and is titled by the server", () => {
  assert.equal(usageKey("s_1", "claude"), "s_1:claude");
  assert.equal(usageKey(LOCAL_SERVER, "claude"), "local:claude");
  assert.notEqual(usageKey("s_1", "claude"), usageKey("s_2", "claude"));
  assert.equal(usageTitleOn(THERE, "Plan usage limits"), "Plan usage on Studio");
  assert.equal(usageTitleOn(THERE, "Cursor usage"), "Plan usage on Studio");
  assert.equal(usageTitleOn(HERE, "Cursor usage"), "Cursor usage"); // pi has none, there as here
});

// ---- the findings of the review T87

test("emptyReason: what an empty thread says of a chat that takes no message, by its server (F1, F12)", () => {
  // this computer: the sentences from before
  assert.equal(emptyReason(HERE, ["claude"], chat()), "");
  assert.equal(emptyReason(HERE, ["claude"], chat({ agent: "" })), CHOOSE_AGENT);
  assert.equal(emptyReason(HERE, [], chat({ agent: "" })), NO_AGENT);
  // another server, connected: it is named
  assert.equal(emptyReason(THERE, ["pi"], far({ agent: "pi" })), "");
  assert.equal(emptyReason(THERE, ["pi"], far({ agent: "" })), CHOOSE_AGENT);
  assert.equal(emptyReason(THERE, [], far({ agent: "" })), "No agent is installed on Studio. Install Claude Code, Cursor or pi on that machine.");
  // not connected: nothing can be sent, whether the chat has an agent or not, and whether it has started or not
  assert.equal(emptyReason(DOWN, [], far({ agent: "" })), notConnectedLine("Studio"));
  assert.equal(emptyReason(DOWN, [], far({ agent: "claude" })), notConnectedLine("Studio"));
  assert.equal(emptyReason(DOWN, [], far({ locked: true })), notConnectedLine("Studio"));
  // no longer on its server: nothing can be sent either, connected or not, and that is what is said
  assert.equal(emptyReason(THERE, ["pi"], far({ agent: "pi" }), true), goneText("Studio"));
  assert.equal(emptyReason(DOWN, [], far({ agent: "" }), true), goneText("Studio"));
  assert.equal(emptyReason(HERE, ["claude"], chat(), false), "");
});

test("sendingLine: the line of a fork's or a branch's first message on its way to another server", () => {
  assert.equal(sendingLine("Studio"), "Sending to Studio…");
});

test("offWhy: why a chat takes no call, which every control of its view that is off says", () => {
  assert.equal(offWhy(HERE), "", "a chat of this computer always takes one");
  assert.equal(offWhy(THERE), "");
  assert.equal(offWhy(DOWN), notConnectedLine("Studio"));
  assert.equal(offWhy(THERE, true), goneText("Studio"));
  assert.equal(offWhy(DOWN, true), goneText("Studio"), "gone comes first: the server coming back mends nothing for it");
  // and the actions themselves do nothing for such a chat, whatever reaches them
  const acts = src("state/actions.ts");
  assert.ok(acts.includes("const takesCalls = (chat: string): boolean => reachable(getState(), chat);"));
  assert.equal(acts.split("takesCalls(chat)").length - 1, 5, "label, fork, another branch, a move, Back");
});

test("a chat its server no longer has takes no Send and no change, and the Send, the box and the toolbar's line say so", () => {
  const c = far({ agent: "pi", locked: true });
  assert.equal(goneText("Studio"), "This chat is no longer on Studio.");
  assert.equal(sendTitleOn(THERE, ["pi"], c, false, true), "This chat is no longer on Studio.");
  assert.equal(sendTitleOn(THERE, ["pi"], c, true, true), goneText("Studio"), "before what else blocks it");
  assert.equal(sendTitleOn(DOWN, [], c, false, true), goneText("Studio"), "and before the server that is not connected");
  assert.equal(sendTitleOn(THERE, ["pi"], c, false, false), "Send");
  assert.equal(sendTitleOn(THERE, ["pi"], c, false), "Send");
  assert.equal(offPlaceholder(THERE, ["pi"], c, true), goneText("Studio"));
  assert.equal(offPlaceholder(DOWN, [], c, true), goneText("Studio"));
  assert.equal(offPlaceholder(THERE, ["pi"], far({ agent: "" }), true), goneText("Studio"));
  assert.equal(offPlaceholder(THERE, ["pi"], c, false), "");
  assert.deepEqual(toolbarLine(THERE, ["pi"], c, true), { text: goneText("Studio"), tone: "missing" });
  assert.deepEqual(toolbarLine(DOWN, [], c, true), { text: goneText("Studio"), tone: "missing" });
  assert.deepEqual(toolbarLine(THERE, ["pi"], c, false), { text: "", tone: "" });
});
