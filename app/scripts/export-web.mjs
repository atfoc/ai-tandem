// `npm run build:web`: Expo's web export (AD-40) and the two steps after it. Usage:
//   node scripts/export-web.mjs [--output-dir <dir>] [--connect-self]   (default dist-web; EXPO_PUBLIC_AIWB_VERSION is the build's version)
//   --connect-self (or AIWB_CONNECT_SELF=1): the build for the browser checks, whose CSP also has `connect-src 'self'` (U3)
// 0. `@aiwb/board-view`'s `build:web` writes the board into public/board/ (board.js, board.css, fonts/; generated, git-ignored).
//    Metro never bundles Excalidraw (AD-40): the page loads this build of it, the one the phone's web view runs, and a stale
//    one never ships because it is built again here.
// 1. `expo export --platform web` (web.output "single", experiments.baseUrl "."): public/ is copied as it is (public/index.html
//    with its links to ./board/, public/board/), so the export names its bundle, chunks and assets relative to the page and
//    the window can load it from file://.
// 2. The post-export step: the CSP <meta> (AD-41) and the <script> of the bundle go into dist-web/index.html. Excalidraw's
//    fonts are in dist-web/board/fonts/, next to board.js, which is where it looks for them.
//    The palette's licence notice (Catppuccin, MIT) is written beside the page as THIRD-PARTY-NOTICES.txt (noticeText): the
//    licence asks that every copy carries it, and the bundle's own copy of the text is a string of an unused function.
// 3. The check that nothing is named by an absolute path (index.html, the bundle's strings): such an export is blank under file://.
//    desktop/e2e/app.e2e.mjs (AIWB_PAGE=../app/dist-web/index.html) loads the result in the window itself.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The page's CSP. `connectSelf` (the build the browser checks run, `--connect-self`) adds `connect-src 'self'` and nothing
 *  else, so the page can reach the mock and the test host it is served from over HTTP; the shipped build, which the window
 *  loads from file:// and which has no network of its own, keeps `connect-src 'none'`. */
export const cspFor = ({ connectSelf = false } = {}) =>
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:; " +
  `font-src 'self' data:; connect-src ${connectSelf ? "'self'" : "'none'"}; base-uri 'none'; form-action 'none'`;

/** The shipped build's CSP (AD-41). */
export const csp = cspFor();

/** The page with the CSP <meta> after the charset and a deferred <script> for each bundle after the root element. */
export function transformIndex(html, bundles, { connectSelf = false } = {}) {
  if (!html.includes('<link rel="stylesheet" href="./board/board.css">') || !html.includes('<script src="./board/board.js" defer></script>'))
    throw new Error("public/index.html needs the links to the board: ./board/board.css and ./board/board.js (defer)");
  if (bundles.length !== 1) throw new Error(`expected one web bundle, found ${bundles.length}: ${bundles.join(", ")}`);
  const metaAt = html.indexOf('<meta charset="utf-8">');
  const rootAt = html.indexOf('<div id="root"></div>');
  if (metaAt < 0 || rootAt < 0) throw new Error('public/index.html needs <meta charset="utf-8"> and <div id="root"></div>');
  const meta = '<meta charset="utf-8">';
  const root = '<div id="root"></div>';
  return (
    html.slice(0, metaAt) + meta + `\n<meta http-equiv="Content-Security-Policy" content="${cspFor({ connectSelf })}">` +
    html.slice(metaAt + meta.length, rootAt) + root + `\n<script src="./${bundles[0]}" defer></script>` +
    html.slice(rootAt + root.length)
  );
}

/** The text of the file THIRD-PARTY-NOTICES.txt of the export: the licence notice of the Catppuccin palette
 *  (logic/flavours.ts NOTICE, the text the stylesheet of the old page carried), without the comment's framing. */
export async function noticeText() {
  const { NOTICE } = await import("@aiwb/core/logic/flavours.ts");
  const body = NOTICE.replace(/^\/\*!\n/, "").replace(/\n \*\/$/, "").split("\n").map((l) => l.replace(/^ \* ?/, "")).join("\n");
  return `Third-party notices\n===================\n\n${body}\n`;
}

/** The paths in a page that start with "/": from file:// they point at the root of the disk, nothing loads, the window stays
 *  blank and `did-fail-load` never fires (spike rn-spike-electron). `experiments.baseUrl: "."` keeps them out of the export. */
export function absolutePaths(html) {
  return [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
}

/** The same for the app's bundle: its runtime names the chunks, assets and fonts it loads at run time as strings. */
export function absolutePathsInBundle(js) {
  return [...js.matchAll(/["'`](\/(?:_expo|assets)\/[^"'`]*)["'`]/g)].map((m) => m[1]);
}

/** Throws when the export at `outDir` names something by an absolute path (AD-41: the window loads it from file://). */
export function checkRelative(outDir) {
  const bad = absolutePaths(fs.readFileSync(path.join(outDir, "index.html"), "utf8"));
  for (const b of bundlesOf(outDir)) bad.push(...absolutePathsInBundle(fs.readFileSync(path.join(outDir, b), "utf8")));
  if (bad.length) throw new Error(`the export names files by an absolute path, which the window cannot load from file://: ${[...new Set(bad)].join(", ")}`);
}

function bundlesOf(outDir) {
  const dir = path.join(outDir, "_expo/static/js/web");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => `_expo/static/js/web/${f}`);
}

async function main() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const at = process.argv.indexOf("--output-dir");
  const outDir = path.resolve(appRoot, at >= 0 ? process.argv[at + 1] : "dist-web");
  const board = spawnSync("npm", ["run", "build:web"], { cwd: path.join(appRoot, "../packages/board-view"), stdio: "inherit" });
  if (board.status !== 0) process.exit(board.status ?? 1);
  const run = spawnSync("npx", ["expo", "export", "--platform", "web", "--output-dir", outDir], { cwd: appRoot, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
  const index = path.join(outDir, "index.html");
  const connectSelf = process.argv.includes("--connect-self") || process.env.AIWB_CONNECT_SELF === "1";
  fs.writeFileSync(index, transformIndex(fs.readFileSync(index, "utf8"), bundlesOf(outDir), { connectSelf }));
  checkRelative(outDir);
  fs.writeFileSync(path.join(outDir, "THIRD-PARTY-NOTICES.txt"), await noticeText());
  for (const f of ["board/board.js", "board/board.css", "board/fonts/Nunito"]) {
    if (!fs.existsSync(path.join(outDir, f))) throw new Error(`the export has no ${f}: the board's web build did not reach it`);
  }
  console.log(`Page ready: ${index}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
