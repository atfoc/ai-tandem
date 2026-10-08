// Unit tests for the pure MCP wiring logic (mcp-wiring.ts): config-source
// precedence, the app-owned board predicate, the auto-allow set, the
// notice/stderr failure channel, the subagent wording, and the full
// connect/discover/register/close lifecycle against an in-process stub server.
// Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/mcp-wiring.test.ts
//
// No pi, no real app, no npm packages, nothing outside 127.0.0.1.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { parseMCPConfig } from "../mcp.ts";
import {
  autoAllowedToolNames,
  appSourced,
  boardServerActive,
  configNotice,
  makeNoticeSink,
  mcpToolResultOrThrow,
  piToolParameters,
  selectMCPConfig,
  serverNotice,
  startMCP,
  stderrNoticeLine,
  subagentDescription,
  subagentPromptSnippet,
  STDERR_NOTICE_PREFIX,
  type MCPSelection,
} from "../mcp-wiring.ts";

// ---- stub server ----------------------------------------------------------

interface StubTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface StubOptions {
  /** Successive tools/list pages (cursor "1" is page index 1, ...). */
  pages?: { tools: StubTool[] }[];
  /** Answer tools/list with HTTP 503. */
  failList?: boolean;
  /** Accept tools/call but never answer (for close/abort tests). */
  hangCall?: boolean;
  /** Accept initialize but never answer (connect-budget tests). */
  hangInitialize?: boolean;
  /** Answer initialize, then accept but never answer notifications/initialized. */
  hangNotification?: boolean;
  /** Answer the handshake, then accept but never answer tools/list. */
  hangList?: boolean;
  /** Per-tool tools/call results. */
  callResults?: Record<string, { text?: string; isError?: boolean }>;
}

interface StubRequest {
  method: string;
  protocol: string;
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

async function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: StubRequest[] = [];
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
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
    const method: string = typeof body?.method === "string" ? body.method : "";
    requests.push({ method, protocol: String(req.headers["mcp-protocol-version"] ?? ""), body });
    if (body === undefined || body.id === undefined || body.id === null) {
      if (options.hangNotification && method === "notifications/initialized") return; // deliberately no response
      res.statusCode = 202;
      res.end();
      return;
    }
    if (options.hangInitialize && method === "initialize") return; // deliberately no response
    if (options.hangList && method === "tools/list") return; // deliberately no response
    const send = (message: unknown): void => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(message));
    };
    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "board", version: "0.0.1" },
          },
        });
        return;
      case "tools/list": {
        if (options.failList) {
          res.statusCode = 503;
          res.setHeader("content-type", "text/plain");
          res.end("discovery exploded");
          return;
        }
        const pages = options.pages ?? [{ tools: [] }];
        let index = 0;
        if (typeof body.params?.cursor === "string" && body.params.cursor !== "") {
          const parsed = Number(body.params.cursor);
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
        if (index + 1 < pages.length) result.nextCursor = String(index + 1);
        send({ jsonrpc: "2.0", id: body.id, result });
        return;
      }
      case "tools/call": {
        if (options.hangCall) return; // deliberately no response
        const spec = options.callResults?.[body.params?.name];
        const content = [{ type: "text", text: spec?.text ?? `called ${body.params?.name}` }];
        const result: Record<string, unknown> = { content };
        if (spec?.isError) result.isError = true;
        send({ jsonrpc: "2.0", id: body.id, result });
        return;
      }
      case "ping":
        send({ jsonrpc: "2.0", id: body.id, result: {} });
        return;
      default:
        send({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `method not found: ${method}` } });
    }
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

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function selectionOf(raw: string, source: MCPSelection["source"] = "env"): MCPSelection {
  return { source, raw };
}

// ---- config source selection ----------------------------------------------

test("selectMCPConfig: the flag wins over the environment", () => {
  const flag = '{"mcpServers":{"flag":{"url":"http://flag"}}}';
  const env = '{"mcpServers":{"env":{"url":"http://env"}}}';
  assert.deepEqual(selectMCPConfig(flag, env), { source: "flag", raw: flag });
  assert.deepEqual(selectMCPConfig(undefined, env), { source: "env", raw: env });
  assert.deepEqual(selectMCPConfig(undefined, undefined), { source: "none", raw: undefined });
});

