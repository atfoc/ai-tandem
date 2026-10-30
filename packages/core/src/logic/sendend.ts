// What the end of a Send leaves under a chat's composer and in its box. DOM-free: Composer.tsx asks here.

/** The text a Send sends of what the box holds: the blank lines before the first line with something on it and the whitespace at the
 *  end are taken off, the first line's indent is kept (code pasted or typed indented goes as it is). "" for a box of whitespace only: the
 *  message is blank then, and is sent only with quotes or images. */
export const sentText = (text: string): string => text.replace(/^(?:[ \t]*(?:\r\n|\n|\r))+/, "").trimEnd();

/** The code of a Send refused because the chat's server is not connected: nothing was sent. */
export const SERVER_UNREACHABLE = "server_unreachable";

/** Whether a failed Send's answer tells that the message was not taken, so that the server removed
 *  no draft for it (what the saver is told, DraftSaver.sending): any refusal below 500, and the 503
 *  of a chat whose server is not connected, for which nothing was sent. Another 5xx may hide a
 *  message that was taken (504 `send_unknown`: it was sent, and no answer came). */
export const sentNothing = (status: number | undefined, code?: string): boolean =>
  (status !== undefined && status < 500) || code === SERVER_UNREACHABLE;

/** Whether a failed Send's answer tells that the chat is no longer on its server: 404 with the code `not_found`. The page then shows the chat as no longer on that server, as it does when a read of
 *  it is answered so. Another 404 is of a part of the chat (`no_branch`), and says nothing of the chat. */
export const goneBySend = (code?: string): boolean => code === "not_found";

/** Whether a failed Send's sentence is shown under the composer. connected: whether the chat's
 *  server is connected now, as the answer is handled. A Send refused because the server was not
 *  connected (503 `server_unreachable`) wakes the connection, and the news of it can be here
 *  before the refusal is: its sentence would then say what is no longer so, with nothing left to
 *  take it away (the composer drops such a sentence when the server connects, which it has). */
export const refusalShown = (status: number | undefined, code: string | undefined, connected: boolean): boolean =>
  !(status === 503 && code === SERVER_UNREACHABLE && connected);

/** Whether a failed Send's message goes back into the composer. removed: the sent draft was
 *  removed on the server while the Send was on its way (what DraftSaver.sending answers):
 *  another window sent that draft, or the Send was taken after all (a first message too, whose
 *  answer never came), and the message is no draft again. */
export const putsBack = (removed: boolean): boolean => !removed;

/** The line under a chat's composer: the sentence of the last refusal (err), else the chat's own
 *  error; "" for none. */
export const underComposer = (err: string, c: { status?: string; error?: string }): string =>
  err || (c.status === "error" && c.error) || "";
