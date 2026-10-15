// The types of this computer's server on Node (node/local.js): the LocalPort of the desktop app and the test host.

import type { LocalPort } from '../ports';

/** What the server program answered: its exit code (-1 when it could not run), its output and its errors. */
export type RunResult = { code: number; stdout: string; stderr: string };

export type NodeLocalOptions = {
  /** The server program. */
  bin: string;
  /** Its -home, or null for its own default. */
  home?: string | null;
  /** Its environment; the process's when unset. */
  env?: Record<string, string | undefined>;
  /** Test seam: runs the program with args within timeoutMs, and always answers. */
  run?: (args: string[], timeoutMs: number) => Promise<RunResult>;
};

/** The LocalPort: Starter (launch -json, secret, relaunch -json, status -json), LocalConn and ownerOp. */
export function nodeLocal(options: NodeLocalOptions): LocalPort;