test("selectMCPConfig: empty/absent values mean none and fall through", () => {
  const env = '{"mcpServers":{"env":{"url":"http://env"}}}';
  assert.deepEqual(selectMCPConfig("", env), { source: "env", raw: env });
  assert.deepEqual(selectMCPConfig("   ", env), { source: "env", raw: env });
  assert.deepEqual(selectMCPConfig(undefined, ""), { source: "none", raw: undefined });
  assert.deepEqual(selectMCPConfig(undefined, "  "), { source: "none", raw: undefined });
  // A malformed but non-empty flag still wins: it is the app's job to reject it
  // through the notice channel, not to silently use the environment.
  assert.deepEqual(selectMCPConfig("{nope", env), { source: "flag", raw: "{nope" });
});

test("selectMCPConfig: the flag, then the file, then the environment", () => {
  const flag = '{"mcpServers":{"flag":{"url":"http://flag"}}}';
  const env = '{"mcpServers":{"env":{"url":"http://env"}}}';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-mcp-file-"));
  try {
    const file = path.join(dir, "mcp.json");
    const fileRaw = '{"mcpServers":{"board":{"url":"http://file","headers":{"Authorization":"Bearer FILETOKEN"}}}}';
    fs.writeFileSync(file, fileRaw, { mode: 0o600 });

    assert.deepEqual(selectMCPConfig(flag, env, file), { source: "flag", raw: flag });
    assert.deepEqual(selectMCPConfig(undefined, env, file), { source: "file", raw: fileRaw });
    assert.deepEqual(selectMCPConfig("", undefined, file), { source: "file", raw: fileRaw });
    // An empty/absent path falls through to the environment.
    assert.deepEqual(selectMCPConfig(undefined, env, ""), { source: "env", raw: env });
    assert.deepEqual(selectMCPConfig(undefined, env, "  "), { source: "env", raw: env });
    assert.deepEqual(selectMCPConfig(undefined, undefined, undefined), { source: "none", raw: undefined });
    assert.deepEqual(parseMCPConfig(selectMCPConfig(undefined, env, file).raw).servers[0].headers, {
      Authorization: "Bearer FILETOKEN",
    });

    // A file that cannot be read is still the selection (the environment is
    // not silently used instead); the error is carried, never thrown.
    const missing = selectMCPConfig(undefined, env, path.join(dir, "absent.json"));
    assert.equal(missing.source, "file");
    assert.equal(missing.raw, undefined);
    assert.match(missing.error ?? "", /cannot read config file .*absent\.json/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("startMCP: an unreadable or malformed config file is one notice, never a throw", async () => {
  const run = async (selection: MCPSelection): Promise<string[]> => {
    const notices: string[] = [];
    const bootstrap = await startMCP({
      selection,
      register: () => assert.fail("no tool may be registered"),
      notice: (message) => notices.push(message),
    });
    assert.equal(bootstrap.source, "file");
    assert.deepEqual(bootstrap.boardToolNames, []);
    bootstrap.close();
    return notices;
  };
  const unreadable = await run(selectMCPConfig(undefined, undefined, "/nonexistent/aiwb/mcp.json"));
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0], /^config rejected: cannot read config file \/nonexistent\/aiwb\/mcp\.json/);

  const malformed = await run(selectMCPConfig(undefined, undefined, "/any/mcp.json", () => "{nope"));
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /^config rejected: invalid JSON/);
});

test("the file source is app-sourced like the environment; the flag is not", () => {
  assert.equal(appSourced("file"), true);
  assert.equal(appSourced("env"), true);
  assert.equal(appSourced("flag"), false);
  assert.equal(appSourced("none"), false);
  const raw = '{"mcpServers":{"board":{"url":"http://board"}}}';
  assert.equal(
    boardServerActive({ bridgePresent: true, selection: selectionOf(raw, "file"), parsed: parseMCPConfig(raw) }),
    true,
  );
});

// ---- board-active predicate and auto-allow set -----------------------------

test("boardServerActive: only the app-owned env config in an app run counts", () => {
  const envRaw = '{"mcpServers":{"board":{"url":"http://board"}}}';
  const flagRaw = '{"mcpServers":{"board":{"url":"http://board"}}}';
  const envParsed = parseMCPConfig(envRaw);
  const flagParsed = parseMCPConfig(flagRaw);

  assert.equal(
    boardServerActive({ bridgePresent: true, selection: selectionOf(envRaw, "env"), parsed: envParsed }),
    true,
  );
  // No bridge: standalone config is user-supplied, not the app's board server.
  assert.equal(
    boardServerActive({ bridgePresent: false, selection: selectionOf(envRaw, "env"), parsed: envParsed }),
    false,
  );
  // Flag-sourced board key: never the app-owned server (risk R-spoof).
  assert.equal(
    boardServerActive({ bridgePresent: true, selection: selectionOf(flagRaw, "flag"), parsed: flagParsed }),
    false,
  );
  // Env config without a board key.
  assert.equal(
    boardServerActive({
      bridgePresent: true,
      selection: selectionOf('{"mcpServers":{"other":{"url":"http://other"}}}', "env"),
      parsed: parseMCPConfig('{"mcpServers":{"other":{"url":"http://other"}}}'),
    }),
    false,
  );
  // A rejected stdio "board" entry never yields board tools.
  const stdio = '{"mcpServers":{"board":{"command":"npx"}}}';
  assert.equal(
    boardServerActive({ bridgePresent: true, selection: selectionOf(stdio, "env"), parsed: parseMCPConfig(stdio) }),
    false,
  );
  // No config at all.
  assert.equal(
    boardServerActive({ bridgePresent: true, selection: selectMCPConfig(undefined, undefined), parsed: parseMCPConfig(undefined) }),
    false,
  );
});

test("autoAllowedToolNames: board MCP names only when app-sourced", () => {
  const boardMCP = ["mcp__board__read_board", "mcp__board__apply"];

  assert.deepEqual(autoAllowedToolNames({ boardMCPToolNames: boardMCP, appSourcedBoard: true }), boardMCP);
  // Flag-sourced board server: its MCP names are not auto-allowed.
  assert.deepEqual(autoAllowedToolNames({ boardMCPToolNames: boardMCP, appSourcedBoard: false }), []);
  assert.deepEqual(autoAllowedToolNames({ boardMCPToolNames: [], appSourcedBoard: false }), []);
});

// ---- failure channel -------------------------------------------------------

test("configNotice and serverNotice render one clear line", () => {
  assert.equal(configNotice(["invalid JSON: nope", 'server "x": missing url']), 'config rejected: invalid JSON: nope; server "x": missing url');
  assert.equal(
    serverNotice("board", new Error("MCP initialize failed: fetch failed: connect ECONNREFUSED 127.0.0.1:1")),
    'server "board" failed: MCP initialize failed: fetch failed: connect ECONNREFUSED 127.0.0.1:1',
  );
  assert.equal(serverNotice("board", "plain"), 'server "board" failed: plain');
});

test("stderrNoticeLine carries the extension prefix", () => {
  assert.equal(stderrNoticeLine("server \"board\" failed: boom"), `${STDERR_NOTICE_PREFIX}server "board" failed: boom\n`);
});

test("makeNoticeSink: bridge gets one frame, standalone gets one stderr line", () => {
  const sent: string[] = [];
  const written: string[] = [];
  const withBridge = makeNoticeSink({
    bridgePresent: true,
    send: (message) => sent.push(message),
    writeStderr: (chunk) => written.push(chunk),
  });
  withBridge("a");
  withBridge("b");
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(written, []);

  const standalone = makeNoticeSink({
    bridgePresent: false,
    send: (message) => sent.push(message),
    writeStderr: (chunk) => written.push(chunk),
  });
  standalone("c");
  assert.deepEqual(sent, ["a", "b"]);
  assert.deepEqual(written, [`${STDERR_NOTICE_PREFIX}c\n`]);
});

// ---- tool result and parameter conversion ----------------------------------

test("mcpToolResultOrThrow: success is text, isError carries the board text", () => {
  assert.deepEqual(mcpToolResultOrThrow({ text: "rect r1", isError: false, content: [] }, "mcp__board__read_board"), {
    content: [{ type: "text", text: "rect r1" }],
    details: {},
  });
  assert.throws(
    () => mcpToolResultOrThrow({ text: "this chat is archived", isError: true, content: [] }, "mcp__board__read_board"),
    /this chat is archived/,
  );
  // Empty error text falls back to a message naming the pi tool.
  assert.throws(
    () => mcpToolResultOrThrow({ text: "  ", isError: true, content: [] }, "mcp__board__apply"),
    /MCP tool mcp__board__apply failed/,
  );
});

test("piToolParameters: server schema passes through, absent becomes the empty object schema", () => {
  const schema = { type: "object", properties: { board: { type: "string" } }, required: ["board"] };
  assert.equal(piToolParameters(schema), schema);
  assert.deepEqual(piToolParameters(undefined), { type: "object" });
  assert.deepEqual(piToolParameters("nope"), { type: "object" });
  assert.deepEqual(piToolParameters([1, 2]), { type: "object" });
});

// ---- subagent wording ------------------------------------------------------

test("subagent wording mentions board tools only when the board server is active", () => {
  assert.doesNotMatch(subagentDescription(false), /board/i);
  assert.match(subagentDescription(true), /board tools/);
  assert.doesNotMatch(subagentPromptSnippet(false), /board/i);
  assert.match(subagentPromptSnippet(true), /board tools/);
});

// ---- lifecycle -------------------------------------------------------------

test("startMCP: connects, paginates, registers namespaced tools and forwards calls", { timeout: 15000 }, async () => {
  const stub = await startStub({
    pages: [
      {
        tools: [
          { name: "read_board", description: "Read the board", inputSchema: { type: "object", properties: { board: { type: "string" } } } },
          { name: "apply", description: "", inputSchema: undefined },
        ],
      },
      { tools: [{ name: "show_board", description: "Show it" }] },
    ],
    callResults: {
      read_board: { text: "rect r1 at 0,0" },
      apply: { text: "apply failed", isError: true },
    },
  });
  try {
    const registered: any[] = [];
    const notices: string[] = [];
    const bootstrap = await startMCP({
      selection: selectionOf(JSON.stringify({ mcpServers: { board: { url: stub.url } } })),
      register: (tool) => registered.push(tool),
      notice: (message) => notices.push(message),
    });
    try {
      assert.deepEqual(notices, []);
      assert.deepEqual(
        registered.map((tool) => tool.name),
        ["mcp__board__read_board", "mcp__board__apply", "mcp__board__show_board"],
      );
      assert.deepEqual(
        bootstrap.boardToolNames,
        ["mcp__board__read_board", "mcp__board__apply", "mcp__board__show_board"],
      );
      assert.equal(bootstrap.source, "env");
      for (const tool of registered) {
        assert.equal(tool.executionMode, "sequential");
        assert.equal(tool.label, tool.name.replace("mcp__board__", ""));
      }
      assert.equal(registered[0].description, "Read the board");
      // Empty server description falls back to a text naming the tool/server.
      assert.equal(registered[1].description, 'apply (MCP server "board")');
      // A missing schema becomes the empty object schema.
      assert.deepEqual(registered[1].parameters, { type: "object" });
      assert.deepEqual(registered[0].parameters, { type: "object", properties: { board: { type: "string" } } });

      const ok = await registered[0].execute({ board: "b" });
      assert.deepEqual(ok, { content: [{ type: "text", text: "rect r1 at 0,0" }], details: {} });
      await assert.rejects(registered[1].execute({}), /apply failed/);

      const listRequests = stub.requests.filter((r) => r.method === "tools/list");
      assert.equal(listRequests.length, 2, "pagination must list twice");
      assert.equal(listRequests[0].body.params.cursor, undefined);
      assert.equal(listRequests[1].body.params.cursor, "1");
      assert.equal(stub.requests[0].method, "initialize");
      assert.equal(stub.requests[0].protocol, "");
      assert.equal(stub.requests[1].method, "notifications/initialized");
      for (const request of stub.requests.slice(1)) {
        assert.equal(request.protocol, "2025-06-18");
      }
    } finally {
      bootstrap.close();
      bootstrap.close(); // idempotent
    }
  } finally {
    await stub.close();
  }
});

test("startMCP: a connect failure is non-fatal and reports one notice for that server", { timeout: 15000 }, async () => {
  const stub = await startStub({ pages: [{ tools: [{ name: "read_board", description: "Read", inputSchema: { type: "object" } }] }] });
  try {
    const deadPort = await freePort();
    const registered: any[] = [];
    const notices: string[] = [];
    const bootstrap = await startMCP({
      selection: selectionOf(
        JSON.stringify({
          mcpServers: {
            board: { url: stub.url },
            dead: { url: `http://127.0.0.1:${deadPort}/mcp/x` },
          },
        }),
      ),
      register: (tool) => registered.push(tool),
      notice: (message) => notices.push(message),
    });
    try {
      assert.deepEqual(
        registered.map((tool) => tool.name),
        ["mcp__board__read_board"],
      );
      assert.deepEqual(bootstrap.boardToolNames, ["mcp__board__read_board"]);
      assert.equal(notices.length, 1, notices.join(" | "));
      assert.match(notices[0], /^server "dead" failed: /);
      assert.match(notices[0], /MCP initialize failed/);
      assert.match(notices[0], /ECONNREFUSED|bad port/);
    } finally {
      bootstrap.close();
    }
  } finally {
    await stub.close();
  }
});

test("startMCP: a discovery failure leaves that server's tools absent and reports one notice", { timeout: 15000 }, async () => {
  const stub = await startStub({ failList: true });
  try {
    const registered: any[] = [];
    const notices: string[] = [];
    const bootstrap = await startMCP({
      selection: selectionOf(JSON.stringify({ mcpServers: { board: { url: stub.url } } })),
      register: (tool) => registered.push(tool),
      notice: (message) => notices.push(message),
    });
    try {
      assert.deepEqual(registered, []);
      assert.deepEqual(bootstrap.boardToolNames, []);
      assert.equal(notices.length, 1);
      assert.match(notices[0], /^server "board" failed: /);
      assert.match(notices[0], /HTTP 503/);
    } finally {
      bootstrap.close();
    }
  } finally {
    await stub.close();
  }
});

// ---- connect/discovery budget (plan R7/§3.8: a stalling server must not hold
// session_start open forever) -------------------------------------------------

interface StallScenario {
  notices: string[];
  registeredNames: string[];
  /** Observed methods excluding the client's best-effort cancellation notice. */
  stalledMethods: string[];
  /** Whether the abort path sent notifications/cancelled to the stalled server. */
  cancelled: boolean;
  elapsedMs: number;
}

/**
 * runStallScenario starts a healthy server and a server that stalls one phase,
 * runs startMCP with a short 500 ms bound, and asserts the isolation invariants
 * shared by every stall phase: startMCP resolves well inside the test budget,
 * the healthy server's tools are still registered, exactly one notice names the
 * stalled server, and no unhandled rejection escapes (checked for 50 ms after
 * the run). The caller asserts the phase-specific message and observed methods.
 */
async function runStallScenario(stall: StubOptions, expectedPhase: "handshake" | "discovery"): Promise<StallScenario> {
  const healthy = await startStub({
    pages: [{ tools: [{ name: "read_board", description: "Read", inputSchema: { type: "object" } }] }],
  });
  const stalled = await startStub(stall);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    const registered: any[] = [];
    const notices: string[] = [];
    const startedAt = Date.now();
    const bootstrap = await startMCP({
      selection: selectionOf(
        JSON.stringify({ mcpServers: { stalled: { url: stalled.url }, board: { url: healthy.url } } }),
      ),
      register: (tool) => registered.push(tool),
      notice: (message) => notices.push(message),
      handshakeTimeoutMs: 500,
    });
    const elapsedMs = Date.now() - startedAt;
    try {
      assert.ok(elapsedMs < 5000, `startMCP took ${elapsedMs}ms with a 500ms per-server bound`);
      assert.deepEqual(
        registered.map((tool) => tool.name),
        ["mcp__board__read_board"],
        notices.join(" | "),
      );
      assert.equal(notices.length, 1, notices.join(" | "));
      assert.match(notices[0], /^server "stalled" failed: /);
      assert.match(notices[0], new RegExp(`MCP ${expectedPhase} timed out after 500ms`));
      return {
        notices,
        registeredNames: registered.map((tool) => tool.name),
        stalledMethods: stalled.requests
          .map((request) => request.method)
          .filter((method) => method !== "notifications/cancelled"),
        cancelled: stalled.requests.some((request) => request.method === "notifications/cancelled"),
        elapsedMs,
      };
    } finally {
      bootstrap.close();
      bootstrap.close(); // idempotent, and must not abort a settled deadline.
    }
  } finally {
    // Give any late rejection a chance to surface before asserting none did.
    await delay(50);
    process.off("unhandledRejection", onRejection);
    assert.deepEqual(rejections, [], "startMCP leaked an unhandled rejection");
    await healthy.close();
    await stalled.close();
  }
}

