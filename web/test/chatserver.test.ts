// What a chat's composer says and offers by the chat's server (src/logic/chatserver.ts): the texts
// that name the server, the line under the toolbar, the Send that is off, `~` by that server's
// home, the folder titles, the recent folders and the plan usage's key; and the components read
// as source for what they pass on (the unit tests have no DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, agentLine, noAgentReason, usableAgents } from "../src/logic/agentlist.ts";
import { DraftSaver } from "../src/logic/drafts.ts";
import { goneText } from "../src/logic/remoteview.ts";
import { FIRST_TEXT_KEPT, emptyReason, errShown, errStays, sendGone, sendingLine, startsThere } from "../src/logic/chatserver.ts";
import { AGENT_UNCONFIRMED, agentChoiceOn, folderHead, folderStarts, folderTitle, noAgentOn, noAgentReasonOn, notConnectedLine, offPlaceholder, recentFrom, sendOff,
  sendTitleOn, tildeBy, toolbarLine, unconfirmedLine, usageKey, usageTitleOn, withRecent, type Where } from "../src/logic/chatserver.ts";
import { listsOf, recentKey, serverConnected, serverName, serverOf } from "../src/logic/serverlists.ts";
import type { ServerState } from "../src/logic/servers.ts";
import { LOCAL_SERVER, type AgentKind, type ChatView, type ServerLists } from "../src/types.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const composer = src("Composer.tsx"), choices = src("ChatChoices.tsx"), chatView = src("ChatView.tsx");

const HERE: Where = { server: LOCAL_SERVER, name: "This computer", connected: true };
const THERE: Where = { server: "s_1", name: "Studio", connected: true };
const DOWN: Where = { ...THERE, connected: false };
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", status: "ready", locked: false, ...o }) as ChatView;
const LISTS: ServerLists = { agents: ["pi"], catalogs: {}, home: "/home/u", defaultCwd: "/home/u/work" };
const store = (state: ServerState) => ({
  usable: ["claude"] as AgentKind[], catalogs: {}, home: "/Users/me", defaultCwd: "/Users/me/code",
  lists: { s_1: LISTS }, servers: [{ id: "s_1", name: "Studio", state }],
});

