// The board view's web target (packages/board-view/build.mjs, `web`) built again with AIWB_APPLY_VARIANT swapped in, into
// out/web-variant (the harness's Chromium side takes it with AIWB_WEB_DIR). Same entry, defines, loaders and plugins.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const bv = path.resolve(here, "../../packages/board-view");
const excal = path.resolve(here, "../../node_modules/@excalidraw/excalidraw");
const version = JSON.parse(fs.readFileSync(path.join(excal, "package.json"), "utf8")).version;
const variant = process.env.AIWB_APPLY_VARIANT;
if (!variant) throw new Error("AIWB_APPLY_VARIANT names a file of variants/");
const out = path.join(here, "out/web-variant");
const plugins = [
  { name: "apply-variant", setup(b) {
    b.onResolve({ filter: /(^|\/)apply\.ts$/ }, (a) => (a.importer.includes("/variants/apply") ? undefined : { path: path.join(here, "variants", variant) }));
    // AIWB_WEB_FACES=1: the endpoint and fonts.ts of work package E2 (variants/endpoint-faces.ts, fonts-record.ts)
    if (process.env.AIWB_WEB_FACES === "1") {
      b.onResolve({ filter: /(^|\/)endpoint\.ts$/ }, () => ({ path: path.join(here, "variants/endpoint-faces.ts") }));
      b.onResolve({ filter: /(^|\/)fonts\.ts$/ }, () => ({ path: path.join(here, "variants/fonts-record.ts") }));
    }
  } },
  { name: "slim", setup(b) {
    b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (a) => ({ path: a.path, namespace: "no-mermaid" }));
    b.onLoad({ filter: /.*/, namespace: "no-mermaid" }, () => ({ contents: "export const parseMermaidToExcalidraw = async () => { throw new Error('no mermaid'); }; export default {};", loader: "js" }));
    b.onResolve({ filter: /^\.\/locales\// }, (a) => (/\/en-/.test(a.path) ? undefined : { path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {};", loader: "js" }));
  } },
];
const r = await esbuild.build({
  entryPoints: [path.join(bv, "src/web/entry.tsx")], bundle: true, format: "iife", write: false, outdir: path.join(here, ".out"), entryNames: "board",
  conditions: ["production"], target: "safari16", minify: true, jsx: "automatic", logLevel: "warning", legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"', __EXCALIDRAW_VERSION__: JSON.stringify(version), "import.meta.url": '"https://aiwb-assets.invalid/"' },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" }, plugins,
});
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "board.js"), r.outputFiles.find((f) => f.path.endsWith(".js")).text);
fs.writeFileSync(path.join(out, "board.css"), r.outputFiles.find((f) => f.path.endsWith(".css")).text);
for (const d of fs.readdirSync(path.join(excal, "dist/prod/fonts")).filter((d) => d !== "Xiaolai")) fs.cpSync(path.join(excal, "dist/prod/fonts", d), path.join(out, "fonts", d), { recursive: true });
console.log(`board (web) with apply variant ${variant} -> ${out}`);
