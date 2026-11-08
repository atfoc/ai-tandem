// The entry of the board host's bundle (`dist/boardhost.mjs`, built by H4): the process as the server starts it, with the real
// connection module. The tests drive `run` (main.ts) with fakes; this is the only file that makes the real client.
//
// The first import installs the page (a DOM on the global object): every tldraw module (rooms.ts → schema.ts imports tldraw)
// is evaluated after it. Keep it first.
import "./node/install-page.ts";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, parseAppWaits } from "@aiwb/conn";
import { nodeConnector } from "@aiwb/conn/node";
import { memStore } from "@aiwb/headless/src/memstore.ts";
import { run } from "./main.ts";
import { loadRuntime } from "./node/runtime.ts";

process.on("unhandledRejection", (e) => { process.stderr.write(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}\n`); });

await run({
  stdin: process.stdin,
  stderr: (line) => { process.stderr.write(`${line}\n`); },
  exit: (code) => { process.exitCode = code; setImmediate(() => process.exit(code)); },
  env: process.env,
  signals: process,
  captureConsole: true,
  // the runtime (page, fonts, editor, measuring) before the stream opens; main.ts bounds it by the start limit
  // (the time logged is since the process started: the page and tldraw are evaluated by the static imports, before this)
  prepare: async (_c, log) => {
    const rt = await loadRuntime({ fontDir: bundledFontDir() });
    log(`board host ready: ${rt.dom}, ${rt.fonts} fonts, ${Math.round(performance.now())} ms`);
  },
  makeClient: (entry, clientId, log) => {
    let timing = {};
    try { timing = parseAppWaits(process.env.AIWB_APP_WAITS); } catch (e) { log(`AIWB_APP_WAITS is ignored: ${(e as Error).message}`); }
    return createClient({ connector: nodeConnector(), store: memStore(entry, clientId), local: null, timing, log });
  },
});

/** The bundle's copy of the font files (`dist/assets/fonts/`, beside the bundle), or undefined in development (then
 *  @tldraw/assets' `fonts/`). */
function bundledFontDir(): string | undefined {
  const dir = fileURLToPath(new URL("./assets/fonts/", import.meta.url));
  return existsSync(dir) ? dir : undefined;
}
