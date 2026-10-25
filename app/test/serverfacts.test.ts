// What the phone's server screens decide without drawing (S2, goal 3.8.2–3.8.4): the list's order, a row's host and tile, the fingerprint in blocks,
// the status header's second line, a test's line, why a server cannot be reached and what to try, the too-old and remove words.
import assert from "node:assert/strict";
import { test } from "node:test";

import { OUTCOMES } from "@aiwb/conn";
import type { ServerView, TestResult } from "@aiwb/core/logic/servers.ts";
import { SERVER_WORDS, serverWord } from "@aiwb/core/logic/statewords.ts";

import {
  fpBlocks, fpEnds, fpShort, hostOf, removeWords, rowLine, sinceLine, sortedServers, testLine, tileOf, tooOldText, WHY_OUTCOMES, whyOf,
} from "../src/screens/servers/facts.ts";

const v = (id: string, name: string, extra: Partial<ServerView> = {}): ServerView => ({ id, name, state: "connected", ...extra });
const tr = (outcome: string, extra: Partial<TestResult> = {}): TestResult => ({ ok: false, step: OUTCOMES[outcome]?.[0] ?? 0, outcome, message: OUTCOMES[outcome]?.[1] ?? "", ...extra });
const AGAIN = "Test again. Its chats come back by themselves.";

test("the list is A–Z by name, ignoring case and accents, ties by id, problems not first", () => {
  const list = [v("3", "build box", { state: "unreachable" }), v("2", "Éclair"), v("1", "attic"), v("5", "Home lab"), v("4", "Build box"), v("0", "eclair")];
  assert.deepEqual(sortedServers(list).map((s) => s.id), ["1", "3", "4", "0", "2", "5"]);
  const input = [v("b", "B"), v("a", "A")];
  sortedServers(input);
  assert.deepEqual(input.map((s) => s.id), ["b", "a"], "the input is not changed");
  assert.deepEqual(sortedServers([]), []);
});

test("the host of an address has no scheme, port or path", () => {
  assert.equal(hostOf("https://build-box.example:4790"), "build-box.example");
  assert.equal(hostOf("https://10.0.0.5:4790/"), "10.0.0.5");
  assert.equal(hostOf(undefined), "");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf("not an address"), "");
});

test("the tile comes from the word: a certificate is its own, then the tone", () => {
  assert.equal(tileOf(SERVER_WORDS.certChanged), "cert");
  assert.equal(tileOf(SERVER_WORDS.connected), "ok");
  assert.equal(tileOf(SERVER_WORDS.unreachable), "bad");
  assert.equal(tileOf(SERVER_WORDS.tooOld), "warn");
  assert.equal(tileOf(SERVER_WORDS.connecting), "wait");
  assert.equal(tileOf(SERVER_WORDS.localNetworkOff), "bad");
});

const FP = "3F:9A:0C:21:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:12:34:56:78:9A:BC:DE:F0:A1:B2:7E:4D";

test("a fingerprint is 16 upper-case blocks of 4", () => {
  const b = fpBlocks(FP);
  assert.equal(b.length, 16);
  assert.deepEqual(b.slice(0, 3), ["3F9A", "0C21", "1122"]);
  assert.equal(b[15], "7E4D");
  assert.deepEqual(fpBlocks(FP.toLowerCase()), b, "lower case");
  assert.deepEqual(fpBlocks(FP.replaceAll(":", "")), b, "64 digits without colons");
  assert.deepEqual(fpBlocks(`  ${FP}\n`), b, "around spaces");
});

test("a fingerprint that is not 32 pairs gives nothing", () => {
  for (const bad of [undefined, "", "AB:CD", FP + ":00", FP.slice(0, -3), FP.replace("3F", "ZZ"), FP.replaceAll(":", "").slice(0, 62), FP.replaceAll(":", "") + "00", "AB:CD:" + FP.replaceAll(":", "").slice(4), FP.replace(/:/, "::")]) {
    assert.deepEqual(fpBlocks(bad), [], String(bad));
    assert.equal(fpShort(bad), "", String(bad));
    assert.equal(fpEnds(bad), "", String(bad));
  }
});

