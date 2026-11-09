// The words and rules of the Claude accounts' screens (multiple-claude goal §1.1–§1.7): Settings › Claude accounts (the
// host row, one row per account with its chips, its line and its buttons), the add/edit sheet (its hints, its client-side
// refusals, the note on where the login is kept, the chip of a folder that waits for a restart), the login row, the
// restart/stop/remove dialogs, the Agent picker's rows (an account greyed with its reason) and the banner of a chat whose
// folder is not mounted in its account's container. Every sentence the screens show is here, so a screen only draws it.
//
// The server is the authority (plan D3, D8, D9, D22): the usable list says which accounts can be picked, the list says each
// account's login, container, restart-needed and pending folders, and a message is refused by the server whatever the
// app shows. What is decided here only mirrors those rules for what is drawn; the refusals of the server are shown as they
// come (their sentences are the Go ones, internal/aliases/errors.go, mirrored below for the banner).
//
// Also the types of what the state keeps of the accounts beside the lists (a login under way, the request to open the
// accounts screen): state/store.ts holds them, state/aliases.ts changes them. Pure: no React, no store, so Node loads it.
import { agentName, isAliasKind } from "../agents.ts";
import type { AgentKind } from "../types.ts";
import type { Alias, AliasList, AliasLogin, DockerState } from "../aliasesapi.ts";
import type { ServerView } from "./servers.ts";

// ---- what the state keeps

/** A login under way of one account (store `aliasLogins`, by loginKey). starting: the call that starts it runs; preparing:
 *  the account's container is being made ready, the login is asked again once it runs; waiting: the URL was opened, a code is
 *  awaited (error: the last code was refused, or the last call failed); sending: a code is on its way; failed: the login
 *  ended without one (error says why: Claude ends it on a well-formed wrong code, and a new login is started for another try). The URL lives only here: it is never logged or put anywhere else. */
export type LoginFlow = { phase: "starting" | "preparing" | "waiting" | "sending" | "failed"; url?: string; error?: string };

/** The request to show Settings › Claude accounts (store `accountsNav`): the server's section, and in it the account `id`
 *  (its sheet), or the add sheet (`add`), with a folder put in the sheet's list (`prefill`: the banner's "Add it in Settings"),
 *  or the account's login started (`login`: the picker's "Log in…"). seq grows with every request, so the same one twice
 *  is seen twice. */
export type AccountsNav = { server: string; id?: string; add?: boolean; prefill?: string; login?: boolean; seq: number };

/** The key of an account's login in the store: the server's entry id and the account's id. */
export const loginKey = (server: string, id: string) => `${server}/${id}`;

// ---- small words

/** The colour of a chip: ok green, muted grey, warn amber, danger red. */
export type ChipTone = "ok" | "muted" | "warn" | "danger";

export type Chip = { text: string; tone: ChipTone; title?: string };

/** The first row of every section: the computer's own Claude Code (it is never edited, logged in or out, or removed here). */
export const HOST_ROW = { name: "Claude (this computer)", badge: "Default", line: "Host login (~/.claude) · no container" } as const;

/** Under "+ Add account". */
export const ADD_ACCOUNT_HINT = "Each account is its own Claude login in its own Docker container.";
/** Under the sheet's list of folders. */
export const MOUNT_HINT = "Each folder is mounted at the same path inside the container.";
/** Under the sheet's Image field (Advanced). */
export const IMAGE_HINT = "Empty = the default image. Folder or image changes apply on a container restart.";
/** The chip of a saved folder the running container lacks (the account's `pending`). */
export const NEW_FOLDER_CHIP = "New · needs restart";
/** The words of the login row. */
export const LOGIN_WORDS = {
  opened: "⟳ Opened your browser",
  prompt: "Sign in there, then paste the code it shows:",
  submit: "Submit",
  again: "Open link again",
  retry: "Log in again",
  cancel: "Cancel",
  preparing: "Preparing the account's container…",
} as const;
/** The labels of an account's buttons. */
export const ACTION_WORDS = { add: "+ Add account", edit: "Edit", login: "Log in", loginPicker: "Log in…", logout: "Log out", stop: "Stop container",
  restart: "Restart container", remove: "Remove account", addFolder: "+ Add folder", advanced: "▾ Advanced", save: "Save", cancel: "Cancel" } as const;
