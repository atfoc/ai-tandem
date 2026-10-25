// R1's recipes of Settings, Servers, Voice settings and the prompt library (rules.mjs says what a recipe is): goal 3.8 (Settings, Servers, Voice, the
// library), 3.7.3 (Auto-send is in Settings › Voice alone), 6.1 and 6.2. The ways to each screen are those of UX.S1-settings, UX.S2-servers,
// UX.S3-voice and UX.S4.1 to S4.3: Home's gear, Settings' rows, the list's rows, the sheets' own buttons.
import { until } from "../../shot.mjs";
import { IDS, byTid, back, press, tidSel, touchDrag } from "../sel.mjs";
import { atRest, closeFlavours, openFlavours, openRow, openSettings } from "../settings.mjs";
import { CERT_NOW, IMPOSTOR, STUDIO, STUDIO_CODE } from "../srv.mjs";
import { closeSheet, openAddKey, openChooseVoice, openVoice, sheetGone, sheetShown, typeKey, voiceSettings, voicesLoaded } from "../voicephone.mjs";
import { LIB_EXAMPLE, holdOpen, openGroup, openLibrary, pressSheetRow, seedLibrary } from "../libphone.mjs";

const J = JSON.stringify;
const KEY = "sk_test_R1CANARY1";
const WAIT = 15000;

// ---- shared steps and behaviours

/** The bar on top: its back (text and name) and its title, and whether the title is centred (goal 3.1.2). */
const barNow = (page) => page.evaluate(() => {
  const backs = [...document.querySelectorAll('[data-testid="nav-back"]')], bk = backs[backs.length - 1];
  const bars = [...document.querySelectorAll('[data-testid="place-bar"]')], bar = bars[bars.length - 1];
  const title = bar?.querySelector('[data-testid="bar-title"]');
  let mid = null;
  if (title) { const r = document.createRange(); r.selectNodeContents(title); const b = r.getBoundingClientRect(); mid = (b.left + b.right) / 2; }
  return { back: bk?.innerText.trim() ?? null, backName: bk?.getAttribute("aria-label") ?? null, title: title?.innerText.trim() ?? null, mid, width: innerWidth };
});
/** The back names the screen it goes back to ("‹ Settings") and the title is centred. */
const barIs = (back, title) => async (page, h) => {
  const b = await barNow(page);
  if (b.back !== back) h.fail(`the bar's back says ${J(b.back)}, not ${J(back)}`);
  else if (b.backName !== `Back to ${back}`) h.fail(`the back is named ${J(b.backName)}, not "Back to ${back}"`);
  if (title !== undefined && b.title !== title) h.fail(`the bar's title says ${J(b.title)}, not ${J(title)}`);
  if (b.mid !== null && Math.abs(b.mid - b.width / 2) > 8) h.fail(`the bar's title is not centred (its middle is at ${Math.round(b.mid)}, the window's at ${Math.round(b.width / 2)})`);
};
const topScreen = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop()?.dataset.screen ?? null);
const gone = (page, id) => until(async () => !(await byTid(page, id).last().isVisible().catch(() => false)), WAIT);

/** Settings, pushed from Home's gear. */
const toSettings = (page) => openSettings(page);
/** The Servers list: Settings (when it is not there) and its Servers row. */
const toServers = async (page) => {
  if (await byTid(page, "srv-list").last().isVisible().catch(() => false)) return;
  if (!(await byTid(page, "settings-screen").last().isVisible().catch(() => false))) await openSettings(page);
  await openRow(page, "servers", "srv-list");
  await byTid(page, "srv-row").first().waitFor({ state: "visible", timeout: WAIT });
};
/** A server's detail from the list. */
const toDetail = (id) => async (page) => {
  await toServers(page);
  await press(page, byTid(page, "srv-row", { server: id }));
  await atRest(page, "srv-facts");
};
/** The Add a server flow's Choose how, from the list's "+". */
const toAdd = async (page) => {
  await toServers(page);
  await press(page, byTid(page, "srv-plus").last());
  await sheetShown(page, "add-choose");
};
/** Pressing a P4's Cancel leaves what it asked about alone. */
const cancelP4 = async (page) => {
  await press(page, byTid(page, "confirm-cancel").last());
  await gone(page, "confirm-sheet");
  await gone(page, "confirm-dialog");
};
const closeP1 = async (page, id = "action-sheet") => {
  await page.keyboard.press("Escape");
  await gone(page, id);
};
const UNDO_CERTS = "delete flags.certs; delete flags.app; appCalls.length = 0;";

