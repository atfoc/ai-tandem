// Proves A2.7: at the default widths a started chat's composer looks as it did before the toolbar was fitted to its
// row, but for what the attach button takes, which the row got since. Screenshots of this build and of the build of
// the commit this work began from, compared pixel by pixel on still pages: a started chat in the default 400 px panel
// beside a board (light and dark) and beside a run, and a plain chat's page in the default window. Only the composer
// is compared: the sidebar (it has a control more), the stage, the chat's head and its thread are left out.
// The plain chat's row has room for the button: with it taken out, no pixel differs. The panel's row has not: there
// the button takes the room of the meter's text, which is the toolbar's own rule for a row that runs out of room
// (logic/composerfit.ts), and the Insert button stands in what the ring leaves. So in the default panel no pixel
// differs outside the meter's text and the two buttons: the lock, the folder, the fixed chip, the ring, the box and
// Send are where they were. And in a panel of 430 px, the 30 px wider that the button takes, the row is whole again:
// with the button taken out no pixel differs there, the meter's text among them.
// And the comparison sees the composer: the default panel as it is differs, and so does the same panel with the
// agent at work. There the meter was cut to its ring before the attach button, on purpose: Stop takes the room of
// its text, where the build before squeezed the folder's lock away and let Send stand against the box's border
// (G1 §Q2).
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
// (the panel in which a started chat's row is whole again: the attach button and its gap take 30 px)
const WHOLE = { "aiwb.widths": JSON.stringify({ side: 264, panel: 430 }) };
const PANEL = { wait: ".board-panel .composer-box .send", omit: [".side-pane", ".board-stage", ".chat-head", ".thread"] };
const PANELS = [
  { name: "a started chat beside a board", sel: { board: "b_arch", chat: "c_board" }, theme: {} },
  { name: "the same in the dark theme", sel: { board: "b_arch", chat: "c_board" }, theme: { "aiwb.theme": "dark" } },
  { name: "a started chat beside a run", sel: { run: "r_live", chat: "c_live_ask" }, theme: {} },
];
// What the row got after BASE, taken out of it for the comparison. (Taking the attach button out does not give the
// row its room back: its width is counted from the first frame on.)
const ATTACH = ".composer .attach-btn { display: none }";
// The default panel: the meter's text is not drawn in either build (the ring is: it has a stroke, no colour of its
// own), and the Insert button, which stands in the room the text left, is taken out with the attach button.
const NO_TEXT = `.composer .ctx-meter, .composer .ctx-meter * { color: transparent !important } .composer .insert-btn { display: none } ${ATTACH}`;
const PAGES = [
  ...PANELS.map((p) => ({ name: `${p.name}, but for the meter's text`, sel: p.sel, ls: { ...DEFAULT, ...p.theme }, ...PANEL, style: NO_TEXT })),
  ...PANELS.map((p) => ({ name: `${p.name}, in a panel of 430 px`, sel: p.sel, ls: { ...WHOLE, ...p.theme }, ...PANEL, style: ATTACH })),
  // (a plain chat's row has room for the fixed Subagents chip, for the Insert button and for the attach button, which
  // the toolbar got after BASE: beside them the composer is as it was, so the three are taken out of the row for the
  // comparison. In the 430 px panels the first two are not drawn: a fixed chip on the default settings gives way to
  // the others, and the Insert button stands only where the row has room left.)
  { name: "a started plain chat", sel: { chat: "c_plain" }, ls: DEFAULT, wait: ".chat-page .composer-box .send", omit: [".side-pane", ".chat-head", ".thread"], style: `.composer .sub-chip, .composer .insert-btn { display: none } ${ATTACH}` },
];
// The pages that must differ: the default panel as it is (the meter cut to its ring, the two buttons), and at work.
const SEEN = [
  { name: "a started chat beside a board, as it is", sel: { board: "b_arch", chat: "c_board" }, ls: DEFAULT, ...PANEL, why: "where the meter had its text and the row no attach button" },
  { name: "a chat at work beside a run", sel: { run: "r_trouble", chat: "c_trouble_ask" }, ls: DEFAULT, ...PANEL, why: "where the meter had its text beside Stop" },
];

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

await check("A2.7 at the default widths a started chat's composer is as it was, but for the attach button's room", async ({ browser, mock, dist, fail, note }) => {
  if (!mock) return fail("this check starts its own mocks, one per build: run it with PORT and DIST, not with MOCK");
  await mock.stop(); // the comparison's mocks take the port in turn
  const made = process.env.BASE_DIST ? "" : buildOf(BASE), before = process.env.BASE_DIST || made;
  const off = onEnd(() => { if (made) fs.rmSync(made, { recursive: true, force: true }); });
  try {
    const r = await compareShots({ a: before, b: dist, pages: [...PAGES, ...SEEN], port: mock.port, browser });
    for (const p of r.slice(0, PAGES.length)) if (p.differing) fail(`${p.name}: ${p.differing} of ${p.pixels} pixels of the composer differ from the build of ${BASE.slice(0, 7)}${p.sizes ? ` (the screenshots are ${p.sizes.map((s) => s.join(" by ")).join(" and ")} px)` : ""}`);
    for (const [i, p] of SEEN.entries()) if (!r[PAGES.length + i].differing) fail(`${p.name}: no pixel differs from the build of ${BASE.slice(0, 7)}, ${p.why}: the comparison does not see the composer`);
    note(`against the build of ${process.env.BASE_DIST ? before : BASE.slice(0, 7)}, differing pixels of the composer: ${r.map((p) => `${p.name} ${p.differing}`).join(", ")}`);
  } finally { off(); if (made) fs.rmSync(made, { recursive: true, force: true }); }
});
