// Dependency-free board-bridge wire protocol for the pi extension.
//
// The Go side is internal/agent/bridge.go (the frozen contract) and
// internal/pibridge/bridge.go (the server). Frames are one LF-terminated line of
// UTF-8 JSON each. This module imports only node:net so it is unit-testable
// without pi or typebox.

import * as net from "node:net";

/** Subagent identity attached by child runs (mirrors agent.SubIdentity). */
export interface SubIdentity {
  parent: string;
  depth: number;
  child: string;
}

/** One bridge frame (mirrors agent.BridgeFrame; fields are loose/optional). */
export interface BridgeFrame {
  kind: string;
  run?: string;
  id?: string;
  name?: string;
  sub?: SubIdentity;
  input?: unknown;
  event?: unknown;
  ok?: boolean;
  error?: string;
  allow?: boolean;
  reason?: string;
}

/** encodeFrame renders one frame as an LF-terminated JSON line. */
export function encodeFrame(frame: object): string {
  return JSON.stringify(frame) + "\n";
}

/** decodeFrame parses one LF-terminated (or bare) JSON frame line. */
export function decodeFrame(line: string): BridgeFrame {
  let s = line;
  if (s.endsWith("\n")) s = s.slice(0, -1);
  if (s.endsWith("\r")) s = s.slice(0, -1);
  return JSON.parse(s) as BridgeFrame;
}

/**
 * callBridge opens one connection, writes one frame line and resolves with the
 * first response line. It rejects on connection error, timeout or an early close.
 */
export function callBridge(socketPath: string, frame: object, timeoutMs = 35000): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = net.createConnection(socketPath);

    const finish = (err: Error | null, value?: any) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    timer = setTimeout(() => finish(new Error(`bridge call timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.on("connect", () => {
      socket.write(encodeFrame(frame));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(null, decodeFrame(buffer.slice(0, nl)));
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
      }
    });
    socket.on("error", (err: Error) => finish(err));
    socket.on("close", () => finish(new Error("bridge connection closed before a response")));
  });
}

/**
 * openControl keeps one control connection open, sends the given frame (e.g. a
 * hello) and invokes onAbort for every `{kind:"abort"}` line. Connection and
 * reconnect failures are tolerated silently: the extension reconnects per call,
 * and the abort push is best effort. close() stops the connection and reconnects.
 */
export function openControl(socketPath: string, frame: object, onAbort: () => void): { close(): void } {
  let closed = false;
  let socket: net.Socket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let buffer = "";

  const connect = () => {
    if (closed) return;
    buffer = "";
    const s = net.createConnection(socketPath);
    socket = s;

    s.on("connect", () => {
      s.write(encodeFrame(frame));
    });
    s.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        try {
          const parsed = decodeFrame(line);
          if (parsed && parsed.kind === "abort") onAbort();
        } catch {
          // Ignore malformed lines on the best-effort control channel.
        }
      }
    });
    s.on("error", () => {
      // Silent: connect() below retries; callBridge reports per-call failures.
    });
    s.on("close", () => {
      socket = null;
      if (closed) return;
      retry = setTimeout(connect, 1000);
      if (typeof retry.unref === "function") retry.unref();
    });
  };

  connect();

  return {
    close() {
      closed = true;
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },
  };
}
