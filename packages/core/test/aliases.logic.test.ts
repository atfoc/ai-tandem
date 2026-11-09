// The words and rules of the Claude accounts' screens (src/logic/aliases.ts): the host row, the chips and the line of an
// account in each state, the pending line, the buttons, the folder rule (under, not merely a prefix), the banner of a chat on
// an account (D8: the applied mounts while a restart waits), the dialogs, the picker's rows (D3: the usable list decides,
// the reason of a greyed one), the sheet's own refusals, its note, the sections per server (D28) and the login row.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setAliasNames } from "../src/agents.ts";
import type { Alias, AliasList, DockerState } from "../src/aliasesapi.ts";
import {
  ACTION_WORDS, ADD_ACCOUNT_HINT, HOST_ROW, IMAGE_HINT, LOGIN_WORDS, MOUNT_HINT, NEW_FOLDER_CHIP, accountLine, accountSections, aliasNamesOf, cleanMounts,
  containerChips, containerNote, dockerWords, folderCount, folderPending, isUnder, loggedIn, loginChip, loginKey, loginView, mountBanner, mountedIn,
  pendingLine, pickerRows, removeDialog, restartDialog, rowActions, sheetProblem, stopDialog,
} from "../src/logic/aliases.ts";

afterEach(() => setAliasNames({}));

const OK: DockerState = { ok: true };
const DOWN: DockerState = { ok: false, kind: "not_running", reason: "Docker is not running" };
const SHOP = "/Users/demo/projects/shop", NOTES = "/Users/demo/notes", SCRATCH = "/Users/demo/projects/scratch", EMPTY = "/Users/demo/projects/empty-repo";

function alias(id: string, o: Partial<Alias> = {}): Alias {
  return { id, name: `Claude · ${id}`, mounts: [], created: "2026-11-01T00:00:00Z", kind: `claude:${id}`, login: { known: true, loggedIn: false },
    container: { name: `aiwb-alias-${id}`, state: "stopped" }, restartNeeded: false, pending: [], busy: 0, ...o };
}
const work = alias("a_work0001", { name: "Claude · Work", login: { known: true, loggedIn: true, email: "work@example.com" }, container: { name: "aiwb-alias-a_work0001", state: "running" },
  mounts: [SHOP], applied: { image: "aiwb/claude:dev", mounts: [SHOP] } });
const pers = alias("a_pers0001", { name: "Claude · Personal", mounts: [NOTES], applied: { image: "aiwb/claude:dev", mounts: [NOTES] } });
const client = alias("a_clnt0001", { name: "Claude · Client", login: { known: true, loggedIn: true, email: "client@example.com" }, container: { name: "aiwb-alias-a_clnt0001", state: "running" },
  mounts: [SCRATCH, EMPTY], applied: { image: "aiwb/claude:dev", mounts: [SCRATCH] }, restartNeeded: true, pending: [EMPTY], busy: 2 });
const lab = alias("a_lab00001", { name: "Claude · Lab", container: { name: "aiwb-alias-a_lab00001", state: "docker_unavailable", reason: "Docker is not running" } });
const list = (aliases: Alias[], docker: DockerState = OK): AliasList => ({ docker, defaultImage: "aiwb/claude:dev", host: { known: true, loggedIn: true, email: "demo@example.com" }, aliases });

test("the host row and the hints say what the goal says", () => {
  assert.deepEqual(HOST_ROW, { name: "Claude (this computer)", badge: "Default", line: "Host login (~/.claude) · no container" });
  assert.equal(ADD_ACCOUNT_HINT, "Each account is its own Claude login in its own Docker container.");
  assert.equal(MOUNT_HINT, "Each folder is mounted at the same path inside the container.");
  assert.equal(IMAGE_HINT, "Empty = the default image. Folder or image changes apply on a container restart.");
  assert.equal(NEW_FOLDER_CHIP, "New · needs restart");
  assert.deepEqual(LOGIN_WORDS, { opened: "⟳ Opened your browser", prompt: "Sign in there, then paste the code it shows:", submit: "Submit", again: "Open link again", retry: "Log in again", cancel: "Cancel", preparing: "Preparing the account's container…" });
  assert.equal(ACTION_WORDS.stop, "Stop container");
});

