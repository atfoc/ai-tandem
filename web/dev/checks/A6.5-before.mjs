// Proves A6.5: Light, Dark and System are exactly as they were before the Catppuccin flavours, and a page from
// before them that meets a saved flavour falls back to the system's theme and keeps the saved value.
// "Before" is a build of the commit before the flavours: BASE names it (a git revision), and without BASE it is the
// parent of the commit that added src/logic/flavours.ts. Its web folder is taken out of git into a folder of its own
// and built there; no worktree is made and nothing of the checkout is touched. BASE_DIST=/tmp/x/dist is such a build
// made before.
//   The same colours: in Light, in Dark, and in System under a light and under a dark OS, every colour token the
//   old stylesheet sets on :root has the same computed value in the new page.
//   The same pixels: screenshots of still pages of both builds (Home, a chat, a chat with code and cards, a board
//   that is shown and one that is edited, a run, a finished run, the goal composer) differ in no pixel outside the
//   picker, which stands where the three-button switch stood. As the comparison's own proof, the same pages do
//   differ when the picker is not left out.
//   The old page and a saved flavour: a flavour is picked in the new page, then the old build is served at the same
//   address. The old page shows the system's theme, light or dark as the OS is, its switch marks System, and the
//   saved value is still the flavour, after a reload too. Served the new build again, the page is in the flavour.
// On the branch that has all six goals the commit before the flavours has the other five, so no BASE is given
// there. Where it has not (the flavours merged from a branch of their own), BASE names the merge's other side:
// against a commit that lacks another goal, that goal's changes show as differing pixels.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDist, check, compareShots, onEnd, openPage, seed, startMock, until } from "../shot.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
const git = (...args) => execFileSync("git", ["-C", WEB, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }).trim();

/** The build from before the flavours, in a folder of its own: { dist, rev, tidy }. */
function before() {
  if (process.env.BASE_DIST) return { dist: process.env.BASE_DIST, rev: "the build of BASE_DIST", tidy: () => {} };
  let rev = process.env.BASE;
  if (!rev) {
    const added = git("log", "--diff-filter=A", "--format=%H", "--", "src/logic/flavours.ts").split("\n").filter(Boolean).pop();
    if (!added) throw new Error("no commit of this branch added web/src/logic/flavours.ts: name the commit before the flavours with BASE");
    rev = added + "~1";
  }
  const hash = git("rev-parse", "--short", rev + "^{commit}"), root = git("rev-parse", "--show-toplevel");
  const dir = fs.mkdtempSync(path.join(TMP, "aiwb-before-")), tidy = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const tar = execFileSync("git", ["-C", root, "archive", hash, "web"], { maxBuffer: 1 << 30 });
    execFileSync("tar", ["-x", "-C", dir], { input: tar });
    if (fs.existsSync(path.join(dir, "web/src/logic/flavours.ts"))) throw new Error(`the commit ${hash} has the flavours already: BASE must name a commit before them`);
    // (its build.mjs finds esbuild beside itself: the packages are this checkout's, by a link)
    fs.symlinkSync(path.join(WEB, "node_modules"), path.join(dir, "web/node_modules"));
    return { dist: buildDist(path.join(dir, "dist"), { web: path.join(dir, "web") }), rev: hash, tidy };
  } catch (e) { tidy(); throw e; }
}

/** In the page: the computed value of every custom property that a rule of :root sets, by name. */
function rootTokens() {
  const names = new Set();
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (!rule.selectorText || !/^:root(\[[^\]]*\])*$/.test(rule.selectorText.trim())) continue;
    for (const name of rule.style) if (name.startsWith("--")) names.add(name);
  }
  const cs = getComputedStyle(document.documentElement), out = { "color-scheme": cs.colorScheme, "data-theme": document.documentElement.dataset.theme ?? "", "data-flavour": document.documentElement.dataset.flavour ?? "" };
  for (const n of [...names].sort()) out[n] = cs.getPropertyValue(n).trim();
  return out;
}

const THEMES = [
  { name: "Light", ls: { "aiwb.theme": "light" }, scheme: "dark", theme: "light" },
  { name: "Dark", ls: { "aiwb.theme": "dark" }, scheme: "light", theme: "dark" },
  { name: "System under a light OS", ls: { "aiwb.theme": "system" }, scheme: "light", theme: "light" },
  { name: "System under a dark OS", ls: {}, scheme: "dark", theme: "dark" }, // (nothing saved: a page that never chose)
];
const PICKER = [".side-foot .seg", ".side-foot .theme-pick"]; // the old switch, the new picker: the same place
const PAGES = [
  { name: "home", sel: {} },
  { name: "chat", sel: { chat: "c_plain" }, wait: ".thread .msg.assistant" },
  { name: "cards", sel: { chat: "c_A6_cards" }, seed: ["A6"], wait: ".thread .perm.pending .perm-actions" },
  { name: "board", sel: { board: "b_arch", chat: "c_board" }, wait: ".excalidraw" },
  { name: "sketch", sel: { board: "b_ui", chat: "c_A6_sketch" }, seed: ["A6"], wait: ".excalidraw:not(.excalidraw--view-mode) .App-toolbar" },
  { name: "run", sel: { run: "r_live" }, wait: ".run-stage .tl" },
  { name: "result", sel: { run: "r_done" }, wait: ".run-stage" },
  { name: "goal", sel: { run: "r_draft" }, wait: ".run-composer" },
];

