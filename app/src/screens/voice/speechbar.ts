// What the phone's speech bar (PhoneSpeechBar.tsx) says and offers at each moment, with no React and no react-native, so that Node tests it
// (app/test/voice.speechbar.test.ts): the state word, the one action of the moment, the words End leaves in the box.
import type { Phase } from "../../voice/index.ts";
import { BAR_INTERRUPT, BAR_LISTENING, BAR_MUTED, BAR_PAUSED, BAR_SENDING, BAR_SPEAKING, BAR_THINKING, PILL_CANCEL, PILL_SEND, VOICE_CONTINUE } from "../../voice/words.ts";

/** The one action at the right of the bar's top row. */
export type BarAction = "send" | "cancel" | "interrupt" | "continue";

export const ACTION_LABEL: Record<BarAction, string> = { send: PILL_SEND, cancel: PILL_CANCEL, interrupt: BAR_INTERRUPT, continue: VOICE_CONTINUE };

export type BarInput = {
  phase: Phase;
  muted: boolean;
  /** The session is held because the headphones went away (voice devices VD-12). */
  paused: boolean;
  /** The seconds left of the countdown (null: none runs). */
  left: number | null;
};

/** The turn is still the person's: words are being heard or wait to be sent. */
export function turnIsOpen(phase: Phase): boolean {
  return phase === "listening" || phase === "waiting" || phase === "countdown";
}

/** The state word of the top row: Listening, Sending in N s, Thinking…, Speaking, Muted (a muted session says so in any phase). */
export function stateWord({ phase, muted, paused, left }: BarInput): string {
  if (muted) return BAR_MUTED;
  if (paused) return BAR_PAUSED;
  switch (phase) {
    case "countdown": return BAR_SENDING(Math.max(1, Math.ceil(left ?? 0)));
    case "sending": case "thinking": return BAR_THINKING;
    case "speaking": return BAR_SPEAKING;
    default: return BAR_LISTENING;
  }
}

/** The action of the moment: Continue while paused, Cancel in the countdown, Interrupt while speaking, Send while the turn is open, none while it thinks. */
export function barAction({ phase, paused }: BarInput): BarAction | null {
  if (paused) return "continue";
  if (phase === "countdown") return "cancel";
  if (phase === "speaking") return "interrupt";
  return turnIsOpen(phase) ? "send" : null;
}

/** Whether the waveform shows the level (the person talks or the model speaks) or flat dots (thinking, muted, paused). */
export function waveFlat({ phase, muted, paused }: BarInput): boolean {
  return muted || paused || phase === "sending" || phase === "thinking";
}

/** The words End leaves in the box as the draft: what was heard and not yet sent (finished words, then the live guess); none once the turn is sent. */
export function unsentWords(phase: Phase, committed: string, partial: string): string {
  return turnIsOpen(phase) ? [committed, partial].filter(Boolean).join(" ").trim() : "";
}
