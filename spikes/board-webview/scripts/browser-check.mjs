// The page, bridge and all, in a desktop browser: the board is loaded from file://, driven by the same typed messages
// and answered the same way as in the app, only the transport differs (window.__aiwb.receive / window.__aiwb.out in place
// of the web view's postMessage). It shows that the bundle works and that the one bridge drives Excalidraw directly in a
// page (the web build). Needs Playwright: AIWB_PLAYWRIGHT=<path to playwright-core's index.js> or `playwright` installed.
// Usage: node scripts/browser-check.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { createRequire } from "node:module";
import { request, parseFromBoard } from "../bridge/protocol.ts";
import { smallScene, largeScene } from "../app/scenes.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(here, "../assets/board.html");
const pw = process.env.AIWB_PLAYWRIGHT ? createRequire(import.meta.url)(process.env.AIWB_PLAYWRIGHT) : createRequire(import.meta.url)("playwright");
const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
await page.goto(pathToFileURL(html).href);
await page.waitForFunction(() => window.__aiwb?.out?.length > 0, null, { timeout: 30000 });

let n = 0;
const sent = [];
async function call(type, params = {}, timeout = 30000) {
  const id = `r${++n}`;
  const msg = JSON.stringify(request(id, type, params));
  await page.evaluate((m) => window.__aiwb.receive(m), msg);
  await page.waitForFunction((id) => window.__aiwb.out.some((s) => JSON.parse(s).id === id), id, { timeout });
  const all = await page.evaluate(() => window.__aiwb.out);
  const reply = all.map((s) => parseFromBoard(s)).find((p) => p.ok && p.value.kind === "reply" && p.value.id === id);
  if (!reply.value.ok) throw new Error(`${type}: ${reply.value.error.code}: ${reply.value.error.message}`);
  return reply.value.result;
}
const events = async (type) => (await page.evaluate(() => window.__aiwb.out)).map((s) => parseFromBoard(s)).filter((p) => p.ok && p.value.kind === "event" && p.value.type === type).map((p) => p.value);

const ready = (await events("ready"))[0];
const results = { ready: { protocol: ready.protocol, excalidraw: ready.excalidraw, loadMs: ready.loadMs } };
results.loadSmall = await call("loadScene", { scene: smallScene() });
results.apply = await call("applyChange", { change: { create: [{ type: "rectangle", key: "c", x: 100, y: 300, width: 160, height: 80, label: { text: "Added" } }, { type: "arrow", start: { key: "a" }, end: { key: "c" } }], update: [{ ref: { key: "b" }, backgroundColor: "#a5d8ff" }], delete: [{ ref: { key: "a" } }], select: [{ key: "c" }] } });
await page.waitForTimeout(800);
results.sceneChangedEvents = (await events("sceneChanged")).map((e) => ({ version: e.version, flushed: e.flushed, elements: e.elements }));
results.selection = (await events("selection")).at(-1);
results.png = await call("exportPng", { scale: 1 });
fs.writeFileSync("/tmp/aiwb-board-check.png", Buffer.from(results.png.base64, "base64"));
results.png.base64 = `${results.png.base64.length} chars`;
for (const t of ["dark", "mocha", "latte", "light"]) results[`theme ${t}`] = await call("setTheme", { theme: t });
results.badRequest = await page.evaluate(() => { window.__aiwb.receive(JSON.stringify({ v: 1, kind: "request", id: "x", type: "eval", code: "1" })); return window.__aiwb.out.map((s) => JSON.parse(s)).filter((m) => m.id === "x"); });
results.large = await call("loadScene", { scene: largeScene(2000) }, 120000);
results.flush = await call("flush");
results.violations = consoleLines.filter((l) => /blocked|Content Security/i.test(l));
results.console = consoleLines.slice(0, 15);
console.log(JSON.stringify(results, null, 1));
await browser.close();