/** The titles of the screen and the sheet. */
export const SCREEN_WORDS = { settingsRow: "Claude accounts", title: "Claude accounts", section: "ACCOUNTS", addTitle: "Add account", editTitle: "Edit account",
  name: "Name", namePlaceholder: "Claude · Work", folders: "Folders to mount", image: "Image" } as const;

/** "1 folder", "3 folders". */
export const folderCount = (n: number) => (n === 1 ? "1 folder" : `${n} folders`);

/** "1 agent is", "3 agents are": the start of a dialog's sentence about the agents working in a container. */
const agentsWorking = (n: number) => (n === 1 ? "1 agent is" : `${n} agents are`);

/** Whether a login counts as logged in: Claude said so (one that was never asked, known false, does not: D22). */
export const loggedIn = (l: AliasLogin | undefined) => !!l?.known && !!l.loggedIn;

/** The login chip: "Logged in as <email>" (ok) or "Not logged in" (muted). title: why Claude could not be asked, when it could not. */
export function loginChip(l: AliasLogin): Chip {
  const title = l.error ? { title: l.error } : {};
  if (loggedIn(l)) return { text: l.email ? `Logged in as ${l.email}` : "Logged in", tone: "ok", ...title };
  return { text: "Not logged in", tone: "muted", ...title };
}

/** Why Docker cannot be used, as a chip and a greyed row say it. */
export function dockerWords(d: DockerState): string {
  if (d.kind === "not_running") return "Docker not running";
  if (d.kind === "not_installed") return "Docker is not installed";
  return d.reason || "Docker cannot be used";
}

/** Whether the account's container can be used now: Docker is, and the account's container is not one Docker cannot reach. */
export const dockerUsable = (a: Alias, docker: DockerState) => docker.ok && a.container.state !== "docker_unavailable";

/** The Docker words of an account whose container cannot be reached: the server's Docker state, or the container's own reason. */
const dockerWordsOf = (a: Alias, docker: DockerState) => (docker.ok ? dockerWords({ ok: false, reason: a.container.reason }) : dockerWords(docker));

export type ContainerChip = Chip & { id: "running" | "stopped" | "docker" | "preparing" | "error" | "restart" };

/** The container chips of an account, in the order drawn: its state, and "⟳ Restart needed" after it when saved changes wait. */
export function containerChips(a: Alias, docker: DockerState): ContainerChip[] {
  const out: ContainerChip[] = [];
  const st = a.container.state;
  if (!dockerUsable(a, docker)) out.push({ id: "docker", text: dockerWordsOf(a, docker), tone: "warn" });
  else if (st === "running") out.push({ id: "running", text: "● Running", tone: "ok" });
  else if (st === "preparing") out.push({ id: "preparing", text: LOGIN_WORDS.preparing, tone: "muted" });
  else if (st === "error") out.push({ id: "error", text: a.container.reason || "The container failed", tone: "danger" });
  else out.push({ id: "stopped", text: "○ Stopped", tone: "muted" });
  if (a.restartNeeded) out.push({ id: "restart", text: "⟳ Restart needed", tone: "warn" });
  return out;
}

/** The row's line: "<container name> · N folder(s) mounted", and " · start Docker to use it" while Docker is not running. The
 *  folders counted are those the running container has while a restart is needed, else the saved ones. */
export function accountLine(a: Alias, docker: DockerState): string {
  const n = a.restartNeeded ? (a.applied?.mounts.length ?? 0) : a.mounts.length;
  return `${a.container.name} · ${folderCount(n)} mounted${!docker.ok && docker.kind === "not_running" ? " · start Docker to use it" : ""}`;
}