test("a fingerprint is shortened for a cell and for the trust question", () => {
  assert.equal(fpShort(FP), "3F9A 0C21 … 7E4D");
  assert.equal(fpEnds(FP.toLowerCase()), "3F:9A:0C:21 … 7E:4D");
  assert.equal(fpEnds("8b:47:1e:c2" + ":00".repeat(26) + ":4b:88"), "8B:47:1E:C2 … 4B:88");
  assert.equal(fpEnds(("8B471EC2" + "00".repeat(26) + "4B88").toLowerCase()), "8B:47:1E:C2 … 4B:88");
});

test("the header's second line: a test seen now, a test seen earlier, the state's start, or nothing", () => {
  const now = new Date(2026, 9, 22, 18, 40).getTime();
  const word = { text: "Unreachable" };
  assert.equal(sinceLine(word, now - 5_000, undefined, now), "Checked just now");
  assert.equal(sinceLine(word, now - 60_000, new Date(2026, 9, 22, 9, 12).getTime(), now), "Checked just now", "a minute exactly");
  assert.equal(sinceLine(word, now + 3_000, undefined, now), "Checked just now", "a clock set back");
  assert.equal(sinceLine(word, new Date(2026, 9, 22, 9, 5).getTime(), undefined, now), "Checked at 9:05");
  assert.equal(sinceLine(word, new Date(2026, 9, 22, 17, 12).getTime(), undefined, now), "Checked at 17:12");
  assert.equal(sinceLine(word, null, new Date(2026, 9, 22, 9, 12).getTime(), now), "Unreachable since 9:12");
  assert.equal(sinceLine({ text: "Connected" }, null, new Date(2026, 9, 21, 20, 0).getTime(), now), "Connected since yesterday");
  assert.equal(sinceLine({ text: "Connected" }, null, new Date(2026, 9, 3, 20, 0).getTime(), now), "Connected since Oct 3");
  assert.equal(sinceLine(word, null, undefined, now), "");
});

