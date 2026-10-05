// The app's pi extension. It wires the MCP lifecycle from --mcp-config /
// AIWB_MCP_CONFIG independently of the app bridge, so standalone
// `pi -e index.ts --mcp-config '<json>'` works; the app-facing wiring
// (the UDS permission gate, hello/abort) is gated on AIWB_BRIDGE_*. App chats
// do not register the native `subagent` tool: the MCP spawn family replaces it.
//
// Wiring order (plan R1):
//   1. `--mcp-config` is registered unconditionally as the literal first factory
//      action, before any environment read: pi exits non-zero on an unknown or
//      valueless flag.
//   2. AIWB_BRIDGE_SOCKET/AIWB_BRIDGE_RUN are then read only to decide the
//      app-facing wiring (the UDS permission gate, hello/abort). Bridge absence
//      does NOT gate the MCP lifecycle. Native `subagent` is not registered on
//      app chats (or standalone).
//   3. session_start resolves the config flag-over-env, connects, discovers and
//      registers tools; session_shutdown closes every client from either source.
//      MCP failures are per-server, non-fatal, and reported as one one-shot
//      `notice` frame (bridge) or a prefixed stderr line (standalone).
//
// The extension presents only the per-run bridge handle (AIWB_BRIDGE_RUN), an
// internal, non-secret identifier; the board token reaches pi only inside the
// MCP config's Authorization header (AIWB_MCP_CONFIG), never in argv or a URL.
// Both, and the other app handles, are taken out of process.env on the first
// read (app-env.ts) so the shell commands pi runs do not inherit them.
// Protocol/mcp/mcp-wiring/app-env are dependency-free
// modules so they stay testable without pi or typebox.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { callBridge, openControl } from "./protocol.ts";
import { handleToolCall } from "./permissions.ts";
import { takeAppEnv } from "./app-env.ts";
import {
  autoAllowedToolNames,
  makeNoticeSink,
  selectMCPConfig,
  startMCP,
  type MCPBootstrap,
} from "./mcp-wiring.ts";

// A short bound for the one-shot notice frame: reporting a failure must never
// hold up session_start for long, and the call must not depend on the
// asynchronous control socket being connected (plan R7).
const NOTICE_TIMEOUT_MS = 5000;

// Optional override for one server's connect/discovery budget. The production
// default (10 s) lives in mcp-wiring.ts; the AIWB_MCP_HANDSHAKE_TIMEOUT_MS
// override exists so the real-pi boot tests can exercise a stalling server
// without waiting out the default. Non-positive/NaN values use the default.
const envHandshakeTimeoutMs = Number(process.env.AIWB_MCP_HANDSHAKE_TIMEOUT_MS);

// childKillers is the registry the later subagent job fills in: one killer per
// live child process tree. An abort push invokes and clears them all.
const childKillers = new Set<() => void>();

/**
 * registerChildKiller records a killer for a live child run and returns the
 * deregistration function runSubagent calls once the child exits.
 */
export function registerChildKiller(fn: () => void): () => void {
  childKillers.add(fn);
  return () => {
    childKillers.delete(fn);
  };
}

function killChildren(): void {
  for (const fn of [...childKillers]) {
    try {
      fn();
    } catch {
      // Best effort: a failed killer must not stop the others.
    }
  }
  childKillers.clear();
}

const SPAWN_FAMILY_BARE = new Set(["spawn_subagent", "stop_subagent", "list_subagent_models"]);

/** Spawn-family MCP tools must not run sequentially so sibling spawns in one
 *  assistant message can proceed in parallel (plan D2). Board-engine MCP tools
 *  stay sequential. Detect by the registered name: the three bare names, a
 *  namespaced form ending in `__<bare>`, or `mcp__<server>__<bare>`. */
function isSpawnFamilyTool(name: string): boolean {
  if (SPAWN_FAMILY_BARE.has(name)) return true;
  if (
    name.endsWith("__spawn_subagent") ||
    name.endsWith("__stop_subagent") ||
    name.endsWith("__list_subagent_models")
  ) {
    return true;
  }
  const parts = name.split("__");
  return parts.length >= 3 && parts[0] === "mcp" && SPAWN_FAMILY_BARE.has(parts.slice(2).join("__"));
}

