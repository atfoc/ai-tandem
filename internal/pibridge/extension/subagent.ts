// The app's `subagent` tool: it owns a child `pi --mode rpc` process, relays the
// child's activity to the app over the bridge and kills the child's process tree
// by PID on abort (never by negative process-group id: the child shares the
// parent pi process group).
//
// This module imports Node built-ins only (child_process/fs/path) and no pi or
// typebox code, so `node --test --experimental-strip-types` can import it.
// index.ts supplies the bridge activity sender, the killer registry, the app
// environment and the materialized extension path.
//
// Child protocol (plan §5.2/§8.6):
//   1. `{id:"s1",type:"get_state"}` -> on success `{id:"p1",type:"prompt",message}`
//   2. the child's RPC stream is mapped to compact activity frames
//   3. `agent_settled` -> one `get_session_stats`, then a final usage frame and
//      a `done` frame; stdin stays open until then so pi does not shut down.
//
// Abort (user Stop or the bridge abort push) sends SIGTERM to every PID in the
// child's tree (descendants first), waits up to killWaitMs for them to go, then
// SIGKILLs the survivors, and emits `done` stopped exactly once.

import {
  spawn as defaultSpawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Parameters of the app `subagent` tool (mirrors index.ts's Type.Object schema). */
export interface SubagentParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  thinking?: string;
  background?: boolean;
}

/** Identity attached to every activity frame (mirrors agent.SubIdentity). */
export interface SubagentIdentity {
  parent: string;
  depth: number;
  child: string;
}

/** One child-activity event (the fields of agent.SubActivity this tool emits). */
export type SubagentFrame =
  | {
      type: "start";
      id: string;
      description: string;
      prompt: string;
      agentType: string;
      model?: string;
      background: boolean;
    }
  | { type: "thinking" }
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_input"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; tokens?: number; window?: number; toolUses?: number }
  | {
      type: "done";
      status: "completed" | "failed" | "stopped";
      summary?: string;
      error?: string;
      tokens?: number;
      window?: number;
      toolUses?: number;
    };

/** The tool result returned to pi (the adapter streams the sub-thread separately). */
export interface SubagentToolResult {
  content: { type: "text"; text: string }[];
  details: {
    status: "completed" | "stopped" | "running";
    childId: string;
    tokens?: number;
    window?: number;
    toolUses?: number;
    background: boolean;
  };
}

/** A failed run's rejection: `message` is the child's last report when it left one (so the parent
 * card shows it even when stderr is empty), otherwise the stderr/error text; `summary` carries
 * that last report when there is one. The done frame's `error` field always keeps the stderr text. */
export interface SubagentError extends Error {
  summary?: string;
}

/** Spawn signature; tests may inject their own (defaults to child_process.spawn). */
export type SpawnChild = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Dependencies and behavior switches of one subagent run. */
export interface RunSubagentOptions {
  /** The parent's tool-call id: the identity parent and the killer registration. */
  toolCallId: string;
  params: SubagentParams;
  /** The parent process env (AIWB_* bridge vars, model/thinking, AIWB_PI_BIN). */
  env: Record<string, string | undefined>;
  /** pi's abort signal for this tool call, if any. */
  signal?: AbortSignal;
  /** Working directory of the child (defaults to process.cwd()). */
  cwd?: string;
  /** Path of the materialized app extension (fileURLToPath(import.meta.url)). */
  selfPath: string;
  /**
   * Registers the abort killer for this child; the returned function (when
   * supplied) deregisters it once the child exits.
   */
  registerKiller: (fn: () => void) => (() => void) | void;
  /** Emits one activity frame; called with the child's identity and the event. */
  activity: (sub: SubagentIdentity, event: SubagentFrame) => void;
  /** Injectable spawn for tests. */
  spawn?: SpawnChild;
  /** SIGTERM -> SIGKILL grace period for the child tree (default 3000ms). */
  killWaitMs?: number;
}

const GET_STATE_ID = "s1";
const PROMPT_ID = "p1";
const STATS_ID = "t1";
const MAX_STDERR = 64 * 1024;
const DEFAULT_KILL_WAIT_MS = 3000;
const STATS_TIMEOUT_MS = 5000;
const KILL_POLL_MS = 25;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/** randomChildId returns "s" + 12 hex, safe for pi --session-id and paths. */
function randomChildId(): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16)}`;
  return `s${uuid.replace(/-/g, "").slice(0, 12)}`;
}

/** The bash-timeout reminder appended to a DeepSeek Flash child's system prompt (see childArgs). */
const BASH_TIMEOUT_REMINDER = "Never run bash commands without timeout";

/** isDeepSeekFlash reports whether a child model choice names a DeepSeek Flash model: V4 Flash,
 * V4.1 Flash, their aliases and dated variants, and provider-qualified catalog ids. Broad on
 * purpose so a new DeepSeek Flash release keeps the reminder. */
function isDeepSeekFlash(model: string): boolean {
  const id = model.toLowerCase();
  return id.includes("deepseek") && id.includes("flash");
}

/** childEnv copies env (dropping undefined) and applies the subagent identity. */
function childEnv(
  env: Record<string, string | undefined>,
  toolCallId: string,
  childId: string,
  depth: number,
  model: string,
  thinking: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  out.AIWB_SUB_PARENT = toolCallId;
  out.AIWB_SUB_DEPTH = String(depth);
  out.AIWB_SUB_CHILD = childId;
  if (model) out.AIWB_MODEL = model;
  if (thinking) out.AIWB_THINKING = thinking;
  return out;
}

/** assistantText joins the text parts of an assistant message. */
function assistantText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

/** joinedResult joins the text parts of a tool_execution_end result. */
function joinedResult(result: any): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/** isProcessAlive reports whether pid still exists (EPERM counts as alive). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** signalPid signals one positive PID, ignoring a process that already exited. */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH (already gone) and EPERM are both best-effort no-ops here.
  }
}

/**
 * collectProcessTree returns rootPid and all of its descendants, deepest
 * first, from `ps -eo pid=,ppid=`. On a ps failure it returns just [rootPid].
 * PIDs are only ever used positive.
 */
function collectProcessTree(rootPid: number): number[] {
  let output = "";
  try {
    const res = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" });
    if (res.status !== 0 || typeof res.stdout !== "string") return [rootPid];
    output = res.stdout;
  } catch {
    return [rootPid];
  }

  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || pid <= 0) continue;
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }

  const ordered: number[] = [];
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) walk(child);
    ordered.push(pid);
  };
  walk(rootPid);
  return ordered;
}

/**
 * killProcessTree SIGTERMs every PID of the tree (children first), then polls
 * for up to waitMs and SIGKILLs the survivors. Never uses a negative PID.
 */
function killProcessTree(rootPid: number | undefined, waitMs: number): void {
  if (typeof rootPid !== "number" || !Number.isFinite(rootPid) || rootPid <= 0) return;
  const pids = collectProcessTree(rootPid);
  for (const pid of pids) signalPid(pid, "SIGTERM");

  const deadline = Date.now() + Math.max(0, waitMs);
  const poll = (): void => {
    const alive = pids.filter(isProcessAlive);
    if (alive.length === 0) return;
    if (Date.now() >= deadline) {
      for (const pid of alive) signalPid(pid, "SIGKILL");
      return;
    }
    setTimeout(poll, KILL_POLL_MS);
  };
  poll();
}

/**
 * runSubagent spawns one child pi run and resolves with the tool result for a
 * foreground call. Background calls resolve as soon as the child is started and
 * keep streaming activity (and the `done` frame) to the bridge; a spawn failure
 * or a failed child rejects the returned promise with a clear error.
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentToolResult> {
  const params = opts.params ?? ({} as SubagentParams);
  const description = str(params.description);
  const prompt = str(params.prompt);
  const background = params.background === true;
  const subagentType = str(params.subagent_type) || "general-purpose";
  const env = opts.env ?? {};

  const envModel = str(env.AIWB_MODEL);
  const envThinking = str(env.AIWB_THINKING);
  const model = str(params.model) || envModel;
  const thinking = str(params.thinking) || envThinking;

  const chatDir = str(env.AIWB_CHAT_DIR);
  if (!chatDir) throw new Error("subagent: AIWB_CHAT_DIR is not set; cannot create the child session dir");
  if (!opts.selfPath) throw new Error("subagent: the app extension path is not set");

  const childId = randomChildId();
  const childDir = path.join(chatDir, "subagents", childId, "pi");
  fs.mkdirSync(childDir, { recursive: true, mode: 0o700 });

  // A child of a chat has depth 0; a child of a child has depth+1.
  const parentDepth = Number(env.AIWB_SUB_DEPTH ?? 0);
  const depth = env.AIWB_SUB_PARENT
    ? Number.isFinite(parentDepth) && parentDepth >= 0
      ? parentDepth + 1
      : 1
    : 0;

  const identity: SubagentIdentity = { parent: opts.toolCallId, depth, child: childId };
  const emit = (event: SubagentFrame): void => {
    try {
      opts.activity(identity, event);
    } catch {
      // A bridge failure must not stop the child run.
    }
  };

  const args: string[] = [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    opts.selfPath,
    "--session-dir",
    childDir,
    "--session-id",
    childId,
    "--no-approve",
  ];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  if (env.AIWB_APPEND_PROMPT) args.push("--append-system-prompt", env.AIWB_APPEND_PROMPT);
  // DeepSeek Flash children also get the bash-timeout reminder; pi joins repeated
  // --append-system-prompt values with blank lines.
  if (isDeepSeekFlash(model)) args.push("--append-system-prompt", BASH_TIMEOUT_REMINDER);

  let child: ChildProcess | undefined;
  let stdoutBuffer = "";
  let stderrTail = "";
  let lastAssistantText = "";
  let lastUsageTokens = 0;
  let lastWindow = 0;
  let toolUses = 0;
  const toolCallIds = new Set<string>();
  let finalTokens = 0;
  let finalWindow = 0;
  let settleSeen = false;
  let abortRequested = false;
  let doneEmitted = false;
  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  let deregisterKiller: (() => void) | undefined;
  let signalListener: (() => void) | undefined;

  let resolveOutcome: ((result: SubagentToolResult) => void) | undefined;
  let rejectOutcome: ((err: Error) => void) | undefined;
  const outcome = new Promise<SubagentToolResult>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  // Background runs nobody awaits must not turn a late rejection into an
  // unhandled-rejection crash.
  void outcome.catch(() => {});

  const writeCommand = (command: Record<string, unknown>): void => {
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return;
    try {
      stdin.write(`${JSON.stringify(command)}\n`);
    } catch {
      // The child is gone; exit/close handles the result.
    }
  };

  const finish = (status: "completed" | "failed" | "stopped", error?: string, summary?: string): void => {
    if (doneEmitted) return;
    doneEmitted = true;
    if (statsTimer !== undefined) {
      clearTimeout(statsTimer);
      statsTimer = undefined;
    }
    const frame: Extract<SubagentFrame, { type: "done" }> = { type: "done", status };
    if (summary) frame.summary = summary;
    if (error) frame.error = error;
    if (finalTokens > 0) frame.tokens = finalTokens;
    if (finalWindow > 0) frame.window = finalWindow;
    if (toolUses > 0) frame.toolUses = toolUses;
    emit(frame);

    // Closing stdin lets the settled child shut down gracefully.
    try {
      child?.stdin?.end();
    } catch {
      // Already closed.
    }

    if (status === "failed") {
      // The rejection's message is the child's last report when non-empty (so the parent card
      // shows it even when stderr is empty); the done frame's `error` field keeps the stderr text.
      const message = summary && summary.trim() ? summary : error && error.trim() ? error : "subagent failed";
      const failure: SubagentError = new Error(message);
      if (summary && summary.trim()) failure.summary = summary;
      rejectOutcome?.(failure);
      return;
    }
    resolveOutcome?.({
      content: [{ type: "text", text: summary && summary.trim() ? summary : "Subagent finished." }],
      details: { status, childId, tokens: finalTokens, window: finalWindow, toolUses, background: false },
    });
  };

  const dispose = (): void => {
    if (statsTimer !== undefined) {
      clearTimeout(statsTimer);
      statsTimer = undefined;
    }
    if (deregisterKiller) {
      try {
        deregisterKiller();
      } catch {
        // Best effort.
      }
      deregisterKiller = undefined;
    }
    if (opts.signal && signalListener) {
      opts.signal.removeEventListener("abort", signalListener);
      signalListener = undefined;
    }
  };

  const abortRun = (): void => {
    if (abortRequested) return;
    abortRequested = true;
    killProcessTree(child?.pid, opts.killWaitMs ?? DEFAULT_KILL_WAIT_MS);
    if (finalTokens === 0) finalTokens = lastUsageTokens;
    finish("stopped", undefined, lastAssistantText || undefined);
  };

  const captureStats = (data: any): void => {
    let tokens = 0;
    let window = 0;
    const contextUsage = data?.contextUsage;
    if (contextUsage && num(contextUsage.tokens) > 0) tokens = num(contextUsage.tokens);
    if (contextUsage && num(contextUsage.contextWindow) > 0) window = num(contextUsage.contextWindow);
    // A null/absent contextUsage.tokens means "not measurable right now" (e.g. after compaction).
    // The last message usage is the best fill estimate; stats.tokens.total is cumulative spend,
    // not context fill, so it is only the last resort.
    if (tokens === 0) tokens = lastUsageTokens;
    if (tokens === 0 && data?.tokens) tokens = num(data.tokens.total);
    if (window === 0) window = lastWindow;
    finalTokens = tokens;
    finalWindow = window;

    const frame: Extract<SubagentFrame, { type: "usage" }> = { type: "usage" };
    if (tokens > 0) frame.tokens = tokens;
    if (window > 0) frame.window = window;
    emit(frame);
  };

  const requestStats = (): void => {
    if (settleSeen) return;
    settleSeen = true;
    writeCommand({ id: STATS_ID, type: "get_session_stats" });
    statsTimer = setTimeout(() => {
      statsTimer = undefined;
      if (finalTokens === 0) finalTokens = lastUsageTokens;
      finish("completed", undefined, lastAssistantText || undefined);
    }, STATS_TIMEOUT_MS);
    if (typeof statsTimer.unref === "function") statsTimer.unref();
  };

  const handleResponse = (msg: any): void => {
    if (msg.id === GET_STATE_ID) {
      if (msg.success === false) {
        finish("failed", str(msg.error) || "child pi rejected get_state", lastAssistantText || undefined);
        return;
      }
      writeCommand({ id: PROMPT_ID, type: "prompt", message: prompt });
      return;
    }
    if (msg.id === PROMPT_ID) {
      if (msg.success === false) finish("failed", str(msg.error) || "child pi rejected the prompt", lastAssistantText || undefined);
      return;
    }
    if (msg.id === STATS_ID) {
      if (statsTimer !== undefined) {
        clearTimeout(statsTimer);
        statsTimer = undefined;
      }
      captureStats(msg.data);
      finish("completed", undefined, lastAssistantText || undefined);
    }
  };

  const handleMessageUpdate = (msg: any): void => {
    const event = msg.assistantMessageEvent;
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "text_start":
        emit({ type: "text", text: "" });
        break;
      case "text_delta":
        if (typeof event.delta === "string" && event.delta !== "") emit({ type: "text", text: event.delta });
        break;
      case "thinking_start":
      case "thinking_delta":
        emit({ type: "thinking" });
        break;
      case "toolcall_start": {
        const partial = event.partial?.content?.[event.contentIndex];
        const id = str(event.id) || str(partial?.id);
        const name = str(event.toolName) || str(partial?.name);
        if (id && !toolCallIds.has(id)) {
          toolCallIds.add(id);
          toolUses++;
        }
        emit({ type: "tool_start", id, name });
        break;
      }
      case "toolcall_end": {
        const toolCall = event.toolCall;
        if (!toolCall || typeof toolCall !== "object") return;
        emit({
          type: "tool_input",
          id: str(toolCall.id),
          name: str(toolCall.name),
          input: toolCall.arguments ?? {},
        });
        break;
      }
      default:
        break;
    }
  };

  const handleMessageEnd = (msg: any): void => {
    const message = msg.message;
    if (!message || message.role !== "assistant") return;
    const text = assistantText(message);
    if (text) lastAssistantText = text;

    const usage = message.usage;
    if (!usage || typeof usage !== "object") return;
    const tokens = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
    if (tokens === 0) return;
    lastUsageTokens = tokens;
    const window =
      num(message.contextWindow) || num(message.model?.contextWindow) || num(usage.contextWindow);
    if (window > 0) lastWindow = window;
    const frame: Extract<SubagentFrame, { type: "usage" }> = { type: "usage", tokens };
    if (window > 0) frame.window = window;
    emit(frame);
  };

  const handleLine = (line: string): void => {
    if (line.trim() === "") return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // unknown/garbled line: ignore
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "response") {
      handleResponse(msg);
      return;
    }
    switch (msg.type) {
      case "message_update":
        handleMessageUpdate(msg);
        break;
      case "message_end":
        handleMessageEnd(msg);
        break;
      case "tool_execution_end":
        emit({
          type: "tool_result",
          id: str(msg.toolCallId),
          name: str(msg.toolName),
          result: joinedResult(msg.result),
          isError: msg.isError === true,
        });
        break;
      case "agent_settled":
        requestStats();
        break;
      default:
        break; // ignore unknown events
    }
  };

  const spawnFn: SpawnChild = opts.spawn ?? (defaultSpawn as SpawnChild);
  try {
    child = spawnFn(str(env.AIWB_PI_BIN) || "pi", args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv(env, opts.toolCallId, childId, depth, model, thinking),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    finish("failed", `failed to spawn subagent pi: ${errorMessage(err)}`, lastAssistantText || undefined);
    return outcome;
  }

  // The start frame is emitted before any child output can arrive.
  const startFrame: Extract<SubagentFrame, { type: "start" }> = {
    type: "start",
    id: childId,
    description,
    prompt,
    agentType: subagentType,
    background,
  };
  if (model) startFrame.model = model;
  emit(startFrame);

  child.stdin?.on("error", () => {
    // EPIPE on shutdown is expected; close/error below own the result.
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let nl: number;
    while ((nl = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail += chunk;
    if (stderrTail.length > MAX_STDERR) stderrTail = stderrTail.slice(-MAX_STDERR);
  });

  child.on("error", (err: Error) => {
    dispose();
    finish("failed", `failed to spawn subagent pi: ${err.message}`, lastAssistantText || undefined);
  });

  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    dispose();
    if (doneEmitted) return;
    if (abortRequested) {
      finish("stopped", undefined, lastAssistantText || undefined);
      return;
    }
    if (settleSeen) {
      // The child settled but its stats response did not arrive first.
      if (finalTokens === 0) finalTokens = lastUsageTokens;
      finish("completed", undefined, lastAssistantText || undefined);
      return;
    }
    const tail = stderrTail.trim();
    const detail =
      code !== null ? ` (code ${code})` : signal ? ` (signal ${signal})` : "";
    finish("failed", tail || `child pi exited before settling${detail}`, lastAssistantText || undefined);
  });

  // Kick off the child RPC: get_state, then the prompt on its success.
  writeCommand({ id: GET_STATE_ID, type: "get_state" });

  // Abort: register with the extension's killer registry and honor pi's signal.
  const killer = (): void => abortRun();
  try {
    const unregister = opts.registerKiller(killer);
    if (typeof unregister === "function") deregisterKiller = unregister;
  } catch {
    // A broken registry must not prevent the run.
  }
  if (opts.signal) {
    signalListener = killer;
    if (opts.signal.aborted) abortRun();
    else opts.signal.addEventListener("abort", signalListener, { once: true });
  }

  if (background) {
    return {
      content: [{ type: "text", text: `Subagent "${description}" started.` }],
      details: { status: "running", childId, background: true },
    };
  }
  return outcome;
}
