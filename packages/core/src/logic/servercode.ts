// What a phone takes to add a server (goal 4.7): the text the server's machine printed, pasted, or the same text in a QR code
// (scripts/server-code.sh), read into an address, a secret and the fingerprint to compare. The server prints it already: the output of
// `setup-remote.sh` (Port, Names, Fingerprint, the addresses one to a line, "Secret: …") or of `ai-whiteboard remote setup` (no secret),
// and the secret of `ai-whiteboard secret` (a line of 64 hex digits). Nothing is weaker than typing the fields: an address is https
// with the rules of `validAddress`, the secret has the form's rule, and a fingerprint is only a line to compare: the user still accepts it.
// A text that cannot be read whole is refused with its reason in words and nothing of it is used. The words never repeat the secret.
import { validAddress, validHost } from "./servers.ts";

/** What a text gave: every address it names, in its order; the fingerprint it prints, if any; the secret. */
export type ServerCode = { addresses: string[]; secret: string; fingerprint?: string };

export type CodeProblem = "empty" | "too_long" | "no_address" | "plain_http" | "bad_address" | "no_secret" | "bad_secret" | "two_secrets"
  | "bad_fingerprint" | "two_fingerprints" | "not_a_code";

export type CodeResult = { ok: true; code: ServerCode } | { ok: false; reason: CodeProblem; message: string };

/** The longest text read: setup-remote.sh prints about a kilobyte, with a dozen addresses it is three. */
export const CODE_LIMIT = 8000;

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const SERVER_SECRET = /^[0-9a-f]{64}$/;
const URL_TOKEN = /\bhttps?:\/\/[^\s"'<>]+/gi;

const no = (reason: CodeProblem, message: string): CodeResult => ({ ok: false, reason, message });

const PARTIAL = "The secret is missing. `remote setup` does not print it: run setup-remote.sh, which prints the address, the fingerprint and the secret, or "
  + "run `ai-whiteboard secret` and paste its line with the rest.";

/** The value after a label at the start of a line ("Secret: …"), or null. */
function labelled(line: string, label: string): string | null {
  const m = new RegExp(`^\\s*${label}\\s*:\\s*(.*?)\\s*$`, "i").exec(line);
  return m ? m[1] : null;
}

const clean = (url: string) => url.replace(/[.,;)\]]+$/, "").replace(/\/$/, "");

/** Reads a pasted or scanned text; see the top of the file for what it takes. */
export function parseServerCode(text: string): CodeResult {
  const all = String(text ?? "");
  if (!all.trim()) return no("empty", "Nothing to read: paste what the server printed, or scan its code.");
  if (all.length > CODE_LIMIT) return no("too_long", "That is too long to be what a server printed.");
  const lines = all.replace(/\r\n?/g, "\n").split("\n");

  const secrets: string[] = [], prints: string[] = [], names: string[] = [];
  let port = "";
  let labelledOne = false;
  for (const line of lines) {
    const s = labelled(line, "Secret"), f = labelled(line, "Fingerprint"), p = labelled(line, "Port"), n = labelled(line, "Names");
    if (s !== null) { labelledOne = true; if (s) secrets.push(s); }
    if (f !== null) { labelledOne = true; if (f) prints.push(f); }
    if (p !== null) { labelledOne = true; port = p; }
    if (n !== null) { labelledOne = true; names.push(...n.split(",").map((x) => x.trim()).filter(Boolean)); }
  }

  const urls = (all.match(URL_TOKEN) ?? []).map(clean);
  if (urls.some((u) => /^http:/i.test(u))) return no("plain_http", "That has an http address. The app connects over https only: use the https address the server printed.");
  const addresses: string[] = [];
  for (const u of urls) {
    if (!validAddress(u)) return no("bad_address", "That has an address the app cannot take. It must be https://host:port, a name or an IPv4 address and a port.");
    if (!addresses.includes(u)) addresses.push(u);
  }
  // `remote setup` alone prints the port and the names, not the addresses.
  if (!addresses.length && names.length && /^[0-9]+$/.test(port)) {
    for (const n of names) {
      const u = `https://${n}:${port}`;
      if (!validHost(n.toLowerCase()) || !validAddress(u)) return no("bad_address", "That has a name the app cannot take in an address.");
      if (!addresses.includes(u)) addresses.push(u);
    }
  }

  // The secret: "Secret: …", else a line of 64 hex digits (the line of `ai-whiteboard secret`), else "address secret" and nothing else.
  if (!secrets.length) {
    for (const line of lines) if (SERVER_SECRET.test(line.trim())) secrets.push(line.trim());
  }
  if (!secrets.length && !labelledOne && urls.length === 1) {
    const rest = all.replace(URL_TOKEN, " ").split(/\s+/).filter(Boolean);
    if (rest.length === 1) secrets.push(rest[0]);
  }

  if (!addresses.length) {
    if (!labelledOne && !secrets.length) return no("not_a_code", "That is not what a server prints. Paste the output of setup-remote.sh, or scan the code that scripts/server-code.sh shows.");
    return no("no_address", "No server address in that text: an address looks like https://host:4748.");
  }
  if (new Set(secrets).size > 1) return no("two_secrets", "That text has two different secrets. Paste what one server printed.");
  if (!secrets.length) return no("no_secret", PARTIAL);
  const secret = secrets[0];
  if (secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret)) return no("bad_secret", "The secret in that text has spaces or is longer than 256 characters: it cannot be a server's.");

  const fingerprints = [...new Set(prints.map((f) => f.toUpperCase()))];
  if (fingerprints.length > 1) return no("two_fingerprints", "That text has two different fingerprints. Paste what one server printed.");
  if (fingerprints.length && !FINGERPRINT.test(fingerprints[0])) return no("bad_fingerprint", "The fingerprint in that text is not 32 pairs of hex digits like AB:CD:EF:….");
  return { ok: true, code: { addresses, secret, ...(fingerprints.length ? { fingerprint: fingerprints[0] } : {}) } };
}

/** A name for the entry from its address: the first label of a DNS name, an IPv4 address whole. "" when the address is none. */
export function suggestName(address: string): string {
  const host = /^https:\/\/([^/:]+)/i.exec(address.trim())?.[1] ?? "";
  if (/^[0-9.]+$/.test(host)) return host;
  return host.split(".")[0] ?? "";
}

/** The text a server code holds (scripts/server-code.sh makes it, a QR code carries it): what the parser needs and no more.
 *  The fixtures of the tests hold it too, so the script and the parser cannot drift. */
export function codeText(code: ServerCode): string {
  return ["Addresses:", ...code.addresses.map((a) => `  ${a}`), ...(code.fingerprint ? [`Fingerprint: ${code.fingerprint}`] : []), `Secret: ${code.secret}`, ""].join("\n");
}

/** Whether the fingerprint a server presented is the one the pasted text printed: both are 32 hex pairs, compared without ":" and case. */
export function samePrint(a: string, b: string): boolean {
  const flat = (s: string) => s.replace(/[:\s]/g, "").toUpperCase();
  return flat(a) !== "" && flat(a) === flat(b);
}
