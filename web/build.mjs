// Bundles the page into web/dist. `node build.mjs --watch` rebuilds on change.
import * as esbuild from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("index.html", "dist/index.html");
fs.cpSync("public", "dist", { recursive: true }); // favicons (made by scripts/make-icons.py)
fs.cpSync("node_modules/@excalidraw/excalidraw/dist/prod/fonts", "dist/fonts", { recursive: true });
fs.rmSync("dist/fonts/Xiaolai", { recursive: true, force: true });

const opts = {
  entryPoints: ["src/main.tsx"], bundle: true, format: "esm", outdir: "dist",
  conditions: ["production"], define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"' },
  minify: !watch, sourcemap: watch, loader: { ".woff2": "file" }, jsx: "automatic", logLevel: "info",
};
if (watch) await (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
