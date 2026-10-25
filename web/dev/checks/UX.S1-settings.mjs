// UX.S1-settings (package S1, ux-improvements goal 3.8.1; PLAN §2 S1 "Checks"): Settings, Appearance and About on the phone, where
// Settings is one pushed screen of the phone's stack (Home's gear pushes it; here the gear or the uicheck build's seam does, `openSettings` of
// sel.mjs). On the phone, in the light theme (the sizes again in the dark):
//   Settings     the bar's back says "Home" and its title "Settings"; the six rows in the order Servers, Prompt library, Archived, Voice,
//                Appearance, About, each 44 pt high at least, with text of 13 px at least (the label 17), a chevron, and no switch, checkbox
//                or field in the screen; the Servers line says the state of the mock's servers and turns amber, naming the server, when
//                one needs attention; the counts of the Prompt library and Archived are the mock's data; each row pushes its screen and
//                the back lands on Settings with the row there; the back after Settings lands on Home
//   Appearance   the three Theme rows with only the current one checked; Dark applies at once (<html>, the background, `aiwb.theme`)
//                with the screen kept; the flavour row opens a sheet of four rows (Latte, Frappé, Macchiato, Mocha), each 50 pt at least,
//                with a swatch and the note Light / Dark, the chosen one aria-checked; Mocha closes the sheet and applies at once, the
//                flavour row says Mocha and no Theme row is checked; Light turns the flavour off; Settings' Appearance line says the
//                choice ("Catppuccin Mocha", "Light"); a reload keeps it
//   About        the Version row is the page's version, the Help row has no chevron and opens an address outside the app (window.open is
//                held and its call read), and the browser has no "Server log" row (the desktop app's, `inDesktopApp()`, is the IPC
//                transport: the browser checks and the Electron shim of uicheck:electron serve the page over HTTP, so neither can show it)
// The tablet and the desktop keep their split view: no Settings screen is drawn (a push of it by the seam too), and the sidebar foot's
// `theme-btn` is still the theme's picker there.
// OUT=/tmp/x (default web/out/s1-shots) keeps a screenshot of Settings, Appearance, the open flavour sheet and About in the light and dark
// themes and in Mocha, at the phone.
import fs from "node:fs";
import { check, mockEval, until } from "../shot.mjs";
import { IDS, byTid, layoutNow, press, tidSel } from "./sel.mjs";
import { atRest, openAppearance, openFlavours, openRow, openSettings, pickFlavour, pickTheme, rowsOf, settingsText, stackKeys, themeNow } from "./settings.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT ?? new URL("../../out/s1-shots/", import.meta.url).pathname;
const ROWS = ["servers", "library", "archived", "voice", "appearance", "about"];
const SCREEN_OF = { servers: "servers", library: "library", archived: "archived", voice: "voice-settings", appearance: "appearance", about: "about" };
const FLAVOURS = [["latte", "Latte", "Light"], ["frappe", "Frappé", "Dark"], ["macchiato", "Macchiato", "Dark"], ["mocha", "Mocha", "Dark"]];
const BG = { light: "rgb(255, 255, 255)", dark: "rgb(28, 28, 33)", mocha: "rgb(30, 30, 46)" };

