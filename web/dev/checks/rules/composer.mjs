// R1's recipes of the composer, its chips and its pickers (rules.mjs says what a recipe is): goal 3.6, 3.7, 6.1, 6.2, the mockups "01 The box",
// "02 The chat's setup", "03 The pickers", "04 The + sheet", "05 A board chat's context", "04 Insert a prompt" (S4), "07 Notices, and the keyboard".
// Seeds: UXC1 (the box, the "+" sheet, the context row, the images), UXC2 (the chip row and its pickers). A board chat's rows are read on UXC1's
// board "Pipeline" (UXB2 opens the pick on a board, which is the board group's screen, not the composer's).
// How each screen is reached is how UX.C1-composer, UX.C2-pickers and UX.S4.3-prompt reach it (composer.mjs: openChoice, phoneChip).
// What the web build cannot show: the soft keyboard (useKeyboardUp is false there: the chip row stays with the box focused; the hiding is the
// device flow's, app/e2e composer-chips). The "box focused" steps below audit the box with the focus in it (the focus-ring rule).
import zlib from "node:zlib";
import { act, byTid, openChat, press, tidSel } from "../sel.mjs";
import { openChoice, phoneChip } from "../composer.mjs";
import { until } from "../../shot.mjs";

const J = JSON.stringify;
const WAIT = 15000;

// ---- helpers

const input = (page) => byTid(page, "composer-input").first();
/** Whether a testID is drawn now. */
const drawn = (page, id, data) => byTid(page, id, data).first().isVisible().catch(() => false);
/** Waits for a testID to be drawn (or gone), then a beat for the sheet to come to rest. */
const waitDrawn = (page, id, on = true, data) => until(async () => (await drawn(page, id, data)) === on, WAIT);
/** Closes the sheet on top (the grabber, a tap outside, Back: here Escape, then the backdrop) and waits until none is open. */
async function leave(page) {
  for (let i = 0; i < 3 && await byTid(page, "sheet-handle").count(); i++) {
    await page.keyboard.press("Escape");
    if (await until(async () => !(await byTid(page, "sheet-handle").count()), 2500)) break;
    if (await byTid(page, "overlay-backdrop").count()) await press(page, byTid(page, "overlay-backdrop").last(), { position: { x: 5, y: 5 } }).catch(() => {});
    await until(async () => !(await byTid(page, "sheet-handle").count()), 2500);
  }
  if (await byTid(page, "sheet-handle").count()) throw new Error("a sheet would not close");
  await page.waitForTimeout(200);
}
/** Focuses the box (a tap on it) and waits for the focus to be there. */
async function focusBox(page) {
  await press(page, input(page));
  await page.waitForFunction(() => document.activeElement?.dataset?.testid === "composer-input", null, { timeout: WAIT });
}
/** Types into the box (the focus first). */
async function typeIn(page, text) {
  await focusBox(page);
  await page.keyboard.type(text);
}
/** Empties the box. */
async function clearBox(page) {
  await focusBox(page);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
}
const openPlus = async (page) => {
  await leave(page);
  await press(page, byTid(page, "composer-plus").first());
  if (!await waitDrawn(page, "plus-sheet")) throw new Error("a tap on + did not open the sheet");
};
/** The controls of the toolbar that are the primary, by testID. */
const primaries = (page) => page.evaluate(() => ["composer-talk", "send", "stop"].filter((id) => {
  const e = document.querySelector(`[data-testid="composer-phone-tools"] [data-testid="${id}"]`);
  return e && e.getBoundingClientRect().width > 1;
}));
/** `h.fail` unless the primaries are exactly `want` (goal 3.7: Talk empty, Send typed, Stop at work with Send beside it once typed). */
async function wantPrimaries(page, h, want, where) {
  const got = await primaries(page);
  if (J(got) !== J(want)) h.fail(`${where}: the toolbar's primary controls are ${J(got)}, not ${J(want)}`);
}
/** The lines the box holds. */
const linesOf = (page) => input(page).evaluate((e) => e.innerText.split("\n").filter((l) => l.trim()).length);


// ---- the blocked states (goal 3.7.1, 6.2: "said once on screen, the box read-only with the draft visible"; v1-design.md §1)

