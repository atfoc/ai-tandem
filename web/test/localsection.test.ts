// What this computer's section says and offers besides what every section does (src/logic/localsection.ts): the reason a start
// gave, a server older than the app or of another build, a restart that runs or failed. The section drawn is in sidebar.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REASON_LINES, NO_RESTART, RESTARTING, RESTART_FAILED, localExtra, localNotice, localOf, otherBuild, reasonText, type LocalExtra } from "../src/logic/localsection.ts";
import { LOCAL_ENTRY, stateLabel, type ServerState, type ServerView } from "../src/logic/servers.ts";
import { LOCAL_TOO_OLD, sectionView, sidebarEntries } from "../src/logic/sections.ts";

const STATES: ServerState[] = ["connecting", "connected", "unreachable", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed",
  "certificate_not_accepted", "name_not_known", "not_aiwb", "too_old", "another_server", "not_started"];
const NONE: LocalExtra = { line: "", reason: "", again: null, restart: false, log: false };
const entry = (o: Partial<ServerView> = {}): ServerView => ({ ...LOCAL_ENTRY, state: "connected", version: "2.0.0", ...o });

test("otherBuild: the server is of another build than the app when both are known and differ", () => {
  assert.equal(otherBuild("2.0.0", "1.0.0"), true);
  assert.equal(otherBuild("2.0.0", "2.0.0"), false);
  assert.equal(otherBuild("dev", "1.0.0"), false);
  assert.equal(otherBuild("2.0.0", "dev"), false);
  assert.equal(otherBuild("2.0.0", undefined), false, "a server that reports no version");
  assert.equal(otherBuild("2.0.0", ""), false);
});

test("reasonText: what a start gave, trimmed, its first twelve lines", () => {
  assert.equal(reasonText(undefined), "");
  assert.equal(reasonText("  \n"), "");
  assert.equal(reasonText("\n  AI Whiteboard: the server was not started\nreason\n"), "AI Whiteboard: the server was not started\nreason");
  const lines = Array.from({ length: REASON_LINES }, (_, i) => `l${i}`);
  assert.equal(reasonText(lines.join("\n")), lines.join("\n"), "twelve lines are whole");
  assert.equal(reasonText([...lines, "more"].join("\n")), `${lines.join("\n")}\n…`, "a thirteenth is cut, with a mark");
  assert.equal(reasonText("a\r\nb"), "a\nb");
});

test("localExtra: connecting says nothing, a connected server of the app's build says nothing", () => {
  assert.deepEqual(localExtra(entry({ state: "connecting" }), NO_RESTART, "2.0.0", true), NONE);
  assert.deepEqual(localExtra(entry({ state: "connecting", detail: "Restarting…" }), NO_RESTART, "2.0.0", true), NONE, "a restart shows by the page's own mark");
  assert.deepEqual(localExtra(entry(), NO_RESTART, "2.0.0", true), NONE);
  assert.deepEqual(localExtra(entry({ version: "1.0.0" }), NO_RESTART, "dev", true), NONE);
});

test("localExtra: a start that failed gives the reason, Retry (a start again) and, in the app, the log", () => {
  const v = entry({ state: "not_started", detail: "AI Whiteboard is not set up on this machine.\nSet it up once with: ai-whiteboard remote setup" });
  assert.deepEqual(localExtra(v, NO_RESTART, "2.0.0", true), { line: "", reason: v.detail, again: "start", restart: false, log: true });
  assert.deepEqual(localExtra(v, NO_RESTART, "2.0.0", false), { line: "", reason: v.detail, again: "start", restart: false, log: false }, "not in the app: its log is not the page's to open");
  assert.equal(localExtra(entry({ state: "not_started" }), NO_RESTART, "2.0.0", true).reason, "", "a start with no reason");
});

test("localExtra: every state that is no connection offers a new try, with the reason it has", () => {
  for (const state of STATES.filter((s) => !["connecting", "connected", "too_old"].includes(s))) {
    const x = localExtra(entry({ state, detail: `why ${state}` }), NO_RESTART, "2.0.0", true);
    assert.deepEqual([x.again, x.reason, x.restart], ["start", `why ${state}`, false], state);
  }
});

