// L21 (new in the app, AD-80; package rn-sw-focus): the overlays' own focus rule (`app/src/ui/modal.web.tsx`), at the three viewports, on the mock. react-native-web's `Modal`
// pulled a focus that landed outside it back inside while it was mounted, and gave the focus back on its way out to whatever had it when it opened, whatever had the focus by then;
// the screens had timers and microtasks to get around both. The rule that replaced it, as the old page's popups kept it: an overlay that opens takes the focus; Tab and Shift+Tab
// cycle inside the top one; when it closes the focus goes back to the control that opened it, but only if the focus is still inside it or nowhere, so a field a screen focused as the
// overlay closed keeps it. No screen waits for the overlay to be gone any more.
//   (a) A menu's item that opens a field: the field has the focus right after the press and a typed word goes into it, and it keeps the focus. The fork label from a message's
//       actions (a finger's menu; a mouse has a bar, not a menu) and from a row's menu in the tree popup (a menu over a popup), and the library's "New prompt" from a row's menu.
//   (b) A menu that closes gives the focus back to its trigger: with Esc, with a pick, and with a press on the dimmed page (the model's list, a popover, a sheet on the phone).
//   (c) Tab and Shift+Tab from the last and the first control of an overlay stay in it, in a popup of the composer, in a question and in the library's dialog, and never reach the
//       page behind.
//   (d) An overlay over an overlay: Tab cycles in the top one only, and closing it gives the focus to the one under it (the library's dialog with a question over it: Cancel and Esc give
//       the focus to the button that asked; a menu's pick that asks gives it to where the menu came from).
import { callMatcher, check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, longPress, openFoot, press, showList, tidSel } from "./sel.mjs";
import { pressSheetRow } from "./libphone.mjs";
import { chip, closeChoice, openChoice, openState, phoneChip } from "./composer.mjs";
import { firstMsg, menuOfRow, openTree, pressAct, treeRow } from "./fork.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const MSG = '[data-testid="msg"]';
const TWO = "c_A4_two";
const LABEL = callMatcher(/^PUT \/api\/chats\/[^/]+\/label/);
const LIBRARY = { groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [{ id: "p_review", name: "review", parent: "g_git", text: "Review this change." }, { id: "p_todo", name: "todo", parent: "", text: "TODO: " }] };

/** In the page: what has the focus, as the testID of it or of its nearest ancestor that has one, and whether it is inside the top overlay (the last `aria-modal`). */
const where = (page) => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { id: "nothing", top: false, over: 0 };
  const layers = [...document.querySelectorAll('[aria-modal="true"]')], top = layers[layers.length - 1];
  return { id: a.closest("[data-testid]")?.dataset.testid ?? a.tagName, top: !!top && top.contains(a), over: layers.length };
});

/** A word typed right after a press goes where the focus is: waits for `id` to have it, types, and reads the field after a few more frames (a focus that is pulled away later shows). */
async function typedInto(page, id, word, say, what) {
  if (!await until(async () => (await where(page)).id === id, 5000)) return say(`${what}: the focus is on ${(await where(page)).id}, not on ${id}`);
  await page.keyboard.type(word);
  await page.evaluate(() => new Promise((ok) => { let n = 0; const f = () => (++n < 20 ? requestAnimationFrame(f) : ok()); f(); }));
  const field = byTid(page, id).first();
  if ((await where(page)).id !== id) say(`${what}: the focus left ${id} for ${(await where(page)).id} after the word was typed`);
  else if (await field.inputValue().catch(() => null) !== word) say(`${what}: the word typed went to ${JSON.stringify(await field.inputValue().catch(() => null))}, not to ${id}`);
}

