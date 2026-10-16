// The headless writer's process (D20, D28, D32): it reads one line of JSON configuration from its stdin, starts the board
// engine, opens its one stream as a client of the server and runs the loop. It ends when its stdin closes, when its stream
// ends, or with code 3 and the reason on stderr when the engine or the first connection fails within the start limit.
//
// The secret is in the configuration line and in the connection's memory, and in no other place: not in argv, not in the
// environment, not in a file, and not in any line this process prints (every line goes through `redact`).
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import type { StoredEntry } from "@aiwb/conn";
import { startEngine as realStartEngine, type Engine, type EngineOptions } from "./engine.ts";
import { startLoop, HANDOVER_DEFAULT_MS, QUIET_DEFAULT_MS, type Loop } from "./loop.ts";
import type { ClientLike } from "./api.ts";

/** The exit code of a process that could not start (the engine, or the first connection, within the start limit). */
export const EXIT_START_FAILED = 3;

/** How long the engine and the first connection may take together (D31). */
export const START_LIMIT_MS = 20_000;
/** How long the boards held are given to be saved when the process ends (D28). */
export const FLUSH_LIMIT_MS = 2_000;

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

/** The test knob `AIWB_HEADLESS_TEST=hold-before-save[:N]`: false when it is not set, else which `apply` is held (loop.ts `holdBeforeSave`). */
export function holdOf(v: string | undefined): boolean | number {
  const m = /^hold-before-save(?::([1-9]\d*))?$/.exec(v ?? "");
  return !m ? false : m[1] ? Number(m[1]) : true;
}

export type Deps = {
  stdin: NodeJS.ReadableStream;
  /** One line to stderr (the server's log). */
  stderr: (line: string) => void;
  exit: (code: number) => void;
  env: Record<string, string | undefined>;
  /** The folder of the engine's files (`<bundle dir>/engine`). */
  assets: string;
  /** Makes the connection module's client for the one server (bin.ts: `createClient` over the Node connector and a `memStore`);
   *  `close` ends every connection. */
  makeClient: (entry: StoredEntry, clientId: string, log: (line: string) => void) => ClientLike & { close(): Promise<void> };
  /** Starts the engine (default: engine.ts). */
  startEngine?: (o: EngineOptions) => Promise<Engine>;
  engine?: Pick<EngineOptions, "create" | "readyMs" | "timeout">;
  startLimitMs?: number;
  flushLimitMs?: number;
  /** SIGTERM and SIGINT end the process as the end of stdin does (what it holds is saved first); `process` in bin.ts. */
  signals?: Pick<NodeJS.EventEmitter, "once">;
  /** Lines written with console.* (the board side's) go through the same redaction as the process's own. */
  captureConsole?: boolean;
};

/** Runs the process. Resolves when it has asked to exit. */
export async function run(deps: Deps): Promise<void> {
  const startLimit = deps.startLimitMs ?? START_LIMIT_MS;
  const flushLimit = deps.flushLimitMs ?? FLUSH_LIMIT_MS;
  const startEngine = deps.startEngine ?? realStartEngine;
  let secret = "";
  const log = (line: string) => deps.stderr(redact(line, secret));
  let restoreConsole = () => {};

  let engine: Engine | null = null, loop: Loop | null = null, client: (ClientLike & { close(): Promise<void> }) | null = null;
  let stopping = false;
  let rl: ReturnType<typeof createInterface> | undefined;
  let settled!: () => void;
  const done = new Promise<void>((r) => { settled = r; });

  async function stop(code: number, reason?: string) {
    if (stopping) return;
    stopping = true;
    if (reason) log(reason);
    // (what it holds is saved first: at most flushLimit, then the connections and the engine are closed)
    try { await loop?.shutdown(flushLimit); } catch (e) { log(`saving at the end failed: ${(e as Error)?.message}`); }
    await Promise.race([client?.close().catch(() => {}), new Promise((r) => setTimeout(r, flushLimit))]);
    await Promise.race([engine?.close().catch(() => {}), new Promise((r) => setTimeout(r, flushLimit))]);
    restoreConsole();
    rl?.close();
    deps.exit(code);
    settled();
  }

  // ---- the configuration: the first line of stdin; the end of stdin ends the process
  rl = createInterface({ input: deps.stdin as NodeJS.ReadableStream, crlfDelay: Infinity });
  const lines = rl;
  let stdinEnded = false, onStdinEnd: (() => void) | null = null;
  lines.on("close", () => { stdinEnded = true; onStdinEnd?.(); });
  const config = await new Promise<string | null>((resolve) => {
    lines.once("line", (line) => resolve(line));
    lines.once("close", () => resolve(null));
  });
  if (config === null) { await stop(EXIT_START_FAILED, "no configuration on stdin"); return done; }
  let c: Config;
  try { c = parseConfig(config); } catch (e) { await stop(EXIT_START_FAILED, (e as Error).message); return done; }
  secret = c.secret;
  if (deps.captureConsole) {
    const was = { error: console.error, warn: console.warn, log: console.log };
    const text = (a: unknown[]) => a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    console.error = console.warn = console.log = (...a: unknown[]) => log(text(a));
    restoreConsole = () => { Object.assign(console, was); };
  }
  for (const sig of ["SIGTERM", "SIGINT"]) deps.signals?.once(sig, () => void stop(0, `stopped by ${sig}`));
  onStdinEnd = () => void stop(0); // the server stopped or let go of the process
  if (stdinEnded) onStdinEnd();
  lines.resume();

  // ---- the engine, then the connection, within the start limit together
  const deadline = Date.now() + startLimit;
  const within = <T>(p: Promise<T>, what: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(startLimit / 1000)} s`)), Math.max(deadline - Date.now(), 0));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  try {
    engine = await within(startEngine({ assets: deps.assets, version: c.version, warn: log, ...deps.engine }), "starting the board engine");
  } catch (e) {
    await stop(EXIT_START_FAILED, `cannot start the board engine: ${(e as Error).message}`);
    return done;
  }
  if (stopping) return done;
  const entry = entryOf(c);
  client = deps.makeClient(entry, c.clientId, log);
  const hold = holdOf(deps.env.AIWB_HEADLESS_TEST);
  loop = startLoop({
    client, server: entry.id, engine: engine.channel, quietMs: c.quietMs, handoverMs: c.handoverMs, log,
    print: deps.stderr, holdBeforeSave: hold,
    onEnd: (reason) => void stop(0, reason),
  });
  try {
    await within(loop.connected, "the first connection to the server");
  } catch (e) {
    const s = loop.lastState();
    await stop(EXIT_START_FAILED, `cannot connect to the server: ${s.state}${s.detail ? ` (${s.detail})` : ""}; ${(e as Error).message}`);
    return done;
  }
  return done;
}
