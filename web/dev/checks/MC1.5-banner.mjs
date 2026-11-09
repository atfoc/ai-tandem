// MC1.5 (new; multiple-claude goal §1.5.1–3, §1.4.4, §4.2, §1.7.3): the banner of a chat on a Claude account and its held Send, and the header's
// account badge, on the mock's seed MC at the three viewports (the wide layouts' banner above the box, `account-banner` with its state; the
// phone's the same testID inside its "above" card `composer-block` kind account). What it proves:
//   1 not mounted  MC.unmounted (Work, /Users/demo/notes): the banner says exactly "⚠ This folder isn't mounted in Claude · Work — Add it in
//                  Settings"; Send is held (disabled, its name the banner's sentence); the draft stays editable (typed text is in the box);
//                  ⌘/Ctrl+Enter sends nothing (no POST …/messages).
//   2 Settings     "Add it in Settings" asks for Settings › Claude accounts at Work with the folder put in its sheet's list (the store's
//                  `accountsNav`, kept for the checks in `window.__aiwbAccountsNavs`: { server: "local", id: "a_work0001", prefill: "/Users/demo/notes" }), and
//                  Work's edit sheet `account-sheet` opens with `account-folder` /Users/demo/notes in its list (on a page of its own, after 3).
//   3 folder       the folder chip picks /Users/demo/projects/shop (mounted in Work): the banner goes at once, Send takes the draft, and
//                  ⌘/Ctrl+Enter sends it (one POST …/messages, answered 200).
//   4 pending      MC.pending: "⚠ Restart Claude · Client to use this folder", with Restart container; Send held.
//   5 removed      MC.removed: "⚠ This account was removed", no action, Send held; the header's badge says "Claude account".
//   6 badge        MC.work: the header carries `chat-account-badge` "Claude · Work" (data kind claude:a_work0001), and its line does not name
//                  the account again.
// SHOTS=/some/folder keeps PNGs of the banner and of the header badge (the desktop and the phone; the phone's banner in the dark theme too).
// Run: `cd web && npm run uicheck -- MC1.5`, or alone: node web/dev/checks/MC1.5-banner.mjs (DIST=… as README.md says).
import fs from "node:fs";
import path from "node:path";

import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { chip, openState, phoneChip } from "./composer.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const SHOTS = process.env.SHOTS;
const NOT_MOUNTED = "This folder isn't mounted in Claude · Work — Add it in Settings";
const PENDING = "Restart Claude · Client to use this folder";
const REMOVED = "This account was removed";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").replace(/—(?=\S)/g, "— ").trim();

