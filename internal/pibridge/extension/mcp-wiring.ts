// Pure, dependency-free wiring logic for the MCP lifecycle (plan §2.2 B, §3.2-3.5).
//
// This module owns everything about MCP that is not pi/typebox glue:
//   - config source selection (the --mcp-config flag wins over the file named by
//     AIWB_MCP_CONFIG_FILE, which wins over AIWB_MCP_CONFIG; an empty/absent
//     value means no config),
//   - the app-owned "board server is active" predicate (bridge present + file
//     or env source + config key "board"),
//   - the permission auto-allow set (the registered mcp__board__* names only
//     when the config came from the app),
//   - the failure channel formatting (one-shot notice message or prefixed
//     stderr line),
//   - connect/discover/register/close of every server, with per-server failures
//     reported through the notice sink and never thrown, and each server's
//     connect/handshake/discovery phase bounded by a configurable timeout so a
//     stalling server can never hold up session_start forever,
//   - the subagent description/prompt-snippet wording so only app runs with a
//     board server promise board tools.
//
// It imports only ./mcp.ts (which imports nothing) and node:fs, so it is
// unit-testable with `node --test --experimental-strip-types` and no pi,
// typebox, or node_modules.

import * as fs from "node:fs";
import {
  buildToolMappings,
  connectServer,
  parseMCPConfig,
  type ConnectOptions,
  type MCPClient,
  type MCPConfigParseResult,
  type MCPServerSpec,
  type MCPToolInfo,
  type MCPToolMapping,
  type MCPToolResult,
} from "./mcp.ts";

/** Where the effective MCP config came from. */
export type MCPSource = "flag" | "file" | "env" | "none";

/** The effective config selection: `raw` is the winning value, if any. */
export interface MCPSelection {
  source: MCPSource;
  raw: string | undefined;
  /** Set when the winning source could not be read (the file source only). */
  error?: string;
}

/** appSourced reports whether the app chose the config: the file the Go adapter
 *  writes (AIWB_MCP_CONFIG_FILE) or the AIWB_MCP_CONFIG value. */
export function appSourced(source: MCPSource): boolean {
  return source === "file" || source === "env";
}

/**
 * selectMCPConfig resolves the flag over the environment (plan R1). The flag
 * wins when it carries a non-empty value; an empty/absent flag falls back to
 * the file a non-empty AIWB_MCP_CONFIG_FILE names (the app's way: the token is
 * in a file only the user can read, not in the process's environment), then to
 * a non-empty AIWB_MCP_CONFIG; otherwise there is no config. It never throws: a
 * file that cannot be read is still the selection, with `error` set and no
 * `raw`, and startMCP reports it. readFile is a test seam.
 */
export function selectMCPConfig(
  flagValue: unknown,
  envValue: string | undefined,
  filePath?: string,
  readFile: (path: string) => string = (path) => fs.readFileSync(path, "utf8"),
): MCPSelection {
  const flag = typeof flagValue === "string" && flagValue.trim() !== "" ? flagValue : undefined;
  if (flag !== undefined) return { source: "flag", raw: flag };
  const file = typeof filePath === "string" && filePath.trim() !== "" ? filePath : undefined;
  if (file !== undefined) {
    try {
      return { source: "file", raw: readFile(file) };
    } catch (err) {
      return { source: "file", raw: undefined, error: `cannot read config file ${file}: ${errorText(err)}` };
    }
  }
  const env = typeof envValue === "string" && envValue.trim() !== "" ? envValue : undefined;
  if (env !== undefined) return { source: "env", raw: env };
  return { source: "none", raw: undefined };
}

/**
 * boardServerActive is the factory-scope predicate for the subagent wording and
 * the auto-allow rule (plan R4): the board server is the one keyed "board" in
 * the app-owned config (AIWB_MCP_CONFIG_FILE or AIWB_MCP_CONFIG), in an app run
 * (bridge present). A flag-sourced
 * server keyed "board" never counts, and serverInfo.name is irrelevant.
 */
export function boardServerActive(input: {
  bridgePresent: boolean;
  selection: MCPSelection;
  parsed: MCPConfigParseResult;
}): boolean {
  return (
    input.bridgePresent &&
    appSourced(input.selection.source) &&
    input.parsed.servers.some((spec) => spec.key === "board")
  );
}

/**
 * autoAllowedToolNames is the app-run permission auto-allow set (plan R4): the
 * registered `mcp__board__*` names of the app-sourced board server. The raw
 * native board names no longer exist (the Phase 4 switchover removed the native
 * registration), and the `subagent` tool is always auto-allowed by the gate
 * itself. Flag-sourced board-key servers are not auto-allowed.
 */
export function autoAllowedToolNames(input: {
  boardMCPToolNames: readonly string[];
  appSourcedBoard: boolean;
}): string[] {
  return input.appSourcedBoard ? [...input.boardMCPToolNames] : [];
}

