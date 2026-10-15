// What the runner (app/e2e/run.mjs) tells a self-test build, through EXPO_PUBLIC_* variables of the Metro it starts. Each is read
// by its literal name: that is the form Metro puts the value in at bundle time. Nothing here is a secret of a user: the server
// is a scratch server of the run.
import type { NetSelfTestConfig } from "./netSelfTest.ts";

const num = (v: string | undefined) => Number(v ?? "0");

/** The two names the server is reached by: the address and the dotted name of the certificate (AD-36). */
export function selfTestHosts(): { ip: string; dotted: string } {
  return { ip: process.env.EXPO_PUBLIC_AIWB_SELFTEST_HOST ?? "127.0.0.1", dotted: process.env.EXPO_PUBLIC_AIWB_SELFTEST_DOTTED ?? "localtest.me" };
}

/** The scratch server and stand-ins of the run, reached as `host`; null when the build was not given them. */
export function netSelfTestConfig(host: string): NetSelfTestConfig | null {
  const port = num(process.env.EXPO_PUBLIC_AIWB_SELFTEST_PORT);
  const fingerprint = process.env.EXPO_PUBLIC_AIWB_SELFTEST_FINGERPRINT ?? "";
  const secret = process.env.EXPO_PUBLIC_AIWB_SELFTEST_SECRET ?? "";
  if (!port || !fingerprint || !secret) return null;
  return {
    host, port, fingerprint, secret,
    closedPort: num(process.env.EXPO_PUBLIC_AIWB_SELFTEST_CLOSED_PORT),
    plainPort: num(process.env.EXPO_PUBLIC_AIWB_SELFTEST_PLAIN_PORT),
    h1Port: num(process.env.EXPO_PUBLIC_AIWB_SELFTEST_H1_PORT),
    h1Fingerprint: process.env.EXPO_PUBLIC_AIWB_SELFTEST_H1_FINGERPRINT ?? "",
    blackholePort: num(process.env.EXPO_PUBLIC_AIWB_SELFTEST_BLACKHOLE_PORT),
    control: process.env.EXPO_PUBLIC_AIWB_SELFTEST_CONTROL || undefined,
  };
}

/** Where the app tells the runner what each case did (one POST per line); empty: nowhere. */
export const selfTestReportUrl = (): string => process.env.EXPO_PUBLIC_AIWB_SELFTEST_REPORT ?? "";