/** What waits for a restart: "N folder(s) waiting: <paths>" or "Changes wait for a restart"; "" when nothing does. */
export function pendingLine(a: Alias): string {
  if (!a.restartNeeded) return "";
  return a.pending.length ? `${folderCount(a.pending.length)} waiting: ${a.pending.join(", ")}` : "Changes wait for a restart";
}

/** The buttons of an account's row (and sheet). loginDisabled: why Log in cannot be pressed now (Docker cannot be used). */
export type RowActions = { edit: true; login: boolean; loginDisabled?: string; logout: boolean; stop: boolean; restart: boolean };

export function rowActions(a: Alias, docker: DockerState): RowActions {
  const inn = loggedIn(a.login);
  return { edit: true, login: !inn, ...(!inn && !dockerUsable(a, docker) ? { loginDisabled: dockerWordsOf(a, docker) } : {}),
    logout: inn, stop: a.container.state === "running", restart: a.restartNeeded };
}

// ---- folders

/** A folder as compared: without its trailing slashes ("/" stays "/"). */
export const normFolder = (p: string) => { const t = p.trim(); return t.length > 1 ? t.replace(/\/+$/, "") || "/" : t; };

/** Whether folder is root or a folder under it ("/a/bc" is not under "/a/b"; trailing slashes do not count). */
export function isUnder(folder: string, root: string): boolean {
  const f = normFolder(folder), r = normFolder(root);
  if (!f || !r) return false;
  return r === "/" ? f.startsWith("/") : f === r || f.startsWith(r + "/");
}

/** Whether folder is one of mounts or under one of them. */
export const mountedIn = (folder: string, mounts: readonly string[]) => mounts.some((m) => isUnder(folder, m));

/** Whether a saved folder of the account waits for a restart (its chip says NEW_FOLDER_CHIP). */
export const folderPending = (a: Alias | undefined, folder: string) => !!a?.pending.some((p) => normFolder(p) === normFolder(folder));

/** The folders of the sheet as they are sent: trimmed, the blank ones left out. */
export const cleanMounts = (mounts: readonly string[]) => mounts.map((m) => m.trim()).filter(Boolean);

/** What the sheet refuses before it is sent: a blank name, a folder that is no absolute path, a folder listed twice; "" when
 *  fine. Blank folders are left out (cleanMounts). The server checks the rest (a folder that does not exist, …) and its
 *  sentence is shown as it comes. */
export function sheetProblem(input: { name: string; mounts: readonly string[] }): string {
  if (!input.name.trim()) return "An account needs a name";
  const seen = new Set<string>();
  for (const m of cleanMounts(input.mounts)) {
    if (!m.startsWith("/")) return `${m} is not an absolute path`;
    const k = normFolder(m);
    if (seen.has(k)) return `${m} is listed twice`;
    seen.add(k);
  }
  return "";
}

/** The sheet's note on where the account's things are kept. a: the account edited; none for a new one. */
export const containerNote = (a?: Alias) =>
  `Login and chats are kept in the app's folder (not ~/.claude). Container: ${a ? a.container.name : "made when first needed"}`;

// ---- the list

/** The account of kind in list, if it has it. */
export const accountOf = (list: AliasList | undefined, kind: AgentKind | string) => list?.aliases.find((a) => a.kind === kind);

/** The names of the accounts of every list, by kind (agents.ts setAliasNames). */
export function aliasNamesOf(lists: Record<string, AliasList>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of Object.values(lists)) for (const a of l.aliases) out[a.kind] = a.name;
  return out;
}

/** One ACCOUNTS section of the screen: a connected server of the list that has accounts (D28), in the order of the server
 *  list. title: "ACCOUNTS", with the server's name after it when there are several. */
export type AccountSection = { server: string; name: string; title: string; list: AliasList };

