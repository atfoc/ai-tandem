// The window side of the faithfulness harness: the board view's own web target (`node ../board-view/build.mjs web`) in Chromium
// (Playwright), mounted as the app mounts it, and asked with the bridge's `req` messages, as the app's board side asks it. `warm` loads
// Excalidraw's faces for the given text first (document.fonts.load), as a window that has drawn such text has them; without it the
// page measures with whatever faces it loaded so far (a cold page, as a phone's hidden engine view). Playwright is no dependency of
// the repository: it is found as the other dev tools find it (see faithful.mjs).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

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

/** Serves the web build (`webDir`) and starts one Chromium (`playwright`: the module) with a page that has mounted the board.
 *  `newPage()` of the result gives a further, fresh page of the same browser (a cold one). */
export async function startChromium({ playwright, webDir, deviceScaleFactor = 1 }) {
  if (!fs.existsSync(path.join(webDir, "board.js"))) throw new Error(`no web build in ${webDir}`);
  const web = path.resolve(webDir);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(PAGE); }
    const f = path.join(web, decodeURIComponent(u.pathname));
    if (!f.startsWith(web) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end(); }
    const type = f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "access-control-allow-origin": "*" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await playwright.chromium.launch();
  const errors = [];
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => window.__ready);
    return {
      /** The reply (`res` message) to one request. */
      req: (op) => page.evaluate((op) => window.__req(op), op),
      /** Loads a board into the window (it is then "on screen": Excalidraw puts its faces in document.fonts). */
      load: (board, scene) => page.evaluate(([b, s]) => window.__load(b, s), [board, scene]),
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
      close: () => page.close(),
    };
  };
  return { version: browser.version(), errors, newPage: open, async close() { await browser.close(); server.close(); } };
}
