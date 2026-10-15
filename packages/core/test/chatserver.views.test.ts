// What a chat's composer and empty thread say by the server the chat is on (src/logic/chatserver.ts): the texts for a chat with no agent, a server
// that is not connected, a chat its server no longer has; the folder browser's head and its recent folders. Pure logic: the pages that draw them are
// proved in the browser checks (web/dev/checks/L16, L23).
// Rows: C-CH-05 (no agent: the box's placeholder, Send's title), C-CH-11 (the recent folders), C-RO-03 (an empty chat its server no longer has),
// C-IM-25 (the gone sentence is also the attach button's title), C-CH-09 (the browser's head).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHOOSE_AGENT, NO_AGENT } from "../src/logic/agentlist.ts";
import { imagesOff } from "../src/logic/chatimage.ts";
import { emptyReason, folderHead, folderStarts, folderTitle, noAgentOn, notConnectedLine, offPlaceholder, offWhy, recentFrom, sendOff, sendTitleOn, tildeBy, withRecent, type Where } from "../src/logic/chatserver.ts";
import { goneText } from "../src/logic/remoteview.ts";
import { RECENT_KEY } from "../src/logic/serverlists.ts";
import { LOCAL_SERVER, type AgentKind, type ChatView } from "../src/types.ts";

const HERE: Where = { server: LOCAL_SERVER, name: "This computer", connected: true };
const THERE: Where = { server: "s_1", name: "Studio", connected: true };
const DOWN: Where = { ...THERE, connected: false };
const chat = (o: Partial<ChatView> = {}) => ({ id: "c_1", agent: "claude", status: "ready", locked: false, ...o }) as ChatView;

test("a chat with no agent: the box says to choose one (or that none is installed), Send is off with the reason, the thread offers nothing to send", () => {
  const none = chat({ agent: "" });
  // an agent can be chosen
  assert.equal(offPlaceholder(HERE, ["claude"], none), "Choose an agent…");
  assert.equal(sendTitleOn(HERE, ["claude"], none, true), CHOOSE_AGENT);
  assert.equal(emptyReason(HERE, ["claude"], none), CHOOSE_AGENT);
  // none is installed: this computer's sentence, and another server's names it
  assert.equal(offPlaceholder(HERE, [], none), "No agent is installed");
  assert.equal(sendTitleOn(HERE, [], none, true), NO_AGENT);
  assert.equal(emptyReason(HERE, [], none), NO_AGENT);
  assert.equal(offPlaceholder(THERE, [], none), "No agent is installed");
  assert.equal(sendTitleOn(THERE, [], none, true), noAgentOn(THERE));
  assert.equal(emptyReason(THERE, [], none), "No agent is installed on Studio. Install Claude Code, Cursor or pi on that machine.");
  // a chat with an agent says nothing of the kind
  assert.equal(offPlaceholder(HERE, ["claude"], chat()), "");
  assert.equal(emptyReason(HERE, ["claude"], chat()), "");
  assert.equal(emptyReason(THERE, ["pi"], chat({ agent: "pi" })), "");
});

test("a server that is not connected: Send, the box and the empty thread say so, before the agent's own words", () => {
  const line = "Studio is not connected: nothing can be sent or changed until it is back.";
  assert.equal(notConnectedLine("Studio"), line);
  assert.equal(sendOff(DOWN), true);
  assert.equal(sendOff(THERE), false);
  assert.equal(sendOff(HERE), false);
  for (const agent of ["", "pi"] as (AgentKind | "")[]) {
    const c = chat({ id: "s_1~c_1", agent });
    assert.equal(sendTitleOn(DOWN, [], c, true), line);
    assert.equal(offPlaceholder(DOWN, [], c), "Studio is not connected");
    assert.equal(emptyReason(DOWN, [], c), line);
    assert.equal(offWhy(DOWN), line);
  }
  // started or not does not matter: the view is read-only as it was
  for (const started of [{ locked: true }, { forkedFrom: "c_0" }, { branches: 2 }, { status: "thinking" }] as Partial<ChatView>[]) {
    assert.equal(sendTitleOn(DOWN, [], chat({ agent: "pi", ...started }), false), line);
  }
  assert.equal(offWhy(THERE), "");
});

