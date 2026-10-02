// Pure permission-gate logic for the extension's pi.on("tool_call") hook.
//
// This module imports no pi/typebox code so it is unit-testable with plain
// Node (node --test --experimental-strip-types). index.ts wires pi's event to
// handleToolCall; the socket work is injected as `ask` so tests can supply a
// fake server or a failing stub.
//
// Behavior (plan §3.5/R4): the app's own tools (the app-sourced `mcp__board__*`
// MCP tools plus the `subagent` tool) are auto-allowed without a bridge ask;
// every other tool sends exactly one ask frame and blocks unless the app
// answers {ok:true, allow:true}. Socket failures and timeouts block fail-safe:
// an unapproved tool must never run.

import type { SubIdentity } from "./protocol.ts";

/** The app's subagent tool name; registered by the later subagent job. */
export const SUBAGENT_TOOL = "subagent";

/** Ask timeout: longer than the adapter's 10-minute decision window. */
export const ASK_TIMEOUT_MS = 11 * 60 * 1000;

/** Reason shown to the model when the app denied without a reason of its own. */
export const DEFAULT_DENY_REASON = "the permission request was denied";

/** The subset of pi's tool_call event this gate needs. */
export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input?: unknown;
}

/** The block decision pi turns into a failed tool result. */
export interface ToolCallBlock {
  block: true;
  reason: string;
}

/** handleToolCall resolves undefined to let the tool run, or a block decision. */
export type ToolCallDecision = ToolCallBlock | undefined;

/** Dependencies of the gate; everything the pure module touches is injected. */
export interface PermissionDeps {
  /** The run token sent on every ask frame (AIWB_BRIDGE_RUN). */
  run: string;
  /** The process environment used for the child subagent identity. */
  env: Record<string, string | undefined>;
  /** The app's own tool names, auto-allowed without an ask (index.ts computes
   * the app-sourced mcp__board__* names). */
  autoAllowed: readonly string[];
  /** ask sends one {kind:"ask"} frame and resolves with the bridge response. */
  ask: (frame: object, timeoutMs: number) => Promise<unknown>;
  /** timeoutMs overrides ASK_TIMEOUT_MS (tests inject a short value). */
  timeoutMs?: number;
}

/**
 * subIdentity reads the env the adapter sets on child runs. AIWB_SUB_PARENT
 * being set is the signal that this is a child; a missing/non-numeric depth
 * falls back to 0.
 */
export function subIdentity(env: Record<string, string | undefined>): SubIdentity | undefined {
  const parent = env.AIWB_SUB_PARENT;
  if (!parent) return undefined;
  const depth = Number(env.AIWB_SUB_DEPTH ?? 0);
  return {
    parent,
    depth: Number.isFinite(depth) ? depth : 0,
    child: env.AIWB_SUB_CHILD ?? "",
  };
}

function isOwnTool(name: string, deps: PermissionDeps): boolean {
  if (name === SUBAGENT_TOOL) return true;
  return deps.autoAllowed.includes(name);
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function denyReason(resp: unknown): string {
  if (resp && typeof resp === "object") {
    const r = resp as { reason?: unknown; error?: unknown };
    if (typeof r.reason === "string" && r.reason.trim() !== "") return r.reason;
    if (typeof r.error === "string" && r.error.trim() !== "") return r.error;
  }
  return DEFAULT_DENY_REASON;
}

/**
 * handleToolCall is the whole tool_call gate. It never throws: every failure
 * path resolves to a block so pi cannot execute an unapproved tool.
 */
export async function handleToolCall(event: ToolCallEvent, deps: PermissionDeps): Promise<ToolCallDecision> {
  if (isOwnTool(event.toolName, deps)) return undefined;

  const frame: Record<string, unknown> = {
    kind: "ask",
    run: deps.run,
    id: event.toolCallId,
    name: event.toolName,
    input: event.input ?? {},
  };
  const sub = subIdentity(deps.env);
  if (sub) frame.sub = sub;

  let resp: unknown;
  try {
    resp = await deps.ask(frame, deps.timeoutMs ?? ASK_TIMEOUT_MS);
  } catch (err) {
    return {
      block: true,
      reason: `permission request failed (${errorText(err)}); ${event.toolName} was not run`,
    };
  }

  const r = resp as { ok?: unknown; allow?: unknown } | null;
  if (!r || r.ok !== true || r.allow !== true) {
    return { block: true, reason: denyReason(resp) };
  }
  return undefined;
}