// Each of the three stall tests waits out the 500 ms bound and shares nothing with the others, so
// they run at the same time.
describe("startMCP: a stalled server", { concurrency: true }, () => {
  test("startMCP: a server that never answers initialize is bounded and isolated", { timeout: 15000 }, async () => {
    const result = await runStallScenario({ hangInitialize: true }, "handshake");
    assert.deepEqual(result.stalledMethods, ["initialize"]);
    assert.equal(result.cancelled, true, "the aborted initialize should get a best-effort cancellation");
  });

  test("startMCP: a hung notifications/initialized POST is bounded and isolated", { timeout: 15000 }, async () => {
    const result = await runStallScenario({ hangNotification: true }, "handshake");
    assert.deepEqual(result.stalledMethods, ["initialize", "notifications/initialized"]);
    assert.equal(result.cancelled, false, "a notification has no request id to cancel");
  });

  test("startMCP: a hung tools/list discovery is bounded and isolated", { timeout: 15000 }, async () => {
    const result = await runStallScenario({ hangList: true }, "discovery");
    assert.deepEqual(result.stalledMethods, ["initialize", "notifications/initialized", "tools/list"]);
    assert.equal(result.cancelled, true, "the aborted tools/list should get a best-effort cancellation");
  });
});

test("startMCP: a non-positive or non-finite handshake timeout falls back to the default", async () => {
  // No server is contacted: this only pins the normalization of bad values.
  const bootstrap = await startMCP({
    selection: selectionOf('{"mcpServers":{}}'),
    register: () => assert.fail("no tool may be registered"),
    notice: () => assert.fail("no notice may be sent"),
    connect: async () => assert.fail("no server may be connected"),
    handshakeTimeoutMs: 0,
  });
  bootstrap.close();
});

