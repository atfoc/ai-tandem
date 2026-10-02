// Unit tests for the dependency-free MCP Streamable HTTP client (mcp.ts).
// Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/mcp.test.ts
//
// Every transport test starts a loopback node:http stub server in-process; no
// pi, no real app, no npm packages, and nothing outside 127.0.0.1 is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildToolMappings,
  connectServer,
  parseMCPConfig,
  type ConnectOptions,
  type MCPClient,
  type MCPServerSpec,
} from "../mcp.ts";

// ---- stub server ----------------------------------------------------------

interface StubTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface StubToolResult {
  text?: string;
  texts?: string[];
  isError?: boolean;
  rpcError?: { code: number; message: string };
  /** A deliberately malformed JSON-RPC `error` member (e.g. a string). */
  rawError?: unknown;
}

interface StubOptions {
  /** Encode responses as text/event-stream instead of application/json. */
  sse?: boolean;
  /** Terminate every SSE line with a bare CR instead of LF. */
  sseCrTerminated?: boolean;
  /** Split the SSE data payload across two `data:` lines. */
  sseMultiline?: boolean;
  /** Prepend an unrelated SSE event (a different JSON-RPC id). */
  sseNoise?: boolean;
  /** Override the initialize result. */
  initializeResult?: (params: any) => unknown;
  /** Successive tools/list pages (cursor "1" is page index 1, ...). */
  toolsPages?: { tools: StubTool[] }[];
  /** Always return this nextCursor, for the repeated-cursor guard. */
  repeatCursor?: string;
  /** Per-tool tools/call results. */
  toolResults?: Record<string, StubToolResult>;
  /** JSON-RPC methods that get no response at all (for cancellation tests). */
  hangMethods?: string[];
  /** HTTP status for notification responses (default 202). */
  notificationStatus?: number;
  /** Optional body for notification responses. */
  notificationBody?: string;
  /** HTTP status for GET requests (default 405). */
  getStatus?: number;
  /** Per-method non-2xx responses. */
  failMethods?: Record<string, { status: number; body: string }>;
}

interface StubRequest {
  httpMethod: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

interface Stub {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(10);
  }
}

function stubResponse(body: any, options: StubOptions): Record<string, unknown> {
  const id = body.id;
  const params = body.params ?? {};
  switch (body.method) {
    case "initialize": {
      const result = options.initializeResult
        ? options.initializeResult(params)
        : {
            protocolVersion: params.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "board", version: "0.0.1" },
          };
      return { jsonrpc: "2.0", id, result };
    }
    case "tools/list": {
      const pages = options.toolsPages ?? [{ tools: [] }];
      let index = 0;
      if (typeof params.cursor === "string" && params.cursor !== "") {
        const parsed = Number(params.cursor);
        index = Number.isFinite(parsed) ? parsed : 0;
      }
      const page = pages[index] ?? { tools: [] };
      const result: Record<string, unknown> = {
        tools: page.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object" },
        })),
      };
      if (options.repeatCursor !== undefined) result.nextCursor = options.repeatCursor;
      else if (index + 1 < pages.length) result.nextCursor = String(index + 1);
      return { jsonrpc: "2.0", id, result };
    }
    case "tools/call": {
      const spec = options.toolResults?.[params.name];
      if (spec?.rawError !== undefined) return { jsonrpc: "2.0", id, error: spec.rawError };
      if (spec?.rpcError) return { jsonrpc: "2.0", id, error: spec.rpcError };
      const content = spec?.texts
        ? spec.texts.map((text) => ({ type: "text", text }))
        : [{ type: "text", text: spec?.text ?? `called ${params.name}` }];
      const result: Record<string, unknown> = { content };
      if (spec?.isError) result.isError = true;
      return { jsonrpc: "2.0", id, result };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${body.method}` } };
  }
}

function writeResponse(res: http.ServerResponse, message: Record<string, unknown>, options: StubOptions): void {
  const payload = JSON.stringify(message);
  if (options.sse) {
    res.setHeader("content-type", "text/event-stream");
    const events: string[] = [];
    if (options.sseNoise) {
      events.push(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 987654, result: { unrelated: true } })}\n\n`);
    }
    if (options.sseMultiline) {
      // SSE joins `data:` lines with "\n"; split where a newline is valid JSON
      // whitespace (between members) so the re-joined payload stays parseable.
      const splitAt = payload.indexOf('"result"');
      const mid = splitAt > 0 ? splitAt : Math.ceil(payload.length / 2);
      events.push(`event: message\ndata: ${payload.slice(0, mid)}\ndata: ${payload.slice(mid)}\n\n`);
    } else {
      events.push(`event: message\ndata: ${payload}\n\n`);
    }
    const body = events.join("");
    res.end(options.sseCrTerminated ? body.replace(/\n/g, "\r") : body);
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(payload);
}

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: StubRequest[] = [];

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      requests.push({ httpMethod: req.method ?? "", headers: req.headers, body: undefined });
      res.statusCode = options.getStatus ?? 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    requests.push({ httpMethod: "POST", headers: req.headers, body });

    const method: string = typeof body?.method === "string" ? body.method : "";
    if (options.hangMethods?.includes(method)) return; // deliberately no response
    const isNotification = body === undefined || body.id === undefined || body.id === null;
    if (isNotification) {
      res.statusCode = options.notificationStatus ?? 202;
      if (options.notificationBody !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(options.notificationBody);
      } else {
        res.end();
      }
      return;
    }
    const failure = options.failMethods?.[method];
    if (failure) {
      res.statusCode = failure.status;
      res.setHeader("content-type", "text/plain");
      res.end(failure.body);
      return;
    }
    writeResponse(res, stubResponse(body, options), options);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * withStub runs a test against one stub server and always closes the stub and
 * every connected client, even when connectServer throws mid-test.
 */
