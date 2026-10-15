// What the phone's add-server flow decides without a screen (S12, goal 4.7, AD-34): what a pasted or scanned text puts in the form (and what it
// does not: the fingerprint is not accepted for the user), the fingerprint set against the text's, a paste told from typing, and the local network's
// refusal told from the outcome and from an entry's detail (the words are the connection code's, held equal here).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { OUTCOMES } from "@aiwb/conn";
import type { ServerForm } from "@aiwb/core/logic/servers.ts";
import { formError } from "@aiwb/core/logic/servers.ts";

import {
  chooseAddress, fillForm, fingerprintLine, isLocalNetworkDenied, isPaste, LOCAL_NETWORK_DENIED, LOCAL_NETWORK_DENIED_MESSAGE, LOCAL_NETWORK_WHY, read,
} from "../src/screens/servers/addcode.ts";

const FIX = new URL("../../packages/core/test/fixtures/remote-setup/", import.meta.url);
const setup = readFileSync(new URL("setup-remote-default.txt", FIX), "utf8");
const EMPTY: ServerForm = { name: "", address: "", secret: "", selfSigned: false, pin: "" };

test("the words of the local network's refusal are the connection code's, step 2", () => {
  assert.deepEqual(OUTCOMES[LOCAL_NETWORK_DENIED], [2, LOCAL_NETWORK_DENIED_MESSAGE]);
});

test("the refusal is told from the test's outcome and from an entry's detail, and from nothing else", () => {
  assert.equal(isLocalNetworkDenied({ outcome: "local_network_denied" }), true);
  assert.equal(isLocalNetworkDenied({ detail: LOCAL_NETWORK_DENIED_MESSAGE }), true);
  assert.equal(isLocalNetworkDenied({ outcome: "refused", detail: OUTCOMES.refused[1] }), false);
  assert.equal(isLocalNetworkDenied({ outcome: "no_route" }), false);
  assert.equal(isLocalNetworkDenied(null), false);
  assert.equal(isLocalNetworkDenied(undefined), false);
});

test("the whole output fills the form: the first address, the secret, the box for a self-signed certificate, a name; no pin", () => {
  const r = read({ ...EMPTY, pin: "AB" }, setup);
  assert.ok(r.ok);
  assert.equal(r.form.address, "https://mac.example.net:4790");
  assert.match(r.form.secret, /^[0-9a-f]{64}$/);
  assert.equal(r.form.selfSigned, true);
  assert.equal(r.form.name, "mac");
  assert.equal(r.form.pin, "", "the fingerprint is accepted by the person, from the one the server presents");
  assert.equal(r.addresses.length, 3);
  assert.match(r.fingerprint ?? "", /^E6:45:B0/);
  assert.equal(formError(r.form), "", "the filled form is one the form takes");
});

test("a typed name stays; another of the text's addresses takes the pin away", () => {
  const r = read({ ...EMPTY, name: "Studio" }, setup);
  assert.ok(r.ok);
  assert.equal(r.form.name, "Studio");
  const other = chooseAddress({ ...r.form, pin: "AB" }, r.addresses[2]);
  assert.equal(other.address, "https://10.0.0.5:4790");
  assert.equal(other.pin, "");
  assert.equal(other.secret, r.form.secret);
});

test("a text that is refused fills nothing and gives its words, without the secret", () => {
  const r = read(EMPTY, "https://studio.example:4790");
  assert.ok(!r.ok);
  assert.match(r.message, /secret/);
  const http = read(EMPTY, `http://studio.example:4790 ${"a".repeat(64)}`);
  assert.ok(!http.ok && /https/.test(http.message) && !http.message.includes("aaaa"));
});

test("the fingerprint the server presents is set against the text's: match, differs, or unknown", () => {
  const fp = "E6:45:B0:35:48:5E:F3:4B:96:8E:6E:F4:40:67:7F:5E:E4:E7:43:3E:71:0D:21:3E:4A:F8:04:DE:DD:3F:A2:E2";
  assert.equal(fingerprintLine(fp, fp.toLowerCase()), "match");
  assert.equal(fingerprintLine(fp.replace("E6", "E7"), fp), "differs");
  assert.equal(fingerprintLine(undefined, fp), "");
  assert.equal(fingerprintLine(fp, undefined), "");
});

test("a paste is told from typing by how much one change adds", () => {
  assert.equal(isPaste("", "h"), false);
  assert.equal(isPaste("https://a.example", "https://a.example:"), false);
  assert.equal(isPaste("", setup), true);
  assert.equal(isPaste("x", `x${"y".repeat(30)}`), true);
  // over a selection, or into the middle of what the box holds: still what was inserted that counts
  assert.equal(isPaste("https://a.example:1 abc", setup), true);
  assert.equal(isPaste("start end", `start ${"z".repeat(25)}end`), true);
  assert.equal(isPaste("", ""), false);
  assert.equal(isPaste(setup, "x"), false, "a selection replaced by one character is typing");
  assert.equal(isPaste(setup, ""), false, "emptying the box is not a paste");
});

test("fillForm keeps the id of an edit and what the text does not give", () => {
  const f = fillForm({ ...EMPTY, id: "s_a", name: "Mine" }, { addresses: ["https://a.example:1", "https://b.example:2"], secret: "s" }, 1);
  assert.deepEqual(f, { id: "s_a", name: "Mine", address: "https://b.example:2", secret: "s", selfSigned: true, pin: "" });
});

test("the explanation before the first connection says why the system asks", () => {
  assert.match(LOCAL_NETWORK_WHY, /local network/);
  assert.match(LOCAL_NETWORK_WHY, /ask/);
});
