// MC1.1 (multiple-claude goal §1.1, screen 1; §1.7; plan D28): Settings › Claude accounts on the mock's seed "MC" (dev/mock-ui.js), at the
// three viewports: the phone through Home's gear and Settings' "Claude accounts" row (a pushed screen), the wide layouts through the
// sidebar foot's Settings and its "Claude accounts…" (a dialog). One ACCOUNTS section per server with accounts (this computer, the lab box);
// in each the host row first (its login chip, the Default badge, its line, no button), then each account in its state: Work logged in and
// running (Edit, Stop container), Personal not logged in and stopped (Edit, Log in), Client running with a restart needed ("⟳ Restart
// needed", "1 folder waiting: /Users/demo/projects/empty-repo", Restart container), Lab on a server whose Docker is not running (greyed, the
// line ending " · start Docker to use it", Log in off); "+ Add account" and its hint in each section; nothing wider than the window at the
// phone. Then Docker of this computer goes down (aliasDocker): its rows grey with the reason, without a reload, and come back.
// MC1.2 goes on with the sheet, MC1.3 with the login, MC1.6 with restart and stop.
import { check, mockEval, seed, until } from "../shot.mjs";
import { chipsOf, openAccounts, rowOf, shoot, textOf } from "./accounts.mjs";
import { byTid } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const EMPTY = "/Users/demo/projects/empty-repo";

