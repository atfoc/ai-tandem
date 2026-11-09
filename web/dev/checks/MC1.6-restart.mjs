// MC1.6 (multiple-claude goal §1.6.3–§1.6.6, screen 6): changing an account's folders later, on the seed "MC", at the desktop and the phone.
// Claude · Client's sheet shows its saved folder that the running container lacks with the chip "New · needs restart". A folder saved on
// Claude · Work while an agent works in its container (aliasSet busy 1) asks "Restart Claude · Work?" with the busy sentence, Later /
// Restart now; Later leaves it pending: its row says "⟳ Restart needed" and "1 folder waiting: …" with Restart container, and its sheet has
// the chip. Restart container asks again; Restart now sends force and the row is no longer pending. Stop container on a busy account
// (Client, 2 agents) asks "Stop Claude · Client?" with Cancel / Stop now, and Stop now stops it; on an idle running account (Work) Stop
// stops at once with no question.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { chipsOf, openAccounts, rowOf, sheet, shoot, textOf } from "./accounts.mjs";
import { byTid, layoutNow, press } from "./sel.mjs";

export const viewports = ["desktop", "phone"];

const J = JSON.stringify;
const SCRATCH = "/Users/demo/projects/scratch", EMPTY = "/Users/demo/projects/empty-repo";

