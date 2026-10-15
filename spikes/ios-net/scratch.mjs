// A scratch AI Whiteboard server for the spike, set up as web/e2e/lib/rig.mjs (class Scratch) does it: its own data folder, a free
// port, the stand-in-less flags. `node scratch.mjs start <dir>` builds nothing: it needs the binary at <dir>/ai-whiteboard (go build -o
// <dir>/ai-whiteboard ./cmd/ai-whiteboard) and prints one JSON line {port, fingerprint, secret, home, pid}; `node scratch.mjs stop <dir>`
// stops it with `stop -home`. Never touches ~/.ai-whiteboard or the user's server on 4748/6006.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { Scratch } = await import(path.join(repo, "web/e2e/lib/rig.mjs"));

const [cmd, dir] = process.argv.slice(2);
if (!dir || !["start", "stop"].includes(cmd)) { console.error("usage: scratch.mjs start|stop <dir>"); process.exit(2); }
const bin = path.join(path.resolve(dir), "ai-whiteboard");
const info = path.join(path.resolve(dir), "scratch.json");

if (cmd === "start") {
  const s = new Scratch({ out: path.resolve(dir), bin, agent: null, tag: "server", name: "spike" });
  await s.setUp();
  const launched = await s.launch();
  const out = { port: s.port, fingerprint: s.fingerprint, secret: s.secret, home: s.home, pid: launched.pid };
  fs.writeFileSync(info, JSON.stringify(out));
  console.log(JSON.stringify(out));
} else {
  const s = new Scratch({ out: path.resolve(dir), bin, agent: null, tag: "server", name: "spike" });
  await s.stop();
  fs.rmSync(info, { force: true });
}
process.exit(0);