test("localExtra: a server older than the app offers Restart server; so does one of another build", () => {
  assert.deepEqual(localExtra(entry({ state: "too_old", version: "0.9.1" }), NO_RESTART, "2.0.0", true), { ...NONE, restart: true });
  assert.deepEqual(localExtra(entry({ version: "1.0.0" }), NO_RESTART, "2.0.0", true), { ...NONE, line: "This computer's server runs another build (1.0.0)", restart: true });
});

test("localExtra: a restart that runs, and one that failed, come before the state", () => {
  assert.deepEqual(localExtra(entry({ state: "connecting" }), { phase: "restarting", why: "" }, "2.0.0", true), { ...NONE, line: RESTARTING });
  assert.deepEqual(localExtra(entry({ version: "1.0.0" }), { phase: "restarting", why: "" }, "2.0.0", true), { ...NONE, line: RESTARTING }, "no second Restart server");
  assert.deepEqual(localExtra(entry({ state: "not_started", detail: "x" }), { phase: "failed", why: "the server stopped while starting" }, "2.0.0", true),
    { line: RESTART_FAILED, reason: "the server stopped while starting", again: "restart", restart: false, log: true });
  assert.equal(localExtra(entry(), { phase: "failed", why: "x" }, "2.0.0", false).log, false);
});

test("localNotice: this computer's section has something to say", () => {
  const servers = (o: Partial<ServerView> = {}, more: ServerView[] = []) => [entry(o), ...more];
  assert.equal(localNotice({ servers: servers(), restart: NO_RESTART }, "2.0.0"), false);
  for (const state of STATES.filter((s) => s !== "connected")) assert.equal(localNotice({ servers: servers({ state }), restart: NO_RESTART }, "2.0.0"), true, state);
  assert.equal(localNotice({ servers: servers({ version: "1.0.0" }), restart: NO_RESTART }, "2.0.0"), true);
  assert.equal(localNotice({ servers: servers(), restart: { phase: "failed", why: "x" } }, "2.0.0"), true);
  assert.equal(localNotice({ servers: servers({}, [{ id: "s_aaaaaaaaaaaa", name: "Studio", state: "unreachable" }]), restart: NO_RESTART }, "2.0.0"), false);
  assert.equal(localOf([{ id: "s_aaaaaaaaaaaa", name: "Studio", state: "connected" }, entry()])?.id, "local");
});

test("sidebarEntries: this computer's entry first and always, then the others in the order of the list", () => {
  const a: ServerView = { id: "s_aaaaaaaaaaaa", name: "A", state: "connected" }, b: ServerView = { id: "s_bbbbbbbbbbbb", name: "B", state: "connected" };
  assert.deepEqual(sidebarEntries([LOCAL_ENTRY, a, b]).map((v) => v.id), ["local", a.id, b.id]);
  assert.deepEqual(sidebarEntries([b, LOCAL_ENTRY, a]).map((v) => v.id), ["local", b.id, a.id]);
  assert.deepEqual(sidebarEntries([a]).map((v) => v.id), ["local", a.id], "a list that does not name it");
  assert.deepEqual(sidebarEntries([]).map((v) => v.id), ["local"]);
});

test("sectionView of this computer: the same head and words as any section; the lines of a server too old are its own", () => {
  for (const state of STATES) {
    const l = sectionView({ state, local: true }, false, false), r = sectionView({ state }, false, false);
    assert.equal(l.state, r.state, state);
    assert.equal(l.tone, r.tone, state);
    assert.equal(l.add, false, state);
  }
  assert.equal(sectionView({ state: "not_started", local: true }, false, false).state, stateLabel("not_started"));
  assert.deepEqual(sectionView({ state: "too_old", version: "0.9", local: true }, false, false).lines, [LOCAL_TOO_OLD, "Version 0.9"]);
  assert.deepEqual(sectionView({ state: "too_old", version: "0.9" }, false, false).lines, ["Update the server on that machine.", "Version 0.9"]);
  assert.equal(sectionView({ state: "connected", local: true }, true, false).add, true);
});
