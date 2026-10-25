// The words of the phone's "Set up voice" sheet (ux-improvements goal 3.7.2, v1-design §3): title, body, muted note and the primary's
// label for each kind of voice problem, and the agent the body names. No React here, so Node loads it.
import type { VoiceProblemKind } from "../../voice/index.ts";
import {
  PROBLEM_WORDS, SETUP_ELEVENLABS_TITLE, SETUP_MIC_TITLE, SETUP_NOTE, SETUP_OFFLINE_TITLE, SETUP_OPEN_VOICE, SETUP_TALK, SETUP_TITLE, SETUP_YOUR_AGENTS,
} from "../../voice/words.ts";

export type SetupWords = { title: string; body: string; note?: string; action: string };

/** The sheet's words for a problem; `agent` is the name the first body line gives. */
export function setupWords(kind: VoiceProblemKind, agent: string): SetupWords {
  const w = PROBLEM_WORDS[kind];
  switch (kind) {
    case "no_key": return { title: SETUP_TITLE, body: SETUP_TALK(agent), note: SETUP_NOTE, action: SETUP_OPEN_VOICE };
    case "key_rejected": return { title: SETUP_TITLE, body: w.sentence, note: SETUP_NOTE, action: SETUP_OPEN_VOICE };
    case "no_credits":
    case "service": return { title: SETUP_ELEVENLABS_TITLE, body: w.sentence, action: w.action };
    case "mic_blocked": return { title: SETUP_MIC_TITLE, body: w.sentence, action: w.action };
    case "offline": return { title: SETUP_OFFLINE_TITLE, body: w.sentence, action: w.action };
  }
}

/** The agent an anchor names: `dictate:<chat>` and `speech:<chat>` the chat's, `pill:<board>` the board's voice chat's (`boardChat` finds it),
 *  anything else "your agents". `chatAgent` gives a chat's display name, or undefined when there is none. */
export function setupAgent(anchor: string, chatAgent: (chat: string) => string | undefined, boardChat: (board: string) => string | null): string {
  const i = anchor.indexOf(":");
  if (i < 0) return SETUP_YOUR_AGENTS;
  const kind = anchor.slice(0, i), id = anchor.slice(i + 1);
  if (kind === "dictate" || kind === "speech") return chatAgent(id) ?? SETUP_YOUR_AGENTS;
  if (kind === "pill") { const c = boardChat(id); return (c ? chatAgent(c) : undefined) ?? SETUP_YOUR_AGENTS; }
  return SETUP_YOUR_AGENTS;
}
