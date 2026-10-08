// The server and agent choices of a chat's composer and the chat with no agent: the logic the
// components use (src/logic/agentlist.ts, src/logic/status.ts), the body api.configure sends for
// an agent pick (src/api.ts with a stubbed global fetch), and the toolbar read as source (the unit
// tests have no DOM).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, ApiError } from "../src/api.ts";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, agentLabel, agentLine, agentOpen, configHint, noAgentPlaceholder, noAgentReason, pickAgent } from "../src/logic/agentlist.ts";
import { pickServer, showsServer } from "../src/logic/chatserver.ts";
import { serverChoice } from "../src/logic/serverlists.ts";
import { composerControls, refreshAfterRefusal, sendTitle } from "../src/logic/status.ts";
import { AGENT_ORDER, LOCAL_SERVER, type AgentKind, type ChatView } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const composer = src("Composer.tsx"), choices = src("ChatChoices.tsx");
/** The source of Composer.tsx's Toolbar. */
const toolbar = composer.slice(composer.indexOf("export function Toolbar("), composer.indexOf("function ModelNotice("));

const calls: { path: string; method?: string; body: unknown }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true } };
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; answer = { status: 200, body: { ok: true } }; });

// ---- AC29: the five choices

test("the toolbar's choices are server, agent, folder, model, effort, in this order", () => {
  const at = ["<ServerPick ", "<AgentPick ", "<DirPicker ", 'title="Model"', 'title="Effort"'].map((mark) => {
    assert.equal(toolbar.split(mark).length, 2, `${mark} is in the toolbar once`);
    return toolbar.indexOf(mark);
  });
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  // the selectors of the two new choices are their titles'
  assert.equal(count(choices, /title="Server"/g), 1);
  assert.equal(count(choices, /title="Agent"/g), 1);
});

test("the server choice lists this computer and every entry, and ends with Servers…", () => {
  const c = { locked: false } as ChatView;
  assert.deepEqual(serverChoice([], c), { options: [{ id: "local", label: "This computer" }], fixed: "" });
  assert.equal(serverChoice([], c).options[0].id, LOCAL_SERVER);
  const got = serverChoice([{ id: "s_1", name: "Studio", state: "unreachable" }, { id: "s_2", name: "Old", state: "too_old" }], c);
  assert.deepEqual(got.options.map((o) => [o.id, o.label, !!o.disabled]), [["local", "This computer", false], ["s_1", "Studio", false], ["s_2", "Old", true]]);
  assert.ok(got.options[2].reason, "a disabled entry says why");
  // the component: the options with the reason as the note, the last item, and a fixed chip in place of the choice
  assert.ok(/const \{ options, fixed \} = serverChoice\(servers, c, useBoardServer\(c\)\);/.test(choices), "ServerPick lists serverChoice");
  assert.ok(choices.includes("options={options.map((o) => ({ id: o.id, label: o.label, note: o.reason, disabled: o.disabled }))}"));
  assert.ok(choices.includes('more={{ label: "Servers…", onClick: () => openServers() }}'));
  assert.ok(choices.includes("if (fixed) return <span className={`tchip static server-chip ${w.connected ? \"\" : \"off\"}`} title={`Server — ${fixed}`}>{w.name}</span>;"));
  // a disabled option takes no pick, by the mouse or by Enter
  assert.ok(composer.includes("if (!o || o.disabled) return;"));
  assert.ok(composer.includes("aria-disabled={o.disabled || undefined} title={o.disabled ? o.note : undefined}"));
});

test("a server pick sends the server alone and takes the chat the server answers with; a refusal takes nothing", async () => {
  const chat = { id: "c_1", agent: "pi", server: "s_1", locked: false } as ChatView;
  answer = { status: 200, body: { ok: true, chat } };
  const taken: ChatView[] = [];
  await pickServer((p) => api.configure("c_1", "main", p), "s_1", (c) => taken.push(c));
  assert.deepEqual(calls, [{ path: "/api/chats/c_1?branch=main", method: "PATCH", body: { server: "s_1" } }]);
  assert.deepEqual(taken, [chat]);
  answer = { status: 409, body: { error: "no chat can be started on that server", code: "server_unusable" } };
  await assert.rejects(pickServer((p) => api.configure("c_1", "main", p), "s_2", (c) => taken.push(c)),
    (e: unknown) => e instanceof ApiError && e.code === "server_unusable" && e.message === "no chat can be started on that server");
  assert.equal(taken.length, 1);
  // the component gives it the store's upsertChat, and the refusal goes where the composer shows the other configure refusals
  assert.ok(/pickServer\(\(p\) => api\.configure\(c\.id, shownBranch\(getState\(\), c\.id\), p\), id, upsertChat\)\s+\.then\(\(\) => onError\(""\), \(e\) => onError\(e\.message\)\)/.test(choices));
});

