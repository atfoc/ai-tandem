// Bundles the page into web/dist. `node build.mjs --watch` rebuilds on change.
// AIWB_VERSION (default "dev") is the build's version: stamped into the bundle as __APP_VERSION__
// and written to dist/version.json, which the server reports as webVersion (the page's version.ts).
import * as esbuild from "esbuild";
import fs from "node:fs";

const watch = process.argv.includes("--watch");
const version = process.env.AIWB_VERSION || "dev";
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/version.json", JSON.stringify({ version }));
fs.copyFileSync("index.html", "dist/index.html");
fs.cpSync("public", "dist", { recursive: true }); // favicons (made by scripts/make-icons.py)
fs.cpSync("node_modules/@excalidraw/excalidraw/dist/prod/fonts", "dist/fonts", { recursive: true });
fs.rmSync("dist/fonts/Xiaolai", { recursive: true, force: true });

const opts = {
  entryPoints: ["src/main.tsx"], bundle: true, format: "esm", outdir: "dist",
  conditions: ["production"], define: {
    "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"', __APP_VERSION__: JSON.stringify(version),
  },
  minify: !watch, sourcemap: watch, loader: { ".woff2": "file" }, jsx: "automatic", logLevel: "info",
};
if (watch) await (await esbuild.context(opts)).watch();
else await esbuild.build(opts);
