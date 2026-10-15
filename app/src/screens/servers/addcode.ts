// What the phone's add-server flow decides without a screen (S12, goal 4.7, AD-34): what a pasted or scanned code puts in the form, how the
// fingerprint the server presented is set against the one the text printed, and when a refusal is the local network's. The words of the
// flow are here too, so that a test and a check read them from one place. No React here.
import { parseServerCode, samePrint, suggestName, type ServerCode } from "@aiwb/core/logic/servercode.ts";
import type { ServerForm } from "@aiwb/core/logic/servers.ts";

/** Said before the first connection, where the system asks (iOS): why it will. */
export const LOCAL_NETWORK_WHY = "The first time, your phone may ask to let AI Whiteboard reach devices on your local network. Allow it: a server on your home or office network is one of them.";

/** The outcome `local_network_denied` and its message (packages/conn/core/outcomes.js; a test holds the two the same): a connection refused by the permission. */
export const LOCAL_NETWORK_DENIED = "local_network_denied";
export const LOCAL_NETWORK_DENIED_MESSAGE = "This app may not reach the local network: allow it in the system settings";
export const LOCAL_NETWORK_DENIED_HELP = "This phone has not let AI Whiteboard reach the local network, so no server there can answer. Allow it in the settings (Local Network), then test the connection again.";

export { SCAN_AIM, SCAN_CAMERA_ASK, SCAN_CAMERA_OFF } from "../../platform/scanwords.ts";

/** Whether a test's answer or a row's state is the permission's refusal: the outcome says it, and an entry's detail is the outcome's message. */
export function isLocalNetworkDenied(x: { outcome?: string; detail?: string } | null | undefined): boolean {
  return !!x && (x.outcome === LOCAL_NETWORK_DENIED || x.detail === LOCAL_NETWORK_DENIED_MESSAGE);
}

/** The form with what a code gave: the address (the one chosen, else the first), the secret, the box for a self-signed certificate (every set-up
 *  makes one), a name when there is none. The fingerprint is not put in the form: the user accepts the one the server presents, which
 *  `fingerprintLine` sets against the code's. Typed fields of the form that a code does not give stay. */
export function fillForm(f: ServerForm, code: ServerCode, which = 0): ServerForm {
  const address = code.addresses[which] ?? code.addresses[0];
  return { ...f, name: f.name.trim() ? f.name : suggestName(address), address, secret: code.secret, selfSigned: true, pin: "" };
}

/** The same form with another of the code's addresses: nothing accepted before holds for it. */
export function chooseAddress(f: ServerForm, address: string): ServerForm {
  return { ...f, address, pin: "" };
}

/** How the fingerprint the server presented stands against the one in the pasted text: "match", "differs", or "" when either is unknown. */
export function fingerprintLine(presented: string | undefined, printed: string | undefined): "match" | "differs" | "" {
  if (!presented || !printed) return "";
  return samePrint(presented, printed) ? "match" : "differs";
}

export const FP_MATCH = "It is the fingerprint the pasted text printed.";
export const FP_DIFFERS = "It is NOT the fingerprint the pasted text printed. Do not accept it: this may not be your server.";

/** What a text gave, for the flow: the form to show and what to remember of the code (not the secret), or the refusal's words. */
export type Read = { ok: true; form: ServerForm; addresses: string[]; fingerprint?: string } | { ok: false; message: string };

export function read(f: ServerForm, text: string): Read {
  const r = parseServerCode(text);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, form: fillForm(f, r.code), addresses: r.code.addresses, ...(r.code.fingerprint ? { fingerprint: r.code.fingerprint } : {}) };
}

/** What one change of the field inserted: the text between the part before and the part after the edit that the old and the new text share. */
export function inserted(was: string, now: string): number {
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  return now.length - head - tail;
}

/** A paste inserts a long text in one change of the field (at the end, in the middle, over a selection); typing inserts a character. */
export const PASTE_AT = 20;
export const isPaste = (was: string, now: string): boolean => inserted(was, now) >= PASTE_AT;