test("a chat its server no longer has: the gone sentence stands for Send, the box, the empty thread and the attach button, before a server that is not connected", () => {
  const gone = goneText("Studio");
  assert.equal(gone, "This chat is no longer on Studio.");
  const c = chat({ id: "s_1~c_1", agent: "pi", locked: true });
  assert.equal(sendTitleOn(THERE, ["pi"], c, false, true), gone);
  assert.equal(sendTitleOn(THERE, ["pi"], c, true, true), gone, "before what else blocks it");
  assert.equal(sendTitleOn(DOWN, [], c, false, true), gone, "and before the server that is not connected");
  assert.equal(sendTitleOn(THERE, ["pi"], c, false, false), "Send (Enter)");
  assert.equal(offPlaceholder(THERE, ["pi"], c, true), gone);
  assert.equal(offPlaceholder(DOWN, [], c, true), gone);
  assert.equal(offWhy(THERE, true), gone);
  assert.equal(offWhy(DOWN, true), gone, "gone comes first: the server coming back mends nothing for it");
  // an empty chat of it offers nothing to send, whether or not it has an agent, connected or not (the thread draws no suggestion where this is not "")
  assert.equal(emptyReason(THERE, ["pi"], chat({ agent: "pi" }), true), gone);
  assert.equal(emptyReason(DOWN, [], chat({ agent: "" }), true), gone);
  assert.equal(emptyReason(HERE, ["claude"], chat(), false), "");
  // (the attach button's title for a chat that is there is imagesOff's: a server that is not connected has its own sentence, a connected one none)
  assert.equal(imagesOff({ server: "Studio", connected: false, model: "" })?.title, "Studio is not connected: images can be added when it is back");
  assert.equal(imagesOff({ server: "Studio", connected: true, model: "" }), null);
});

test("the folder browser is headed by the server, and shortens a path with that server's home", () => {
  assert.equal(folderHead(HERE), "Start the agent in");
  assert.equal(folderHead(THERE), "Folder on Studio");
  assert.deepEqual(folderStarts({ home: "/Users/me", defaultCwd: "/Users/me/code" }), ["/Users/me/code", "/Users/me"]);
  assert.deepEqual(folderStarts({ home: "/Users/me" }), ["/Users/me", "/Users/me"]);
  assert.deepEqual(folderStarts(undefined), ["", ""]);
  assert.equal(tildeBy("/Users/me", "/Users/me/code/shop"), "~/code/shop");
  assert.equal(tildeBy("/Users/me", "/Users/me"), "~");
  assert.equal(tildeBy("/Users/me", "/Users/mer/code"), "/Users/mer/code", "a folder that only starts with the same letters is not inside the home");
  assert.equal(tildeBy(undefined, "/tmp/x"), "/tmp/x");
});

test("the folder chip's title: this computer's, another server's named, a folder that is not found, a folder fixed by the first message", () => {
  assert.equal(folderTitle(HERE, "/Users/me/shop", { hint: "until the first message" }), "Working directory: /Users/me/shop — until the first message");
  assert.equal(folderTitle(HERE, "/Users/me/shop", { locked: true }), "Working directory: /Users/me/shop");
  assert.equal(folderTitle(HERE, "/gone/dir", { missing: true }), "Folder not found: /gone/dir");
  assert.equal(folderTitle(THERE, "/home/u/shop", { hint: "until the first message" }), "Folder on Studio: /home/u/shop — until the first message");
  assert.equal(folderTitle(THERE, "/home/u/shop", { locked: true }), "Folder on Studio: /home/u/shop");
  assert.equal(folderTitle(THERE, "/gone/dir", { missing: true }), "Folder not found on Studio: /gone/dir");
});

test("the recent folders: last used first, once, six at most; stored as a list of paths under one key", () => {
  assert.equal(RECENT_KEY, "aiwb.dirs");
  assert.deepEqual(recentFrom(null), []);
  assert.deepEqual(recentFrom("not json"), []);
  assert.deepEqual(recentFrom('{"a":1}'), []);
  assert.deepEqual(recentFrom('["/a","/b",3]'), ["/a", "/b"]);
  assert.deepEqual(withRecent(["/a", "/b"], "/b"), ["/b", "/a"]);
  assert.deepEqual(withRecent(["1", "2", "3", "4", "5", "6"], "7"), ["7", "1", "2", "3", "4", "5"]);
  assert.deepEqual(recentFrom(JSON.stringify(withRecent(recentFrom(JSON.stringify(withRecent([], "/a"))), "/b"))), ["/b", "/a"], "what is written is what is read");
});
