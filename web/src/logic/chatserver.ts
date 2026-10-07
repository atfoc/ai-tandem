// What a chat's composer says and offers by the server the chat is on (logic/serverlists.ts): the
// texts that name the server, the line under the toolbar, the Send that is off, the folder
// browser's home and titles, the recent folders and the plan usage's cache key. The texts for
// this computer are the ones of logic/agentlist.ts (no DOM, no React).
import { agentName } from "../agents.ts";
import { LOCAL_SERVER, type AgentKind, type ChatView } from "../types.ts";
import { CHOOSE_AGENT, NO_AGENT, agentChoice, agentOpen, noAgentPlaceholder, type AgentChoice } from "./agentlist.ts";
import { goneText } from "./remoteview.ts";
import { sendTitle } from "./status.ts";

/** A chat's server as the composer reads it: the entry id, its name, and whether it is connected. */
export type Where = { server: string; name: string; connected: boolean };

const remote = (w: Where) => w.server !== LOCAL_SERVER;

/** Why a chat on a server that is not connected offers no agent and takes no first message. */
export const notConnectedLine = (name: string): string => `${name} is not connected: its agents are not known.`;

/** The line of a chat whose first message got no answer. */
export const unconfirmedLine = (name: string): string =>
  `${name} did not answer: it is not known whether the first message arrived. Send again: it is sent only once.`;

export const AGENT_UNCONFIRMED = "The first message may have arrived: the agent cannot be changed until that is known";

/** Why no agent can be chosen on a server that has none. */
export const noAgentOn = (w: Where): string =>
  remote(w) ? `No agent is installed on ${w.name}. Install Claude Code, Cursor or pi on that machine.` : NO_AGENT;

const notInstalledOn = (w: Where, a: AgentKind) => `${agentName(a)} is not installed on ${w.name}: install it there, or choose another agent.`;

/** agentChoice by the chat's server: a server that is not connected offers none and marks none,
 *  since its agents are not known; another server's reasons name it. */
export function agentChoiceOn(w: Where, usable: AgentKind[], current: AgentKind | ""): AgentChoice {
  if (!w.connected) return { options: [], current, missing: false, reason: notConnectedLine(w.name) };
  const ch = agentChoice(usable, current);
  if (!remote(w)) return ch;
  return { ...ch, reason: !usable.length ? noAgentOn(w) : ch.missing ? notInstalledOn(w, current as AgentKind) : "" };
}

/** Why a chat with no agent takes no message, by its server. */
export const noAgentReasonOn = (w: Where, usable: AgentKind[]): string =>
  !w.connected ? notConnectedLine(w.name) : usable.length ? CHOOSE_AGENT : noAgentOn(w);

/** The line under the toolbar of a chat whose server and agent are shown, and whether it is about
 *  something that stops a Send ("missing") or a first message to send again ("unconfirmed"); text
 *  "" for none. An unconfirmed start comes first: its server and agent are fixed. */
export function toolbarLine(w: Where, usable: AgentKind[], c: Pick<ChatView, "agent" | "start">): { text: string; tone: "" | "missing" | "unconfirmed" } {
  if (c.start === "unconfirmed") return { text: unconfirmedLine(w.name), tone: "unconfirmed" };
  if (!w.connected) return { text: notConnectedLine(w.name), tone: "missing" };
  const text = c.agent ? agentChoiceOn(w, usable, c.agent).reason : noAgentReasonOn(w, usable);
  return { text, tone: text && (c.agent || !usable.length) ? "missing" : "" };
}

type Opens = Pick<ChatView, "locked" | "forkedFrom" | "branch" | "branches" | "role" | "start">;

/** Whether the chat's Send is off for its server: an unstarted chat on a server that is not
 *  connected has no agent to show. Not a started one (the server answers its send, 503, and tries
 *  the connection again) and not one whose first message is to be sent again. */
export const sendOff = (w: Where, c: Opens): boolean => !w.connected && agentOpen(c) && c.start !== "unconfirmed";

/** Whether the chat's Send is off because its server no longer has the chat. */
export const sendGone = (c: Pick<ChatView, "server" | "gone">): boolean => !!c.server && !!c.gone;

/** The title of a chat's Send, by its server. */
export const sendTitleOn = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "status" | "fresh"> & Partial<Pick<ChatView, "agent" | "server" | "gone">>, blocked: boolean): string =>
  sendGone(c) ? goneText(w.name) : sendOff(w, c) ? notConnectedLine(w.name) : sendTitle(c, blocked, noAgentReasonOn(w, usable));

/** What an empty thread says in place of its usual text, by the chat's server: why an unstarted
 *  chat on a server that is not connected shows no agent, or why a chat with no agent takes no
 *  message; "" for a chat that takes one. Where it says something, the thread offers no
 *  suggestions: a click would send a message that is refused. */
export const emptyReason = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "agent">): string =>
  sendOff(w, c) ? notConnectedLine(w.name) : !c.agent ? noAgentReasonOn(w, usable) : "";

/** The line of a first message that is on its way to the chat's server. */
export const sendingLine = (name: string): string => `Sending to ${name}…`;

/** Whether a Send is the first message of a chat on another server: one call that can take long,
 *  during which the thread shows the text (the store's `starting`) and the draft is held. */
export const startsThere = (c: Opens & Pick<ChatView, "server">): boolean => !!c.server && c.server !== LOCAL_SERVER && agentOpen(c);

/** The code of a first message refused because the chat had started there with an earlier text:
 *  the chat is a started one by then, and the text was not sent. */
export const FIRST_TEXT_KEPT = "first_text_kept";

/** Whether a refused Send's sentence is shown under the composer. Not that of a first message
 *  with no answer: the line under the toolbar (unconfirmedLine) says the same. */
export const errShown = (code?: string): boolean => code !== "start_unconfirmed";

/** Whether a refusal's sentence stays under the composer when the chat's choices or its start
 *  change: the one of `first_text_kept` is about a chat that starts with that very answer. Any
 *  other is about the choices and the state it was refused in, and goes with them. */
export const errStays = (code?: string): boolean => code === FIRST_TEXT_KEPT;

/** What the box of a chat that takes no message says; "" for one that does. */
export const offPlaceholder = (w: Where, usable: AgentKind[], c: Opens & Pick<ChatView, "agent">): string =>
  sendOff(w, c) ? `${w.name} is not connected` : !c.agent ? noAgentPlaceholder(usable) : "";

/** Whether the toolbar shows the chat's server: while it can be chosen, and for a chat on another
 *  server also after that. */
export const showsServer = (c: Parameters<typeof agentOpen>[0] & { server?: string }): boolean =>
  agentOpen(c) || (!!c.server && c.server !== LOCAL_SERVER);

/** A server picked for a chat: configure sends the server alone (the server sets agent, folder,
 *  model and effort from its own part), and the chat it answers with goes to take (the store). */
export async function pickServer(configure: (p: { server: string }) => Promise<{ chat?: ChatView }>, server: string, take: (c: ChatView) => void): Promise<void> {
  const r = await configure({ server });
  if (r.chat) take(r.chat);
}

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

/** The recent folders as stored (under recentKey(server)); none for anything else than a list of paths. */
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