test("the login chip: logged in with the email; not logged in, also when Claude was never asked (D22)", () => {
  assert.deepEqual(loginChip({ known: true, loggedIn: true, email: "a@b.c" }), { text: "Logged in as a@b.c", tone: "ok" });
  assert.deepEqual(loginChip({ known: true, loggedIn: false }), { text: "Not logged in", tone: "muted" });
  assert.deepEqual(loginChip({ known: false, loggedIn: true, email: "a@b.c" }), { text: "Not logged in", tone: "muted" });
  assert.deepEqual(loginChip({ known: false, loggedIn: false, error: "claude: not found" }), { text: "Not logged in", tone: "muted", title: "claude: not found" });
  assert.ok(loggedIn(work.login) && !loggedIn(pers.login) && !loggedIn(undefined));
});

test("Docker's words", () => {
  assert.equal(dockerWords(DOWN), "Docker not running");
  assert.equal(dockerWords({ ok: false, kind: "not_installed", reason: "docker: not found" }), "Docker is not installed");
  assert.equal(dockerWords({ ok: false, kind: "unsupported", reason: "Claude accounts need a macOS or Linux server" }), "Claude accounts need a macOS or Linux server");
  assert.equal(dockerWords({ ok: false, kind: "failed" }), "Docker cannot be used");
});

test("the container chips of each state, and Restart needed after them", () => {
  const ids = (a: Alias, d = OK) => containerChips(a, d).map((c) => [c.id, c.text, c.tone]);
  assert.deepEqual(ids(work), [["running", "● Running", "ok"]]);
  assert.deepEqual(ids(pers), [["stopped", "○ Stopped", "muted"]]);
  assert.deepEqual(ids(alias("a_none0001", { container: { name: "x", state: "none" } })), [["stopped", "○ Stopped", "muted"]]);
  assert.deepEqual(ids(lab, DOWN), [["docker", "Docker not running", "warn"]]);
  assert.deepEqual(ids(work, DOWN), [["docker", "Docker not running", "warn"]], "Docker down: every container says so");
  assert.deepEqual(ids(alias("a_x0000001", { container: { name: "x", state: "docker_unavailable", reason: "Docker is slow" } })), [["docker", "Docker is slow", "warn"]]);
  assert.deepEqual(ids(alias("a_x0000001", { container: { name: "x", state: "preparing" } })), [["preparing", "Preparing the account's container…", "muted"]]);
  assert.deepEqual(ids(alias("a_x0000001", { container: { name: "x", state: "error", reason: "Mounts denied: /Users/demo/notes is not shared" } })),
    [["error", "Mounts denied: /Users/demo/notes is not shared", "danger"]]);
  assert.deepEqual(ids(client), [["running", "● Running", "ok"], ["restart", "⟳ Restart needed", "warn"]]);
});

test("the line: the container, the folders mounted (the applied ones while a restart waits), and Docker to start", () => {
  assert.equal(folderCount(1), "1 folder");
  assert.equal(folderCount(0), "0 folders");
  assert.equal(accountLine(work, OK), "aiwb-alias-a_work0001 · 1 folder mounted");
  assert.equal(accountLine(client, OK), "aiwb-alias-a_clnt0001 · 1 folder mounted");
  assert.equal(accountLine({ ...client, restartNeeded: false }, OK), "aiwb-alias-a_clnt0001 · 2 folders mounted");
  assert.equal(accountLine(lab, DOWN), "aiwb-alias-a_lab00001 · 0 folders mounted · start Docker to use it");
  assert.equal(accountLine(lab, { ok: false, kind: "not_installed" }), "aiwb-alias-a_lab00001 · 0 folders mounted");
});

test("the pending line", () => {
  assert.equal(pendingLine(client), `1 folder waiting: ${EMPTY}`);
  assert.equal(pendingLine({ ...client, pending: [EMPTY, NOTES] }), `2 folders waiting: ${EMPTY}, ${NOTES}`);
  assert.equal(pendingLine({ ...client, pending: [] }), "Changes wait for a restart");
  assert.equal(pendingLine(work), "");
  assert.ok(folderPending(client, EMPTY + "/") && !folderPending(client, SCRATCH) && !folderPending(undefined, EMPTY));
});

