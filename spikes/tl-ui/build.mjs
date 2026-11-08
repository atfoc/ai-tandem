// The spike's web target, built like board-view's `build:web` (one esbuild configuration, an IIFE that defines a global).
//   node build.mjs [--dev] [--out <dir>]     default out: dist/ (git-ignored)
// Writes board-tl.js, board-tl.css, fonts/ (tldraw's own woff2, from @tldraw/assets), and a spike page index.html + page.js
// under the CSP the app's web build ships (cspFor() of app/scripts/export-web.mjs, imported, not copied), so what loads
// here loads in the app's page. --dev bundles tldraw with NODE_ENV=development (see spike-ui.md, "Licence").
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cspFor } from "../../app/scripts/export-web.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const at = process.argv.indexOf("--out");
const out = path.resolve(here, at >= 0 ? process.argv[at + 1] : "dist");
const connectSelf = process.argv.includes("--connect-self");

const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [path.join(here, "src/entry.tsx")], bundle: true, format: "iife", write: false, outdir: out, entryNames: "board-tl",
  target: "safari16", minify: !dev, jsx: "automatic", logLevel: "warning", legalComments: "none", sourcemap: false,
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  loader: { ".woff2": "file" },
});
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of r.outputFiles) fs.writeFileSync(f.path, f.contents);
fs.cpSync(path.join(here, "node_modules/@tldraw/assets/fonts"), path.join(out, "fonts"), { recursive: true });
const csp = cspFor({ connectSelf });
fs.writeFileSync(path.join(out, "index.html"), `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tl-ui spike</title>
<style>html, body { height: 100%; margin: 0; overflow: hidden; } #board { position: fixed; inset: 0; }</style>
<link rel="stylesheet" href="./board-tl.css">
<script src="./board-tl.js"></script>
<div id="board"></div>
<script src="./page.js"></script>
</html>
`);
fs.writeFileSync(path.join(out, "page.js"), `window.aiwbBoardTl.mount(document.getElementById("board"), { seed: !location.search.includes("empty") });\n`);
const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + " KB";
console.log(`tl-ui (${dev ? "development" : "production"}): ${Date.now() - t0} ms; board-tl.js ${kb("board-tl.js")}, board-tl.css ${kb("board-tl.css")} -> ${out}\nCSP: ${csp}`);
