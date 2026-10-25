// What the phone's add flow decides without a screen (S2-7, goal 3.8.3): what a test's answer means against the code's fingerprint, and which form
// is tested and which is saved.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ServerForm, TestResult } from "@aiwb/core/logic/servers.ts";

import { formToSave, formToTest, judge, reachedLine } from "../src/screens/servers/AddFlow/steps.ts";

const FP = "C4:1E:9B:07:5A:3D:E2:F8:0B:6C:71:A9:D3:5E:48:F2:A9:07:3C:1B:6E:84:F2:5D:19:C0:B7:A6:2D:58:E3:F1";
const OTHER = "7D:20:E9:1A:44:BC:0F:63:B8:15:2C:A7:9E:04:D6:F1:3B:59:A0:C8:57:E2:1D:9F:C6:3A:08:B4:E7:D1:4F:25";
const form: ServerForm = { name: "Studio", address: "https://studio.local:4790", secret: "s", selfSigned: false, pin: "" };
const pass: TestResult = { ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.8.2", agents: ["claude"] };
const changed: TestResult = { ok: false, step: 3, outcome: "cert_changed", message: "Certificate changed", fingerprint: OTHER, pinned: FP };
const asked: TestResult = { ok: false, step: 3, outcome: "fingerprint", message: "Compare this fingerprint", fingerprint: FP };

test("with the code's fingerprint, a passed test is trusted green and a different certificate is a mismatch", () => {
  assert.deepEqual(judge(pass, FP), { kind: "trust", tone: "ok", fingerprint: FP, tested: true });
  assert.deepEqual(judge(changed, FP), { kind: "mismatch", presented: OTHER });
  // a presented fingerprint that differs, whatever the outcome says, is a mismatch; the same one in other spelling is not
  assert.deepEqual(judge({ ...asked, fingerprint: OTHER }, FP), { kind: "mismatch", presented: OTHER });
  assert.equal(judge({ ...pass, fingerprint: FP.toLowerCase().replaceAll(":", "") }, FP).kind, "trust");
});

test("a failure that is not a certificate's says its step and its message", () => {
  const v = judge({ ok: false, step: 2, outcome: "refused", message: "Nothing listens there" }, FP);
  assert.deepEqual(v, { kind: "failed", text: "Step 2 of 5: the connection · Nothing listens there" });
});

test("without a fingerprint in the code, the one the server presents is shown plain to be compared", () => {
  assert.deepEqual(judge(asked, undefined), { kind: "trust", tone: "plain", fingerprint: FP, tested: false });
  assert.deepEqual(judge(pass, undefined), { kind: "trust", tone: "none", fingerprint: "", tested: true });
  assert.equal(judge(changed, undefined).kind, "failed");
});

test("the test sends the code's fingerprint as the pin; the save pins what was trusted", () => {
  assert.deepEqual(formToTest(form, FP), { ...form, selfSigned: true, pin: FP });
  assert.equal(formToTest(form, undefined), form);
  assert.deepEqual(formToSave(form, { kind: "trust", tone: "ok", fingerprint: FP, tested: true }), { ...form, selfSigned: true, pin: FP });
  assert.deepEqual(formToSave(form, { kind: "trust", tone: "plain", fingerprint: OTHER, tested: false }), { ...form, selfSigned: true, pin: OTHER });
  assert.equal(formToSave(form, { kind: "trust", tone: "none", fingerprint: "", tested: true }), form);
});

test("a passed test reads 'Reached in N ms · version X' without its tick", () => {
  assert.equal(reachedLine(pass, 140.4), "Reached in 140 ms · version 1.8.2");
  assert.equal(reachedLine(pass, null), "Reached · version 1.8.2");
});
