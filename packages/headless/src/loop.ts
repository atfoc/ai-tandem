// The writer's loop over its one stream (D22): the events of the server go to the app's own board side (`createBoardSide`), with
// no view attached and the Node engine as its engine (D21). It is the small part of the app's event layer (state/conn.ts) that
// boards need, plus what a writer with no person behind it must do itself: save before it answers (D25), give a board back
// after a quiet time (D26), and yield it when asked (D17).
//
// It takes nothing by itself (D27): a board is its own from the `held` the server sends until it releases it, and the board
// side's own take is a refusal here (api.ts). Everything is keyed by the server's own board ids; the one server is "this
// computer" to the store.
import type { Envelope } from "@aiwb/conn";
import { RpcError } from "@aiwb/core/board/scene.ts";
import { createBoardSide, type BoardApp } from "@aiwb/core/board/side.ts";
import type { BoardChannel } from "@aiwb/core/board/channel.ts";
import { setBoardSide, type ToolCall, type ToolResult } from "@aiwb/core/state/ports.ts";
import * as store from "@aiwb/core/state/store.ts";
import { makeApi, type ClientLike, type WriterApi } from "./api.ts";
import { nameOf, noSelectionText, noShowText, noViewText, saveFailedText, takenText } from "./texts.ts";

/** The quiet time a board is kept after the last call on it (D26), and the longest wait for the call in progress when a board
 *  is asked for (D17): the server sends both in the start-up configuration. */
export const QUIET_DEFAULT_MS = 60_000;
export const HANDOVER_DEFAULT_MS = 8_000;
const NO_TIMER_MS = 60 * 60_000;

export type LoopOptions = {
  client: ClientLike;
  /** The entry id of the server in the client's list. */
  server: string;
  /** The engine's channel (engine.ts). */
  engine: BoardChannel;
  quietMs?: number;
  handoverMs?: number;
  /** Where a line of the writer's own goes; never board content and never a secret. */
  log?: (line: string) => void;
  /** Where the test knob prints its line (stderr). */
  print?: (line: string) => void;
  /** `AIWB_HEADLESS_TEST=hold-before-save[:N]`: after the `apply` of the Nth call of that tool (true: the first; counted over all boards
   *  from the start of the loop) and before its save, print `HOLD apply <board>` (the server's log adds `headless:`) and wait for ever
   *  (the end-to-end test kills the process there). The applies before it are saved and answered as usual. */
  holdBeforeSave?: boolean | number;
  /** The one stream ended or its server left `connected`, after it had been connected. The loop has stopped listening. */
  onEnd?: (reason: string) => void;
};

export type ServerState = { state: string; detail: string };

export type Loop = {
  side: BoardApp;
  /** Resolves with the first snapshot; rejects when the server refuses the connection in a way that waits for a person. */
  connected: Promise<void>;
  /** The state of the connection to the server as it last was told (for the reason a start failed). */
  lastState(): ServerState;
  /** The boards this writer holds. */
  holds(): string[];
  /** Saves everything that waits (at most limitMs), then stops listening. Nothing is answered after it. */
  shutdown(limitMs: number): Promise<void>;
};

type BoardRun = {
  /** Calls in progress on the board. */
  active: number;
  /** The board is being given up (D17): new calls are answered TAKEN. */
  yielding: boolean;
  /** The board was released while a call was still in progress: that call answers TAKEN and writes nothing (3.4, 6.3). */
  cut: boolean;
  quiet?: ReturnType<typeof setTimeout>;
  idle: (() => void)[];
};

