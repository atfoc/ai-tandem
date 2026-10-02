// Dependency-free MCP Streamable HTTP client for the pi extension.
//
// This module is a reusable, config-driven client for MCP servers that speak
// "Streamable HTTP" (2025-03-26 spec and later) over POST. It has no knowledge
// of boards, chats, permissions, or pi: it imports nothing at all, so the pi
// extension tree keeps working with no node_modules (plan D6). Node's global
// fetch/AbortController/AbortSignal are the only platform APIs used.
//
// Supported transport behavior (plan §2.2 A, §3.3):
//   - JSON-RPC 2.0 over POST with `accept: application/json, text/event-stream`.
//   - `initialize` -> `notifications/initialized` -> requests carrying the
//     negotiated `mcp-protocol-version` header (the server may echo any version).
//   - Both single `application/json` responses and `text/event-stream` responses
//     (the response whose JSON-RPC id matches the request is used).
//   - Notifications tolerate any HTTP status (202, 204, or a JSON body).
//   - No GET/SSE stream is opened or required (servers answering 405 are fine).
//   - Paginated `tools/list` with a repeated-cursor/page guard.
//   - `tools/call` and `ping`.
//   - AbortSignal cancellation: the in-flight fetch is aborted and a best-effort
//     `notifications/cancelled` is sent before the call rejects.
//
// Config parsing (`parseMCPConfig`) accepts a Claude-compatible `mcpServers`
// object and never throws: bad entries produce non-fatal messages instead.
// Accepted HTTP entry types are: `type` absent, `"http"`, `"streamable-http"`,
// `"streamableHttp"`, or `"streamable_http"`. stdio entries (a `command`, or
// `type: "stdio"`) and the legacy `type: "sse"` transport are rejected in v1
// with a clear message, as is a missing/invalid `url` (http/https only).
//
// Naming (`buildToolMappings`) is the plan's R5/D5 mapping: every discovered
// tool gets a deterministic, provider-safe pi name
// `mcp__<sanitized config key>__<sanitized tool name>`, with collisions
// disambiguated by `_2`, `_3`, ... in discovery order. The mapping always keeps
// the original config key and tool name so calls and permission decisions use
// the names the server expects.

/** One accepted HTTP MCP server from the config. `key` is the config key. */
export interface MCPServerSpec {
  key: string;
  url: string;
  /** Optional extra request headers from the config's `headers` object. */
  headers?: Record<string, string>;
}

/** Non-throwing result of `parseMCPConfig`. */
export interface MCPConfigParseResult {
  servers: MCPServerSpec[];
  errors: string[];
}

/** MCP entry types accepted for HTTP/Streamable servers. */
const HTTP_TYPES = new Set(["http", "streamable-http", "streamableHttp", "streamable_http"]);

/** The protocol version requested when the caller does not pick one. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** pi tool names are capped at 64 chars for provider compatibility. */
export const MAX_PI_TOOL_NAME = 64;

/** Every pi tool emitted for an MCP server starts with this prefix. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Maximum `tools/list` pages accepted before discovery fails. */
const MAX_LIST_PAGES = 100;

/** Default bound on the best-effort cancellation notification. */
const DEFAULT_CANCEL_TIMEOUT_MS = 2000;

/** One tool as returned by `tools/list`. */
export interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One `tools/call` result: text parts joined plus the isError flag. */
export interface MCPToolResult {
  text: string;
  isError: boolean;
  content: unknown[];
}

/** `serverInfo` as returned by `initialize`. */
export interface MCPServerInfo {
  name?: string;
  version?: string;
}

/** Per-request options accepted by `listTools`/`callTool`/`ping`. */
export interface MCPRequestOptions {
  signal?: AbortSignal;
}

/** Options accepted by `connectServer`. */
export interface ConnectOptions {
  /**
   * Cancels the handshake: initialize *and* the notifications/initialized
   * POST. It is not retained for later calls.
   */
  signal?: AbortSignal;
  /** Requested protocol version (default `DEFAULT_PROTOCOL_VERSION`). */
  protocolVersion?: string;
  /** `clientInfo` sent in `initialize`. */
  clientInfo?: { name: string; version: string };
  /** Overrides the global fetch (tests). */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Optional per-request timeout in ms (none by default). */
  requestTimeoutMs?: number;
  /** Bound on the best-effort cancellation notification (default 2000 ms). */
  cancelTimeoutMs?: number;
}

