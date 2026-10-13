// What a chat's composer says and offers by the server the chat is on (logic/serverlists.ts): the
// texts that name the server, the line under the toolbar, the Send that is off, the folder
// browser's home and titles, the recent folders and the plan usage's cache key. The texts for
// this computer are the ones of logic/agentlist.ts (no DOM, no React).
import { agentName } from "../agents.ts";
import { LOCAL_SERVER, type AgentKind, type ChatView } from "../types.ts";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, noAgentPlaceholder, type AgentChoice } from "./agentlist.ts";
import { goneText } from "./remoteview.ts";
import { sendTitle } from "./status.ts";

/** A thing's server as its views read it: the entry id, its name, and whether it takes a call now (the local server
 *  holds its tree: logic/serverlists.ts serverConnected). This computer always does. */
export type Where = { server: string; name: string; connected: boolean };

const remote = (w: Where) => w.server !== LOCAL_SERVER;

/** Why a chat on a server that is not connected takes no message and no change: what its composer says. */
export const notConnectedLine = (name: string): string => `${name} is not connected: nothing can be sent or changed until it is back.`;

/** Why no agent can be chosen on a server that has none. */
export const noAgentOn = (w: Where): string =>
  remote(w) ? `No agent is installed on ${w.name}. Install Claude Code, Cursor or pi on that machine.` : NO_AGENT;

const notInstalledOn = (w: Where, a: AgentKind) => `${agentName(a)} is not installed on ${w.name}: install it there, or choose another agent.`;

/** agentChoice by the chat's server: a server that is not connected offers none and marks none;
 *  another server's reasons name it. */
export function agentChoiceOn(w: Where, usable: AgentKind[], current: AgentKind | ""): AgentChoice {
  if (!w.connected) return { options: [], current, missing: false, reason: notConnectedLine(w.name) };
  const ch = agentChoice(usable, current);
  if (!remote(w)) return ch;
  return { ...ch, reason: !usable.length ? noAgentOn(w) : ch.missing ? notInstalledOn(w, current as AgentKind) : "" };
}

/** Why a chat with no agent takes no message, by its server. */
export const noAgentReasonOn = (w: Where, usable: AgentKind[]): string =>
  !w.connected ? notConnectedLine(w.name) : usable.length ? CHOOSE_AGENT : noAgentOn(w);

/** The line under the toolbar: why the chat takes no message and no change (its server no longer has it: gone; its
 *  server is not connected), else what is said of its agent while that can be chosen; and whether it is about
 *  something that stops a Send ("missing"); text "" for none. */
export function toolbarLine(w: Where, usable: AgentKind[], c: Pick<ChatView, "agent">, gone = false): { text: string; tone: "" | "missing" } {
  if (gone) return { text: goneText(w.name), tone: "missing" };
  if (!w.connected) return { text: notConnectedLine(w.name), tone: "missing" };
  const text = c.agent ? agentChoiceOn(w, usable, c.agent).reason : noAgentReasonOn(w, usable);
  return { text, tone: text && (c.agent || !usable.length) ? "missing" : "" };
}

type Opens = Pick<ChatView, "locked" | "forkedFrom" | "branch" | "branches" | "role">;

/** Whether the chat's Send, its Stop and its choices are off for its server: it is not connected. The view stays as
 *  the page had it when the connection ended, read-only. */
export const sendOff = (w: Where): boolean => !w.connected;

/** Whether the composer's box is read-only: the chat's server is not connected, or no longer has the chat (gone). The
 *  box keeps what it holds and takes no more: what was typed and not yet taken by the server stays in it, and is
 *  saved when the server is connected again, if the chat is still open then. Nothing is typed into a chat that
 *  nothing can be sent to. */
export const boxOff = (w: Where, gone = false): boolean => gone || sendOff(w);

/** Why a chat takes no call now: its server no longer has it (gone), or is not connected; "" for a chat that takes
 *  one. Every control of the chat's view that would ask its server, or change what the view shows of it, is off then
 *  and says this: the actions of a message, the tree's, the way to another branch, Back, a permission request's answer. */
export const offWhy = (w: Where, gone = false): string => (gone ? goneText(w.name) : sendOff(w) ? notConnectedLine(w.name) : "");

/** The title of a chat's Send, by its server. gone: its server no longer has the chat. */
export const sendTitleOn = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "status" | "fresh"> & Partial<Pick<ChatView, "agent">>, blocked: boolean, gone = false): string =>
  gone ? goneText(w.name) : sendOff(w) ? notConnectedLine(w.name) : sendTitle(c, blocked, noAgentReasonOn(w, usable));

/** What an empty thread says in place of its usual text, by the chat's server: why a chat that its
 *  server no longer has (gone), or one on a server that is not connected, takes no message, or why
 *  a chat with no agent takes none; "" for a chat that takes one. Where it says something, the
 *  thread offers no suggestions: a click would send a message that is refused. */
export const emptyReason = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "agent">, gone = false): string =>
  offWhy(w, gone) || (!c.agent ? noAgentReasonOn(w, usable) : "");

/** The line of a message that starts a fork or a branch, while it is on its way to the chat's server (logic/waits.ts). */
export const sendingLine = (name: string): string => `Sending to ${name}…`;

/** What the box of a chat that takes no message says; "" for one that does. gone: its server no longer has the chat. */
export const offPlaceholder = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "agent">, gone = false): string =>
  gone ? goneText(w.name) : sendOff(w) ? `${w.name} is not connected` : !c.agent ? noAgentPlaceholder(usable) : "";

/** Whether the toolbar names the chat's server: only for a chat of a section. The server is where
 *  the chat was made, and is no choice of the toolbar's. */
export const showsServer = (w: Where): boolean => remote(w);

// ---- folders

/** A path with a server's home written as "~"; as it is with no home known. */
export const tildeBy = (home: string | undefined, p?: string): string =>
  p && home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p ?? "";

/** The title of the folder chip: another server's names the server. */
export function folderTitle(w: Where, cwd: string, o: { missing?: boolean; locked?: boolean; hint?: string } = {}): string {
  if (!remote(w)) return o.locked ? `Working directory: ${cwd}` : o.missing ? `Folder not found: ${cwd}` : `Working directory: ${cwd} — ${o.hint}`;
  return o.locked ? `Folder on ${w.name}: ${cwd}` : o.missing ? `Folder not found on ${w.name}: ${cwd}` : `Folder on ${w.name}: ${cwd} — ${o.hint}`;
}

/** The head of the folder browser. */
export const folderHead = (w: Where): string => (remote(w) ? `Folder on ${w.name}` : "Start the agent in");

/** Where the folder browser starts when the chat's own folder cannot be read: the server's default folder, then its home. */
export const folderStarts = (lists?: { home?: string; defaultCwd?: string }): string[] =>
  [lists?.defaultCwd || lists?.home || "", lists?.home || ""];

/** The recent folders as stored (under RECENT_KEY); none for anything else than a list of paths. */
export function recentFrom(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** The recent folders with one used now: first, once, six at most. */
export const withRecent = (recent: string[], d: string): string[] => [d, ...recent.filter((x) => x !== d)].slice(0, 6);

// ---- plan usage

/** The key the last usage answer is kept under: a server's plan is its own. */
export const usageKey = (server: string, agent: AgentKind): string => `${server}:${agent}`;

/** The head of the plan usage: the agent's own on this computer, "Plan usage on <Name>" for another server. */
export const usageTitleOn = (w: Where, title: string): string => (remote(w) ? `Plan usage on ${w.name}` : title);