/** The pi-visible result shape for a successful MCP tool call. */
export interface PiTextToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/**
 * mcpToolResultOrThrow converts a tools/call result for pi (plan R6): a
 * successful result becomes text content, an isError result throws carrying the
 * board/MCP text so pi records a failed tool result. Empty error text falls
 * back to a message naming the tool.
 */
export function mcpToolResultOrThrow(result: MCPToolResult, toolName: string): PiTextToolResult {
  if (result.isError) {
    throw new Error(result.text.trim() !== "" ? result.text : `MCP tool ${toolName} failed`);
  }
  return { content: [{ type: "text", text: result.text }], details: {} };
}

/**
 * piToolParameters forwards the server's inputSchema as the pi parameter schema;
 * a missing/non-object schema becomes the empty object schema.
 */
export function piToolParameters(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  return { type: "object" };
}

/** The model-facing description for a discovered MCP tool. */
export function toolDescription(mapping: MCPToolMapping): string {
  return mapping.description.trim() !== "" ? mapping.description : fallbackToolText(mapping);
}

/** The prompt snippet for a discovered MCP tool (server description when present). */
export function toolPromptSnippet(mapping: MCPToolMapping): string {
  return mapping.description.trim() !== "" ? mapping.description : fallbackToolText(mapping);
}

function fallbackToolText(mapping: MCPToolMapping): string {
  return `${mapping.toolName} (MCP server "${mapping.serverKey}")`;
}

/** The `subagent` tool description; board tools are only promised when active. */
export function subagentDescription(boardActive: boolean): string {
  return [
    "Delegate a self-contained task to a separate pi subagent with its own context window.",
    "Use it for focused research, large searches, or work that would otherwise flood this conversation; the subagent runs the same tools as this agent" +
      (boardActive ? ", including the board tools." : "."),
    "description is a short UI label for the task; prompt is the full, self-contained instruction.",
    "The tool runs in the foreground and returns the subagent's final report; set background=true to keep working and receive the report later.",
    "Call it several times in one message to run subagents in parallel.",
  ].join(" ");
}

/** The `subagent` prompt snippet; board tools are only promised when active. */
export function subagentPromptSnippet(boardActive: boolean): string {
  const base =
    "subagent: delegate a self-contained task to a child pi agent (description = short UI label, prompt = full instruction; background=true does not wait)";
  return boardActive ? `${base}; the child inherits the board tools` : base;
}

/** Prefix of the standalone stderr failure line (plan §3.8). */
export const STDERR_NOTICE_PREFIX = "ai-whiteboard pi extension: MCP ";

/**
 * Default bound on one server's whole connect/discovery phase: initialize,
 * notifications/initialized and the paginated tools/list (plan R7/§3.8). It is
 * deliberately larger than a healthy loopback handshake needs and does NOT
 * bound tools/call: calls are governed by the turn's abort signal (plan A9), so
 * a board call may legitimately block for as long as the relay allows.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** configNotice formats parse/rejection errors as one notice message. */
export function configNotice(errors: readonly string[]): string {
  return `config rejected: ${errors.join("; ")}`;
}

/** serverNotice formats one server's connect/discovery failure. */
export function serverNotice(key: string, err: unknown): string {
  return `server "${key}" failed: ${errorText(err)}`;
}

/** stderrNoticeLine renders the standalone failure line. */
export function stderrNoticeLine(message: string): string {
  return `${STDERR_NOTICE_PREFIX}${message}\n`;
}

export interface NoticeSinkOptions {
  /** In an app run the notice goes over the one-shot bridge frame. */
  bridgePresent: boolean;
  /** Sends one `{kind:"notice"}` frame (fire-and-forget). */
  send: (message: string) => void;
  /** Writes one prefixed stderr line (standalone). */
  writeStderr: (chunk: string) => void;
}

/**
 * makeNoticeSink picks the R7 failure channel: with a bridge, one one-shot
 * notice frame per failure; without a bridge, one clear stderr line. It never
 * throws.
 */