/** The states of a connection that do not mend by themselves (the others, `connecting` and `unreachable`, are tried again). */
const REFUSED = new Set(["certificate_not_accepted", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "name_not_known",
  "not_aiwb", "too_old", "another_server"]);

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startLoop(o: LoopOptions): Loop {
  const quietMs = o.quietMs ?? QUIET_DEFAULT_MS;
  const handoverMs = o.handoverMs ?? HANDOVER_DEFAULT_MS;
  const log = o.log ?? (() => {});
  const print = o.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const api: WriterApi = makeApi(o.client, o.server);
  // (nothing is written on a timer: every write is the loop's own `flush`, after a finished change, so a board shows only what an agent
  // was told is done; the board side's debounce is set far away, and `flush` clears it)
  const side = createBoardSide({ api, saveDebounce: NO_TIMER_MS, agentSave: NO_TIMER_MS });
  side.setEngine(() => Promise.resolve(o.engine));
  setBoardSide(side);

  const runs = new Map<string, BoardRun>();
  const runOf = (id: string): BoardRun => {
    let r = runs.get(id);
    if (!r) { r = { active: 0, yielding: false, cut: false, idle: [] }; runs.set(id, r); }
    return r;
  };
  let closed = false, ended = false, wasConnected = false;
  let applies = 0; // the applies that reached their save (the test knob holdBeforeSave counts them)
  let last: ServerState = { state: "connecting", detail: "" };
  let sub: { close(): void } | null = null;
  let onConnected!: () => void, onRefused!: (e: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { onConnected = resolve; onRefused = reject; });
  connected.catch(() => {}); // (the caller may not wait for it)

  // ---- the boards this writer holds

  /** The board is let go: nothing of it is kept (its scene, its save state, its role), and nothing runs for it. */
  function forget(id: string) {
    const r = runs.get(id);
    if (r?.quiet) clearTimeout(r.quiet);
    runs.delete(id);
    side.forgetBoard(id);
    store.setRole(id, null);
    store.setDropped(id, false);
  }

  /** Waits until no call is in progress on the board, at most ms. */
  function idle(r: BoardRun, ms: number): Promise<void> {
    if (!r.active) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); r.idle = r.idle.filter((f) => f !== done); resolve(); }
      r.idle.push(done);
    });
  }

  // ---- the quiet time (D26)

  function armQuiet(id: string) {
    const r = runs.get(id);
    if (!r || r.yielding || closed) return;
    clearTimeout(r.quiet);
    r.quiet = setTimeout(() => void quietEnded(id), quietMs);
  }

  async function quietEnded(id: string) {
    const r = runs.get(id);
    if (!r || r.yielding || closed) return;
    r.quiet = undefined;
    if (r.active) return; // (the end of that call arms the quiet time again)
    try {
      await side.flush(id);
      if (r.active || r.yielding || runs.get(id) !== r || closed) return;
      if (side.boardUnsaved(id)) { armQuiet(id); return; } // a write that failed is tried again at the next quiet time, not given away
      const { state } = await api.release(id, true);
      if (runs.get(id) !== r) return;
      if (state === "kept") armQuiet(id); // a call was routed to this writer meanwhile: it keeps the board
      else forget(id);                    // free, handed or none: the board is not this writer's any more
    } catch (e) {
      log(`quiet release of board ${id} failed: ${messageOf(e)}`);
      if (runs.get(id) === r) armQuiet(id);
    }
  }

  // ---- yielding a board (D17)

  /** `release_request`: another window asks for the board. No new call is started on it (TAKEN), the one in progress is waited
   *  for (at most handoverMs), and the board is released. Every finished change is already saved (D25), so when the call ended there
   *  is nothing to write but what a failed save left (flushed); when it did not, its change is neither finished nor failed cleanly: it
   *  is not written, the board is released without it, and the call answers TAKEN when it gets to its save (6.3). */
  async function yieldBoard(id: string) {
    const r = runOf(id);
    if (r.yielding) return;
    r.yielding = true;
    clearTimeout(r.quiet);
    await idle(r, handoverMs);
    if (r.active) {
      r.cut = true;
      log(`the call in progress on board ${id} did not end in ${handoverMs} ms: its change is not written, the board is given up`);
    } else {
      try { await side.flush(id); } catch (e) { log(`saving board ${id} before it is given up failed: ${messageOf(e)}`); }
    }
    try { await api.release(id); } catch (e) { log(`releasing board ${id} failed: ${messageOf(e)}`); }
    if (runs.get(id) === r) forget(id);
  }

  // ---- the agent's calls (2.8, 2.9)

  /** Whether a change was written: nothing waits to be written, the board is still this writer's and its scene is kept. */
  function unsavedReason(id: string): string {
    const st = store.getState();
    if (side.boardUnsaved(id)) return st.saveSaid[id] || (st.outage[id] ? "the server could not be reached" : "the server did not take the write");
    if (st.dropped[id] || st.roles[id] !== "held" || !side.scene(id)) return "the board was changed or taken over elsewhere before the write";
    return "";
  }

  async function answerTool(call: ToolCall): Promise<ToolResult> {
    const st = store.getState();
    const target = call.target;
    switch (call.name) {
      // (the server never sends these two here, D7; if one comes, it is told in plain words and is no error)
      case "get_view": return noViewText(nameOf(call.board, st.boards[call.board]));
      case "show_board": return noShowText(nameOf(target ?? call.board, st.boards[target ?? call.board]));
      case "read_board": case "apply": case "delete_elements": case "get_image": break;
      default: return side.runTool(call); // (UNKNOWN_TOOL, in the side's own words)
    }
    // a call with no known target is answered as the side answers it (NO_BOARD)
    if (!target || !st.boards[target]) return side.runTool(call);
    const name = nameOf(target, st.boards[target]);
    const run = runOf(target);
    if (run.yielding) throw new RpcError("TAKEN", takenText(name));
    if (call.name === "get_image" && call.args?.scope === "selection") throw new RpcError("NO_SELECTION", noSelectionText(name));
    if (st.roles[target] !== "held") throw new RpcError("NOT_HOLDER", "this window does not hold the board");
    run.active++;
    clearTimeout(run.quiet);
    try {
      let result: ToolResult;
      try {
        result = await side.runTool(call);
      } catch (e) {
        if (run.cut) throw new RpcError("TAKEN", takenText(name)); // (the board was given up under it: whatever the engine said is no answer)
        throw e;
      }
      if (call.name === "apply" || call.name === "delete_elements") {
        if (call.name === "apply" && o.holdBeforeSave && ++applies === (o.holdBeforeSave === true ? 1 : o.holdBeforeSave)) { print(`HOLD apply ${target}`); await new Promise<never>(() => {}); }
        if (run.cut) throw new RpcError("TAKEN", takenText(name)); // (nothing is written for a board that is no longer this writer's)
        // saved before the agent is told it is done (D25)
        await side.flush(target);
        const why = unsavedReason(target);
        if (why) throw new RpcError("SAVE_FAILED", saveFailedText(why));
      } else if (run.cut) throw new RpcError("TAKEN", takenText(name));
      return result;
    } finally {
      run.active--;
      if (!run.active) { const waiting = run.idle; run.idle = []; for (const f of waiting) f(); }
      // a call cut off by a release may have put its change back into the board side after the board was forgotten: it goes again
      if (run.cut && !runs.has(target)) side.forgetBoard(target);
      armQuiet(target);
    }
  }

  /** An `rpc` event: runs the tool and replies to the server, as conn.ts does (a 409 is not an error: the call is no longer this
   *  writer's to answer). */
  async function answer(m: any) {
    let reply: { result?: unknown; error?: string };
    try {
      if (m.method !== "tool") throw new Error(`unknown method ${m.method}`);
      reply = { result: await answerTool(m.params) };
    } catch (err: any) {
      reply = { error: `${err?.code ? err.code + ": " : ""}${err?.message ?? String(err)}` };
    }
    if (closed) return;
    await api.rpcReply(m.id, reply).catch((e) => { if (e?.status !== 409) log(`rpc reply failed: ${messageOf(e)}`); });
  }

  // ---- the events

  function onEvent(m: any) {
    switch (m?.type) {
      case "hello": side.streamOpened(); return;
      case "snapshot": {
        const boards: Record<string, any> = {};
        for (const b of Array.isArray(m.boards) ? m.boards : []) if (b?.id) boards[b.id] = b;
        store.setState({ boards, connected: true });
        wasConnected = true;
        onConnected();
        return;
      }
      case "board": if (m.board?.id) store.upsertBoard(m.board); return;
      case "board_removed": if (m.id) { const r = runs.get(m.id); if (r?.quiet) clearTimeout(r.quiet); runs.delete(m.id); store.removeBoard(m.id); } return;
      case "held": if (m.board) { side.granted(m.board, m.rev ?? 0); runOf(m.board); armQuiet(m.board); } return; // (the quiet time starts at the grant: a board no call came for is let go)
      case "superseded": if (m.board) { side.boardLost(m.board); forget(m.board); } return; // the board went to another window
      case "release_request": if (m.board) void yieldBoard(m.board); return;
      case "server_stopping": void side.flushAll().then(() => api.flushed()).catch((e) => log(`answering server_stopping failed: ${messageOf(e)}`)); return;
      case "rpc": void answer(m); return;
    }
  }

  function end(reason: string) {
    if (ended) return;
    ended = true;
    sub?.close();
    o.onEnd?.(reason);
  }

  function onEnvelope(e: Envelope) {
    if (closed || ended) return;
    if ("app" in e) {
      const v: any = (e.app as any)?.type === "server_state" ? (e.app as any).server : null;
      if (!v || v.id !== o.server) return;
      last = { state: String(v.state), detail: typeof v.detail === "string" ? v.detail : "" };
      // the one stream never opens again (D28): the next call starts a new process with the then current secret
      if (!wasConnected && REFUSED.has(last.state)) onRefused(new Error("the server refused the connection")); // (it waits for the user: not worth the start limit)
      if (wasConnected && v.state !== "connected") end(`the connection to the server ended (${last.detail || last.state})`);
      return;
    }
    if (e.server !== o.server) return;
    try { onEvent(e.event); } catch (err) { log(`an event of the server could not be handled: ${messageOf(err)}`); }
  }

  sub = o.client.subscribe(onEnvelope);

  return {
    side, connected,
    lastState: () => last,
    holds: () => Object.entries(store.getState().roles).filter(([, role]) => role === "held").map(([id]) => id),
    async shutdown(limitMs) {
      if (closed) return;
      for (const r of runs.values()) clearTimeout(r.quiet);
      // (saved before the listening stops, and before `closed`: a save is a call of the client)
      await Promise.race([side.flushAll().catch((e) => log(`saving at the end failed: ${messageOf(e)}`)), wait(limitMs)]);
      closed = true;
      sub?.close();
    },
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
