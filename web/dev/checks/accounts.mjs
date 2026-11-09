// Helpers of the MC checks over Settings › Claude accounts (no dash in the name: not a check). The testIDs are
// app/src/screens/settings/accounts/ids.ts.
//
//   openAccounts(page)         Settings › Claude accounts: on the phone Home's gear, then the row; on the wide layouts the sidebar foot's
//                              Settings, then its "Claude accounts…" button (the accounts dialog). Answers the list's locator, waited for.
//   rowOf(page, id)            an account's row (dataSet id)
//   textOf(loc)                its text, the spaces folded
//   chipsOf(loc)               [{ chip, tone, text }] of the chips under loc
//   sheet(page)                the add/edit sheet (the phone's FormSheet, the wide dialog's form)
//   shoot(page, name)          a PNG under $SHOTS (nothing when SHOTS is not set)
import fs from "node:fs";
import path from "node:path";
import { atRest, openSettings } from "./settings.mjs";
import { byTid, layoutNow, openFoot, press, tidSel } from "./sel.mjs";

const WAIT = 15000;

export async function openAccounts(page) {
  if (layoutNow(page) === "phone") {
    await openSettings(page);
    await press(page, byTid(page, "settings-row", { row: "claude-accounts" }).last());
    await atRest(page, "accounts-screen");
  } else {
    await openFoot(page, "settings-btn");
    const btn = byTid(page, "settings-accounts").last();
    await btn.waitFor({ state: "visible", timeout: WAIT });
    await btn.scrollIntoViewIfNeeded();
    await press(page, btn);
    await byTid(page, "accounts-dialog").last().waitFor({ state: "visible", timeout: WAIT });
  }
  const list = byTid(page, "accounts-list").last();
  await list.waitFor({ state: "visible", timeout: WAIT });
  await byTid(list, "account-row").first().waitFor({ state: "visible", timeout: WAIT });
  return list;
}

export const rowOf = (page, id) => byTid(page, "account-row", { id }).last();
export const textOf = async (loc) => ((await loc.first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
export const chipsOf = (loc) => loc.first().evaluate((el) => [...el.querySelectorAll('[data-testid="account-chip"]')].map((c) => ({ chip: c.dataset.chip, tone: c.dataset.tone, text: c.innerText.trim() })));
export const sheet = (page) => byTid(page, "account-sheet").last();
export const sheetSel = tidSel("account-sheet");

export async function shoot(page, name) {
  const dir = process.env.SHOTS;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(350); // (a sheet's rise, a dialog's paint)
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}
