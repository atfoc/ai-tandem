// Unit tests for the dependency-free bridge protocol client. Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/protocol.test.ts
// A fake net.createServer answers one frame; no pi, no real app socket.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { callBridge, encodeFrame, decodeFrame, openControl } from "../protocol.ts";

interface FakeServer {
  socketPath: string;
  close(): Promise<void>;
}

async function startServer(handler: (socket: net.Socket) => void): Promise<FakeServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-proto-"));
  const socketPath = path.join(dir, "s.sock");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    socketPath,
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

// answerOne reads a single frame and replies with the given response object.
function answerOne(response: object): (socket: net.Socket) => void {
  return (socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const frame = decodeFrame(buf.slice(0, nl));
      socket.write(encodeFrame({ id: frame.id, ...response }));
    });
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("callBridge resolves with the first response line", async () => {
  const srv = await startServer(answerOne({ ok: true, result: "pong" }));
  try {
    const resp = await callBridge(srv.socketPath, { kind: "tool", run: "r", id: "c1", name: "list_boards" });
    assert.deepEqual(resp, { id: "c1", ok: true, result: "pong" });
  } finally {
    await srv.close();
  }
});

test("callBridge resolves error responses (the extension throws)", async () => {
  const srv = await startServer(answerOne({ ok: false, error: "unknown tool nope" }));
  try {
    const resp = await callBridge(srv.socketPath, { kind: "tool", run: "r", id: "c2", name: "nope" });
    assert.deepEqual(resp, { id: "c2", ok: false, error: "unknown tool nope" });
  } finally {
    await srv.close();
  }
});

test("callBridge rejects on timeout", async () => {
  const srv = await startServer(() => {
    // Accept and stay silent.
  });
  try {
    await assert.rejects(callBridge(srv.socketPath, { kind: "tool", id: "t1" }, 50), /timed out/);
  } finally {
    await srv.close();
  }
});

test("callBridge rejects when the socket cannot be reached", async () => {
  const missing = path.join(os.tmpdir(), `aiwb-proto-missing-${process.pid}`, "s.sock");
  await assert.rejects(callBridge(missing, { kind: "tool", id: "t2" }, 500));
});

test("callBridge rejects on early close", async () => {
  const srv = await startServer((socket) => socket.end());
  try {
    await assert.rejects(callBridge(srv.socketPath, { kind: "tool", id: "t3" }, 500), /closed before a response/);
  } finally {
    await srv.close();
  }
});

test("encode/decode round trip over LF JSON", () => {
  const frame = {
    kind: "activity",
    run: "r",
    id: "e1",
    sub: { parent: "p", depth: 1, child: "c" },
    event: { type: "text", text: "line1\nline2" },
  };
  const line = encodeFrame(frame);
  assert.ok(line.endsWith("\n"));
  assert.equal(line.indexOf("\n"), line.length - 1, "frame must be one line");
  assert.deepEqual(decodeFrame(line), frame);
  assert.deepEqual(decodeFrame(JSON.stringify(frame)), frame);
  assert.throws(() => decodeFrame("not json"));
});

test("openControl sends hello and delivers abort pushes", async () => {
  let client: net.Socket | null = null;
  let hello: any;
  const srv = await startServer((socket) => {
    client = socket;
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      hello = decodeFrame(buf.slice(0, nl));
    });
  });
  let aborts = 0;
  const control = openControl(srv.socketPath, { kind: "hello", run: "r", id: "hello" }, () => {
    aborts++;
  });
  try {
    await waitFor(() => hello !== undefined);
    assert.deepEqual(hello, { kind: "hello", run: "r", id: "hello" });
    client!.write(encodeFrame({ kind: "abort", run: "r" }));
    await waitFor(() => aborts === 1);
    // Malformed control lines are tolerated.
    client!.write("garbage\n");
    client!.write(encodeFrame({ kind: "abort", run: "r" }));
    await waitFor(() => aborts === 2);
  } finally {
    control.close();
    await srv.close();
  }
});

test("openControl tolerates an unreachable socket", async () => {
  const missing = path.join(os.tmpdir(), `aiwb-proto-missing-${process.pid}`, "s.sock");
  const control = openControl(missing, { kind: "hello", run: "r", id: "hello" }, () => {});
  control.close();
});
