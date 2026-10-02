// Unit tests for the app subagent tool (subagent.ts). Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/subagent.test.ts
//
// A fake bridge socket server records the activity frames (kind/run/sub/event)
// and a fake `pi` executable (a small node script in a temp dir, selected via
// AIWB_PI_BIN) drives the child RPC stream and can spawn a long-lived
// grandchild; no real pi runs. Every process spawned by a test is tracked in a
// PID file and killed on the test's failure path too.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callBridge, decodeFrame, encodeFrame, type BridgeFrame } from "../protocol.ts";
import { runSubagent, type SubagentFrame, type SubagentParams, type SubagentToolResult } from "../subagent.ts";

// ---------------------------------------------------------------------------
// fake bridge socket

interface FakeBridge {
  socketPath: string;
  frames: BridgeFrame[];
  close(): Promise<void>;
}

async function startBridge(): Promise<FakeBridge> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-sub-bridge-"));
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
        socket.write(encodeFrame({ id: frame.id, ok: true }));
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

// ---------------------------------------------------------------------------
// fake pi executable

// Scripted child pi. FAKE_PI_MODE selects the scenario; it always writes its
// own PID into FAKE_PI_PIDS so the test can never leak a process.
const FAKE_PI = [
  "#!/usr/bin/env node",
  '"use strict";',
  'const fs = require("node:fs");',
  'const { spawn } = require("node:child_process");',
  "",
  'const mode = process.env.FAKE_PI_MODE || "happy";',
  'const dump = process.env.FAKE_PI_DUMP || "";',
  "if (dump) {",
  "  try {",
  "    fs.writeFileSync(dump, JSON.stringify({",
  "      argv: process.argv.slice(2),",
  "      cwd: process.cwd(),",
  "      env: {",
  "        AIWB_SUB_PARENT: process.env.AIWB_SUB_PARENT || null,",
  "        AIWB_SUB_DEPTH: process.env.AIWB_SUB_DEPTH || null,",
  "        AIWB_SUB_CHILD: process.env.AIWB_SUB_CHILD || null,",
  "        AIWB_MODEL: process.env.AIWB_MODEL || null,",
  "        AIWB_THINKING: process.env.AIWB_THINKING || null,",
  "        AIWB_MCP_CONFIG: process.env.AIWB_MCP_CONFIG || null,",
  "      },",
  "    }));",
  "  } catch {}",
  "}",
  'if (process.env.FAKE_PI_PIDS) {',
  '  try { fs.writeFileSync(process.env.FAKE_PI_PIDS, JSON.stringify({ parent: process.pid, child: null })); } catch {}',
  "}",
  "",
  "function out(obj) { process.stdout.write(JSON.stringify(obj) + \"\\n\"); }",
  "",
  "async function emitHappy() {",
  '  out({ type: "message_update", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world" } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking..." } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "tc1", toolName: "bash" } });',
  '  out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: { id: "tc1", name: "bash", arguments: { command: "ls" } } } });',
  '  out({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: { content: [{ type: "text", text: "file.txt" }] }, isError: false });',
  '  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }], usage: { input: 10, cacheRead: 2, cacheWrite: 1, output: 5 } } });',
  '  out({ type: "agent_settled" });',
  "}",
  "",
  "async function handle(cmd) {",
  '  if (cmd.type === "get_state") {',
  '    if (mode === "slow") await new Promise((r) => setTimeout(r, 150));',
  '    out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { sessionId: "child-session", sessionFile: "/tmp/child.jsonl" } });',
  "    return;",
  "  }",
  '  if (cmd.type === "prompt") {',
  '    out({ id: cmd.id, type: "response", command: "prompt", success: true });',
  '    if (mode === "happy" || mode === "slow" || mode === "statsnull") await emitHappy();',
  '    if (mode === "abort") {',
  '      const gc = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),30000); setInterval(()=>{},1000)"], { stdio: "ignore" });',
  "      if (process.env.FAKE_PI_PIDS) {",
  '        fs.writeFileSync(process.env.FAKE_PI_PIDS, JSON.stringify({ parent: process.pid, child: gc.pid }));',
  "      }",
  "    }",
  '    if (mode === "stubborn") {',
  '      process.on("SIGTERM", () => {});',
  '      const gc = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setTimeout(() => process.exit(0), 30000); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
  "      if (process.env.FAKE_PI_PIDS) {",
  '        fs.writeFileSync(process.env.FAKE_PI_PIDS, JSON.stringify({ parent: process.pid, child: gc.pid }));',
  "      }",
  "    }",
  '    if (mode === "fail") {',
  '      process.stderr.write("fake pi exploded: boom\\n", () => process.exit(3));',
  "    }",
  '    if (mode === "failtext") {',
  '      out({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });',
  '      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial report" } });',
  '      out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial report" }], usage: { input: 3 } } });',
  '      const tail = process.env.FAKE_PI_STDERR || "";',
  '      if (tail) process.stderr.write(tail, () => process.exit(3));',
  '      else process.stdout.write("\\n", () => process.exit(3));',
  "    }",
  "    return;",
  "  }",
  '  if (cmd.type === "get_session_stats") {',
  '    if (mode === "statsnull") {',
  '      out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 9999 }, contextUsage: { tokens: null, contextWindow: 200000 } } });',
  "      return;",
  "    }",
  '    out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { tokens: { total: 18 }, toolCalls: 1, contextUsage: { tokens: 123, contextWindow: 200000 } } });',
  "    return;",
  "  }",
  "}",
  "",
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (chunk) => {',
  "  buf += chunk;",
  "  let i;",
  '  while ((i = buf.indexOf("\\n")) >= 0) {',
  "    const line = buf.slice(0, i);",
  "    buf = buf.slice(i + 1);",
  '    if (!line.trim()) continue;',
  "    let cmd;",
  '    try { cmd = JSON.parse(line); } catch { continue; }',
  "    void handle(cmd);",
  "  }",
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "setTimeout(() => process.exit(0), 20000);",
  "",
].join("\n");

interface Fixture {
  dir: string;
  selfPath: string;
  chatDir: string;
  pidFile: string;
  env: Record<string, string>;
  pids(): { parent: number | null; child: number | null };
  cleanup(): void;
}

function makeFixture(extraEnv: Record<string, string> = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-fakepi-"));
  const bin = path.join(dir, "fake-pi");
  fs.writeFileSync(bin, FAKE_PI, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const pidFile = path.join(dir, "pids.json");
  const chatDir = path.join(dir, "chat");
  const env: Record<string, string> = {
    AIWB_PI_BIN: bin,
    AIWB_CHAT_DIR: chatDir,
    FAKE_PI_PIDS: pidFile,
    FAKE_PI_MODE: "happy",
    ...extraEnv,
  };
  const readPids = (): { parent: number | null; child: number | null } => {
    try {
      const data = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      return {
        parent: typeof data.parent === "number" ? data.parent : null,
        child: typeof data.child === "number" ? data.child : null,
      };
    } catch {
      return { parent: null, child: null };
    }
  };
  return {
    dir,
    selfPath: path.join(dir, "index.ts"),
    chatDir,
    pidFile,
    env,
    pids: readPids,
    cleanup: () => {
      const pids = readPids();
      for (const pid of [pids.parent, pids.child]) {
        if (typeof pid === "number" && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// helpers

function eventsOf(frames: BridgeFrame[]): SubagentFrame[] {
  return frames.map((frame) => frame.event as SubagentFrame);
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pidState(pid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/** waitGone polls process.kill(pid, 0) until every PID reports ESRCH. */
async function waitGone(pids: number[], what = "child processes", timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some((pid) => pidState(pid) !== "gone")) {
    if (Date.now() > deadline) {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Best effort cleanup before failing.
        }
      }
      const states = pids.map((pid) => `${pid}:${pidState(pid)}`).join(", ");
      throw new Error(`timed out waiting for ${what} to die (${states})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface RunHandle {
  promise: Promise<SubagentToolResult>;
  registered: (() => void)[];
}

function startRun(
  bridge: FakeBridge,
  fx: Fixture,
  params: Partial<SubagentParams> = {},
  extra: { signal?: AbortSignal; killWaitMs?: number } = {},
): RunHandle {
  const registered: (() => void)[] = [];
  // Inherit the runner env (PATH for the fake pi shebang) but never the runner's
  // own bridge/subagent identity: the fixture decides the identity under test.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AIWB_")) delete env[key];
  }
  Object.assign(env, fx.env);
  const promise = runSubagent({
    toolCallId: "call_1",
    params: { description: "Test subagent", prompt: "Do the thing", ...params },
    env,
    signal: extra.signal,
    killWaitMs: extra.killWaitMs,
    cwd: fx.dir,
    selfPath: fx.selfPath,
    registerKiller: (fn) => {
      registered.push(fn);
      return () => {
        const i = registered.indexOf(fn);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    activity: (sub, event) => {
      void callBridge(bridge.socketPath, { kind: "activity", run: "run-1", sub, event }).catch(() => {
        // Fire and forget.
      });
    },
  });
  return { promise, registered };
}

async function readDump(fx: Fixture): Promise<any> {
  const file = path.join(fx.dir, "dump.json");
  await waitFor(() => fs.existsSync(file), "fake pi dump");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// tests

test("foreground happy path streams activity frames and resolves the summary", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture();
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  const result = await promise;
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const events = eventsOf(bridge.frames);
  const start = events.find((event) => event.type === "start")!;
  const childId = start.id;
  assert.match(childId, /^s[0-9a-f]{12}$/);
  assert.equal(start.description, "Test subagent");
  assert.equal(start.prompt, "Do the thing");
  assert.equal(start.agentType, "general-purpose");
  assert.equal(start.background, false);
  assert.equal(start.model, undefined);

  // Every frame has the exact envelope and the child's identity.
  for (const frame of bridge.frames) {
    assert.equal(frame.kind, "activity");
    assert.equal(frame.run, "run-1");
    assert.deepEqual(frame.sub, { parent: "call_1", depth: 0, child: childId });
  }
  assert.deepEqual(bridge.frames[0], {
    kind: "activity",
    run: "run-1",
    sub: { parent: "call_1", depth: 0, child: childId },
    event: {
      type: "start",
      id: childId,
      description: "Test subagent",
      prompt: "Do the thing",
      agentType: "general-purpose",
      background: false,
    },
  });

  assert.deepEqual(events, [
    {
      type: "start",
      id: childId,
      description: "Test subagent",
      prompt: "Do the thing",
      agentType: "general-purpose",
      background: false,
    },
    { type: "text", text: "" },
    { type: "text", text: "Hello " },
    { type: "text", text: "world" },
    { type: "thinking" },
    { type: "thinking" },
    { type: "tool_start", id: "tc1", name: "bash" },
    { type: "tool_input", id: "tc1", name: "bash", input: { command: "ls" } },
    { type: "tool_result", id: "tc1", name: "bash", result: "file.txt", isError: false },
    { type: "usage", tokens: 13 },
    { type: "usage", tokens: 123, window: 200000 },
    { type: "done", status: "completed", summary: "Hello world", tokens: 123, window: 200000, toolUses: 1 },
  ]);

  assert.deepEqual(result, {
    content: [{ type: "text", text: "Hello world" }],
    details: { status: "completed", childId, tokens: 123, window: 200000, toolUses: 1, background: false },
  });

  // The child session dir exists, owner-only.
  const childDir = path.join(fx.chatDir, "subagents", childId, "pi");
  assert.equal(fs.statSync(childDir).mode & 0o777, 0o700);

  // The settled child is shut down and gone.
  await waitFor(() => fx.pids().parent !== null, "child pid file");
  await waitGone([fx.pids().parent!], "foreground child");
});

test("background returns the ack immediately and emits done later", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "slow" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx, { description: "Background task", prompt: "Work in the background", background: true });
  const ack = await promise;
  assert.equal(ack.content[0].text, 'Subagent "Background task" started.');
  assert.equal(ack.details.status, "running");
  assert.equal(ack.details.background, true);
  assert.match(ack.details.childId, /^s[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(ack.details).sort(), ["background", "childId", "status"]);

  // The slow child has not even answered get_state yet.
  assert.equal(eventsOf(bridge.frames).filter((event) => event.type === "done").length, 0);

  await waitFor(
    () => eventsOf(bridge.frames).some((event) => event.type === "done" && event.status === "completed"),
    "background done frame",
  );
  const start = eventsOf(bridge.frames).find((event) => event.type === "start");
  assert.ok(start && start.type === "start" && start.background === true);
  assert.equal(start.id, ack.details.childId);

  await waitFor(() => fx.pids().parent !== null, "child pid file");
  await waitGone([fx.pids().parent!], "background child");
});

test("spawn error emits done failed and rejects", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture();
  fx.env.AIWB_PI_BIN = path.join(fx.dir, "missing-pi");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  await assert.rejects(promise, /failed to spawn subagent pi/);
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const events = eventsOf(bridge.frames);
  assert.deepEqual(events.map((event) => event.type), ["start", "done"]);
  const done = events[1] as Extract<SubagentFrame, { type: "done" }>;
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /failed to spawn subagent pi/);
});

test("a crashed child rejects with its stderr tail and emits done failed once", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "fail" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  await assert.rejects(promise, /fake pi exploded: boom/);
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const doneFrames = eventsOf(bridge.frames).filter((event) => event.type === "done");
  assert.equal(doneFrames.length, 1);
  const done = doneFrames[0] as Extract<SubagentFrame, { type: "done" }>;
  assert.equal(done.status, "failed");
  assert.equal(done.error, "fake pi exploded: boom");
  await waitFor(() => fx.pids().parent !== null, "child pid file");
  await waitGone([fx.pids().parent!], "failed child");
});

test("a failed child carries its last report as the summary and in the rejection", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "failtext" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  const err = await promise.then(
    () => {
      throw new Error("the failed run resolved");
    },
    (e: Error & { summary?: string }) => e,
  );
  // stderr is empty, so the report is also the rejection message; the summary always rides along.
  assert.equal(err.message, "partial report");
  assert.equal(err.summary, "partial report");

  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");
  const doneFrames = eventsOf(bridge.frames).filter((event) => event.type === "done");
  assert.equal(doneFrames.length, 1);
  const done = doneFrames[0] as Extract<SubagentFrame, { type: "done" }>;
  assert.equal(done.status, "failed");
  // No stderr: the done frame keeps the generic exit diagnostic, the report rides in summary.
  assert.match(done.error ?? "", /before settling/);
  assert.equal(done.summary, "partial report");
  await waitFor(() => fx.pids().parent !== null, "child pid file");
  await waitGone([fx.pids().parent!], "failed child");
});

test("a failed child with stderr keeps the stderr as error and the report as summary", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "failtext", FAKE_PI_STDERR: "boom after report\n" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  const err = await promise.then(
    () => {
      throw new Error("the failed run resolved");
    },
    (e: Error & { summary?: string }) => e,
  );
  // The rejection shows the report; the stderr stays in the done frame's error.
  assert.equal(err.message, "partial report");
  assert.equal(err.summary, "partial report");

  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");
  const done = eventsOf(bridge.frames).find((event) => event.type === "done") as Extract<
    SubagentFrame,
    { type: "done" }
  >;
  assert.equal(done.status, "failed");
  assert.equal(done.error, "boom after report");
  assert.equal(done.summary, "partial report");
});

test("a null contextUsage falls back to the last message usage, not the cumulative total", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "statsnull" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  const result = await promise;
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const usage = eventsOf(bridge.frames).filter((event) => event.type === "usage");
  assert.deepEqual(usage, [
    { type: "usage", tokens: 13 },
    { type: "usage", tokens: 13, window: 200000 },
  ]);
  const done = eventsOf(bridge.frames).find((event) => event.type === "done") as Extract<
    SubagentFrame,
    { type: "done" }
  >;
  assert.equal(done.tokens, 13);
  assert.equal(done.window, 200000);
  assert.equal(result.details.tokens, 13);
});

test("abort via signal kills the child process tree and emits done stopped once", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "abort" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const controller = new AbortController();
  const { promise, registered } = startRun(bridge, fx, {}, { signal: controller.signal });

  await waitFor(() => fx.pids().child !== null, "grandchild pid");
  const pids = fx.pids();
  assert.equal(pidState(pids.parent!), "alive");
  assert.equal(pidState(pids.child!), "alive");

  controller.abort();
  // A second abort (signal + killer registry) must not duplicate the done frame.
  registered[0]?.();

  const result = await promise;
  assert.equal(result.details.status, "stopped");
  assert.equal(result.content[0].text, "Subagent finished.");

  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");
  const doneFrames = eventsOf(bridge.frames).filter((event) => event.type === "done");
  assert.equal(doneFrames.length, 1);
  assert.equal((doneFrames[0] as Extract<SubagentFrame, { type: "done" }>).status, "stopped");

  await waitGone([pids.parent!, pids.child!], "aborted tree (child and grandchild)");
  assert.equal(pidState(pids.parent!), "gone");
  assert.equal(pidState(pids.child!), "gone");
});

test("abort via the registered killer kills the tree too", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "abort" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise, registered } = startRun(bridge, fx);
  await waitFor(() => fx.pids().child !== null, "grandchild pid");
  const pids = fx.pids();
  assert.equal(registered.length, 1);

  registered[0]();
  registered[0]();

  const result = await promise;
  assert.equal(result.details.status, "stopped");
  await waitGone([pids.parent!, pids.child!], "killed tree (child and grandchild)");
  const doneFrames = eventsOf(bridge.frames).filter((event) => event.type === "done");
  assert.equal(doneFrames.length, 1);
});

test("a SIGTERM-resistant tree is SIGKILLed after the grace period", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ FAKE_PI_MODE: "stubborn" });
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const controller = new AbortController();
  const { promise } = startRun(bridge, fx, {}, { signal: controller.signal, killWaitMs: 250 });
  await waitFor(() => fx.pids().child !== null, "stubborn grandchild pid");
  const pids = fx.pids();
  assert.equal(pidState(pids.parent!), "alive");
  assert.equal(pidState(pids.child!), "alive");

  controller.abort();
  const result = await promise;
  assert.equal(result.details.status, "stopped");
  // Both PIDs ignored SIGTERM and must go away once the grace period expires.
  await waitGone([pids.parent!, pids.child!], "stubborn child and grandchild");
});

test("nested child env carries depth+1 and the child's own tool-call id", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({
    AIWB_SUB_PARENT: "call_outer",
    AIWB_SUB_DEPTH: "0",
    AIWB_MODEL: "prov/parent-model",
    AIWB_THINKING: "high",
    AIWB_APPEND_PROMPT: "/tmp/board-prompt.md",
  });
  fx.env.FAKE_PI_DUMP = path.join(fx.dir, "dump.json");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx, {
    subagent_type: "researcher",
    model: "prov/child-model",
    thinking: "low",
  });
  await promise;
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const events = eventsOf(bridge.frames);
  const start = events.find((event) => event.type === "start")!;
  const childId = start.id;
  assert.equal(start.agentType, "researcher");
  assert.equal(start.model, "prov/child-model");
  assert.deepEqual(bridge.frames[0].sub, { parent: "call_1", depth: 1, child: childId });

  const dump = await readDump(fx);
  assert.equal(dump.env.AIWB_SUB_PARENT, "call_1");
  assert.equal(dump.env.AIWB_SUB_DEPTH, "1");
  assert.equal(dump.env.AIWB_SUB_CHILD, childId);
  assert.equal(dump.env.AIWB_MODEL, "prov/child-model");
  assert.equal(dump.env.AIWB_THINKING, "low");

  const argv: string[] = dump.argv;
  assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
  assert.ok(argv.includes("--no-extensions"));
  assert.ok(argv.includes("--no-approve"));
  assert.equal(argv[argv.indexOf("-e") + 1], fx.selfPath);
  assert.equal(argv[argv.indexOf("--session-id") + 1], childId);
  assert.equal(argv[argv.indexOf("--session-dir") + 1], path.join(fx.chatDir, "subagents", childId, "pi"));
  assert.equal(argv[argv.indexOf("--model") + 1], "prov/child-model");
  assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "/tmp/board-prompt.md");
});

test("a DeepSeek Flash child gets the bash-timeout reminder", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture({ AIWB_APPEND_PROMPT: "/tmp/board-prompt.md" });
  fx.env.FAKE_PI_DUMP = path.join(fx.dir, "dump.json");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx, { model: "openrouter/deepseek/deepseek-v4.1-flash" });
  await promise;
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const dump = await readDump(fx);
  const argv: string[] = dump.argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "openrouter/deepseek/deepseek-v4.1-flash");
  const appends = argv.filter((_arg, i) => i > 0 && argv[i - 1] === "--append-system-prompt");
  assert.deepEqual(appends, ["/tmp/board-prompt.md", "Never run bash commands without timeout"]);
});

test("a non-flash child gets no bash-timeout reminder", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture();
  fx.env.FAKE_PI_DUMP = path.join(fx.dir, "dump.json");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx, { model: "deepseek/deepseek-v4-pro" });
  await promise;
  await waitFor(() => eventsOf(bridge.frames).some((event) => event.type === "done"), "done frame");

  const dump = await readDump(fx);
  const argv: string[] = dump.argv;
  assert.ok(!argv.includes("Never run bash commands without timeout"));
});

test("a board-chat child inherits AIWB_MCP_CONFIG (A10)", async (t) => {
  const boardConfig = '{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:45231/mcp/run-7"}}}';
  const bridge = await startBridge();
  const fx = makeFixture({ AIWB_MCP_CONFIG: boardConfig });
  fx.env.FAKE_PI_DUMP = path.join(fx.dir, "dump.json");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  await promise;
  const dump = await readDump(fx);
  assert.equal(dump.env.AIWB_MCP_CONFIG, boardConfig);
});

test("a plain-chat child gets no AIWB_MCP_CONFIG (A10)", async (t) => {
  const bridge = await startBridge();
  const fx = makeFixture();
  fx.env.FAKE_PI_DUMP = path.join(fx.dir, "dump.json");
  t.after(async () => {
    await bridge.close();
    fx.cleanup();
  });

  const { promise } = startRun(bridge, fx);
  await promise;
  const dump = await readDump(fx);
  assert.equal(dump.env.AIWB_MCP_CONFIG, null);
});
