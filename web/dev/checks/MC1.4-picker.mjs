// MC1.4 (new; multiple-claude goal §1.4.1–4, §1.6.5, §1.7): each Claude account is its own agent in the Agent picker, on the mock's seed MC
// at the three viewports (the wide toolbar's popover `picker` with its `pick-row`s; the phone's `agent-sheet` with its `picker-row`s). What it proves:
//   1 rows      on MC.new the picker lists Claude Code, Cursor, Pi, then the accounts in the order added: Claude · Work, Claude · Personal,
//               Claude · Client. Work: "work@example.com · in its own container" and its chip "● Running", pickable. Personal: greyed (aria-disabled),
//               "Not logged in", with the button Log in… beside it. Client: "⟳ Restart needed", "1 folder waiting: /Users/demo/projects/empty-repo",
//               Restart container. A press on the greyed row picks nothing (no PATCH, the list stays open).
//   2 Log in…   closes the picker and asks for Settings › Claude accounts at Personal with its login started (the store's `accountsNav`, every
//               request of which a build for the checks keeps in `window.__aiwbAccountsNavs`: { server: "local", id: "a_pers0001", login: true }); Settings › Claude accounts
//               shows (`accounts-list`) with Personal's login row (`account-login`); the account is put back as it was and the page back on the chat.
//   3 pick      Work: ONE PATCH { agent: "claude:a_work0001" }; the agent chip names the account ("Claude · Work") with the Claude glyph, the model
//               chip says the account's own default "Sonnet 5.5 · Medium" (its catalog's, not Claude Code's Opus 5.5 · High); the mock's chat has it.
//   4 Docker    down on this computer (the mock's aliasDocker): without a reload the accounts are greyed with "Docker not running", and the line
//               under the toolbar of the chat now on Work says "Claude · Work: Docker not running" (never "not installed"); Docker back: Work is
//               pickable again.
//   5 ⌘E        (desktop) on MC.worknew the model and effort menu lists only the account's models (sonnet, haiku), Sonnet's efforts low, medium,
//               high, the chat's sonnet/medium drafted.
// SHOTS=/some/folder keeps a PNG of the open picker at each viewport (and in the dark theme at the desktop and the phone).
// Run: `cd web && npm run uicheck -- MC1.4`, or alone: node web/dev/checks/MC1.4-picker.mjs (DIST=… as README.md says).
import fs from "node:fs";
import path from "node:path";