/** A connected MCP server. Create one with `connectServer`. */
export interface MCPClient {
  readonly spec: MCPServerSpec;
  /** Negotiated protocol version (the server's echo, or the requested one). */
  readonly protocolVersion: string;
  readonly serverInfo: MCPServerInfo | undefined;
  listTools(options?: MCPRequestOptions): Promise<MCPToolInfo[]>;
  callTool(name: string, args: unknown, options?: MCPRequestOptions): Promise<MCPToolResult>;
  ping(options?: MCPRequestOptions): Promise<void>;
  /** Aborts in-flight requests (best-effort cancellations) and closes the client. */
  close(): void;
}

/** One server's discovered tools, the input of `buildToolMappings`. */
export interface MCPDiscoveredTools {
  /** The config key (unique and user-visible); never `serverInfo.name`. */
  key: string;
  tools: MCPToolInfo[];
}

/** The pi-name <-> (server key, original tool name) mapping entry. */
export interface MCPToolMapping {
  /** Deterministic, sanitized, unique pi tool name. */
  piName: string;
  /** The config key the tool came from. */
  serverKey: string;
  /** The server's original tool name, used for `tools/call`. */
  toolName: string;
  description: string;
  inputSchema: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function excerpt(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
}

function objectKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}

/**
 * parseMCPConfig parses a Claude-compatible `mcpServers` object from the
 * `--mcp-config` flag or `AIWB_MCP_CONFIG`. It never throws: unsupported or
 * malformed entries are returned as per-entry `errors` and every valid HTTP
 * server is returned in config order. An absent/empty `raw` yields no servers
 * and no errors.
 */
export function parseMCPConfig(raw: string | undefined): MCPConfigParseResult {
  const servers: MCPServerSpec[] = [];
  const errors: string[] = [];
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { servers, errors };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    errors.push(`invalid JSON: ${errorMessage(err)}`);
    return { servers, errors };
  }
  if (!isRecord(parsed)) {
    errors.push('config must be a JSON object with an "mcpServers" object');
    return { servers, errors };
  }
  const rawServers = parsed.mcpServers;
  if (!isRecord(rawServers)) {
    errors.push('missing "mcpServers" object');
    return { servers, errors };
  }

  for (const key of objectKeys(rawServers)) {
    const entry = rawServers[key];
    if (!isRecord(entry)) {
      errors.push(`server "${key}": entry must be an object`);
      continue;
    }
    if (entry.command !== undefined) {
      errors.push(`server "${key}": stdio servers (a "command") are not supported in v1`);
      continue;
    }
    const type = entry.type;
    if (type !== undefined) {
      if (typeof type !== "string") {
        errors.push(`server "${key}": "type" must be a string`);
        continue;
      }
      if (type === "stdio") {
        errors.push(`server "${key}": stdio servers are not supported in v1`);
        continue;
      }
      if (type === "sse") {
        errors.push(`server "${key}": legacy HTTP+SSE (type "sse") is not supported in v1`);
        continue;
      }
      if (!HTTP_TYPES.has(type)) {
        errors.push(
          `server "${key}": unsupported type "${type}" (accepted: http, streamable-http, streamableHttp, streamable_http, or no type)`,
        );
        continue;
      }
    }
    const url = entry.url;
    if (typeof url !== "string" || url.trim() === "") {
      errors.push(`server "${key}": missing url`);
      continue;
    }
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      errors.push(`server "${key}": invalid url ${JSON.stringify(url)}`);
      continue;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      errors.push(`server "${key}": url must be http(s), got "${url}"`);
      continue;
    }
    const headers = parseHeaders(entry.headers, key, errors);
    if (headers === null) continue;
    servers.push(headers === undefined ? { key, url } : { key, url, headers });
  }
  return { servers, errors };
}

/**
 * parseHeaders validates the optional `headers` object. It returns undefined
 * when absent, a copy when valid, and null (after pushing an error) when the
 * entry must be skipped.
 */
function parseHeaders(value: unknown, key: string, errors: string[]): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`server "${key}": "headers" must be an object`);
    return null;
  }
  const headers: Record<string, string> = {};
  for (const name of objectKeys(value)) {
    const headerValue = value[name];
    if (typeof headerValue !== "string") {
      errors.push(`server "${key}": header "${name}" must be a string`);
      return null;
    }
    headers[name] = headerValue;
  }
  return headers;
}

/**
 * connectServer opens an MCP Streamable HTTP connection: `initialize` with the
 * requested protocol version, capabilities `{}` and clientInfo, then
 * `notifications/initialized`. It resolves with a connected client or rejects
 * with a clear Error (HTTP status + body excerpt, JSON-RPC error, or transport
 * failure).
 */
export async function connectServer(spec: MCPServerSpec, options: ConnectOptions = {}): Promise<MCPClient> {
  const client = new StreamableHTTPClient(spec, options);
  await client.connect(options);
  return client;
}