// ---- Settings, Appearance, About

const settingsRecipes = [
  { id: "settings.settings", goal: "3.8.1 · 01 Settings", seed: ["UXS2"], wait: tidSel("home"),
    steps: [
      { name: "settings", go: toSettings, ready: tidSel("settings-screen"), check: barIs("Home", "Settings") },
      { name: "appearance", go: (page) => openRow(page, "appearance", "appearance-screen"), ready: tidSel("appearance-screen"), check: barIs("Settings", "Appearance") },
      { name: "flavours", go: openFlavours, ready: tidSel("flavour-sheet") },
      { name: "about", go: async (page) => { await closeFlavours(page); await back(page); await atRest(page, "settings-screen"); await openRow(page, "about", "about-screen"); }, ready: tidSel("about-screen"), check: barIs("Settings", "About") },
    ] },
];

// ---- Servers

const serversRecipes = [
  { id: "settings.servers-list", goal: "3.8.2 · 03 Servers (03a)", seed: ["UXS2"], wait: tidSel("home"),
    steps: [
      { name: "list", go: toServers, ready: tidSel("srv-list"), check: barIs("Settings", "Servers") },
    ] },
  { id: "settings.servers-detail-connected", goal: "3.8.2 · 03 Servers (03b), 13 Server sheet", seed: ["UXS2"], wait: tidSel("home"),
    steps: [
      { name: "connected", go: toDetail("s_build"), ready: tidSel("srv-facts", { server: "s_build", place: "screen" }), check: barIs("Servers") },
      { name: "certificate", go: (page) => press(page, byTid(page, "srv-cert-row").last()), ready: tidSel("srv-cert", { server: "s_build", changed: "no" }), check: barIs("Build box") },
      { name: "edit", go: async (page) => { await back(page); await atRest(page, "srv-facts"); await press(page, byTid(page, "srv-edit").last()); }, ready: tidSel("srv-edit-form") },
      { name: "remove", go: async (page) => { await closeSheet(page, "srv-edit-form").catch(() => press(page, byTid(page, "sheet-left").last())); await gone(page, "srv-edit-form"); await press(page, byTid(page, "srv-remove").last()); },
        ready: tidSel("confirm-dialog"),
        check: async (page, h) => {
          if (!(await byTid(page, "confirm-title").last().innerText()).includes("Build box")) h.fail("Remove server's question does not name the server");
          await cancelP4(page);
          await atRest(page, "srv-facts");
          if (!(await byTid(page, "srv-row", { server: "s_build" }).count()) && !(await byTid(page, "srv-facts", { server: "s_build" }).count())) h.fail("Cancel on Remove server removed it");
          const calls = await h.mockEval(`return appCalls.filter((c) => c.op === "servers.remove").length;`);
          if (calls) h.fail("Remove server sent servers.remove before its P4 was confirmed");
        } },
    ], undo: UNDO_CERTS },
  { id: "settings.servers-detail-unreachable", goal: "3.8.2 · 03 Servers (03d)", seed: ["UXS2"], wait: tidSel("home"),
    steps: [{ name: "unreachable", go: toDetail("s_attic"), ready: tidSel("srv-facts", { server: "s_attic", place: "screen" }), check: barIs("Servers") }] },
  { id: "settings.servers-detail-too-old", goal: "3.8.2 · 03 Servers (03d)", seed: ["UXS2"], wait: tidSel("home"),
    steps: [{ name: "too-old", go: toDetail("s_mini"), ready: tidSel("srv-facts", { server: "s_mini", place: "screen" }), check: barIs("Servers") }] },
  { id: "settings.servers-cert-changed", goal: "3.8.2 · 05 Certificate changed (05b, 05c)", seed: ["UXS2"], wait: tidSel("home"),
    steps: [
      { name: "detail", go: toDetail("s_certbox"), ready: tidSel("srv-cert-notice") },
      { name: "compare", go: (page) => press(page, byTid(page, "srv-compare").last()), ready: tidSel("srv-cert", { server: "s_certbox", changed: "yes" }), check: barIs("Cert box") },
      { name: "trust", go: (page) => press(page, byTid(page, "srv-trust").last()), ready: tidSel("confirm-sheet"),
        check: async (page, h) => {
          await cancelP4(page);
          const calls = await h.mockEval(`return appCalls.filter((c) => c.op === "servers.accept").length;`);
          if (calls) h.fail("Cancel on the trust question sent servers.accept");
        } },
    ], undo: UNDO_CERTS },
  { id: "settings.servers-add-match", goal: "3.8.2 · 04 Add a server (04a, 04c, 04d)", seed: ["UXS2"], wait: tidSel("home"), mock: `flags.certs = { "studio.local": ${J(STUDIO)} };`, undo: UNDO_CERTS,
    steps: [
      { name: "choose", go: async (page) => { await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {}); await page.evaluate((t) => navigator.clipboard.writeText(t), STUDIO_CODE); await toAdd(page);
          await until(async () => (await byTid(page, "action-row", { action: "paste" }).first().getAttribute("data-tag").catch(() => null)) === "In clipboard", WAIT); },
        ready: tidSel("add-choose") },
      { name: "check", go: (page) => press(page, byTid(page, "action-row", { action: "paste" }).last()), ready: tidSel("add-form", { step: "check" }) },
      { name: "trust", go: (page) => press(page, byTid(page, "add-test").last()), ready: tidSel("add-form", { step: "trust" }),
        check: async (page, h) => {
          if ((await byTid(page, "add-match", { match: "yes" }).count()) !== 1) h.fail("a fingerprint that matches the code does not say so");
          const calls = await h.mockEval(`return appCalls.filter((c) => c.op === "servers.add").length;`);
          if (calls) h.fail("the trust step added the server before Trust and save was pressed");
        } },
    ] },
  { id: "settings.servers-add-mismatch", goal: "3.8.2 · 04 Add a server (04e)", seed: ["UXS2"], wait: tidSel("home"), mock: `flags.certs = { "studio.local": ${J(IMPOSTOR)} };`, undo: UNDO_CERTS,
    steps: [
      { name: "mismatch", go: async (page) => { await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {}); await page.evaluate((t) => navigator.clipboard.writeText(t), STUDIO_CODE); await toAdd(page);
          await press(page, byTid(page, "action-row", { action: "paste" }).last()); await byTid(page, "add-form", { step: "check" }).last().waitFor({ state: "visible", timeout: WAIT });
          await press(page, byTid(page, "add-test").last()); },
        ready: tidSel("add-form", { step: "mismatch" }),
        check: async (page, h) => {
          if (await byTid(page, "add-trust").count()) h.fail("a certificate that does not match the code offers Trust and save");
          const bad = await byTid(page, "srv-fp-now", { tone: "bad" }).last().locator('[data-testid="srv-fp-block"]').count();
          if (bad !== 16) h.fail(`the presented fingerprint has ${bad} red blocks, not 16`);
          const buttons = await byTid(page, "add-form").last().locator("[role=button]").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.innerText).trim()));
          if (J(buttons) !== J(["Cancel"])) h.fail(`the mismatch step's buttons are ${J(buttons)}, not Cancel alone`);
        } },
    ] },
];

