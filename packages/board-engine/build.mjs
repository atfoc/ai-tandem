// Bundles the Node engine (src/bundle.ts) into dist/engine.mjs (git-ignored): the stand-in page, Excalidraw and the board view's
// engine on given elements, with the board view's own esbuild settings (conditions production, the defines, the slim plugin, CSS
// emptied). The native canvas stays outside the bundle (ENGINE_EXTERNALS in src/node.ts): it is loaded from `node_modules` next to
// the bundle, which `copyEngineAssets` puts there.
//
//   node build.mjs          builds dist/engine.mjs
//
// `buildEngine({ ifStale })` is what src/node.ts calls: with `ifStale` it builds only when dist/engine.mjs is missing or older than
// the sources it is made from.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const outFile = path.join(here, "dist", "engine.mjs");

/** The root of an installed package (its exports hide package.json): up from where its entry resolves. */
export function packageRoot(name) {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name));
  while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== name) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package root for ${name}`);
    dir = up;
  }
  return dir;
}

// The slim plugin of packages/board-view/build.mjs (which cannot be imported: it builds when it is loaded): English only, no Mermaid.
const slim = {
  name: "slim",
  setup(b) {
    b.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, (a) => ({ path: a.path, namespace: "no-mermaid" }));
    b.onLoad({ filter: /.*/, namespace: "no-mermaid" }, () => ({
      contents: "export const parseMermaidToExcalidraw = async () => { throw new Error('mermaid is not in this build'); }; export default {};", loader: "js",
    }));
    b.onResolve({ filter: /^\.\/locales\// }, (a) => (/\/en-/.test(a.path) ? undefined : { path: a.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

/** The newest modification time under the folders (and files) that dist/engine.mjs is made from. */
function newestSource() {
  const roots = [
    path.join(here, "src"), path.join(here, "build.mjs"), path.join(here, "package.json"),
    path.join(here, "..", "board-view", "src"), path.join(here, "..", "board-bridge", "src"),
  ];
  let newest = 0;
  const visit = (p) => {
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) visit(path.join(p, n));
    else newest = Math.max(newest, st.mtimeMs);
  };
  roots.forEach(visit);
  return newest;
}

/** Builds dist/engine.mjs; returns its path. With `ifStale`, only when it is missing or older than its sources. */
export async function buildEngine({ ifStale = false } = {}) {
  if (ifStale) {
    const st = fs.statSync(outFile, { throwIfNoEntry: false });
    if (st && st.mtimeMs >= newestSource()) return outFile;
  }
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot("@excalidraw/excalidraw"), "package.json"), "utf8")).version;
  // built beside the target and renamed into place, so two builds at once (two tests) never leave half a file
  const tmp = `${outFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(here, "src", "bundle.ts")], bundle: true, format: "esm", platform: "node", target: "node22",
    // the repository root, whatever the working directory: esbuild's comments in the bundle name modules by paths relative to it
    absWorkingDir: path.resolve(here, "..", ".."),
    outfile: tmp, conditions: ["production"], jsx: "automatic", logLevel: "warning", legalComments: "none",
    external: ["skia-canvas"],
    define: { "process.env.NODE_ENV": '"production"', "process.env.IS_PREACT": '"false"', __EXCALIDRAW_VERSION__: JSON.stringify(version) },
    loader: { ".woff2": "empty", ".woff": "empty", ".ttf": "empty", ".css": "empty" },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    plugins: [slim],
  });
  fs.renameSync(tmp, outFile);
  return outFile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  await buildEngine();
  console.log(`engine (node): ${((fs.statSync(outFile).size) / 1e6).toFixed(2)} MB, ${Date.now() - t0} ms -> ${path.relative(process.cwd(), outFile)}`);
}