import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MORE, POP, chip, menuOf, openState, phoneChip } from "./composer.mjs";
import { back, byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const ORDER = ["claude", "cursor", "pi", "claude:a_work0001", "claude:a_pers0001", "claude:a_clnt0001"];
const WORK = "claude:a_work0001", PERS = "claude:a_pers0001", CLIENT = "claude:a_clnt0001";
const SHOTS = process.env.SHOTS;

/** In the page: the open Agent picker's rows (the popover's or the phone's sheet), each with its kind, its text, whether it is greyed and the
 *  label of the button beside it; null when none is open. */
function pickerInPage() {
  const sheet = document.querySelector('[data-testid="agent-sheet"]'), pop = document.querySelector('[data-testid="picker"]');
  const root = sheet ?? pop;
  if (!root) return null;
  const rows = [...root.querySelectorAll(sheet ? '[data-testid="picker-row"]' : '[data-testid="pick-row"]')];
  const actionOf = (r) => [r.nextElementSibling, r.parentElement?.nextElementSibling].find((e) => e?.dataset?.testid === "pick-action");
  return rows.map((r) => ({
    kind: sheet ? r.dataset.value : r.dataset.optionId, text: r.textContent.replace(/\s+/g, " ").trim(),
    disabled: r.getAttribute("aria-disabled") === "true", action: actionOf(r)?.textContent.trim() ?? "",
    chip: r.querySelector('[data-testid="account-chip"]')?.textContent.trim() ?? "",
  }));
}

await check("MC1.4 the Agent picker lists every Claude account: its line, its chip, why it is greyed, Log in…, the pick, Docker down, ⌘E", async ({ url, layout, viewport, open, fail, note }) => {
  const states = await seed(url, "MC");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const phone = layout === "phone";
  const read = (page) => page.evaluate(pickerInPage);
  const isOpen = async (page) => (await read(page)) !== null;
  /** Opens the Agent picker: the phone's chip and sheet, or the toolbar's chip (from the "more" popup when it is there) and popover. */
  const openPicker = async (page) => {
    if (phone) await press(page, phoneChip(page, "agent").first());
    else {
      const inRow = byTid(page, "composer-tools").locator(tidSel("tchip", { kind: "agent" }));
      if (!await inRow.count() && await page.locator(MORE).count()) { await press(page, page.locator(MORE).first()); await page.locator(POP).first().waitFor({ state: "visible", timeout: 8000 }); }
      await press(page, chip(page, "agent").first());
    }
    const rows = await until(async () => { const r = await read(page); return r?.length ? r : null; }, 8000);
    if (!rows) throw new Error("the Agent picker did not open");
    return rows;
  };
  const closed = (page) => until(async () => !await isOpen(page), 8000);
  const rowAt = (page, kind) => phone ? byTid(byTid(page, "agent-sheet"), "picker-row", { value: kind }).first() : byTid(byTid(page, "picker"), "pick-row", { optionId: kind }).first();
  const actionOf = (page, kind) => rowAt(page, kind).locator('xpath=(following-sibling::*[@data-testid="pick-action"] | ../following-sibling::*[@data-testid="pick-action"])').first();
  const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.waitForTimeout(900); await page.screenshot({ path: path.join(SHOTS, `${name}-${viewport}.png`) }); };
  /** The agent chip's words (the phone's chip row, or the toolbar's). */
  const agentChipText = async (page) => {
    const l = phone ? phoneChip(page, "agent") : chip(page, "agent");
    return (await l.count()) ? (await l.first().textContent()).replace(/[▾⌄]/g, "").trim() : null;
  };
  const modelChipText = async (page) => {
    const l = phone ? phoneChip(page, "model") : chip(page, "model", { fixed: false });
    return (await l.count()) ? (await l.first().textContent()).replace(/[▾⌄]/g, "").replace(/\s+/g, " ").trim() : null;
  };

  {
    const { page } = await openState(open, state("new"), layout, 0);
    const calls = callsOf(page);
    const patches = (from = 0) => calls.slice(from).filter((c) => c.method === "PATCH" && /\/chats\/c_MC_new/.test(c.path));

    // 1 the rows
    let rows = await openPicker(page);
    await shot(page, "picker");
    if (J(rows.map((r) => r.kind)) !== J(ORDER)) fail(`the picker lists ${J(rows.map((r) => r.kind))}, not ${J(ORDER)}`);
    const by = (k) => rows.find((r) => r.kind === k) ?? { text: "", disabled: null, action: "", chip: "" };
    const names = rows.map((r) => r.text);
    ["Claude Code", "Cursor", "Pi", "Claude · Work", "Claude · Personal", "Claude · Client"].forEach((n, i) => { if (!names[i]?.startsWith(n)) fail(`row ${i + 1} says ${J(names[i])}, not ${J(n)} first`); });
    const w = by(WORK), p = by(PERS), cl = by(CLIENT);
    if (!w.text.includes("work@example.com · in its own container") || w.chip !== "● Running" || w.disabled || w.action) fail(`Work's row is ${J(w)}: not "work@example.com · in its own container", "● Running", pickable, no button`);
    if (!p.disabled || !p.text.includes("Not logged in") || p.action !== "Log in…") fail(`Personal's row is ${J(p)}: not greyed with "Not logged in" and Log in…`);
    if (cl.disabled || cl.chip !== "⟳ Restart needed" || !cl.text.includes("1 folder waiting: /Users/demo/projects/empty-repo") || cl.action !== "Restart container") fail(`Client's row is ${J(cl)}: not "⟳ Restart needed", its waiting folder and Restart container`);
    if (rows.slice(0, 3).some((r) => r.disabled || r.action || r.chip)) fail(`the agents' rows changed: ${J(rows.slice(0, 3))}`);
    // a press on the greyed row picks nothing
    await rowAt(page, PERS).click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
    if (patches().length) fail(`a press on the greyed Personal wrote ${J(patches().map((c) => c.body))}`);
    if (!await isOpen(page)) { fail("a press on the greyed Personal closed the picker"); await openPicker(page); }

    // 2 Log in…
    await press(page, actionOf(page, PERS));
    if (!await closed(page)) fail("Log in… left the picker open");
    const navs = await until(() => page.evaluate(() => window.__aiwbAccountsNavs?.length ? window.__aiwbAccountsNavs : null), 5000);
    const nav = navs?.at(-1);
    if (!nav || nav.server !== "local" || nav.id !== "a_pers0001" || nav.login !== true) fail(`Log in… asked for ${J(navs)}, not Settings › Claude accounts at a_pers0001 with its login (server local)`);
    // Settings › Claude accounts shows, with Personal's login started (its login row).
    if (!await until(() => page.locator(tidSel("accounts-list")).count(), 10000)) fail("Log in… did not show Settings › Claude accounts");
    else if (!await until(() => byTid(page, "account-login", { id: "a_pers0001" }).count(), 10000)) fail("Settings › Claude accounts shows no login row for Claude · Personal");
    await mockEval(`aliasSet("local", "a_pers0001", { login: { known: true, loggedIn: false }, container: { state: "stopped" } }); return true;`, url).catch(() => {});
    if (layout === "phone") await back(page); else await page.keyboard.press("Escape"); // (back to the chat)
    if (patches().length) fail(`Log in… wrote ${J(patches().map((c) => c.body))}`);

    // 3 pick Work
    rows = await openPicker(page);
    const from = calls.length;
    await press(page, rowAt(page, WORK));
    if (!await closed(page)) fail("the pick of Work left the picker open");
    if (!await until(() => patches(from).length, 10000)) fail("the pick of Work made no PATCH");
    await page.waitForTimeout(500);
    const made = patches(from).map((c) => c.body);
    if (made.length !== 1 || J(made[0]) !== J({ agent: WORK })) fail(`the pick wrote ${J(made)}, not one PATCH { agent: "${WORK}" }`);
    const kept = await mockEval(`return [chats.c_MC_new.agent, sessions.c_MC_new?.main?.model ?? chats.c_MC_new.model, sessions.c_MC_new?.main?.effort ?? chats.c_MC_new.effort];`, url).catch(() => null);
    note(`the mock's chat: ${J(kept)}`);
    if (!await until(async () => (await agentChipText(page)) === "Claude · Work", 5000)) fail(`the agent chip says ${J(await agentChipText(page))}, not "Claude · Work"`);
    const glyph = phone ? phoneChip(page, "agent") : chip(page, "agent");
    if (!await glyph.first().locator("svg").count()) fail("the agent chip has no glyph");
    const model = await until(async () => { const t = await modelChipText(page); return t === "Sonnet 5.5 · Medium" ? t : null; }, 5000);
    if (!model) {
      const t = await modelChipText(page);
      if (t !== null) fail(`the model chip says ${J(t)}, not "Sonnet 5.5 · Medium" (the account's own default)`);
      else note("the model chip is in the \"more\" popup at this width: its words are not read");
    }

    // 4 Docker down, then back, without a reload
    await mockEval(`aliasDocker("local", { ok: false, kind: "not_running", reason: "Docker is not running" });`, url);
    const line = await until(async () => { const l = byTid(page, "agent-reason"); return (await l.count()) ? (await l.first().textContent()).trim() : null; }, 8000);
    if (line !== "Claude · Work: Docker not running") fail(`with Docker down the line under the toolbar says ${J(line)}, not "Claude · Work: Docker not running"`);
    rows = await openPicker(page);
    await shot(page, "picker-docker");
    const greyed = rows.filter((r) => r.kind.startsWith("claude:"));
    if (greyed.length !== 3 || greyed.some((r) => !r.disabled || !r.text.includes("Docker not running") || r.action)) fail(`with Docker down the accounts are ${J(greyed)}: not each greyed with "Docker not running" and no button`);
    if (rows.slice(0, 3).some((r) => r.disabled)) fail("with Docker down an agent that is no account is greyed");
    await page.keyboard.press("Escape");
    if (!await closed(page)) { await page.mouse.click(5, 5); await closed(page); }
    await mockEval(`aliasDocker("local", { ok: true });`, url);
    if (!await until(async () => (await byTid(page, "agent-reason").count()) === 0, 8000)) fail(`with Docker back the line under the toolbar still says ${J(await byTid(page, "agent-reason").first().textContent().catch(() => ""))}`);
    rows = await openPicker(page);
    if ((rows.find((r) => r.kind === WORK) ?? {}).disabled !== false) fail(`with Docker back Work is ${J(rows.find((r) => r.kind === WORK))}`);
    await page.keyboard.press("Escape");
    await page.context().close();
  }

  // the dark theme, for the eyes only (SHOTS)
  if (SHOTS && viewport !== "tablet") {
    const { page } = await openState(open, state("new"), layout, 0, { ls: { "aiwb.theme": "dark" } });
    await openPicker(page);
    await shot(page, "picker-dark");
    await page.context().close();
  }

  // 5 ⌘E on a new chat on Work: the account's own catalog
  if (layout === "desktop") {
    const { page } = await openState(open, state("worknew"), layout, 0, { size: [1400, 800] });
    const mac = /Mac|iPhone|iPad/.test(await page.evaluate(() => navigator.platform));
    if (!await until(async () => (await modelChipText(page)) === "Sonnet 5.5 · Medium", 8000)) fail(`MC.worknew's model chip says ${J(await modelChipText(page))}, not "Sonnet 5.5 · Medium"`);
    if ((await agentChipText(page)) !== "Claude · Work") fail(`MC.worknew's agent chip says ${J(await agentChipText(page))}`);
    await press(page, byTid(page, "composer-input").first());
    await page.keyboard.press(mac ? "Meta+KeyE" : "Control+KeyE");
    const m = await until(async () => { const x = await menuOf(page); return x?.rows.length ? x : null; }, 8000);
    if (!m) fail("⌘E opened no model menu on MC.worknew");
    else {
      if (J(m.rows) !== J(["sonnet", "haiku"])) fail(`⌘E on Work lists ${J(m.rows)}, not only the account's sonnet and haiku`);
      if (m.model !== "sonnet" || m.effort !== "medium" || J(m.efforts) !== J(["low", "medium", "high"])) fail(`⌘E drafts ${J({ model: m.model, effort: m.effort, efforts: m.efforts })}, not sonnet/medium of low, medium, high`);
    }
    await page.keyboard.press("Escape");
    await page.context().close();
  }
}, { viewports, page: false });