async function withStub(
  options: StubOptions,
  run: (
    stub: Stub,
    connect: (spec?: Partial<MCPServerSpec>, connectOptions?: ConnectOptions) => Promise<MCPClient>,
  ) => Promise<void>,
): Promise<void> {
  const stub = await startStub(options);
  const clients: MCPClient[] = [];
  try {
    await run(stub, async (spec = {}, connectOptions = {}) => {
      const client = await connectServer({ key: "board", url: stub.url, ...spec }, connectOptions);
      clients.push(client);
      return client;
    });
  } finally {
    for (const client of clients) client.close();
    await stub.close();
  }
}

const READ_TOOL: StubTool = { name: "read_board", description: "Read the board", inputSchema: { type: "object" } };

// ---- config parsing -------------------------------------------------------

test("config: accepts all HTTP entry types and keeps config order", () => {
  const parsed = parseMCPConfig(
    JSON.stringify({
      mcpServers: {
        board: { url: "http://127.0.0.1:1/mcp/x" },
        a: { type: "http", url: "http://example.com/a" },
        b: { type: "streamable-http", url: "https://example.com/b" },
        c: { type: "streamableHttp", url: "http://example.com/c" },
        d: { type: "streamable_http", url: "http://example.com/d" },
        e: { url: "http://example.com/e", headers: { authorization: "Bearer x" } },
      },
    }),
  );
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.servers.map((spec) => spec.key),
    ["board", "a", "b", "c", "d", "e"],
  );
  assert.equal(parsed.servers[0].url, "http://127.0.0.1:1/mcp/x");
  assert.deepEqual(parsed.servers[5].headers, { authorization: "Bearer x" });
});

test("config: absent or empty raw yields no servers and no errors", () => {
  assert.deepEqual(parseMCPConfig(undefined), { servers: [], errors: [] });
  assert.deepEqual(parseMCPConfig(""), { servers: [], errors: [] });
  assert.deepEqual(parseMCPConfig("   "), { servers: [], errors: [] });
});