// ---- Voice settings

const voiceRecipes = [
  { id: "settings.voice-nokey", goal: "3.8.5 · Settings › Voice (no key)", seed: [], wait: tidSel("home"),
    steps: [
      { name: "card", go: openVoice, ready: tidSel("vs-nokey-card"), check: barIs("Settings", "Voice") },
      { name: "add-key", go: openAddKey, ready: tidSel("vs-key-sheet") },
    ] },
  { id: "settings.voice-key", goal: "3.8.5 · Settings › Voice (key), 3.7.3", seed: [], wait: tidSel("home"),
    steps: [
      { name: "add-key-typed", go: async (page) => { await openVoice(page); await openAddKey(page);
          // (Paste fills the box from the clipboard, then the eye shows it)
          await page.context().grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {}); await page.evaluate((k) => navigator.clipboard.writeText(k), KEY);
          await press(page, byTid(page, "vs-key-paste").last());
          if (!(await until(async () => (await byTid(page, "vs-key").last().inputValue()) === KEY, 5000))) await typeKey(page, KEY);
          await press(page, byTid(page, "vs-key-eye").last()); },
        ready: tidSel("vs-key-sheet") },
      { name: "test-key", go: async (page) => { await press(page, byTid(page, "vs-key-test").last()); await byTid(page, "vs-key-result").last().waitFor({ state: "visible", timeout: WAIT });
          await until(async () => /Works/.test(await byTid(page, "vs-key-result").last().innerText()), WAIT); },
        ready: tidSel("vs-key-result") },
      { name: "with-key", go: async (page) => { await press(page, byTid(page, "sheet-right").last()); await sheetGone(page, "vs-key-sheet"); await until(async () => (await byTid(page, "vs-screen").last().getAttribute("data-key")) === "saved", WAIT); await atRest(page, "vs-screen"); },
        ready: tidSel("vs-autosend"), autosend: true,
        check: async (page, h) => {
          const sw = page.locator('[role="switch"]').filter({ has: byTid(page, "vs-autosend") }).last();
          const was = (await voiceSettings(page)).autoSend;
          await press(page, sw);
          if (!(await until(async () => (await voiceSettings(page)).autoSend === !was, 5000))) h.fail("Auto-send here did not change the stored setting");
          await press(page, sw);
          await until(async () => (await voiceSettings(page)).autoSend === was, 5000);
        } },
      { name: "language", go: async (page) => { await press(page, byTid(page, "vs-adv-language").last()); await sheetShown(page, "vs-picker"); }, ready: tidSel("vs-picker"), autosend: true /* (the Voice screen under the sheet says it) */ },
      { name: "choose-voice", go: async (page) => { await page.keyboard.press("Escape"); await sheetGone(page, "vs-picker"); await openChooseVoice(page); await voicesLoaded(page); }, ready: tidSel("cv-screen"), check: barIs("Voice", "Choose voice") },
      { name: "choose-voice-search", go: async (page) => { await byTid(page, "cv-search").last().fill("fran"); await until(async () => (await byTid(page, "cv-row").count()) === 1, WAIT); }, ready: tidSel("cv-row", { voice: "vsFrank" }) },
      { name: "choose-voice-playing", go: async (page) => {
          // (the sample's clip is held for a moment, so the playing row is there to read)
          await page.route("**/voice/_preview/**", async (route) => { const r = await route.fetch(); await new Promise((ok) => setTimeout(ok, 4000)); await route.fulfill({ response: r }).catch(() => {}); });
          await byTid(page, "cv-search").last().fill("");
          await press(page, byTid(page, "cv-play", { voice: "vsBob" }).last()); },
        ready: tidSel("cv-play", { voice: "vsBob", playing: "true" }),
        check: async (page) => { await press(page, byTid(page, "cv-play", { voice: "vsBob" }).last()); await page.unroute("**/voice/_preview/**"); } },
      { name: "remove-key", go: async (page) => { await back(page); await atRest(page, "vs-screen"); await press(page, byTid(page, "vs-key-remove").last()); await sheetShown(page, "vs-remove-confirm"); }, ready: tidSel("vs-remove-confirm"), autosend: true /* (the Voice screen under the question says it) */,
        check: async (page, h) => {
          await press(page, byTid(page, "confirm-cancel").last());
          await sheetGone(page, "vs-remove-confirm");
          if ((await byTid(page, "vs-screen").last().getAttribute("data-key")) !== "saved") h.fail("Cancel on Remove key removed the key");
        } },
    ] },
];