export default function boardToolsExtension(pi: ExtensionAPI): void {
  // 1. Load-bearing registration order (plan R1): the flag is registered
  // unconditionally as the first action of the factory, before any
  // AIWB_BRIDGE_* read or early return. pi rejects an unknown/valueless flag in
  // non-interactive mode, so standalone use with only --mcp-config must find it
  // registered even when no bridge environment is present.
  pi.registerFlag("mcp-config", {
    type: "string",
    description:
      "Claude-compatible MCP servers JSON ({\"mcpServers\":{...}}); HTTP/Streamable servers only. Takes precedence over AIWB_MCP_CONFIG.",
    default: "",
  });

  // 2. The bridge environment decides only the app-facing wiring; the MCP
  // lifecycle below runs with or without it. The app's variables leave
  // process.env here; pi runs this factory again on a fork or a new session,
  // and that run gets the kept values (app-env.ts).
  const appEnv = takeAppEnv();
  const socketPath = appEnv.AIWB_BRIDGE_SOCKET ?? "";
  const run = appEnv.AIWB_BRIDGE_RUN ?? "";
  const bridgePresent = socketPath !== "" && run !== "";

  // 3. MCP lifecycle: connect/discover/register/close regardless of the bridge
  // guard. Every failure is isolated per server and surfaced through `notice`.
  let activeMCP: MCPBootstrap | undefined;
  let boardMCPNames: string[] = [];
  let boardMCPAppSourced = false;
  let noticeSeq = 0;

  const notice = makeNoticeSink({
    bridgePresent,
    send: (message) => {
      noticeSeq += 1;
      // One-shot like a tool/ask call, so an early session_start connect
      // failure is not lost while the control socket is still coming up.
      void callBridge(
        socketPath,
        { kind: "notice", run, id: `notice-${noticeSeq}`, error: message },
        NOTICE_TIMEOUT_MS,
      ).catch(() => {
        // Fire and forget: failing to report a failure must not surface.
      });
    },
    writeStderr: (chunk) => {
      try {
        process.stderr.write(chunk);
      } catch {
        // stderr must never crash the extension.
      }
    },
  });

  const resetMCP = (): void => {
    activeMCP?.close();
    activeMCP = undefined;
    boardMCPNames = [];
    boardMCPAppSourced = false;
  };

  pi.on("session_start", async () => {
    // Defensive: session_shutdown normally closes the previous session's
    // clients; never leak them on a reload/new/resume/fork edge.
    resetMCP();
    const selection = selectMCPConfig(pi.getFlag("mcp-config"), appEnv.AIWB_MCP_CONFIG);
    if (selection.source === "none") return;
    const bootstrap = await startMCP({
      selection,
      notice,
      handshakeTimeoutMs: envHandshakeTimeoutMs,
      register: (tool) => {
        pi.registerTool({
          name: tool.name,
          label: tool.label,
          description: tool.description,
          promptSnippet: tool.promptSnippet,
          parameters: Type.Unsafe(tool.parameters as never),
          // Spawn-family tools omit executionMode so sibling spawns in one
          // assistant message run in parallel (native `subagent` did the same).
          // Board-engine MCP tools stay sequential.
          ...(isSpawnFamilyTool(tool.name) ? {} : { executionMode: "sequential" as const }),
          async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
            return tool.execute(params ?? {}, signal);
          },
        });
      },
    });
    activeMCP = bootstrap;
    if (bridgePresent) {
      // The permission gate auto-allows app-sourced board MCP tools (plan R4);
      // a flag-sourced board-key server stays gated.
      boardMCPNames = bootstrap.boardToolNames;
      boardMCPAppSourced = bootstrap.source === "env";
    }
  });

  // Closes every client from either config source and aborts in-flight calls;
  // covers quit/reload/new/resume/fork reasons (plan R7).
  pi.on("session_shutdown", () => {
    resetMCP();
  });

  // Standalone run (no bridge): the servers are explicitly user-supplied, there
  // is no app permission card and no UDS channel, so the gate is deliberately
  // not wired at all here — these tools run un-gated (plan R4/§3.5). Native
  // `subagent` is not registered on standalone either.
  if (!bridgePresent) return;

  // App chats keep the permission gate, hello/abort, and child-killer wiring.
  // They do not register the native `subagent` tool: the MCP spawn family
  // (spawn_subagent / stop_subagent) replaces it.

  // Permission gate: exactly one rule (plan R4). The auto-allowed set is the
  // app-sourced mcp__board__* names (the native raw board tools were removed in
  // the Phase 4 switchover); `subagent` is always allowed by the gate. Every
  // other tool sends one ask frame and blocks until the app decides (fail-safe
  // timeout/deny in permissions.ts).
  pi.on("tool_call", async (event) => {
    return handleToolCall(
      { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input },
      {
        run,
        env: process.env,
        autoAllowed: autoAllowedToolNames({
          boardMCPToolNames: boardMCPNames,
          appSourcedBoard: boardMCPAppSourced,
        }),
        ask: (frame, timeoutMs) => callBridge(socketPath, frame, timeoutMs),
      },
    );
  });

  // Best-effort control channel: hello now, abort pushes later. The socket keeps
  // itself alive; pi kills the process at the end of the run.
  openControl(socketPath, { kind: "hello", run, id: "hello" }, killChildren);
}
