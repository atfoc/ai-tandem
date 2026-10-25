// What blocks the phone's composer, and the words it says (ux-improvements goal 3.7.1; the V1 design §1). Pure: no React, so Node loads it
// (test/composer.blocked.test.ts). Blocked.tsx draws what this decides.
//
// One state stands in the box's own place or the toolbar's, by priority: archived (with its server offline, the bar says that instead of
// its button) › the old board connection › no agent › the chat gone from its server › its server offline. The two "above" notices, a model too
// small for the conversation and a refused send, can stand with any state that leaves the box in view (offline, gone) or with none.
import { NO_AGENT } from "@aiwb/core/logic/agentlist.ts";
import type { Where } from "@aiwb/core/logic/chatserver.ts";
import { goneText } from "@aiwb/core/logic/remoteview.ts";
import { formatSince } from "@aiwb/core/logic/statewords.ts";
import { LOCAL_SERVER, type AgentKind } from "@aiwb/core/types.ts";

export type BlockKind = "offline" | "gone" | "archived" | "legacy" | "noagent" | "toosmall" | "refused";
/** `box`: drawn instead of the box; `toolbar`: in the toolbar's place inside the read-only box; `above`: right above the box. */
export type BlockPlace = "box" | "toolbar" | "above";
/** The control a state offers: Servers (the server's detail), Unarchive, New chat on this board, Pick a model, the refused card's ×. */
export type BlockAction = "servers" | "unarchive" | "newchat" | "pickmodel" | "dismiss";

export type BlockWords = {
  kind: BlockKind;
  place: BlockPlace;
  /** The 17 pt first line. */
  title: string;
  /** The 13 pt second line ("" none). */
  sub: string;
  action?: BlockAction;
};

export type BlockInputs = {
  archived: boolean;
  legacy: boolean;
  /** The chat belongs to a board (the old-connection bar offers New chat on it only then). */
  board: boolean;
  where: Where;
  /** The server no longer has the chat. */
  gone: boolean;
  /** The agents the chat's server offers. */
  usable: readonly AgentKind[];
  /** The chat's own agent ("" none). */
  agent: string;
  /** When the server's state began (State.serverSince), epoch ms; undefined when no time is known. */
  since: number | undefined;
  now: number;
  /** The model notice's text when it warns (the model is too small for the conversation), "" else. */
  tooSmall: string;
  /** The last refused send's sentence ("" none). */
  refused: string;
};

export type Blocks = {
  /** The state of the box's or the toolbar's place, if one holds. */
  main: BlockWords | null;
  /** The notices above the box (the amber one, then the red one); none while the box is replaced. */
  above: BlockWords[];
  /** Why Send is greyed ("" while the notices do not grey it): the model is too small. */
  sendOff: string;
};

/** "<Server> is offline since 14:02." — with no time known, "<Server> is offline." */
export const offlineSentence = (name: string, since: number | undefined, now: number): string =>
  `${name} is offline${since === undefined ? "" : ` ${formatSince(since, now)}`}.`;

export const OFFLINE_KEPT = "Your draft is kept until it's back.";
export const ARCHIVED_TITLE = "This chat is archived.";
export const ARCHIVED_SUB = "Unarchive it to send a message. It goes back to the list with the others.";
export const LEGACY_TITLE = "This chat used the old board connection.";
export const LEGACY_SUB = "Start a new chat on this board to go on.";
export const NO_AGENT_SUB = "Install Claude Code, Cursor or pi on that computer, then come back.";

/** The words of "no agent": another server names it; this computer says today's sentence (agentlist.ts NO_AGENT), split at its first full stop. */
export function noAgentWords(w: Where): { title: string; sub: string } {
  if (w.server !== LOCAL_SERVER) return { title: `No agent is installed on ${w.name}.`, sub: NO_AGENT_SUB };
  const at = NO_AGENT.indexOf(". ");
  return at < 0 ? { title: NO_AGENT, sub: "" } : { title: NO_AGENT.slice(0, at + 1), sub: NO_AGENT.slice(at + 2) };
}

export function blockOf(i: BlockInputs): Blocks {
  const off = !i.where.connected;
  let main: BlockWords | null = null;
  if (i.archived) {
    main = off
      ? { kind: "archived", place: "box", title: ARCHIVED_TITLE, sub: offlineSentence(i.where.name, i.since, i.now) }
      : { kind: "archived", place: "box", title: ARCHIVED_TITLE, sub: ARCHIVED_SUB, action: "unarchive" };
  } else if (i.legacy) {
    main = { kind: "legacy", place: "box", title: LEGACY_TITLE, sub: LEGACY_SUB, action: i.board ? "newchat" : undefined };
  } else if (!i.agent && !i.usable.length && !off) { // (what a server offers is not known while it is offline: that is not "none installed")
    main = { kind: "noagent", place: "box", ...noAgentWords(i.where) };
  } else if (i.gone) {
    main = { kind: "gone", place: "toolbar", title: goneText(i.where.name), sub: "" };
  } else if (off) {
    main = { kind: "offline", place: "toolbar", title: offlineSentence(i.where.name, i.since, i.now), sub: OFFLINE_KEPT, action: "servers" };
  }
  const above: BlockWords[] = [];
  if (main?.place !== "box") {
    if (i.tooSmall) above.push({ kind: "toosmall", place: "above", title: i.tooSmall, sub: "", action: "pickmodel" });
    if (i.refused) above.push({ kind: "refused", place: "above", title: i.refused, sub: "", action: "dismiss" });
  }
  return { main, above, sendOff: above.some((b) => b.kind === "toosmall") ? i.tooSmall : "" };
}