test("startMCP: parse errors are non-fatal and produce one config notice", { timeout: 15000 }, async () => {
  const registered: any[] = [];
  const notices: string[] = [];
  let connected = false;
  const bootstrap = await startMCP({
    // One valid server plus one stdio entry: the stdio entry is rejected with a
    // notice and the rest still start.
    selection: selectionOf(
      JSON.stringify({
        mcpServers: {
          cmd: { command: "npx", args: ["-y", "x"] },
          board: { url: "http://127.0.0.1:1/mcp/x" },
        },
      }),
    ),
    register: (tool) => registered.push(tool),
    notice: (message) => notices.push(message),
    connect: async () => {
      connected = true;
      throw new Error("MCP initialize failed: bad port");
    },
  });
  try {
    assert.equal(connected, true);
    assert.deepEqual(registered, []);
    assert.equal(notices.length, 2, notices.join(" | "));
    assert.match(notices[0], /^config rejected: server "cmd": stdio/);
    assert.match(notices[1], /^server "board" failed: /);
    // Both failures ran through the injected connect seam independently.
    assert.deepEqual(bootstrap.boardToolNames, []);
  } finally {
    bootstrap.close();
  }
});

test("startMCP: no config connects nothing and registers nothing", async () => {
  let called = false;
  const bootstrap = await startMCP({
    selection: selectMCPConfig(undefined, undefined),
    register: () => assert.fail("no tool may be registered without a config"),
    notice: () => assert.fail("no notice may be sent without a config"),
    connect: async () => {
      called = true;
      throw new Error("must not connect");
    },
  });
  assert.equal(called, false);
  assert.equal(bootstrap.source, "none");
  assert.deepEqual(bootstrap.boardToolNames, []);
  bootstrap.close();
});

test("startMCP: close aborts an in-flight call and closes the client", { timeout: 15000 }, async () => {
  const stub = await startStub({ pages: [{ tools: [{ name: "read_board", description: "", inputSchema: { type: "object" } }] }], hangCall: true });
  try {
    const registered: any[] = [];
    const bootstrap = await startMCP({
      selection: selectionOf(JSON.stringify({ mcpServers: { board: { url: stub.url } } })),
      register: (tool) => registered.push(tool),
      notice: () => assert.fail("no notice expected"),
    });
    const call = registered[0].execute({ board: "b" });
    await waitFor(() => stub.requests.some((r) => r.method === "tools/call"));
    bootstrap.close();
    await assert.rejects(call, (err: Error) => err.name === "AbortError");
    // The client is closed: later calls fail fast with a clear message.
    await assert.rejects(registered[0].execute({ board: "b" }), /MCP client is closed/);
    await waitFor(() => stub.requests.some((r) => r.method === "notifications/cancelled"));
  } finally {
    await stub.close();
  }
});