test("the composer's Where is the chat's server, its name and whether it is connected", () => {
  const s = store("unreachable");
  const c = { server: "s_1" };
  assert.deepEqual({ server: serverOf(c), name: serverName(s, serverOf(c)), connected: serverConnected(s, serverOf(c)) }, DOWN);
  assert.deepEqual({ server: serverOf({}), name: serverName(s, serverOf({})), connected: serverConnected(s, serverOf({})) }, HERE);
  assert.ok(choices.includes("const server = serverOf(c);") && choices.includes("serverName(s, server)") && choices.includes("serverConnected(s, server)"));
  // the agents are the chat's server's: none while it is not connected
  assert.deepEqual(usableAgents(s, "s_1"), []);
  assert.deepEqual(usableAgents(store("connected"), "s_1"), ["pi"]);
  assert.ok(composer.includes("usableAgents(s, where.server)") && choices.includes("usableAgents(s, w.server)"));
  // model and effort come from that server's catalog
  assert.equal(composer.split("catalogFor(s, serverOf(c), c.agent)").length, 3);
  assert.ok(!composer.includes("catalogFor(s, LOCAL_SERVER"));
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
  const line = "Studio is not connected: its agents are not known.";
  assert.equal(notConnectedLine("Studio"), line);
  // also with an agent the chat has from before, and with a list kept from before
  for (const agent of ["", "pi"] as (AgentKind | "")[]) {
    assert.deepEqual(agentChoiceOn(DOWN, [], agent), { options: [], current: agent, missing: false, reason: line });
    assert.deepEqual(toolbarLine(DOWN, [], { agent }), { text: line, tone: "missing" });
  }
  assert.equal(noAgentReasonOn(DOWN, []), line);
  const c = chat({ server: "s_1", agent: "pi" });
  assert.equal(sendOff(DOWN, c), true);
  assert.equal(sendTitleOn(DOWN, [], c, false), line);
  assert.equal(sendTitleOn(DOWN, [], chat({ server: "s_1", agent: "" }), true), line);
  assert.equal(offPlaceholder(DOWN, [], c), "Studio is not connected");
  // connected: as any chat
  assert.equal(sendOff(THERE, c), false);
  assert.equal(sendTitleOn(THERE, ["pi"], c, false), "Send (Enter)");
  assert.equal(sendTitleOn(THERE, [], chat({ agent: "" }), true), noAgentOn(THERE));
  assert.equal(sendTitleOn(THERE, ["pi"], chat({ status: "thinking" }), true), "The agent is working");
  assert.equal(offPlaceholder(THERE, ["pi"], c), "");
  assert.equal(offPlaceholder(THERE, ["pi"], chat({ agent: "" })), "Choose an agent…");
  assert.equal(sendOff(HERE, chat()), false);
  // a started chat's send is not off: the server answers it (503 server_unreachable), and the text stays in the box
  for (const started of [{ locked: true }, { forkedFrom: "c_0" }, { branch: "b_1" }, { branches: 2 }] as Partial<ChatView>[]) {
    assert.equal(sendOff(DOWN, chat({ server: "s_1", ...started })), false);
    assert.equal(sendTitleOn(DOWN, [], chat({ server: "s_1", ...started }), false), "Send (Enter)");
  }
  // the composer: Send's button and Enter
  assert.ok(composer.includes("const off = sendOff(where, c);"));
  assert.ok(composer.includes("if ((!t && !quotes.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composer.includes("disabled={blocked || off || left || sending || (!text.trim() && !quotes.length)}"));
  // no "Loading models…" for a server that sends none
  assert.ok(composer.includes('where.connected ? <span className="tchip static">Loading models…</span> : null'));
});

test("a first message with no answer: the line says to send again, the agent is fixed, and Send stays on", () => {
  const line = "Studio did not answer: it is not known whether the first message arrived. Send again: it is sent only once.";
  assert.equal(unconfirmedLine("Studio"), line);
  const c = chat({ server: "s_1", agent: "pi", start: "unconfirmed" });
  for (const w of [THERE, DOWN]) {
    assert.deepEqual(toolbarLine(w, w.connected ? ["pi"] : [], c), { text: line, tone: "unconfirmed" });
    assert.equal(sendOff(w, c), false); // sending again is how it is settled; a server that is not connected answers 503
    assert.equal(sendTitleOn(w, [], c, false), "Send (Enter)");
    assert.equal(offPlaceholder(w, [], c), "");
  }
  assert.ok(choices.includes('c.start === "unconfirmed" ? <span className="tchip static" title={`Agent — ${AGENT_UNCONFIRMED}`}>'));
  assert.match(AGENT_UNCONFIRMED, /agent cannot be changed/);
  // the text stays in the box after a send with no answer (504) or to a server that is not connected (503): the failed send's path
  assert.ok(composer.includes("setErr(e?.message ?? String(e));"));
  assert.ok(composer.includes("if (!current.current.trim()) input.current?.set(t); // nothing typed is lost"));
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
  assert.ok(composer.includes("export const tildify = (p?: string, server: string = LOCAL_SERVER) => tildeBy(listsOf(getState(), server)?.home, p);"));
  assert.ok(composer.includes("const tilde = (p?: string) => tildify(p, server);"));
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
  assert.deepEqual(folderStarts(undefined), ["", ""]); // lists that never came: the server's own start
  assert.ok(composer.includes("const r = await api.dirs(p, server);"));
  assert.ok(composer.includes("folderStarts(listsOf(getState(), server))"));
  assert.ok(composer.includes("server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })}"));
  assert.ok(composer.includes('<DirBrowser start={cwd ?? ""} server={server}'));
});

test("recent folders are kept per server", () => {
  assert.deepEqual(recentFrom(null), []);
  assert.deepEqual(recentFrom("not json"), []);
  assert.deepEqual(recentFrom('{"a":1}'), []);
  assert.deepEqual(recentFrom('["/a","/b",3]'), ["/a", "/b"]);
  assert.deepEqual(withRecent(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(withRecent(["1", "2", "3", "4", "5", "6"], "7"), ["7", "1", "2", "3", "4", "5"]);
  assert.notEqual(recentKey("s_1"), recentKey(LOCAL_SERVER));
  // the key in use: read and written under the server's, and the chat's server is the one handed down
  assert.ok(composer.includes("recentFrom(safeGet(recentKey(server)))"));
  assert.ok(composer.includes("safeSet(recentKey(server), JSON.stringify(withRecent(recentDirs(server), d)))"));
  assert.ok(composer.includes("rememberDir(d, server); setOpen(false);") && composer.includes("recentDirs(server).filter("));
  assert.ok(!composer.includes('"aiwb.dirs"'));
});

test("plan usage asks the chat's server, is kept by server and agent, and is titled by the server", () => {
  assert.equal(usageKey("s_1", "claude"), "s_1:claude");
  assert.equal(usageKey(LOCAL_SERVER, "claude"), "local:claude");
  assert.notEqual(usageKey("s_1", "claude"), usageKey("s_2", "claude"));
  assert.equal(usageTitleOn(THERE, "Plan usage limits"), "Plan usage on Studio");
  assert.equal(usageTitleOn(THERE, "Cursor usage"), "Plan usage on Studio");
  assert.equal(usageTitleOn(HERE, "Cursor usage"), "Cursor usage");
  assert.ok(composer.includes("const key = usageKey(where.server, agent);"));
  assert.ok(composer.includes("const r = await api.usage(agent, fresh, where.server); lastUsage[key] = r; setU(r);"));
  assert.ok(composer.includes("useState<PlanUsage | null>(lastUsage[key] ?? null)"));
  assert.ok(composer.includes("<UsagePopover key={usageKey(where.server, c.agent)} agent={c.agent} where={where}"));
  assert.ok(composer.includes("const title = own && usageTitleOn(where, own);")); // pi has none, there as here
});

// ---- the findings of the review T87

test("emptyReason: what an empty thread says of a chat that takes no message, by its server (F1, F12)", () => {
  // this computer: the sentences from before
  assert.equal(emptyReason(HERE, ["claude"], chat()), "");
  assert.equal(emptyReason(HERE, ["claude"], chat({ agent: "" })), CHOOSE_AGENT);
  assert.equal(emptyReason(HERE, [], chat({ agent: "" })), NO_AGENT);
  // another server, connected: it is named
  assert.equal(emptyReason(THERE, ["pi"], chat({ server: "s_1", agent: "pi" })), "");
  assert.equal(emptyReason(THERE, ["pi"], chat({ server: "s_1", agent: "" })), CHOOSE_AGENT);
  assert.equal(emptyReason(THERE, [], chat({ server: "s_1", agent: "" })), "No agent is installed on Studio. Install Claude Code, Cursor or pi on that machine.");
  // not connected: its agents are not known, whether the chat has one or not
  assert.equal(emptyReason(DOWN, [], chat({ server: "s_1", agent: "" })), notConnectedLine("Studio"));
  assert.equal(emptyReason(DOWN, [], chat({ server: "s_1", agent: "claude" })), notConnectedLine("Studio"));
  // a started chat and an unconfirmed start show their thread or take the message again
  assert.equal(emptyReason(DOWN, [], chat({ server: "s_1", locked: true })), "");
  assert.equal(emptyReason(DOWN, [], chat({ server: "s_1", start: "unconfirmed" })), "");
  // the empty thread uses it, offers no suggestion with it, and shows no agent and no hint for a server that is not connected
  assert.ok(chatView.includes("const reason = emptyReason(where, usable, c);") && chatView.includes("const suggest = reason ? []"));
  assert.ok(chatView.includes("const agent = off ? \"\" : c.agent;") && chatView.includes("const hint = off ? \"\" : configHint(usable, c.agent);"));
  assert.ok(!chatView.includes("noAgentReason(usable)"));
  // the header says no "Ready" for it, and the toolbar offers no model and no effort
  assert.ok(chatView.includes("headStatus(c, isLegacy(c), statusText(c, boardName), sendOff(where, c))"));
  assert.ok(composer.includes(") : !c.agent || sendOff(where, c) ? null : !cat ? ("));
});

test("the chat header shortens the folder with the home of the chat's server (F2)", () => {
  assert.ok(chatView.includes("tildify(c.cwd, server)") && !chatView.includes("tildify(c.cwd)"));
});

test("errShown, errStays: which refusal's sentence is put under the composer, and which stays (F3, F4, F6)", () => {
  assert.equal(errShown("start_unconfirmed"), false); // the line under the toolbar says it
  for (const code of [undefined, "server_unreachable", "not_sent", "send_unknown", "busy", FIRST_TEXT_KEPT]) assert.equal(errShown(code), true, String(code));
  assert.equal(errStays(FIRST_TEXT_KEPT), true); // the chat starts with that answer: the sentence is not about what it was before
  for (const code of [undefined, "server_unreachable", "not_sent", "busy"]) assert.equal(errStays(code), false, String(code));
  assert.ok(composer.includes("if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) { errKept.current = errStays(code); setErr("));
  // the sentence goes when the server is connected again, and with the chat's start and choices
  assert.ok(composer.includes("useEffect(() => { if (where.connected && !errKept.current) setErr(\"\"); }, [where.connected]);"));
  assert.ok(composer.includes("useEffect(() => { if (!errKept.current) setErr(\"\"); }, [c?.locked, c?.start, c?.server, c?.agent, c?.cwd, c?.model, c?.effort]);"));
});

test("startsThere, sendingLine: the first message of a chat on another server is shown while it is sent (F5)", () => {
  assert.equal(startsThere(chat({ server: "s_1" })), true);
  assert.equal(startsThere(chat({ server: "s_1", start: "unconfirmed" })), true); // sent again
  assert.equal(startsThere(chat()), false);
  assert.equal(startsThere(chat({ server: LOCAL_SERVER })), false);
  for (const o of [{ locked: true }, { forkedFrom: "c_0" }, { branch: "ab12cd34" }, { branches: 2 }]) assert.equal(startsThere(chat({ server: "s_1", ...o })), false, JSON.stringify(o));
  assert.equal(sendingLine("Studio"), "Sending to Studio…");
  assert.ok(composer.includes("if (first) setStarting(chatId, t);") && composer.includes("drafts.current!.sending(undefined, first)"));
  assert.ok(chatView.includes("{sendingLine(serverIs)}") && chatView.includes("starting !== undefined ? ("));
});

test("sendGone: a chat its server no longer has takes no Send, and the Send says so", () => {
  assert.equal(sendGone({ server: "s_1", gone: true }), true);
  assert.equal(sendGone({ server: "s_1" }), false);
  assert.equal(sendGone({ gone: true }), false); // a chat of this computer is never gone
  assert.equal(sendTitleOn(THERE, ["pi"], chat({ server: "s_1", locked: true, gone: true }), false), "This chat is no longer on Studio.");
  assert.equal(sendTitleOn(DOWN, [], chat({ server: "s_1", locked: true, gone: true }), false), goneText("Studio"));
  assert.equal(sendTitleOn(THERE, ["pi"], chat({ server: "s_1", locked: true }), false), "Send (Enter)");
  assert.ok(composer.includes("disabled={blocked || off || left || sending ||") && composer.includes("const left = sendGone(c);"));
});

// A first message answered 409 first_text_kept (F6): the chat started on its server with an earlier text, the server removed the draft (the sent text)
// on a counter raised by one, and the text of this Send must end in the box and be saved as the started chat's draft. The composer's steps, as submit
// takes them, over a real saver: the Send is held, the box is emptied, the refusal comes, the saver is told of it (DraftSaver.kept, which counts from
// its own counter; keptRev, which counted from the store's record, is gone: the review T123, N1), the text is put back.
test("the saver and first_text_kept: a text refused so is saved as the started chat's draft, whichever of the answer and the event comes first", async () => {
  const T = { text: "second text" };

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const eventFirst of [true, false]) {
    const puts: { text: string; base?: number }[] = [], shown: string[] = [];
    let rev = 3, stored: { text: string } | undefined = T; // the server's
    const saver = new DraftSaver(async (d, _k, base) => {
      puts.push({ text: d.text, base });
      if (base !== rev) throw Object.assign(new Error("stale"), { code: "stale", rev, draft: stored });
      stored = d.text ? { text: d.text } : undefined;
      return ++rev;
    }, T, undefined, 5, 3, (d) => shown.push(d.text));
    const answered = saver.sending(20, true);
    saver.change("");                                   // the box is emptied at Enter
    await wait(15);
    assert.deepEqual(puts, [], "a held Send saves nothing");
    rev = 4; stored = undefined;                           // the swap: no draft, the counter raised by one
    if (eventFirst) saver.arrived(4, null);             // the branch_state event of the swap
    // the 409: submit's catch, then its finally
    saver.kept();
    saver.change(T.text);                               // the text is back in the box
    answered(true);
    if (!eventFirst) saver.arrived(4, null);            // the event comes after the answer
    await wait(30);
    assert.deepEqual(puts, [{ text: "second text", base: 4 }], `event first: ${eventFirst}`);
    assert.deepEqual([rev, stored], [5, T]);
    assert.deepEqual(shown, [], "nothing replaces the text in the box");
  }
  assert.ok(composer.includes("if (code === FIRST_TEXT_KEPT) drafts.current!.kept();"));
  assert.ok(!composer.includes("keptRev"));
});