await check("UX.S1 Settings, Appearance and About on the phone; the wide layouts unchanged", async ({ url, layout, page, fail, note }) => {
  const topScreen = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop()?.dataset.screen ?? null);
  const barOf = () => page.evaluate(() => {
    const bar = [...document.querySelectorAll('[data-testid="place-bar"]')].pop(), back = [...document.querySelectorAll('[data-testid="nav-back"]')].pop();
    return { back: back?.innerText.trim() ?? null, backName: back?.getAttribute("aria-label") ?? null, text: bar?.innerText.replace(/\s+/g, " ").trim() ?? null };
  });

  if (layout !== "phone") {
    // ---- the wide layouts: Settings is not drawn by itself, and the foot's picker is still the theme's
    if (layoutNow(page) === "phone") return fail("a wide viewport is the phone layout");
    await byTid(page, "side-pane").first().waitFor({ state: "visible", timeout: WAIT });
    if (await byTid(page, "settings-screen").count()) fail("a wide layout draws the Settings screen before anything pushed it");
    if (!(await byTid(page, "theme-btn").first().isVisible().catch(() => false))) fail("the sidebar foot's theme-btn is not drawn");
    await page.evaluate(() => window.__aiwbStack.push("settings", {}));
    await page.waitForTimeout(500);
    if (await byTid(page, "settings-screen").count() || await byTid(page, "pushed-screen").count()) fail("a wide layout draws the pushed Settings screen of the phone's stack");
    if (await byTid(page, IDS.back).count()) fail("a wide layout draws a back control");
    if (!(await byTid(page, "theme-btn").first().isVisible().catch(() => false))) fail("after the push, the sidebar foot's theme-btn is gone");
    note("the wide layout is the split view: no Settings screen, the foot's theme-btn is the picker");
    return;
  }

  // ---- the phone
  fs.mkdirSync(OUT, { recursive: true });
  const shoot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
  const world = await mockEval(`return { servers: extra.servers.map((s) => ({ id: s.id, name: s.name, state: s.state })), archived: Object.values(chats).filter((c) => c.archived).length };`, url);
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  await until(async () => (await stackKeys(page)).join() === "home", WAIT);

  // ---- Settings pushed from Home
  await openSettings(page);
  const keys = await stackKeys(page);
  if (keys.length !== 2 || keys[0] !== "home") fail(`Settings pushed from Home: the stack is [${keys.join(", ")}]`);
  const bar = await barOf();
  if (bar.back !== "Home" || bar.backName !== "Back to Home") fail(`the bar's back says ${J(bar.back)} (${J(bar.backName)}), not "Home" ("Back to Home")`);
  if (!/^Home\s*Settings$/.test(bar.text ?? "")) fail(`the bar says ${J(bar.text)}, not "Home" and "Settings"`);

  /** The sizes of the Settings screen on top: rows, texts, chevrons, controls. */
  const sizes = async (tag) => {
    const m = await page.evaluate(() => {
      const screen = [...document.querySelectorAll('[data-testid="settings-screen"]')].pop();
      const rows = [...screen.querySelectorAll('[data-testid="settings-row"]')].map((e) => {
        const r = e.getBoundingClientRect();
        const svgRight = [...e.querySelectorAll("svg")].filter((s) => s.getBoundingClientRect().right > r.right - 40);
        const texts = [...e.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim());
        return { row: e.dataset.row, top: r.top, h: r.height, chevron: svgRight.length > 0, label: texts[0]?.textContent.trim(), fonts: texts.map((d) => parseFloat(getComputedStyle(d).fontSize)), labelFont: parseFloat(getComputedStyle(texts[0]).fontSize) };
      });
      const fonts = [...screen.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim()).map((d) => parseFloat(getComputedStyle(d).fontSize));
      return { rows, minFont: Math.min(...fonts), controls: screen.querySelectorAll('input, textarea, select, [role="switch"], [role="checkbox"], [type="checkbox"]').length };
    });
    if (m.rows.map((r) => r.row).join() !== ROWS.join()) fail(`${tag}: the rows are ${m.rows.map((r) => r.row).join(", ")}, not ${ROWS.join(", ")}`);
    if (m.rows.some((r, i) => i && r.top <= m.rows[i - 1].top)) fail(`${tag}: the rows are not drawn top to bottom in order`);
    for (const r of m.rows) {
      if (r.h < 44) fail(`${tag}: the ${r.row} row is ${r.h} px high, under 44`);
      if (r.labelFont < 17) fail(`${tag}: the ${r.row} row's label is ${r.labelFont} px, under 17`);
      if (!r.chevron) fail(`${tag}: the ${r.row} row has no chevron`);
    }
    if (m.minFont < 13) fail(`${tag}: a text of the screen is ${m.minFont} px, under 13`);
    if (m.controls) fail(`${tag}: the screen has ${m.controls} switches, checkboxes or fields; Settings has none`);
    return m;
  };
  const labels = (await settingsText(page));
  const names = { servers: "Servers", library: "Prompt library", archived: "Archived", voice: "Voice", appearance: "Appearance", about: "About" };
  for (const r of ROWS) if (labels[r]?.label !== names[r]) fail(`the ${r} row is labelled ${J(labels[r]?.label)}, not ${J(names[r])}`);
  await sizes("light");

  // ---- what the rows say, from the mock's data
  const nonServer = labels.servers;
  const connected = world.servers.filter((s) => s.state === "connected").length;
  if (world.servers.some((s) => s.state !== "connected")) fail("the mock's servers are not all connected at the start");
  if (nonServer.sub !== `${connected} connected`) fail(`the Servers line says ${J(nonServer.sub)}, not "${connected} connected"`);
  const baseColour = labels.voice.subColour ?? labels.servers.subColour;
  if (labels.library.value !== "None") fail(`the Prompt library says ${J(labels.library.value)} with no prompts, not "None"`);
  const archivedWant = world.archived === 0 ? "None" : String(world.archived);
  if (labels.archived.value !== archivedWant) fail(`Archived says ${J(labels.archived.value)}, the mock has ${world.archived} archived chats: ${J(archivedWant)}`);
  if (labels.appearance.sub !== "System") fail(`the Appearance line says ${J(labels.appearance.sub)}, not "System" before any choice`);
  if (!labels.about.value) fail("the About row shows no version");
  // (a prompt library the mock fills while the screen is open: the row follows)
  await mockEval(`libraries.local.prompts.push({ id: "p_a", name: "a", parent: "", text: "A." }, { id: "p_b", name: "b", parent: "", text: "B." }); sendLibrary("local");`, url);
  if (!(await until(async () => (await settingsText(page)).library.value === "2 prompts", WAIT))) fail(`the Prompt library says ${J((await settingsText(page)).library.value)} with two prompts, not "2 prompts"`);
  // (a server that cannot be reached: the Servers line names it, in amber)
  {
    // (a second server, then it cannot be reached)
    const other = { id: "s_attic", name: "Attic", address: "https://attic.example:4790", state: "connected", version: "dev" };
    await mockEval(`setServers([${J(other)}]);`, url);
    if (!(await until(async () => (await settingsText(page)).servers.sub === `${connected + 1} connected`, WAIT))) fail(`a second server joined and the Servers line says ${J((await settingsText(page)).servers.sub)}, not "${connected + 1} connected"`);
    await mockEval(`setServerState(${J(other.id)}, "unreachable", { detail: "connection refused" });`, url);
    if (!(await until(async () => /unreachable|can.t reach|not reachable|offline|refused|attention/i.test((await settingsText(page)).servers.sub), WAIT))) fail(`a server dropped and the Servers line says ${J((await settingsText(page)).servers.sub)}`);
    const t = (await settingsText(page)).servers;
    if (!t.sub.includes(other.name) && !/need attention/.test(t.sub)) fail(`the Servers line ${J(t.sub)} does not name ${J(other.name)}`);
    const [r, g, b] = (t.subColour.match(/\d+/g) ?? []).map(Number);
    if (!(r > b + 60 && r >= g) || t.subColour === baseColour) fail(`the Servers line is ${t.subColour}, not amber (the other lines are ${baseColour})`);
    note(`the Servers line with ${other.name} dropped: ${J(t.sub)} in ${t.subColour}`);
    await mockEval(`setServerState(${J(other.id)}, "connected", { version: "dev" });`, url);
    if (!(await until(async () => (await settingsText(page)).servers.sub === `${connected + 1} connected`, WAIT))) fail(`the server is back and the Servers line says ${J((await settingsText(page)).servers.sub)}, not "${connected + 1} connected"`);
    await mockEval(`setServers([]);`, url);
    if (!(await until(async () => (await settingsText(page)).servers.sub === `${connected} connected`, WAIT))) fail(`the server is gone and the Servers line says ${J((await settingsText(page)).servers.sub)}, not "${connected} connected"`);
  }
  await shoot("light-1-settings");

  // ---- each row pushes its screen, and the back lands on Settings with the row there
  for (const r of ROWS) {
    await openRow(page, r);
    if (!(await until(async () => (await topScreen()) === SCREEN_OF[r], WAIT))) fail(`the ${r} row pushed ${J(await topScreen())}, not ${J(SCREEN_OF[r])}`);
    await atRest(page, "pushed-screen", WAIT).catch(() => {});
    const b = await barOf();
    if (b.back !== "Settings") fail(`the back of the ${r} screen says ${J(b.back)}, not "Settings"`);
    await press(page, byTid(page, IDS.back).last());
    await atRest(page, "settings-screen");
    if (!(await byTid(page, "settings-row", { row: r }).last().isVisible())) fail(`back from ${r}: its row is not on Settings`);
    if ((await stackKeys(page)).length !== 2) fail(`back from ${r}: the stack is [${(await stackKeys(page)).join(", ")}]`);
  }

  // ---- About
  await shootAbout("light");

  // ---- Appearance
  await openAppearance(page);
  const sub = async () => (await settingsText(page)).appearance?.sub;
  {
    const foot = await page.evaluate(() => [...document.querySelectorAll('[data-testid="appearance-screen"]')].pop()?.innerText ?? "");
    if (!foot.includes("System follows this device's light or dark setting.")) fail(`Appearance does not say that System follows this device's setting: ${J(foot.slice(0, 200))}`);
    let rows = await rowsOf(page);
    if (rows.map((r) => r.theme).join() !== "light,dark,system") fail(`the theme rows are ${rows.map((r) => r.theme).join(", ")}`);
    const only = (rows, want, tag) => {
      const on = rows.filter((r) => r.checked === "true").map((r) => r.theme);
      if (on.join() !== want) fail(`${tag}: the checked theme rows are [${on.join(", ")}], not [${want}]`);
      if (rows.some((r) => (r.checked === "true") !== r.tick)) fail(`${tag}: a ✓ is drawn on a row that is not checked, or missing on the one that is`);
    };
    only(rows, "system", "before any choice");
    await shoot("light-2-appearance");

    await pickTheme(page, "dark");
    if (!(await until(async () => (await themeNow(page)).theme === "dark", WAIT))) fail(`Dark pressed: data-theme is ${J((await themeNow(page)).theme)}`);
    let now = await themeNow(page);
    if (now.flavour !== null || now.saved !== "dark" || now.bg !== BG.dark) fail(`Dark pressed: ${J(now)}, not data-theme "dark", no flavour, saved "dark", the background ${BG.dark}`);
    if ((await topScreen()) !== "appearance") fail(`Dark pressed: the top screen is ${J(await topScreen())}: the choice left Appearance`);
    rows = await rowsOf(page);
    only(rows, "dark", "Dark pressed");
    await shoot("dark-2-appearance");

    // ---- the flavour sheet
    await openFlavours(page);
    const sheet = await page.evaluate(() => {
      const s = [...document.querySelectorAll('[data-testid="flavour-sheet"]')].pop();
      const text = s.innerText;
      return {
        text,
        rows: [...s.querySelectorAll('[data-testid="picker-row"]')].map((e) => {
          const r = e.getBoundingClientRect();
          const bgs = [...e.querySelectorAll("div")].filter((d) => d.children.length === 0 && !d.textContent.trim()).map((d) => getComputedStyle(d).backgroundColor).filter((c) => c !== "rgba(0, 0, 0, 0)");
          return { value: e.dataset.value, h: r.height, text: e.innerText.replace(/\s+/g, " ").trim(), checked: e.getAttribute("aria-checked"), swatch: new Set(bgs).size >= 2 };
        }),
      };
    });
    if (!sheet.text.includes("Catppuccin flavours") || !sheet.text.includes("How the app looks on this device")) fail(`the flavour sheet's title is ${J(sheet.text.slice(0, 80))}`);
    if (sheet.rows.map((r) => r.value).join() !== FLAVOURS.map((f) => f[0]).join()) fail(`the flavour sheet's rows are [${sheet.rows.map((r) => r.value).join(", ")}]`);
    for (const [v, label, kind] of FLAVOURS) {
      const r = sheet.rows.find((x) => x.value === v);
      if (!r) continue;
      if (r.h < 50) fail(`the ${label} row is ${r.h} px high, under 50`);
      if (!r.text.includes(label) || !r.text.includes(kind)) fail(`the ${label} row says ${J(r.text)}, not ${J(label)} with the note ${J(kind)}`);
      if (!r.swatch) fail(`the ${label} row has no swatch of two colours`);
      if (r.checked === "true") fail(`${label} is marked chosen with no flavour on`);
    }
    await shoot("dark-3-flavours");
    await pickFlavour(page, "mocha");
    now = await themeNow(page);
    if (now.theme !== "dark" || now.flavour !== "mocha" || now.saved !== "mocha" || now.bg !== BG.mocha) fail(`Mocha picked: ${J(now)}, not data-theme "dark", data-flavour "mocha", saved "mocha", the background ${BG.mocha}`);
    if ((await topScreen()) !== "appearance") fail(`Mocha picked: the top screen is ${J(await topScreen())}`);
    const fr = byTid(page, "flavour-row").last();
    if ((await fr.getAttribute("data-flavour")) !== "mocha" || !(await fr.innerText()).includes("Mocha")) fail(`the flavour row says ${J(await fr.innerText())} (${await fr.getAttribute("data-flavour")}) after Mocha`);
    only(await rowsOf(page), "", "Mocha picked");
    await shoot("mocha-2-appearance");
    await openFlavours(page);
    const marked = await page.evaluate(() => [...[...document.querySelectorAll('[data-testid="flavour-sheet"]')].pop().querySelectorAll('[data-testid="picker-row"][aria-checked="true"]')].map((e) => e.dataset.value));
    if (marked.join() !== "mocha") fail(`the flavour sheet marks [${marked.join(", ")}] as chosen, not [mocha]`);
    await shoot("mocha-3-flavours");
    await page.touchscreen.tap(page.viewportSize().width / 2, 30); // (the dimmed page above the sheet)
    if (!(await until(() => page.evaluate(() => !document.querySelector('[data-testid="flavour-sheet"]')), 5000))) await page.keyboard.press("Escape");
    await until(() => page.evaluate(() => !document.querySelector('[data-testid="flavour-sheet"]')), WAIT);
    // Settings says the choice
    await press(page, byTid(page, IDS.back).last());
    await atRest(page, "settings-screen");
    if ((await sub()) !== "Catppuccin Mocha") fail(`Settings' Appearance line says ${J(await sub())}, not "Catppuccin Mocha"`);
    await sizes("Mocha");
    await shoot("mocha-1-settings");
    await shootAbout("mocha");

    // ---- Light turns the flavour off
    await pickTheme(page, "light");
    if (!(await until(async () => (await themeNow(page)).flavour === null, WAIT))) fail(`Light pressed over Mocha: data-flavour is ${J((await themeNow(page)).flavour)}`);
    now = await themeNow(page);
    if (now.theme !== "light" || now.saved !== "light" || now.bg !== BG.light) fail(`Light pressed: ${J(now)}`);
    only(await rowsOf(page), "light", "Light pressed over Mocha");
    const off = byTid(page, "flavour-row").last();
    if ((await off.getAttribute("data-flavour")) !== "off" || !(await off.innerText()).includes("Off")) fail(`the flavour row says ${J(await off.innerText())} after Light, not Off`);
    await press(page, byTid(page, IDS.back).last());
    await atRest(page, "settings-screen");
    if ((await sub()) !== "Light") fail(`Settings' Appearance line says ${J(await sub())}, not "Light"`);

    // ---- the dark Settings: sizes and shots
    await pickTheme(page, "dark");
    await press(page, byTid(page, IDS.back).last());
    await atRest(page, "settings-screen");
    await sizes("dark");
    await shoot("dark-1-settings");
    if ((await sub()) !== "Dark") fail(`Settings' Appearance line says ${J(await sub())}, not "Dark"`);
    await shootAbout("dark");
    // the other flavours apply too
    for (const [v, , kind] of FLAVOURS) {
      await pickFlavour(page, v);
      const n = await themeNow(page);
      if (n.flavour !== v || n.saved !== v || n.theme !== kind.toLowerCase()) fail(`${v} picked: ${J(n)}`);
    }

    // ---- a reload keeps the choice
    await pickFlavour(page, "mocha");
    await page.reload({ waitUntil: "domcontentloaded" });
    await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
    now = await themeNow(page);
    if (now.flavour !== "mocha" || now.theme !== "dark" || now.saved !== "mocha" || now.bg !== BG.mocha) fail(`after a reload: ${J(now)}, not Mocha`);
    await openAppearance(page);
    const again = byTid(page, "flavour-row").last();
    if (!(await until(async () => (await again.innerText()).includes("Mocha"), WAIT))) fail("after a reload the flavour row does not say Mocha");
    only(await rowsOf(page), "", "after a reload");
    await pickTheme(page, "light");
    await page.reload({ waitUntil: "domcontentloaded" });
    await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
    now = await themeNow(page);
    if (now.flavour !== null || now.theme !== "light" || now.saved !== "light") fail(`after a reload of Light: ${J(now)}`);
    await openAppearance(page);
    only(await rowsOf(page), "light", "after a reload of Light");
  }

  // ---- the back after Settings lands on Home
  while ((await stackKeys(page)).length > 2) await press(page, byTid(page, IDS.back).last()), await page.waitForTimeout(400);
  await atRest(page, "settings-screen");
  await press(page, byTid(page, IDS.back).last());
  if (!(await until(async () => (await stackKeys(page)).join() === "home", WAIT))) fail(`the back after Settings: the stack is [${(await stackKeys(page)).join(", ")}], not [home]`);
  if (!(await byTid(page, "home").first().isVisible())) fail("the back after Settings did not land on Home");

  /** About, read in the theme of `tag` (and shot). Settings is on top; it is on top again after. */
  async function shootAbout(tag) {
    await openRow(page, "about", "about-screen");
    await shoot(`${tag}-4-about`);
    if (tag !== "light") return back();
    const m = await readAbout();
    return back(m);
  }
  function readAbout() { return page.evaluate(() => {
      const screen = [...document.querySelectorAll('[data-testid="about-screen"]')].pop();
      return [...screen.querySelectorAll('[data-testid="about-row"]')].map((e) => {
        const r = e.getBoundingClientRect(), v = e.querySelector('[data-testid="cell-value"]');
        return { row: e.dataset.row, h: r.height, text: e.innerText.replace(/\s+/g, " ").trim(), value: v?.textContent.trim() ?? "", chevron: [...e.querySelectorAll("svg")].some((s) => s.getBoundingClientRect().right > r.right - 40), arrow: e.textContent.includes("↗") };
      });
    }); }
  async function back(m) {
    if (m) await aboutChecks(m);
    await press(page, byTid(page, IDS.back).last());
    await atRest(page, "settings-screen");
  }
  async function aboutChecks(rows) {
    if (rows.map((r) => r.row).join() !== "version,help") fail(`About has the rows [${rows.map((r) => r.row).join(", ")}]: it must have version and help, and no server log in the browser`);
    const version = rows.find((r) => r.row === "version"), help = rows.find((r) => r.row === "help");
    const shown = (await settingsText(page)).about;
    void shown;
    if (!version?.value) fail("About's Version row shows no version");
    if (help?.chevron) fail("About's Help row has a chevron: it opens outside the app");
    if (!help?.arrow) fail("About's Help row has no ↗");
    if (rows.some((r) => r.h < 44)) fail(`an About row is under 44 px high: ${J(rows.map((r) => r.h))}`);
    if (await byTid(page, "about-row", { row: "log" }).count()) fail("the browser's About has a Server log row");
    await page.evaluate(() => { window.__opened = []; window.open = (...a) => { window.__opened.push(a); return null; }; });
    await press(page, byTid(page, "about-row", { row: "help" }).last());
    if (!(await until(() => page.evaluate(() => window.__opened.length > 0), 5000))) return fail("a press on Help opened nothing");
    const [href, target, features] = await page.evaluate(() => window.__opened[0]);
    if (!/^https:\/\//.test(href) || target !== "_blank" || !/noopener/.test(features ?? "")) fail(`Help opens ${J([href, target, features])}, not an https address in a new tab with noopener`);
    if ((await topScreen()) !== "about") fail(`Help left About: the top screen is ${J(await topScreen())}`);
    const sv = await page.evaluate(() => [...document.querySelectorAll('[data-testid="settings-row"][data-row="about"] [data-testid="cell-value"]')].pop()?.textContent.trim());
    if (sv !== version.value) fail(`Settings' About row shows ${J(sv)}, About's Version row ${J(version.value)}`);
    note(`About: version ${J(version.value)}, Help opens ${href}`);
  }
  note("Settings, Appearance and About on the phone: rows, sizes, themes and the flavour sheet read; shots in " + OUT);
  void tidSel;
}, { viewports });