test("config: malformed JSON and missing mcpServers are non-fatal", () => {
  const badJson = parseMCPConfig("{nope");
  assert.equal(badJson.servers.length, 0);
  assert.match(badJson.errors[0], /invalid JSON/);

  const noServers = parseMCPConfig('{"other":1}');
  assert.equal(noServers.servers.length, 0);
  assert.match(noServers.errors[0], /mcpServers/);

  const arrayServers = parseMCPConfig('{"mcpServers":[]}');
  assert.equal(arrayServers.servers.length, 0);
  assert.match(arrayServers.errors[0], /mcpServers/);

  const arrayRoot = parseMCPConfig("[]");
  assert.equal(arrayRoot.servers.length, 0);
  assert.match(arrayRoot.errors[0], /JSON object/);
});

test("config: stdio entries are rejected with a clear message", () => {
  const parsed = parseMCPConfig(
    JSON.stringify({
      mcpServers: {
        cmd: { command: "npx", args: ["-y", "server"] },
        typed: { type: "stdio", command: "node" },
      },
    }),
  );
  assert.equal(parsed.servers.length, 0);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /stdio/);
  assert.match(parsed.errors[1], /stdio/);
});

test("config: legacy sse and unknown types are rejected", () => {
  const parsed = parseMCPConfig(
    JSON.stringify({
      mcpServers: {
        legacy: { type: "sse", url: "http://example.com/sse" },
        weird: { type: "websocket", url: "ws://example.com" },
      },
    }),
  );
  assert.equal(parsed.servers.length, 0);
  assert.match(parsed.errors[0], /legacy HTTP\+SSE/);
  assert.match(parsed.errors[1], /unsupported type "websocket"/);
});

test("config: missing/invalid urls are rejected, valid servers survive", () => {
  const parsed = parseMCPConfig(
    JSON.stringify({
      mcpServers: {
        missing: { type: "http" },
        empty: { url: "   " },
        bad: { url: "not a url" },
        scheme: { url: "ftp://example.com/mcp" },
        nonString: { url: 7 },
        good: { url: "http://example.com/mcp" },
      },
    }),
  );
  assert.deepEqual(
    parsed.servers.map((spec) => spec.key),
    ["good"],
  );
  assert.equal(parsed.errors.length, 5);
  assert.match(parsed.errors[0], /missing url/);
  assert.match(parsed.errors[1], /missing url/);
  assert.match(parsed.errors[2], /invalid url/);
  assert.match(parsed.errors[3], /http\(s\)/);
  assert.match(parsed.errors[4], /missing url/);
});

test("config: non-object entries and bad headers are rejected per entry", () => {
  const parsed = parseMCPConfig(
    JSON.stringify({
      mcpServers: {
        scalar: "http://example.com",
        badHeaders: { url: "http://example.com/mcp", headers: { x: 1 } },
        good: { url: "http://example.com/good" },
      },
    }),
  );
  assert.deepEqual(
    parsed.servers.map((spec) => spec.key),
    ["good"],
  );
  assert.match(parsed.errors[0], /entry must be an object/);
  assert.match(parsed.errors[1], /header "x" must be a string/);
});

// ---- transport ------------------------------------------------------------

test("JSON mode: handshake, tools/list, tools/call and protocol header", { timeout: 10000 }, async () => {
  await withStub(
    {
      toolsPages: [{ tools: [READ_TOOL] }],
      toolResults: { read_board: { text: "rect r1 at 0,0" } },
    },
    async (stub, connect) => {
      const client = await connect({ headers: { "x-api-key": "k" } });
      assert.equal(client.protocolVersion, "2025-06-18");
      assert.deepEqual(client.serverInfo, { name: "board", version: "0.0.1" });

      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_board"],
      );
      assert.equal(tools[0].description, "Read the board");

      const result = await client.callTool("read_board", { board: "b_x" });
      assert.equal(result.text, "rect r1 at 0,0");
      assert.equal(result.isError, false);

      assert.deepEqual(
        stub.requests.map((r) => r.body?.method),
        ["initialize", "notifications/initialized", "tools/list", "tools/call"],
      );
      const init = stub.requests[0];
      assert.equal(init.headers["mcp-protocol-version"], undefined);
      assert.equal(init.headers["accept"], "application/json, text/event-stream");
      assert.equal(init.headers["x-api-key"], "k");
      assert.deepEqual(init.body.params.capabilities, {});
      assert.equal(typeof init.body.params.clientInfo.name, "string");
      assert.equal(init.body.params.protocolVersion, "2025-06-18");
      for (const r of stub.requests.slice(1)) {
        assert.equal(r.headers["mcp-protocol-version"], "2025-06-18");
      }
      assert.equal(stub.requests[1].body.id, undefined); // notifications/initialized has no id
      assert.equal(stub.requests[1].body.params, undefined);
      assert.equal(stub.requests[2].body.params.cursor, undefined);
    },
  );
});