const DRAFT = "Reply to Dana about the staging rollout";
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const times = (hay, needle) => hay.split(needle).length - 1;
/** `e`'s background and the first opaque one around it (the surface it stands on), in the page. */
const groundOf = (page, css) => page.evaluate((c) => {
  const opaque = (v) => !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(v);
  const e = document.querySelector(c);
  if (!e) return null;
  // (the block itself or the first element inside it that is drawn with a ground: a toolbar block is the box's own; a bar is the box's shape)
  const q = [e, ...e.querySelectorAll("*")].find((x) => opaque(getComputedStyle(x).backgroundColor)) ?? e;
  let p = e.parentElement;
  while (p && !opaque(getComputedStyle(p).backgroundColor)) p = p.parentElement;
  return { bg: getComputedStyle(q).backgroundColor, surface: p ? getComputedStyle(p).backgroundColor : null };
}, css);
/** The size of a control, hit slop not counted (the block's buttons are 44 pt boxes themselves). */
async function wantTouch(page, h, id, where) {
  const r = await byTid(page, id).first().boundingBox();
  if (!r) return h.fail(`${where}: ${id} is not drawn`);
  if (r.width < 43.5 || r.height < 43.5) h.fail(`${where}: ${id} is ${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}, under 44 pt`);
}
/** Goal 6.2's line for a blocked state, read from the page: the reason said once (the block once; its sentences once in the page's text, not as
 *  a placeholder, banner, line or thread note), the box read-only and greyed where the block replaces it (the toolbar's place: the box stays,
 *  locked; the box's place: the box is not drawn, the bar has its shape and ground) with the draft in it, and the block's button a 44 pt control.
 *  spec: { kind, place, said, draft?, header?, button?, noButton?, one? }. The header's sub-line says the state's word, not the sentence. */
async function blockedLine(page, h, spec) {
  const w = `the ${spec.kind} block`;
  const text = await bodyText(page);
  if (await byTid(page, "composer-block").count() !== 1) h.fail(`${w}: ${await byTid(page, "composer-block").count()} composer-block elements, not one`);
  if (!await drawn(page, "composer-block", { kind: spec.kind, place: spec.place })) return h.fail(`${w}: no composer-block of kind ${spec.kind} in the ${spec.place} place`);
  for (const sentence of spec.said) if (times(text, sentence) !== 1) h.fail(`${w}: "${sentence}" is on the screen ${times(text, sentence)} times, not once`);
  // not again as a placeholder, a banner, a line or a note in the thread
  if (/Ask or tell/.test(text)) h.fail(`${w}: the box's placeholder is shown under a block`);
  const ph = await input(page).evaluate((e) => e.getAttribute("data-placeholder") || e.getAttribute("placeholder") || e.getAttribute("aria-placeholder") || "").catch(() => "");
  if (ph) h.fail(`${w}: the box has the placeholder ${J(ph)}`);
  const extra = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-err"], [data-testid="model-notice"], [data-testid="empty-reason"], [data-testid="ctx-note"], [data-testid*="notice" i], [data-testid*="banner" i]')]
    .filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.dataset.testid));
  if (extra.length) h.fail(`${w}: the reason is also drawn as ${J([...new Set(extra)])} (said once means the block alone)`);
  if (await byTid(page, "archived-bar").count() > 1) h.fail(`${w}: more than one archived bar`);
  if (spec.header && !spec.header.test(await byTid(page, "chat-head").first().innerText())) h.fail(`${w}: the chat's header does not say ${spec.header}`);
  // the box
  if (spec.place === "toolbar") {
    const box = byTid(page, "composer-box");
    if (await box.getAttribute("data-readonly") !== "true") h.fail(`${w}: the box is not read-only (data-readonly ${J(await box.getAttribute("data-readonly"))})`);
    const before = ((await box.innerText()) ?? "").trim();
    if (spec.draft && !before.includes(spec.draft)) h.fail(`${w}: the draft is not in the box (it holds ${J(before)})`);
    const edit = await input(page).evaluate((e) => ({ ce: e.getAttribute("contenteditable"), ro: e.getAttribute("aria-readonly") ?? e.readOnly ?? e.disabled })).catch(() => null);
    if (edit && edit.ce === "true" && edit.ro !== "true" && edit.ro !== true) h.fail(`${w}: the box is editable (contenteditable true, no read-only mark)`);
    await input(page).click({ force: true, timeout: 3000 }).catch(() => {});
    await page.keyboard.type("zzz");
    const after = ((await box.innerText()) ?? "").trim();
    if (after.includes("zzz")) h.fail(`${w}: text typed into the box went in (${J(after)})`);
    const g = await groundOf(page, tidSel("composer-box"));
    if (!g || g.bg === g.surface) h.fail(`${w}: the box is not greyed: its ground ${J(g?.bg)} is the surface's ${J(g?.surface)}, as a plain box's is`);
  } else if (spec.place === "box") {
    if (await byTid(page, "composer-input").count()) h.fail(`${w}: the box is drawn beside the block that stands in its place`);
    const g = await groundOf(page, tidSel("composer-block", { kind: spec.kind }));
    if (!g || g.bg === g.surface) h.fail(`${w}: the bar is not greyed: its ground ${J(g?.bg)} is the surface's ${J(g?.surface)}`);
  }
  // its button: 44 pt, and the states that have none have none
  for (const id of spec.button ? [spec.button] : []) await wantTouch(page, h, id, w);
  for (const id of spec.noButton ?? []) if (await byTid(page, id).count()) h.fail(`${w}: has ${id}, which this state does not offer`);
}
/** The press of a block's button, then the screen it lands on (`ready`), then `lands` (a check). */
const pressBlock = (id) => async (page) => { await press(page, byTid(page, id).first()); };