test("the buttons: Edit always, Log in when not logged in (not pressable while Docker is down), Stop while running, Restart when needed", () => {
  assert.deepEqual(rowActions(work, OK), { edit: true, login: false, logout: true, stop: true, restart: false });
  assert.deepEqual(rowActions(pers, OK), { edit: true, login: true, logout: false, stop: false, restart: false });
  assert.deepEqual(rowActions(lab, DOWN), { edit: true, login: true, loginDisabled: "Docker not running", logout: false, stop: false, restart: false });
  assert.deepEqual(rowActions(client, OK), { edit: true, login: false, logout: true, stop: true, restart: true });
});

test("a folder is under another only by whole names; trailing slashes do not count", () => {
  assert.ok(isUnder("/a/b", "/a/b"));
  assert.ok(isUnder("/a/b/c", "/a/b"));
  assert.ok(isUnder("/a/b/", "/a/b"));
  assert.ok(isUnder("/a/b", "/a/b///"));
  assert.ok(!isUnder("/a/bc", "/a/b"));
  assert.ok(!isUnder("/a", "/a/b"));
  assert.ok(isUnder("/anything", "/"));
  assert.ok(!isUnder("", "/a"));
  assert.ok(mountedIn(SHOP + "/web", [NOTES, SHOP]));
  assert.ok(!mountedIn(SHOP, []));
});

test("the banner: none for other kinds or with no list; removed; not mounted; the D8 rule while a restart waits", () => {
  const l = list([work, pers, client]);
  assert.equal(mountBanner(NOTES, "claude", l), null);
  assert.equal(mountBanner(NOTES, "claude:a_work0001", undefined), null);
  assert.deepEqual(mountBanner(SHOP, "claude:a_gone0001", l), { state: "removed", text: "This account was removed" });
  assert.equal(mountBanner(SHOP + "/docs", "claude:a_work0001", l), null);
  assert.deepEqual(mountBanner(NOTES, "claude:a_work0001", l), { state: "not_mounted", text: "This folder isn't mounted in Claude · Work — Add it in Settings", alias: work });
  // running and waiting for a restart: the applied mounts are what it has
  assert.equal(mountBanner(SCRATCH, "claude:a_clnt0001", l), null);
  assert.deepEqual(mountBanner(EMPTY, "claude:a_clnt0001", l), { state: "pending", text: "Restart Claude · Client to use this folder", alias: client });
  assert.equal(mountBanner(SHOP, "claude:a_clnt0001", l)?.state, "not_mounted");
  // stopped (or no restart needed): the saved ones, which its next start has
  const stopped = { ...client, restartNeeded: false, container: { ...client.container, state: "stopped" as const } };
  assert.equal(mountBanner(EMPTY, "claude:a_clnt0001", list([stopped])), null);
});

test("the dialogs name the agents working and what is lost", () => {
  assert.deepEqual(restartDialog("Claude · Client", 2), { title: "Restart Claude · Client?",
    body: "2 agents are working in this container. Restarting stops them; you can continue their chats after the restart.", cancel: "Later", ok: "Restart now" });
  assert.equal(restartDialog("W", 1).body, "1 agent is working in this container. Restarting stops them; you can continue their chats after the restart.");
  assert.deepEqual(stopDialog("W", 3), { title: "Stop W?", body: "3 agents are working in this container. Stopping stops them; you can continue their chats later.", cancel: "Cancel", ok: "Stop now" });
  assert.deepEqual(removeDialog("W", 0), { title: "Remove W?",
    body: "Its login, sessions and settings are deleted and its container is removed. Its chats stay readable but can no longer continue.", cancel: "Cancel", ok: "Remove account" });
  assert.equal(removeDialog("W", 1).body, "Its login, sessions and settings are deleted and its container is removed. Its chats stay readable but can no longer continue. 1 agent is working in it and will be stopped.");
});

