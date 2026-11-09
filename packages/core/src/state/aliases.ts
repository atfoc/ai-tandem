// The Claude accounts of each server in the store (multiple-claude goal §1.1–§1.6, plan §1 client API): the lists, the logins
// under way, and the request to show the accounts screen, with the actions the screens call. Each action names the server
// it is for by its entry id (LOCAL_SERVER for this computer: D28, accounts are per server); a refusal is the ApiError of
// api.ts, thrown again for the screen to show (`e.message` is the server's sentence).
//
// A list comes whole: in the server's snapshot and in an `aliases` event after every change (conn.ts calls applyAliases).
// An action's answer is put into the list at once as well (the event follows anyway, and replaces it). After every change
// of a list the names of the accounts are fed to agents.ts (setAliasNames), before the store tells its subscribers.
//
// A login (screen 3) is a flow per account (logic/aliases.ts LoginFlow): the call that starts it answers the URL to open
// (`waiting`), or that the container is being made ready (`preparing`: when a later list shows its container running, or 2 s
// later when the list shows it running already, the login is asked again, once at a time, and goes on as above), or that it is
// logged in, or that it failed. A code is sent while waiting; a malformed one leaves the flow waiting with Claude's error, a
// well-formed wrong one ends the login (failed: Log in again starts a new one). Cancel ends it on the server and drops it here
// even when that call fails. A list that shows the account logged in, or no longer has it, drops a flow that waits. The URL is
// kept in the flow alone, and opened through the function the screen gives (the platform's way to open a link on this device),
// once; a flow that ends without opening it calls that function's close (a web page's placeholder window goes).
import { setAliasNames } from "../agents.ts";
import { aliasesApi, type Alias, type AliasChange, type AliasInput, type AliasList, type LoginAnswer, type RestartOutcome } from "../aliasesapi.ts";
import { aliasNamesOf, loggedIn, loginKey, type AccountsNav, type LoginFlow } from "../logic/aliases.ts";
import { getState, setState } from "./store.ts";

// ---- the lists

/** A server's list arrived (its snapshot, an `aliases` event, a GET), or it has none (null: a snapshot without `aliases`, or
 *  the server left the list). The names are fed to agents.ts first; then the logins it settles are settled. */
export function applyAliases(server: string, list: AliasList | null | undefined) {
  const had = getState().aliases;
  if (!list && !(server in had)) return;
  const next = { ...had };
  if (list) next[server] = list; else delete next[server];
  setAliasNames(aliasNamesOf(next));
  setState({ aliases: next });
  settleLogins(server, list ?? null);
}

/** Puts one account, as an answer gave it, into its server's list (where its id is, or at the end). */
function putAlias(server: string, a: Alias | undefined) {
  const list = getState().aliases[server];
  if (!list || !a?.id) return;
  const at = list.aliases.findIndex((x) => x.id === a.id);
  const aliases = at < 0 ? [...list.aliases, a] : list.aliases.map((x, i) => (i === at ? a : x));
  applyAliases(server, { ...list, aliases });
}

/** Takes one account out of its server's list. */
function dropAlias(server: string, id: string) {
  const list = getState().aliases[server];
  if (list?.aliases.some((x) => x.id === id)) applyAliases(server, { ...list, aliases: list.aliases.filter((x) => x.id !== id) });
}

// ---- the actions

/** Reads the server's list again (the Settings screen calls it when it opens): it is put into the store, and answered. */
export async function refreshAccounts(server: string): Promise<AliasList> {
  const list = await aliasesApi.list(server);
  applyAliases(server, list);
  return list;
}

/** What a save answers: the account as saved and, for an edit, what was done about its container (restart: done, deferred,
 *  busy with the count of agents working in it, or unchanged). An add starts nothing: it has no restart. */
export type SaveResult = { alias: Alias; restart?: RestartOutcome; busy?: number };

/** Adds an account (id undefined; input.name is required) or edits one (a field left out keeps its value). On `busy` nothing
 *  was done to the container: ask the person (logic/aliases.ts restartDialog), then restartAccount(…, true) or leave it pending. */
export async function saveAccount(server: string, id: string | undefined, input: AliasInput): Promise<SaveResult> {
  if (id === undefined) {
    const alias = await aliasesApi.add(server, { ...input, name: input.name ?? "" });
    putAlias(server, alias);
    return { alias };
  }
  const change = await aliasesApi.edit(server, id, input);
  putAlias(server, change.alias);
  return change;
}

/** Recreates the account's container with its saved folders and image. Without force, agents working in it make it answer
 *  `busy` with their count and do nothing (restartDialog asks the person; their yes calls it again with force). */
export async function restartAccount(server: string, id: string, force = false): Promise<AliasChange> {
  const change = await aliasesApi.restart(server, id, force);
  putAlias(server, change.alias);
  return change;
}