// ---- seeds

const LIBRARY = {
  groups: [{ id: "g_git", name: "git", parent: "" }, { id: "g_pr", name: "pull requests", parent: "g_git" }],
  prompts: [
    { id: "p_top", name: "Plain words", parent: "", text: "Reply in plain words." },
    { id: "p_title", name: "PR title", parent: "g_pr", text: "Suggest three titles for this pull request.\nKeep each under 60 characters." },
    { id: "p_commit", name: "Commit message", parent: "g_git", text: "Write a commit message for the staged changes." },
  ],
};
const setLibrary = (h) => h.mockEval(`setLibrary("local", ${J(LIBRARY)});`);
const SHOP = "/Users/demo/projects/shop";
const MANY = Array.from({ length: 16 }, (_, i) => `module-${String(i + 1).padStart(2, "0")}`);

export const recipes = [
  // =============== UXC1: the box
  { id: "composer.new-chat", goal: "3.6 · 01 The box, 02 The chat's setup", seed: ["UXC1"], state: "UXC1.new", wait: tidSel("composer-input"),
    steps: [
      { name: "new chat: chip row and Talk", ready: tidSel("composer-chip-row"),
        check: async (page, h) => {
          await wantPrimaries(page, h, ["composer-talk"], "an empty box");
          const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-chip-row"] [data-testid="tchip"]')].map((e) => e.dataset.kind));
          if (J(kinds) !== J(["agent", "folder", "model", "subagents"])) h.fail(`the chip row holds ${J(kinds)}, not agent, folder, model, subagents`);
        } },
      { name: "box focused (the web build has no keyboard: the row stays)", go: async (page) => { await focusBox(page); } },
      { name: "typed: Send", go: async (page) => { await page.keyboard.type("Hello"); }, ready: tidSel("send"),
        check: async (page, h) => {
          await wantPrimaries(page, h, ["send"], "a typed box");
          // Return adds a line and sends nothing (goal 3.7)
          await page.keyboard.press("Enter");
          await page.keyboard.type("second line");
          if (await linesOf(page) !== 2) h.fail("Return did not add a line to the box");
          if (!await drawn(page, "send")) h.fail("Return sent the message (the toolbar is not Send any more)");
        } },
    ] },

  { id: "composer.started", goal: "3.6, 3.7 · 01 The box, 04 The + sheet", seed: ["UXC1"], state: "UXC1.started", wait: tidSel("composer-input"), prepare: setLibrary,
    steps: [
      { name: "started chat: empty box, Talk, no chip row", ready: tidSel("composer-talk"),
        check: async (page, h) => {
          await wantPrimaries(page, h, ["composer-talk"], "an empty box");
          if (await byTid(page, "composer-chip-row").count()) h.fail("a started chat draws the chip row");
        } },
      { name: "+ sheet: Add to message", go: async (page) => { await openPlus(page); },
        check: async (page, h) => {
          const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid="plus-sheet"] [data-testid="action-row"]')].map((e) => e.dataset.action));
          for (const none of ["selection", "point"]) if (ids.includes(none)) h.fail(`a plain chat's + sheet has the board row ${none}`);
          if (!(await byTid(page, "plus-sheet").first().innerText()).includes("Add to message")) h.fail("the + sheet's head is not Add to message");
        } },
      { name: "Insert a prompt sheet", go: async (page) => { await press(page, byTid(page, "action-row", { action: "prompt" }).first()); }, ready: tidSel("insert-popup") },
      { name: "Insert a prompt: search", go: async (page) => {
          const field = byTid(page, "insert-popup").locator("input").first();
          await field.fill("commit");
        }, ready: tidSel("insert-row") },
      { name: "the context ring's sheet", go: async (page) => { await leave(page); await press(page, byTid(page, "ctx-meter").first()); }, ready: tidSel("usage-sheet") },
      { name: "typed: Send (no Talk)", go: async (page) => { await leave(page); await typeIn(page, "A question"); }, ready: tidSel("send"),
        check: async (page, h) => { await wantPrimaries(page, h, ["send"], "a typed box"); } },
    ] },

  { id: "composer.busy", goal: "3.7 · 01 The box (the agent works)", seed: ["UXC1"], state: "UXC1.busy", wait: tidSel("composer-input"),
    steps: [
      { name: "the agent works: Stop", ready: tidSel("stop"),
        check: async (page, h) => { await wantPrimaries(page, h, ["stop"], "an empty box at work"); } },
      { name: "typed at work: Send beside Stop", go: async (page) => { await typeIn(page, "next"); }, ready: tidSel("send"),
        check: async (page, h) => { await wantPrimaries(page, h, ["send", "stop"], "a typed box at work"); } },
    ] },

  { id: "composer.images", goal: "3.6 · 01 The box (images)", seed: ["UXC1"], state: "UXC1.started", wait: tidSel("composer-input"),
    prepare: (h) => h.mockEval("flags.upload = { hold: true };"),
    undo: "release('upload'); delete flags.upload; catalogs.claude.models.forEach((m) => { delete m.noImages; });",
    steps: [
      { name: "an upload that waits: thumb, ring, ×",
        go: async (page) => {
          await openPlus(page);
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), press(page, byTid(page, "action-row", { action: "files" }).first())]);
          await chooser.setFiles([{ name: "diagram.png", mimeType: "image/png", buffer: PNG(1) }]);
        }, ready: tidSel("image-thumb-busy") },
      { name: "a refused image: marked tile and its reason",
        go: async (page, h) => {
          await h.mockEval("release('upload'); delete flags.upload;");
          await openPlus(page);
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), press(page, byTid(page, "action-row", { action: "files" }).first())]);
          await chooser.setFiles([{ name: "IMG_2041.HEIC", mimeType: "image/heic", buffer: Buffer.from("heic") }]);
        }, ready: tidSel("composer-images-line") },
      { name: "the limit line (11 images) and the dimmed Files row",
        go: async (page) => {
          for (let i = 0; i < 5 && await byTid(page, "image-refused-remove").count(); i++) await press(page, byTid(page, "image-refused-remove").first());
          for (let i = 0; i < 5 && await byTid(page, "image-thumb-remove").count(); i++) await press(page, byTid(page, "image-thumb-remove").first());
          await openPlus(page);
          const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), press(page, byTid(page, "action-row", { action: "files" }).first())]);
          await chooser.setFiles(Array.from({ length: 11 }, (_, i) => ({ name: `IMG_${i + 1}.png`, mimeType: "image/png", buffer: PNG(100 + i) })));
        }, ready: tidSel("composer-images-line", { kind: "count" }) },
      { name: "+ sheet at the limit: Files dimmed with the reason", go: async (page) => { await openPlus(page); },
        check: async (page, h) => {
          const files = await page.evaluate(() => { const e = document.querySelector('[data-testid="plus-sheet"] [data-testid="action-row"][data-action="files"]'); return e && { text: e.innerText, off: e.getAttribute("aria-disabled") === "true" || getComputedStyle(e).opacity < 1 || !!e.querySelector('[aria-disabled="true"]') }; });
          if (!files?.off) h.fail(`the Files row is not dimmed at the limit of images: ${J(files)}`);
        } },
      { name: "a model without images: Files dimmed with the model's name",
        go: async (page, h) => {
          await leave(page);
          for (let i = 0; i < 12 && await byTid(page, "image-thumb-remove").count(); i++) await press(page, byTid(page, "image-thumb-remove").first());
          await h.mockEval(`catalogs.claude.models.find((m) => m.id === "opus").noImages = true;`);
          await page.reload();
          await byTid(page, "composer-input").first().waitFor({ state: "visible", timeout: WAIT });
          await openPlus(page);
        } },
    ] },

  { id: "composer.board-chat", goal: "3.6 · 04 The + sheet, 05 A board chat's context", seed: ["UXC1"], state: "UXC1.board-started", wait: tidSel("composer-input"),
    steps: [
      { name: "board chat: context row", ready: tidSel("context-row") },
      { name: "+ sheet in a board chat: Add selection, Point at", go: async (page) => { await openPlus(page); },
        check: async (page, h) => {
          const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid="plus-sheet"] [data-testid="action-row"]')].map((e) => e.dataset.action));
          for (const want of ["files", "prompt", "selection", "point"]) if (!ids.includes(want)) h.fail(`a board chat's + sheet has no ${want} row (${ids.join(", ")})`);
        } },
      { name: "the @ dock", go: async (page) => { await leave(page); await typeIn(page, "@r"); }, ready: tidSel("mention-dock") },
    ] },

  { id: "composer.board-draft", goal: "3.6 · 05 A board chat's context (a mention and two quotes)", seed: ["UXC1"], state: "UXC1.board-draft", wait: tidSel("composer-input"),
    steps: [
      { name: "context row: board chip, @, 2 quotes", ready: tidSel("qcount") },
      { name: "Quoted in this message", go: async (page) => { await press(page, byTid(page, "qcount").first()); }, ready: tidSel("quotes-sheet") },
    ] },

  // =============== UXC2: the chip row and its pickers
  { id: "composer.chips", goal: "3.6 · 02 The chat's setup, 03 The pickers", seed: ["UXC2"], state: "UXC2.new", wait: tidSel("composer-input"),
    steps: [
      { name: "Agent picker", go: async (page) => { await openChoice(page, "agent"); },
        check: async (page, h) => {
          const sheet = byTid(page, "agent-sheet");
          if (await byTid(sheet, "sheet-right").count()) h.fail("the Agent picker has a Done: a tap chooses and closes (P2)");
          if (await byTid(sheet, "sheet-left").count()) h.fail("the Agent picker has a Cancel");
        } },
      { name: "Agent: a tap chooses and closes",
        go: async (page) => { await press(page, byTid(page, "agent-sheet").locator(tidSel("picker-row", { value: "claude" }))); await byTid(page, "agent-sheet").waitFor({ state: "detached", timeout: WAIT }); },
        check: async (page, h) => { if (await byTid(page, "agent-sheet").count()) h.fail("a tap on an agent did not close the picker"); } },
      { name: "Model and effort", go: async (page) => { await openChoice(page, "model"); },
        check: async (page, h) => {
          const sheet = byTid(page, "model-sheet");
          if (!await byTid(sheet, "model-menu-done").count()) h.fail("Model and effort has no Done");
          if (!await byTid(sheet, "model-menu-cancel").count()) h.fail("Model and effort has no Cancel (its picks are a draft: plans/model-effort-menu/design.md 2.1)");
          const rows = byTid(sheet, "model-menu-row");
          if (await rows.count() > 1) {
            await press(page, rows.nth(1));
            await page.waitForTimeout(400);
            if (!await byTid(page, "model-sheet").count()) h.fail("a tap on a model closed the sheet: only Done and Cancel close Model and effort");
          }
        } },
      { name: "Subagents", go: async (page) => { await leave(page); await openChoice(page, "subagents"); },
        check: async (page, h) => {
          const sheet = byTid(page, "sub-sheet");
          if (!await byTid(sheet, "sheet-right").count()) h.fail("Subagents has no Done");
          if (await byTid(sheet, "sheet-left").count()) h.fail("Subagents has a Cancel");
        } },
      { name: "Folder: Start the agent in", go: async (page) => { await leave(page); await openChoice(page, "folder"); }, ready: tidSel("dir-item"),
        check: async (page, h) => {
          const sheet = byTid(page, "folder-sheet");
          if (!await byTid(sheet, "sheet-left").count()) h.fail("the Folder picker has no Cancel");
          if (await byTid(sheet, "sheet-right").count()) h.fail("the Folder picker has a Done: it has Use <folder>");
          const use = (await byTid(sheet, "dir-use").first().innerText().catch(() => "")).trim();
          if (!/^Use /.test(use)) h.fail(`the folder sheet's button says ${J(use)}, not "Use <folder>"`);
        } },
      { name: "Folder: an empty folder", go: async (page) => { await press(page, byTid(page, "folder-sheet").locator(`${tidSel("dir-item")}[aria-label="docs"]`).first()); }, ready: tidSel("dir-empty") },
      { name: "Folder: Up", go: async (page) => { await press(page, byTid(page, "dir-up").first()); }, ready: tidSel("dir-item") },
      { name: "Folder: the path typed (keyboard up: a short window)",
        go: async (page, h) => {
          await press(page, byTid(page, "dir-path").first());
          await byTid(page, "dir-input").first().waitFor({ state: "visible", timeout: WAIT });
          h.vp = page.viewportSize();
          await page.setViewportSize({ width: h.vp.width, height: Math.round(h.vp.height * 0.55) }); // (a soft keyboard takes about 45 % of a phone)
          await page.waitForTimeout(500);
        },
        check: async (page, h) => {
          if (process.env.R1_OUT) await page.screenshot({ path: `${process.env.R1_OUT}/composer.folder-keyboard-up.${h.theme}.png` }).catch(() => {}); // (the evidence of the Sheet footer item)
          const r = await byTid(page, "dir-use").first().boundingBox(), vh = page.viewportSize().height;
          if (!r || r.y < 0 || r.y + r.height > vh + 0.5) h.fail(`"Use <folder>" is not in the window with the path typed: ${J(r)} in ${vh} px`);
          else if (await page.evaluate(() => { const e = document.querySelector('[data-testid="dir-use"]'); const b = e.getBoundingClientRect(); const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !(e === at || e.contains(at)); })) h.fail(`"Use <folder>" is covered with the path typed`);
          await page.setViewportSize(h.vp);
          await page.waitForTimeout(300);
        } },
    ] },

  { id: "composer.chips-long-folder", goal: "3.6 · 03 The pickers (a long folder list)", seed: ["UXC2"], state: "UXC2.new", wait: tidSel("composer-input"),
    prepare: (h) => h.mockEval(`TREE[${J(SHOP)}] = ${J(MANY)}; ${MANY.map((m) => `TREE[${J(SHOP + "/" + m)}] = [];`).join(" ")}`),
    undo: `TREE[${J(SHOP)}] = ["docs", "web"]; ${MANY.map((m) => `delete TREE[${J(SHOP + "/" + m)}];`).join(" ")}`,
    steps: [
      { name: "Folder: a long list, scrolled to its end",
        go: async (page) => {
          await openChoice(page, "folder");
          await byTid(page, "dir-item").first().waitFor({ state: "visible", timeout: WAIT });
          await byTid(page, "dir-item").last().scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
        },
        check: async (page, h) => {
          const r = await byTid(page, "dir-use").first().boundingBox(), vh = page.viewportSize().height;
          if (!r || r.y < 0 || r.y + r.height > vh + 0.5) h.fail(`"Use <folder>" is out of the window with a long folder list scrolled: ${J(r)} in ${vh} px`);
        } },
    ] },

  { id: "composer.chips-pi", goal: "3.6 · 03 The pickers (Model and effort with headings)", seed: ["UXC2"], state: "UXC2.pi", wait: tidSel("composer-input"),
    steps: [
      { name: "pi: Model and effort with provider headings", go: async (page) => { await openChoice(page, "model"); }, ready: tidSel("menu-head") },
      { name: "pi: search", go: async (page) => { await byTid(page, "model-sheet").locator("input").first().fill("gemini"); await page.waitForTimeout(300); } },
    ] },

  { id: "composer.chips-missing", goal: "3.6 · 02 The chat's setup (an agent the server lacks)", seed: ["UXC2"], state: "UXC2.missing", wait: tidSel("composer-input"),
    steps: [{ name: "the agent chip red, the reason line", ready: tidSel("agent-reason") }] },

  { id: "composer.chips-fork", goal: "3.6 · 02 The chat's setup (a fork: the model alone)", seed: ["UXC2"], state: "UXC2.fork", wait: tidSel("composer-input"),
    steps: [{ name: "a fork: the model chip alone with its note", ready: tidSel("chip-note") }] },

  // =============== V1: the blocked states (goal 3.7.1; seed UXV1, reached as UX.V1-voice reaches them: the state's chat, a server dropped by `act`)
  { id: "composer.v1-offline", goal: "3.7.1 · 07 Notices (offline)", seed: ["UXV1"], state: "UXV1.draft-off", wait: tidSel("composer-input"),
    undo: "setServerState('s_uxv1', 'connected');",
    steps: [
      { name: "connected: the draft in a plain box", ready: tidSel("composer-phone-tools"),
        check: async (page, h) => {
          if (!(await byTid(page, "composer-box").innerText()).includes(DRAFT)) h.fail("the connected chat's box does not hold its draft");
          if (await byTid(page, "composer-block").count()) h.fail("a connected chat draws a block");
        } },
      { name: "offline: the toolbar's place says it", go: async (page, h) => { await act(page, h.state.act); }, ready: tidSel("composer-block", { kind: "offline", place: "toolbar" }),
        check: (page, h) => blockedLine(page, h, { kind: "offline", place: "toolbar", said: ["Design Mac is offline since", "Your draft is kept until it's back."], draft: DRAFT, header: /offline/i, button: "block-servers" }) },
      { name: "Servers: the server's detail", go: pressBlock("block-servers"), ready: tidSel("srv-facts"),
        check: async (page, h) => { if (!(await byTid(page, "srv-facts").first().innerText()).includes("Design Mac") && !(await page.locator("body").innerText()).includes("Design Mac")) h.fail("Servers did not land on Design Mac's detail"); } },
      { name: "back: the chat, still blocked once", go: async (page) => { await press(page, byTid(page, "nav-back").last()); }, ready: tidSel("composer-block", { kind: "offline" }),
        check: (page, h) => blockedLine(page, h, { kind: "offline", place: "toolbar", said: ["Design Mac is offline since", "Your draft is kept until it's back."], draft: DRAFT, header: /offline/i, button: "block-servers" }) },
    ] },

  { id: "composer.v1-gone", goal: "3.7.1 · 07 Notices (the chat is no longer on its server)", seed: ["UXV1"], state: "UXV1.gone", wait: tidSel("composer-input"), fresh: true,
    steps: [
      { name: "the server dropped the chat: the toolbar's place says it", ready: tidSel("composer-block", { kind: "gone", place: "toolbar" }),
        check: (page, h) => blockedLine(page, h, { kind: "gone", place: "toolbar", said: ["This chat is no longer on Design Mac."], noButton: ["block-servers", "unarchive"] }) },
    ] },

  { id: "composer.v1-archived", goal: "3.7.1 · 07 Notices (archived)", seed: ["UXV1"], state: "UXV1.arch", wait: tidSel("composer-block"), fresh: true,
    steps: [
      { name: "archived: one bar in the box's place", ready: tidSel("composer-block", { kind: "archived", place: "box" }),
        check: (page, h) => blockedLine(page, h, { kind: "archived", place: "box", said: ["This chat is archived.", "Unarchive it to send a message. It goes back to the list with the others."], button: "unarchive" }) },
      { name: "Unarchive: the box is back", go: pressBlock("unarchive"), ready: tidSel("composer-input"),
        check: async (page, h) => {
          if (await byTid(page, "composer-block").count()) h.fail("the block stays after Unarchive");
          if (await h.mockEval("return !!chats.c_UXV1_arch.archived;")) h.fail("Unarchive did not unarchive the chat");
        } },
    ] },

  { id: "composer.v1-archived-offline", goal: "3.7.1 · 07 Notices (archived and offline)", seed: ["UXV1"], state: "UXV1.arch-off", wait: tidSel("composer-block"),
    undo: "setServerState('s_uxv1', 'connected');",
    steps: [
      { name: "archived and offline: the bar says both, no button", go: async (page, h) => { await act(page, h.state.act); }, ready: tidSel("composer-block", { kind: "archived", place: "box" }),
        check: async (page, h) => {
          await blockedLine(page, h, { kind: "archived", place: "box", said: ["This chat is archived.", "Design Mac is offline since"], header: /offline/i, noButton: ["unarchive", "block-servers"] });
        } },
    ] },

  { id: "composer.v1-no-agent", goal: "3.7.1 · 07 Notices (no agent)", seed: ["UXV1"], state: "UXV1.noagent", wait: tidSel("composer-block"),
    steps: [
      { name: "a started chat: the bar in the box's place", ready: tidSel("composer-block", { kind: "noagent", place: "box" }),
        check: (page, h) => blockedLine(page, h, { kind: "noagent", place: "box", said: ["No agent is installed on Bare box.", "Install Claude Code, Cursor or pi on that computer, then come back."], noButton: ["unarchive", "block-servers"] }) },
      { name: "a new chat on that server: the same, once (the empty thread does not repeat it)", go: async (page) => { await openChat(page, "s_uxv1_bare~c_UXV1_bare_new"); }, ready: tidSel("composer-block", { kind: "noagent", place: "box" }),
        check: async (page, h) => {
          await blockedLine(page, h, { kind: "noagent", place: "box", said: ["No agent is installed on Bare box."], noButton: ["unarchive", "block-servers"] });
          // (no chip row stands above the bar: the empty thread's hint to the chips "above the box" would point at nothing)
          if (await byTid(page, "config-hint").count()) h.fail(`the empty thread hints at chips that are not there: ${J(await byTid(page, "config-hint").first().innerText())}`);
        } },
    ] },

  { id: "composer.v1-old-board-connection", goal: "3.7.1 · 07 Notices (an old board connection)", seed: ["UXV1"], state: "UXV1.legacy-board", wait: tidSel("composer-block"), fresh: true,
    steps: [
      { name: "a board chat of the old connection: the bar in the box's place", ready: tidSel("composer-block", { kind: "legacy", place: "box" }),
        check: (page, h) => blockedLine(page, h, { kind: "legacy", place: "box", said: ["This chat used the old board connection.", "Start a new chat on this board to go on."], button: "block-newchat" }) },
      { name: "New chat on this board: an empty chat on the board", go: pressBlock("block-newchat"), ready: tidSel("empty-thread"),
        check: async (page, h) => {
          if (!(await byTid(page, "ctx-chip", { kind: "board" }).first().innerText()).includes("Sketch")) h.fail("the new chat is not on the board \"Sketch\"");
          if (await byTid(page, "composer-block").count()) h.fail("the new chat is blocked too");
        } },
    ] },

  { id: "composer.v1-model-too-small", goal: "3.7.1 · 07 Notices (a model too small)", seed: ["UXV1"], state: "UXV1.toosmall", wait: tidSel("composer-block"),
    steps: [
      { name: "amber card above the box", ready: tidSel("composer-block", { kind: "toosmall", place: "above" }),
        // (the design keeps the box itself writable here: only Send is greyed, so a person can type while picking a model)
        check: async (page, h) => {
          const text = await bodyText(page);
          if (times(text, "too small a context window") !== 1) h.fail(`the reason is on the screen ${times(text, "too small a context window")} times, not once`);
          if (await byTid(page, "composer-block").count() !== 1) h.fail("more than one composer-block");
          if (await byTid(page, "composer-block", { kind: "toosmall" }).locator(tidSel("block-dismiss")).count()) h.fail("the amber card has a × (it has none)");
          if (await byTid(page, "composer-err").count()) h.fail("a red line is drawn beside the amber card");
          if (await byTid(page, "model-notice", { warn: true }).count() !== 1) h.fail("the amber card's line is not the one model notice");
          if (/Ask or tell/.test(text) === false && !(await input(page).count())) h.fail("the box is not drawn under the card");
          await wantTouch(page, h, "block-pick-model", "the amber card");
        } },
      { name: "typed: the draft is visible and Send is greyed with the reason", go: async (page) => { await typeIn(page, "hello"); }, ready: tidSel("send"),
        check: async (page, h) => {
          const send = byTid(page, "send").first();
          if (!await until(async () => (await send.getAttribute("aria-disabled")) === "true", 5000)) h.fail("Send is not greyed with a model too small");
          else if (!/too small a context window/.test((await send.getAttribute("aria-label")) ?? "")) h.fail(`Send's label is ${J(await send.getAttribute("aria-label"))}, not the reason`);
          if (!(await byTid(page, "composer-box").innerText()).includes("hello")) h.fail("the typed draft is not visible in the box");
        } },
      { name: "Pick a model: the model sheet", go: pressBlock("block-pick-model"), ready: tidSel("model-sheet"),
        check: async (page, h) => { if (!await byTid(page, "model-sheet").first().isVisible()) h.fail("Pick a model did not open the model sheet"); } },
    ] },

  { id: "composer.v1-refused-send", goal: "3.7.1 · 07 Notices (a refused send)", seed: ["UXV1"], state: "UXV1.plain", wait: tidSel("composer-input"),
    prepare: (h) => h.mockEval(`flags.send = { refuse: { status: 409, code: "agent_missing", error: "Claude Code is not installed on this computer" } };`),
    undo: "delete flags.send;",
    steps: [
      { name: "a typed message", go: async (page) => { await typeIn(page, "Does the tax rounding have the same problem?"); }, ready: tidSel("send") },
      { name: "refused: the red card above the box", go: async (page) => { await press(page, byTid(page, "send").first()); }, ready: tidSel("composer-block", { kind: "refused", place: "above" }),
        check: async (page, h) => {
          const reason = "Claude Code is not installed on this computer", text = await bodyText(page);
          if (times(text, reason) !== 1) h.fail(`the reason is on the screen ${times(text, reason)} times, not once`);
          if (await byTid(page, "composer-block").count() !== 1) h.fail("more than one composer-block");
          if (await byTid(page, "composer-block", { kind: "refused" }).locator(tidSel("composer-err")).count() !== 1) h.fail("the reason is not the card's own line");
          if (await byTid(page, "composer-err").count() !== 1) h.fail(`${await byTid(page, "composer-err").count()} composer-err lines, not the card's one`);
          if (await byTid(page, "model-notice").count()) h.fail("a model notice is drawn beside the refused card");
          if (!(await byTid(page, "composer-box").innerText()).includes("Does the tax rounding")) h.fail("the text left the box");
          await wantTouch(page, h, "block-dismiss", "the refused card");
        } },
      { name: "×: the card goes, the text stays", go: async (page) => { await press(page, byTid(page, "block-dismiss").first()); }, ready: tidSel("composer-box"),
        check: async (page, h) => {
          if (!await until(async () => (await byTid(page, "composer-block").count()) === 0, 5000)) h.fail("× did not remove the card");
          if (!(await byTid(page, "composer-box").innerText()).includes("Does the tax rounding")) h.fail("× took the text out of the box");
        } },
    ] },

];

/** A 1×1 PNG of the colour `n` (distinct pictures: the box does not take them for one image), as UX.C1-composer makes them. */
function PNG(n) {
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, n & 255, (n >> 8) & 255, 100 + n]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
