// What blocks the phone's composer and what it says (screens/composer/blocked.ts; goal 3.7.1, the V1 design §1).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_AGENT } from "@aiwb/core/logic/agentlist.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";

import { ARCHIVED_SUB, ARCHIVED_TITLE, LEGACY_SUB, LEGACY_TITLE, NO_AGENT_SUB, OFFLINE_KEPT, blockOf, noAgentWords, offlineSentence, type BlockInputs } from "../src/screens/composer/blocked.ts";

const NOW = new Date(2026, 9, 24, 15, 30).getTime();
const AT = new Date(2026, 9, 24, 14, 2).getTime();
const on = { server: "s1", name: "Build box", connected: true };
const off = { ...on, connected: false };
const base: BlockInputs = { archived: false, legacy: false, board: true, where: on, gone: false, usable: ["claude"], agent: "claude", since: AT, now: NOW, tooSmall: "", refused: "" };
const of = (o: Partial<BlockInputs>) => blockOf({ ...base, ...o });

describe("blocked states of the phone's composer (3.7.1)", () => {
  it("nothing blocks a chat that takes a message", () => {
    assert.deepEqual(of({}), { main: null, above: [], sendOff: "" });
  });

  it("offline: in the toolbar's place, with the time, the kept draft and Servers", () => {
    const b = of({ where: off });
    assert.deepEqual(b.main, { kind: "offline", place: "toolbar", title: "Build box is offline since 14:02.", sub: OFFLINE_KEPT, action: "servers" });
    assert.equal(OFFLINE_KEPT, "Your draft is kept until it's back.");
  });
  it("offline with no time known drops the time", () => {
    assert.equal(of({ where: off, since: undefined }).main?.title, "Build box is offline.");
    assert.equal(offlineSentence("Studio", undefined, NOW), "Studio is offline.");
  });
  it("offline since a day before reads as formatSince does", () => {
    assert.equal(offlineSentence("Studio", new Date(2026, 9, 23, 9, 0).getTime(), NOW), "Studio is offline since yesterday.");
  });

  it("gone: the sentence, no second line, no control", () => {
    assert.deepEqual(of({ gone: true }).main, { kind: "gone", place: "toolbar", title: goneText("Build box"), sub: "" });
  });

  it("archived: in the box's place with Unarchive", () => {
    assert.deepEqual(of({ archived: true }).main, { kind: "archived", place: "box", title: ARCHIVED_TITLE, sub: ARCHIVED_SUB, action: "unarchive" });
    assert.equal(ARCHIVED_SUB, "Unarchive it to send a message. It goes back to the list with the others.");
  });
  it("archived and offline: the bar says why, with no button", () => {
    const m = of({ archived: true, where: off }).main;
    assert.deepEqual(m, { kind: "archived", place: "box", title: "This chat is archived.", sub: "Build box is offline since 14:02." });
    assert.equal(m?.action, undefined);
    assert.equal(of({ archived: true, where: off, since: undefined }).main?.sub, "Build box is offline.");
  });

  it("legacy: New chat on this board, with no button for a chat with no board", () => {
    assert.deepEqual(of({ legacy: true }).main, { kind: "legacy", place: "box", title: LEGACY_TITLE, sub: LEGACY_SUB, action: "newchat" });
    assert.equal(of({ legacy: true, board: false }).main?.action, undefined);
    assert.equal(LEGACY_SUB, "Start a new chat on this board to go on.");
  });

  it("no agent: another server is named, this computer says today's sentence", () => {
    const m = of({ agent: "", usable: [] }).main;
    assert.deepEqual(m, { kind: "noagent", place: "box", title: "No agent is installed on Build box.", sub: NO_AGENT_SUB });
    const local = noAgentWords({ server: "local", name: "This computer", connected: true });
    assert.equal(`${local.title} ${local.sub}`, NO_AGENT);
    assert.match(local.title, /^No agent is installed on this computer\.$/);
  });
  it("a chat with no agent where agents are offered is not blocked; one with an agent never is", () => {
    assert.equal(of({ agent: "", usable: ["claude"] }).main, null);
    assert.equal(of({ agent: "claude", usable: [] }).main, null);
  });
  it("no agent is not said while the server is offline: its agents are not known", () => {
    assert.equal(of({ agent: "", usable: [], where: off }).main?.kind, "offline");
  });

  it("priority: archived › legacy › no agent › gone › offline", () => {
    const all = { archived: true, legacy: true, agent: "", usable: [], gone: true, where: off };
    assert.equal(of(all).main?.kind, "archived");
    assert.equal(of({ ...all, archived: false }).main?.kind, "legacy");
    assert.equal(of({ ...all, archived: false, legacy: false, where: on }).main?.kind, "noagent");
    assert.equal(of({ gone: true, where: off }).main?.kind, "gone");
    assert.equal(of({ where: off }).main?.kind, "offline");
  });

  it("model too small: amber card above, Pick a model, Send greyed with the reason", () => {
    const b = of({ tooSmall: "Haiku 5.5 has too small a context window for this conversation. Pick a larger model." });
    assert.equal(b.main, null);
    assert.deepEqual(b.above.map((x) => [x.kind, x.place, x.action]), [["toosmall", "above", "pickmodel"]]);
    assert.equal(b.sendOff, b.above[0].title);
  });
  it("refused send: red card above with ×, Send is not greyed by it", () => {
    const b = of({ refused: "Not sent: the folder no longer exists." });
    assert.deepEqual(b.above, [{ kind: "refused", place: "above", title: "Not sent: the folder no longer exists.", sub: "", action: "dismiss" }]);
    assert.equal(b.sendOff, "");
  });
  it("both above notices stand together, with an offline toolbar too", () => {
    const b = of({ where: off, tooSmall: "Too small.", refused: "Refused." });
    assert.equal(b.main?.kind, "offline");
    assert.deepEqual(b.above.map((x) => x.kind), ["toosmall", "refused"]);
  });
  it("no notice above while the box is replaced", () => {
    for (const o of [{ archived: true }, { legacy: true }, { agent: "", usable: [] }]) {
      const b = of({ ...o, tooSmall: "Too small.", refused: "Refused." });
      assert.deepEqual([b.above, b.sendOff], [[], ""]);
    }
  });
});

