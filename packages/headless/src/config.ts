// The configuration line the server writes on the process's stdin (D27), and the two helpers around it. Alone in this file so
// that the board host (`@aiwb/board-host`), which starts the same way, can import it without the board engine.
import { randomBytes } from "node:crypto";
import type { StoredEntry } from "@aiwb/conn";

/** The quiet time a board is kept after the last call on it (D26), and the longest wait for the call in progress when a board
 *  is asked for (D17): the server sends both in the start-up configuration. */
export const QUIET_DEFAULT_MS = 60_000;
export const HANDOVER_DEFAULT_MS = 8_000;

export type Config = {
  address: string;
  fingerprint: string;
  secret: string;
  clientId: string;
  instanceId: string;
  quietMs: number;
  handoverMs: number;
  version: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Reads the configuration line. The errors name the field and never quote the line. */
export function parseConfig(line: string): Config {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { throw new Error("the configuration on stdin is not JSON"); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the configuration on stdin is not an object");
  const c = raw as Record<string, unknown>;
  const text = (k: string): string => {
    const v = c[k];
    if (typeof v !== "string" || v === "") throw new Error(`the configuration has no "${k}"`);
    return v;
  };
  const ms = (k: string, def: number): number => {
    const v = c[k];
    if (v === undefined || v === null) return def;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`the configuration's "${k}" is not a number of milliseconds`);
    return v;
  };
  const clientId = text("clientId");
  if (!UUID.test(clientId)) throw new Error('the configuration\'s "clientId" is not a UUID v4');
  const address = text("address");
  return {
    address: /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`,
    fingerprint: text("fingerprint"),
    secret: text("secret"),
    clientId,
    instanceId: text("instanceId"),
    quietMs: ms("quietMs", QUIET_DEFAULT_MS),
    handoverMs: ms("handoverMs", HANDOVER_DEFAULT_MS),
    version: typeof c.version === "string" ? c.version : "dev",
  };
}

/** The entry of the one server, as the connection module's list holds it: pinned to the certificate the server gave. */
export function entryOf(c: Config, random: (n: number) => Buffer = randomBytes): StoredEntry {
  return {
    id: `s_${random(6).toString("hex")}`, name: "AI Whiteboard", address: c.address, secret: c.secret,
    selfSigned: true, pin: c.fingerprint, instanceId: c.instanceId,
  };
}

/** A line with the secret taken out of it. */
export function redact(line: string, secret: string): string {
  return secret ? line.split(secret).join("***") : line;
}