test("connect accepts the server-echoed protocol version and uses it afterwards", { timeout: 10000 }, async () => {
  await withStub(
    {
      initializeResult: () => ({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "9" },
      }),
      toolsPages: [{ tools: [READ_TOOL] }],
    },
    async (stub, connect) => {
      const client = await connect({ key: "board" }, { protocolVersion: "2025-06-18" });
      assert.equal(client.protocolVersion, "2025-11-25");
      await client.listTools();
      assert.equal(stub.requests[0].body.params.protocolVersion, "2025-06-18");
      const listRequest = stub.requests.find((r) => r.body?.method === "tools/list");
      assert.equal(listRequest?.headers["mcp-protocol-version"], "2025-11-25");
    },
  );
});

test("connectServer: the handshake signal also bounds a hung notifications/initialized POST", { timeout: 10000 }, async () => {
  await withStub({ hangMethods: ["notifications/initialized"] }, async (stub, connect) => {
    const controller = new AbortController();
    const connecting = connect({}, { signal: controller.signal });
    // Abort only once the initialized POST is actually in flight, so the test
    // cannot pass by aborting the initialize request instead.
    await waitFor(() => stub.requests.some((r) => r.body?.method === "notifications/initialized"));
    controller.abort();
    await assert.rejects(connecting, (err: Error) => {
      assert.match(err.name, /AbortError/);
      return true;
    });
  });
});

test("SSE mode: event streams with noise and multi-line data are parsed", { timeout: 10000 }, async () => {
  await withStub(
    {
      sse: true,
      sseNoise: true,
      sseMultiline: true,
      toolsPages: [{ tools: [READ_TOOL] }],
      toolResults: { read_board: { text: "sse text" } },
    },
    async (_stub, connect) => {
      const client = await connect();
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_board"],
      );
      const result = await client.callTool("read_board", {});
      assert.equal(result.text, "sse text");
      assert.equal(result.isError, false);
    },
  );
});

test("SSE mode: bare CR line terminators are parsed", { timeout: 10000 }, async () => {
  await withStub(
    {
      sse: true,
      sseCrTerminated: true,
      toolsPages: [{ tools: [READ_TOOL] }],
      toolResults: { read_board: { text: "cr text" } },
    },
    async (_stub, connect) => {
      const client = await connect();
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["read_board"],
      );
      const result = await client.callTool("read_board", {});
      assert.equal(result.text, "cr text");
    },
  );
});

test("tools/list paginates across pages until nextCursor is absent", { timeout: 10000 }, async () => {
  await withStub(
    {
      toolsPages: [
        { tools: [{ name: "a" }] },
        { tools: [{ name: "b" }, { name: "c" }] },
        { tools: [{ name: "d" }] },
      ],
    },
    async (stub, connect) => {
      const client = await connect();
      const tools = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["a", "b", "c", "d"],
      );
      const listRequests = stub.requests.filter((r) => r.body?.method === "tools/list");
      assert.equal(listRequests.length, 3);
      assert.equal(listRequests[0].body.params.cursor, undefined);
      assert.deepEqual(
        listRequests.slice(1).map((r) => r.body.params.cursor),
        ["1", "2"],
      );
    },
  );
});

test("tools/list rejects a repeated cursor instead of looping forever", { timeout: 10000 }, async () => {
  await withStub({ toolsPages: [{ tools: [{ name: "a" }] }], repeatCursor: "same" }, async (_stub, connect) => {
    const client = await connect();
    await assert.rejects(client.listTools(), /repeated cursor/);
  });
});