await check("L21 the overlays' focus: a field opened by a menu keeps it, a menu gives it back, Tab stays in the top overlay", async ({ url, layout, open, fail, note, touch }) => {
  const say = (line) => fail(line);

  // ---- (a) the fork label, from a message's actions and from a row of the tree popup
  {
    await seed(url, "A4");
    const { page, ctx } = await open({ sel: { chat: TWO }, wait: MSG });
    await page.route(LABEL, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ labels: [] }) }));
    await pressAct(page, await firstMsg(page), "label");
    await typedInto(page, "fk-label-input", "Thread", say, "Label from a message's actions");
    await page.keyboard.press("Enter");
    await until(async () => !await byTid(page, "fk-label-field").count(), 5000);
    await openTree(page);
    await menuOfRow(page, treeRow(page, "text", "Because of the font copy step"));
    // (the phone's row has a sheet of actions, the wide layouts' a menu: both end in the label field)
    await press(page, layout === "phone" ? byTid(page, "action-row", { action: "label" }).first() : byTid(page, "fk-ctx-item", { kind: "label" }).first());
    await typedInto(page, "fk-label-input", "Tree", say, "Label from a row's menu over the tree popup");
    await page.keyboard.press("Enter");
    if (!await until(async () => !await byTid(page, "fk-label-input").count(), 5000)) say("Enter in the tree's label field did not end it");
    await ctx.close();
  }

  // ---- (a) the library's "New prompt" from a row's menu, (d) a question over the library
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const fresh = seeded.find((s) => s.id === "plain-new") ?? fail("the seed has no state plain-new");
  await mockEval(`setServers([]); setLibrary("local", ${JSON.stringify(LIBRARY)});`, url);
  if (layout === "phone") {
    // The phone has no library dialog: the library is S4's pushed screens (Settings › Prompt library, `lib-screen`), its "+" a sheet of New prompt / New group, the prompt editor a form
    // sheet (`prompt-editor`) and a leave with a change a question over it (`confirm-sheet`). Wide-only, so not asserted here (goal 3.1.3: keyboard focus rules are for a keyboard):
    // the focus a closing overlay gives back to its opener, Tab and Shift+Tab staying in the top overlay, a row's menu with its first entry focused. Kept: a field the press
    // opens has the focus at once and keeps it, and the question over the form asks, keeps the text on "Keep editing" and ends the form on "Discard changes".
    const { page, ctx } = await open({ sel, wait: tidSel("composer-input") });
    await openFoot(page, "library-btn");
    await byTid(page, "lib-screen").last().waitFor({ state: "visible", timeout: 15000 });
    await press(page, byTid(page, "lib-plus").last());
    await pressSheetRow(page, "action-sheet", "new-prompt");
    await byTid(page, "prompt-editor").last().waitFor({ state: "visible", timeout: 15000 });
    await typedInto(page, "editor-name", "fresh", say, "New prompt from the library's \"+\"");

    // (d) a question over the form: unsaved text, then Cancel; the question asks, Keep editing keeps the form and its text, and Discard changes ends it
    await byTid(page, "editor-text").first().fill("Not saved yet.");
    for (const how of ["Keep editing", "Discard changes"]) {
      await press(page, byTid(page, "sheet-left").last());
      const Q = byTid(page, "confirm-sheet");
      await Q.last().waitFor({ state: "visible", timeout: 10000 }).catch(() => say(`${how}: Cancel on a changed prompt asked nothing`));
      if (how === "Keep editing") {
        await press(page, byTid(page, "confirm-cancel").last());
        if (!await until(async () => !await Q.count(), 10000)) say("Keep editing left the question open");
        if (!await byTid(page, "prompt-editor").count()) say("Keep editing closed the form too");
        else if (await byTid(page, "editor-text").first().inputValue().catch(() => null) !== "Not saved yet.") say("Keep editing lost the text");
      } else {
        await press(page, byTid(page, "confirm-go").last());
        if (!await until(async () => !await byTid(page, "prompt-editor").count() && !await Q.count(), 10000)) say("Discard changes left the form or the question open");
        if (!await byTid(page, "lib-screen").last().isVisible()) say("Discard changes closed the library screen too");
      }
    }
    await back(page);
    if (!await until(async () => !await byTid(page, "lib-screen").last().isVisible().catch(() => false), 10000)) say("back did not leave the library screen");
    note("phone: the library is S4's pushed screens; the focus handed back to the opener, the Tab ring of an overlay, the first entry of a row's menu are wide-only keyboard rules (goal 3.1.3) and are not asserted at the phone; what is: the editor's name field has the focus at once, and the question over the form keeps the text on Keep editing and ends the form on Discard changes");
    await ctx.close();
  }
  if (layout !== "phone") {
    const { page, ctx } = await open({ sel, wait: tidSel("composer-input") });
    const button = (await showList(page), byTid(page, "library-btn").first());
    await press(page, button);
    const D = byTid(page, "library-dialog");
    await D.waitFor({ state: "visible", timeout: 15000 });
    if (!await until(async () => (await where(page)).id === "lib-search", 5000)) say(`the library popup opened with the focus on ${(await where(page)).id}, not on its search`);
    const row = (name) => D.locator(tidSel("lib-row")).filter({ hasText: name }).first();
    const menuOf = async (name) => {
      if (touch) await longPress(page, row(name)); else await row(name).click({ button: "right" });
      await byTid(page, "lib-menu").waitFor({ state: "visible", timeout: 10000 });
    };
    const item = (text) => byTid(page, "lib-menu").locator(tidSel("lib-menu-item")).filter({ hasText: text }).first();
    await row("review").waitFor({ state: "attached", timeout: 10000 });
    await menuOf("review");
    if (!await until(async () => (await where(page)).id === "lib-menu-item", 5000)) say(`the menu of a row opened with the focus on ${(await where(page)).id}, not on its first entry`);
    await press(page, item("New prompt"));
    await typedInto(page, "lib-name-input", "fresh", say, "New prompt from a row's menu");

    // (d) a question over the library: unsaved text, then Close; the question's own Tab stays in it, Cancel and Esc give the focus to Close
    await byTid(page, "lib-text-input").first().fill("Not saved yet.");
    const close = byTid(page, "lib-close").first();
    for (const how of ["Cancel", "Esc"]) {
      await press(page, close);
      const Q = byTid(page, "confirm-dialog");
      await Q.waitFor({ state: "visible", timeout: 10000 });
      if (!await until(async () => (await where(page)).top, 5000)) say(`${how}: the question over the library opened with the focus on ${(await where(page)).id}, outside it`);
      // Tab from the question's last control and Shift+Tab from its first stay in the question (the library below is not reached)
      const ring = await tabRing(page, Q);
      if (!ring.ok) say(`${how}: Tab and Shift+Tab in the question over the library reach ${JSON.stringify(ring.out)}, outside it`);
      if (how === "Cancel") await press(page, Q.getByText("Cancel", { exact: true }).first()); else await page.keyboard.press("Escape");
      await Q.waitFor({ state: "detached", timeout: 10000 });
      if (!await until(async () => (await where(page)).id === "lib-close", 5000)) say(`${how} on the question over the library gave the focus to ${(await where(page)).id}, not to the button that asked (Close)`);
      if (!await D.count()) say(`${how} on the question closed the library too`);
    }

    // (d) a menu's pick that asks: the question comes up as the menu goes; Cancel gives the focus to where the menu came from, inside the library
    await menuOf("todo");
    await press(page, item("New prompt"));
    const Q = byTid(page, "confirm-dialog");
    await Q.waitFor({ state: "visible", timeout: 10000 });
    await press(page, Q.getByText("Cancel", { exact: true }).first());
    await Q.waitFor({ state: "detached", timeout: 10000 });
    await until(async () => (await where(page)).id !== "nothing", 5000);
    const at = await where(page);
    if (!at.top || at.id === "nothing") say(`Cancel on a question that a menu's pick asked left the focus on ${at.id} (inside the library: ${at.top})`);

    // Tab and Shift+Tab in the library's dialog: it never reaches the page; Esc: the focus is on the button that opened it
    const ring = await tabRing(page, D);
    if (!ring.ok) say(`Tab and Shift+Tab in the library popup reach ${JSON.stringify(ring.out)}, outside it`);
    await page.keyboard.press("Escape");
    if (await byTid(page, "confirm-dialog").count()) await press(page, byTid(page, "confirm-dialog").getByText("Discard", { exact: true }).first());
    await D.waitFor({ state: "detached", timeout: 10000 });
    if (!await until(async () => (await where(page)).id === "library-btn", 5000)) say(`the library popup closed with the focus on ${(await where(page)).id}, not on the button that opened it`);
    await ctx.close();
  }

  // ---- (b) a menu gives the focus back to its trigger: Esc, a pick, a press on the dimmed page; (c) Tab stays in it
  if (layout === "phone") {
    // The phone's chips open sheets (the kit's, which own their focus: no focus ring at the phone, goal 3.1.3). What a sheet does with the focus: it takes it in (the top overlay has it
    // or the page has none), Esc, Done and a press on the dimmed page close it, and a sheet closed leaves the focus on its chip or nowhere, never inside the sheet that is gone. Tab (c) is
    // the desktop's rule (a hardware keyboard on a tablet), and is not asked of a finger's sheet.
    const { page, ctx } = await openState(open, fresh, layout, 0);
    await phoneChip(page, "model").waitFor({ state: "visible", timeout: 15000 });
    const sheetOpen = () => byTid(page, "model-sheet");
    const settled = async (how) => { // the focus a closed sheet leaves: its chip, the box or nothing; never an element of a sheet or of a layer
      if (!await until(async () => !(await sheetOpen().count()), 8000)) return say(`${how}: the model sheet stays open`);
      await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
      const w = await where(page);
      if (w.over || !["tchip", "nothing", "composer-input"].includes(w.id)) say(`${how}: the model sheet closed with the focus on ${w.id} (${w.over} layer(s) still modal), not on its chip or nowhere`);
    };
    for (const how of ["Done", "Esc", "a press outside", "a pick"]) {
      await openChoice(page, "model");
      const w = await where(page);
      if (w.id !== "nothing" && !w.top) say(`${how}: the model sheet opened with the focus on ${w.id}, outside it`);
      if (how === "Done") await press(page, byTid(page, "sheet-right").first());
      else if (how === "Esc") await page.keyboard.press("Escape");
      else if (how === "a press outside") await press(page, byTid(page, "overlay-backdrop").last(), { position: { x: 5, y: 5 } });
      else { // a model's row keeps the sheet open: Done closes it
        await press(page, byTid(page, "picker-row").first());
        if (!await sheetOpen().count()) say("a pick: a model's row closed the sheet: it stays open for the effort");
        await closeChoice(page);
      }
      await settled(how);
    }
    // the agent sheet closes with a pick
    if (await phoneChip(page, "agent").count()) {
      await openChoice(page, "agent");
      await press(page, byTid(page, "picker-row").first());
      if (!await until(async () => !(await byTid(page, "agent-sheet").count()), 8000)) say("a pick in the agent sheet left it open");
      else { const w = await where(page); if (w.over || !["tchip", "nothing", "composer-input"].includes(w.id)) say(`the agent sheet closed with the focus on ${w.id}, not on its chip or nowhere`); }
    }
    await ctx.close();
  } else {
    const { page, ctx } = await openState(open, fresh, layout, 0);
    const trigger = chip(page, "model").first();
    await trigger.waitFor({ state: "visible", timeout: 15000 });
    const picker = byTid(page, "picker");
    const reopen = async (how) => {
      await press(page, trigger);
      if (!await until(() => picker.count(), 5000)) return say(`${how}: a press on the model's chip opened no list`);
      if (!await until(async () => (await where(page)).top, 5000)) say(`${how}: the model's list opened with the focus on ${(await where(page)).id}, outside it`);
    };
    const backToChip = async (how) => { if (!await until(async () => (await where(page)).id === "tchip", 5000)) say(`${how}: the list closed with the focus on ${(await where(page)).id}, not on its chip`); };
    await reopen("Esc");
    const ring = await tabRing(page, byTid(page, "picker").first());
    if (!ring.ok) say(`Tab and Shift+Tab in the model's list reach ${JSON.stringify(ring.out)}, outside it`);
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "detached", timeout: 10000 });
    await backToChip("Esc");
    await reopen("a pick");
    await press(page, byTid(page, "pick-row").first());
    await picker.waitFor({ state: "detached", timeout: 10000 });
    await backToChip("a pick");
    if (layout !== "phone") { // (the phone's sheet has the backdrop too: a press at its top)
      await reopen("a press outside");
      await press(page, byTid(page, "overlay-backdrop").last());
      await picker.waitFor({ state: "detached", timeout: 10000 });
      await backToChip("a press outside");
    }
    await ctx.close();
  }
  note("a field a menu opens has the focus at once and keeps it; Esc, a pick and a press outside give it back to the trigger; Tab and Shift+Tab stay in the top overlay; a question over the library gives the focus to the button that asked");
}, { viewports, page: false });

/** Tab from the last control of `root` (an overlay's content) and Shift+Tab from its first, and Tab through it twice over: the focus never leaves it. Answers { ok, out } (where it went). */
async function tabRing(page, root) {
  const out = [];
  const inside = async () => root.evaluate((r) => r.contains(document.activeElement));
  const here = async () => { const w = await where(page); return w.id; };
  const tabbables = await root.evaluate((r) => [...r.querySelectorAll('button, input, select, textarea, [tabindex]')].filter((x) => x.tabIndex >= 0 && !x.disabled && x.getClientRects().length > 0).length);
  const stays = async (key) => { await page.keyboard.press(key); if (!await inside()) out.push(`${key}: ${await here()}`); };
  for (let i = 0; i < tabbables + 2; i++) await stays("Tab");
  for (let i = 0; i < tabbables + 2; i++) await stays("Shift+Tab");
  return { ok: !out.length, out };
}
