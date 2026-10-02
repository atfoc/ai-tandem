// The app's pi extension. It wires the MCP lifecycle from --mcp-config /
// AIWB_MCP_CONFIG independently of the app bridge, so standalone
// `pi -e index.ts --mcp-config '<json>'` works; the app-facing wiring
// (subagent, the UDS permission gate, hello/abort) is gated on AIWB_BRIDGE_*.
//
// Wiring order (plan R1):
//   1. `--mcp-config` is registered unconditionally as the literal first factory
//      action, before any environment read: pi exits non-zero on an unknown or
//      valueless flag.
//   2. AIWB_BRIDGE_SOCKET/AIWB_BRIDGE_RUN are then read only to decide the
//      app-facing wiring (the subagent tool, the UDS permission gate,
//      hello/abort). Bridge absence does NOT gate the MCP lifecycle.
//   3. session_start resolves the config flag-over-env, connects, discovers and
//      registers tools; session_shutdown closes every client from either source.
//      MCP failures are per-server, non-fatal, and reported as one one-shot
//      `notice` frame (bridge) or a prefixed stderr line (standalone).
//
// The extension presents only the per-run token (AIWB_BRIDGE_RUN); the board
// token never enters the pi process. Protocol/mcp/mcp-wiring are dependency-free
// modules so they stay testable without pi or typebox.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fileURLToPath } from "node:url";
import { callBridge, openControl } from "./protocol.ts";
import { handleToolCall } from "./permissions.ts";
import { runSubagent, type SubagentParams } from "./subagent.ts";
import { parseMCPConfig } from "./mcp.ts";
import {
  autoAllowedToolNames,
  boardServerActive,
  makeNoticeSink,
  selectMCPConfig,
  startMCP,
  subagentDescription,
  subagentPromptSnippet,
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
  // lifecycle below runs with or without it.
  const socketPath = process.env.AIWB_BRIDGE_SOCKET ?? "";
  const run = process.env.AIWB_BRIDGE_RUN ?? "";
  const bridgePresent = socketPath !== "" && run !== "";

  // The subagent tool's description may promise board tools only when the
  // app-owned env config contains the board server (plan R4, §3.6). This is
  // decided at factory scope with no network IO; the flag value is only
  // readable later (pi applies CLI flag values after factory scope) and a
  // flag-sourced board-key server is never the app-owned board server anyway.
  const envSelection = selectMCPConfig(undefined, process.env.AIWB_MCP_CONFIG);
  const boardToolsAdvertised = boardServerActive({
    bridgePresent,
    selection: envSelection,
    parsed: parseMCPConfig(envSelection.raw),
  });

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
    const selection = selectMCPConfig(pi.getFlag("mcp-config"), process.env.AIWB_MCP_CONFIG);
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
          executionMode: "sequential",
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
  // not wired at all here — these tools run un-gated (plan R4/§3.5). The
  // subagent tool is app-only.
  if (!bridgePresent) return;

  // The app's subagent tool: children are app-spawned `pi --mode rpc` processes
  // whose activity is forwarded over this same bridge connection, tagged with
  // the parent tool-call id and the child session id. Subagents inherit
  // AIWB_MCP_CONFIG, so a board chat's children keep the board MCP tools and a
  // plain chat's children get none (plan R8/§3.6).
  const subagentParameters = Type.Object({
    description: Type.String({
      description: "Short UI label for this subagent (a few words, not a sentence).",
    }),
    prompt: Type.String({
      description:
        "The full, self-contained task for the subagent. It sees nothing from this conversation, so include everything it needs.",
    }),
    subagent_type: Type.Optional(
      Type.String({ description: 'Optional agent type label, e.g. "researcher" or "reviewer". Default: general-purpose.' }),
    ),
    model: Type.Optional(
      Type.String({ description: "Optional provider-qualified model id for the child. Default: this chat's model." }),
    ),
    thinking: Type.Optional(
      Type.String({ description: "Optional thinking level for the child (off, minimal, low, medium, high, ...)." }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Run the subagent without waiting: the tool returns immediately and the subagent reports when it finishes. Default false.",
      }),
    ),
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: subagentDescription(boardToolsAdvertised),
    promptSnippet: subagentPromptSnippet(boardToolsAdvertised),
    parameters: subagentParameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: SubagentParams, signal?: AbortSignal) {
      return runSubagent({
        toolCallId,
        params,
        env: process.env,
        signal,
        cwd: process.cwd(),
        selfPath: fileURLToPath(import.meta.url),
        registerKiller: registerChildKiller,
        activity: (sub, event) => {
          void callBridge(socketPath, { kind: "activity", run, sub, event }).catch(() => {
            // Fire and forget: child activity must never block the child.
          });
        },
      });
    },
  });

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