test("tools/call joins text parts and propagates isError", { timeout: 10000 }, async () => {
  await withStub(
    {
      toolResults: {
        multi: { texts: ["line one", "line two"] },
        bad: { text: "unknown tool rm_rf", isError: true },
      },
    },
    async (_stub, connect) => {
      const client = await connect();
      const ok = await client.callTool("multi", {});
      assert.equal(ok.text, "line one\nline two");
      assert.equal(ok.isError, false);
      const bad = await client.callTool("bad", {});
      assert.equal(bad.text, "unknown tool rm_rf");
      assert.equal(bad.isError, true);
    },
  );
});

test("a JSON-RPC error response throws a clear Error", { timeout: 10000 }, async () => {
  await withStub({ toolResults: { mystery: { rpcError: { code: -32601, message: "method not found" } } } }, async (_stub, connect) => {
    const client = await connect();
    await assert.rejects(client.callTool("mystery", {}), /MCP error -32601: method not found/);
  });
});

test("a malformed JSON-RPC error member throws instead of returning an empty result", { timeout: 10000 }, async () => {
  await withStub({ toolResults: { broken: { rawError: "boom" } } }, async (_stub, connect) => {
    const client = await connect();
    await assert.rejects(client.callTool("broken", {}), (err: Error) => {
      assert.match(err.message, /malformed JSON-RPC error/);
      assert.match(err.message, /boom/);
      return true;
    });
  });
});

test("an unreachable server rejects with a clear transport error", { timeout: 10000 }, async () => {
  // A port that was just closed gives a deterministic ECONNREFUSED without
  // depending on a fixed port number.
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  await assert.rejects(connectServer({ key: "board", url: `http://127.0.0.1:${port}/mcp/x` }), (err: Error) => {
    assert.match(err.message, /MCP initialize failed/);
    assert.match(err.message, /ECONNREFUSED|bad port/);
    return true;
  });
});

test("ping succeeds", { timeout: 10000 }, async () => {
  await withStub({ toolsPages: [{ tools: [] }] }, async (stub, connect) => {
    const client = await connect();
    await client.ping();
    assert.ok(stub.requests.some((r) => r.body?.method === "ping"));
  });
});

test("notifications tolerate 202 empty, 200 JSON, and 204 responses", { timeout: 10000 }, async () => {
  const variants: StubOptions[] = [
    { notificationStatus: 202 },
    { notificationStatus: 200, notificationBody: '{"jsonrpc":"2.0","result":{}}' },
    { notificationStatus: 204 },
  ];
  for (const variant of variants) {
    await withStub({ ...variant, toolsPages: [{ tools: [] }] }, async (stub, connect) => {
      const client = await connect();
      await client.listTools();
      assert.ok(stub.requests.some((r) => r.body?.method === "notifications/initialized"));
    });
  }
});

test("a GET/SSE stream is never needed (405 GET is tolerated and never called)", { timeout: 10000 }, async () => {
  await withStub({ getStatus: 405, toolsPages: [{ tools: [READ_TOOL] }] }, async (stub, connect) => {
    const client = await connect();
    await client.listTools();
    assert.equal(stub.requests.filter((r) => r.httpMethod === "GET").length, 0);
  });
});

test("non-2xx responses throw with the status and a short body excerpt", { timeout: 10000 }, async () => {
  await withStub(
    { failMethods: { "tools/list": { status: 503, body: "server exploded: " + "x".repeat(500) } } },
    async (_stub, connect) => {
      const client = await connect();
      await assert.rejects(client.listTools(), (err: Error) => {
        assert.match(err.message, /HTTP 503/);
        assert.match(err.message, /server exploded/);
        assert.ok(err.message.length < 400, `message should carry a short excerpt, got ${err.message.length} chars`);
        return true;
      });
    },
  );
});