export function makeNoticeSink(options: NoticeSinkOptions): (message: string) => void {
  return (message: string): void => {
    if (options.bridgePresent) {
      options.send(message);
      return;
    }
    options.writeStderr(stderrNoticeLine(message));
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/** normalizedHandshakeTimeout falls back to the default for bad values. */
function normalizedHandshakeTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

/**
 * handshakeDeadline starts one server's connect/discovery budget. The returned
 * signal aborts when the budget is spent; `clear` stops the timer as soon as
 * the phase ends (success or failure) so no timer outlives startMCP.
 */
function handshakeDeadline(timeoutMs: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`MCP handshake timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** One discovered-and-registered MCP tool, ready for pi.registerTool. */
export interface MCPToolRegistration {
  /** Namespaced pi name (`mcp__<server>__<tool>`, sanitized and unique). */
  name: string;
  /** Human-readable label (the server's original tool name). */
  label: string;
  description: string;
  promptSnippet: string;
  /** The server's inputSchema (or the empty object schema). */
  parameters: Record<string, unknown>;
  executionMode: "sequential";
  /** Forwards to tools/call and throws on isError/failure. */
  execute: (args: unknown, signal?: AbortSignal) => Promise<PiTextToolResult>;
}

export interface StartMCPOptions {
  /** The effective config selection (flag over file over env already resolved). */
  selection: MCPSelection;
  /** Called once per discovered tool, in server/tool discovery order. */
  register: (tool: MCPToolRegistration) => void;
  /** The non-fatal failure channel (see makeNoticeSink). */
  notice: (message: string) => void;
  /** Test seam; defaults to connectServer. */
  connect?: (spec: MCPServerSpec, options?: ConnectOptions) => Promise<MCPClient>;
  /**
   * Bound in ms on one server's whole connect/discovery phase (initialize +
   * notifications/initialized + paginated tools/list). A server that does not
   * finish within the budget is closed and reported through `notice` without
   * affecting the remaining servers. Defaults to DEFAULT_HANDSHAKE_TIMEOUT_MS;
   * non-positive/non-finite values fall back to the default. tools/call is
   * never bounded by this (it follows the turn abort signal).
   */
  handshakeTimeoutMs?: number;
}

/** Handle to a started MCP lifecycle. */
export interface MCPBootstrap {
  /** The source the effective config came from. */
  source: MCPSource;
  /** Registered pi names of the server whose config key is "board". */
  boardToolNames: string[];
  /** Aborts in-flight calls and closes every client; safe to call twice. */
  close(): void;
}

/**
 * startMCP connects every supported server, runs paginated discovery and
 * registers one tool per discovered tool through `register` (plan §3.2-3.3).
 * Each server's connect + handshake + discovery phase is bounded by
 * `handshakeTimeoutMs` (default DEFAULT_HANDSHAKE_TIMEOUT_MS); a server that
 * exceeds it is aborted and reported. Failures are per server: the server's
 * tools stay absent, exactly one notice goes out, and the remaining servers
 * still start. `close` aborts in-flight calls and closes every connected
 * client (plan R7).
 */
export async function startMCP(options: StartMCPOptions): Promise<MCPBootstrap> {
  const clients: MCPClient[] = [];
  const close = (): void => {
    const open = clients.splice(0);
    for (const client of open) {
      try {
        client.close();
      } catch {
        // Best effort: closing one client must not stop the others.
      }
    }
  };

  const selection = options.selection;
  if (selection.error !== undefined) options.notice(configNotice([selection.error]));
  if (selection.source === "none" || selection.raw === undefined) {
    return { source: selection.source, boardToolNames: [], close };
  }

  const parsed = parseMCPConfig(selection.raw);
  if (parsed.errors.length > 0) options.notice(configNotice(parsed.errors));

  const connect = options.connect ?? connectServer;
  const handshakeTimeoutMs = normalizedHandshakeTimeout(options.handshakeTimeoutMs);
  const connected: { key: string; tools: MCPToolInfo[]; client: MCPClient }[] = [];
  for (const spec of parsed.servers) {
    let client: MCPClient | undefined;
    const deadline = handshakeDeadline(handshakeTimeoutMs);
    let phase: "handshake" | "discovery" = "handshake";
    try {
      client = await connect(spec, { signal: deadline.signal });
      phase = "discovery";
      const tools = await client.listTools({ signal: deadline.signal });
      // Retained only after the whole bounded phase succeeded, so a timed-out
      // client is never registered or reused by tools/call.
      clients.push(client);
      connected.push({ key: spec.key, tools, client });
    } catch (err) {
      if (client !== undefined) {
        try {
          client.close();
        } catch {
          // Best effort: the failed server is reported below.
        }
      }
      // A fired deadline is reported as a clear timeout, not as the internal
      // abort error (or a secondary error raised just after it fired).
      const reported = deadline.signal.aborted
        ? new Error(`MCP ${phase} timed out after ${handshakeTimeoutMs}ms`)
        : err;
      options.notice(serverNotice(spec.key, reported));
    } finally {
      deadline.clear();
    }
  }

  const mappings = buildToolMappings(connected.map((entry) => ({ key: entry.key, tools: entry.tools })));
  const clientByKey = new Map(connected.map((entry) => [entry.key, entry.client] as const));
  for (const mapping of mappings) {
    const client = clientByKey.get(mapping.serverKey);
    if (client === undefined) continue;
    options.register({
      name: mapping.piName,
      label: mapping.toolName,
      description: toolDescription(mapping),
      promptSnippet: toolPromptSnippet(mapping),
      parameters: piToolParameters(mapping.inputSchema),
      executionMode: "sequential",
      execute: (args: unknown, signal?: AbortSignal) =>
        client
          .callTool(mapping.toolName, args, signal ? { signal } : undefined)
          .then((result) => mcpToolResultOrThrow(result, mapping.piName)),
    });
  }

  return {
    source: selection.source,
    boardToolNames: mappings.filter((mapping) => mapping.serverKey === "board").map((mapping) => mapping.piName),
    close,
  };
}
