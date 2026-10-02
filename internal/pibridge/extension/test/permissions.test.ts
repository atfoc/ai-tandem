// Unit tests for the pure permission gate (permissions.ts). Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/permissions.test.ts
// A fake net.createServer records the ask frames and answers them; no pi, no
// real app socket. Mirrors protocol.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callBridge, decodeFrame, encodeFrame, type BridgeFrame } from "../protocol.ts";
import { ASK_TIMEOUT_MS, DEFAULT_DENY_REASON, handleToolCall, subIdentity } from "../permissions.ts";

// The seven raw native board tool names the app used to register. Since the
// Phase 4 switchover the app registers only the MCP-namespaced names, and the
// old parity asset is gone (Phase 5): this self-contained list keeps pinning
// that raw names are not auto-allowed. boardMCPTools is the app-sourced board
// server's tool set.
const boardTools: string[] = [
  "list_boards",
  "read_board",
  "get_view",
  "apply",
  "delete_elements",
  "create_board",
  "show_board",
];

const boardMCPTools = boardTools.map((name) => `mcp__board__${name}`);

interface FakeServer {
  socketPath: string;
  frames: BridgeFrame[];
  close(): Promise<void>;
}

// startServer records every decoded frame and answers with respond(frame)
// unless it returns null (silent, for timeout tests).
async function startServer(respond: (frame: BridgeFrame) => object | null): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-perm-"));
  const socketPath = path.join(dir, "s.sock");
  const sockets = new Set<net.Socket>();
  const frames: BridgeFrame[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() === "") continue;
        const frame = decodeFrame(line);
        frames.push(frame);
        const response = respond(frame);
        if (response) socket.write(encodeFrame({ id: frame.id, ...response }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
    frames,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

// gateDeps wires the gate's real ask path through callBridge to the fake server.
function gateDeps(
  socketPath: string,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number; autoAllowed?: string[] } = {},
) {
  return {
    run: "run-1",
    env: opts.env ?? {},
    autoAllowed: opts.autoAllowed ?? boardMCPTools,
    ask: (frame: object, timeoutMs: number) => callBridge(socketPath, frame, timeoutMs),
    timeoutMs: opts.timeoutMs,
  };
}

test("ask timeout outlives the adapter's 10-minute decision window", () => {
  assert.equal(ASK_TIMEOUT_MS, 11 * 60 * 1000);
});

test("raw native board names are no longer auto-allowed and ask like any other tool", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    for (const name of boardTools) {
      const decision = await handleToolCall(
        { toolName: name, toolCallId: `c-${name}`, input: { board: "b" } },
        gateDeps(srv.socketPath, { autoAllowed: boardMCPTools }),
      );
      assert.equal(decision, undefined, `${name} must be gated (no native auto-allow)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      srv.frames.map((frame) => frame.name),
      boardTools,
      "every raw native name must produce exactly one ask frame",
    );
  } finally {
    await srv.close();
  }
});

test("app-sourced board MCP tools are auto-allowed with no ask frame", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    for (const name of boardMCPTools) {
      const decision = await handleToolCall(
        { toolName: name, toolCallId: `c-${name}`, input: { board: "b" } },
        gateDeps(srv.socketPath, { autoAllowed: boardMCPTools }),
      );
      assert.equal(decision, undefined, `${name} must be allowed`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(srv.frames, []);
  } finally {
    await srv.close();
  }
});

test("a non-board MCP tool sends exactly one ask frame", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    const decision = await handleToolCall(
      { toolName: "mcp__other__read", toolCallId: "mcp-1", input: { q: "x" } },
      gateDeps(srv.socketPath, { autoAllowed: boardMCPTools }),
    );
    assert.equal(decision, undefined);
    assert.deepEqual(srv.frames, [
      { kind: "ask", run: "run-1", id: "mcp-1", name: "mcp__other__read", input: { q: "x" } },
    ]);
  } finally {
    await srv.close();
  }
});

test("a flag-sourced board-key server is not auto-allowed", async () => {
  const srv = await startServer(() => ({ ok: true, allow: false, reason: "ask first" }));
  try {
    // Flag-sourced servers never enter the auto-allow set, even when keyed
    // "board": the gate must ask exactly once.
    const decision = await handleToolCall(
      { toolName: "mcp__board__read_board", toolCallId: "flag-1", input: { board: "b" } },
      gateDeps(srv.socketPath, { autoAllowed: [] }),
    );
    assert.deepEqual(decision, { block: true, reason: "ask first" });
    assert.deepEqual(srv.frames, [
      { kind: "ask", run: "run-1", id: "flag-1", name: "mcp__board__read_board", input: { board: "b" } },
    ]);
  } finally {
    await srv.close();
  }
});

test("the subagent tool is auto-allowed with no ask frame", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    const decision = await handleToolCall({ toolName: "subagent", toolCallId: "s1", input: { prompt: "do it" } }, gateDeps(srv.socketPath));
    assert.equal(decision, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(srv.frames, []);
  } finally {
    await srv.close();
  }
});

test("a built-in allow sends exactly one ask frame and lets the tool run", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true, reason: "" }));
  try {
    const decision = await handleToolCall(
      { toolName: "bash", toolCallId: "call-1", input: { command: "ls" } },
      gateDeps(srv.socketPath),
    );
    assert.equal(decision, undefined);
    assert.deepEqual(srv.frames, [
      { kind: "ask", run: "run-1", id: "call-1", name: "bash", input: { command: "ls" } },
    ]);
  } finally {
    await srv.close();
  }
});

test("deny blocks with the adapter's reason", async () => {
  const srv = await startServer(() => ({ ok: true, allow: false, reason: "The user said no in AI Whiteboard." }));
  try {
    const decision = await handleToolCall({ toolName: "write", toolCallId: "call-2", input: {} }, gateDeps(srv.socketPath));
    assert.deepEqual(decision, { block: true, reason: "The user said no in AI Whiteboard." });
  } finally {
    await srv.close();
  }
});

test("an ok:false response blocks fail-safe", async () => {
  const srv = await startServer(() => ({ ok: false, error: "no run handler" }));
  try {
    const decision = await handleToolCall({ toolName: "read", toolCallId: "call-3", input: {} }, gateDeps(srv.socketPath));
    assert.deepEqual(decision, { block: true, reason: "no run handler" });
  } finally {
    await srv.close();
  }
});

test("a malformed allow answer blocks with the default reason", async () => {
  const srv = await startServer(() => ({ ok: true })); // no allow field
  try {
    const decision = await handleToolCall({ toolName: "edit", toolCallId: "call-4", input: {} }, gateDeps(srv.socketPath));
    assert.deepEqual(decision, { block: true, reason: DEFAULT_DENY_REASON });
  } finally {
    await srv.close();
  }
});

test("allow:false without a reason blocks with the default reason", async () => {
  const srv = await startServer(() => ({ ok: true, allow: false }));
  try {
    const decision = await handleToolCall({ toolName: "grep", toolCallId: "call-5", input: {} }, gateDeps(srv.socketPath));
    assert.deepEqual(decision, { block: true, reason: DEFAULT_DENY_REASON });
  } finally {
    await srv.close();
  }
});

test("an unreachable socket blocks fail-safe", async () => {
  const missing = path.join(os.tmpdir(), `aiwb-perm-missing-${process.pid}`, "s.sock");
  const decision = await handleToolCall({ toolName: "read", toolCallId: "call-6", input: {} }, gateDeps(missing, { timeoutMs: 500 }));
  assert.equal(decision?.block, true);
  assert.match(decision!.reason, /permission request failed/);
  assert.match(decision!.reason, /read was not run/);
});

test("an ask timeout blocks fail-safe with a short injected timeout", async () => {
  const srv = await startServer(() => null); // accept, never answer
  try {
    const decision = await handleToolCall(
      { toolName: "write", toolCallId: "call-7", input: {} },
      gateDeps(srv.socketPath, { timeoutMs: 50 }),
    );
    assert.equal(decision?.block, true);
    assert.match(decision!.reason, /permission request failed/);
    assert.match(decision!.reason, /timed out/);
    assert.match(decision!.reason, /write was not run/);
  } finally {
    await srv.close();
  }
});

test("a child's sub identity is forwarded exactly", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    const env = { AIWB_SUB_PARENT: "tool-9", AIWB_SUB_DEPTH: "1", AIWB_SUB_CHILD: "child-1" };
    const decision = await handleToolCall(
      { toolName: "edit", toolCallId: "inner-2", input: { path: "a.ts" } },
      gateDeps(srv.socketPath, { env }),
    );
    assert.equal(decision, undefined);
    assert.deepEqual(srv.frames, [
      {
        kind: "ask",
        run: "run-1",
        id: "inner-2",
        name: "edit",
        input: { path: "a.ts" },
        sub: { parent: "tool-9", depth: 1, child: "child-1" },
      },
    ]);
  } finally {
    await srv.close();
  }
});

test("a parent run sends no sub field and defaults a missing input to {}", async () => {
  const srv = await startServer(() => ({ ok: true, allow: true }));
  try {
    const decision = await handleToolCall({ toolName: "find", toolCallId: "call-8" }, gateDeps(srv.socketPath));
    assert.equal(decision, undefined);
    assert.deepEqual(srv.frames, [{ kind: "ask", run: "run-1", id: "call-8", name: "find", input: {} }]);
    assert.equal("sub" in (srv.frames[0] as object), false);
  } finally {
    await srv.close();
  }
});

test("subIdentity derives parent/depth/child from the child env", () => {
  assert.equal(subIdentity({}), undefined);
  assert.deepEqual(subIdentity({ AIWB_SUB_PARENT: "p" }), { parent: "p", depth: 0, child: "" });
  assert.deepEqual(
    subIdentity({ AIWB_SUB_PARENT: "p", AIWB_SUB_DEPTH: "2", AIWB_SUB_CHILD: "c" }),
    { parent: "p", depth: 2, child: "c" },
  );
});