test("the picker: the other agents first, then every account in the list's order, greyed with its reason unless usable (D3)", () => {
  setAliasNames({ "claude:a_work0001": "Claude · Work" });
  const usable = ["claude", "cursor", "pi", "claude:a_work0001", "claude:a_clnt0001"] as const;
  const rows = pickerRows([...usable], list([work, pers, client]));
  assert.deepEqual(rows.map((r) => r.kind), ["claude", "cursor", "pi", "claude:a_work0001", "claude:a_pers0001", "claude:a_clnt0001"]);
  assert.deepEqual(rows[0], { kind: "claude", label: "Claude Code", disabled: false });
  assert.deepEqual(rows[3], { kind: "claude:a_work0001", label: "Claude · Work", note: "work@example.com · in its own container", chip: { text: "● Running", tone: "ok" }, disabled: false });
  assert.deepEqual(rows[4], { kind: "claude:a_pers0001", label: "Claude · Personal", note: "in its own container", chip: { text: "○ Stopped", tone: "muted" }, disabled: true, reason: "Not logged in", action: "login" });
  assert.deepEqual(rows[5], { kind: "claude:a_clnt0001", label: "Claude · Client", note: "client@example.com · in its own container", chip: { text: "⟳ Restart needed", tone: "warn" },
    disabled: false, pending: `1 folder waiting: ${EMPTY}`, action: "restart" });
  // Docker down: the reason is Docker's; a logged-in one the server does not list: "Not available now"
  const down = pickerRows(["claude"], list([lab], DOWN));
  assert.deepEqual(down[1], { kind: "claude:a_lab00001", label: "Claude · Lab", note: "in its own container", chip: { text: "Docker not running", tone: "warn" }, disabled: true, reason: "Docker not running" });
  assert.equal(pickerRows(["claude"], list([work]))[1].reason, "Not available now");
  // no list (yet): the usable account kinds still show, by the registry's name
  assert.deepEqual(pickerRows([...usable], undefined).slice(3).map((r) => [r.label, r.disabled]), [["Claude · Work", false], ["Claude account", false]]);
});

test("the sheet's own refusals", () => {
  assert.equal(sheetProblem({ name: "  ", mounts: [] }), "An account needs a name");
  assert.equal(sheetProblem({ name: "W", mounts: [SHOP, SHOP + "/"] }), `${SHOP}/ is listed twice`);
  assert.equal(sheetProblem({ name: "W", mounts: ["projects/shop"] }), "projects/shop is not an absolute path");
  assert.equal(sheetProblem({ name: "W", mounts: [SHOP, SHOP + "/web", "  "] }), "", "a folder inside another is allowed; a blank one is left out");
  assert.deepEqual(cleanMounts([" /a ", "", "/b"]), ["/a", "/b"]);
});

test("the sheet's note names the container, or says when it is made", () => {
  assert.equal(containerNote(work), "Login and chats are kept in the app's folder (not ~/.claude). Container: aiwb-alias-a_work0001");
  assert.equal(containerNote(), "Login and chats are kept in the app's folder (not ~/.claude). Container: made when first needed");
});

test("the names of every list by kind, and one section per connected server that has accounts (D28)", () => {
  const lists = { local: list([work, pers]), s_lab: list([lab], DOWN) };
  assert.deepEqual(aliasNamesOf(lists), { "claude:a_work0001": "Claude · Work", "claude:a_pers0001": "Claude · Personal", "claude:a_lab00001": "Claude · Lab" });
  const servers = [{ id: "local", local: true, name: "This computer", state: "connected" }, { id: "s_off", name: "Office", state: "unreachable" }, { id: "s_lab", name: "Lab", state: "connected" }] as any;
  assert.deepEqual(accountSections(servers, lists).map((s) => [s.server, s.title]), [["local", "ACCOUNTS · This computer"], ["s_lab", "ACCOUNTS · Lab"]]);
  assert.deepEqual(accountSections(servers.slice(0, 1), lists).map((s) => [s.server, s.title]), [["local", "ACCOUNTS"]]);
  assert.deepEqual(accountSections([{ ...servers[2], state: "unreachable" }], lists), []);
});

test("the login row of each phase", () => {
  assert.equal(loginKey("local", "a_work0001"), "local/a_work0001");
  assert.equal(loginView(undefined), null);
  assert.deepEqual(loginView({ phase: "preparing" }), { line: "Preparing the account's container…", code: false, busy: true });
  assert.deepEqual(loginView({ phase: "waiting", url: "https://x" }), { line: "⟳ Opened your browser", prompt: "Sign in there, then paste the code it shows:", code: true, busy: false,
    again: { action: "link", label: "Open link again" } });
  assert.equal(loginView({ phase: "waiting", url: "https://x", error: "Invalid code, please try again" })?.error, "Invalid code, please try again");
  assert.deepEqual(loginView({ phase: "sending" }), { line: "⟳ Opened your browser", prompt: "Sign in there, then paste the code it shows:", code: true, busy: true,
    again: { action: "link", label: "Open link again" } });
  assert.equal(loginView({ phase: "failed", error: "Claude exited" })?.error, "Claude exited");
  assert.deepEqual(loginView({ phase: "starting" }), { line: "Starting the login…", code: false, busy: true }); // no button but Cancel while a call runs
});

