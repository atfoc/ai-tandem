// The board's two builds, from one esbuild configuration (AD-40, AD-51, AD-56). Usage:
//   node build.mjs web [--out <dir>]       `npm run build:web`: the web build's board. Default ../../app/public/board/ (git-ignored):
//                                          board.js, board.css, fonts/. `board.js` is an IIFE that defines
//                                          `window.aiwbBoardView = { mount(element, post, options) }` (src/web/entry.tsx);
//                                          Excalidraw takes its fonts from fonts/ next to wherever board.js was loaded from.
//   node build.mjs webview [--out <dir>]   `npm run build:webview`: the phone's board. Default dist-webview/ (not committed):
//                                          board.html, ONE file with the script, the style and the fonts inside it (the fonts as
//                                          data: URLs, a font shim swaps each FontFace address for them), and a Content-Security-
//                                          Policy that lets the page load and reach nothing: each inline script by its hash.
// The bench (dev/bench/README.md; never shipped): AIWB_BOARD_BENCH=1 bundles dev/bench/entry.tsx in place of the webview's entry
// (the shipped page, then the bench on top); AIWB_BOARD_BENCH_REPORT=<http url> lets the page POST its progress there (its origin
// becomes the CSP's connect-src); AIWB_BOARD_BENCH_AUTO=1 makes the page start the bench by itself;
// AIWB_BOARD_BENCH_MODES=<set or list> is what a run measures when it names no modes (default "all"; dev/bench/modeset.mjs). With none set, the output is the shipped one.
// Both: Excalidraw is the installed one (`conditions: production`), without the locales other than English and without Mermaid
// (KEEP_MERMAID=1 keeps it), and without Xiaolai (12 MB of Chinese fonts).
import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (target !== "web" && target !== "webview") {
  console.error("usage: node build.mjs <web|webview> [--out <dir>]");
  process.exit(2);
}
const at = process.argv.indexOf("--out");
const out = path.resolve(here, at >= 0 ? process.argv[at + 1] : target === "web" ? "../../app/public/board" : "dist-webview");

const bench = process.env.AIWB_BOARD_BENCH === "1" && target === "webview";
const benchReport = bench ? process.env.AIWB_BOARD_BENCH_REPORT ?? "" : "";
const benchModes = bench ? process.env.AIWB_BOARD_BENCH_MODES ?? "all" : "";
const benchOrigin = benchReport ? new URL(benchReport).origin : "";
if (benchReport && !/^https?:$/.test(new URL(benchReport).protocol)) throw new Error("AIWB_BOARD_BENCH_REPORT must be an http(s) url");