await check("MC1.5 the banner of a chat on an account: its sentence, Add it in Settings, the held Send, the folder that clears it; the header's badge", async ({ url, layout, viewport, open, fail, note }) => {
  const states = await seed(url, "MC");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const phone = layout === "phone";
  const mac = async (page) => /Mac|iPhone|iPad/.test(await page.evaluate(() => navigator.platform));
  const shot = async (page, name, locator) => {
    if (!SHOTS || viewport === "tablet") return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await (locator ?? page).screenshot({ path: path.join(SHOTS, `${name}-${viewport}.png`) });
  };
  /** The banner as drawn: its state, its words, its action's words; null when there is none. */
  const bannerOf = (page) => page.evaluate(() => {
    const b = document.querySelector('[data-testid="account-banner"]');
    if (!b) return null;
    return { state: b.dataset.state, text: b.textContent, action: b.querySelector('[data-testid="account-banner-action"]')?.textContent.trim() ?? "" };
  });
  /** The Send as drawn: held or not, and its name (the title it says why with). */
  const sendOf = (page) => page.evaluate(() => {
    const s = [...document.querySelectorAll('[data-testid="send"]')].find((e) => e.getClientRects().length);
    return s ? { disabled: s.getAttribute("aria-disabled") === "true" || s.hasAttribute("disabled"), label: s.getAttribute("aria-label") ?? "" } : null;
  });
  const sendKey = async (page) => page.keyboard.press(await mac(page) ? "Meta+Enter" : "Control+Enter");
  const posts = (calls, chat, from = 0) => calls.slice(from).filter((c) => c.method === "POST" && new RegExp(`/chats/${chat}/messages`).test(c.path));
  const holds = async (page, chat, sentence, tag) => {
    const s = await until(async () => { const x = await sendOf(page); return x?.disabled && x.label === sentence ? x : null; }, 5000);
    if (!s) fail(`${tag}: Send is ${J(await sendOf(page))}, not held with ${J(sentence)}`);
  };

  // 1–3 a folder that is not mounted
  {
    const { page } = await openState(open, state("unmounted"), layout, 0);
    const calls = callsOf(page);
    const b = await until(() => bannerOf(page), 8000);
    if (!b) fail("MC.unmounted shows no account banner");
    else {
      if (b.state !== "not_mounted" || norm(b.text) !== `⚠ ${NOT_MOUNTED}` || b.action !== "Add it in Settings") fail(`MC.unmounted's banner is ${J(b)}, not not_mounted saying ${J("⚠ " + NOT_MOUNTED)} with "Add it in Settings"`);
    }
    if (phone && !await byTid(page, "composer-block", { kind: "account", place: "above" }).count()) fail("at the phone the banner is not the composer's \"above\" card");
    if (!phone) await holds(page, "c_MC_unmounted", NOT_MOUNTED, "MC.unmounted"); // (the phone's empty box has Talk in Send's place, off with the same reason)
    const input = byTid(page, "composer-input").first();
    await press(page, input);
    await page.keyboard.type("Sort my notes");
    if (!(await input.textContent() ?? "").includes("Sort my notes") && !(await input.inputValue().catch(() => "")).includes("Sort my notes")) fail("the draft did not take the typing under the banner");
    await sendKey(page);
    await page.waitForTimeout(700);
    if (posts(calls, "c_MC_unmounted").length) fail(`⌘/Ctrl+Enter under the banner sent ${J(posts(calls, "c_MC_unmounted"))}`);
    await holds(page, "c_MC_unmounted", NOT_MOUNTED, "MC.unmounted with a draft");
    await shot(page, "banner");

    // 3 the folder chip picks a mounted folder: the banner goes, Send works
    const c = phone ? phoneChip(page, "folder").first() : chip(page, "folder").first();
    if (!phone && !await c.count()) await press(page, byTid(page, "more-chip").first());
    await press(page, c);
    const field = byTid(page, phone ? "folder-sheet" : "dirs").first().locator(tidSel("dir-input")).first();
    if (phone && !await until(() => field.count(), 1500)) await press(page, byTid(page, "dir-path").first());
    if (!await until(() => field.count(), 5000)) fail("the folder chip opened no browser with a field");
    else {
      await field.fill("/Users/demo/projects/shop");
      await field.press("Enter");
      const use = byTid(page, "dir-use").first();
      if (!await until(async () => (await use.textContent().catch(() => "")) === "Use shop", 5000)) fail(`the browser did not list shop: ${J(await use.textContent().catch(() => ""))}`);
      await press(page, use);
      if (!await until(async () => (await bannerOf(page)) === null, 8000)) fail(`with shop picked the banner stays: ${J(await bannerOf(page))}`);
      const s = await until(async () => { const x = await sendOf(page); return x && !x.disabled ? x : null; }, 5000);
      if (!s) fail(`with shop picked Send is ${J(await sendOf(page))}`);
      const from = calls.length;
      for (let i = 0; i < 3 && await byTid(page, "overlay-backdrop").count(); i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); } // (the "more" popup the chip was in)
      await press(page, input);
      await sendKey(page);
      const sent = await until(() => { const p = posts(calls, "c_MC_unmounted", from); return p.length && p[0].status ? p : null; }, 8000);
      if (!sent || sent.length !== 1 || sent[0].status !== 200) fail(`⌘/Ctrl+Enter in shop sent ${J(sent ?? posts(calls, "c_MC_unmounted", from))}, not one message answered 200`);
    }
    await page.context().close();
  }

  // 2 Add it in Settings: Work's sheet, the folder in its list (a page of its own: the sheet stays open over the chat)
  {
    await seed(url, "MC"); // (MC.unmounted again: step 3 moved it to shop)
    const { page } = await openState(open, state("unmounted"), layout, 0);
    if (!await until(() => bannerOf(page), 8000)) fail("MC.unmounted (again) shows no account banner");
    await press(page, byTid(page, "account-banner-action").first());
    const navs = await until(() => page.evaluate(() => window.__aiwbAccountsNavs?.length ? window.__aiwbAccountsNavs : null), 5000);
    const nav = navs?.at(-1);
    if (!nav || nav.server !== "local" || nav.id !== "a_work0001" || nav.prefill !== "/Users/demo/notes") fail(`Add it in Settings asked for ${J(navs)}, not Work's sheet with /Users/demo/notes (server local)`);
    // Work's sheet opens with /Users/demo/notes in its list.
    const sheet = byTid(page, "account-sheet", { mode: "edit", id: "a_work0001" });
    if (!await until(() => sheet.count(), 10000)) fail("Add it in Settings opened no sheet of Claude · Work");
    else if (!await until(() => byTid(sheet, "account-folder", { path: "/Users/demo/notes" }).count(), 5000)) fail("the account's sheet does not list /Users/demo/notes");

    await page.context().close();
  }

  // 4 pending, 5 removed
  for (const [id, chat, st, sentence, action] of [["pending", "c_MC_pending", "pending", PENDING, "Restart container"], ["removed", "c_MC_removed", "removed", REMOVED, ""]]) {
    const { page } = await openState(open, state(id), layout, 0);
    const b = await until(() => bannerOf(page), 8000);
    if (!b || b.state !== st || norm(b.text.replace(action, "")) !== `⚠ ${sentence}` || b.action !== action) fail(`MC.${id}'s banner is ${J(b)}, not ${st} saying ${J("⚠ " + sentence)}${action ? ` with ${action}` : " with no action"}`);
    if (phone) { await press(page, byTid(page, "composer-input").first()); await page.keyboard.type("Go on"); } // (the phone shows Send once the box holds something)
    await holds(page, chat, sentence, `MC.${id}`);
    if (id === "removed") {
      const badge = byTid(page, "chat-account-badge");
      if (!await until(() => badge.count(), 5000) || norm(await badge.first().textContent()) !== "Claude account") fail(`MC.removed's header badge says ${J(await badge.first().textContent().catch(() => null))}, not "Claude account"`);
      if (phone) await shot(page, "banner-removed");
    }
    await page.context().close();
  }

  // the phone's banner in the dark theme, for the eyes only
  if (SHOTS && phone) {
    await seed(url, "MC"); // (MC.unmounted again: step 3 moved it to shop)
    const { page } = await openState(open, state("unmounted"), layout, 0, { ls: { "aiwb.theme": "dark" } });
    await until(() => bannerOf(page), 8000);
    await shot(page, "banner-dark");
    await page.context().close();
  }

  // 6 the header's badge
  {
    const { page } = await openState(open, state("work"), layout, 0);
    const badge = byTid(page, "chat-account-badge", { kind: "claude:a_work0001" });
    if (!await until(() => badge.count(), 8000)) fail("MC.work's header has no account badge");
    else {
      if (norm(await badge.first().textContent()) !== "Claude · Work") fail(`MC.work's badge says ${J(await badge.first().textContent())}`);
      if (!await byTid(page, "chat-head").locator(tidSel("chat-account-badge")).count()) fail("the badge is not in the chat's header");
    }
    const sub = norm(await byTid(page, "chat-head-sub").first().textContent().catch(() => ""));
    if (/Claude · Work/.test(sub)) fail(`the header's line names the account again: ${J(sub)}`);
    if (await bannerOf(page)) fail(`MC.work (in shop, mounted) shows a banner: ${J(await bannerOf(page))}`);
    await shot(page, "badge", phone ? undefined : byTid(page, "chat-head").first());
    await page.context().close();
  }
}, { viewports, page: false });