await check("MC1.1 Settings › Claude accounts: the sections, the host row, an account in each state, Docker down and back", async ({ url, viewport, open, fail }) => {
  await seed(url, "MC");
  const { page } = await open();
  const list = await openAccounts(page);
  await shoot(page, `list-${viewport}`);

  // ---- the sections (D28): this computer, then the lab box
  const sections = await list.evaluate((el) => [...el.querySelectorAll('[data-testid="accounts-section"]')].map((s) => ({ server: s.dataset.server, title: s.querySelector('[role="heading"]')?.innerText.trim() })));
  if (J(sections.map((s) => s.server)) !== J(["local", "s_lab"])) fail(`the sections are ${J(sections)}, not this computer's and the lab box's`);
  if (!sections.every((s) => /^ACCOUNTS · /i.test(s.title ?? ""))) fail(`the section titles are ${J(sections.map((s) => s.title))}, not "ACCOUNTS · <server>"`);

  // ---- the host row
  for (const server of ["local", "s_lab"]) {
    const host = byTid(page, "account-host", { server }).last();
    const text = await textOf(host);
    const want = server === "local" ? "Logged in as demo@example.com" : "Not logged in";
    for (const w of ["Claude (this computer)", want, "Default", "Host login (~/.claude) · no container"]) if (!text.includes(w)) fail(`${server}'s host row says ${J(text)}: no ${J(w)}`);
    if (await host.getByRole("button").count()) fail(`${server}'s host row has a button`);
    const order = await page.evaluate((s) => {
      const sec = [...document.querySelectorAll(`[data-testid="accounts-section"][data-server="${s}"]`)].pop();
      return [...sec.querySelectorAll('[data-testid="account-host"], [data-testid="account-row"]')].map((e) => e.dataset.id ?? "host");
    }, server);
    const wantOrder = server === "local" ? ["host", "a_work0001", "a_pers0001", "a_clnt0001"] : ["host", "a_lab00001"];
    if (J(order) !== J(wantOrder)) fail(`${server}'s rows are ${J(order)}, not ${J(wantOrder)}`);
  }

  // ---- each account
  const buttons = async (row) => ({
    edit: await byTid(row, "account-edit").count(), login: await byTid(row, "account-login-button").count(), stop: await byTid(row, "account-stop").count(),
    restart: await byTid(row, "account-restart").count(),
  });
  const expect = async (id, { chips, line, pending, acts, usable = "true" }) => {
    const row = rowOf(page, id);
    const got = await chipsOf(row), text = await textOf(row);
    const said = got.map((c) => c.text);
    if (J(said) !== J(chips)) fail(`${id}'s chips are ${J(said)}, not ${J(chips)}`);
    if (!text.includes(line)) fail(`${id}'s row says ${J(text)}: no line ${J(line)}`);
    if (pending && !text.includes(pending)) fail(`${id}'s row says ${J(text)}: no ${J(pending)}`);
    if (!pending && /waiting:/.test(text)) fail(`${id}'s row says something waits: ${J(text)}`);
    const b = await buttons(row);
    if (J(b) !== J(acts)) fail(`${id}'s buttons are ${J(b)}, not ${J(acts)}`);
    if ((await row.getAttribute("data-usable")) !== usable) fail(`${id} is drawn usable=${await row.getAttribute("data-usable")}, not ${usable}`);
    return { row, got };
  };
  const work = await expect("a_work0001", { chips: ["Logged in as work@example.com", "● Running"], line: "aiwb-alias-a_work0001 · 1 folder mounted", acts: { edit: 1, login: 0, stop: 1, restart: 0 } });
  if (J(work.got.map((c) => c.tone)) !== J(["ok", "ok"])) fail(`Work's chips are in the tones ${J(work.got.map((c) => c.tone))}, not ok and ok`);
  await expect("a_pers0001", { chips: ["Not logged in", "○ Stopped"], line: "aiwb-alias-a_pers0001 · 1 folder mounted", acts: { edit: 1, login: 1, stop: 0, restart: 0 } });
  const client = await expect("a_clnt0001", { chips: ["Logged in as client@example.com", "● Running", "⟳ Restart needed"], line: "aiwb-alias-a_clnt0001 · 1 folder mounted",
    pending: `1 folder waiting: ${EMPTY}`, acts: { edit: 1, login: 0, stop: 1, restart: 1 } });
  if (client.got[2]?.tone !== "warn") fail(`"⟳ Restart needed" is in the tone ${client.got[2]?.tone}, not warn`);
  const lab = await expect("a_lab00001", { chips: ["Not logged in", "Docker not running"], line: "aiwb-alias-a_lab00001 · 0 folders mounted · start Docker to use it",
    acts: { edit: 1, login: 1, stop: 0, restart: 0 }, usable: "false" });
  if ((await byTid(lab.row, "account-login-button").getAttribute("aria-disabled")) !== "true") fail("Lab's Log in can be pressed while Docker is not running");

  // ---- + Add account and its hint, in each section
  for (const server of ["local", "s_lab"]) {
    if (!await byTid(page, "account-add", { server }).last().isVisible()) fail(`${server}'s section has no "+ Add account"`);
    const sec = await textOf(byTid(page, "accounts-section", { server }));
    if (!sec.includes("+ Add account")) fail(`${server}'s section does not say "+ Add account"`);
    if (!sec.includes("Each account is its own Claude login in its own Docker container.")) fail(`${server}'s section has no hint under "+ Add account"`);
  }

  // ---- nothing wider than the window, nothing past its row
  const over = await page.evaluate(() => {
    const out = [];
    if (document.documentElement.scrollWidth > innerWidth) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    for (const row of document.querySelectorAll('[data-testid="account-row"], [data-testid="account-host"]')) {
      const r = row.getBoundingClientRect();
      for (const e of row.querySelectorAll("div, [role=button]")) {
        const b = e.getBoundingClientRect();
        if (b.width && (b.right > r.right + 0.5 || b.left < r.left - 0.5)) { out.push(`${row.dataset.id ?? "host"}: ${(e.innerText || e.dataset.testid || "").slice(0, 40)} ends at ${Math.round(b.right)} past ${Math.round(r.right)}`); break; }
      }
    }
    return out;
  });
  for (const o of over) fail(o);

  // ---- Docker of this computer goes down, then comes back: no reload
  const marker = await page.evaluate(() => (window.__mcMark = Math.random()));
  await mockEval(`aliasDocker("local", { ok: false, kind: "not_running", reason: "Docker is not running" });`, url);
  if (!await until(async () => (await rowOf(page, "a_work0001").getAttribute("data-usable")) === "false", 10000)) fail("Docker down: Work is not greyed");
  for (const id of ["a_work0001", "a_pers0001", "a_clnt0001"]) {
    const said = (await chipsOf(rowOf(page, id))).map((c) => c.text);
    if (!said.includes("Docker not running")) fail(`Docker down: ${id}'s chips are ${J(said)}, no "Docker not running"`);
    if (!(await textOf(rowOf(page, id))).includes("start Docker to use it")) fail(`Docker down: ${id}'s line does not say " · start Docker to use it"`);
  }
  if ((await byTid(rowOf(page, "a_pers0001"), "account-login-button").getAttribute("aria-disabled")) !== "true") fail("Docker down: Personal's Log in can be pressed");
  await shoot(page, `list-docker-down-${viewport}`);
  await mockEval(`aliasDocker("local", { ok: true });`, url);
  if (!await until(async () => (await rowOf(page, "a_work0001").getAttribute("data-usable")) === "true", 10000)) fail("Docker back: Work is still greyed");
  const back = (await chipsOf(rowOf(page, "a_work0001"))).map((c) => c.text);
  if (J(back) !== J(["Logged in as work@example.com", "● Running"])) fail(`Docker back: Work's chips are ${J(back)}`);
  if ((await byTid(rowOf(page, "a_pers0001"), "account-login-button").getAttribute("aria-disabled")) === "true") fail("Docker back: Personal's Log in is still off");
  if (await page.evaluate(() => window.__mcMark) !== marker) fail("the page reloaded");

  // ---- the dark theme, for the eye (SHOTS only)
  if (process.env.SHOTS) {
    await page.context().close();
    const dark = await open({ ls: { "aiwb.theme": "dark" } });
    await openAccounts(dark.page);
    await shoot(dark.page, `list-dark-${viewport}`);
  }
}, { viewports, page: false });