/** Stops the account's container; `busy` as restartAccount (stopDialog). */
export async function stopAccount(server: string, id: string, force = false): Promise<AliasChange> {
  const change = await aliasesApi.stop(server, id, force);
  putAlias(server, change.alias);
  return change;
}

/** Removes the account (after removeDialog): its container, its login, sessions and settings. Its chats stay, read-only. */
export async function removeAccount(server: string, id: string): Promise<void> {
  await aliasesApi.remove(server, id);
  forget(server, id);
  dropAlias(server, id);
}

/** Logs the account out (its own folder only; the computer's ~/.claude and the other accounts are never touched). */
export async function logoutAccount(server: string, id: string): Promise<Alias> {
  const alias = await aliasesApi.logout(server, id);
  putAlias(server, alias);
  return alias;
}

// ---- the login

/** Opens a URL on this device (the platform's way: a browser tab, Linking.openURL). close, if given: what the flow calls when it
 *  ends or settles without opening the URL (logged in, failed, refused, cancelled, the account gone), so that what the platform
 *  readied for it on the press (a web page's placeholder window) goes; never once the URL was opened. */
export type OpenURL = ((url: string) => void) & { close?: () => void };

/** The wait before a login that answered `preparing` is asked again when its container runs already (the server answers so too
 *  when the URL took longer than its own wait, and then no further list may come). A field, so that a test can shorten it. */
export const loginWaits = { reaskMs: 2000 };

/** How a flow that has not opened its URL yet will open it: the function the screen gave, whether a repeat of the call runs
 *  (asking), and the timer of the repeat that waits, if any. */
type Opener = { open: OpenURL; asking: boolean; timer?: ReturnType<typeof setTimeout> };

/** By loginKey: the turn of each flow (an answer of an older one is not applied), and how a flow opens its URL until it has. */
const turns = new Map<string, number>();
const openers = new Map<string, Opener>();
let turn = 0;

const flowOf = (k: string): LoginFlow | undefined => getState().aliasLogins[k];
function setFlow(k: string, f: LoginFlow | null) {
  const had = getState().aliasLogins;
  if (!f && !(k in had)) return;
  const next = { ...had };
  if (f) next[k] = f; else delete next[k];
  setState({ aliasLogins: next });
}
/** The flow will not open its URL: what was readied for it goes (close), and its repeat that waits. */
function dropOpener(k: string) {
  const o = openers.get(k);
  if (!o) return;
  openers.delete(k);
  if (o.timer !== undefined) clearTimeout(o.timer);
  o.open.close?.();
}
/** The flow opens its URL now: its opener is spent (and not closed). */
function takeOpener(k: string): OpenURL | undefined {
  const o = openers.get(k);
  if (!o) return undefined;
  openers.delete(k);
  if (o.timer !== undefined) clearTimeout(o.timer);
  return o.open;
}
/** Ends what this module keeps of a flow, and the flow. */
function forget(server: string, id: string) {
  const k = loginKey(server, id);
  turns.delete(k); dropOpener(k);
  setFlow(k, null);
}
/** The flow ended without its URL: failed, with why. */
function fail(k: string, error: string) {
  dropOpener(k);
  setFlow(k, { phase: "failed", error });
}

/** What a login's start (or its repeat after `preparing`) answered, for the flow of turn t. */
function onStart(server: string, id: string, t: number, ans: LoginAnswer) {
  const k = loginKey(server, id);
  if (turns.get(k) !== t) return; // cancelled, or started again, meanwhile
  switch (ans.state) {
    case "waiting": {
      const open = ans.url ? takeOpener(k) : (dropOpener(k), undefined);
      setFlow(k, { phase: "waiting", ...(ans.url ? { url: ans.url } : {}), ...(ans.error ? { error: ans.error } : {}) });
      if (ans.url) open?.(ans.url);
      return;
    }
    case "preparing": {
      setFlow(k, { phase: "preparing" });
      const o = openers.get(k);
      if (!o) return;
      o.asking = false;
      // The container may run already (the URL took longer than the server's wait): no list may come to settle it, so it is asked
      // again after a short wait. A later list that shows it running asks too (settleLogins); the first one does it.
      const a = getState().aliases[server]?.aliases.find((x) => x.id === id);
      if (a?.container.state === "running" && o.timer === undefined) {
        o.timer = setTimeout(() => {
          o.timer = undefined;
          if (turns.get(k) === t && openers.get(k) === o && flowOf(k)?.phase === "preparing") reask(server, id, t);
        }, loginWaits.reaskMs);
      }
      return;
    }
    case "logged_in": forget(server, id); return;
    default: fail(k, ans.error || "The login failed");
  }
}

