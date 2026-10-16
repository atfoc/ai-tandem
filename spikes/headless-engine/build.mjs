// Bundles the Node engine (entry.ts) into out/engine.mjs, with the board view's own esbuild settings where they apply
// (conditions production, the defines, the slim plugin); the native canvas stays outside the bundle.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const excal = path.resolve(here, "../../node_modules/@excalidraw/excalidraw");
const version = JSON.parse(fs.readFileSync(path.join(excal, "package.json"), "utf8")).version;
const slim = {
  name: "slim",
  setup(b) {
    b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (a) => ({ path: a.path, namespace: "no-mermaid" }));
    b.onLoad({ filter: /.*/, namespace: "no-mermaid" }, () => ({ contents: "export const parseMermaidToExcalidraw = async () => { throw new Error('mermaid is not in this build'); }; export default {};", loader: "js" }));
    b.onResolve({ filter: /^\.\/locales\// }, (a) => (/\/en-/.test(a.path) ? undefined : { path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};
// AIWB_APPLY_VARIANT=<file in variants/>: the engine's apply.ts is replaced by that variant (the window's build, build-web.mjs,
// takes the same variable), to prove a change of the engine on both sides before it is made in packages/board-view.
const variant = process.env.AIWB_APPLY_VARIANT;
const swap = {
  name: "apply-variant",
  setup(b) { if (variant) b.onResolve({ filter: /(^|\/)apply\.ts$/ }, (a) => (a.importer.includes("/variants/") ? undefined : { path: path.join(here, "variants", variant) })); },
};
export { swap, slim, version };
const t0 = Date.now();
const r = await esbuild.build({
  entryPoints: [path.join(here, "entry.ts")], bundle: true, format: "esm", platform: "node", target: "node22",
  outfile: path.join(here, "out/engine.mjs"), conditions: ["production"], jsx: "automatic", logLevel: "warning", legalComments: "none",
  external: ["@napi-rs/canvas", "skia-canvas"], metafile: true,
  define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"', __EXCALIDRAW_VERSION__: JSON.stringify(version) },
  loader: { ".woff2": "file", ".css": "empty" }, assetNames: "assets/[name]",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  plugins: [swap, slim],
});
const size = fs.statSync(path.join(here, "out/engine.mjs")).size;
console.log(`engine (node)${variant ? ` with apply variant ${variant}` : ""}: excalidraw ${version}, ${Date.now() - t0} ms, ${(size / 1e6).toFixed(2)} MB -> out/engine.mjs`);
