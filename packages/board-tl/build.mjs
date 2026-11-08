// The new board's web target (decision U2), one esbuild configuration: an IIFE that defines `window.aiwbTlView`.
//   node build.mjs                       (npm run build:web) → app/public/tl/tl.js + tl.css (git-ignored, like app/public/board/)
//   node build.mjs --dev-page [--out d]  (npm run dev-page)  → a standalone page, default packages/board-tl/dev-dist/
//                                         (git-ignored): index.html under the app's CSP (cspFor() of app/scripts/export-web.mjs,
//                                         imported), tl.js, tl.css, and page.js, which mounts an empty local board and exposes the editor as window.__tlEditor (the dev page only)
// Always a development build of tldraw (process.env.NODE_ENV "development", decisions and licence.md: a production file://
// page without a key goes blank after 5 s), minified anyway. The fonts are tldraw's 16 woff2 files of @tldraw/assets, named by
// src/model/fonts.ts, inlined as data: URLs (`@tldraw/assets/selfHosted` is swapped for a module that imports them), so no
// fonts/ folder is written and the window's image export keeps the font under connect-src 'none' (decision U4).
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cspFor } from "../../app/scripts/export-web.mjs";
import { FONT_FACES } from "./src/model/fonts.ts";
import { fontsDir } from "./src/model/fonts-node.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const devPage = process.argv.includes("--dev-page");
const at = process.argv.indexOf("--out");
const out = path.resolve(here, at >= 0 ? process.argv[at + 1] : devPage ? "dev-dist" : "../../app/public/tl");

const fonts = fontsDir();
const assetsDir = path.dirname(fonts);
const inlineFonts = {
  name: "inline-fonts",
  setup(b) {
    b.onResolve({ filter: /^@tldraw\/assets\/selfHosted$/ }, () => ({ path: "selfHosted-inline", namespace: "inline-fonts" }));
    b.onLoad({ filter: /.*/, namespace: "inline-fonts" }, () => {
      for (const f of FONT_FACES) if (!fs.existsSync(path.join(fonts, f.file))) throw new Error(`font file missing: ${f.file} in ${fonts}`);
      return {
        resolveDir: assetsDir,
        loader: "js",
        contents:
          `import { getAssetUrls as selfHosted } from "./selfHosted.js";\n` +
          FONT_FACES.map((f, i) => `import f${i} from "./fonts/${f.file}";`).join("\n") +
          `\nexport function getAssetUrls(o) { return { ...selfHosted(o), fonts: { ${FONT_FACES.map((f, i) => `${JSON.stringify(f.key)}: f${i}`).join(", ")} } }; }\n`,
      };
    });
  },
};

const t0 = Date.now();
const common = {
  bundle: true, format: "iife", write: false, target: "safari16", minify: true, jsx: "automatic", logLevel: "warning",
  legalComments: "none", sourcemap: false, define: { "process.env.NODE_ENV": JSON.stringify("development") },
};
const r = await esbuild.build({
  ...common, entryPoints: [path.join(here, "src/web/entry.tsx")], outdir: out, entryNames: "tl",
  loader: { ".woff2": "dataurl" }, plugins: [inlineFonts],
});
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of r.outputFiles) fs.writeFileSync(f.path, f.contents);
for (const f of ["tl.js", "tl.css"]) if (!fs.existsSync(path.join(out, f))) throw new Error(`${f} was not written`);

if (devPage) {
  const csp = cspFor();
  fs.writeFileSync(path.join(out, "index.html"), `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>board-tl dev page</title>
<style>html, body { height: 100%; margin: 0; overflow: hidden; } #board { position: fixed; inset: 0; }</style>
<link rel="stylesheet" href="./tl.css">
<script src="./tl.js"></script>
<div id="board"></div>
<script src="./page.js"></script>
</html>
`);
  fs.writeFileSync(path.join(out, "page.js"), `window.aiwbTlView.mount(document.getElementById("board"), {
  onMount: function (editor) { window.__tlEditor = editor; document.body.dataset.ready = "1"; },
});
`);
}
const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + " KB";
console.log(`board-tl web (development): ${Date.now() - t0} ms; tl.js ${kb("tl.js")}, tl.css ${kb("tl.css")} -> ${out}${devPage ? " (dev page)" : ""}`);
