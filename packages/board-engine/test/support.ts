// Shared by the endpoint tests: the assets folder `copyEngineAssets` makes for this machine, and a way to ask the endpoint and wait.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyEngineAssets, createNodeEndpoint, type NodeEndpoint } from "../src/node.ts";
import type { EngineOp, FromBoard } from "@aiwb/board-bridge/messages.ts";

export const target = { os: process.platform as "darwin" | "linux", arch: process.arch as "arm64" | "x64" };

/** A new temp folder (removed with `rmTemp`). */
export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `aiwb-engine-${prefix}-`));
}
export const rmTemp = (dir: string): void => fs.rmSync(dir, { recursive: true, force: true });

/** The engine on assets copied into a temp folder: what the test asks and what the engine posted. */
export async function startEngine(options: { version?: string } = {}) {
  const root = tempDir("run");
  const assets = path.join(root, "engine");
  await copyEngineAssets(assets, target);
  const posted: FromBoard[] = [];
  const waiting = new Map<number, (m: Extract<FromBoard, { t: "res" }>) => void>();
  const endpoint: NodeEndpoint = await createNodeEndpoint((m) => {
    posted.push(m);
    if (m.t === "res") waiting.get(m.id)?.(m);
  }, { assets, warn: () => {}, ...options });
  let next = 1;
  /** Sends a `req` and waits for its `res`. */
  const ask = (op: EngineOp): Promise<Extract<FromBoard, { t: "res" }>> => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`no answer to ${op.op}`)), 60_000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    endpoint.receive({ t: "req", id, op });
  });
  return { root, assets, posted, endpoint, ask, close: async () => { await endpoint.close(); rmTemp(root); } };
}
