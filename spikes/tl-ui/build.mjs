// The spike's web target, built like board-view's `build:web` (one esbuild configuration, an IIFE that defines a global).
//   node build.mjs [--dev] [--out <dir>]     default out: dist/ (git-ignored)
//   node build.mjs --onefile [--dev] [--out <dir>]   the phone's shape (as board-view's `webview`): one board-tl.html with
//                                            the script and the style inline (the script allowed by its hash in the CSP)
//                                            and tldraw's fonts as data: URLs; nothing else is written (spike-ui-embed.md)
// Writes board-tl.js, board-tl.css, fonts/ (tldraw's own woff2, from @tldraw/assets), and a spike page index.html + page.js
// under the CSP the app's web build ships (cspFor() of app/scripts/export-web.mjs, imported, not copied), so what loads
// here loads in the app's page. --dev bundles tldraw with NODE_ENV=development (see spike-ui.md, "Licence").
import * as esbuild from "esbuild";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cspFor } from "../../app/scripts/export-web.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const at = process.argv.indexOf("--out");
const out = path.resolve(here, at >= 0 ? process.argv[at + 1] : "dist");
const connectSelf = process.argv.includes("--connect-self");
const onefile = process.argv.includes("--onefile");

// --onefile: `@tldraw/assets/selfHosted` (read by src/assets.ts) is swapped for a module whose fonts are the woff2 files
// themselves, bundled as data: URLs (loader dataurl); its other URLs (icons, embed icons, translations) are the self-hosted
// ones, which src/assets.ts blanks anyway.
const assetsDir = path.join(here, "node_modules/@tldraw/assets");
const inlineFonts = {
  name: "inline-fonts",
  setup(b) {
    b.onResolve({ filter: /^@tldraw\/assets\/selfHosted$/ }, () => ({ path: "selfHosted-inline", namespace: "inline-fonts" }));
    b.onLoad({ filter: /.*/, namespace: "inline-fonts" }, () => {
      const src = fs.readFileSync(path.join(assetsDir, "selfHosted.js"), "utf8");
      const pairs = [...src.matchAll(/(\w+): formatAssetUrl\(\s*'\.\/fonts\/([^']+)'/g)].map((m) => [m[1], m[2]]);
      if (pairs.length !== 16) throw new Error(`expected tldraw's 16 fonts in selfHosted.js, found ${pairs.length}`);
      return {
        resolveDir: assetsDir, loader: "js",
        contents: `import { getAssetUrls as selfHosted } from "./selfHosted.js";\n` +
          pairs.map(([, f], i) => `import f${i} from "./fonts/${f}";`).join("\n") +
          `\nexport function getAssetUrls(o) { return { ...selfHosted(o), fonts: { ${pairs.map(([k], i) => `${k}: f${i}`).join(", ")} } }; }\n`,
      };
    });
  },
};

const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [path.join(here, "src/entry.tsx")], bundle: true, format: "iife", write: false, outdir: out, entryNames: "board-tl",
  target: "safari16", minify: !dev, jsx: "automatic", logLevel: "warning", legalComments: "none", sourcemap: false,
  define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
  loader: { ".woff2": onefile ? "dataurl" : "file" },
  plugins: onefile ? [inlineFonts] : [],
});
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
if (onefile) {
  const text = (ext) => new TextDecoder().decode(r.outputFiles.find((f) => f.path.endsWith(ext)).contents);
  const page = `window.aiwbBoardTl.mount(document.getElementById("board"), { seed: !location.search.includes("empty") });`;
  const js = text(".js").replace(/<\/(script)/gi, "<\\/$1") + "\n" + page;
  const css = text(".css");
  if (/<\/style|<!--/i.test(css)) throw new Error('the style holds "</style" or "<!--": it cannot be inlined');
  const hash = (t) => "'sha256-" + crypto.createHash("sha256").update(t).digest("base64") + "'";
  // board-view's webview CSP, less worker-src (tldraw starts no worker)
  const csp = [
    "default-src 'none'", `script-src ${hash(js)}`, "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
    "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'",
  ].join("; ");
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>tl-ui spike (one file)</title>
<style>html, body { height: 100%; margin: 0; overflow: hidden; } #board { position: fixed; inset: 0; }</style>
<style>${css}</style>
<div id="board"></div>
<script>${js}</script>
</html>
`;
  fs.writeFileSync(path.join(out, "board-tl.html"), html);
  console.log(`tl-ui one file (${dev ? "development" : "production"}): ${Date.now() - t0} ms; board-tl.html ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB (js ${(Buffer.byteLength(js) / 1024).toFixed(0)} KB, css ${(Buffer.byteLength(css) / 1024).toFixed(0)} KB) -> ${out}\nCSP: ${csp}`);
  process.exit(0);
}
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
