// The board host's process (design 5.2): the headless writer's start-up with the board host's loop. It reads one line of JSON
// configuration from its stdin (the headless writer's line; `quietMs` is the room quiet time, `handoverMs` is ignored), prepares
// what the rooms need, opens its one stream as a client of the server and runs the loop (host.ts). It ends when its stdin closes,
// on SIGTERM or SIGINT, or when its stream ends, saving every dirty room first (at most 2 s); with code 3 and the reason on
// stderr when the start does not finish within the limit.
//
// The secret is in the configuration line and in the connection's memory only; every line printed goes through `redact`.
import { createInterface } from "node:readline";
import type { StoredEntry } from "@aiwb/conn";
import { entryOf, parseConfig, redact, type Config } from "@aiwb/headless/src/config.ts";
import type { HandleTool } from "./agent.ts";
import type { ClientLike } from "./api.ts";
import { startHost, type Host } from "./host.ts";
import type { BoardSchema } from "./schema.ts";

export const EXIT_START_FAILED = 3;
/** How long the preparation and the first connection may take together (design 5.2). */
export const START_LIMIT_MS = 20_000;
/** How long the dirty rooms are given to be saved when the process ends (design 4.2). */
export const FLUSH_LIMIT_MS = 2_000;

export type Deps = {
  stdin: NodeJS.ReadableStream;
  /** One line to stderr (the server's log). */
  stderr: (line: string) => void;
  exit: (code: number) => void;
  env: Record<string, string | undefined>;
  /** Makes the connection module's client for the one server; `close` ends every connection. */
  makeClient: (entry: StoredEntry, clientId: string, log: (line: string) => void) => ClientLike & { close(): Promise<void> };
  /** What has to be ready before the stream opens (the Node stand-in page, the fonts: later packages). */
  prepare?: (c: Config, log: (line: string) => void) => Promise<void>;
  handleTool?: HandleTool;
  schema?: () => BoardSchema;
  startLimitMs?: number;
  flushLimitMs?: number;
  /** Waits of the loop, for tests. */
  waits?: { sendGapMs?: number; retryMs?: number; saveDelayMs?: number };
  signals?: Pick<NodeJS.EventEmitter, "once">;
  captureConsole?: boolean;
  /** The host made, for tests. */
  onHost?: (h: Host) => void;
};

/** Runs the process. Resolves when it has asked to exit. */
export async function run(deps: Deps): Promise<void> {
  const startLimit = deps.startLimitMs ?? START_LIMIT_MS;
  const flushLimit = deps.flushLimitMs ?? FLUSH_LIMIT_MS;
  let secret = "";
  const log = (line: string) => deps.stderr(redact(line, secret));
  let restoreConsole = () => {};

  let host: Host | null = null, client: (ClientLike & { close(): Promise<void> }) | null = null;
  let stopping = false;
  let rl: ReturnType<typeof createInterface> | undefined;
  let settled!: () => void;
  const done = new Promise<void>((r) => { settled = r; });

  async function stop(code: number, reason?: string) {
    if (stopping) return;
    stopping = true;
    if (reason) log(reason);
    try { await host?.shutdown(flushLimit); } catch (e) { log(`saving at the end failed: ${(e as Error)?.message}`); }
    await Promise.race([client?.close().catch(() => {}), new Promise((r) => setTimeout(r, flushLimit))]);
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
    const was = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
    const text = (a: unknown[]) => a.map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    // (all five: the server reads stdout and stderr as its log, and nothing may reach stdout unredacted)
    console.error = console.warn = console.log = console.info = console.debug = (...a: unknown[]) => log(text(a));
    restoreConsole = () => { Object.assign(console, was); };
  }
  for (const sig of ["SIGTERM", "SIGINT"]) deps.signals?.once(sig, () => void stop(0, `stopped by ${sig}`));
  onStdinEnd = () => void stop(0); // the server stopped or let go of the process
  if (stdinEnded) onStdinEnd();
  lines.resume();

  // ---- the preparation, then the connection, within the start limit together
  const deadline = Date.now() + startLimit;
  const within = <T>(p: Promise<T>, what: string): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not finish in ${Math.round(startLimit / 1000)} s`)), Math.max(deadline - Date.now(), 0));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  if (deps.prepare) {
    try { await within(deps.prepare(c, log), "preparing the board host"); } catch (e) {
      await stop(EXIT_START_FAILED, `cannot start the board host: ${(e as Error).message}`);
      return done;
    }
  }
  if (stopping) return done;
  const entry = entryOf(c);
  client = deps.makeClient(entry, c.clientId, log);
  host = startHost({
    client, server: entry.id, log, handleTool: deps.handleTool, schema: deps.schema, quietMs: c.quietMs, ...deps.waits,
    onEnd: (reason) => void stop(0, reason),
  });
  deps.onHost?.(host);
  try {
    await within(host.connected, "the first connection to the server");
  } catch (e) {
    const s = host.lastState();
    await stop(EXIT_START_FAILED, `cannot connect to the server: ${s.state}${s.detail ? ` (${s.detail})` : ""}; ${(e as Error).message}`);
    return done;
  }
  return done;
}
