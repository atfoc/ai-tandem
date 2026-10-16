// The window side of the faithfulness harness: the board view's own web target (packages/board-view, `node build.mjs web`) in
// Chromium (Playwright), mounted as the app mounts it, and asked with the bridge's `req` messages, as the app's board side asks
// it. `warm` loads Excalidraw's faces for the given text first (document.fonts.load), as a window that has drawn such text has
// them; without it the page measures with whatever faces it loaded so far.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = process.env.AIWB_WEB_DIR ? path.resolve(process.env.AIWB_WEB_DIR) : path.join(here, "../out/web");

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="board.css">
<div id="root" style="width:1200px;height:800px"></div>
<script src="board.js"></script>
<script>
  let seq = 0; const waiting = new Map(); let ready; window.__ready = new Promise((r) => (ready = r));
  const loaded = new Map();
  const v = aiwbBoardView.mount(document.getElementById("root"), (m) => {
    if (m.t === "ready") ready();
    if (m.t === "loaded") loaded.get(m.board)?.();
    if (m.t === "res") { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  window.__req = (op) => new Promise((r) => { const id = ++seq; waiting.set(id, r); v.receive({ t: "req", id, op }); });
  window.__load = (board, scene) => new Promise((r) => { loaded.set(board, r); v.receive({ t: "load", board, scene, viewMode: false, theme: { mode: "light", filter: null }, style: {} }); });
  window.__send = (m) => v.receive(m);
</script>`;

export async function startChromium({ deviceScaleFactor = 1 } = {}) {
  if (!fs.existsSync(path.join(WEB, "board.js"))) throw new Error("no web build: cd packages/board-view && node build.mjs web --out ../../spikes/headless-engine/out/web");
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    const f = path.join(WEB, decodeURIComponent(u.pathname));
    if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.__ready);
  return {
    version: browser.version(),
    errors,
    req: (op) => page.evaluate((op) => window.__req(op), op),
    load: (board, scene) => page.evaluate(([b, s]) => window.__load(b, s), [board, scene]),
    send: (m) => page.evaluate((m) => window.__send(m), m),
    /** Loads, for every font string, the faces the text needs; answers the faces now in document.fonts that are loaded. */
    warm: (fonts, text) => page.evaluate(async ([fonts, text]) => {
      for (const f of fonts) { for (const fam of f.replace(/^\S+\s+/, "").split(/,\s*/)) { try { await document.fonts.load(`20px "${fam}"`, text); } catch { /* a face that is not shipped (Xiaolai) fails */ } } }
      let n = 0; document.fonts.forEach((f) => { if (f.status === "loaded") n++; }); return n;
    }, [fonts, text]),
    /** What the page's canvas measures for each text in each font string (after warm). */
    measure: (fonts, texts) => page.evaluate(([fonts, texts]) => {
      const c = document.createElement("canvas").getContext("2d");
      return fonts.map((f) => { c.font = f; return texts.map((t) => c.measureText(t).width); });
    }, [fonts, texts]),
    facesInDocument: () => page.evaluate(() => { const out = []; document.fonts.forEach((f) => out.push([f.family, f.status, f.unicodeRange.slice(0, 30)])); return out; }),
    page,
    async close() { await browser.close(); server.close(); },
  };
}