test("a test's line: reached, with and without the time and the version; failed with its step and message", () => {
  assert.deepEqual(testLine({ ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.8.2" }, 120), { ok: true, text: "✓ Reached in 120 ms · version 1.8.2" });
  assert.equal(testLine({ ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.8.2" }, null).text, "✓ Reached · version 1.8.2");
  assert.equal(testLine({ ok: true, step: 5, outcome: "connected", message: "Connected" }, 87.4).text, "✓ Reached in 87 ms");
  assert.equal(testLine({ ok: true, step: 5, outcome: "connected", message: "Connected" }, null).text, "✓ Reached");
  assert.deepEqual(testLine(tr("refused"), 40), { ok: false, text: "✕ Step 2 of 5: the connection · Nothing listens there: is the server running on that machine?" });
  assert.equal(testLine(tr("x", { step: 9, message: "Odd" }), null).text, "✕ Odd", "a step that is none of the five");
  assert.equal(testLine(tr("secret_refused", { message: "" }), null).text, "✕ Step 4 of 5: the secret and the server's answer");
  assert.equal(testLine(tr("x", { step: 0, message: "" }), null).text, "✕");
});

test("the outcomes with words hold the connection code's step and message", () => {
  for (const [k, w] of Object.entries(WHY_OUTCOMES)) assert.deepEqual(OUTCOMES[k], [w.step, w.message], k);
});

const ADDR = "https://attic.example:4790";
const server = (state: ServerView["state"], detail?: string): ServerView => v("a", "Attic server", { state, detail, address: ADDR });

test("why: refused names the step, the port and what to try", () => {
  const w = whyOf(server("unreachable", OUTCOMES.refused[1]), tr("refused"));
  assert.deepEqual(w, {
    title: "Connection refused",
    body: "Step 2 of 5, the connection: the machine answered, but no server listens on port 4790. It is probably stopped.",
    tries: ["Start the server on that machine (open the app there, or run ai-whiteboard launch).", AGAIN],
  });
  assert.match(whyOf({ ...server("unreachable"), address: undefined }, tr("refused")).body, /no server listens on its port\. It is probably stopped\.$/);
  assert.match(whyOf({ ...server("unreachable"), address: "https://attic.example" }, tr("refused")).body, /on its port\./);
});

test("why: every listed outcome has its heading, its step, plain steps and the closing line", () => {
  const steps: Record<string, number> = { refused: 2, name_not_found: 2, no_route: 2, local_network_denied: 2, tls_timeout: 3, secret_refused: 4, bad_host: 4, not_aiwb: 4, another_server: 4, no_answer: 4, too_old: 4 };
  const names = ["the connection", "the connection", "the connection", "the connection", "the certificate", "the secret and the server's answer"];
  const seen = new Set<string>();
  for (const [o, step] of Object.entries(steps)) {
    const w = whyOf(server("unreachable"), tr(o));
    assert.ok(w.title, o);
    assert.ok(w.body.startsWith(`Step ${step} of 5, ${step === 2 ? names[0] : step === 3 ? names[4] : names[5]}: `), `${o}: ${w.body}`);
    assert.ok(w.body.endsWith("."), o);
    assert.ok(w.tries.length >= 2 && w.tries.at(-1) === AGAIN, o);
    assert.ok(!/\b(Esc|⌘|right-click|click)\b/i.test(w.body + w.tries.join(" ")), `${o} has a desktop word`);
    seen.add(w.title);
  }
  assert.equal(seen.size, 11, "each outcome has its own heading");
});

test("why: the words of the ones the goal names", () => {
  assert.match(whyOf(server("unreachable"), tr("name_not_found")).body, /name/);
  assert.match(whyOf(server("unreachable"), tr("no_route")).tries.join(" "), /VPN/);
  assert.match(whyOf(server("unreachable"), tr("no_route")).tries.join(" "), /network/);
  assert.match(whyOf(server("unreachable"), tr("local_network_denied")).tries.join(" "), /Settings.*Local Network/);
  const tls = whyOf(server("unreachable"), tr("tls_timeout"));
  assert.match(tls.body + tls.tries.join(" "), /VPN/);
  assert.match(tls.body + tls.tries.join(" "), /firewall.*port/);
  const secret = whyOf(server("secret_not_accepted"), null);
  assert.match(secret.body, /changed on the server/);
  assert.match(secret.tries.join(" "), /setup-remote\.sh/);
  assert.match(secret.tries.join(" "), /Add the server again/);
  assert.match(whyOf(server("unreachable"), tr("too_old")).tries.join(" "), /Update/);
});

test("why: with no test, the entry's state says the outcome", () => {
  const title = (s: ServerView["state"], d?: string) => whyOf(server(s, d), null).title;
  assert.equal(title("secret_not_accepted"), "Secret not accepted");
  assert.equal(title("name_not_known"), whyOf(server("unreachable"), tr("bad_host")).title);
  assert.equal(title("not_aiwb"), whyOf(server("unreachable"), tr("not_aiwb")).title);
  assert.equal(title("another_server"), whyOf(server("unreachable"), tr("another_server")).title);
  assert.equal(title("too_old"), whyOf(server("unreachable"), tr("too_old")).title);
  assert.deepEqual(whyOf(server("secret_not_accepted"), null), whyOf(server("unreachable"), tr("secret_refused")));
});

test("why: an unreachable entry's detail is matched to an outcome, by its message or by a keyword", () => {
  const same = (detail: string, outcome: string) => assert.deepEqual(whyOf(server("unreachable", detail), null), whyOf(server("unreachable"), tr(outcome)), detail);
  for (const o of ["refused", "name_not_found", "no_route", "local_network_denied", "tls_timeout", "no_answer"]) same(OUTCOMES[o][1], o);
  same(OUTCOMES.refused[1].toUpperCase(), "refused");
  same("dial tcp 10.0.0.5:4790: connection refused", "refused");
  same("lookup attic.example: no such host (not found)", "name_not_found");
  same("tls handshake timeout", "tls_timeout");
  same("Request timed out", "tls_timeout");
  same("The local network is off for this app", "local_network_denied");
});

test("why: anything else reads the answer's message, the state's reason or the detail, with the generic steps", () => {
  const generic = ["Check that the server runs and that this phone reaches its network.", AGAIN];
  assert.deepEqual(whyOf(server("unreachable"), tr("tls_error")), { title: "The secure connection failed", body: "Step 3 of 5: the certificate", tries: generic });
  assert.deepEqual(whyOf(server("unreachable"), tr("x", { step: 0, message: "Odd answer" })), { title: "Odd answer", body: "", tries: generic });
  assert.deepEqual(whyOf(server("unreachable", "boom"), null), { title: "Boom", body: "", tries: generic });
  assert.deepEqual(whyOf(server("unreachable"), null), { title: "Unreachable", body: "", tries: generic });
  assert.equal(whyOf(server("certificate_not_accepted"), null).title, serverWord({ state: "certificate_not_accepted" }).reason);
  assert.equal(whyOf(server("certificate_not_accepted", "x"), tr("tls_error", { message: "" })).title, "Certificate not accepted");
  assert.equal(whyOf(server("unreachable"), { ok: true, step: 5, outcome: "connected", message: "Connected" }).title, "Unreachable", "a passed test says nothing of why");
});

test("too old: both versions and how to update", () => {
  assert.deepEqual(tooOldText("Old Mini", "0.9.1", "1.9.0"), {
    versions: "Old Mini runs 0.9.1; this app is 1.9.0",
    how: "Update AI Whiteboard on Old Mini (install the new version there and start it), then test again.",
  });
  assert.equal(tooOldText("Old Mini", undefined, "1.9.0").versions, "Old Mini runs an older version; this app is 1.9.0");
});

test("remove: the question names the server and says nothing is deleted there", () => {
  assert.deepEqual(removeWords("Build box"), {
    title: "Remove “Build box”?",
    body: "Its section leaves your list. Nothing is deleted or stopped on Build box: its chats and whiteboards stay there, and you can add it again.",
    confirm: "Remove Build box",
  });
});

test("a row says the host after a connected or connecting word, and the reason after a problem's", () => {
  const line = (x: ServerView, localNetworkDenied = false) => rowLine(x, serverWord(x, { localNetworkDenied }));
  assert.deepEqual(line(v("1", "Build", { address: "https://build-box.example:4790" })), { text: "build-box.example", mono: true });
  assert.deepEqual(line(v("1", "Slow", { state: "connecting", address: "https://slow-link.example:4790" })), { text: "slow-link.example", mono: true });
  assert.deepEqual(line(v("1", "Build")), { text: "", mono: true }, "no address, nothing to say");
  // unreachable: what the entry says of the failure, in lower case
  const down = (detail?: string) => v("2", "Attic", { state: "unreachable", address: "https://attic.example:4790", detail });
  assert.deepEqual(line(down("Connection refused")), { text: "connection refused", mono: false });
  assert.deepEqual(line(down(WHY_OUTCOMES.refused.message)), { text: "connection refused", mono: false }, "the table's message names its outcome");
  assert.deepEqual(line(down("Name not found")), { text: "name not found", mono: false });
  assert.deepEqual(line(down("TLS handshake failed")), { text: "TLS handshake failed", mono: false }, "an acronym keeps its capitals");
  assert.deepEqual(line(down()), { text: "", mono: false }, "no detail: no reason, and not the host");
  assert.deepEqual(line(down("a very long sentence that a row cannot hold and that says nothing short")), { text: "", mono: false });
  // the states folded into "Unreachable" read their label
  assert.deepEqual(line(v("3", "X", { state: "secret_not_accepted", address: "https://x.example" })), { text: "secret not accepted", mono: false });
  // too old, certificate changed, local network
  assert.deepEqual(line(v("4", "Mini", { state: "too_old", address: "https://mini.example" })), { text: "update it", mono: false });
  assert.deepEqual(line(v("5", "Cert", { state: "certificate_changed", address: "https://cert.example" })), { text: "", mono: false }, "its word says paused");
  assert.deepEqual(line(down("Connection refused"), true), { text: "allow it in Settings", mono: false });
  assert.equal(serverWord(v("5", "Cert", { state: "certificate_changed" })).text, "Certificate changed · paused");
});