await check("MC1.6 restart and stop: the pending chip, the busy dialogs, Later, Restart now, Stop now, an idle stop", async ({ url, viewport, open, fail }) => {
  await seed(url, "MC");
  const { page } = await open();
  const calls = callsOf(page);
  await openAccounts(page);
  const phone = layoutNow(page) === "phone";
  const S = () => sheet(page);
  const dlg = () => byTid(page, "confirm-dialog").last();
  const shown = (loc, ms = 10000) => until(() => loc.isVisible().catch(() => false), ms);
  const gone = (loc, ms = 10000) => until(async () => (await loc.count()) === 0, ms);
  const chips = async (id) => (await chipsOf(rowOf(page, id))).map((c) => c.text);
  const button = (root, name) => root.getByRole("button", { name, exact: true }).last();
  const closeSheet = async () => {
    await press(page, phone ? byTid(page, "sheet-left").last() : byTid(page, "account-cancel").last());
    await gone(byTid(page, "account-sheet"));
  };
  const folderRows = () => S().evaluate((el) => [...el.querySelectorAll('[data-testid="account-folder"]')].map((e) => ({ path: e.dataset.path, pending: e.dataset.pending, text: e.innerText.trim() })));

  // ---- Client's sheet: the pending folder's chip
  await press(page, byTid(rowOf(page, "a_clnt0001"), "account-edit"));
  await shown(S());
  const rows = await folderRows();
  const pend = rows.find((r) => r.path === EMPTY), kept = rows.find((r) => r.path === SCRATCH);
  if (pend?.pending !== "true" || !pend.text.includes("New · needs restart")) fail(`Client's ${EMPTY} is drawn ${J(pend)}, not with "New · needs restart"`);
  if (kept?.pending !== "false" || kept.text.includes("needs restart")) fail(`Client's ${SCRATCH} is drawn ${J(kept)}, as pending`);
  if (!await byTid(S(), "account-restart").count()) fail("Client's sheet has no Restart container");
  await shoot(page, `sheet-edit-pending-${viewport}`);
  await closeSheet();

  // ---- a folder saved on Work while an agent works: asked; Later
  await mockEval(`aliasSet("local", "a_work0001", { busy: 1 });`, url);
  await press(page, byTid(rowOf(page, "a_work0001"), "account-edit"));
  await shown(S());
  await page.evaluate((p) => window.__aiwbAccounts.openAccounts({ server: "local", id: "a_work0001", prefill: p }), SCRATCH); // (as the browser would add it)
  await until(async () => (await folderRows()).some((r) => r.path === SCRATCH), 8000);
  let from = calls.length;
  await press(page, byTid(page, "account-save").last());
  if (!await shown(dlg())) throw new Error("a save on a busy account asked nothing");
  let said = await textOf(dlg());
  for (const w of ["Restart Claude · Work?", "1 agent is working in this container. Restarting stops them; you can continue their chats after the restart."])
    if (!said.includes(w)) fail(`the restart dialog says ${J(said)}: no ${J(w)}`);
  if (!await button(dlg(), "Later").isVisible() || !await button(dlg(), "Restart now").isVisible()) fail("the restart dialog has no Later / Restart now");
  await shoot(page, `restart-dialog-${viewport}`);
  await press(page, button(dlg(), "Later"));
  await gone(byTid(page, "confirm-dialog"));
  if (calls.slice(from).some((c) => /\/restart$/.test(c.path))) fail("Later sent a restart");
  if (!await until(async () => (await chips("a_work0001")).includes("⟳ Restart needed"), 8000)) fail(`after Later Work's chips are ${J(await chips("a_work0001"))}`);
  const workText = await textOf(rowOf(page, "a_work0001"));
  if (!workText.includes(`1 folder waiting: ${SCRATCH}`)) fail(`after Later Work's row says ${J(workText)}`);
  if (!await byTid(rowOf(page, "a_work0001"), "account-restart").count()) fail("after Later Work has no Restart container");
  await press(page, byTid(rowOf(page, "a_work0001"), "account-edit"));
  await shown(S());
  if ((await folderRows()).find((r) => r.path === SCRATCH)?.pending !== "true") fail("after Later Work's sheet does not mark the folder as waiting");
  await closeSheet();

  // ---- Restart container: asked again; Restart now
  from = calls.length;
  await press(page, byTid(rowOf(page, "a_work0001"), "account-restart"));
  if (!await shown(dlg())) fail("Restart container on a busy account asked nothing");
  else {
    if (!(await textOf(dlg())).includes("Restart Claude · Work?")) fail("Restart container asked something else");
    await press(page, button(dlg(), "Restart now"));
    const forced = await until(() => calls.slice(from).find((c) => c.path === "/api/aliases/a_work0001/restart" && c.body?.force === true), 8000);
    if (!forced) fail(`Restart now sent ${J(calls.slice(from).filter((c) => /restart/.test(c.path)))}, not force`);
    if (!await until(async () => !(await chips("a_work0001")).includes("⟳ Restart needed"), 8000)) fail("after Restart now Work still needs a restart");
    if (/waiting:/.test(await textOf(rowOf(page, "a_work0001")))) fail("after Restart now Work's row still says folders wait");
  }

  // ---- Stop on a busy account: asked, Stop now
  from = calls.length;
  await press(page, byTid(rowOf(page, "a_clnt0001"), "account-stop"));
  if (!await shown(dlg())) fail("Stop container on a busy account asked nothing");
  else {
    said = await textOf(dlg());
    for (const w of ["Stop Claude · Client?", "2 agents are working in this container."]) if (!said.includes(w)) fail(`the stop dialog says ${J(said)}: no ${J(w)}`);
    if (!await button(dlg(), "Cancel").isVisible()) fail("the stop dialog has no Cancel");
    await press(page, button(dlg(), "Stop now"));
    if (!await until(() => calls.slice(from).find((c) => c.path === "/api/aliases/a_clnt0001/stop" && c.body?.force === true), 8000)) fail("Stop now sent no force");
    if (!await until(async () => (await chips("a_clnt0001")).includes("○ Stopped"), 8000)) fail(`after Stop now Client's chips are ${J(await chips("a_clnt0001"))}`);
  }

  // ---- Stop on an idle running account: at once
  await press(page, byTid(rowOf(page, "a_work0001"), "account-stop"));
  if (!await until(async () => (await chips("a_work0001")).includes("○ Stopped"), 8000)) fail(`an idle Stop: Work's chips are ${J(await chips("a_work0001"))}`);
  if (await byTid(page, "confirm-dialog").count()) fail("an idle Stop asked a question");
}, { viewports, page: false });
