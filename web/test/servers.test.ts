// The Servers dialog's logic (src/logic/servers.ts): the label of each state, the buttons of a
// row, what the form offers after a test, and the list a snapshot gives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_ENTRY, anyNotConnected, formError, formView, heldResult, insertServer, removeText, resultHeading, rowActions, rowResult, serversOf, stateLabel, stepText, upsertServer, validAddress, validHost,
  type ServerForm, type ServerState, type ServerView, type TestResult } from "../src/logic/servers.ts";

const LABELS: Record<ServerState, string> = {
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
const STATES = Object.keys(LABELS) as ServerState[];
const entry = (o: Partial<ServerView> = {}): ServerView => ({ id: "s_3f9a1c2b77de", name: "Studio", address: "https://mac.local:4748", state: "connected", ...o });
const form = (o: Partial<ServerForm> = {}): ServerForm => ({ name: "Studio", address: "https://mac.local:4748", secret: "s3cret", selfSigned: false, pin: "", ...o });
const result = (outcome: string, o: Partial<TestResult> = {}): TestResult => ({ ok: outcome === "connected", step: 3, outcome, message: outcome, ...o });

test("stateLabel: each of the eleven states has its label", () => {
  assert.equal(STATES.length, 11);
  for (const s of STATES) assert.equal(stateLabel(s), LABELS[s]);
  assert.equal(new Set(STATES.map(stateLabel)).size, 11);
});

test("rowActions: the local entry has none", () => {
  assert.deepEqual(rowActions(LOCAL_ENTRY), []);
  for (const state of STATES) assert.deepEqual(rowActions({ ...LOCAL_ENTRY, state }), []);
});

test("rowActions: a too old server can be tested, edited and removed, and nothing connects it anyway", () => {
  assert.deepEqual(rowActions(entry({ state: "too_old" })), ["test", "edit", "remove"]);
});

test("rowActions: every remote entry has test, edit and remove; accept is offered for a certificate alone", () => {
  for (const state of STATES) {
    const acts = rowActions(entry({ state, fingerprint: "AB:CD" }));
    for (const a of ["test", "edit", "remove"] as const) assert.ok(acts.includes(a), `${state}: ${a}`);
    const extra = acts.filter((a) => a === "accept" || a === "showFingerprint");
    if (state === "certificate_changed") assert.deepEqual(extra, ["accept"]);
    else if (state === "fingerprint_not_accepted") assert.deepEqual(extra, ["showFingerprint"]);
    else assert.deepEqual(extra, [], state);
  }
  // Without the presented fingerprint in the view it is read first.
  assert.deepEqual(rowActions(entry({ state: "certificate_changed" })), ["showFingerprint", "test", "edit", "remove"]);
});

test("formError: the first problem, and an empty secret in an edit alone", () => {
  assert.equal(formError(form()), "");
  assert.notEqual(formError(form({ name: "  " })), "");
  assert.notEqual(formError(form({ name: "x".repeat(81) })), "");
  for (const address of ["", "http://mac.local:4748", "https://mac.local", "https://mac.local:0", "https://mac.local:70000", "https://mac.local:4748/x",
    "https://u@mac.local:4748", "https://[::1]:4748", "https://mac.local:4748?a=1"])
    assert.match(formError(form({ address })), /Not a valid https address/, address);
  assert.equal(formError(form({ address: " HTTPS://Mac.local:4748/ " })), "");
  assert.notEqual(formError(form({ secret: "" })), "");
  assert.equal(formError(form({ id: "s_1", secret: "" })), "");
  assert.notEqual(formError(form({ secret: "a b" })), "");
  assert.notEqual(formError(form({ secret: "x".repeat(257) })), "");
});

test("formView: Save only after an OK test of the form as it is", () => {
  const f = form();
  assert.equal(formView(f, null, null).canSave, false);
  assert.equal(formView(f, f, result("connected")).canSave, true);
  assert.equal(formView(f, { ...f }, result("connected")).canSave, true);
  assert.equal(formView(f, f, result("refused")).canSave, false);
  // Any field changed after the test: the test is of another form.
  for (const o of [{ name: "Other" }, { address: "https://mac.local:4749" }, { secret: "other" }, { selfSigned: true }, { pin: "AB" }, { id: "s_1" }] as Partial<ServerForm>[]) {
    const v = formView({ ...f, ...o }, f, result("connected", { message: "Connected" }));
    assert.equal(v.canSave, false, JSON.stringify(o));
    assert.equal(v.message, undefined);
  }
  assert.equal(formView(form({ name: "" }), form({ name: "" }), result("connected")).canSave, false);
});

test("formView: Save anyway without a test or after a failed one, but not past these four outcomes or a form error", () => {
  const f = form();
  assert.equal(formView(f, null, null).saveAnyway, true);
  assert.equal(formView(form({ address: "mac.local" }), null, null).saveAnyway, false);
  assert.equal(formView(form({ secret: "" }), null, null).saveAnyway, false);
  assert.equal(formView(form({ id: "s_1", secret: "" }), null, null).saveAnyway, true);
  for (const o of ["refused", "name_not_found", "no_route", "tls_timeout", "not_https", "fingerprint", "cert_changed", "cert_name", "cert_expired", "self_signed",
    "secret_refused", "bad_host", "not_aiwb", "too_old", "no_answer", "no_state"])
    assert.equal(formView(f, f, result(o)).saveAnyway, true, o);
  for (const o of ["bad_address", "is_local", "duplicate", "another_server"]) assert.equal(formView(f, f, result(o)).saveAnyway, false, o);
  assert.equal(formView(f, f, result("connected")).saveAnyway, false);
  // A changed form is an untested one again.
  assert.equal(formView({ ...f, address: "https://mac.local:4749" }, f, result("duplicate")).saveAnyway, true);
});

test("formView: a fingerprint to accept for `fingerprint` and `cert_changed`, the second with both", () => {
  const f = form({ selfSigned: true });
  const first = formView(f, f, result("fingerprint", { fingerprint: "AB:CD", message: "Compare this fingerprint" }));
  assert.deepEqual(first, { canSave: false, saveAnyway: true, message: "Compare this fingerprint", accept: "AB:CD" });
  const g = form({ selfSigned: true, pin: "11:22" });
  const changed = formView(g, g, result("cert_changed", { fingerprint: "AB:CD", pinned: "11:22", message: "Certificate changed" }));
  assert.deepEqual(changed, { canSave: false, saveAnyway: true, message: "Certificate changed", accept: "AB:CD", pinned: "11:22" });
  // No other outcome offers one, whatever the answer holds.
  for (const o of ["connected", "refused", "self_signed", "cert_name", "secret_refused"])
    assert.equal(formView(f, f, result(o, { fingerprint: "AB:CD" })).accept, undefined, o);
  const withDetail = formView(f, f, result("cert_expired", { detail: "x509: certificate has expired" }));
  assert.equal(withDetail.detail, "x509: certificate has expired");
});

test("removeText: names the entry and both counts, and that nothing is deleted on that server", () => {
  assert.equal(removeText("Studio", 3, 2),
    `Remove "Studio"? It has 3 chats and 2 runs in this app. They are removed from this app; nothing is deleted or stopped on that server.`);
  assert.match(removeText("Studio", 1, 1), /It has 1 chat and 1 run in this app\./);
  assert.match(removeText("Studio", 0, 0), /It has 0 chats and 0 runs in this app\./);
});

test("serversOf: a snapshot without the field gives the local entry alone", () => {
  assert.deepEqual(serversOf({}), { servers: [LOCAL_ENTRY] });
  assert.deepEqual(serversOf({ servers: [] }), { servers: [LOCAL_ENTRY] });
  assert.deepEqual(LOCAL_ENTRY, { id: "local", local: true, name: "This computer", state: "connected" });
  const list = [LOCAL_ENTRY, entry()];
  assert.equal(serversOf({ servers: list }).servers, list);
});

test("upsertServer: replaces the entry with the id in its place, or adds it at the end", () => {
  const list = [LOCAL_ENTRY, entry(), entry({ id: "s_2", name: "Two" })];
  const changed = entry({ state: "unreachable" });
  assert.deepEqual(upsertServer(list, changed), [LOCAL_ENTRY, changed, list[2]]);
  const added = entry({ id: "s_3", name: "Three" });
  assert.deepEqual(upsertServer(list, added), [...list, added]);
  assert.equal(list.length, 3);
});

test("anyNotConnected: the dot shows for any entry that is not connected", () => {
  assert.equal(anyNotConnected([LOCAL_ENTRY]), false);
  assert.equal(anyNotConnected([LOCAL_ENTRY, entry()]), false);
  for (const state of STATES.filter((s) => s !== "connected")) assert.equal(anyNotConnected([LOCAL_ENTRY, entry({ state })]), true, state);
});

test("insertServer: adds an entry the list lacks, and leaves one it has as it is", () => {
  const list = [LOCAL_ENTRY, entry({ state: "too_old" })];
  assert.equal(insertServer(list, entry({ state: "connecting" })), list);
  assert.deepEqual(insertServer(list, entry({ id: "s_2" })), [...list, entry({ id: "s_2" })]);
  assert.deepEqual(insertServer([], LOCAL_ENTRY), [LOCAL_ENTRY]);
});

test("stepText: the five steps by name, and nothing for another number", () => {
  assert.equal(stepText(1), "Step 1 of 5: the address");
  assert.equal(stepText(2), "Step 2 of 5: the connection");
  assert.equal(stepText(3), "Step 3 of 5: the certificate");
  assert.match(stepText(4), /^Step 4 of 5: the secret/);
  assert.equal(stepText(5), "Step 5 of 5: the first events");
  for (const x of [0, 6, -1, 1.5, NaN, "3", undefined, null]) assert.equal(stepText(x), "", String(x));
});

test("validHost: the server's rule (remote.NormalName)", () => {
  for (const h of ["mac.local", "MAC.Local", "localhost", "a", "7", "192.168.1.20", "my-mac.lan", "a--b.c", "a.-b", "x".repeat(253)]) assert.equal(validHost(h), true, h);
  for (const h of ["", "my_mac", "mac.local.", ".mac.local", "-mac", "mac-", "a..b", "ma c", "m\u00e4c.local", "::1", "[::1]", "a@b", "a%41", "x".repeat(254)]) assert.equal(validHost(h), false, h);
});

test("validAddress and formError: what the server's address parser takes, and no more", () => {
  const good = ["https://mac.local:4748", " HTTPS://Mac.local:4748/ ", "https://192.168.1.20:1", "https://localhost:65535", "https://a:04748", "https://my-mac:443/"];
  const bad = ["https://my_mac:4748", "https://mac.local.:4748", "https://.mac.local:4748", "https://-mac:4748", "https://mac-:4748", "https://a..b:4748",
    "https://mac.local", "https://mac.local:", "https://mac.local:0", "https://mac.local:65536", "https://mac.local:99999999", "https://mac.local:47x8", "https://mac.local:+80",
    "http://mac.local:4748", "mac.local:4748", "https:mac.local:4748", "https://[::1]:4748", "https://::1:4748", "https://user@mac.local:4748", "https://u:p@mac.local:4748",
    "https://mac.local:4748/x", "https://mac.local:4748//", "https://mac.local:4748?x", "https://mac.local:4748/#x", "https://ma c.local:4748", "https://:4748", "https://m\u00e4c:4748", ""];
  for (const address of good) { assert.equal(validAddress(address), true, address); assert.equal(formError(form({ address })), "", address); }
  for (const address of bad) { assert.equal(validAddress(address), false, address); assert.match(formError(form({ address })), /Not a valid https address/, address); }
});

test("rowResult: a test's answer adds only what the row's own lines do not say", () => {
  assert.deepEqual(rowResult(entry(), null), { step: "", ownCert: true });
  // Too old: the row has the version and the detail already; the step is new.
  const old = entry({ state: "too_old", version: "dev", detail: "Update it", agents: ["claude"] });
  assert.deepEqual(rowResult(old, result("too_old", { step: 4, version: "dev", detail: "Update it", agents: ["claude"] })),
    { message: "too_old", step: stepText(4), ownCert: true });
  assert.deepEqual(rowResult(old, result("too_old", { step: 4, version: "0.9", detail: "Other", agents: ["pi"] })),
    { message: "too_old", step: stepText(4), detail: "Other", version: "0.9", agents: ["pi"], ownCert: true });
  // A test that passed has no step line.
  assert.deepEqual(rowResult(entry({ version: "1.2.3" }), result("connected", { step: 5, version: "1.2.3" })), { message: "connected", step: "", ownCert: true });
  // A fingerprint to accept: the answer's block shows the fingerprints, the row's own lines give way.
  const changed = entry({ state: "certificate_changed", pin: "11:22", fingerprint: "AA:BB" });
  assert.deepEqual(rowResult(changed, result("cert_changed", { fingerprint: "AA:BB", pinned: "11:22" })), { message: "cert_changed", step: stepText(3), accept: "AA:BB", pinned: "11:22", ownCert: false });
  assert.deepEqual(rowResult(changed, result("fingerprint", { fingerprint: "CC:DD" })), { message: "fingerprint", step: stepText(3), accept: "CC:DD", pinned: "11:22", ownCert: false });
  assert.deepEqual(rowResult(entry({ state: "fingerprint_not_accepted" }), result("fingerprint", { fingerprint: "AA:BB" })), { message: "fingerprint", step: stepText(3), accept: "AA:BB", ownCert: false });
  // A fingerprint in an answer of another outcome is not one to accept.
  assert.deepEqual(rowResult(changed, result("refused", { step: 2, fingerprint: "AA:BB" })), { message: "refused", step: stepText(2), ownCert: true });
});

const NOTHING = "Nothing listens there: is remote access set up on that machine?";

test("rowResult: the message is dropped when it is the row's state label or its detail line, and kept otherwise", () => {
  const connected = result("connected", { step: 5, message: "Connected" });
  const refused = result("unreachable", { step: 2, message: NOTHING, detail: "dial tcp4 127.0.0.1:47899: connect: connection refused" });
  const secret = result("secret", { step: 4, message: "Secret not accepted" });
  const down = entry({ state: "unreachable", detail: NOTHING });
  assert.equal(rowResult(entry(), connected).message, undefined);
  assert.equal(rowResult(down, refused).message, undefined);
  assert.equal(rowResult(down, refused).detail, "dial tcp4 127.0.0.1:47899: connect: connection refused");
  assert.equal(rowResult(entry({ state: "secret_not_accepted" }), secret).message, undefined);
  // The entry's state changed since: the row does not say what the test said.
  assert.equal(rowResult(entry(), refused).message, NOTHING);
  assert.equal(rowResult(down, connected).message, "Connected");
  assert.equal(rowResult(entry(), secret).message, "Secret not accepted");
  // A label alone is no match for a message that says more.
  assert.equal(rowResult(entry({ state: "unreachable" }), refused).message, NOTHING);
});

test("resultHeading: the message the row does not show, or else whether the test passed", () => {
  const down = entry({ state: "unreachable", detail: NOTHING });
  const refused = result("unreachable", { step: 2, message: NOTHING });
  const connected = result("connected", { step: 5, message: "Connected" });
  assert.equal(resultHeading(rowResult(entry(), connected), true), "Test passed");
  assert.equal(resultHeading(rowResult(down, refused), false), "Test failed");
  assert.equal(resultHeading(rowResult(down, connected), true), "Connected");
  assert.equal(resultHeading(rowResult(entry(), refused), false), NOTHING);
});

test("heldResult: a test's answer is shown while the entry has the state it had when the answer came", () => {
  const r = result("unreachable", { step: 2, message: NOTHING });
  assert.equal(heldResult(null, "connected"), null);
  assert.equal(heldResult({ result: r, state: "unreachable" }, "unreachable"), r);
  // The server came back: the old answer goes.
  assert.equal(heldResult({ result: r, state: "unreachable" }, "connected"), null);
  assert.equal(heldResult({ result: r, state: "unreachable" }, "connecting"), null);
  // An answer that says another thing than the state it came under stays until the state changes.
  const ok = result("connected", { step: 5 });
  assert.equal(heldResult({ result: ok, state: "unreachable" }, "unreachable"), ok);
  assert.equal(heldResult({ result: ok, state: "unreachable" }, "connected"), null);
});

test("formView: an edit of the name alone is saved without a test and with no Save anyway; any other change keeps the rule", () => {
  const saved = form({ id: "s_1", secret: "", selfSigned: true, pin: "AB:CD" });
  // Name only changed.
  assert.deepEqual(formView({ ...saved, name: "Garage" }, null, null, saved), { canSave: true, saveAnyway: false, force: true });
  // Nothing changed, or the name by its spaces alone: Save is disabled.
  assert.deepEqual(formView(saved, null, null, saved), { canSave: false, saveAnyway: true });
  assert.deepEqual(formView({ ...saved, name: " Studio " }, null, null, saved), { canSave: false, saveAnyway: true });
  // Name and address changed: as without the saved entry.
  const both = { ...saved, name: "Garage", address: "https://mac.local:4749" };
  assert.deepEqual(formView(both, null, null, saved), { canSave: false, saveAnyway: true });
  assert.deepEqual(formView(both, null, null, saved), formView(both, null, null));
  assert.deepEqual(formView(both, both, result("refused"), saved), formView(both, both, result("refused")));
  assert.deepEqual(formView(both, both, result("connected"), saved), formView(both, both, result("connected")));
  // Name with a secret, the box or the fingerprint changed.
  for (const o of [{ secret: "other" }, { selfSigned: false }, { pin: "EE:FF" }, { selfSigned: false, pin: "" }] as Partial<ServerForm>[])
    assert.deepEqual(formView({ ...saved, name: "Garage", ...o }, null, null, saved), { canSave: false, saveAnyway: true }, JSON.stringify(o));
  // A name that is not valid is not saved.
  assert.deepEqual(formView({ ...saved, name: "" }, null, null, saved), { canSave: false, saveAnyway: false });
  assert.deepEqual(formView({ ...saved, name: "x".repeat(81) }, null, null, saved), { canSave: false, saveAnyway: false });
  // A failed test of the renamed form does not take Save away: the test was of the connection, which the edit leaves alone.
  const renamed = { ...saved, name: "Garage" };
  assert.deepEqual(formView(renamed, renamed, result("refused"), saved), { canSave: true, saveAnyway: false, force: true, message: "refused" });
  // The add form has no saved entry: a name there is never enough.
  assert.deepEqual(formView(form({ name: "Garage" }), null, null, form()), { canSave: false, saveAnyway: true });
  assert.deepEqual(formView(form({ name: "Garage" }), null, null), { canSave: false, saveAnyway: true });
});
