// Runs the browser checks of dev/checks, one after the other, and prints which passed. They check the app's web build (app/, its
// export; AD-42) on the mock, each at the viewports it lists (dev/viewports.mjs). How a check is written: dev/checks/README.md
//   npm run uicheck                      every check
//   npm run uicheck -- L1 P0.7           the checks named: one by its id (P0.1 is the file P0.1-…, not P0.10-…), or
//                                        every check of an item or a phase (A2: A2.1-…, A2.2-…)
//   PORT=4900 npm run uicheck            the port the checks' mocks bind (default: a free one, so runs side by side do not collide)
//   DIST=/tmp/x/dist npm run uicheck     a build made before, in place of one made now. It must be a build for the checks:
//                                        buildAppDist (dev/shot.mjs), or `cd app && EXPO_PUBLIC_AIWB_VERSION=uicheck npm run build:web
//                                        -- --output-dir /tmp/x/dist --connect-self` (a plain export has the version "dev", on which
//                                        the page shows no update notice, and P0.3 fails on those states, and its CSP lets it
//                                        reach nothing but the files it came from, not the mock)
//   LIMIT=120 npm run uicheck            the seconds one check may take (default 600, six times what the longest
//                                        takes on a free machine): one that has not ended by then is ended, and
//                                        has failed; a check that names its own (a line `export const limit = <seconds>;`,
//                                        UX.R1 walks every phone screen) gets the larger of the two
// One check alone, with its own output: PORT=4900 node dev/checks/P0.1-overflow.mjs (DIST as above; MOCK=http://… for
// a mock that runs already; VIEWPORT=phone for one viewport). No check calls a paid model, and none is run by `npm test` or
// `npm run check`.
// Ended by SIGTERM, SIGINT or SIGHUP (a command's time limit, Ctrl-C), the runner ends the check that runs, which
// stops its mock, and removes the build it made; a check run alone does the same.
//
// The summary names the Playwright and the Chromium that drew the pages (the newest Playwright of the npx cache,
// unless PLAYWRIGHT or node_modules has one). The widths of packages/core/test/fixtures/composer-widths.json, which P0.6 holds to
// 1.5 px, are this machine's system font in that Chromium: on another machine, or with another Chromium, P0.6 fails
// until the fixture is written again (WRITE=1, see the check).
//
// The convention. A browser check is one file, dev/checks/<criterion>-<word>.mjs, named by the criterion it proves (A2.2-fits.mjs;
// P0.n are the tooling's own, P7.n prove what needs two goals together, SEC.n prove the sections of the sidebar on the mock's
// servers: dev/mock.mjs "Remote servers", L<n> are those written for the app). Its first comment says what it proves, and which
// other check goes on from it, if one does. It calls check(title, body, { viewports }) of dev/shot.mjs once: that starts the check's own mock
// on PORT with the build in DIST, opens a browser, and ends the process with 0 and "ok <title>", or with 1 and a
// line "FAIL <title>: <what failed>" for each failure. In the body the check seeds what it needs (seed(url, "A2"):
// only its item's section), opens its pages and calls fail(line) for what is wrong; a throw fails it too.
// It waits for signs, not for times: a selector, an event of the stream, until(fn) of dev/shot.mjs, each with a bound
// of seconds, so that it passes on a machine several times slower. until() does not throw: after its bound it
// answers a value that is not true, which the check must read (if (!await until(…)) fail(…)). Where a time is itself
// what is measured (an answer held by a knob), the knob's time is long beside what it is compared with.
// To add one: copy the shortest check of the folder, name it by its criterion, and run it alone until it says ok.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkFiles } from "./checklist.mjs";
import { buildAppDist, ending, freePort, onEnd, versions } from "./shot.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "checks");
const LIMIT = Number(process.env.LIMIT) || 600;
const want = process.argv.slice(2);
const files = checkFiles(DIR, want);
if (!files.length) { console.error(`no check of dev/${path.basename(DIR)} is named ${want.join(" or ")}`); process.exit(2); }

let built = "", running = null;
/** Ends a check that runs: by SIGTERM, on which it stops its mock and removes its build. One that goes on for ten
 *  more seconds is killed with its process group, its mock with it. */
const end = (p) => { p.kill("SIGTERM"); const hard = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 10000); return p.gone.then(() => clearTimeout(hard)); };
onEnd(async () => { if (running) await end(running); if (built) fs.rmSync(built, { recursive: true, force: true }); });

/** Runs one check to its end, in a process group of its own, and answers whether it passed. */
const run = (f) => new Promise((ok) => {
  const p = (running = spawn(process.execPath, [path.join(DIR, f)], { env, stdio: "inherit", detached: true }));
  let late = false;
  const own = Number(/^export const limit = (\d+);/m.exec(fs.readFileSync(path.join(DIR, f), "utf8"))?.[1] ?? 0), secs = Math.max(LIMIT, own);
  const limit = setTimeout(() => { late = true; console.log(`FAIL ${f}: it had not ended after ${secs} s`); end(p); }, secs * 1000);
  p.gone = new Promise((gone) => p.on("exit", (code) => { clearTimeout(limit); running = null; gone(); ok(code === 0 && !late); }));
});

const drew = await versions();
built = process.env.DIST ? "" : buildAppDist();
const env = { ...process.env, DIST: process.env.DIST || built, PORT: process.env.PORT || String(await freePort()) };
const failed = [];
try {
  for (const f of files) {
    const t = Date.now(), passed = await run(f);
    if (ending()) await new Promise(() => {}); // (ended early: the signal's handler ends the process, and no other check is started)
    if (!passed) failed.push(f);
    console.log(`     (${f}: ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  }
} finally { if (built) fs.rmSync(built, { recursive: true, force: true }); }
console.log(`\n${files.length - failed.length} of ${files.length} checks passed${failed.length ? `; failed: ${failed.join(", ")}` : ""} (Playwright ${drew.playwright}, Chromium ${drew.chromium})`);
process.exit(failed.length ? 1 : 0);