/** Asks again for the login of turn t, which prepares, unless a repeat runs already: its answer goes to onStart as the first one. */
function reask(server: string, id: string, t: number) {
  const k = loginKey(server, id), o = openers.get(k);
  if (!o || o.asking) return;
  o.asking = true;
  if (o.timer !== undefined) { clearTimeout(o.timer); o.timer = undefined; }
  void askLogin(server, id, t).catch(() => {}); // (a refusal fails the flow, which says it)
}

/** Asks the server for the login of turn t: its answer goes to onStart; a refusal fails the flow and is thrown. */
async function askLogin(server: string, id: string, t: number) {
  const k = loginKey(server, id);
  let ans: LoginAnswer;
  try { ans = await aliasesApi.login(server, id); } catch (e) {
    if (turns.get(k) === t) fail(k, (e as Error)?.message || "The login failed");
    throw e;
  }
  onStart(server, id, t, ans);
}

/** Starts the account's login (Log in, and Log in again after a login Claude ended): the container is started if needed and
 *  Claude's own login runs in it. The URL it answers is opened with open (once); a login that runs already is joined. A flow
 *  that ends without opening it calls open.close. */
export async function startLogin(server: string, id: string, open: OpenURL): Promise<void> {
  const k = loginKey(server, id), t = ++turn;
  dropOpener(k); // (a start before this one that has not opened its URL never will)
  turns.set(k, t);
  openers.set(k, { open, asking: true });
  setFlow(k, { phase: "starting" });
  await askLogin(server, id, t);
}

/** Sends the code the person pasted. A wrong one leaves the flow waiting with Claude's error (the field is tried again), or
 *  failed when Claude ended the login (a well-formed wrong code: Log in again starts a new one); a right one ends it (the list
 *  that follows says logged in). A refusal of the call leaves it waiting with its sentence, and is thrown. */
export async function submitCode(server: string, id: string, code: string): Promise<void> {
  const k = loginKey(server, id), was = flowOf(k), t = turns.get(k);
  if (!was || t === undefined) return;
  const url = was.url ? { url: was.url } : {};
  setFlow(k, { phase: "sending", ...url });
  let ans: LoginAnswer;
  try { ans = await aliasesApi.loginCode(server, id, code); } catch (e) {
    if (turns.get(k) === t) setFlow(k, { phase: "waiting", ...url, error: (e as Error)?.message || "The code could not be sent" });
    throw e;
  }
  if (turns.get(k) !== t) return;
  if (ans.state === "logged_in") return forget(server, id);
  if (ans.state === "waiting") return setFlow(k, { phase: "waiting", ...(ans.url ? { url: ans.url } : url), ...(ans.error ? { error: ans.error } : {}) });
  if (ans.state === "preparing") return setFlow(k, { phase: "preparing" });
  fail(k, ans.error || "The login failed");
}

/** Opens the login's URL again; with none kept (the flow is not waiting) the login is started again, which joins it (and
 *  calls open.close if it ends without the URL). */
export async function openLinkAgain(server: string, id: string, open: OpenURL): Promise<void> {
  const url = flowOf(loginKey(server, id))?.url;
  if (url) { open(url); return; }
  await startLogin(server, id, open);
}

/** Cancels the login: the server ends it. The flow is dropped whatever the call answers (what was readied to open its URL is
 *  closed); a refusal is thrown. */
export async function cancelLogin(server: string, id: string): Promise<void> {
  forget(server, id);
  await aliasesApi.cancelLogin(server, id);
}

/** What a server's new list settles of its logins: a flow of an account it no longer has, or that it shows logged in, ends
 *  (but one whose code is on its way: its answer ends it); a preparing one whose container runs now asks for the login
 *  again, once (not while a repeat runs). */
function settleLogins(server: string, list: AliasList | null) {
  const prefix = loginKey(server, "");
  for (const [k, f] of Object.entries(getState().aliasLogins)) {
    if (!k.startsWith(prefix)) continue;
    const id = k.slice(prefix.length), a = list?.aliases.find((x) => x.id === id);
    if (!a || (loggedIn(a.login) && f.phase !== "sending" && f.phase !== "starting")) { forget(server, id); continue; }
    const t = turns.get(k);
    if (f.phase === "preparing" && a.container.state === "running" && t !== undefined) reask(server, id, t);
  }
}

// ---- the request to show the accounts screen

let navs = 0;

/** Asks for Settings › Claude accounts (the Settings screen draws it): a server's section, and an account's sheet in it, the
 *  add sheet with a folder in its list, or an account's login. */
export function openAccounts(nav: Omit<AccountsNav, "seq">) { setState({ accountsNav: { ...nav, seq: ++navs } }); }

/** The accounts screen was closed, or has taken the request. */
export function closeAccounts() { setState({ accountsNav: null }); }