// ---- The prompt library

const BUILD = { id: "s_build", name: "Build Box", address: "https://build.example:4790", state: "connected", version: "dev" };
const BUILD_LIB = { groups: [{ id: "g_deploy", name: "deploy", parent: "" }], prompts: [{ id: "p_check", name: "Deploy checklist", parent: "g_deploy", text: "List what to check before a deploy." }] };
const swipeRow = (id) => `[data-testid="swipe-row"][data-id=${J(id)}]`;
const swipe = async (page, id) => {
  const loc = page.locator(swipeRow(id)).last();
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await touchDrag(page, { x: b.x + b.width * 0.7, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.3, y: b.y + b.height / 2 }, { hold: 0 });
  await page.locator(`${swipeRow(id)} [data-testid="swipe-action"]`).first().waitFor({ state: "visible", timeout: WAIT });
};
const libPrepare = (h) => seedLibrary(h.url, LIB_EXAMPLE);

const libraryRecipes = [
  { id: "settings.library-screens", goal: "3.8.6 · 06 Prompt library (06a, 06b)", seed: [], wait: tidSel("home"), prepare: libPrepare,
    steps: [
      { name: "list", go: openLibrary, ready: tidSel("lib-screen"), check: barIs("Settings", "Prompt library") },
      { name: "plus", go: (page) => press(page, byTid(page, "lib-plus").last()), ready: tidSel("action-sheet"),
        check: async (page, h) => { const t = await byTid(page, "sheet-title").last().innerText(); if (!/New in Prompt library/.test(t)) h.fail(`the + sheet is titled ${J(t)}`); } },
      { name: "group", go: async (page) => { await closeP1(page); await openGroup(page, "g_git"); }, ready: tidSel("lib-group-screen"), check: barIs("Prompt library", "git") },
      { name: "group-more", go: (page) => press(page, byTid(page, "lib-more").last()), ready: tidSel("action-sheet") },
      { name: "nested", go: async (page) => { await closeP1(page); await openGroup(page, "g_pr"); }, ready: tidSel("lib-group-screen", { group: "g_pr" }), check: barIs("git", "pull requests") },
    ] },
  { id: "settings.library-swipe-move", goal: "3.8.6 · 06 Prompt library (06c swipe)", seed: [], wait: tidSel("home"), prepare: libPrepare,
    steps: [
      { name: "swipe", go: async (page) => { await openLibrary(page); await swipe(page, "p_sum"); }, ready: `${swipeRow("p_sum")} [data-testid="swipe-action"]` },
      { name: "move-picker", go: (page) => press(page, page.locator(`${swipeRow("p_sum")} [data-testid="swipe-action"][data-action="move"]`).first()), ready: tidSel("move-picker") },
    ] },
  { id: "settings.library-editor", goal: "3.8.6 · 06 Prompt library (editor, P3)", seed: [], wait: tidSel("home"), prepare: libPrepare,
    steps: [
      { name: "editor", go: async (page) => { await openLibrary(page); await openGroup(page, "g_review"); await press(page, byTid(page, "lib-prompt-row", { id: "p_rev1" }).last()); }, ready: tidSel("prompt-editor") },
      { name: "leave", go: async (page) => { await byTid(page, "editor-name").last().fill("Review this change now"); await press(page, byTid(page, "sheet-left").last()); }, ready: tidSel("confirm-sheet"),
        check: async (page, h) => {
          await press(page, byTid(page, "confirm-cancel").last());
          await gone(page, "confirm-sheet");
          if (!(await byTid(page, "prompt-editor").last().isVisible().catch(() => false))) h.fail("Keep editing closed the editor");
        } },
    ] },
  { id: "settings.library-delete-group", goal: "3.8.6 · 06 Prompt library (06b-d delete)", seed: [], wait: tidSel("home"), prepare: libPrepare,
    steps: [
      { name: "group-more", go: async (page) => { await openLibrary(page); await openGroup(page, "g_review"); await press(page, byTid(page, "lib-more").last()); }, ready: tidSel("action-sheet") },
      { name: "delete", go: (page) => pressSheetRow(page, "action-sheet", "delete"), ready: tidSel("confirm-sheet"),
        check: async (page, h) => {
          await cancelP4(page);
          const n = await h.mockEval(`return libraries.local.groups.length;`);
          if (n !== LIB_EXAMPLE.groups.length) h.fail("Cancel on Delete group deleted it");
        } },
    ] },
  { id: "settings.library-offline", goal: "3.8.6 · 06 Prompt library (offline notice)", seed: [], wait: tidSel("home"), prepare: libPrepare,
    undo: `setServers([]); return true;`,
    steps: [{ name: "offline",
      // (the second server joins while the page is open, as UX.S4.1 does it: a library comes with a connection, then the server drops)
      go: async (page, h) => {
        await h.mockEval(`setServers([${J(BUILD)}]); setLibrary("s_build", ${J(BUILD_LIB)}); setServerState("s_build", "connected", { version: "dev" }); return true;`);
        await openLibrary(page);
        await byTid(page, "lib-section", { server: "s_build" }).last().waitFor({ state: "visible", timeout: WAIT });
        await h.mockEval(`setServerState("s_build", "unreachable", { detail: "connection refused" }); return true;`);
      }, ready: tidSel("lib-off-notice") }] },
];

export const recipes = [...settingsRecipes, ...serversRecipes, ...voiceRecipes, ...libraryRecipes];
void [IDS, CERT_NOW, holdOpen];
