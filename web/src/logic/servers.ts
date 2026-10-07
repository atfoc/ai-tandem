// The list of servers this app connects to (the Servers dialog): the shapes the local server
// sends, and what the dialog shows and offers for them. The local server holds the list and
// the secrets; the page never gets a secret back.

/** The state of one entry's connection, as the local server holds it. */
export type ServerState = "connecting" | "connected" | "unreachable" | "secret_not_accepted" | "fingerprint_not_accepted" | "certificate_changed"
  | "certificate_not_accepted" | "name_not_known" | "not_aiwb" | "too_old" | "another_server";

/** One entry of the list. pin = the accepted fingerprint; fingerprint = the one the server presented when the pin refused it. */
export type ServerView = { id: string; local?: boolean; name: string; address?: string; selfSigned?: boolean; pin?: string; instanceId?: string;
  state: ServerState; detail?: string; fingerprint?: string; version?: string; agents?: string[] };

/** The answer of "Test connection". pinned = the fingerprint the entry holds, with the outcome "cert_changed". */
export type TestResult = { ok: boolean; step: number; outcome: string; message: string; detail?: string; fingerprint?: string; pinned?: string;
  version?: string; instanceId?: string; agents?: string[] };

/** The add and edit form. id = the entry edited; without it the form adds one. */
export type ServerForm = { id?: string; name: string; address: string; secret: string; selfSigned: boolean; pin: string };

/** The entry for the server the page talks to: always first, never edited or removed. */
export const LOCAL_ENTRY: ServerView = { id: "local", local: true, name: "This computer", state: "connected" };

/** A snapshot's list; a server that sends none has the local entry alone. */
export function serversOf(s: { servers?: ServerView[] | null }): { servers: ServerView[] } {
  return { servers: s.servers?.length ? s.servers : [LOCAL_ENTRY] };
}

/** The list with this entry in the place of the one with its id, or at the end. */
export function upsertServer(list: ServerView[], v: ServerView): ServerView[] {
  return list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v];
}

/** The list with this entry at the end when it has none with its id; an entry it has stays as it is.
 *  For the answer of an add, an edit or an accept: its view is as old as the request, and the
 *  stream's events (`servers`, `server_state`) may have put a newer one there already. */
export function insertServer(list: ServerView[], v: ServerView): ServerView[] {
  return list.some((x) => x.id === v.id) ? list : [...list, v];
}

const STATE_LABELS: Record<ServerState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  unreachable: "Unreachable",
  secret_not_accepted: "Secret not accepted",
  fingerprint_not_accepted: "Fingerprint not accepted",
  certificate_changed: "Certificate changed",
  certificate_not_accepted: "Certificate not accepted",
  name_not_known: "Name not known there",
  not_aiwb: "Not an AI Whiteboard server",
  too_old: "Too old: update the server on that machine",
  another_server: "Another server",
};

export function stateLabel(s: ServerState): string { return STATE_LABELS[s] ?? String(s); }

/** The five steps of "Test connection", by the answer's `step`. */
const STEP_NAMES = ["the address", "the connection", "the certificate", "the secret and the server's answer", "the first events"];

/** The line for the step a test failed at ("Step 3 of 5: the certificate"), or "" for a step that is none of the five. */
export function stepText(step: unknown): string {
  const name = typeof step === "number" ? STEP_NAMES[step - 1] : undefined;
  return name ? `Step ${step} of ${STEP_NAMES.length}: ${name}` : "";
}

export type RowAction = "test" | "edit" | "remove" | "accept" | "showFingerprint";

/** The buttons of a row. The local entry has none. No state offers a way to connect past a refusal:
 *  accept is for a certificate alone, with the fingerprint the server presented ("accept") or after
 *  reading it ("showFingerprint"). */
export function rowActions(v: ServerView): RowAction[] {
  if (v.local) return [];
  const all: RowAction[] = ["test", "edit", "remove"];
  if (v.state === "certificate_changed") return [v.fingerprint ? "accept" : "showFingerprint", ...all];
  if (v.state === "fingerprint_not_accepted") return ["showFingerprint", ...all];
  return all;
}

/** Whether s is a host the local server takes (remote.NormalName): an IPv4 literal or a DNS name, [a-z0-9.-] after
 *  lower-casing, 253 characters at most, no dot or hyphen at either end and no "..". */
export function validHost(s: string): boolean {
  return s.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s) && !s.includes("..");
}

/** Whether s is an address the local server takes (servers.ParseAddress): https, such a host, a port of 1 to 65535, a path of "" or "/". */
export function validAddress(s: string): boolean {
  const m = /^https:\/\/([^/:]+):([0-9]+)\/?$/i.exec(s.trim());
  return !!m && validHost(m[1]) && +m[2] >= 1 && +m[2] <= 65535;
}

/** "" or the form's first problem. The local server checks the same again; in an edit an empty secret keeps the stored one. */
export function formError(f: ServerForm): string {
  const name = f.name.trim();
  if (!name) return "Give the server a name";
  if (name.length > 80) return "The name is too long (80 characters at most)";
  if (!validAddress(f.address)) return "Not a valid https address (https://host:port)";
  const secret = f.secret.trim();
  if (!secret) return f.id ? "" : "Enter the secret";
  if (secret.length > 256 || !/^[\x21-\x7e]+$/.test(secret)) return "The secret has no spaces and 256 characters at most";
  return "";
}

