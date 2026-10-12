// Proves A2.7: at the default widths a started chat's composer looks as it did before the toolbar was fitted to its
// row. Screenshots of this build and of the build of the commit this work began from, compared pixel by pixel on
// still pages: a started chat in the default 400 px panel beside a board (light and dark) and beside a run, and a
// plain chat's page in the default window. Only the composer is compared: the sidebar (it has a control more), the
// stage, the chat's head and its thread are left out. No pixel differs.
// And the comparison sees the composer: the same panel with the agent at work differs. There the meter is cut to its
// ring, on purpose: Stop takes the room of its text, where the build before squeezed the folder's lock away and let
// Send stand against the box's border (G1 §Q2).
//   BASE=<commit>           the commit whose build is "before" (default: where the branch of this work left main)
//   BASE_DIST=/tmp/x/dist   a build of it made before, in place of one made now
// The build of BASE is made from `git archive`, with this checkout's packages: the work added none.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDist, check, compareShots, onEnd } from "../shot.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.BASE || "f9d3ec04b4bac83e82f5ad07d33571bea25678f2";
const DEFAULT = { "aiwb.widths": JSON.stringify({ side: 264, panel: 400 }) };
const PANEL = { wait: ".board-panel .composer-box .send", omit: [".side-pane", ".board-stage", ".chat-head", ".thread"] };
const PAGES = [
  { name: "a started chat beside a board", sel: { board: "b_arch", chat: "c_board" }, ls: DEFAULT, ...PANEL },
  { name: "the same in the dark theme", sel: { board: "b_arch", chat: "c_board" }, ls: { ...DEFAULT, "aiwb.theme": "dark" }, ...PANEL },
  { name: "a started chat beside a run", sel: { run: "r_live", chat: "c_live_ask" }, ls: DEFAULT, ...PANEL },
  // (a plain chat's row has room for the fixed Subagents chip, which the toolbar got after BASE: beside it the composer
  // is as it was, so the chip is taken out of the row for the comparison. In the panels it is not drawn: a fixed chip
  // on the default settings gives way to the others.)
  { name: "a started plain chat", sel: { chat: "c_plain" }, ls: DEFAULT, wait: ".chat-page .composer-box .send", omit: [".side-pane", ".chat-head", ".thread"], style: ".composer .sub-chip { display: none }" },
];
const AT_WORK = { name: "a chat at work beside a run", sel: { run: "r_trouble", chat: "c_trouble_ask" }, ls: DEFAULT, ...PANEL };

/** The client of a commit, built into a folder outside the checkout; answers the folder. */
function buildOf(commit) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-base-")), web = path.join(src, "web"), tar = path.join(src, "web.tar");
  try {
    fs.mkdirSync(web);
    // (run in web/, the archive holds its files alone, by their paths under it)
    try { execFileSync("git", ["-C", WEB, "archive", "-o", tar, commit, "src", "index.html", "public", "build.mjs"], { stdio: "pipe" }); }
    catch (e) { throw new Error(`the sources of ${commit} could not be read from git (BASE names another commit, BASE_DIST a build made before):\n${e.stderr?.toString() || e.message}`); }
    execFileSync("tar", ["-xf", tar, "-C", web], { stdio: "pipe" });
    fs.symlinkSync(path.join(WEB, "node_modules"), path.join(web, "node_modules"));
    return buildDist(undefined, { web });
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
}

await check("A2.7 at the default widths a started chat's composer is as it was", async ({ browser, mock, dist, fail, note }) => {
  if (!mock) return fail("this check starts its own mocks, one per build: run it with PORT and DIST, not with MOCK");
  await mock.stop(); // the comparison's mocks take the port in turn
  const made = process.env.BASE_DIST ? "" : buildOf(BASE), before = process.env.BASE_DIST || made;
  const off = onEnd(() => { if (made) fs.rmSync(made, { recursive: true, force: true }); });
  try {
    const r = await compareShots({ a: before, b: dist, pages: [...PAGES, AT_WORK], port: mock.port, browser });
    for (const p of r.slice(0, PAGES.length)) if (p.differing) fail(`${p.name}: ${p.differing} of ${p.pixels} pixels of the composer differ from the build of ${BASE.slice(0, 7)}${p.sizes ? ` (the screenshots are ${p.sizes.map((s) => s.join(" by ")).join(" and ")} px)` : ""}`);
    const work = r[PAGES.length];
    if (!work.differing) fail(`${work.name}: no pixel differs from the build of ${BASE.slice(0, 7)}, where the meter had its text beside Stop: the comparison does not see the composer`);
    note(`against the build of ${process.env.BASE_DIST ? before : BASE.slice(0, 7)}, differing pixels of the composer: ${r.map((p) => `${p.name} ${p.differing}`).join(", ")}`);
  } finally { off(); if (made) fs.rmSync(made, { recursive: true, force: true }); }
});
