// What the certificate screen decides without drawing (goal 3.8.4): whether a scanned code's fingerprint is the one presented now, and the
// first pairs the command prints. No React here, so Node loads it (app/test/certcompare.test.ts).
import { fpBlocks, fpEnds } from "../facts.ts";

export const CERT_MISMATCH = "The code's fingerprint does not match: do not trust it";
export const CERT_NO_PRINT = "This code has no fingerprint to compare. Show the one that scripts/server-code.sh prints on the server.";

/** Whether two fingerprints are the same one: the same 16 blocks, whatever the way each was written. Never when either is not 32 pairs. */
export function samePrinted(a: string | undefined, b: string | undefined): boolean {
  const x = fpBlocks(a).join(""), y = fpBlocks(b).join("");
  return x !== "" && x === y;
}

/** The first pairs of a fingerprint, ending in a colon, as the server prints them ("8B:47:1E:C2:"); "" when it is not 32 pairs. */
export function firstPairs(fp: string | undefined): string {
  const s = fpEnds(fp).split(" … ")[0];
  return s ? `${s}:` : "";
}
