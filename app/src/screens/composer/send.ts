// Sending (the old page's Composer.tsx sendMessage): plain chats send the text alone; board chats send the <ui-context> with it. Quotes and images
// go with both. With a pending move the message goes to its point (the target), and a Send that succeeded ends the move. The text, the
// quotes and the images are told to sendAt as well: the thread shows the message while one that starts a new branch, or a fork's first one,
// is on its way. The first message of a chat on another server is an ordinary Send, as any other. No React here.
import { api } from "@aiwb/core/api.ts";
import type { Picked } from "@aiwb/core/logic/mentions.ts";
import { sendAt } from "@aiwb/core/state/actions.ts";
import { getState, isLegacy } from "@aiwb/core/state/store.ts";
import type { ChatImage, Reference } from "@aiwb/core/types.ts";

import { boardApp } from "../shell/boardside.ts";

export async function sendMessage(chat: string, text: string, picked: Picked[] = [], references: Reference[] = [], images: ChatImage[] = []): Promise<unknown> {
  const c = getState().chats[chat];
  if (isLegacy(c)) return;
  const context = c?.board ? boardApp.buildContext(chat, text, picked) : "";
  return sendAt(chat, (branch, target) => api.send(chat, branch, text, context, references, target, images),
    { text, references, ...(images.length ? { images } : {}) });
}