test("aborting an in-flight call rejects and sends notifications/cancelled", { timeout: 10000 }, async () => {
  await withStub({ hangMethods: ["tools/call"] }, async (stub, connect) => {
    const client = await connect();
    const controller = new AbortController();
    const call = client.callTool("read_board", { board: "b_x" }, { signal: controller.signal });
    await waitFor(() => stub.requests.some((r) => r.body?.method === "tools/call"));
    controller.abort();
    await assert.rejects(call, (err: Error) => err.name === "AbortError");
    await waitFor(() => stub.requests.some((r) => r.body?.method === "notifications/cancelled"));
    const cancelled = stub.requests.find((r) => r.body?.method === "notifications/cancelled");
    const callRequest = stub.requests.find((r) => r.body?.method === "tools/call");
    assert.equal(cancelled?.body.params.requestId, callRequest?.body.id);
    assert.equal(cancelled?.body.params.reason, "client aborted");
  });
});

test("close() aborts an in-flight call and sends a cancellation", { timeout: 10000 }, async () => {
  await withStub({ hangMethods: ["tools/call"] }, async (stub, connect) => {
    const client = await connect();
    const call = client.callTool("read_board", {});
    await waitFor(() => stub.requests.some((r) => r.body?.method === "tools/call"));
    client.close();
    await assert.rejects(call, (err: Error) => err.name === "AbortError");
    await waitFor(() => stub.requests.some((r) => r.body?.method === "notifications/cancelled"));
  });
});

// ---- naming (plan R5 / risk R-sanitize) -----------------------------------

test("tool mappings: sanitize to provider-safe names and keep originals", () => {
  const mappings = buildToolMappings([
    { key: "my server!", tools: [{ name: "weird tool.name/x?", description: "d", inputSchema: { type: "object" } }] },
  ]);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0].piName, "mcp__my_server___weird_tool_name_x_");
  assert.equal(mappings[0].serverKey, "my server!");
  assert.equal(mappings[0].toolName, "weird tool.name/x?");
  assert.equal(mappings[0].description, "d");
  assert.match(mappings[0].piName, /^[A-Za-z0-9_-]+$/);
});

test("tool mappings: collisions get deterministic unique suffixes", () => {
  const servers = [
    {
      key: "board",
      tools: [
        { name: "a b", description: "", inputSchema: {} },
        { name: "a_b", description: "", inputSchema: {} },
        { name: "a-b", description: "", inputSchema: {} },
      ],
    },
  ];
  const first = buildToolMappings(servers);
  assert.deepEqual(
    first.map((m) => m.piName),
    ["mcp__board__a_b", "mcp__board__a_b_2", "mcp__board__a-b"],
  );
  assert.equal(new Set(first.map((m) => m.piName)).size, 3);
  assert.equal(first[1].toolName, "a_b");
  assert.equal(first[1].serverKey, "board");
  const second = buildToolMappings(servers);
  assert.deepEqual(
    second.map((m) => m.piName),
    first.map((m) => m.piName),
  );
});

test("tool mappings: sanitized server keys that collide are disambiguated", () => {
  const mappings = buildToolMappings([
    { key: "a b", tools: [{ name: "t", description: "", inputSchema: {} }] },
    { key: "a_b", tools: [{ name: "t", description: "", inputSchema: {} }] },
  ]);
  assert.deepEqual(
    mappings.map((m) => m.piName),
    ["mcp__a_b__t", "mcp__a_b__t_2"],
  );
  assert.deepEqual(
    mappings.map((m) => m.serverKey),
    ["a b", "a_b"],
  );
});

test("tool mappings: empty segments become 'unnamed'", () => {
  const mappings = buildToolMappings([{ key: "", tools: [{ name: "", description: "", inputSchema: {} }] }]);
  assert.equal(mappings[0].piName, "mcp__unnamed__unnamed");
});

test("tool mappings: long names are capped at 64 chars and stay unique", () => {
  const long = "x".repeat(200);
  const mappings = buildToolMappings([
    {
      key: "s".repeat(80),
      tools: [
        { name: long, description: "", inputSchema: {} },
        { name: long, description: "", inputSchema: {} },
      ],
    },
  ]);
  for (const mapping of mappings) assert.ok(mapping.piName.length <= 64, mapping.piName);
  assert.ok(mappings[0].piName.startsWith("mcp__"));
  assert.notEqual(mappings[0].piName, mappings[1].piName);
  assert.equal(mappings[0].toolName, long);
});
