// A write refused as `unknown_client` (409): the server knows a page by its open event stream,
// and has none of this one. api.ts sees the refusal and conn.ts owns the stream; the hook between
// them is kept here, so that neither needs the other for it. DOM-free.

/** What the user reads in place of the server's code. */
export const UNKNOWN_CLIENT = "The connection to the server was interrupted. Try again in a moment.";

let hook: () => void = () => {};

/** Sets what such a refusal calls: conn.ts opens the stream again when the browser gave it up. */
export function onUnknownClient(f: () => void) { hook = f; }

/** A write was refused as `unknown_client`. */
export function unknownClient() { hook(); }

/** Whether an event stream is to be opened again after such a refusal: only one the browser
 *  closed for good (readyState 2, after an answer that is no event stream). One that is open or
 *  reconnecting is the browser's to bring back. */
export const streamGone = (es: { readyState: number } | null): boolean => !!es && es.readyState === 2;
