// What the add flow decides without drawing (goal 3.8.3): what a test's answer means against the code's fingerprint, which form is tested and
// which is saved. No React here, so Node loads it (app/test/addflow.test.ts).
import { samePrint } from "@aiwb/core/logic/servercode.ts";
import { stepText, type ServerForm, type TestResult } from "@aiwb/core/logic/servers.ts";

import { testLine } from "../facts.ts";

/** The steps of the P3 "New server" (the sheet's `data-step`). */
export type Step = "check" | "trust" | "mismatch" | "paste" | "manual";

/** What a test's answer comes to:
 *  - `trust`: show it and let the person trust and save. `fingerprint` = the one shown; `tone` "ok" = it is the code's (green, "Matches"), "plain" =
 *    the person compares it with what the server printed, "none" = there is none (a certificate the system trusts). `tested` = the secret was
 *    sent and answered (a "plain" one stops at step 3 before the secret).
 *  - `mismatch`: the certificate is not the code's; nothing secret was sent.
 *  - `failed`: any other answer; `text` is its words. */
export type Verdict =
  | { kind: "trust"; tone: "ok" | "plain" | "none"; fingerprint: string; tested: boolean }
  | { kind: "mismatch"; presented: string }
  | { kind: "failed"; text: string };

export function judge(r: TestResult, code: string | undefined): Verdict {
  if (code) {
    if (r.outcome === "cert_changed" || (r.fingerprint && !samePrint(r.fingerprint, code))) return { kind: "mismatch", presented: r.fingerprint ?? "" };
    if (r.ok) return { kind: "trust", tone: "ok", fingerprint: code, tested: true };
  } else {
    if (r.outcome === "fingerprint" && r.fingerprint) return { kind: "trust", tone: "plain", fingerprint: r.fingerprint, tested: false };
    if (r.ok) return { kind: "trust", tone: "none", fingerprint: "", tested: true };
  }
  return { kind: "failed", text: failure(r) };
}

/** The words of a test that did not pass: the step it stopped at, then the answer's message. */
export function failure(r: TestResult): string {
  return [stepText(r.step), r.message].filter(Boolean).join(" · ") || "The test did not pass.";
}

/** The form a test sends: with the code's fingerprint as the pin, so that conn checks the certificate in the handshake and a mismatch
 *  sends no secret. Without one, the form as it is. */
export function formToTest(f: ServerForm, code: string | undefined): ServerForm {
  return code ? { ...f, selfSigned: true, pin: code } : f;
}

/** The form a "Trust and save" sends: the fingerprint the person trusted is the pin (the app tests again before it saves). */
export function formToSave(f: ServerForm, v: Extract<Verdict, { kind: "trust" }>): ServerForm {
  return v.tone === "none" ? f : { ...f, selfSigned: true, pin: v.fingerprint };
}

/** "Reached in 140 ms · version 1.8.2" of a passed test (the line of core's `testLine` without its ✓). */
export function reachedLine(r: TestResult, ms: number | null): string {
  return testLine(r, ms).text.replace(/^✓\s*/, "");
}
