// What the board's pill decides, with no React and no react-native, so that Node tests it (app/test/voice.pill.test.ts): the orb's state from
// the session's phase, the pill's size, the chat a turn goes to, the chats the chip lists, and the bars of the waveform.
import { boardChats } from "@aiwb/core/logic/tree.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import type { Phase } from "../../../voice/index.ts";

/** The orb's states (goal 3.6). `waiting` is "Tap to send waiting" (the ↑ badge); `countdown` is "Auto-send waiting" (the ring fills). */
export type OrbState = "idle" | "listening" | "countdown" | "waiting" | "thinking" | "speaking";

/** The three sizes of the pill (VC-28): the compact pill, the listening bar, the orb alone. */
export type PillSize = "compact" | "listening" | "orb";

export function orbState(phase: Phase): OrbState {
  switch (phase) {
    case "idle": return "idle";
    case "starting": case "listening": return "listening";
    case "countdown": return "countdown";
    case "waiting": return "waiting";
    case "sending": case "thinking": return "thinking";
    case "speaking": return "speaking";
  }
}

/** The pill grows to the listening bar while the person listens or words wait, and is the orb alone when it was collapsed. */
export function pillSize(phase: Phase, collapsed: boolean): PillSize {
  if (collapsed) return "orb";
  const s = orbState(phase);
  return s === "listening" || s === "countdown" || s === "waiting" ? "listening" : "compact";
}

/** A chat voice can send to: not archived, and not a Curl-era one that the app disables. */
const takesTurn = (c: ChatView | undefined): c is ChatView => !!c && !c.archived && !c.instructionsSent;

/** The chat the pill talks to: the chat used last when it is still a chat of the board, else the newest of the board's chats the sidebar
 *  lists; null when there is none (the first turn then makes one). */
export function pickTarget(chats: Record<string, ChatView>, board: string, last: string | undefined, showArchived: boolean): string | null {
  const l = last ? chats[last] : undefined;
  if (l && l.board === board && takesTurn(l)) return l.id;
  return boardChats(chats, board, showArchived).find(takesTurn)?.id ?? null;
}

/** The chats the chip lists: the ones the sidebar shows for the board, or every one of them. */
export function chipChats(chats: Record<string, ChatView>, board: string, showArchived: boolean, all: boolean): ChatView[] {
  return boardChats(chats, board, all || showArchived);
}

/** How many chats "Show all" adds to the sidebar's list. */
export function hiddenCount(chats: Record<string, ChatView>, board: string, showArchived: boolean): number {
  return boardChats(chats, board, true).length - boardChats(chats, board, showArchived).length;
}

/** The waveform's bars: the last `n` levels (RMS 0..1) scaled so that speech fills the height (a quiet room still shows a low line). */
export function barHeights(levels: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = levels[levels.length - n + i] ?? 0;
    out.push(Math.min(1, 0.08 + Math.sqrt(Math.max(0, v)) * 1.6));
  }
  return out;
}

/** The share of the pause that has run, 0..1, and the seconds left. */
export function countdownAt(c: { startedAt: number; ms: number }, now: number): { frac: number; left: number } {
  const ran = Math.max(0, Math.min(c.ms, now - c.startedAt));
  return { frac: c.ms > 0 ? ran / c.ms : 1, left: Math.max(0, (c.ms - ran) / 1000) };
}

/** How long a caption stays after its last change, and how long it takes to fade (VC-28). */
export const CAPTION_MS = 4000;
export const CAPTION_FADE_MS = 500;

export type Captions = {
  /** What the person said: the words of the turn from the moment they are heard (the bar shows them while it is the listening bar) until the reply starts. */
  said: string;
  /** The sentence being spoken, kept after the reply ends until it fades. */
  spoken: string;
  /** The turn is on its way: the words stay until the reply starts, whatever the time. */
  holdSaid: boolean;
  /** The reply is being spoken: the sentence stays until it ends. */
  holdSpoken: boolean;
};

/** What the board's captions say for a session. The listening bar already shows the words of the turn, so the caption leaves them to it. */
export function captionTexts(o: { phase: Phase; size: PillSize; committed: string; partial: string; spoken: string }): Captions {
  const words = o.phase === "listening" || o.phase === "countdown" || o.phase === "waiting" || o.phase === "sending" || o.phase === "thinking";
  const said = words && o.size !== "listening" ? [o.committed, o.partial].filter(Boolean).join(" ") : "";
  return { said, spoken: o.phase === "speaking" ? o.spoken : "", holdSaid: o.phase === "sending" || o.phase === "thinking", holdSpoken: o.phase === "speaking" };
}

/** A key for the board's selection as the store has it: the chip that was removed stays removed while the selection is the same one. */
export function selectionKey(sel: { count: number; lines: readonly string[] }): string {
  return `${sel.count}\n${sel.lines.join("\n")}`;
}