test("loginView: a login Claude ended (a well-formed wrong code, none open) offers Log in again, no code field and no Open link again", () => {
  const wrong = "Login failed: That code wasn't accepted. Please try again.";
  assert.deepEqual(loginView({ phase: "failed", error: wrong }), { line: "The login did not finish", code: false, busy: false, error: wrong,
    again: { action: "login", label: "Log in again" } });
  assert.deepEqual(loginView({ phase: "failed", error: "No login is open for this account; start it again" })?.again, { action: "login", label: LOGIN_WORDS.retry });
  assert.equal(loginView({ phase: "failed" })?.error, "The login failed");
  assert.equal(LOGIN_WORDS.retry, "Log in again");
});

test("why a chat on an account the server does not list as usable cannot use it: the picker's reason, never \"not installed\"", async () => {
  const { accountReason } = await import("../src/logic/aliases.ts");
  const { accountMissing, agentChoice, agentLine } = await import("../src/logic/agentlist.ts");
  const { toolbarLine, agentChoiceOn } = await import("../src/logic/chatserver.ts");
  setAliasNames({ "claude:a_pers0001": "Claude · Personal", "claude:a_lab00001": "Claude · Lab", "claude:a_work0001": "Claude · Work" });
  const here = list([work, pers, client]);
  assert.equal(accountReason("claude:a_pers0001", here), "Not logged in");
  assert.equal(accountReason("claude:a_lab00001", list([lab], DOWN)), "Docker not running");
  assert.equal(accountReason("claude:a_work0001", list([work], { ok: false, kind: "not_installed", reason: "" })), "Docker is not installed");
  assert.equal(accountReason("claude:a_gone0001", here), "This account was removed");
  assert.equal(accountReason("claude:a_work0001", here), "Not available now", "logged in, Docker fine, still not usable");
  assert.equal(accountReason("claude", here), "");
  assert.equal(accountReason("claude:a_gone0001", undefined), "", "no list: nothing is known");
  assert.equal(accountMissing("claude:a_pers0001", here), "Claude · Personal: Not logged in");
  assert.equal(accountMissing("claude:a_gone0001", here), "This account was removed");
  assert.equal(accountMissing("claude:a_gone0001", undefined), "Claude account: Not available now");
  const usable = ["claude", "cursor", "pi", "claude:a_work0001"] as const;
  assert.deepEqual(agentChoice([...usable], "claude:a_pers0001", here), { options: [...usable], current: "claude:a_pers0001", missing: true, reason: "Claude · Personal: Not logged in" });
  assert.equal(agentChoice([...usable], "claude:a_work0001", here).reason, "", "a usable account says nothing");
  assert.equal(agentLine([...usable], "claude:a_lab00001", list([lab], DOWN)), "Claude · Lab: Docker not running");
  assert.equal(agentLine([...usable], "pi" as any, here), "", "the others as before");
  const local = { server: "local", name: "This computer", connected: true }, remote = { server: "s_lab", name: "Lab box", connected: true };
  assert.deepEqual(toolbarLine(local, [...usable], { agent: "claude:a_pers0001" }, false, here), { text: "Claude · Personal: Not logged in", tone: "missing" });
  assert.equal(agentChoiceOn(remote, ["claude"], "claude:a_lab00001", list([lab], DOWN)).reason, "Claude · Lab: Docker not running", "another server's account says its own reason too");
  assert.equal(agentChoiceOn(remote, ["claude"], "cursor").reason, "Cursor is not installed on Lab box: install it there, or choose another agent.");
  for (const k of ["claude:a_pers0001", "claude:a_gone0001", "claude:a_lab00001"]) assert.doesNotMatch(agentLine([...usable], k as any, here), /not installed/);
});