/** The root of an installed package (its exports hide package.json): up from where its entry resolves. */
function packageRoot(name) {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name));
  while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== name) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package root for ${name}`);
    dir = up;
  }
  return dir;
}
const excal = packageRoot("@excalidraw/excalidraw");
const version = JSON.parse(fs.readFileSync(path.join(excal, "package.json"), "utf8")).version;
const fontsDir = path.join(excal, "dist/prod/fonts");
/** The fonts of Excalidraw that are shipped: the folder of each family, but not Xiaolai. */
const families = () => fs.readdirSync(fontsDir).filter((d) => d !== "Xiaolai");

// Locales other than English are not shipped (the page is English); the dynamic import of one gets an empty module.
// Mermaid (the "Mermaid to Excalidraw" dialog of the text-to-diagram tool, 2.9 MB with what it pulls in) is left out
// too, unless KEEP_MERMAID=1: nothing of the board's tools uses it.
const slim = {
  name: "slim",
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

/** One configuration for both targets: only the entry and the output differ. */
function bundleOf(entry, more = {}) {
  return esbuild.build({
    entryPoints: [path.join(here, entry)], bundle: true, format: "iife", write: false, outdir: path.join(here, ".out"), entryNames: "board",
    conditions: ["production"], target: "safari16", minify: true, jsx: "automatic", logLevel: "warning", legalComments: "none",
    define: {
      "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"',
      __EXCALIDRAW_VERSION__: JSON.stringify(version), "import.meta.url": '"https://aiwb-assets.invalid/"',
      ...more,
    },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    plugins: [slim],
  }).then((r) => ({
    js: r.outputFiles.find((f) => f.path.endsWith(".js")).text,
    css: r.outputFiles.find((f) => f.path.endsWith(".css")).text,
  }));
}

/** Empties the output folder, but only a folder that is empty or holds an earlier output of this build. */
function clean(dir) {
  if (fs.existsSync(dir)) {
    const names = fs.readdirSync(dir);
    if (names.length && !names.some((n) => n === "board.js" || n === "board.html")) throw new Error(`${dir} is not empty and holds no earlier output of this build: not emptied`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

/** Script text that can sit in an inline <script>: HTML ends it at `</script` and goes strange after `<!--` followed by `<script`.
 *  Excalidraw has `<!--` in a string and a regular expression; `\x3C` is the same character in a string, a template and a
 *  regular expression. (A `<` that a backslash already escapes is not touched: the build stops.) */
function inlineSafe(text) {
  return text.replace(/(\\*)(<!--|<\/script)/gi, (all, slashes, what) => {
    if (slashes.length % 2) throw new Error(`"${what}" after a backslash in the script: cannot be made safe to inline`);
    return slashes + "\\x3C" + what.slice(1);
  });
}

const kb = (n) => (n / 1024).toFixed(0) + " KB";
const t0 = Date.now();

if (target === "web") {
  const { js, css } = await bundleOf("src/web/entry.tsx");
  clean(out);
  fs.writeFileSync(path.join(out, "board.js"), js);
  fs.writeFileSync(path.join(out, "board.css"), css);
  for (const d of families()) fs.cpSync(path.join(fontsDir, d), path.join(out, "fonts", d), { recursive: true });
  const fontBytes = fs.readdirSync(path.join(out, "fonts"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).reduce((n, e) => n + fs.statSync(path.join(e.parentPath, e.name)).size, 0);
  console.log(`board (web): excalidraw ${version}, ${Date.now() - t0} ms; board.js ${kb(Buffer.byteLength(js))}, board.css ${kb(Buffer.byteLength(css))}, fonts ${kb(fontBytes)} -> ${out}`);
} else {
  const bundle = bench
    ? await bundleOf("dev/bench/entry.tsx", { __AIWB_BENCH_REPORT__: JSON.stringify(benchReport), __AIWB_BENCH_AUTO__: process.env.AIWB_BOARD_BENCH_AUTO === "1" ? "true" : "false", __AIWB_BENCH_MODES__: JSON.stringify(benchModes) })
    : await bundleOf("src/webview/entry.tsx");
  const css = bundle.css;
  // Excalidraw's fonts (the canvas draws text with them) go into the page as data: URLs, by the name the font shim looks up.
  const fonts = {};
  for (const dir of families()) {
    for (const f of fs.readdirSync(path.join(fontsDir, dir))) fonts[`${dir}/${f}`] = "data:font/woff2;base64," + fs.readFileSync(path.join(fontsDir, dir, f)).toString("base64");
  }
  const shim = `window.__AIWB_FONTS=${JSON.stringify(fonts)};\n` + fs.readFileSync(path.join(here, "src/webview/fontshim.js"), "utf8");
  const js = inlineSafe(bundle.js), shimText = inlineSafe(shim);
  if (/<\/style|<!--/i.test(bundle.css)) throw new Error('the style holds "</style" or "<!--": it cannot be inlined');
  const hash = (s) => "'sha256-" + crypto.createHash("sha256").update(s).digest("base64") + "'";
  const csp = [
    "default-src 'none'", `script-src ${hash(shimText)} ${hash(js)}`, "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
    `connect-src ${benchOrigin || "'none'"}`, "worker-src blob:", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en" data-theme="light">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Board</title>
<style>${css}</style>
<div id="root"></div>
<script>${shimText}</script>
<script>${js}</script>
</html>
`;
  clean(out);
  fs.writeFileSync(path.join(out, "board.html"), html);
  if (bench) console.log("BENCH BUILD (not for shipping)");
  console.log(`board (webview): excalidraw ${version}, ${Date.now() - t0} ms; board.html ${kb(Buffer.byteLength(html))} (js ${kb(Buffer.byteLength(js))}, css ${kb(Buffer.byteLength(css))}, fonts ${kb(Buffer.byteLength(shimText))}) -> ${path.join(out, "board.html")}`);
}