class StreamableHTTPClient implements MCPClient {
  readonly spec: MCPServerSpec;
  protocolVersion: string;
  serverInfo: MCPServerInfo | undefined;

  private readonly requestedVersion: string;
  private readonly clientInfo: { name: string; version: string };
  private readonly doFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly requestTimeoutMs: number | undefined;
  private readonly cancelTimeoutMs: number;
  private negotiated = false;
  private nextId = 1;
  private readonly pending = new Map<number, AbortController>();
  private closed = false;

  constructor(spec: MCPServerSpec, options: ConnectOptions) {
    this.spec = spec;
    this.requestedVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.protocolVersion = this.requestedVersion;
    this.clientInfo = options.clientInfo ?? { name: "ai-whiteboard-pi-extension", version: "0.1.0" };
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
  }

  async connect(options: ConnectOptions = {}): Promise<void> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: this.requestedVersion,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
      options.signal,
    );
    if (isRecord(result)) {
      if (typeof result.protocolVersion === "string" && result.protocolVersion !== "") {
        this.protocolVersion = result.protocolVersion;
      }
      if (isRecord(result.serverInfo)) {
        this.serverInfo = {
          name: typeof result.serverInfo.name === "string" ? result.serverInfo.name : undefined,
          version: typeof result.serverInfo.version === "string" ? result.serverInfo.version : undefined,
        };
      }
    }
    this.negotiated = true;
    // The caller's handshake signal is forwarded so a server that accepts the
    // POST and never answers is bounded by the connect budget (plan R7).
    await this.postNotification("notifications/initialized", undefined, options.signal);
  }

  async listTools(options: MCPRequestOptions = {}): Promise<MCPToolInfo[]> {
    const tools: MCPToolInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
      const result = await this.request("tools/list", params, options.signal);
      const rawTools = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
      for (const raw of rawTools) {
        if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") continue;
        tools.push({
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : "",
          inputSchema: raw.inputSchema,
        });
      }
      const nextCursor =
        isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
      if (nextCursor === undefined) return tools;
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`MCP tools/list repeated cursor ${JSON.stringify(nextCursor)}`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  async callTool(name: string, args: unknown, options: MCPRequestOptions = {}): Promise<MCPToolResult> {
    const result = await this.request("tools/call", { name, arguments: args ?? {} }, options.signal);
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((part: unknown): part is Record<string, unknown> => isRecord(part) && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    return { text, isError: isRecord(result) && result.isError === true, content };
  }

  async ping(options: MCPRequestOptions = {}): Promise<void> {
    await this.request("ping", undefined, options.signal);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, controller] of pending) {
      controller.abort();
      void this.sendCancelled(id);
    }
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("MCP client is closed");
    const id = this.nextId++;
    const controller = new AbortController();
    this.pending.set(id, controller);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.requestTimeoutMs !== undefined && this.requestTimeoutMs > 0) {
      timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    }

    try {
      const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
      if (params !== undefined) message.params = params;
      const response = await this.post(message, controller.signal);
      if (!response.ok) {
        throw await httpStatusError(method, response);
      }
      return await this.readResult(response, id);
    } catch (err) {
      if (aborted || signal?.aborted) {
        await this.sendCancelled(id);
        throw abortedError();
      }
      if (controller.signal.aborted) {
        if (timer !== undefined) {
          throw new Error(`MCP request ${method} timed out after ${this.requestTimeoutMs}ms`);
        }
        // close() aborts the internal controller; it already sent a best-effort
        // cancellation, so do not duplicate it here.
        throw abortedError();
      }
      throw transportError(method, err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      this.pending.delete(id);
    }
  }

  private async post(message: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.spec.headers ?? {}),
    };
    if (this.negotiated) headers["mcp-protocol-version"] = this.protocolVersion;
    return this.doFetch(this.spec.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
  }

  private async postNotification(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    // The HTTP status of a notification is irrelevant (202/204/JSON are all
    // accepted), so the response is deliberately not inspected.
    await this.post(message, signal);
  }

  private async sendCancelled(requestId: number): Promise<void> {
    let signal: AbortSignal | undefined;
    try {
      // Bounded so a dead/slow server cannot delay the abort rejection.
      signal = AbortSignal.timeout(this.cancelTimeoutMs);
    } catch {
      signal = undefined;
    }
    try {
      await this.postNotification("notifications/cancelled", { requestId, reason: "client aborted" }, signal);
    } catch {
      // Best effort: cancellation notifications must never mask the real error.
    }
  }

  private async readResult(response: Response, id: number): Promise<unknown> {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const essence = contentType.split(";")[0].trim();
    const text = await response.text();
    if (essence === "text/event-stream") {
      const messages = parseEventStream(text);
      const match = messages.find((message) => isRecord(message) && message.id === id);
      if (!match) throw new Error(`MCP: no response with id ${id} in the SSE response`);
      return unwrapMessage(match as Record<string, unknown>);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`MCP: invalid JSON response for request ${id}: ${excerpt(text) || "(empty body)"}`);
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const match = messages.find((message) => isRecord(message) && message.id === id);
    if (!match) throw new Error(`MCP: no JSON-RPC response with id ${id} in the response body`);
    return unwrapMessage(match as Record<string, unknown>);
  }
}

