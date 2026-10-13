// The agents a server can run and what an agent choice shows (src/logic/agentlist.ts): a chat's
// and the empty state's list name usable agents only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_AGENT, agentChoice, agentOpen, catalogFor, homeAgentsText, usableAgents } from "../src/logic/agentlist.ts";
import { LOCAL_ENTRY, type ServerState } from "../src/logic/servers.ts";
import { AGENT_ORDER, LOCAL_SERVER, type AgentKind, type Catalog, type ChatView } from "../src/types.ts";

const chat = (o: Partial<ChatView> = {}) => ({ agent: "claude", locked: false, ...o }) as ChatView;

test("usableAgents: the local server's list, as the store holds it", () => {
  assert.equal(LOCAL_SERVER, "local");
  const s = { usable: ["claude", "pi"] as AgentKind[] };
  assert.deepEqual(usableAgents(s), ["claude", "pi"]);
  assert.deepEqual(usableAgents(s, LOCAL_SERVER), ["claude", "pi"]);
  assert.deepEqual(usableAgents({ usable: [] }), []);
  assert.equal(usableAgents(s), s.usable, "the store's own list: a selector gets the same one");
});

test("usableAgents: another server's list by its entry id, only while it is connected: the local server holds its tree", () => {
  const lists = { s_1: { agents: ["pi"] as AgentKind[], catalogs: {}, home: "/home/u", defaultCwd: "/home/u" } };
  // tree: a `section` event with that server's tree came, and none with null since
  const at = (state: ServerState, tree = state === "connected") =>
    ({ usable: ["claude"] as AgentKind[], lists, servers: [LOCAL_ENTRY, { id: "s_1", name: "Studio", state }], sections: tree ? { s_1: {} } : {} });
  assert.deepEqual(usableAgents(at("connected"), "s_1"), ["pi"]);
  assert.deepEqual(usableAgents(at("connected")), ["claude"]);
  for (const state of ["unreachable", "connecting", "too_old"] as ServerState[]) assert.deepEqual(usableAgents(at(state), "s_1"), [], state);
  // the tree decides, not the entry's state: the two come in events of their own, in no fixed order
  assert.deepEqual(usableAgents(at("connected", false), "s_1"), [], "connected, and its tree has not come yet");
  assert.deepEqual(usableAgents(at("unreachable", true), "s_1"), ["pi"], "the state's event came before the tree went");
  assert.deepEqual(usableAgents(at("connected"), "s_2"), []); // no such entry
  assert.deepEqual(usableAgents({ ...at("connected"), lists: {} }, "s_1"), []); // connected, its lists not here yet
  assert.equal(usableAgents(at("unreachable"), "s_1"), usableAgents(at("unreachable"), "s_2"), "one empty list: a selector gets the same one");
  // the catalog stays while the server is away: a chat on it still shows its model by name
  const cat = { models: [], default: { model: "m" } } as Catalog;
  const kept = { ...at("unreachable"), lists: { s_1: { ...lists.s_1, catalogs: { pi: cat } } } };
  assert.equal(catalogFor(kept, "s_1", "pi"), cat);
  assert.deepEqual(usableAgents(kept, "s_1"), []);
});

test("agentChoice: a chat is offered the usable agents alone", () => {
  const usable: AgentKind[] = ["claude", "pi"];
  assert.deepEqual(agentChoice(usable, chat().agent), { options: ["claude", "pi"], current: "claude", missing: false, reason: "" });
  assert.ok(!agentChoice(usable, "claude").options.includes("cursor"));
});

test("agentChoice: a stored agent the server lacks is marked, is not among the options, and the reason names it", () => {
  const c = agentChoice(["claude", "pi"], chat({ agent: "cursor" }).agent);
  assert.equal(c.missing, true);
  assert.equal(c.current, "cursor");
  assert.deepEqual(c.options, ["claude", "pi"]);
  assert.match(c.reason, /^Cursor is not installed/);
  assert.notEqual(c.reason, NO_AGENT);
});

