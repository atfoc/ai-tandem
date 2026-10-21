// Hold Space (VC-28, goal 3.6), as decisions over plain values, with no React and no react-native, so that Node tests it
// (app/test/voice.pill.test.ts). A tap of Space (shorter than TAP_MS) is a tap on the orb: it starts listening, or ends / interrupts what the
// orb would. Holding it is push-to-talk: listening while it is down, and the release sends the turn at once (the release is the person's act,
// goal 4.7). While the session is paused (voice devices VD-12) Space is the paused orb: a tap continues, a hold does nothing. The hook `useHoldSpace` feeds these functions the key and the session and does what they answer.
import type { Phase } from "../../../voice/index.ts";

/** A Space down for less than this is a tap on the orb. */
export const TAP_MS = 300;
/** After a release the words may still be on their way from the voice service: how long they are waited for before the microphone is shut. */
export const WORDS_WAIT_MS = 1500;

export type Hold =
  | { kind: "off" }
  | { kind: "down"; at: number }       // Space is down and it started the session
  | { kind: "released"; at: number };  // a hold was let go: the turn goes as soon as its words are there

/** What the session is doing, as far as the key cares. */
export type Heard = { phase: Phase; words: boolean; paused?: boolean };

/** What the pill does about it: the orb's own start, interrupt, end and (paused) continue, the ↑ badge's send, and Cancel of the countdown. */
export type HoldAct = "start" | "interrupt" | "end" | "resume" | "send" | "cancel";
export type HoldStep = { hold: Hold; act: HoldAct | null };

export const NO_HOLD: Hold = { kind: "off" };
const stay = (hold: Hold): HoldStep => ({ hold, act: null });

/** Space went down (not a repeat of the key). With no session it starts one and a hold may follow; with one running it is a tap on the orb at once. */
export function spaceDown(h: Hold, s: Heard, at: number): HoldStep {
  if (h.kind !== "off") return stay(h);
  if (s.paused && s.phase !== "idle") return { hold: NO_HOLD, act: "resume" }; // (the paused orb's tap, in every phase; no hold follows, so no push-to-talk)
  if (s.phase === "idle") return { hold: { kind: "down", at }, act: "start" };
  return { hold: NO_HOLD, act: s.phase === "speaking" ? "interrupt" : "end" };
}

/** Space went up: after a tap the session listens on by itself; after a hold the turn is sent, or waits for its words. */
export function spaceUp(h: Hold, s: Heard, at: number): HoldStep {
  if (h.kind !== "down") return stay(h);
  if (at - h.at < TAP_MS) return stay(NO_HOLD);
  return settle({ kind: "released", at }, s, at);
}

/** Space is held or let go and something about the session changed (or time passed): what to do now. While held, a countdown is cancelled (the
 *  release decides, not the pause); after a release the turn is sent once it has words, and the microphone is shut if none come. */
export function settle(h: Hold, s: Heard, at: number): HoldStep {
  if (h.kind === "off") return stay(h);
  if (s.paused && s.phase !== "idle") return stay(NO_HOLD); // (paused during a hold: nothing is sent, the person continues with a tap)
  switch (s.phase) {
    case "starting": return stay(h);
    case "listening": case "countdown": case "waiting": break;
    default: return stay(NO_HOLD); // (the session ended, or the turn already went: there is nothing left to send)
  }
  if (h.kind === "down") return s.phase === "countdown" ? { hold: h, act: "cancel" } : stay(h);
  if (s.words) return { hold: NO_HOLD, act: "send" };
  return at - h.at >= WORDS_WAIT_MS ? { hold: NO_HOLD, act: "end" } : stay(h);
}

/** When a released hold looks again for its words, or null when no timer is wanted. */
export const wakeAt = (h: Hold): number | null => (h.kind === "released" ? h.at + WORDS_WAIT_MS : null);
