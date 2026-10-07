// The agents a server can run, and what an agent choice shows: every list of agents the page
// offers (a chat's, a draft run's, the empty state's) reads the store through here, so none
// names an agent the server lacks. An item with no agent has agent "" (no DOM, no React). The
// lists are by server (logic/serverlists.ts): a chat's are those of the server it is on.
import { agentName } from "../agents.ts";
import { LOCAL_SERVER, type AgentKind, type Catalog, type ChatView } from "../types.ts";
import { listsOf, offered, type ListsState } from "./serverlists.ts";

const NONE: AgentKind[] = []; // one list for every server that offers none: a store selector gets the same one each time

/** The usable agents of a server (an entry id), in the order they are offered: none while the
 *  server is not connected, also when its list is known from before. */
export const usableAgents = (s: ListsState, server: string = LOCAL_SERVER): AgentKind[] => offered(s, server)?.agents ?? NONE;

/** The catalog a server (an entry id) has of an item's agent, also while the server is not
 *  connected: a chat on it still shows its model by name. None for an item with no agent. */
export const catalogFor = (s: ListsState, server: string, agent: AgentKind | ""): Catalog | undefined =>
  (agent && listsOf(s, server)?.catalogs?.[agent]) || undefined;

/** Whether the chat's server and agent can still be changed: it has not started and is neither a
 *  fork, a branch nor a run's own agent. The server is the authority (it answers 409). */
export const agentOpen = (c: Pick<ChatView, "locked" | "forkedFrom" | "branch" | "branches" | "role">): boolean =>
  !c.locked && !c.forkedFrom && !c.branch && !((c.branches ?? 0) > 1) && !c.role;

export const NO_AGENT = "No agent is installed on this computer. Install Claude Code, Cursor or pi; a program outside the app's PATH is found after a restart.";
const notInstalled = (a: AgentKind) => `${agentName(a)} is not installed on this computer: install it, or choose another agent.`;

/** What an agent picker shows: the agents offered, the item's own, whether the server lacks it,
 *  and why nothing can be sent or started ("" when it can). */
export type AgentChoice = { options: AgentKind[]; current: AgentKind | ""; missing: boolean; reason: string };

export function agentChoice(usable: AgentKind[], current: AgentKind | ""): AgentChoice {
  const missing = current !== "" && !usable.includes(current);
  return { options: usable, current, missing, reason: !usable.length ? NO_AGENT : missing ? notInstalled(current as AgentKind) : "" };
}

export const CHOOSE_AGENT = "Choose an agent to send a message.";

/** Why a chat with no agent takes no message: none is installed, or one is still to be chosen.
 *  It is the title of its Send. */
export const noAgentReason = (usable: AgentKind[]): string => (usable.length ? CHOOSE_AGENT : NO_AGENT);

/** The name shown where a chat's agent is named; a chat with none says so, as its agent choice does. */
export const agentLabel = (agent: AgentKind | ""): string => (agent ? agentName(agent) : "No agent");

/** The hint of an empty thread on what is still to be picked: for a chat with no agent the agent
 *  comes first, and with none to choose there is nothing to pick. */
export const configHint = (usable: AgentKind[], agent: AgentKind | ""): string =>
  agent ? "Pick the folder, model and effort below — they lock when you send."
    : usable.length ? "Pick the agent, folder, model and effort below — they lock when you send." : "";

/** What the box of a chat with no agent says. */
export const noAgentPlaceholder = (usable: AgentKind[]): string => (usable.length ? "Choose an agent…" : "No agent is installed");

/** The line under a chat's toolbar on its agent: why a chat with none takes no message, or why
 *  the one it has cannot be used; "" for a usable one. A chat with an agent the server lacks can
 *  still be sent: the server looks again, and refuses with the reason (409 agent_missing). */
export const agentLine = (usable: AgentKind[], agent: AgentKind | ""): string =>
  agent ? agentChoice(usable, agent).reason : noAgentReason(usable);

/** An agent picked for a chat: configure sends the change, which names the agent alone (the
 *  server sets model and effort), and the chat it answers with goes to take (the store). */
export async function pickAgent(configure: (p: { agent: AgentKind }) => Promise<{ chat?: ChatView }>, agent: AgentKind, take: (c: ChatView) => void): Promise<void> {
  const r = await configure({ agent });
  if (r.chat) take(r.chat);
}

// The names as the empty state's sentence writes them.
const inText = (a: AgentKind) => (a === "pi" ? "pi" : agentName(a));

/** The empty state's sentence on what a chat is. It names the usable agents alone. */
export function homeAgentsText(usable: AgentKind[]): string {
  if (!usable.length) return NO_AGENT;
  const names = usable.map(inText);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0];
  return `Chats are ${list} sessions, the same as in a terminal.`;
}