export function accountSections(servers: readonly ServerView[], lists: Record<string, AliasList>): AccountSection[] {
  const shown = servers.filter((v) => lists[v.id] && v.state === "connected");
  return shown.map((v) => ({ server: v.id, name: v.name, title: shown.length > 1 ? `${SCREEN_WORDS.section} · ${v.name}` : SCREEN_WORDS.section, list: lists[v.id] }));
}

// ---- the banner of a chat on an account

/** The sentence of a chat on an account that was removed (aliases.ErrRemoved). */
export const REMOVED_ACCOUNT = "This account was removed";
/** A folder not mounted in the account's container (aliases.MountError). */
export const notMountedWords = (name: string) => `This folder isn't mounted in ${name} — Add it in Settings`;
/** A folder saved for the account that its running container lacks (aliases.MountError, Pending). */
export const pendingMountWords = (name: string) => `Restart ${name} to use this folder`;

export type MountBanner = { state: "not_mounted" | "pending" | "removed"; text: string; alias?: Alias };

/** The banner of a chat on an account whose folder cwd its container cannot reach (the UI puts "⚠ " before the text), or
 *  null: for a kind that is no account's, and for a server whose list the page does not have. The rule is the server's (D8):
 *  a running container that waits for a restart has the mounts it was made with (a folder only in the saved ones waits for
 *  the restart); otherwise the saved ones are what the next start makes it with. */
export function mountBanner(cwd: string, kind: AgentKind | string, list: AliasList | undefined): MountBanner | null {
  if (!isAliasKind(kind) || !list) return null;
  const a = accountOf(list, kind);
  if (!a) return { state: "removed", text: REMOVED_ACCOUNT };
  if (a.container.state === "running" && a.restartNeeded && a.applied) {
    if (mountedIn(cwd, a.applied.mounts)) return null;
    if (mountedIn(cwd, a.mounts)) return { state: "pending", text: pendingMountWords(a.name), alias: a };
    return { state: "not_mounted", text: notMountedWords(a.name), alias: a };
  }
  return mountedIn(cwd, a.mounts) ? null : { state: "not_mounted", text: notMountedWords(a.name), alias: a };
}

// ---- dialogs

export type Dialog = { title: string; body: string; cancel: string; ok: string };

/** Asked before a restart while agents work in the container (busy > 0). */
export const restartDialog = (name: string, busy: number): Dialog => ({
  title: `Restart ${name}?`,
  body: `${agentsWorking(busy)} working in this container. Restarting stops them; you can continue their chats after the restart.`,
  cancel: "Later", ok: "Restart now",
});

/** Asked before a stop while agents work in the container (busy > 0). */
export const stopDialog = (name: string, busy: number): Dialog => ({
  title: `Stop ${name}?`,
  body: `${agentsWorking(busy)} working in this container. Stopping stops them; you can continue their chats later.`,
  cancel: "Cancel", ok: "Stop now",
});

/** Asked before every removal (goal §4.3), naming what is lost. */
export const removeDialog = (name: string, busy: number): Dialog => ({
  title: `Remove ${name}?`,
  body: "Its login, sessions and settings are deleted and its container is removed. Its chats stay readable but can no longer continue."
    + (busy > 0 ? ` ${agentsWorking(busy)} working in it and will be stopped.` : ""),
  cancel: "Cancel", ok: "Remove account",
});

// ---- the Agent picker

/** A row of the Agent picker. disabled: it cannot be picked now (reason says why; action: what its button does, "login"
 *  "Log in…", "restart" "Restart container"). pending: the pendingLine of a usable account that waits for a restart. */
export type PickerRow = { kind: AgentKind; label: string; note?: string; chip?: Chip; disabled: boolean; reason?: string; action?: "login" | "restart"; pending?: string };

/** The Agent picker's rows: the usable kinds that are no account's, in their order, then every account of the list in its
 *  order (an account the server does not list as usable is greyed, with why: D3), then any usable account kind the list
 *  lacks (a list not arrived yet). */
