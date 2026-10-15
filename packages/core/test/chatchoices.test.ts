// The server's name and the agent choice of a chat's composer and the chat with no agent: the logic the
// components use (src/logic/agentlist.ts, src/logic/status.ts), the body api.configure sends for
// an agent pick (src/api.ts through a fake transport), and the toolbar read as source (the unit
// tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sourceOf } from "./fixtures/bundle.ts";
import { installFake } from "./fixtures/faketransport.ts";
import { api, ApiError } from "../src/api.ts";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, agentLabel, agentLine, agentOpen, configHint, noAgentPlaceholder, noAgentReason, pickAgent } from "../src/logic/agentlist.ts";
import { showsServer } from "../src/logic/chatserver.ts";
import { SERVER_FINAL } from "../src/logic/serverlists.ts";
import { composerControls, refreshAfterRefusal, sendTitle } from "../src/logic/status.ts";
import { AGENT_ORDER, LOCAL_SERVER, type AgentKind, type ChatView } from "../src/types.ts";

const src = sourceOf;

const fake = installFake();
const calls = fake.calls;
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
fake.handler = () => ({ status: answer.status, text: JSON.stringify(answer.body), sceneRev: null });
beforeEach(() => { fake.reset(); answer = { status: 200, body: { ok: true } }; });

test("the server picker is gone from the toolbar: the server is a chip that opens nothing and sends nothing", () => {
  assert.equal(SERVER_FINAL, "A chat is on the server it was made on");
  // the api's configure takes no server
  const apiSrc = src("api.ts");
  const configure = apiSrc.slice(apiSrc.indexOf("  configure: ("), apiSrc.indexOf("  /** Saves a branch's draft"));
  assert.ok(configure.includes("p: { agent?: AgentKind; model?: string; effort?: string; cwd?: string; subDepth?: number; subCap?: number }"));
  assert.ok(!/\bserver\??:/.test(configure), "no field of the change names a server: the chat's key says where the call goes");
  assert.ok(configure.includes('thing<{ ok: boolean; chat?: ChatView }>("chats", id, "PATCH", onBranch(branch), p)'));
});

test("an agent pick sends the agent alone and takes the chat the server answers with", async () => {
  const chat = { id: "c_1", agent: "cursor", model: "auto", locked: false } as ChatView;
  answer = { status: 200, body: { ok: true, chat } };
  const taken: ChatView[] = [];
  await pickAgent((p) => api.configure("c_1", "main", p), "cursor", (c) => taken.push(c));
  assert.deepEqual(calls, [{ server: "local", path: "/api/chats/c_1?branch=main", method: "PATCH", body: { agent: "cursor" } }]);
  assert.deepEqual(taken, [chat]); // with the model the server chose for that agent
  // a chat of a section: the same call to its entry's server, and the chat it answers gets the page's key
  calls.length = 0; taken.length = 0;
  await pickAgent((p) => api.configure("s_1~c_1", "main", p), "cursor", (c) => taken.push(c));
  assert.deepEqual(calls, [{ server: "s_1", path: "/api/chats/c_1?branch=main", method: "PATCH", body: { agent: "cursor" } }]);
  assert.deepEqual(taken, [{ ...chat, id: "s_1~c_1" }]);
});

