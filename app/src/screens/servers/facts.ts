// What the phone's server screens decide without drawing (package S2; goal 3.8.2–3.8.4): the list's order and rows, a fingerprint in
// 16 blocks of 4, the status header's second line, why a server cannot be reached and what to try, and the words of the screens, so a
// test and a check read them from one place. No React here, so Node loads it (app/test/serverfacts.test.ts).
//
// Contract of package S2 (its lead fixed the signatures; chunk S2-1 made them real).
import { formatSince, serverWord, type StateWord } from "@aiwb/core/logic/statewords.ts";
import { stepText, type ServerView, type TestResult } from "@aiwb/core/logic/servers.ts";

/** The rows of the Servers list: A–Z by name (case- and accent-insensitive, `localeCompare` with sensitivity "base"), ties by id; no
 *  group of problems first (goal 4.1 item 19). */
export function sortedServers(list: readonly ServerView[]): ServerView[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The host of an address, as a row's second line says it: "https://build-box.example:4790" → "build-box.example"; "" when there is
 *  none or it cannot be read. */
export function hostOf(address: string | undefined): string {
  if (!address) return "";
  try {
    return new URL(address).hostname;
  } catch {
    return "";
  }
}

/** What follows the state word on a row's second line. A connected or connecting server says its host (`mono`, the way an address is
 *  written); a server with a problem says the reason instead, in the normal type: why it cannot be reached (what its entry says of the
 *  failure, lower case), "update it" when too old, "allow it in Settings" when iOS refused the local network. A certificate that changed
 *  has it all in its word ("Certificate changed · paused"); a failure the entry does not explain says nothing. `text` is "" when there
 *  is nothing to add. */
export function rowLine(v: Pick<ServerView, "state" | "address" | "detail">, word: Pick<StateWord, "key" | "tone"> & { reason?: string }): { text: string; mono: boolean } {
  switch (word.key) {
    case "connected":
    case "connecting": return { text: hostOf(v.address), mono: true };
    case "cert-changed": return { text: "", mono: false };
    case "too-old": return { text: "update it", mono: false };
    case "local-network-off": return { text: "allow it in Settings", mono: false };
    default: return { text: lowered(word.reason) || lowered(whyReason(v)), mono: false };
  }
}

/** A reason as a row's line says it: lower case at its start ("Connection refused" → "connection refused"), unless the second letter
 *  is a capital too (an acronym such as "TLS"), and short enough for a row. */
function lowered(s: string | undefined): string {
  const t = (s ?? "").trim().replace(/[.:]$/, "");
  if (!t || t.length > 36) return "";
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

/** The tile of a server's row and header: "ok" (the accent's tile), "bad" (a red tile with "!"), "warn" (an amber tile with "!"),
 *  "cert" (a red tile with a shield), "wait" (grey). From the server's word. */
export type TileKind = "ok" | "bad" | "warn" | "cert" | "wait";
export function tileOf(word: Pick<StateWord, "key" | "tone">): TileKind {
  if (word.key === "cert-changed") return "cert";
  return word.tone;
}

const PAIRS = /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/i;
const PLAIN = /^[0-9a-f]{64}$/i;

/** The 32 pairs of a fingerprint, upper case; [] when it is not 32 pairs ("AB:CD:…", or 64 hex digits without colons). */
function pairsOf(fp: string | undefined): string[] {
  const t = fp?.trim() ?? "";
  if (PAIRS.test(t)) return t.toUpperCase().split(":");
  if (PLAIN.test(t)) return t.toUpperCase().match(/../g) ?? [];
  return [];
}

/** A fingerprint ("AB:CD:…", 32 pairs) as 16 blocks of 4 hex digits, upper case ("ABCD", …); [] when it is not 32 pairs. */
export function fpBlocks(fp: string | undefined): string[] {
  const p = pairsOf(fp);
  if (!p.length) return [];
  const out: string[] = [];
  for (let i = 0; i < p.length; i += 2) out.push(p[i] + p[i + 1]);
  return out;
}

/** A fingerprint shortened for a cell: the first two blocks and the last ("3F9A 0C21 … 7E4D"); "" when it is not 32 pairs. */
export function fpShort(fp: string | undefined): string {
  const b = fpBlocks(fp);
  return b.length ? `${b[0]} ${b[1]} … ${b[b.length - 1]}` : "";
}

/** The first and last pairs of a fingerprint as the server prints them, for the trust confirm: "8B:47:1E:C2 … 4B:88" (the first four
 *  pairs, then the last two); "" when it is not 32 pairs. */
export function fpEnds(fp: string | undefined): string {
  const p = pairsOf(fp);
  return p.length ? `${p.slice(0, 4).join(":")} … ${p.slice(-2).join(":")}` : "";
}

/** The status header's second line. `checkedAt` = when this screen's last test answered (epoch ms) or null; `since` = when the state
 *  began (State.serverSince) or undefined. A test seen within the last minute reads "Checked just now", an older one "Checked at 9:12";
 *  with no test, the state's start: "Connected since 9:12", "Unreachable since yesterday" (formatSince of @aiwb/core/logic/statewords.ts,
 *  after the word's text); "" when nothing is known. Never a time the app does not know (goal 4.6). */
export function sinceLine(word: Pick<StateWord, "text">, checkedAt: number | null, since: number | undefined, now: number): string {
  if (checkedAt !== null) {
    if (now - checkedAt <= 60_000) return "Checked just now";
    const d = new Date(checkedAt);
    return `Checked at ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (since !== undefined) return `${word.text} ${formatSince(since, now)}`;
  return "";
}

/** A test's answer in one line under "Test connection": "✓ Reached in 120 ms · version 1.8.2" when it passed (`ms` = how long the
 *  call took, measured by the app; left out when null), else "✕ Step 2 of 5: the connection · <the answer's message>". */
export function testLine(r: TestResult, ms: number | null): { ok: boolean; text: string } {
  if (r.ok) {
    return { ok: true, text: ["✓ Reached" + (ms === null ? "" : ` in ${Math.round(ms)} ms`), r.version ? `version ${r.version}` : ""].filter(Boolean).join(" · ") };
  }
  return { ok: false, text: ["✕", [stepText(r.step), r.message].filter(Boolean).join(" · ")].filter(Boolean).join(" ") };
}

/** Why a server cannot be reached and what to try (the Unreachable detail, dl-03d): a heading, the failed step in plain words, and
 *  numbered steps. From the last test's answer when there is one (its `outcome` and `step`), else from the entry's own state and
 *  `detail`. Every outcome of packages/conn/core/outcomes.js that a saved server can end in has its words; any other reads the
 *  answer's message with the generic steps. The steps always end with "Test again. Its chats come back by themselves." */
export type Why = { title: string; body: string; tries: string[] };

const TEST_AGAIN = "Test again. Its chats come back by themselves.";

/** The outcomes of packages/conn/core/outcomes.js that have words here, with the step and the message of its table (a test holds
 *  them equal to the table). `say` = the plain sentence after the step; `port` = the address's port, "its port" when it has none. */
type Words = { step: number; message: string; title: string; say: (port: string) => string; tries: string[] };
export const WHY_OUTCOMES: Record<string, Words> = {
  refused: {
    step: 2, message: "Nothing listens there: is the server running on that machine?", title: "Connection refused",
    say: (port) => `the machine answered, but no server listens on ${port === "its port" ? port : `port ${port}`}. It is probably stopped`,
    tries: ["Start the server on that machine (open the app there, or run ai-whiteboard launch)."],
  },
  name_not_found: {
    step: 2, message: "Name not found", title: "Name not found",
    say: () => "nothing knows the name in the address. It may have a typo, or it only exists on the server's own network",
    tries: ["Check the name in the address (Edit).", "If the name only works on the server's network, join that network or its VPN."],
  },
  no_route: {
    step: 2, message: "No answer: is the VPN up?", title: "No answer from the machine",
    say: () => "this phone found no way to reach the machine. It may be off, or on another network",
    tries: ["Join the same network as the server, or turn on the VPN that reaches it.", "Check that the machine is on."],
  },
  local_network_denied: {
    step: 2, message: "This app may not reach the local network: allow it in the system settings", title: "Local network is off",
    say: () => "this phone does not let AI Whiteboard reach devices on your local network",
    tries: ["Open Settings, find AI Whiteboard and allow Local Network."],
  },
  tls_timeout: {
    step: 3, message: "No answer: is the VPN up, and does a firewall on the server's machine let the port through?", title: "The connection timed out",
    say: () => "the secure handshake got no answer in time. The VPN may be down, or a firewall blocks the port",
    tries: ["Turn on the VPN, if the server is behind one.", "Check that the firewall on the server's machine lets the port through."],
  },
  secret_refused: {
    step: 4, message: "Secret not accepted", title: "Secret not accepted",
    say: () => "the server refused the secret. It was probably changed on the server",
    tries: ["Run setup-remote.sh on the server to make a new code.", "Add the server again from that code."],
  },
  bad_host: {
    step: 4, message: "The server does not know this name: run set-up there with it", title: "The server does not know this name",
    say: () => "the server answered, but it was not set up for the name in the address",
    tries: ["Run setup-remote.sh on the server with the name this address uses.", "Or change the address to a name the server knows (Edit)."],
  },
  not_aiwb: {
    step: 4, message: "Something else answers there", title: "Not an AI Whiteboard server",
    say: () => "something answers at this address, but it is not AI Whiteboard",
    tries: ["Check the address and its port (Edit).", "Run server-code.sh on the server and scan its code."],
  },
  another_server: {
    step: 4, message: "Another server answers at this address", title: "Another server answers here",
    say: () => "a different AI Whiteboard server answers at this address than the one added",
    tries: ["Check that the address is this server's.", "If the server was replaced, remove it here and add it again."],
  },
  no_answer: {
    step: 4, message: "No answer from the server", title: "No answer from the server",
    say: () => "the server did not answer. It may be busy or still starting",
    tries: ["Check that the server runs (open the app there, or run ai-whiteboard launch).", "Wait a minute, in case it is starting."],
  },
  too_old: {
    step: 4, message: "Server too old: update it on that machine", title: "Server too old",
    say: () => "the server runs an older version than this app talks to",
    tries: ["Update AI Whiteboard on that machine: install the new version there and start it."],
  },
};

/** The outcome an entry's own state and detail point to, or "" when they point to none. */
function outcomeOfEntry(v: Pick<ServerView, "state" | "detail">): string {
  switch (v.state) {
    case "secret_not_accepted": return "secret_refused";
    case "name_not_known": return "bad_host";
    case "not_aiwb": return "not_aiwb";
    case "another_server": return "another_server";
    case "too_old": return "too_old";
    case "unreachable": {
      const d = (v.detail ?? "").trim().toLowerCase();
      if (!d) return "";
      for (const [k, w] of Object.entries(WHY_OUTCOMES)) if (w.message.toLowerCase() === d) return k;
      if (d.includes("refused")) return "refused";
      if (d.includes("not found")) return "name_not_found";
      if (d.includes("timed out") || d.includes("timeout")) return "tls_timeout";
      if (d.includes("local network")) return "local_network_denied";
      return "";
    }
    default: return "";
  }
}

/** The short reason an unreachable entry's detail points to ("Connection refused"), else its detail as it is. */
function whyReason(v: Pick<ServerView, "state" | "detail">): string {
  const k = outcomeOfEntry(v);
  return Object.hasOwn(WHY_OUTCOMES, k) ? WHY_OUTCOMES[k].title : (v.detail ?? "");
}

function portOf(address: string | undefined): string {
  try {
    return (address && new URL(address).port) || "its port";
  } catch {
    return "its port";
  }
}

export function whyOf(v: ServerView, r: TestResult | null): Why {
  const failed = r && !r.ok ? r : null;
  const key = failed ? failed.outcome : outcomeOfEntry(v);
  const w = Object.hasOwn(WHY_OUTCOMES, key) ? WHY_OUTCOMES[key] : undefined;
  if (w) {
    const step = stepText(w.step).replace(": ", ", ");
    return { title: w.title, body: `${step}: ${w.say(portOf(v.address))}.`, tries: [...w.tries, TEST_AGAIN] };
  }
  const detail = v.detail ? v.detail[0].toUpperCase() + v.detail.slice(1) : "";
  return {
    title: failed?.message || serverWord(v).reason || detail || "Unreachable",
    body: failed ? stepText(failed.step) : "",
    tries: ["Check that the server runs and that this phone reaches its network.", TEST_AGAIN],
  };
}

/** Too old (amber): both versions and how to update. `app` = this app's version (core `pageVersion()`), `server` = the entry's. */
export function tooOldText(name: string, server: string | undefined, app: string): { versions: string; how: string } {
  return {
    versions: `${name} runs ${server ?? "an older version"}; this app is ${app}`,
    how: `Update AI Whiteboard on ${name} (install the new version there and start it), then test again.`,
  };
}

/** The P4 of "Remove server…": title, body and the button's words (dl-03c). */
export function removeWords(name: string): { title: string; body: string; confirm: string } {
  return {
    title: `Remove “${name}”?`,
    body: `Its section leaves your list. Nothing is deleted or stopped on ${name}: its chats and whiteboards stay there, and you can add it again.`,
    confirm: `Remove ${name}`,
  };
}

/** The words of the screens that a check reads (the board's, verbatim). */
export const WORDS = {
  listFoot: "A server is AI Whiteboard running on another computer. Its chats and boards show in your list under its name; nothing of them is stored on this phone.",
  testFoot: "Checks the address, the certificate and the secret, in five steps; a failure names the step.",
  removeFoot: (name: string) => `Its chats and boards stay on ${name}.`,
  certTitle: "The server's certificate changed",
  certBody: (name: string) => `${name} answered with a certificate this phone has not seen.`,
  certRenewed: "Expected if it was reinstalled or its certificate renewed.",
  certPosing: (name: string) => `Not expected? Someone between this phone and ${name} may be posing as it.`,
  certPaused: (name: string) => `Until you decide, this phone sends nothing to ${name}: no secret, no message. Its chats wait in your list.`,
  compareSub: "A minute, with access to the server",
  command: "ai-whiteboard remote status",
  commandNote: (pairs: string) => `It prints Fingerprint: ${pairs}… : the same digits, in pairs.`,
  trustTitle: (name: string) => `Trust the new certificate of “${name}”?`,
  trustBody: (name: string, ends: string) => `Only if ${name} itself printed ${ends}. This phone then sends its secret to it again, and its chats come back.`,
  addTitle: "Add a server",
  addSub: "Run setup-remote.sh on the server first",
  scanTitle: "Scan the server's code",
  scanHint: "On the server, run server-code.sh. Its code holds the address, the secret and the certificate's fingerprint.",
  filled: "Filled in from the code. Check the name, then test.",
  localNetTitle: "iOS will ask about your local network",
  localNetBody: (name: string) => `When you test, iOS asks to let AI Whiteboard find devices on your local network. Choose Allow: ${name} is on it.`,
  nothingSent: "Nothing secret is sent until the server's certificate matches the code.",
  matches: "Matches the fingerprint in the code",
  mismatch: "Does NOT match the code — do not trust it",
  mismatchWhy: (host: string, name: string) => `This may not be your server: something between this phone and ${host} answers in its place. Nothing secret was sent. Check that you scanned ${name}'s code, on ${name}'s network.`,
  trustFoot: (name: string) => `This phone will trust this certificate for ${name}, and no other.`,
  added: (name: string) => `${name} added · its chats are in your list`,
} as const;
