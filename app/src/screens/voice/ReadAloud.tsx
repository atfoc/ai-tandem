// Read aloud on a message (VC-24, goal 3.3): `useReadAloud`, the chat view's part that gives a message its action, and the problem popover
// that hangs from the message's control. The fork actions (screens/fork/Message.tsx) draw the action in their bar and their "⋯" menu; the
// reading itself is the engine's (`voice.readAloud`), which stops whatever else is playing first. A reply still being written has none.
import { useRef } from "react";
import type { RefObject } from "react";
import type { View } from "react-native";

import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useReading, voice } from "../../voice/index.ts";
import { READ_ALOUD, READ_STOP } from "../../voice/words.ts";
import type { ReadAloudAction } from "../chat/parts.tsx";
import { ProblemPopover } from "./ProblemPopover.tsx";

/** The id a message's Read aloud gives the engine, and the problem popover is hung by (it is also the engine's key of the message being read). */
export const readAnchor = (chat: string, branch: string, index: number): string => `read:${chat}:${branch}:${index}`;

/** The message's Read aloud action, or null where there is nothing to say (no words, or a reply still being written). Called for every message. */
export function useReadAloud(chat: ChatView, branch: string, index: number, item: Item): ReadAloudAction | null {
  const anchor = useRef<View>(null);
  const id = readAnchor(chat.id, branch, index);
  const reading = useReading().key === id;
  const text = item.kind === "user" || item.kind === "text" ? item.text ?? "" : "";
  const writing = item.kind === "text" && !item.done && chat.status === "writing";
  if (!text.trim() || writing) return null;
  const run = () => {
    if (reading) voice.stopReading();
    else void voice.readAloud({ chat: chat.id, branch, index, text, anchor: id });
  };
  return { reading, title: reading ? READ_STOP : READ_ALOUD, run, anchor };
}

/** The popover of a failed Read aloud (no key, a refusal, no network), hung from the message's control `target`. */
export function ReadAloudProblem({ chat, branch, index, target }: { chat: string; branch: string; index: number; target: RefObject<View | null> }) {
  return <ProblemPopover anchor={readAnchor(chat, branch, index)} target={target} align="right" />;
}