/** What the form offers: Save, "Save anyway", a fingerprint to accept, and the test's result.
 *  force = Save sends what "Save anyway" sends: the edit changes the name alone, so there is nothing to test. */
export type FormView = { canSave: boolean; saveAnyway: boolean; force?: true; accept?: string; message?: string; detail?: string; pinned?: string };

/** What a row shows of a test's answer: the row's own lines already say the rest. message = the answer's, when the row
 *  does not say it; step = the line of a failed test's step;
 *  ownCert = whether the row keeps its own fingerprint lines (the answer's replace them when it has one to accept). */
export type RowResult = { message?: string; step: string; detail?: string; version?: string; agents?: string[]; accept?: string; pinned?: string; ownCert: boolean };

/** Each fact once: the answer's message, detail, version and agents are left out when the entry's line says the same (the
 *  message: its state's label or its detail), and the entry's fingerprint lines when the answer shows the fingerprints. */
export function rowResult(v: ServerView, r: TestResult | null): RowResult {
  if (!r) return { step: "", ownCert: true };
  const out: RowResult = { step: r.ok ? "" : stepText(r.step), ownCert: true };
  if (r.message && r.message !== stateLabel(v.state) && r.message !== v.detail) out.message = r.message;
  if (r.detail && r.detail !== v.detail) out.detail = r.detail;
  if (r.version && r.version !== v.version) out.version = r.version;
  const agents = Array.isArray(r.agents) ? r.agents.map(String) : [];
  if (agents.length && agents.join("\n") !== (Array.isArray(v.agents) ? v.agents.map(String) : []).join("\n")) out.agents = agents;
  if ((r.outcome === "fingerprint" || r.outcome === "cert_changed") && r.fingerprint) {
    out.accept = r.fingerprint;
    const pinned = r.pinned || v.pin; // the fingerprint accepted so far, which the answer's block shows beside the new one
    if (pinned) out.pinned = pinned;
    out.ownCert = false;
  }
  return out;
}

/** The heading of a row's test block: the answer's message when the row does not say it, or whether the test passed. */
export function resultHeading(shown: RowResult, ok: boolean): string {
  return shown.message ?? (ok ? "Test passed" : "Test failed");
}

/** A test's answer a row holds, with the state the entry had when the answer came. */
export type HeldResult = { result: TestResult; state: ServerState };

/** The answer the row still shows: none once the entry's state is another than the one the answer came under. */
export function heldResult(held: HeldResult | null, state: ServerState): TestResult | null {
  return held && held.state === state ? held.result : null;
}

const sameForm = (a: ServerForm, b: ServerForm) =>
  (a.id ?? "") === (b.id ?? "") && a.name === b.name && a.address === b.address && a.secret === b.secret && a.selfSigned === b.selfSigned && a.pin === b.pin;

/** The outcomes no "save anyway" gets past: the address cannot be dialed, or the server there is one that cannot be added. */
const NO_SAVE_ANYWAY = ["bad_address", "is_local", "duplicate", "another_server"];

/** Whether an edit changes the name alone against the saved entry: the address, the secret (empty keeps the stored one),
 *  the self-signed box and the fingerprint are as saved. */
const nameOnly = (f: ServerForm, saved: ServerForm) =>
  !!f.id && f.id === saved.id && f.name.trim() !== saved.name.trim() && f.address === saved.address && !f.secret && f.selfSigned === saved.selfSigned && f.pin === saved.pin;

/** tested = the form as it was when the test that gave r ran. A result of another form counts as no test.
 *  saved = the edit form as it opened (the saved entry): a valid new name alone is saved without a test,
 *  since nothing about the connection changed. */
export function formView(f: ServerForm, tested: ServerForm | null, r: TestResult | null, saved?: ServerForm | null): FormView {
  const valid = !formError(f);
  const res = r && tested && sameForm(f, tested) ? r : null;
  const rename = valid && !!saved && nameOnly(f, saved);
  if (!res) return rename ? { canSave: true, saveAnyway: false, force: true } : { canSave: false, saveAnyway: valid };
  const v: FormView = rename ? { canSave: true, saveAnyway: false, force: true, message: res.message }
    : { canSave: valid && res.ok, saveAnyway: valid && !res.ok && !NO_SAVE_ANYWAY.includes(res.outcome), message: res.message };
  if (res.detail) v.detail = res.detail;
  if ((res.outcome === "fingerprint" || res.outcome === "cert_changed") && res.fingerprint) {
    v.accept = res.fingerprint;
    if (res.pinned) v.pinned = res.pinned;
  }
  return v;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The question before an entry is removed. */
export function removeText(name: string, chats: number, runs: number): string {
  return `Remove "${name}"? It has ${count(chats, "chat")} and ${count(runs, "run")} in this app. They are removed from this app; nothing is deleted or stopped on that server.`;
}

/** Whether the sidebar's button shows its dot. */
export function anyNotConnected(list: ServerView[]): boolean { return list.some((v) => v.state !== "connected"); }
