// What the end of a Send leaves under a chat's composer, in its box and in its thread's place.
// DOM-free: Composer.tsx and ChatView.tsx ask here.

import { FIRST_TEXT_KEPT, errShown } from "./chatserver.ts";

/** The code of a Send refused because the chat's server is not connected: nothing was sent. */
export const SERVER_UNREACHABLE = "server_unreachable";

/** Whether a failed Send's sentence is shown under the composer. connected: whether the chat's
 *  server is connected now, as the answer is handled. A Send refused because the server was not
 *  connected (503 `server_unreachable`) wakes the connection, and the news of it can be here
 *  before the refusal is: its sentence would then say what is no longer so, with nothing left to
 *  take it away (the composer drops such a sentence when the server connects, which it has). */
export const refusalShown = (status: number | undefined, code: string | undefined, connected: boolean): boolean =>
  errShown(code) && !(status === 503 && code === SERVER_UNREACHABLE && connected);

/** Whether a failed Send's message goes back into the composer. removed: the sent draft was
 *  removed on the server while the Send was on its way (what DraftSaver.sending answers):
 *  another window sent that draft, or the Send was taken after all, and the message is no draft
 *  again. But for a first message refused as `first_text_kept`: the removal is then the one of
 *  the chat's start with an earlier text, and this text was not sent. */
export const putsBack = (removed: boolean, code?: string): boolean => !removed || code === FIRST_TEXT_KEPT;

/** Whether the text of a first message stays in the thread's place (the store's `starting`) once
 *  its call has ended. taken: the server took the message; hasItems: the thread has items. It
 *  stays only after a call that was taken, until the thread read again has the message; while the
 *  call runs nothing tells that it was refused, which counts as taken. */
export const startingAfter = (taken: boolean, hasItems: boolean): boolean => taken && !hasItems;