/** Parses every JSON payload in an SSE event stream body. */
function parseEventStream(body: string): unknown[] {
  const out: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    try {
      out.push(JSON.parse(payload));
    } catch {
      // Ignore malformed events; the requested id just will not be found.
    }
  };
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
  }
  flush();
  return out;
}

/** Turns one JSON-RPC message into its result, throwing on its error. */
function unwrapMessage(message: Record<string, unknown>): unknown {
  if (message.error !== undefined && !isRecord(message.error)) {
    // A malformed error member must fail loudly: returning message.result here
    // would silently turn a broken response into an empty result.
    const raw = message.error;
    const text = typeof raw === "string" ? raw : (JSON.stringify(raw) ?? String(raw));
    throw new Error(`MCP error: malformed JSON-RPC error (${excerpt(text)})`);
  }
  if (isRecord(message.error)) {
    const code = message.error.code;
    const codeText = typeof code === "number" || typeof code === "string" ? String(code) : "?";
    const messageText = typeof message.error.message === "string" ? message.error.message : "unknown error";
    let suffix = "";
    if (message.error.data !== undefined) {
      const dataText = typeof message.error.data === "string" ? message.error.data : JSON.stringify(message.error.data);
      suffix = ` (${excerpt(dataText ?? "")})`;
    }
    throw new Error(`MCP error ${codeText}: ${messageText}${suffix}`);
  }
  return message.result;
}

/**
 * transportError wraps a fetch/network failure in a method-scoped message so
 * connect failures read clearly. Errors that already carry an "MCP …" message
 * (HTTP status, JSON parse, JSON-RPC error) are returned unchanged.
 */
function transportError(method: string, err: unknown): Error {
  if (err instanceof Error && err.message.startsWith("MCP")) return err;
  return new Error(`MCP ${method} failed: ${transportErrorMessage(err)}`);
}

function transportErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`;
    if (cause !== undefined) return `${err.message}: ${String(cause)}`;
    if (err.message) return err.message;
  }
  return String(err);
}

async function httpStatusError(method: string, response: Response): Promise<Error> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const detail = excerpt(body);
  return new Error(`MCP ${method} failed: HTTP ${response.status}${statusText}${detail ? `: ${detail}` : ""}`);
}

function abortedError(): Error {
  const err = new Error("MCP request aborted");
  err.name = "AbortError";
  return err;
}

/**
 * buildToolMappings turns discovered tools into pi tool names following plan
 * R5/D5: `mcp__<server key>__<tool>`, sanitized to `[A-Za-z0-9_-]` and capped
 * at 64 characters, with `_2`, `_3`, ... suffixes for collisions in discovery
 * order. Server order and tool order are preserved, so the result is
 * deterministic. `serverKey`/`toolName` always hold the original values.
 */
export function buildToolMappings(servers: MCPDiscoveredTools[]): MCPToolMapping[] {
  const used = new Set<string>();
  const mappings: MCPToolMapping[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      const piName = disambiguate(basePiName(server.key, tool.name), used);
      mappings.push({
        piName,
        serverKey: server.key,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }
  return mappings;
}

function basePiName(serverKey: string, toolName: string): string {
  let server = sanitizeSegment(serverKey);
  let tool = sanitizeSegment(toolName);
  const fixed = MCP_TOOL_PREFIX.length + 2; // prefix + "__"
  const maxServer = MAX_PI_TOOL_NAME - fixed - 1; // keep at least one tool char
  if (server.length > maxServer) server = server.slice(0, maxServer);
  const maxTool = MAX_PI_TOOL_NAME - fixed - server.length;
  if (tool.length > maxTool) tool = tool.slice(0, maxTool);
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

function sanitizeSegment(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return sanitized === "" ? "unnamed" : sanitized;
}

function disambiguate(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate =
      name.length + suffix.length <= MAX_PI_TOOL_NAME
        ? `${name}${suffix}`
        : `${name.slice(0, MAX_PI_TOOL_NAME - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
