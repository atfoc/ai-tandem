// The board engine, behind one seam (architecture section 4). The engine is the board view's endpoint in Node: it answers the
// four requests on given elements (`restore`, `apply`, `delete`, `export`) with the board bridge's messages, and nothing else.
// This file makes a `BoardChannel` of it, the one the board side already works with for a board that is not on screen, so the
// writer's board side is the window's own (D21).
//
// The engine itself is `@aiwb/board-engine/node` (`createNodeEndpoint`, `ENGINE_EXTERNALS`, `copyEngineAssets`); build.mjs finds
// that package by itself, its externals and its assets. Tests give `startEngine` a fake `create`.
import type { FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { createChannel, type BoardChannel } from "@aiwb/core/board/channel.ts";

/** What the engine's Node entry takes (section 4 of the architecture). */
export type NodeEndpointOptions = {
  /** The folder of the engine's files inside the headless bundle (fonts, the native canvas, …): `<bundle dir>/engine`. */
  assets: string;
  /** What `ready` tells as its version. */
  version?: string;
  /** Where the engine logs a line; never board content. */
  warn?: (text: string) => void;
};

export type NodeEndpoint = {
  /** A message of the app, already validated. A `req` is answered with one `res` through `post`; every other message is ignored. */
  receive(m: ToBoard): void;
  /** A message that failed validation: logged; a `req` among them is answered `res ok:false code BAD_MESSAGE`. */
  refuse(raw: unknown, error: string): void;
  /** Frees what the engine holds (the canvas). */
  close(): Promise<void>;
};

/** Starts the engine; resolves once it can work, after posting `{ t: "ready", version }` once. Rejects, posting nothing, with an
 *  Error whose message says why it cannot run here. */
export type CreateNodeEndpoint = (post: (m: FromBoard) => void, options: NodeEndpointOptions) => Promise<NodeEndpoint>;

import { createNodeEndpoint } from "@aiwb/board-engine/node";

export type Engine = {
  /** Where the board side sends its work (`BoardApp.setEngine`). */
  channel: BoardChannel;
  close(): Promise<void>;
};

export type EngineOptions = NodeEndpointOptions & {
  /** The engine to start (default: this package's `createNodeEndpoint`); tests give a fake. */
  create?: CreateNodeEndpoint;
  /** How long the engine may take to say `ready` once started (ms). */
  readyMs?: number;
  /** How long a request may wait for its answer (ms; the channel's default is 20 s). */
  timeout?: number;
};

/** Starts the engine and joins it to a channel, in-process: the objects the side sends go to `receive`, the objects the engine
 *  posts go to the channel's `receive` (which checks them as it checks a view's). Rejects with the engine's own reason. */
export async function startEngine(o: EngineOptions): Promise<Engine> {
  const create = o.create ?? createNodeEndpoint;
  const warn = o.warn ?? ((t: string) => { process.stderr.write(`${t}\n`); });
  let endpoint: NodeEndpoint | null = null;
  const c = createChannel((m) => {
    const r = validateToBoard(m);
    if (r.ok) endpoint?.receive(r.value);
    else endpoint?.refuse(m, r.error);
  }, { warn, ...(o.timeout ? { timeout: o.timeout } : {}) });
  endpoint = await create((m) => c.receive(m), { assets: o.assets, ...(o.version ? { version: o.version } : {}), warn });
  try {
    await readyWithin(c.channel, o.readyMs ?? 5000);
  } catch (e) {
    await endpoint.close().catch(() => {});
    throw e;
  }
  const ep = endpoint;
  return {
    channel: c.channel,
    close: async () => { c.reset("the board engine was closed"); await ep.close(); },
  };
}

/** The engine posts `ready` before `create` resolves; a post that is late by a turn is waited for. */
function readyWithin(ch: BoardChannel, ms: number): Promise<void> {
  if (ch.ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("the board engine did not say it is ready")); }, ms);
    const off = ch.on((m) => { if (m.t === "ready") { clearTimeout(timer); off(); resolve(); } });
  });
}
