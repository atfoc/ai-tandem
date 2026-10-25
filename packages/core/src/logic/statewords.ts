// The one list of state words and their colours (ux-improvements goal 3.1.3, 4.7): what a server and a chat are said to be, on
// Home, the server chips, the server sheet, the Servers screen, Chat info and a chat's header. Every phone screen takes its word
// from here, so a server in a state reads the same everywhere (the rules check, goal 6.2, holds the screens to it). A screen
// draws the word with the tone's colour (app/src/ui/StateWord.tsx); the words are the board's. Pure: no React, so Node loads it.
//
// Contract of package F3 (plans/ux-improvements/PLAN.md). The mapping of the states the goal does not name (a refused secret, a
// name the server does not know, …) is F3's decision: they read "Unreachable", with today's label (`stateLabel`) as the reason.
import { agentShortName } from "../agents.ts";
import type { ChatView, Writer } from "../types.ts";
import type { BoardRole } from "./roles.ts";
import { isBusy } from "./status.ts";
import { stateLabel, type ServerState, type ServerView } from "./servers.ts";

/** The colour of a word: ok green, wait grey, warn amber, bad red. */
export type WordTone = "ok" | "wait" | "warn" | "bad";

/** A state word: `key` is stable (a check and a testID's dataSet read it), `text` is what is shown and read aloud. */
export type StateWord = { key: string; text: string; tone: WordTone };

/** The words of a server. */
export const SERVER_WORDS = {
  connected: { key: "connected", text: "Connected", tone: "ok" },
  connecting: { key: "connecting", text: "Connecting…", tone: "wait" },
  unreachable: { key: "unreachable", text: "Unreachable", tone: "bad" },
  offline: { key: "offline", text: "Offline", tone: "bad" },
  certChanged: { key: "cert-changed", text: "Certificate changed · paused", tone: "bad" },
  localNetworkOff: { key: "local-network-off", text: "Local network off", tone: "bad" },
  tooOld: { key: "too-old", text: "Too old", tone: "warn" },
} as const satisfies Record<string, StateWord>;

/** The words of a chat. "Waiting on N subagents" is made by `waitingOn`. */
export const CHAT_WORDS = {
  writing: { key: "writing", text: "Writing…", tone: "ok" },
  approval: { key: "approval", text: "Needs your approval", tone: "warn" },
  stopped: { key: "stopped", text: "Stopped", tone: "bad" },
  failed: { key: "failed", text: "Failed", tone: "bad" },
  // (a chat whose turn has ended and waits for its background work, a shell or a monitor, with no subagent running: not writing; the chat's
  // header said so first, and Home's rows now say the same)
  background: { key: "background", text: "Waiting for background work", tone: "wait" },
} as const satisfies Record<string, StateWord>;

export const waitingOn = (n: number): StateWord => ({ key: "subagents", text: `Waiting on ${n} subagent${n === 1 ? "" : "s"}`, tone: "ok" });

/** What the phone knows beside the server's own state: iOS refused the local network (platform/localnetwork). */
export type ServerWordContext = { localNetworkDenied?: boolean };

/** The word of a server, and the reason a screen may show under it (today's label for the states the list folds into
 *  "Unreachable"; nothing for the others). */
export function serverWord(v: Pick<ServerView, "state">, o: ServerWordContext = {}): StateWord & { reason?: string } {
  const s: ServerState = v.state;
  if (s === "connected") return SERVER_WORDS.connected;
  if (s === "connecting") return SERVER_WORDS.connecting;
  if (s === "certificate_changed") return SERVER_WORDS.certChanged;
  if (s === "too_old") return SERVER_WORDS.tooOld;
  if (o.localNetworkDenied) return SERVER_WORDS.localNetworkOff;
  if (s === "unreachable") return SERVER_WORDS.unreachable;
  return { ...SERVER_WORDS.unreachable, reason: stateLabel(s) };
}