test("an agent pick sends the agent alone and takes the chat the server answers with", async () => {
  const chat = { id: "c_1", agent: "cursor", model: "auto", locked: false } as ChatView;
  answer = { status: 200, body: { ok: true, chat } };
  const taken: ChatView[] = [];
  await pickAgent((p) => api.configure("c_1", "main", p), "cursor", (c) => taken.push(c));
  assert.deepEqual(calls, [{ path: "/api/chats/c_1?branch=main", method: "PATCH", body: { agent: "cursor" } }]);
  assert.deepEqual(taken, [chat]); // with the model the server chose for that agent
  // the component gives it the store's upsertChat
  assert.ok(/pickAgent\(\(p\) => api\.configure\(c\.id, shownBranch\(getState\(\), c\.id\), p\), id as AgentKind, upsertChat\)/.test(choices));
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

// ---- AC30: the two choices are shown only while they can be changed

test("the agent choice is in the toolbar only while agentOpen; the server also for a chat on another server", () => {
  for (const [name, cond] of [["ServerPick", "showsServer"], ["AgentPick", "agentOpen"]]) {
    assert.equal(count(composer, new RegExp(`<${name}\\b`, "g")), 1, `${name} is rendered in one place`);
    assert.ok(new RegExp(`^\\s*\\{${cond}\\(c\\) && <${name} `, "m").test(toolbar), `${name} is under ${cond}(c)`);
  }
  assert.equal(showsServer({ locked: false }), true);
  assert.equal(showsServer({ locked: true }), false); // a started chat on this computer: as before
  assert.equal(showsServer({ locked: true, server: "local" }), false);
  assert.equal(showsServer({ locked: true, server: "s_1" }), true); // a started chat on another server names it
  assert.equal(showsServer({ locked: false, forkedFrom: "c_0", server: "s_1" }), true);
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
  // the component takes options, mark and line from these
  assert.ok(/agentChoiceOn\(w, usable, c\.agent\)/.test(choices) && /toolbarLine\(w, usable, c\)/.test(choices) && /usableAgents\(s, w\.server\)/.test(choices));
  assert.ok(!choices.includes("AGENT_ORDER"), "ChatChoices.tsx lists no fixed agents");
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

  // the composer reads all of it from here
  assert.ok(composer.includes("title={sendTitleOn(where, usable, c, blocked)} disabled={blocked || off || left || sending ||"));
  assert.ok(composer.includes("const placeholder = offPlaceholder(where, usable, c) || (c.board"));
  assert.ok(/\{line\.text && <div className=\{`agent-reason /.test(choices), "the line is under the toolbar");
  assert.ok(/>No agent</.test(choices) && /: "No agent"\}/.test(choices), "the chip says No agent");
  assert.ok(/\) : !c\.agent \|\| sendOff\(where, c\) \? null : !cat \? \(/.test(toolbar), "no model choice without an agent, or for a server that is not connected");
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
  // the composer puts the text back and asks this before it reads the chat again
  assert.ok(composer.includes("if (!current.current.trim()) input.current?.set(t); // nothing typed is lost"));
  assert.ok(composer.includes("if (e instanceof ApiError && refreshAfterRefusal(e.status, e.code)) void refreshChat(chatId, e.code);"));
});

test("a chat with no agent: its header and its empty thread name no agent, say why, and offer nothing to send", () => {
  assert.equal(agentLabel(""), "No agent");
  assert.equal(agentLabel("claude"), "Claude Code");
  // the hint on what locks at the first message: the agent comes first, and with none to choose there is no hint
  assert.equal(configHint(["claude"], "claude"), "Pick the folder, model and effort below — they lock when you send.");
  assert.equal(configHint(["claude"], ""), "Pick the agent, folder, model and effort below — they lock when you send.");
  assert.equal(configHint([], ""), "");
  assert.equal(configHint([], "claude"), "Pick the folder, model and effort below — they lock when you send.");

  const view = src("ChatView.tsx");
  // the header: a name where the agent's would be, so the line starts with no separator
  assert.ok(/\{agentLabel\(c\.agent\)\}\s+\{c\.cwd \? <> · /.test(view));
  // the empty thread: the title, the reason in place of what an agent's chat says, the hint, and no suggestions
  assert.ok(view.includes('<div className="empty-title">{agentLabel(agent)}</div>'));
  assert.ok(/\{reason\s+\? <p className="empty-reason">\{reason\}<\/p>\s+: c\.board/.test(view)); // by the chat's server: emptyReason (chatserver.test.ts)
  assert.ok(view.includes("const hint = off ? \"\" : configHint(usable, c.agent);") && view.includes('hint && <p className="config-hint">{hint}</p>'));
  assert.ok(view.includes("const suggest = reason ? [] : c.board"));
  assert.ok(!view.includes("they lock when you send"), "the hint's text is in logic/agentlist.ts");
});
