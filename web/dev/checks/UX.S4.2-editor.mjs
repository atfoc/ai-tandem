// UX.S4.2 (package S4, chunk 2; ux-improvements goal 3.8.6): the prompt library's phone sheets: the prompt editor (P3), the move picker (P2) and the group form (P3). They are drawn on
// the phone only, so this check runs there. The sheets are opened through the uicheck build's seam `window.__aiwbLibrary` (openEditor, openMove, openGroupForm) on Home. The library is the
// mock's: this computer's (git ⊃ pull requests ⊃ "PR title", "Pull request description"; review) and a second server's, "Build box" (deploy).
// In the light theme, then the sizes again in the dark:
//   editor     the head Cancel · Prompt · Save (Save off until a change; each 44 pt at least), the Name field 17 px, the Group row says the path, the text field monospaced; Return in the text adds a
//              line and saves nothing; while a field has the focus the bar over the keyboard shows "Edited · not saved" after a change and Done takes the focus away; Save saves (the mock has the new
//              text) and the form closes
//   Group row  opens the move picker over the form: title and sub-line, "Top level" first, the groups set in by their depth, the current place ✓ "Now here", Build box's rows dimmed with the reason;
//              a pick changes the row's value, and Save moves the prompt (the mock's parent)
//   guard      after a change Cancel asks (the words, Discard changes red, Save and close, Keep editing as a link); Keep editing keeps the text, Save and close saves and closes, Discard closes with the
//              mock unchanged; a press on the dimmed page asks too
//   delete     Delete prompt… asks (a P4 over the form) and deletes
//   problems   a name with "/" is said before a save; a server's refusal (a name taken) is in the form's error with what was typed kept
//   offline    the prompt of a server that is not connected: one notice, the fields read-only, Save, the Group row and Delete off
//   move       a group's picker does not offer itself or what is below it; a pick moves it in the mock; a refused move is a toast with the server's sentence
//   group form a new group (in a place picked in another server) and a rename reach the mock; a name with "/" is said under the field
// No text under 13 px and no target under 44 pt in these sheets. OUT=/tmp/x (default web/out/s4-shots) keeps screenshots of each sheet, light and dark.
import fs from "node:fs";
import { check, mockEval, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";
import { atRest } from "./settings.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
const OUT = process.env.OUT ?? new URL("../../out/s4-shots/", import.meta.url).pathname;
const BOX = { id: "s_box", name: "Build box", address: "https://box.example:4790", state: "connected", version: "dev" };
const LIBRARY = {
  groups: [{ id: "g_git", name: "git", parent: "" }, { id: "g_pr", name: "pull requests", parent: "g_git" }, { id: "g_review", name: "review", parent: "" }],
  prompts: [
    { id: "p_title", name: "PR title", parent: "g_pr", text: "Suggest three titles for this pull request, under 70 characters each.\n\nUse the imperative mood; no issue numbers." },
    { id: "p_desc", name: "Pull request description", parent: "g_pr", text: "Write a pull request description for this branch.\n\n## What changed\nOne short paragraph, then bullets for the notable parts." },
  ],
};
const THEIRS = { groups: [{ id: "g_dep", name: "deploy", parent: "" }], prompts: [{ id: "p_plan", name: "deploy plan", parent: "g_dep", text: "List the steps." }] };
const RED = "rgb(224, 49, 49)";

await check("UX.S4.2 the prompt editor, the move picker and the group form on the phone", async ({ url, page, fail, note }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const shoot = async (name, theme) => { await page.waitForTimeout(450); await page.screenshot({ path: `${OUT}/${name}-${theme}.png` }); };
  const reseed = async () => {
    await mockEval(`setServers([${J(BOX)}]); setLibrary("local", ${J(LIBRARY)}); setLibrary("s_box", ${J(THEIRS)}); return true;`, url);
    await mockEval(`return true;`, url);
  };
  const local = (what) => mockEval(`return ${what};`, url);
  const promptOf = (id, server = "local") => local(`(libraries[${J(server)}] ?? libraries.local).prompts.find((p) => p.id === ${J(id)}) ?? null`);
  const groupOf = (id, server = "local") => local(`(libraries[${J(server)}] ?? libraries.local).groups.find((g) => g.id === ${J(id)}) ?? null`);
  const seam = (call, arg) => page.evaluate(([c, a]) => window.__aiwbLibrary[c](a), [call, arg]);
  const sheetOn = (id) => byTid(page, id).last().isVisible().catch(() => false);
  const open = async (call, arg, id) => { await seam(call, arg); await atRest(page, id); await page.waitForTimeout(300); };
  const closed = (id) => until(async () => (await byTid(page, id).count()) === 0, WAIT);
  const text = async (sel) => ((await page.locator(sel).last().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
  const tx = (id, data) => text(tidSel(id, data));
  const css = (sel, prop) => page.locator(sel).last().evaluate((e, p) => getComputedStyle(e)[p], prop);
  const field = (id) => page.locator(tidSel(id)).last();
  const aria = async (sel, name) => page.locator(sel).last().getAttribute(name);
  const saveOff = async () => (await aria(tidSel("sheet-right"), "aria-disabled")) === "true";

  /** Every text of a sheet is 13 px at least; every control (button, menu item) 44 pt each way. */
  const sizes = async (rootId, tag) => {
    const m = await page.evaluate((id) => {
      const root = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
      if (!root) return null;
      const small = [], tiny = [];
      for (const e of root.querySelectorAll("*")) {
        const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (own && parseFloat(getComputedStyle(e).fontSize) < 13) small.push(`${e.textContent.trim().slice(0, 30)}: ${getComputedStyle(e).fontSize}`);
        if (e.matches('[role="button"], [role^="menuitem"]')) { const r = e.getBoundingClientRect(); if (r.width && (r.height < 43.5 || r.width < 43.5)) tiny.push(`${(e.getAttribute("aria-label") || e.textContent).trim().slice(0, 30)}: ${Math.round(r.width)}×${Math.round(r.height)}`); }
      }
      return { small, tiny };
    }, rootId);
    if (!m) return fail(`${tag}: ${rootId} is not on screen`);
    if (m.small.length) fail(`${tag}: texts under 13 px: ${m.small.join("; ")}`);
    if (m.tiny.length) fail(`${tag}: targets under 44 pt: ${m.tiny.join("; ")}`);
  };

  /** The editor's head and fields. */
  const headOf = () => page.evaluate(() => {
    const t = (id) => { const e = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop(), r = e?.getBoundingClientRect(); return e ? { text: e.innerText.trim(), h: r.height, w: r.width, off: e.getAttribute("aria-disabled") === "true" } : null; };
    return { left: t("sheet-left"), title: t("sheet-title"), right: t("sheet-right"), sub: t("sheet-sub") };
  });
  const pickerRows = () => page.evaluate(() => {
    const root = [...document.querySelectorAll('[data-testid="move-picker"]')].pop();
    const rows = [...root.querySelectorAll('[data-testid="picker-row"]')];
    const heads = [...root.querySelectorAll('[data-testid="menu-head"]')].map((e) => e.textContent.trim().toLowerCase());
    const sectionOf = (row) => { let s = ""; for (const h of root.querySelectorAll('[data-testid="menu-head"]')) if (h.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) s = h.textContent.trim().toLowerCase(); return s; };
    return { title: root.querySelector('[data-testid="sheet-title"]')?.innerText.trim(), sub: root.querySelector('[data-testid="sheet-sub"]')?.innerText.trim(), heads, rows: rows.map((r) => {
      const label = r.querySelector("div[dir]")?.innerText ?? "", svg = r.querySelector("svg")?.getBoundingClientRect();
      const lines = r.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
      return { value: r.dataset.value, label: lines[0], note: lines.find((l, i) => i && l !== "✓") ?? "", checked: r.getAttribute("aria-checked") === "true", off: r.getAttribute("aria-disabled") === "true", tick: lines.includes("✓"), glyph: svg ? Math.round(svg.left) : null, section: sectionOf(r), h: r.getBoundingClientRect().height };
    }) };
  });
  const pickerRow = (value) => byTid(page, "move-picker").last().locator(tidSel("picker-row", { value }));
  const closePicker = async () => { await page.keyboard.press("Escape"); await until(async () => (await byTid(page, "move-picker").count()) === 0, WAIT); };

  await byTid(page, "app-root").first().waitFor({ state: "visible", timeout: WAIT });
  await reseed();
  await page.waitForTimeout(500);
  const EDIT = (id = "p_title", server = "local") => ({ mode: "edit", server, id });

  // =============================================================================================== the editor, light
  await page.emulateMedia({ colorScheme: "light" });
  await open("openEditor", EDIT(), "prompt-editor");
  {
    const h = await headOf();
    if (h.left?.text !== "Cancel" || h.title?.text !== "Prompt" || h.right?.text !== "Save") fail(`the head says ${J([h.left?.text, h.title?.text, h.right?.text])}, not Cancel · Prompt · Save`);
    for (const k of ["left", "right"]) if (!h[k] || h[k].h < 43.5 || h[k].w < 43.5) fail(`the head's ${k} is ${h[k]?.w}×${h[k]?.h}, under 44`);
    if (!h.right?.off) fail("Save is on before anything changed");
    const mode = await page.locator(tidSel("prompt-editor-body")).last().evaluate((e) => [e.dataset.mode, e.dataset.server]);
    if (mode.join() !== "edit,local") fail(`the editor's data is ${mode}, not edit,local`);
    if ((await field("editor-name").inputValue()) !== "PR title") fail(`the Name field holds ${J(await field("editor-name").inputValue())}`);
    if ((await aria(tidSel("editor-name"), "aria-label")) !== "Name") fail("the Name field has no label Name");
    if (parseFloat(await css(tidSel("editor-name"), "fontSize")) !== 17) fail(`the Name field is ${await css(tidSel("editor-name"), "fontSize")}, not 17px`);
    const row = await tx("editor-group-row");
    if (!/^Group This computer › git › pull requests$/.test(row)) fail(`the Group row says ${J(row)}, not "Group", "This computer › git › pull requests" (two libraries: the server first)`);
    const rh = await page.locator(tidSel("editor-group-row")).last().boundingBox();
    if (rh.height < 43.5) fail(`the Group row is ${rh.height} high`);
    const tf = await css(tidSel("editor-text"), "fontFamily"), ts = parseFloat(await css(tidSel("editor-text"), "fontSize"));
    if (!/mono|menlo|courier|consolas/i.test(tf) || ts !== 14.5) fail(`the text field is ${J(tf)} at ${ts}px, not monospaced at 14.5px`);
    const th = (await field("editor-text").boundingBox()).height;
    if (th < 189) fail(`the text field is ${th} high, under 190`);
    if (await byTid(page, "editor-kbar").count()) fail("the bar over the keyboard is drawn while no field has the focus");
    if (await byTid(page, "editor-delete").count() !== 1) fail("the editor has no Delete prompt… row");
    const del = await page.locator(tidSel("editor-delete")).last().boundingBox();
    if (del.height < 47.5) fail(`Delete prompt… is ${del.height} high, under 48`);
    await shoot("editor-clean", "light");
    await sizes("prompt-editor", "the editor");
  }

  // ---- the text: Return adds a line and saves nothing; the bar; Done
  await field("editor-text").click();
  await field("editor-text").evaluate((e) => e.setSelectionRange(e.value.length, e.value.length));
  if (!(await until(async () => (await byTid(page, "editor-kbar").count()) === 1, WAIT))) fail("no bar over the keyboard while the text has the focus");
  if (await tx("editor-kbar-state")) fail(`the bar says ${J(await tx("editor-kbar-state"))} before a change`);
  await page.keyboard.type("Keep it short.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line.");
  {
    const v = await field("editor-text").inputValue();
    if (!v.endsWith("Keep it short.\nSecond line.")) fail(`Return did not add a line: the text ends ${J(v.slice(-40))}`);
    if (!(await byTid(page, "prompt-editor").count())) fail("Return closed the editor");
    if ((await promptOf("p_title")).text !== LIBRARY.prompts[0].text) fail("Return saved the text");
    if (!(await until(async () => (await tx("editor-kbar-state")) === "Edited · not saved", WAIT))) fail(`the bar says ${J(await tx("editor-kbar-state"))} after a change, not "Edited · not saved"`);
    const bar = await page.locator(tidSel("editor-kbar")).last().boundingBox(), done = await page.locator(tidSel("editor-kbar-done")).last().boundingBox();
    if (bar.height < 45.5 || bar.height > 46.5 || done.height < 43.5 || done.width < 43.5) fail(`the bar is ${bar.height} high and Done ${done.width}×${done.height}`);
    if ((await css(tidSel("editor-kbar-state"), "fontSize")) !== "13px" || (await css(tidSel("editor-kbar-done"), "fontSize")) === "13px") fail("the bar's state is not 13 px, or its Done not 17");
    const doneText = await page.locator(tidSel("editor-kbar-done")).last().evaluate((e) => parseFloat(getComputedStyle(e.querySelector("div") ?? e).fontSize));
    if (doneText !== 17) fail(`Done is ${doneText}px, not 17`);
    const save = await page.locator(tidSel("sheet-right")).last().boundingBox();
    if (bar.y < save.y + save.height) fail("the bar covers Save");
    if (await saveOff()) fail("Save is off after a change");
    await shoot("editor-dirty", "light");
    await sizes("prompt-editor", "the editor with the bar");
    await press(page, byTid(page, "editor-kbar-done").last());
    const still = await page.evaluate(() => document.activeElement?.tagName);
    if (still === "TEXTAREA" || still === "INPUT") fail(`Done left the focus in a ${still}`);
    if (!(await until(async () => (await byTid(page, "editor-kbar").count()) === 0, WAIT))) fail("the bar stays after Done");
    if (!(await byTid(page, "prompt-editor").count())) fail("Done closed the editor");
  }
  // ---- Save saves and closes
  await press(page, byTid(page, "sheet-right").last());
  if (!(await closed("prompt-editor"))) fail("the editor stays after Save");
  if (!(await until(async () => (await promptOf("p_title")).text.endsWith("Keep it short.\nSecond line."), WAIT))) fail(`Save did not reach the mock: ${J((await promptOf("p_title")).text)}`);

  // ---- the Group row: the picker over the form
  await reseed();
  await open("openEditor", EDIT(), "prompt-editor");
  await press(page, byTid(page, "editor-group-row").last());
  await atRest(page, "move-picker");
  {
    const p = await pickerRows();
    if (p.title !== "Move “PR title” to…" || p.sub !== "Choose its new group") fail(`the picker says ${J([p.title, p.sub])}`);
    if (!(await byTid(page, "prompt-editor").count())) fail("the picker replaced the form: it should be over it");
    if (p.heads.join("|") !== "this computer|build box") fail(`the picker's sections are ${J(p.heads)}`);
    const mine = p.rows.filter((r) => r.section === "this computer");
    if (mine.map((r) => r.label).join("|") !== "Top level|git|pull requests|review") fail(`this computer's places are ${J(mine.map((r) => r.label))}`);
    const g = (l) => mine.find((r) => r.label === l);
    if (!(g("git").glyph > g("Top level").glyph - 1) && g("git").glyph === null) fail("git has no glyph");
    if (!(g("pull requests").glyph > g("git").glyph)) fail(`"pull requests" (${g("pull requests").glyph}) is not set in beyond "git" (${g("git").glyph})`);
    if (g("review").glyph !== g("git").glyph) fail(`"review" (${g("review").glyph}) is not at the level of "git" (${g("git").glyph})`);
    const cur = p.rows.filter((r) => r.checked);
    if (cur.length !== 1 || cur[0].label !== "pull requests" || !cur[0].tick || cur[0].note !== "Now here") fail(`the current place is ${J(cur)}, not "pull requests" ✓ "Now here"`);
    const theirs = p.rows.filter((r) => r.section === "build box");
    if (!theirs.length || theirs.some((r) => !r.off || r.note !== "A prompt stays in its own server's library")) fail(`Build box's rows are ${J(theirs)}, not dimmed with the reason`);
    if (p.rows.some((r) => r.h < 49.5)) fail(`a row of the picker is under 50 high: ${J(p.rows.map((r) => r.h))}`);
    await shoot("picker", "light");
    await sizes("move-picker", "the picker");
  }
  await press(page, pickerRow("local|g_review"));
  if (!(await until(async () => (await byTid(page, "move-picker").count()) === 0, WAIT))) fail("the picker stays after a pick");
  {
    const row = await tx("editor-group-row");
    if (row !== "Group This computer › review") fail(`the Group row says ${J(row)} after the pick, not "This computer › review"`);
    if ((await promptOf("p_title")).parent !== "g_pr") fail("a pick moved the prompt before Save");
    if (await saveOff()) fail("Save is off after a new group was picked");
  }
  await press(page, byTid(page, "sheet-right").last());
  if (!(await closed("prompt-editor"))) fail("the editor stays after Save of a move");
  if (!(await until(async () => (await promptOf("p_title")).parent === "g_review", WAIT))) fail(`Save did not move the prompt: parent ${(await promptOf("p_title")).parent}`);

  // ---- the leave guard
  await reseed();
  await open("openEditor", EDIT(), "prompt-editor");
  const edit = async (to) => { await field("editor-text").fill(to); };
  await edit("Changed text.");
  await press(page, byTid(page, "sheet-left").last());
  await atRest(page, "confirm-sheet");
  {
    const title = await tx("confirm-title"), body = await tx("confirm-body");
    if (title !== "Discard changes to “PR title”?") fail(`the guard's title is ${J(title)}`);
    if (body !== "The changes to the prompt “PR title” are not saved. Discarding goes back to the saved text.") fail(`the guard's body is ${J(body)}`);
    const go = await tx("confirm-go"), alt = await tx("confirm-alt"), keep = await tx("confirm-cancel");
    if (go !== "Discard changes" || alt !== "Save and close" || keep !== "Keep editing") fail(`the guard's buttons say ${J([go, alt, keep])}`);
    if ((await css(tidSel("confirm-go"), "backgroundColor")) !== RED) fail(`Discard changes is ${await css(tidSel("confirm-go"), "backgroundColor")}, not red`);
    const bg = await css(tidSel("confirm-cancel"), "backgroundColor");
    if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(bg)) fail(`Keep editing has a background (${bg}): it should be a link`);
    const order = await page.evaluate(() => ["confirm-go", "confirm-alt", "confirm-cancel"].map((id) => [...document.querySelectorAll(`[data-testid="${id}"]`)].pop().getBoundingClientRect().top));
    if (!(order[0] < order[1] && order[1] < order[2])) fail(`the guard's buttons are not in the order Discard, Save and close, Keep editing: ${order}`);
    if (await byTid(page, "confirm-sheet").locator("text=Revert").count()) fail("the guard has a Revert button");
    await shoot("guard", "light");
    await sizes("confirm-sheet", "the guard");
  }
  await press(page, byTid(page, "confirm-cancel").last());
  if (!(await until(async () => (await byTid(page, "confirm-sheet").count()) === 0, WAIT))) fail("Keep editing leaves the guard open");
  if ((await field("editor-text").inputValue()) !== "Changed text.") fail("Keep editing lost the text");
  if ((await promptOf("p_title")).text === "Changed text.") fail("Keep editing saved");
  // a press on the dimmed page asks too
  await page.mouse.click(10, 6);
  await atRest(page, "confirm-sheet").catch(() => fail("a press on the dimmed page did not ask"));
  await press(page, byTid(page, "confirm-alt").last());
  if (!(await closed("prompt-editor"))) fail("Save and close left the editor open");
  if (!(await until(async () => (await promptOf("p_title")).text === "Changed text.", WAIT))) fail("Save and close did not save");
  await reseed();
  await open("openEditor", EDIT(), "prompt-editor");
  await edit("Never saved.");
  await press(page, byTid(page, "sheet-left").last());
  await atRest(page, "confirm-sheet");
  await press(page, byTid(page, "confirm-go").last());
  if (!(await closed("prompt-editor"))) fail("Discard changes left the editor open");
  if ((await promptOf("p_title")).text !== LIBRARY.prompts[0].text) fail("Discard changes changed the mock");
  // an unchanged form closes at once
  await open("openEditor", EDIT(), "prompt-editor");
  await press(page, byTid(page, "sheet-left").last());
  if (!(await closed("prompt-editor")) || await byTid(page, "confirm-sheet").count()) fail("Cancel of an unchanged editor asks or stays");

  // ---- name problems and a refusal
  await open("openEditor", EDIT(), "prompt-editor");
  await field("editor-name").fill("a/b");
  {
    const problem = await tx("editor-problem");
    if (problem !== `A name cannot contain "/".`) fail(`a name with "/" says ${J(problem)}`);
    if (!(await saveOff())) fail("Save is on for a name with a slash");
    if ((await css(tidSel("editor-problem"), "fontSize")) !== "13px") fail("the name problem is not 13px");
  }
  await field("editor-name").fill("Pull request description");
  await field("editor-text").fill("Typed text that must stay.");
  await press(page, byTid(page, "sheet-right").last());
  if (!(await until(async () => (await byTid(page, "form-error").count()) === 1, WAIT))) fail("a refused save shows no error in the form");
  else {
    const e = await tx("form-error");
    if (e !== `There is already a prompt called "Pull request description" in the group "pull requests".`) fail(`the refusal reads ${J(e)}`);
    if ((await field("editor-text").inputValue()) !== "Typed text that must stay." || (await field("editor-name").inputValue()) !== "Pull request description") fail("a refused save lost what was typed");
    if (!(await byTid(page, "prompt-editor").count())) fail("a refused save closed the form");
  }
  await press(page, byTid(page, "sheet-left").last());
  await atRest(page, "confirm-sheet");
  await press(page, byTid(page, "confirm-go").last());
  await closed("prompt-editor");

  // ---- Delete prompt…
  await open("openEditor", EDIT("p_desc"), "prompt-editor");
  await press(page, byTid(page, "editor-delete").last());
  await atRest(page, "confirm-sheet");
  {
    const title = await tx("confirm-title"), body = await tx("confirm-body"), go = await tx("confirm-go");
    if (title !== "Delete “Pull request description”?" || body !== "“Pull request description” is deleted from This computer's library." || go !== "Delete prompt") fail(`the delete question says ${J([title, body, go])}`);
    if (!(await byTid(page, "prompt-editor").count())) fail("the delete question replaced the form");
  }
  await press(page, byTid(page, "confirm-go").last());
  if (!(await closed("prompt-editor"))) fail("the editor stays after the delete");
  if (!(await until(async () => (await promptOf("p_desc")) === null, WAIT))) fail("the prompt was not deleted in the mock");

  // ---- a new prompt
  await reseed();
  await open("openEditor", { mode: "new", at: { server: "local", group: "g_review" } }, "prompt-editor");
  {
    const h = await headOf();
    if (h.title?.text !== "New prompt" || !h.right?.off) fail(`a new prompt's head is ${J([h.title?.text, h.right?.off])}`);
    if ((await byTid(page, "editor-delete").count()) !== 0) fail("a new prompt has Delete prompt…");
    if ((await tx("editor-group-row")) !== "Group This computer › review") fail(`a new prompt's Group row says ${J(await tx("editor-group-row"))}`);
    await field("editor-name").fill("brand new");
    await field("editor-text").fill("Fresh.");
    await press(page, byTid(page, "sheet-right").last());
    if (!(await closed("prompt-editor"))) fail("Save of a new prompt left the form open");
    const made = await local(`libraries.local.prompts.find((p) => p.name === "brand new") ?? null`);
    if (!made || made.parent !== "g_review" || made.text !== "Fresh.") fail(`the new prompt is ${J(made)} in the mock`);
  }
  await open("openEditor", { mode: "new", at: { server: "local", group: "" } }, "prompt-editor");
  await field("editor-name").fill("never");
  await press(page, byTid(page, "sheet-left").last());
  await atRest(page, "confirm-sheet");
  if ((await tx("confirm-title")) !== "Discard the new prompt?" || (await tx("confirm-body")) !== "It is not saved yet.") fail(`a new prompt's guard says ${J([await tx("confirm-title"), await tx("confirm-body")])}`);
  await press(page, byTid(page, "confirm-go").last());
  await closed("prompt-editor");

  // ---- offline: the prompt of a server that is not connected
  await reseed();
  await mockEval(`setServerState("s_box", "unreachable");`, url);
  await until(async () => page.evaluate(() => true), 500);
  await page.waitForTimeout(800);
  await open("openEditor", EDIT("p_plan", "s_box"), "prompt-editor");
  {
    if (!(await until(async () => (await byTid(page, "editor-off-notice").count()) === 1, WAIT))) fail(`the offline editor has ${await byTid(page, "editor-off-notice").count()} notices, not 1`);
    const n = await tx("editor-off-notice");
    if (n !== "Build box is not connected: this prompt can be changed once it is back.") fail(`the offline notice says ${J(n)}`);
    const says = await page.evaluate(() => [...document.querySelectorAll('[data-testid="prompt-editor"] *')].filter((e) => e.children.length === 0 && /not connected/i.test(e.textContent)).length);
    if (says !== 1) fail(`${says} lines say "not connected" in the offline editor, not one`);
    if ((await css(tidSel("editor-off-notice"), "fontSize")) !== "15px") fail("the offline notice is not 15px");
    for (const id of ["editor-name", "editor-text"]) {
      const ro = await field(id).evaluate((e) => e.readOnly || e.disabled);
      if (!ro) fail(`${id} is editable while offline`);
    }
    if (!(await saveOff())) fail("Save is on offline");
    for (const id of ["editor-group-row", "editor-delete"]) if ((await aria(tidSel(id), "aria-disabled")) !== "true") fail(`${id} is on offline`);
    await shoot("offline", "light");
    await sizes("prompt-editor", "the offline editor");
  }
  await press(page, byTid(page, "sheet-left").last());
  await closed("prompt-editor");
  await mockEval(`setServerState("s_box", "connected");`, url);

  // =============================================================================================== the move picker
  await reseed();
  await page.waitForTimeout(800);
  await open("openMove", { kind: "group", server: "local", id: "g_git" }, "move-picker");
  {
    const p = await pickerRows();
    if (p.title !== "Move “git” to…") fail(`the group's picker says ${J(p.title)}`);
    const mine = p.rows.filter((r) => r.section === "this computer").map((r) => r.label);
    if (mine.join("|") !== "Top level|review") fail(`a group is offered ${J(mine)}: itself and what is below it must not be`);
    const theirs = p.rows.filter((r) => r.section === "build box");
    if (!theirs.length || theirs.some((r) => !r.off || r.note !== "A group stays in its own server's library")) fail(`Build box's rows for a group are ${J(theirs)}`);
    const here = p.rows.find((r) => r.checked);
    if (here?.label !== "Top level" || here?.note !== "Now here") fail(`the group's current place is ${J(here)}`);
  }
  await press(page, pickerRow("local|g_review"));
  if (!(await closed("move-picker"))) fail("the move picker stays after a tap");
  if (!(await until(async () => (await groupOf("g_git")).parent === "g_review", WAIT))) fail(`a pick did not move the group: ${J(await groupOf("g_git"))}`);
  // the current place does nothing
  await open("openMove", { kind: "prompt", server: "local", id: "p_title" }, "move-picker");
  await press(page, pickerRow("local|g_pr"));
  await closed("move-picker");
  if ((await promptOf("p_title")).parent !== "g_pr") fail("a tap on the current place moved the prompt");
  // a refused move: the name is taken in the group it goes to
  await mockEval(`libraries.local.prompts.push({ id: "p_dup", name: "PR title", parent: "g_review", text: "x" }); sendLibrary("local"); return true;`, url);
  await page.waitForTimeout(500);
  await open("openMove", { kind: "prompt", server: "local", id: "p_title" }, "move-picker");
  await press(page, pickerRow("local|g_review"));
  await closed("move-picker");
  {
    if (!(await until(async () => (await byTid(page, "toast").count()) > 0, WAIT))) fail("a refused move shows no toast");
    else {
      const t = await tx("toast");
      if (!t.includes(`There is already a prompt called "PR title" in the group "review".`)) fail(`the toast says ${J(t)}`);
      const kind = await byTid(page, "toast").last().getAttribute("data-kind");
      if (kind !== "error") fail(`the toast's kind is ${J(kind)}, not "error"`);
    }
    if ((await promptOf("p_title")).parent !== "g_pr") fail("a refused move moved the prompt");
  }

  // =============================================================================================== the group form
  await reseed();
  await page.waitForTimeout(800);
  await open("openGroupForm", { mode: "new", at: { server: "local", group: "g_review" } }, "group-form");
  {
    const h = await headOf();
    if (h.title?.text !== "New group" || !h.right?.off) fail(`the new group's head is ${J([h.title?.text, h.right?.off])}`);
    if ((await tx("group-form-where")) !== "In This computer › review") fail(`the group form's In row says ${J(await tx("group-form-where"))}`);
    await shoot("group-form", "light");
    await sizes("group-form", "the group form");
    await field("group-form-name").fill("a/b");
    if ((await tx("group-form-problem")) !== `A name cannot contain "/".` || !(await saveOff())) fail(`a group name with "/" says ${J(await tx("group-form-problem"))} (Save off: ${await saveOff()})`);
    await field("group-form-name").fill("tmp");
    if (await saveOff()) fail("Save is off for a valid name");
    await press(page, byTid(page, "group-form-where").last());
    await atRest(page, "move-picker");
    const p = await pickerRows();
    if (p.title !== "Choose a group") fail(`the group form's picker says ${J(p.title)}`);
    const theirs = p.rows.filter((r) => r.section === "build box");
    if (!theirs.length || theirs.some((r) => r.off)) fail(`a new group cannot be put in Build box: ${J(theirs)}`);
    await press(page, pickerRow("s_box|g_dep"));
    await until(async () => (await byTid(page, "move-picker").count()) === 0, WAIT);
    if ((await tx("group-form-where")) !== "In Build box › deploy") fail(`the In row says ${J(await tx("group-form-where"))} after the pick`);
    await press(page, byTid(page, "sheet-right").last());
    if (!(await closed("group-form"))) fail("the group form stays after Save");
    const made = await local(`libraries.s_box.groups.find((g) => g.name === "tmp") ?? null`);
    if (!made || made.parent !== "g_dep") fail(`the new group is ${J(made)} in Build box`);
  }
  await open("openGroupForm", { mode: "rename", server: "local", id: "g_review" }, "group-form");
  {
    const h = await headOf();
    if (h.title?.text !== "Rename group" || !h.right?.off) fail(`the rename's head is ${J([h.title?.text, h.right?.off])}`);
    if ((await field("group-form-name").inputValue()) !== "review") fail(`the rename's field holds ${J(await field("group-form-name").inputValue())}`);
    if (await byTid(page, "group-form-where").count()) fail("a rename has an In row");
    await field("group-form-name").fill("reviews");
    if (await saveOff()) fail("Save is off for a changed name");
    await press(page, byTid(page, "sheet-right").last());
    if (!(await closed("group-form"))) fail("the rename stays after Save");
    if (!(await until(async () => (await groupOf("g_review")).name === "reviews", WAIT))) fail(`the rename did not reach the mock: ${J(await groupOf("g_review"))}`);
  }

  // =============================================================================================== the same sizes, in the dark
  await page.emulateMedia({ colorScheme: "dark" });
  await until(async () => (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark", WAIT);
  await reseed();
  await page.waitForTimeout(800);
  await open("openEditor", EDIT(), "prompt-editor");
  await sizes("prompt-editor", "the editor, dark");
  await shoot("editor-clean", "dark");
  await field("editor-text").click();
  await field("editor-text").fill("Edited in the dark.");
  await byTid(page, "editor-kbar").last().waitFor({ state: "visible", timeout: WAIT });
  await sizes("prompt-editor", "the editor with the bar, dark");
  await shoot("editor-dirty", "dark");
  await press(page, byTid(page, "editor-kbar-done").last());
  await press(page, byTid(page, "editor-group-row").last());
  await atRest(page, "move-picker");
  await sizes("move-picker", "the picker, dark");
  await shoot("picker", "dark");
  await closePicker();
  await press(page, byTid(page, "sheet-left").last());
  await atRest(page, "confirm-sheet");
  await sizes("confirm-sheet", "the guard, dark");
  if ((await css(tidSel("confirm-go"), "backgroundColor")) === "rgba(0, 0, 0, 0)") fail("Discard changes has no fill in the dark");
  await shoot("guard", "dark");
  await press(page, byTid(page, "confirm-go").last());
  await closed("prompt-editor");
  await mockEval(`setServerState("s_box", "unreachable");`, url);
  await page.waitForTimeout(800);
  await open("openEditor", EDIT("p_plan", "s_box"), "prompt-editor");
  await byTid(page, "editor-off-notice").last().waitFor({ state: "visible", timeout: WAIT });
  await sizes("prompt-editor", "the offline editor, dark");
  await shoot("offline", "dark");
  await press(page, byTid(page, "sheet-left").last());
  await closed("prompt-editor");
  await mockEval(`setServerState("s_box", "connected");`, url);
  await page.waitForTimeout(800);
  await open("openGroupForm", { mode: "new", at: { server: "local", group: "g_review" } }, "group-form");
  await sizes("group-form", "the group form, dark");
  await shoot("group-form", "dark");
  note(`screenshots in ${OUT}`);
}, { viewports });
