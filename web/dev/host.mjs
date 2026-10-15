// The test host (plans/app-as-client-plan.md, C5.2): what the app's main process is to the page, for tests and for an
// agent that checks a change to the page in a headless browser. It holds the server list and the secrets, makes the
// pinned HTTPS connections (the module the app uses, packages/conn) and serves the page's files, its calls, its stream
// and its pictures over plain HTTP, through the face it shares with the mock (dev/hostface.mjs). It is no part of a
// shipped build and no server serves it: it listens on 127.0.0.1 alone, on a port it picks, and is started by a test.
//
//   node web/dev/host.mjs --state-dir DIR [--local-bin PATH --local-home DIR] [--dist DIR] [--port N]
//
//   --state-dir   holds servers.json and client-id, the app's files (made when missing)
//   --local-bin   the server program; with it this computer's server is found or started, as the app does it
//   --local-home  its data folder (--local-bin only; default: the program's own default folder)
//   --dist        the built page (default app/dist-web, the app's web build: the page needs `connect-src 'self'` in its CSP to reach this
//                 host, see app/scripts/export-web.mjs --connect-self); --port: default a free one
//
// The first line it prints is `Host: http://127.0.0.1:<port>/`. AIWB_APP_WAITS lowers the module's waits as in the app.
// The page is in its HTTP way when it is loaded from this address (it has no window.aiwbTransport); nothing is put into it.
// The owner's things that need the app's own shell (open the log, reveal a board's file) answer 501 here.
//
// startHost(options) does the same for a script: { stateDir, localBin, localHome, dist, port, env, timing, log, dial } →
// { url, port, client, face, close() }. env: the environment of the server program it runs; timing: the module's waits
// (parseAppWaits("backoff=3s") reads the syntax of AIWB_APP_WAITS; it is exported from here); dial: the module's test
// seam for net.connect, with which a script puts a link of its own between the host and a server. close() ends the
// connections and the listener; it stops no server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHostFace } from "./hostface.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createNodeClient: createClient, parseAppWaits } = require("../../packages/conn/node");

export { parseAppWaits };

/** Starts a host and answers once it listens. log(line): one line of what went wrong (never a secret). */
export async function startHost({ stateDir, localBin, localHome, dist = path.join(HERE, "../../app/dist-web"), port = 0, env, timing, dial, log = (line) => console.error(line) } = {}) {
  if (!stateDir) throw new Error("the host needs a state folder");
  if (localHome && !localBin) throw new Error("--local-home needs --local-bin");
  const client = createClient({
    stateDir,
    local: localBin ? { bin: path.resolve(localBin), home: localHome ? path.resolve(localHome) : null, env: env ?? process.env } : null,
    timing: timing ?? parseAppWaits(process.env.AIWB_APP_WAITS),
    log,
    dial,
  });
  const face = createHostFace({ client, distDir: path.resolve(dist), log });
  const server = http.createServer(face.handle);
  try {
    await new Promise((ok, no) => { server.once("error", no); server.listen(port, "127.0.0.1", ok); });
  } catch (e) { await client.close(); throw e; }
  const at = server.address().port;
  return {
    url: `http://127.0.0.1:${at}/`, port: at, client, face,
    async close() {
      face.close();
      server.closeAllConnections?.();
      await new Promise((ok) => server.close(ok));
      await client.close();
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const a = process.argv.slice(2), o = {};
  const names = { "--state-dir": "stateDir", "--local-bin": "localBin", "--local-home": "localHome", "--dist": "dist", "--port": "port" };
  for (let i = 0; i < a.length; i += 2) {
    const k = names[a[i]];
    if (!k || a[i + 1] === undefined) { console.error(`host: ${a[i]} is not an option\nusage: node host.mjs --state-dir DIR [--local-bin PATH --local-home DIR] [--dist DIR] [--port N]`); process.exit(2); }
    o[k] = k === "port" ? Number(a[i + 1]) : a[i + 1];
  }
  if (!o.stateDir) { console.error("host: --state-dir is required"); process.exit(2); }
  if (o.dist && !fs.existsSync(path.join(o.dist, "index.html"))) { console.error(`host: ${o.dist} holds no built page (cd app && npm run build:web)`); process.exit(2); }
  let host;
  try { host = await startHost(o); } catch (e) { console.error(`host: ${e.message}`); process.exit(1); }
  console.log(`Host: ${host.url}`);
  let ending = false;
  const end = async () => { if (ending) return; ending = true; await host.close().catch(() => {}); process.exit(0); };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, end);
}
