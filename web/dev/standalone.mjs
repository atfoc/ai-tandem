// Runs one check of web/dev/checks/ by itself, on the gallery (`/?gallery`) of the app's web build: the way a check
// there is run before, or without, the runner of `npm run uicheck` (web/dev/uicheck.mjs). The check exports
// `viewports` and `body({page, viewport, layout, fail, url})`; this builds the app's web build (or takes DIST), serves it,
// opens a page per viewport (the devices of AD-80, in Chromium) and runs the body in each.
//
//   node web/dev/checks/L4-chips.mjs                      from the repository root
//   DIST=/tmp/x/dist node …                                   a web build made before:
//                                                             (cd app && node scripts/export-web.mjs --output-dir /tmp/x/dist)
//   PORT=4810 …                                               the port the build is served on (default: a free one)
//   VIEWPORT=tablet …                                         one viewport only
// A check calls `await standalone(import.meta.url, "L4-chips", viewports, body)` at its end; the call does nothing when the
// file is only imported (by a runner).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPlaywright, onEnd } from "./shot.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app");
const LAYOUT = { desktop: "desktop", tablet: "tablet", phone: "phone" };

/** The options of the browser context for a viewport (AD-80, in Chromium). */
export function contextOptions(playwright, viewport) {
  if (viewport === "desktop") return { viewport: { width: 1280, height: 800 } };
  const { defaultBrowserType, ...device } = playwright.devices[viewport === "tablet" ? "iPad Pro 11" : "iPhone 15"];
  return device;
}

function serve(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split("?")[0]));
    const real = file.startsWith(root) && fs.existsSync(file) && !fs.statSync(file).isDirectory() ? file : path.join(root, "index.html");
    res.setHeader("content-type", types[path.extname(real)] ?? "application/octet-stream");
    res.end(fs.readFileSync(real));
  });
  return new Promise((ok) => server.listen(Number(process.env.PORT) || 0, "127.0.0.1", () => ok(server)));
}

/** Runs `body` at each viewport when `meta` (the check's import.meta.url) is the file being run. */
export async function standalone(meta, id, viewports, body) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(meta)) return;
  let dist = process.env.DIST, built = "";
  if (!dist) {
    dist = built = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "aiwb-app-dist-"));
    try { execFileSync(process.execPath, ["scripts/export-web.mjs", "--output-dir", dist], { cwd: APP, stdio: "pipe" }); }
    catch (e) { console.error(`FAIL ${id}: the web build failed:\n` + (e.stderr?.toString() || e.message)); process.exit(1); }
  }
  const server = await serve(path.resolve(dist));
  const unbuild = () => { if (built) fs.rmSync(built, { recursive: true, force: true }); };
  const off = onEnd(async () => { server.close(); unbuild(); });
  const url = `http://127.0.0.1:${server.address().port}/?gallery`;
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch();
  const failures = [];
  try {
    for (const viewport of process.env.VIEWPORT ? [process.env.VIEWPORT] : viewports) {
      const ctx = await browser.newContext(contextOptions(playwright, viewport));
      const page = await ctx.newPage();
      const fail = (line) => { failures.push(line); };
      page.on("pageerror", (e) => fail(`${viewport}: page error: ${e.message}`));
      page.on("console", (m) => { if (m.type() === "error") fail(`${viewport}: console error: ${m.text()}`); });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="gallery"]', { timeout: 30000 });
        await body({ page, viewport, layout: LAYOUT[viewport], fail, url });
      } catch (e) { fail(`${viewport}: ${e.message.split("\n")[0]}`); }
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); off(); unbuild(); }
  for (const f of failures) console.log(`FAIL ${id}: ${f}`);
  if (failures.length) process.exit(1);
  console.log(`ok ${id}`);
}