test("an agent pick the server refuses takes nothing, and an older server's answer without the chat neither", async () => {
  const taken: ChatView[] = [];
  answer = { status: 409, body: { error: "Cursor's program (\"agent\") was not found on this server: install it, or choose another agent", code: "agent_missing" } };
  await assert.rejects(pickAgent((p) => api.configure("c_1", "main", p), "cursor", (c) => taken.push(c)),
    (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "agent_missing" && /was not found/.test(e.message));
  answer = { status: 200, body: { ok: true } };
  await pickAgent((p) => api.configure("c_1", "main", p), "pi", (c) => taken.push(c));
  assert.deepEqual(taken, []);
  assert.deepEqual(calls.map((c) => c.body), [{ agent: "cursor" }, { agent: "pi" }]);
});

// ---- AC30: the agent choice is shown only while it can be changed; the server's name for a chat on another server

test("the agent choice is in the toolbar only while agentOpen and the chat takes a change; the server's name only for a chat of a section, started or not", () => {
  const here = { server: LOCAL_SERVER, name: "This computer", connected: true };
  assert.equal(showsServer(here), false); // a chat on this computer names no server, new or started: there is nothing to pick
  assert.equal(showsServer({ server: "s_1", name: "Studio", connected: true }), true); // a chat of a section shows the name of its server
  assert.equal(showsServer({ server: "s_1", name: "Studio", connected: false }), true);
  const open = { locked: false } as ChatView;
  assert.equal(agentOpen(open), true);
  assert.equal(agentOpen({ ...open, agent: "" } as ChatView), true); // a chat with no agent chooses one here
  assert.equal(agentOpen({ ...open, locked: true }), false); // after the first message
  assert.equal(agentOpen({ ...open, forkedFrom: "c_0" }), false); // a fork at its start
  assert.equal(agentOpen({ ...open, branch: "b_1" }), false); // a branch at its start
  assert.equal(agentOpen({ ...open, branches: 2 }), false);
});

// ---- AC44: the usable agents alone, the agent the server lacks, the chat with no agent

test("the agent choice offers the usable agents alone; one the server lacks is marked and its line says why", () => {
  const usable: AgentKind[] = ["claude", "pi"];
  assert.deepEqual(agentChoice(usable, "claude").options, usable);
  assert.equal(agentLine(usable, "claude"), "");
  const c = agentChoice(usable, "cursor");
  assert.equal(c.missing, true);
  assert.ok(!c.options.includes("cursor"));
  assert.equal(agentLine(usable, "cursor"), c.reason);
  assert.match(agentLine(usable, "cursor"), /^Cursor is not installed on this computer/);
  // its Send is not blocked by the page: the server looks again, and refuses with the reason
  assert.equal(composerControls({ status: "ready", agent: "cursor" }).blocked, false);
});

test("a chat with no agent shows the reason, and its Send is blocked with the reason as its title", () => {
  // none installed
  assert.equal(agentLine([], ""), NO_AGENT);
  assert.equal(noAgentReason([]), NO_AGENT);
  assert.deepEqual(agentChoice([], "").options, []);
  assert.equal(noAgentPlaceholder([]), "No agent is installed");
  // one installed since: the chat stays without an agent until the user chooses one
  for (const usable of [["claude"], AGENT_ORDER] as AgentKind[][]) {
    assert.equal(agentLine(usable, ""), CHOOSE_AGENT);
    assert.equal(noAgentReason(usable), CHOOSE_AGENT);
    assert.equal(noAgentPlaceholder(usable), "Choose an agent…");
    assert.equal(agentChoice(usable, "").missing, false);
  }
  // a stored agent and none usable: the reason is that none is installed
  assert.equal(agentLine([], "claude"), NO_AGENT);

  const none = { status: "ready", agent: "" } as const;
  assert.deepEqual(composerControls(none), { stop: false, blocked: true, esc: false });
  for (const liveFork of [true, false]) for (const newBranch of [true, false]) {
    assert.equal(composerControls(none, { newBranch, liveFork }).blocked, true);
  }
  assert.equal(sendTitle(none, true, NO_AGENT), NO_AGENT);
  assert.equal(sendTitle(none, true, CHOOSE_AGENT), CHOOSE_AGENT);
  // a chat with an agent keeps today's titles, and one from before the field is not blocked
  assert.deepEqual(composerControls({ status: "ready", agent: "claude" }), { stop: false, blocked: false, esc: false });
  assert.deepEqual(composerControls({ status: "ready" }), { stop: false, blocked: false, esc: false });
  assert.equal(sendTitle({ status: "ready", agent: "claude" }, false, NO_AGENT), "Send (Enter)");
  assert.equal(sendTitle({ status: "thinking", agent: "claude" }, true, NO_AGENT), "The agent is working");
  assert.equal(sendTitle({ status: "thinking", agent: "claude", fresh: true }, true, NO_AGENT), "The agent is starting");
});

test("a Send refused for the agent keeps the typed text: the chat is not read again", () => {
  assert.equal(refreshAfterRefusal(409, "agent_missing"), false);
  assert.equal(refreshAfterRefusal(409, "no_agent"), false);
  // the others are as before
  assert.equal(refreshAfterRefusal(409), true);
  assert.equal(refreshAfterRefusal(409, "busy"), true);
  assert.equal(refreshAfterRefusal(409, "window"), false);
  assert.equal(refreshAfterRefusal(409, "cap"), false);
  assert.equal(refreshAfterRefusal(429, "cap"), false);
  assert.equal(refreshAfterRefusal(400, "agent_missing"), false);
});

test("a chat with no agent: its header and its empty thread name no agent, say why, and offer nothing to send", () => {
  assert.equal(agentLabel(""), "No agent");
  assert.equal(agentLabel("claude"), "Claude Code");
  // the hint on what locks at the first message: the agent comes first, and with none to choose there is no hint
  assert.equal(configHint(["claude"], "claude"), "Pick the folder, model and effort below — they lock when you send.");
  assert.equal(configHint(["claude"], ""), "Pick the agent, folder, model and effort below — they lock when you send.");
  assert.equal(configHint([], ""), "");
  assert.equal(configHint([], "claude"), "Pick the folder, model and effort below — they lock when you send.");
});
