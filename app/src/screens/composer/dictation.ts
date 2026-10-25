// What the composer lends to voice's controls (architecture §8.1, speech mode's send): its text box, as four small things. The composer provides it
// (Composer.tsx), the control (screens/voice/ComposerVoice.tsx) takes it from the context, so that neither imports the other. No react-native here.
import { createContext, useSyncExternalStore } from "react";

export type DictationBox = {
  /** The text the box holds now. */
  text(): string;
  /** Puts `text` into the box as the box's own `set` does (the draft saver sees an ordinary edit); the composer then knows a change to
   *  exactly this text is dictation's own and not the person's typing. */
  put(text: string): void;
  /** `typed` is called when the person changes the box (a key, a paste, a drop, a chip) while it is watched; answers the way to stop watching. */
  watch(typed: () => void): () => void;
  /** Runs `send`, a send that is not the composer's own (a spoken turn), so that the draft the person typed survives it: the server removes the
   *  branch's draft for any send, and the box would follow. The composer's saver is told (`keeping`), and saves the draft again over the removal. */
  keeping<T>(send: () => Promise<T>): Promise<T>;
};

/** null outside a composer (a control drawn with no box does nothing). */
export const DictationBoxContext = createContext<DictationBox | null>(null);

// ux-v1: the live guess of a dictation on the phone. There the box takes the finished words only; the guess (the words the service is not sure of
// yet) is published here by the control and drawn muted under the text by the box (screens/voice/DictateLine.tsx), and is not the box's value.
const guesses = new Map<string, string>();
const listeners = new Set<() => void>();

/** Publishes the live guess of the dictation of `chat` ("" none). */
export function setDictationGuess(chat: string, text: string): void {
  if ((guesses.get(chat) ?? "") === text) return;
  if (text) guesses.set(chat, text); else guesses.delete(chat);
  for (const l of [...listeners]) l();
}

/** The live guess of the dictation of `chat`, as it changes. */
export function useDictationGuess(chat: string): string {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => guesses.get(chat) ?? "",
    () => "",
  );
}
