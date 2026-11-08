// The entry of the board host's bundle (`dist/boardhost.mjs`, built by H4): the process as the server starts it, with the real
// connection module. The tests drive `run` (main.ts) with fakes; this is the only file that makes the real client.
import { createClient, parseAppWaits } from "@aiwb/conn";
import { nodeConnector } from "@aiwb/conn/node";
import { memStore } from "@aiwb/headless/src/memstore.ts";
import { run } from "./main.ts";

process.on("unhandledRejection", (e) => { process.stderr.write(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}\n`); });

await run({
  stdin: process.stdin,
  stderr: (line) => { process.stderr.write(`${line}\n`); },
  exit: (code) => { process.exitCode = code; setImmediate(() => process.exit(code)); },
  env: process.env,
  signals: process,
  captureConsole: true,
  makeClient: (entry, clientId, log) => {
    let timing = {};
    try { timing = parseAppWaits(process.env.AIWB_APP_WAITS); } catch (e) { log(`AIWB_APP_WAITS is ignored: ${(e as Error).message}`); }
    return createClient({ connector: nodeConnector(), store: memStore(entry, clientId), local: null, timing, log });
  },
});