export function pickerRows(usable: readonly AgentKind[], list: AliasList | undefined): PickerRow[] {
  const rows: PickerRow[] = usable.filter((k) => !isAliasKind(k)).map((k) => ({ kind: k, label: agentName(k), disabled: false }));
  const listed = new Set<string>();
  for (const a of list?.aliases ?? []) {
    listed.add(a.kind);
    const email = loggedIn(a.login) ? a.login.email : undefined;
    const chips = containerChips(a, list!.docker);
    const { id: _, ...chip } = chips[0];
    const row: PickerRow = { kind: a.kind, label: a.name, note: email ? `${email} · in its own container` : "in its own container", chip, disabled: false };
    if (!usable.includes(a.kind)) Object.assign(row, { disabled: true }, unusable(a, list!.docker));
    else if (a.restartNeeded) {
      const { id: _r, ...restart } = chips.find((c) => c.id === "restart")!;
      Object.assign(row, { chip: restart, pending: pendingLine(a), action: "restart" as const });
    }
    rows.push(row);
  }
  for (const k of usable) if (isAliasKind(k) && !listed.has(k)) rows.push({ kind: k, label: agentName(k), disabled: false });
  return rows;
}

/** Why an account the server does not list as usable cannot be used now (D3), and the button that helps: Docker's words, "Not
 *  logged in" (with "Log in…"), else "Not available now". */
function unusable(a: Alias, docker: DockerState): { reason: string; action?: "login" } {
  if (!dockerUsable(a, docker)) return { reason: dockerWordsOf(a, docker) };
  if (!loggedIn(a.login)) return { reason: NOT_LOGGED_IN, action: "login" };
  return { reason: NOT_AVAILABLE };
}

/** The picker's reason of an account that is not logged in. */
export const NOT_LOGGED_IN = "Not logged in";
/** The picker's reason of an account that cannot be used for no reason the list tells (the server does not list it as usable). */
export const NOT_AVAILABLE = "Not available now";

/** Why a chat on the Claude account `kind` cannot use it, when the server does not list it as usable: the picker's reason
 *  (Docker's words, "Not logged in", "Not available now"), or REMOVED_ACCOUNT for a kind the list lacks; "" for a kind that is no
 *  account's, and for a server whose list the page does not have. */
export function accountReason(kind: AgentKind | string, list: AliasList | undefined): string {
  if (!isAliasKind(kind) || !list) return "";
  const a = accountOf(list, kind);
  return a ? unusable(a, list.docker).reason : REMOVED_ACCOUNT;
}

// ---- the login row

/** What the login row of an account draws for its flow; null when no login is under way. busy: a call runs (the buttons
 *  wait); code: the code field and Submit are drawn; error: the last refusal, in red; again: the button beside Cancel, if any:
 *  "link" Open link again (the URL kept is opened again: waiting, sending), "login" Log in again (a new start of the login:
 *  failed, for the login Claude ended); label: its words. Cancel is always drawn. */
export type LoginView = { line: string; prompt?: string; code: boolean; busy: boolean; error?: string; again?: { action: "link" | "login"; label: string } };

const OPEN_AGAIN = { action: "link", label: LOGIN_WORDS.again } as const;
const LOG_IN_AGAIN = { action: "login", label: LOGIN_WORDS.retry } as const;

export function loginView(flow: LoginFlow | undefined): LoginView | null {
  if (!flow) return null;
  const error = flow.error ? { error: flow.error } : {};
  switch (flow.phase) {
    case "starting": return { line: "Starting the login…", code: false, busy: true };
    case "preparing": return { line: LOGIN_WORDS.preparing, code: false, busy: true };
    case "waiting": return { line: LOGIN_WORDS.opened, prompt: LOGIN_WORDS.prompt, code: true, busy: false, ...error, again: OPEN_AGAIN };
    case "sending": return { line: LOGIN_WORDS.opened, prompt: LOGIN_WORDS.prompt, code: true, busy: true, again: OPEN_AGAIN };
    case "failed": return { line: "The login did not finish", code: false, busy: false, error: flow.error || "The login failed", again: LOG_IN_AGAIN };
  }
}
