// Builds the board into one self-contained file: board.html, with the script, the style and the fonts inside it.
// Usage: node build.mjs [outfile]   (default: ../assets/board.html, which the app takes as an asset)
// The Content-Security-Policy in its head lets the page load nothing from anywhere: its own inline script by hash,
// data: images and fonts, blob: for what Excalidraw makes, no network (connect-src 'none'), no frame, no form.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(here, "../assets/board.html"));
const excal = path.join(here, "node_modules/@excalidraw/excalidraw");
const version = JSON.parse(fs.readFileSync(path.join(excal, "package.json"), "utf8")).version;

// Locales other than English are not shipped (the page is English); the dynamic import of one gets an empty module.
// Mermaid (the "Mermaid to Excalidraw" dialog of the text-to-diagram tool, 2.9 MB with what it pulls in) is left out
// too, unless KEEP_MERMAID=1: nothing of the board's tools uses it.
const noLocales = {
  name: "no-locales",
  setup(b) {
    if (!process.env.KEEP_MERMAID) {
      b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (a) => ({ path: a.path, namespace: "no-mermaid" }));
      b.onLoad({ filter: /.*/, namespace: "no-mermaid" }, () => ({
        contents: "export const parseMermaidToExcalidraw = async () => { throw new Error('mermaid is not in this build'); }; export default {};", loader: "js",
      }));
    }
    b.onResolve({ filter: /^\.\/locales\// }, (a) => (/\/en-/.test(a.path) ? undefined : { path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [path.join(here, "src/entry.tsx")], bundle: true, format: "iife", write: false, outdir: path.join(here, ".out"),
  conditions: ["production"], target: "safari16", minify: true, jsx: "automatic", logLevel: "warning",
  alias: { "@aiwb/core": path.resolve(here, "../../../packages/core/src") }, // the page's own files import the shared core by this name
  nodePaths: [path.join(here, "node_modules")], // the page's own files (web/src) have no node_modules here
  define: {
    "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"',
    __EXCALIDRAW_VERSION__: JSON.stringify(version), "import.meta.url": '"https://aiwb-assets.invalid/"',
  },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  plugins: [noLocales], legalComments: "none",
});
const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = r.outputFiles.find((f) => f.path.endsWith(".css")).text;

// Excalidraw's fonts (the canvas draws text with them), but not Xiaolai (12 MB of Chinese): the page's build drops it too.
const fontsDir = path.join(excal, "dist/prod/fonts");
const fonts = {};
for (const dir of fs.readdirSync(fontsDir)) {
  if (dir === "Xiaolai") continue;
  for (const f of fs.readdirSync(path.join(fontsDir, dir))) fonts[`${dir}/${f}`] = "data:font/woff2;base64," + fs.readFileSync(path.join(fontsDir, dir, f)).toString("base64");
}
const shim = `window.__AIWB_FONTS=${JSON.stringify(fonts)};\n` + fs.readFileSync(path.join(here, "src/fontshim.js"), "utf8");

const hash = (s) => "'sha256-" + crypto.createHash("sha256").update(s).digest("base64") + "'";
const csp = [
  "default-src 'none'", `script-src ${hash(shim)} ${hash(js)}`, "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
  "connect-src 'none'", "worker-src blob:", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
].join("; ");
const html = `<!doctype html>
<html lang="en" data-theme="light">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Board</title>
<style>${css}</style>
<div id="root"></div>
<script>${shim}</script>
<script>${js}</script>
</html>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(JSON.stringify({
  out, excalidraw: version, buildMs: Date.now() - t0,
  bytes: { html: Buffer.byteLength(html), js: Buffer.byteLength(js), css: Buffer.byteLength(css), fonts: Buffer.byteLength(shim) },
}));
console.log(`board.html ${kb(Buffer.byteLength(html))}: js ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))}, fonts ${kb(Buffer.byteLength(shim))}`);