await check("A6.5 Light, Dark and System are as before the flavours; an old page takes a saved flavour for the system's theme", async ({ browser, mock, dist, fail, note }) => {
  if (!mock) return fail("this check serves two builds in turn, on mocks of its own: run it with PORT and DIST, not with MOCK");
  await mock.stop(); // the two builds take the port in turn
  const old = before(), off = onEnd(old.tidy), port = mock.port;
  try {
    note(`before the flavours: ${old.rev}`);

    // ---- the same colours
    const tokens = async (build) => {
      const m = await startMock({ dist: build, port }), out = {};
      try {
        for (const t of THEMES) {
          const { ctx, page } = await openPage({ url: m.url, browser, ls: t.ls, scheme: t.scheme });
          try { out[t.name] = await page.evaluate(rootTokens); } finally { await ctx.close(); }
        }
      } finally { await m.stop(); }
      return out;
    };
    const was = await tokens(old.dist), now = await tokens(dist);
    for (const t of THEMES) {
      const a = was[t.name], b = now[t.name], names = Object.keys(a);
      if (a["data-theme"] !== t.theme) fail(`${t.name}: the old page has data-theme "${a["data-theme"]}": the check's own table is wrong`);
      if (names.length < 40) fail(`${t.name}: the old page sets ${names.length} tokens on :root: the check does not read its stylesheet`);
      const differ = names.filter((n) => a[n] !== b[n]);
      for (const n of differ) fail(`${t.name}: ${n} was "${a[n]}" and is "${b[n]}"`);
      if (b["data-flavour"]) fail(`${t.name}: the new page has data-flavour "${b["data-flavour"]}"`);
      const more = Object.keys(b).filter((n) => !(n in a));
      // (the flavours' palettes, --ctp-*, are set under data-flavour only: here they have no value)
      note(`${t.name}: ${names.length - differ.length} of ${names.length} tokens as before; new, besides the flavours' palette: ${more.filter((n) => !n.startsWith("--ctp-")).join(", ") || "none"}`);
    }

    // ---- the same pixels outside the picker
    const pages = THEMES.flatMap((t) => PAGES.map((p) => ({ ...p, name: `${p.name} in ${t.name}`, ls: t.ls, scheme: t.scheme })));
    const same = await compareShots({ a: old.dist, b: dist, pages, omit: PICKER, port, browser, out: process.env.OUT });
    for (const p of same) if (p.differing) fail(`${p.name}: ${p.differing} of ${p.pixels} pixels differ from the build before the flavours, outside the picker${process.env.OUT ? ` (${p.a}, ${p.b})` : ""}`);
    note(`${same.length} pages, ${same.reduce((n, p) => n + p.pixels, 0)} pixels, differing outside the picker: ${same.reduce((n, p) => n + p.differing, 0)}`);
    const whole = await compareShots({ a: old.dist, b: dist, pages: pages.filter((p) => p.name.startsWith("home in")), port, browser });
    for (const p of whole) if (!p.differing) fail(`${p.name}: no pixel differs with the picker not left out: the two builds are one, or the comparison does not see the picker`);
    note(`the picker itself, not left out: ${whole.map((p) => `${p.name} ${p.differing}`).join(", ")} pixels`);

    // ---- the old page and a saved flavour
    for (const [flavour, scheme] of [["mocha", "light"], ["latte", "dark"], ["frappe", "dark"], ["macchiato", "light"]]) {
      const tag = `${flavour} saved, the OS ${scheme}`, under = flavour === "latte" ? "light" : "dark";
      const state = (page) => page.evaluate(() => ({ theme: document.documentElement.dataset.theme ?? null, flavour: document.documentElement.dataset.flavour ?? null, saved: localStorage.getItem("aiwb.theme"),
        marked: [...document.querySelectorAll('.side-foot .seg [aria-checked="true"]')].map((e) => e.title).join("|"), picker: document.querySelector(".side-foot .theme-btn")?.title ?? null }));
      let m = await startMock({ dist, port });
      const { ctx, page } = await openPage({ url: m.url, browser, scheme });
      try {
        await page.locator(".side-foot .theme-btn").click();
        await page.locator(`.side-foot [role="menu"] [data-theme-pref="${flavour}"]`).click();
        if (!await until(() => page.evaluate((f) => localStorage.getItem("aiwb.theme") === f, flavour), 10000)) fail(`${tag}: the pick was not saved`);
        const serve = async (build) => { await m.stop(); m = await startMock({ dist: build, port }); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".side-foot", { timeout: 15000 }); return state(page); };

        const o = await serve(old.dist);
        if (o.picker !== null || !o.marked) fail(`${tag}: the page served from the old build has ${o.picker ? "the picker" : "no three-button switch"}: it is not the old page`);
        if (o.theme !== scheme || o.flavour !== null) fail(`${tag}: the old page has data-theme "${o.theme}" and data-flavour ${JSON.stringify(o.flavour)}: it must show the system's theme, ${scheme}`);
        if (!/System/.test(o.marked)) fail(`${tag}: the old page's switch marks "${o.marked}", not System`);
        if (o.saved !== flavour) fail(`${tag}: the old page left ${JSON.stringify(o.saved)} in localStorage "aiwb.theme"`);
        await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector(".side-foot .seg", { timeout: 15000 });
        const again = await state(page);
        if (again.saved !== flavour || again.theme !== scheme) fail(`${tag}: after a reload of the old page the saved value is ${JSON.stringify(again.saved)} and data-theme "${again.theme}"`);

        const n = await serve(dist);
        if (n.theme !== under || n.flavour !== flavour || n.saved !== flavour || !n.picker?.includes("Catppuccin")) fail(`${tag}: the new page after the old one has data-theme "${n.theme}", data-flavour ${JSON.stringify(n.flavour)}, the saved value ${JSON.stringify(n.saved)} and the picker "${n.picker}"`);
      } finally { await ctx.close(); await m.stop(); }
    }
    note("an old page with a saved flavour: the system's theme, System marked, the value kept; the new page after it is in the flavour again");
  } finally { off(); old.tidy(); }
});
