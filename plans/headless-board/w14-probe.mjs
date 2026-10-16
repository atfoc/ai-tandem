// W14 probe: the built app's server binary, a scratch home, PATH without node, one away call through the fake claude.
import { execFileSync, spawnSync } from "node:child_process";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [, , APP, RUN, FAKE, NODE] = process.argv; // app bundle, scratch folder, fake-claude source, absolute node (for the stand-in's shebang only)
const bin = path.join(APP, "Contents/MacOS/ai-whiteboard");
const home = path.join(RUN, "home"), work = path.join(RUN, "work");
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(work, { recursive: true });
const agent = path.join(RUN, "fake-claude");
fs.writeFileSync(agent, fs.readFileSync(FAKE, "utf8").replace("#!/usr/bin/env node", `#!${NODE}`), { mode: 0o755 });
const env = { HOME: process.env.HOME, PATH: "/usr/bin:/bin", SHELL: "/usr/bin/false", /* launch prepends the PATH that $SHELL -ilc prints (usePath in cmd/ai-whiteboard/launch.go); a shell that prints nothing leaves PATH as given */ AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", CURSOR_CONFIG_DIR: path.join(RUN, "cursor") };
const sh = (cmd) => spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" }).stdout;
const run = (args) => execFileSync(bin, args, { env, encoding: "utf8" });
const log = (...a) => console.log(...a);
const apps = () => sh("lsappinfo list | grep -E '^ *[0-9]+\\)' | sed -E 's/^ *[0-9]+\\) \"([^\"]*)\".*/\\1/' | sort").trim().split("\n").filter(Boolean);
const gui = () => sh(`osascript -e 'tell application "System Events" to get name of every process whose background only is false'`).trim();
const seenApps = new Set(), seenGui = new Set();

log("== before: GUI apps (System Events)");
const guiBefore = sh(`osascript -e 'tell application "System Events" to get name of every process whose background only is false'`).trim();
log(guiBefore);
const appsBefore = apps(); log("lsappinfo before:", appsBefore.length, "entries; AI Whiteboard present:", appsBefore.includes("AI Whiteboard"));
log("node on that PATH:", sh("PATH=/usr/bin:/bin command -v node").trim() || "(none)");

const port = 20000 + Math.floor(Math.random() * 20000);
const setup = run(["remote", "setup", "-home", home, "-port", String(port), "-name", "127.0.0.1"]);
const fpr = /^Fingerprint:\s*(\S+)/m.exec(setup)[1];
const secret = fs.readFileSync(path.join(home, "remote-secret"), "utf8").trim();
const out = run(["launch", "-json", "-home", home, "-cwd", work, "-claude", agent, "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"]);
const info = JSON.parse(out.trim().split("\n").pop());
log("== launched", JSON.stringify({ pid: info.pid, port }));
const CLIENT = "5f0c2a7e-3b1d-4c6a-9e2f-7a8b9c0d1e2f";
function call(method, p, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ host: "127.0.0.1", port, path: p, method, rejectUnauthorized: false, checkServerIdentity: (h, c) => {
      const got = crypto.createHash("sha256").update(c.raw).digest("hex");
      if (got !== fpr.replace(/[^0-9a-fA-F]/g, "").toLowerCase()) return new Error("fingerprint mismatch");
    }, headers: { "X-AIWB-Secret": secret, "X-AIWB-Client": CLIENT, "X-AIWB-Level": "7", ...(data ? { "Content-Type": "application/json" } : {}) } }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => r.statusCode === 200 ? res(JSON.parse(b || "null")) : rej(new Error(`${method} ${p}: ${r.statusCode} ${b}`)));
    });
    req.on("error", rej); if (data) req.write(data); req.end();
  });
}
try {
  log("== status before the call:", JSON.stringify(JSON.parse(run(["status", "-json", "-home", home])).running?.headless));
  const mk = await call("POST", "/api/boards", { name: "away", group: "__ungrouped__" }); const b = mk.ID ?? mk.id;
  const mc = await call("POST", "/api/chats", { agent: "claude", board: b }); const chat = mc.ID ?? mc.id;
  await call("PATCH", `/api/chats/${chat}`, { cwd: work });
  const text = `go [[mcp read_board {}]] [[mcp apply {"create":[{"type":"rectangle","key":"w14","x":100,"y":100,"width":240,"height":120,"label":"W14 probe","backgroundColor":"#a5d8ff","fillStyle":"solid"}]}]] [[mcp get_image {}]]`;
  await call("POST", `/api/chats/${chat}/messages`, { text });
  let items = [];
  const t0 = Date.now();
  let midGui = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 150));
    for (const a of apps()) seenApps.add(a); for (const g of gui().split(", ")) seenGui.add(g);
    const it = await call("GET", `/api/chats/${chat}/items`); items = (it.Items ?? it.items).map((i) => ({ Kind: i.Kind ?? i.kind, Text: i.Text ?? i.text ?? "" }));
    if (items.some((i) => i.Kind === "end")) break;
    if (Date.now() - t0 > 90000) throw new Error("turn did not end");
  }
  log(`== the turn ended after ${Date.now() - t0} ms`);
  const reply = items.map((i) => i.Text).join("\n");
  fs.writeFileSync(path.join(RUN, "reply.txt"), reply);
  log("== reply (first 1500 chars, base64 cut):\n" + reply.replace(/[A-Za-z0-9+/=]{200,}/g, (m) => `<${m.length} base64 chars>`).slice(0, 1500));
  // the PNG
  log("== status after the call:", JSON.stringify(JSON.parse(run(["status", "-json", "-home", home])).running?.headless));
  log("== processes:\n" + sh(`ps -axo pid,ppid,pgid,command | grep -E "${RUN}|hb-w14/bin" | grep -v grep | grep -v probe.mjs | cut -c1-260`));
  const hp = String((JSON.parse(run(["status", "-json", "-home", home])).running?.headless ?? {}).pid || "");
  if (hp) {
    const wp = sh(`ps eww -p ${hp} | tr ' ' '\\n' | grep -E '^PATH='`).trim().slice(5);
    log("== writer's command line:\n" + sh(`ps -o pid,ppid,command -p ${hp}`));
    log("== env of the writer (only the two keys):\n" + sh(`ps eww -p ${hp} | tr ' ' '\\n' | grep -E '^(ELECTRON_RUN_AS_NODE)='`) + "PATH of the writer = the server's: " + sh(`ps eww -p ${hp} | tr ' ' '\\n' | grep -E '^PATH=' `).trim());
    log("== native canvas mapped into the writer:\n" + sh(`lsof -p ${hp} 2>/dev/null | grep -E 'skia|node_modules' | awk '{print $NF}'`));
    log("== writer's process info:\n" + sh(`ps -o pid,stat,comm -p ${hp}`));
  }
  // the image: the fake claude drops image parts, so ask the chat's MCP endpoint directly (same endpoint, same away route)
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "chats", chat, "mcp.json"), "utf8")).mcpServers.board;
  const r = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "application/json", ...cfg.headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_image", arguments: {} } }) });
  const body = await r.json();
  const parts = body.result?.content ?? [];
  log("== direct get_image: parts", JSON.stringify(parts.map((p) => ({ type: p.type, mime: p.mimeType, text: p.text, bytes: p.data?.length }))));
  const img = parts.find((p) => p.type === "image");
  if (img) { const png = Buffer.from(img.data, "base64"); fs.writeFileSync(path.join(RUN, "image.png"), png); log("== PNG:", png.length, "bytes, signature", png.subarray(0, 8).toString("hex"), "size", png.readUInt32BE(16) + "x" + png.readUInt32BE(20)); }
  for (const a of apps()) seenApps.add(a); for (const g of gui().split(", ")) seenGui.add(g);
  const newApps = [...seenApps].filter((a) => !appsBefore.includes(a));
  log("== GUI apps (System Events) before:", guiBefore, "| seen at any time during/after the call:", [...seenGui].join(", "));
  log("== lsappinfo names that were not there before (sampled every 150 ms during the call and after):", JSON.stringify(newApps));
  log("== lsappinfo 'AI Whiteboard' entries now:", JSON.stringify(sh("lsappinfo list | grep -i 'AI Whiteboard'").trim()));
  log("== server log lines about headless:\n" + sh(`grep -i 'headless' ${JSON.stringify(path.join(home, "server.log"))} | head -30`));
} finally {
  try { log("== stop:", run(["stop", "-home", home]).trim()); } catch (e) { log("stop failed", e.message); }
  try { process.kill(info.pid, "SIGKILL"); } catch {}
}
log("== after stop: GUI apps\n" + sh(`osascript -e 'tell application "System Events" to get name of every process whose background only is false'`).trim());
log("== leftover writer processes:", sh("pgrep -fl headless.mjs").trim() || "(none)");
