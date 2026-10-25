// The message sheet (ux-improvements goal 3.5): which message a long press on the phone holds, where it is in the window (so the sheet can draw it
// lifted over the dimmed thread), and the label field that "Label…" starts on a message. The sheet is `MessageSheet` in the shell's `Overlays`
// slot; the long press (screens/quotes/hold.ts) opens it through here. No React here, so Node loads it.
import type { MessageButton } from "@aiwb/core/logic/forkmessage.ts";

/** Where the held message is, in the window's points. */
export type HeldRect = { x: number; y: number; width: number; height: number };
/** `rect` is null when it could not be measured: the sheet then draws no lifted message. */
export type HeldMessage = { chat: string; index: number; rect: HeldRect | null } | null;

let held: HeldMessage = null;
const heldListeners = new Set<() => void>();

/** Opens the sheet for the message at `index` of the chat's thread. */
export function openMessageSheet(m: NonNullable<HeldMessage>): void {
  held = m;
  for (const l of heldListeners) l();
}
export const closeMessageSheet = (): void => {
  if (!held) return;
  held = null;
  for (const l of heldListeners) l();
};
export const messageSheetNow = (): HeldMessage => held;
export function subscribeMessageSheet(l: () => void): () => void {
  heldListeners.add(l);
  return () => { heldListeners.delete(l); };
}

// The label field of a message: today's inline field under the message's words. It is a store so that the sheet's Label… row can start it
// in the message (fork/Message.tsx draws it).
const labeling = new Set<string>();
const labelListeners = new Set<() => void>();
const keyOf = (chat: string, index: number) => `${chat}:${index}`;
const changed = () => { for (const l of labelListeners) l(); };

export function startLabel(chat: string, index: number): void {
  if (labeling.has(keyOf(chat, index))) return;
  labeling.add(keyOf(chat, index));
  changed();
}
export function stopLabel(chat: string, index: number): void {
  if (labeling.delete(keyOf(chat, index))) changed();
}
export const isLabeling = (chat: string, index: number): boolean => labeling.has(keyOf(chat, index));
export function subscribeLabel(l: () => void): () => void {
  labelListeners.add(l);
  return () => { labelListeners.delete(l); };
}

/** The sub-line of the sheet: the message's displayed text on one line of white space, cut at about `max` characters with "…". */
export function excerpt(text: string, max = 110): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max).replace(/\s+\S*$/, "").trimEnd() || one.slice(0, max)}…`;
}

/** The sheet's words for a fork action: its row's label and the second line that says what it does. */
export function forkWords(b: Pick<MessageButton, "id">): { label: string; note: string } {
  switch (b.id) {
    case "branchEdit": return { label: "Branch and edit", note: "Change this message on a new branch" };
    case "branch": return { label: "Branch from here", note: "Continue from this reply on a new branch" };
    case "forkEdit": return { label: "Fork and edit", note: "Copy the chat before this into a new chat" };
    case "fork": return { label: "Fork to new chat", note: "Copy the chat up to here into a new chat" };
    case "label": return { label: "Label…", note: "Bookmark it to find in the chat tree" };
  }
}