test("agentChoice: with none usable there is no option and the reason is NO_AGENT", () => {
  assert.deepEqual(agentChoice([], ""), { options: [], current: "", missing: false, reason: NO_AGENT });
  assert.deepEqual(agentChoice([], "pi"), { options: [], current: "pi", missing: true, reason: NO_AGENT });
});

test("agentChoice: no agent yet on a server that has some is a choice to make, with nothing to explain", () => {
  assert.deepEqual(agentChoice(["cursor"], ""), { options: ["cursor"], current: "", missing: false, reason: "" });
});

test("homeAgentsText names no agent that is not usable", () => {
  const names: Record<AgentKind, string> = { claude: "Claude Code", cursor: "Cursor", pi: "pi" };
  assert.equal(homeAgentsText(AGENT_ORDER), "Chats are Claude Code, Cursor or pi sessions, the same as in a terminal.");
  assert.equal(homeAgentsText(["claude", "pi"]), "Chats are Claude Code or pi sessions, the same as in a terminal.");
  assert.equal(homeAgentsText(["cursor"]), "Chats are Cursor sessions, the same as in a terminal.");
  const sets: AgentKind[][] = [["claude"], ["cursor"], ["pi"], ["claude", "cursor"], ["claude", "pi"], ["cursor", "pi"]];
  for (const usable of sets) {
    const text = homeAgentsText(usable);
    for (const a of AGENT_ORDER) assert.equal(new RegExp(`\\b${names[a]}\\b`).test(text), usable.includes(a), `${a} in "${text}"`);
  }
  assert.equal(homeAgentsText([]), NO_AGENT); // none: the reason, with what to install
});

test("catalogFor: the agent's catalog, and none for an item with no agent", () => {
  const cat: Catalog = { models: [], default: { model: "m" } };
  const s = { usable: [] as AgentKind[], catalogs: { claude: cat } };
  assert.equal(catalogFor(s, LOCAL_SERVER, "claude"), cat);
  assert.equal(catalogFor(s, LOCAL_SERVER, "pi"), undefined);
  assert.equal(catalogFor(s, LOCAL_SERVER, ""), undefined);
});

test("catalogFor: by server, and another server's also while it is not connected", () => {
  const here: Catalog = { models: [], default: { model: "here" } }, there: Catalog = { models: [], default: { model: "there" } };
  const lists = { s_1: { agents: ["claude"] as AgentKind[], catalogs: { claude: there, pi: null }, home: "", defaultCwd: "" } };
  const at = (state: ServerState) => ({ usable: ["claude"] as AgentKind[], catalogs: { claude: here }, lists, servers: [LOCAL_ENTRY, { id: "s_1", name: "Studio", state }] });
  assert.equal(catalogFor(at("connected"), "s_1", "claude"), there);
  assert.equal(catalogFor(at("unreachable"), "s_1", "claude"), there, "a chat on a server that is away still names its model");
  assert.equal(catalogFor(at("connected"), LOCAL_SERVER, "claude"), here);
  assert.equal(catalogFor(at("connected"), "s_1", "pi"), undefined); // null: that server has none of it
  assert.equal(catalogFor(at("connected"), "s_1", "cursor"), undefined);
  assert.equal(catalogFor(at("connected"), "s_2", "claude"), undefined); // not the local one's for a server with no lists
  assert.equal(catalogFor(at("connected"), "s_1", ""), undefined);
});

test("agentOpen: only an unstarted chat that is neither a fork nor a branch", () => {
  assert.equal(agentOpen(chat()), true);
  assert.equal(agentOpen(chat({ agent: "" })), true);
  assert.equal(agentOpen(chat({ branches: 1 })), true);
  assert.equal(agentOpen(chat({ locked: true })), false); // started
  assert.equal(agentOpen(chat({ forkedFrom: "c_0", fresh: true })), false); // a fork at its start
  assert.equal(agentOpen(chat({ branch: "ab12cd34", branches: 2 })), false); // on a branch
  assert.equal(agentOpen(chat({ branches: 2 })), false); // on main, with a branch beside it
});