describe("the account banner above the phone's box (multiple-claude goal §1.5, §4.2)", () => {
  const NOT_MOUNTED = "This folder isn't mounted in Claude · Work — Add it in Settings";
  it("a folder not mounted: an amber notice above, first, with Add it in Settings, and its sentence holds Send", () => {
    const b = of({ agent: "claude:a_work0001", account: { state: "not_mounted", text: NOT_MOUNTED }, tooSmall: "Too small.", refused: "Refused." });
    assert.equal(b.main, null);
    assert.deepEqual(b.above.map((x) => [x.kind, x.action ?? ""]), [["account", "settings"], ["toosmall", "pickmodel"], ["refused", "dismiss"]]);
    assert.deepEqual(b.above[0], { kind: "account", place: "above", title: NOT_MOUNTED, sub: "", state: "not_mounted", action: "settings" });
    assert.equal(b.sendOff, NOT_MOUNTED, "the banner's sentence is Send's reason, before the model's");
  });
  it("pending offers Restart container; a removed account offers nothing; both hold Send", () => {
    const p = of({ account: { state: "pending", text: "Restart Claude · Client to use this folder" } });
    assert.deepEqual([p.above[0].action, p.sendOff], ["restart", "Restart Claude · Client to use this folder"]);
    const r = of({ account: { state: "removed", text: "This account was removed" } });
    assert.deepEqual([r.above[0].action, r.sendOff], [undefined, "This account was removed"]);
  });
  it("no banner while the box is replaced (an archived chat on an account)", () => {
    const b = of({ archived: true, account: { state: "removed", text: "This account was removed" } });
    assert.deepEqual([b.above, b.sendOff], [[], ""]);
  });
  it("no banner: as before", () => {
    assert.deepEqual(of({ account: null }), { main: null, above: [], sendOff: "" });
  });
});