/** Whether the server's state is one a person has to act on (Settings' Servers row turns amber, a chip shows its dot). */
export const needsAttention = (v: Pick<ServerView, "state">): boolean => v.state !== "connected" && v.state !== "connecting";

/** The word of a chat, or null when it is idle (a row then shows its settings line). Approval wins over work, as on the rows today. */
export function chatWord(c: Pick<ChatView, "status" | "approvals" | "subsRunning" | "working">): StateWord | null {
  if ((c.approvals ?? 0) > 0 || c.status === "approval") return CHAT_WORDS.approval;
  if (c.status === "waiting" && (c.subsRunning ?? 0) > 0) return waitingOn(c.subsRunning ?? 0);
  if (c.status === "waiting") return CHAT_WORDS.background;
  if (isBusy(c.status) || (c.working ?? 0) > 0) return CHAT_WORDS.writing;
  if (c.status === "stopped") return CHAT_WORDS.stopped;
  if (c.status === "error") return CHAT_WORDS.failed;
  return null;
}

/** Whether a chat needs the person (the orange dot on its row, the count on its group): it waits for approval, stopped or failed. */
export const needsYou = (c: Pick<ChatView, "status" | "approvals" | "subsRunning" | "working">): boolean => {
  const w = chatWord(c);
  return !!w && (w.tone === "warn" || w.tone === "bad");
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** When a state began, as the second line of a word says it: "since 9:12" (24-hour clock, local time) on the day it began,
 *  "since yesterday" the day after, else "since Oct 3" ("since Oct 3, 2025" from another year). `ts` and `now` are epoch
 *  milliseconds; a `ts` in the future (a clock set back) reads as now. */
export function formatSince(ts: number, now: number): string {
  const t = new Date(Math.min(ts, now)), n = new Date(now);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(t)) / 86_400_000); // Math.round: a day is 23 or 25 hours when the clock changes
  if (days <= 0) return `since ${t.getHours()}:${String(t.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return "since yesterday";
  return `since ${MONTHS[t.getMonth()]} ${t.getDate()}${t.getFullYear() === n.getFullYear() ? "" : `, ${t.getFullYear()}`}`;
}

/** The words of a board on the phone (B1): what the second line of its bar says beside the place. "<Agent> is working…" is made by
 *  `boardWord`, from the agent's short name. */
export const BOARD_WORDS = {
  view: { key: "view", text: "View only", tone: "wait" },
  taking: { key: "taking", text: "Taking over…", tone: "wait" },
  editing: { key: "editing", text: "Editing", tone: "ok" },
  taken: { key: "taken", text: "Another window is editing", tone: "warn" },
  agent: { key: "agent", text: "An agent is editing", tone: "warn" },
  archived: { key: "archived", text: "Archived · read-only", tone: "wait" },
  // (B2: while a chat of the board waits for a point, or for shapes selected for it; the bar draws them in the accent)
  picking: { key: "picking", text: "Picking a point", tone: "wait" },
  selecting: { key: "selecting", text: "Selecting for the chat", tone: "wait" },
} as const satisfies Record<string, StateWord>;

/** The word of a board: an agent at work (`worker`, its id: it is said in the agent's colour and is the whole line), an archived
 *  board, this window's role (held, taking), then who else writes it (a window, or an agent that is not at work now), else view only.
 *  A window that lost the board says what holds it now, as the wide bar's sentence does. */
export function boardWord(o: { role: BoardRole | null | undefined; writer: Writer; archived: boolean; worker: string | null | undefined }): StateWord {
  if (o.worker) return { key: "working", text: `${agentShortName(o.worker)} is working…`, tone: "ok" };
  if (o.archived) return BOARD_WORDS.archived;
  if (o.role === "held") return BOARD_WORDS.editing;
  if (o.role === "taking") return BOARD_WORDS.taking;
  if (o.writer === "headless") return BOARD_WORDS.agent;
  if (o.writer === "window" || o.role === "lost") return BOARD_WORDS.taken;
  return BOARD_WORDS.view;
}
