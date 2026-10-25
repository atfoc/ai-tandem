// UX.T2-tools (package T2 of ux-improvements, plans/ux-improvements/PLAN.md §3 T2): tool steps, the full diff, the permission card and dock, the
// busy line and the subagents on the phone — on the chats of the mock's section UXT2 (dev/mock-ui.js: `c_UXT2_steps` a failed command with 14 lines of
// output, three reads, an edit of two changes and a write; `c_UXT2_perm` a long thread that ends with two waiting requests; `c_UXT2_busy` an
// answered request and a command at work; `c_UXT2_subs` one call of three subagents, one of them waiting on a nested one).
// On the phone it asserts:
//   steps      the failed step is open by itself (`step` dataSet `failed`, `open`), says "exit code 1" (`step-exit`), its command box holds the whole
//              command with "$ " and its Copy puts the command on the clipboard and toasts; the output says "last 6 of 14 lines" and shows 6; Show all
//              output shows 14 ("all 14 lines") and Show less 6 again; every step card is at least 44 px high, its title 15 px, its second line 13 px;
//              the three reads are one `step-group` with `count` 3, closed, a tap opens it (three steps inside), a tap folds it; the edit says "+5 −2"
//              (`step-counts`); opened it shows "line 46", at most ten `diff-row`s with line numbers (`data-a`/`data-b`), "Show full diff · N more
//              lines" with N > 0, and Copy (the unified diff on the clipboard, a toast)
//   full diff  Show full diff pushes `diff-screen` (`pushed-screen` dataSet `screen` "diff") titled "coupon.go" with the summary "+5 −2 · 2 changes";
//              `diff-pos` says "1 of 2" and the next change makes it "2 of 2"; a `diff-fold` of "41 unchanged lines" opens in place; Wrap
//              (`diff-wrap`, dataSet `on`) toggles; Copy toasts; the back returns to the chat
//   permission the header's sub-line says "Needs your approval" in the amber of the theme; each waiting card has `perm-who` "Claude wants to run a
//              command", its title, the whole command (`perm-command`), and `perm-deny` and `perm-allow` at least 48 px high and of one width, Allow in
//              the accent and not the red; at the end of the thread there is no `perm-dock`, at its top the dock shows with `perm-dock-pos` "1 of 2";
//              Show scrolls back to the card and the dock leaves; the dock's Allow makes one POST …/permission naming `w1`; once the request is decided
//              (the mock does not decide: the check sends the item as the server would) the dock shows the second request with no "1 of 2", the first
//              card is folded (`perm-folded`) with "Allowed ·" and its time (`perm-time`, hh:mm), and a tap on it opens it
//   busy       the busy line (`typing`) has a spinner and, after about two seconds, `busy-seconds` ("12 s"); the answered request is folded
//   subagents  one `sub-card` with `count` 4 and `running` 2, its head "4 subagents · in the background" and "2 running"; four `sub-row`s of at least
//              60 px, the nested one indented to the right of its parent; no model, tool count or time on a row; the report row (`sub-report-row`) of at
//              least 48 px says "Report from" and the subagent's name; a tap on the first row pushes the subagent's screen (`sub-screen`): its sub-line
//              "Subagent 1 of 4 · Done", the pills (`sub-pills`) with "14 tools", `sub-steps` closed with "14 steps · read 8 files" and open after a tap,
//              the report's Copy toasts, `sub-screen-next` names "Audit the payment retries" and goes there ("Subagent 2 of 4 · …"), there is no
//              `sub-close`; the back returns to the chat
//   dark       the same chats in the dark theme: every part above is drawn and none passes the screen's right edge
// On the tablet and the desktop none of the phone's parts is drawn (`step`, `step-group`, `perm-who`, `perm-dock`, `sub-card`, `sub-report-row`,
// `sub-screen`) and the wide cards are (`tool-card`, `perm` titled "Allow Bash?", `sub-row`).
//
// Run: `cd web && npm run uicheck -- UX.T2-tools`, or alone: node web/dev/checks/UX.T2-tools.mjs (VIEWPORT=phone, DIST=…).
import fs from "node:fs";
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// the testIDs of app/src/screens/tools/ids.ts (T2_TID), as strings
const ID = {
  step: "step", stepTitle: "step-title", stepLine: "step-line", stepExit: "step-exit", stepCounts: "step-counts", stepCommand: "step-command",
  stepCommandCopy: "step-command-copy", stepOutput: "step-output", stepOutputAll: "step-output-all", stepDiff: "step-diff", stepDiffFull: "step-diff-full",
  stepDiffCopy: "step-diff-copy", stepGroup: "step-group", diffScreen: "diff-screen", diffWrap: "diff-wrap", diffCopy: "diff-copy", diffSummary: "diff-summary",
  diffPos: "diff-pos", diffNext: "diff-next", diffFold: "diff-fold", permWho: "perm-who", permCommand: "perm-command", permFolded: "perm-folded",
  permTime: "perm-time", permDock: "perm-dock", permDockPos: "perm-dock-pos", permDockShow: "perm-dock-show", permDockAllow: "perm-dock-allow",
  busySeconds: "busy-seconds", subCard: "sub-card", subCardHead: "sub-card-head", subReport: "sub-report-row", subScreen: "sub-screen", subPills: "sub-pills",
  subReportCopy: "sub-report-copy", subSteps: "sub-steps", subNext: "sub-screen-next",
};
const STEPS = "c_UXT2_steps", PERM = "c_UXT2_perm", BUSY = "c_UXT2_busy", SUBS = "c_UXT2_subs";
const WAIT = 15000;
const J = JSON.stringify;
const COMMAND = "go test ./internal/cart -run TestApplyCoupon -count=20";
const PUSH = "git push origin fix/coupon-rounding";
const PR = "gh pr create --fill --base main --head fix/coupon-rounding --label checkout --reviewer payments-team";
/** The phone's parts and the wide cards a chat draws. */
const PHONE_PARTS = [ID.step, ID.stepGroup, ID.permWho, ID.permDock, ID.subCard, ID.subReport, ID.subScreen];

/** The accent of both themes, read from the tokens' own file (the check runs in Node, which does not read the app's TypeScript). */
const tokens = fs.readFileSync(new URL("../../../app/src/ui/tokens.ts", import.meta.url), "utf8");
const [LIGHT_ACCENT, DARK_ACCENT] = [...tokens.matchAll(/^\s+accentFill: "(#[0-9a-f]{6})"/gim)].map((m) => m[1]);
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`; };
// the header's sub-line while a request waits: `warnText` of tokens.ts, in each theme
const AMBER = { light: "rgb(154, 103, 0)", dark: "rgb(240, 181, 69)" };

async function body({ page, fail, T, step, helpers }) {
  const { seen, shows, gone, toastSays, clip, clearClip, words, scrollEnd } = helpers;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };

  // ---- steps
  await step("steps open", async () => {
    await T("step").first().waitFor({ state: "visible", timeout: WAIT });
    const failed = T(ID.step, { failed: "true" });
    expect(await failed.count() === 1, `${await failed.count()} failed steps, not 1`);
    expect(await failed.first().getAttribute("data-open") === "true", "the failed step is not open by itself");
    expect(/^exit code 1$/.test(await words(T(ID.stepExit).first())), `the failed step says ${J(await words(T(ID.stepExit).first()))}, not "exit code 1"`);
    const box = T(ID.stepCommand).first();
    const shown = await words(box);
    expect(shown.startsWith(`$ ${COMMAND}`) && !/…|\.\.\./.test(shown), `the command box says ${J(shown)}, not "$ " and the whole command`);
    await clearClip();
    await press(page, T(ID.stepCommandCopy).first());
    expect(await toastSays(/copied/i), "Copy on the command did not toast");
    expect(await clip() === COMMAND, `Copy put ${J(await clip())} on the clipboard, not the command`);
  });

  await step("steps output", async () => {
    const out = T(ID.stepOutput).first();
    const lines = async () => ((await out.locator('[data-testid="tool-pre"]').first().textContent()) ?? "").split("\n").filter((l) => l !== "").length;
    const head = async () => words(T(ID.step, { failed: "true" }).first());
    expect(/last 6 of 14 lines/.test(await head()), `the output's head does not say "last 6 of 14 lines" (${J((await head()).slice(0, 200))})`);
    expect(await lines() === 6, `${await lines()} lines of output, not 6`);
    await press(page, T(ID.stepOutputAll).first());
    expect(await until(async () => (await lines()) === 14, 5000), `Show all output shows ${await lines()} lines, not 14`);
    expect(/all 14 lines/.test(await head()), "the output's head does not say \"all 14 lines\" once it is whole");
    await press(page, T(ID.stepOutputAll).first());
    expect(await until(async () => (await lines()) === 6, 5000), `Show less shows ${await lines()} lines, not 6 again`);
  });

  await step("steps sizes", async () => {
    // (the cards of the thread that are drawn now: the failed one, the group and the edit and the write that are drawn by the virtual list)
    await scrollEnd();
    const cards = await T(ID.step).evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height > 0).map((e) => {
      const px = (sel) => { const n = e.querySelector(`[data-testid="${sel}"]`); return n ? parseFloat(getComputedStyle(n).fontSize) : null; };
      return { h: e.getBoundingClientRect().height, title: px("step-title"), line: px("step-line") };
    }));
    expect(cards.length >= 2, `${cards.length} step cards are drawn to measure`);
    for (const c of cards) {
      expect(c.h >= 44, `a step card is ${Math.round(c.h)} px high, not 44`);
      expect(c.title >= 15, `a step's title is ${c.title} px, not 15`);
      if (c.line !== null) expect(c.line >= 13, `a step's second line is ${c.line} px, not 13`);
    }
  });

  await step("step group", async () => {
    const group = T(ID.stepGroup).first();
    await group.scrollIntoViewIfNeeded();
    expect(await group.getAttribute("data-count") === "3", `the folded reads have count ${await group.getAttribute("data-count")}, not 3`);
    expect(await group.getAttribute("data-open") === "false", "the folded reads are open");
    expect(await T(ID.step, undefined, group).count() === 0, "a closed group draws its steps");
    await press(page, group.locator('[role="button"]').first());
    expect(await until(async () => (await T(ID.step, undefined, group).count()) === 3, 5000), `an open group draws ${await T(ID.step, undefined, group).count()} steps, not 3`);
    expect(await group.getAttribute("data-open") === "true", "a tap did not open the group");
    await press(page, group.locator('[role="button"]').first());
    expect(await until(async () => (await group.getAttribute("data-open")) === "false" && (await T(ID.step, undefined, group).count()) === 0, 5000), "a second tap did not fold the group");
  });

  await step("edit step", async () => {
    const edit = T(ID.step, { kind: "edit" }).first();
    await edit.scrollIntoViewIfNeeded();
    expect(/^\+5\s*−2$/.test(await words(T(ID.stepCounts, undefined, edit).first())), `the edit says ${J(await words(T(ID.stepCounts, undefined, edit).first()))}, not "+5 −2"`);
    if (await edit.getAttribute("data-open") !== "true") await press(page, T("tool-row", undefined, edit).first());
    expect(await until(async () => (await T(ID.stepDiff, undefined, edit).count()) > 0, 5000), "the edit shows no diff when open");
    expect(/line 46/.test(await words(edit)), "the opened edit does not say \"line 46\"");
    const rows = T("diff-row", undefined, edit);
    const n = await rows.count();
    expect(n > 0 && n <= 10, `${n} diff rows in the card, not 1 to 10`);
    const numbers = await rows.evaluateAll((els) => els.filter((e) => e.getAttribute("data-a") || e.getAttribute("data-b")).length);
    expect(numbers > 0, "no diff row carries a line number (data-a, data-b)");
    const full = await words(T(ID.stepDiffFull, undefined, edit).first());
    const more = /^Show full diff · (\d+) more lines?$/.exec(full);
    expect(!!more && Number(more[1]) > 0, `the full-diff button says ${J(full)}, not "Show full diff · N more lines"`);
    await clearClip();
    await press(page, T(ID.stepDiffCopy, undefined, edit).first());
    expect(await toastSays(/copied/i), "Copy on the diff did not toast");
    const diff = await clip();
    expect(/^[-+ ]/m.test(diff) && /^\+.*sortedSKUs/m.test(diff) && /^-.*range cart\.Lines/m.test(diff), `Copy put ${J(diff.slice(0, 80))} on the clipboard, not the unified diff`);
  });

  await step("full diff", async () => {
    const edit = T(ID.step, { kind: "edit" }).first();
    await press(page, T(ID.stepDiffFull, undefined, edit).first());
    const screen = T("pushed-screen", { screen: "diff" });
    expect(await until(async () => seen(screen), WAIT), "Show full diff did not push the diff screen");
    expect(await shows(ID.diffScreen), "the pushed screen draws no diff-screen");
    expect(/^coupon\.go/.test(await words(T("bar-title", undefined, screen).first())), `the diff screen's title is ${J(await words(T("bar-title", undefined, screen).first()))}, not "coupon.go"`);
    expect(/^\+5\s*−2\s*·\s*2 changes/.test(await words(T(ID.diffSummary).first())), `the summary says ${J(await words(T(ID.diffSummary).first()))}, not "+5 −2 · 2 changes"`);
    const pos = T(ID.diffPos).first();
    expect(await words(pos) === "1 of 2", `the position says ${J(await words(pos))}, not "1 of 2"`);
    await press(page, T(ID.diffNext).first());
    expect(await until(async () => (await words(pos)) === "2 of 2", 5000), `⌄ made the position ${J(await words(pos))}, not "2 of 2"`);
    const fold = T(ID.diffFold).filter({ hasText: "41 unchanged lines" }).first();
    expect(await seen(fold), "the diff has no fold of 41 unchanged lines");
    await press(page, fold);
    expect(await until(async () => (await T(ID.diffFold).filter({ hasText: "41 unchanged lines" }).count()) === 0, 5000), "a tap on the fold did not open it in place");
    const wrap = T(ID.diffWrap).first();
    expect(await wrap.getAttribute("data-on") === "false", `Wrap starts as on=${await wrap.getAttribute("data-on")}`);
    await press(page, wrap);
    expect(await until(async () => (await wrap.getAttribute("data-on")) === "true", 5000), "Wrap did not turn on");
    await press(page, wrap);
    expect(await until(async () => (await wrap.getAttribute("data-on")) === "false", 5000), "Wrap did not turn off");
    await clearClip();
    await press(page, T(ID.diffCopy).first());
    expect(await toastSays(/copied/i), "Copy on the diff screen did not toast");
    await press(page, T("nav-back").last());
    expect(await gone("pushed-screen", { screen: "diff" }) && await shows("chat-head"), "the back from the diff screen did not return to the chat");
  });

}

/** The permission chat: the cards, the header's colour, the dock and the folded answer. */
async function permission({ page, url, fail, T, step, helpers, scheme }) {
  const { seen, shows, gone, rect, style, words, scrollTop, scrollEnd } = helpers;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const calls = callsOf(page), asked = () => calls.filter((c) => c.method === "POST" && /\/permission/.test(c.path));

  await step("perm header", async () => {
    await T("perm-who").first().waitFor({ state: "visible", timeout: WAIT });
    const sub = T("chat-head-sub").first();
    expect(await words(sub) === "Needs your approval" || /^Needs your approval/.test(await words(sub)), `the header's sub-line says ${J(await words(sub))}, not "Needs your approval"`);
    const colour = await style(sub, "color");
    expect(colour === AMBER[scheme], `the sub-line is ${colour}, not the amber ${AMBER[scheme]}`);
  });

  await step("perm cards", async () => {
    await scrollEnd();
    const who = T("perm-who");
    expect(await until(async () => (await who.count()) >= 2, WAIT), `${await who.count()} permission cards with a who-line, not 2`);
    const pending = T("perm", { state: "pending" });
    expect(await pending.count() === 2, `${await pending.count()} pending cards, not 2`);
    const commands = [PUSH, PR];
    for (const [i, command] of commands.entries()) {
      const card = pending.nth(i);
      expect(await words(T("perm-who", undefined, card).first()) === "Claude wants to run a command", `card ${i + 1} says ${J(await words(T("perm-who", undefined, card).first()))}, not "Claude wants to run a command"`);
      expect((await words(T("perm-title", undefined, card).first())).length > 0, `card ${i + 1} has no title`);
      expect(await words(T(ID.permCommand, undefined, card).first()) === command, `card ${i + 1} shows the command ${J(await words(T(ID.permCommand, undefined, card).first()))}, not ${J(command)} whole`);
      const deny = card.locator('[data-testid="perm-deny"]').first(), allow = card.locator('[data-testid="perm-allow"]').first();
      await allow.scrollIntoViewIfNeeded();
      const d = await rect(deny), a = await rect(allow);
      expect(d.h >= 48 && a.h >= 48, `card ${i + 1}: Deny is ${Math.round(d.h)} px high and Allow ${Math.round(a.h)}, not 48`);
      expect(Math.abs(d.w - a.w) <= 1, `card ${i + 1}: Deny is ${Math.round(d.w)} px wide and Allow ${Math.round(a.w)}`);
      const bg = await style(allow, "backgroundColor");
      expect(bg === rgbOf(scheme === "dark" ? DARK_ACCENT : LIGHT_ACCENT), `card ${i + 1}: Allow's background is ${bg}, not the accent ${rgbOf(scheme === "dark" ? DARK_ACCENT : LIGHT_ACCENT)}`);
    }
  });
  if (scheme === "dark") return;

  await step("perm dock", async () => {
    await scrollEnd();
    await page.waitForTimeout(500);
    expect(await T(ID.permDock).count() === 0 || !await seen(T(ID.permDock)), "the dock is drawn at the end of the thread, where both cards are in view");
    await scrollTop();
    expect(await shows(ID.permDock), "scrolled to the top, the dock is not shown");
    expect(await words(T(ID.permDockPos).first()) === "1 of 2", `the dock's position says ${J(await words(T(ID.permDockPos).first()))}, not "1 of 2"`);
    await press(page, T(ID.permDockShow).first());
    // (the first card fills the screen's height with the second: once it is in view the dock has no "1 of 2", it is gone or says "2 of 2")
    expect(await until(async () => (await T(ID.permDockPos).count()) === 0 || (await words(T(ID.permDockPos).first())) !== "1 of 2", WAIT), "Show did not take the first request's dock away");
    const at = await T("perm", { state: "pending" }).first().evaluate((e) => e.getBoundingClientRect().top);
    expect(at >= 0 && at < (await page.evaluate(() => innerHeight)), "Show did not scroll the first card into view");
    expect(await T(ID.permDock).count() === 0 || /^2 of 2$/.test(await words(T(ID.permDockPos).first())), "after Show the dock names a request other than the second");
  });

  await step("perm dock answer", async () => {
    const index = await mockEval(`return items.${PERM}.findIndex((i) => i.requestId === "w1");`, url);
    await scrollTop();
    expect(await shows(ID.permDock), "scrolled up again, the dock is not shown");
    const before = asked().length;
    await press(page, T(ID.permDockAllow).first());
    expect(await until(async () => asked().length === before + 1, WAIT), "Allow in the dock made no POST …/permission");
    const sent = asked()[before];
    expect(asked().length === before + 1 && sent.body?.requestId === "w1" && sent.body?.allow === true, `the dock's Allow sent ${J(sent?.body)}, not w1 with allow`);
    // (the mock does not decide: the server would send the item as it is now)
    await mockEval(`
      const item = { ...items.${PERM}[${index}], decided: "allow" };
      items.${PERM}[${index}] = item;
      send({ type: "chat_items", chat: ${J(PERM)}, branch: "main", version: (versions.${PERM} = (versions.${PERM} ?? 1) + 1), updates: [{ index: ${index}, item }] });
    `, url);
    expect(await until(async () => (await T(ID.permDock).count()) === 1 && (await T(ID.permDockPos).count()) === 0, WAIT), "once the first request is decided, the dock does not show the second one alone (no \"1 of 2\")");
    const dock = await words(T(ID.permDock).first());
    expect(dock.includes("gh pr create"), `the dock shows ${J(dock.slice(0, 120))}, not the second request`);
    await press(page, T(ID.permDockShow).first());
    const folded = T(ID.permFolded).first();
    expect(await shows(ID.permFolded), "the answered card is not folded to one line");
    expect(/Allowed · /.test(await words(folded)), `the folded card says ${J((await words(folded)).slice(0, 80))}, not "Allowed ·"`);
    expect(/^\d{1,2}:\d\d$/.test(await words(T(ID.permTime, undefined, folded).first())), `the folded card's time is ${J(await words(T(ID.permTime, undefined, folded).first()))}, not the clock (H:mm, as permClock writes it)`);
    await press(page, folded);
    expect(await until(async () => (await T(ID.permFolded).count()) === 0, 5000), "a tap on the folded card did not open it");
  });
}

async function busy({ fail, T, step, helpers }) {
  const { seen, words } = helpers;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  await step("busy line", async () => {
    const line = T("typing").first();
    await line.waitFor({ state: "visible", timeout: WAIT });
    expect(await line.locator('[role="progressbar"]').count() > 0, "the busy line has no spinner");
    expect(await until(async () => (await T(ID.busySeconds).count()) > 0 && /\d+ s/.test(await words(T(ID.busySeconds))), 8000), "the busy line shows no seconds after a few seconds");
    expect(await T(ID.permFolded).count() > 0 && await seen(T(ID.permFolded)), "the answered request is not folded");
  });
}

async function subagents({ page, fail, T, step, helpers }) {
  const { seen, shows, gone, rect, words, toastSays, clip, clearClip } = helpers;
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const win = await page.evaluate(() => innerWidth);

  await step("sub card", async () => {
    const card = T(ID.subCard).first();
    await card.waitFor({ state: "visible", timeout: WAIT });
    expect(await T(ID.subCard).count() === 1, `${await T(ID.subCard).count()} subagent cards, not 1`);
    expect(await card.getAttribute("data-count") === "4" && await card.getAttribute("data-running") === "2", `the card has count ${await card.getAttribute("data-count")} and running ${await card.getAttribute("data-running")}, not 4 and 2`);
    const head = await words(T(ID.subCardHead).first());
    expect(/4 subagents · in the background/.test(head) && /2 running/.test(head), `the card's head says ${J(head)}`);
    const rows = T("sub-row", undefined, card);
    expect(await rows.count() === 4, `${await rows.count()} rows, not 4`);
    for (let i = 0; i < 4; i++) {
      const row = rows.nth(i);
      expect((await rect(row)).h >= 60, `row ${i + 1} is ${Math.round((await rect(row)).h)} px high, not 60`);
      for (const id of ["sub-model", "sub-tools", "sub-time", "sub-stats"]) expect(await T(id, undefined, row).count() === 0, `row ${i + 1} draws ${id}`);
    }
    const parent = T("sub-row", { sub: "t2" }, card).first(), nested = T("sub-row", { sub: "t2a" }, card).first();
    const px = async (row) => (await rect(T("sub-desc", undefined, row).first())).x;
    expect(await px(nested) > await px(parent) + 8, `the nested row's text is at ${Math.round(await px(nested))}, its parent's at ${Math.round(await px(parent))}: it is not indented`);
    const report = T(ID.subReport).first();
    await report.scrollIntoViewIfNeeded();
    expect((await rect(report)).h >= 48, `the report row is ${Math.round((await rect(report)).h)} px high, not 48`);
    const said = await words(report);
    expect(/Report from/.test(said) && /Audit stock reservation/.test(said), `the report row says ${J(said)}`);
    for (const e of [card, report]) expect((await rect(e)).right <= win + 0.5, "a subagent part passes the screen's right edge");
  });

  await step("sub screen", async () => {
    await press(page, T("sub-row", { sub: "t1" }).first());
    expect(await shows(ID.subScreen), "a tap on the first subagent did not push its screen");
    const sub = T("sub-screen-sub").first();
    expect(await until(async () => /^Subagent 1 of 4 · Done/.test(await words(sub)), 5000), `the sub-line says ${J(await words(sub))}, not "Subagent 1 of 4 · Done"`);
    expect(/14 tools/.test(await words(T(ID.subPills).first())), `the pills say ${J(await words(T(ID.subPills).first()))}, without "14 tools"`);
    const steps = T(ID.subSteps).first();
    await steps.scrollIntoViewIfNeeded();
    expect(await steps.getAttribute("data-open") === "false", "the steps are open before a tap");
    expect(/14 steps · read 8 files/.test(await words(steps)), `the steps say ${J(await words(steps))}, not "14 steps · read 8 files"`);
    await clearClip();
    await press(page, T(ID.subReportCopy).first());
    expect(await toastSays(/copied/i), "Copy on the report did not toast");
    expect(/One real bug/.test(await clip()), `Copy put ${J((await clip()).slice(0, 60))} on the clipboard, not the report`);
    await press(page, steps);
    expect(await until(async () => (await steps.getAttribute("data-open")) === "true", 5000), "a tap did not open the steps");
    expect(await T("sub-close").count() === 0, "the subagent's screen has a × (sub-close) on the phone");
    const next = T(ID.subNext).first();
    expect(/Audit the payment retries/.test((await next.getAttribute("aria-label")) ?? ""), `the next says ${J(await next.getAttribute("aria-label"))}, not "Audit the payment retries"`);
    await press(page, next);
    expect(await until(async () => /^Subagent 2 of 4 ·/.test(await words(sub)), 8000), `after next the sub-line says ${J(await words(sub))}, not "Subagent 2 of 4 · …"`);
    await press(page, T("nav-back").last());
    expect(await gone(ID.subScreen) && await shows(ID.subCard), "the back from the subagent's screen did not return to the chat");
  });
}

/** A pass over every phone part of the four chats in one theme: it is drawn and ends inside the screen. */
async function visible({ open, fail, scheme, win }) {
  const parts = {
    [STEPS]: [ID.step, ID.stepGroup],
    [PERM]: [ID.permWho, "perm-allow"],
    [BUSY]: [ID.permFolded, "typing"],
    [SUBS]: [ID.subCard, ID.subReport],
  };
  for (const [chat, ids] of Object.entries(parts)) {
    const o = await open({ sel: { chat }, wait: '[data-testid="chat-head"]', scheme, ls: scheme === "dark" ? { "aiwb.theme": "dark" } : {} });
    const U = (id) => byTid(o.page, id);
    await o.page.waitForTimeout(800);
    for (const id of ids) {
      const el = U(id).first();
      await el.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      if (!await el.isVisible().catch(() => false)) { fail(`${scheme}: ${id} of ${chat} is not drawn`); continue; }
      const r = await el.evaluate((e) => { const b = e.getBoundingClientRect(); return { right: b.right, left: b.left }; });
      if (r.right > win + 0.5 || r.left < -0.5) fail(`${scheme}: ${id} of ${chat} reaches ${Math.round(r.left)}–${Math.round(r.right)} of a ${win} px screen`);
    }
    await o.ctx.close().catch(() => {});
  }
}

/** The helpers of one page: waits, measures and the clipboard. */
function helpersOf(page, T) {
  const seen = (loc) => loc.first().isVisible().catch(() => false);
  const h = {
    seen,
    until,
    shows: (id, data) => until(async () => seen(T(id, data)), WAIT),
    gone: (id, data) => until(async () => (await T(id, data).count()) === 0 || !(await seen(T(id, data))), WAIT),
    toastSays: (re) => until(async () => re.test(((await T("toast").first().textContent().catch(() => "")) ?? "")), 6000),
    clip: () => page.evaluate(() => navigator.clipboard.readText()).catch((e) => `error: ${e.message}`),
    clearClip: () => page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {}),
    style: (loc, prop) => loc.evaluate((e, p) => getComputedStyle(e)[p], prop),
    rect: (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; }),
    words: async (loc) => (((await loc.first().textContent()) ?? "").replace(/\s+/g, " ").trim()),
    scrollTop: async () => { await T("thread-scroll").first().evaluate((e) => { e.scrollTop = 0; }); await page.waitForTimeout(600); },
    scrollEnd: async () => { await T("thread-scroll").first().evaluate((e) => { e.scrollTop = e.scrollHeight; }); await page.waitForTimeout(600); },
  };
  return h;
}

await check("UX.T2-tools tool steps, the full diff, permissions, the busy line and subagents on the phone", async (c) => {
  const { url, viewport, fail, open } = c;
  const phone = viewport === "phone";
  await seed(url, "UXT2");
  const win = phone ? 393 : 0;
  const run = async (chat, fn, extra = {}) => {
    const o = await open({ sel: { chat }, wait: '[data-testid="chat-head"]', ...extra });
    await o.ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const T = (id, data, root = o.page) => byTid(root, id, data);
    const step = async (name, f) => { try { await f(); } catch (e) { fail(`${chat} ${name}: ${String(e.message ?? e).split("\n")[0]}`); } };
    const helpers = helpersOf(o.page, T);
    try { await fn({ page: o.page, context: o.ctx, url, fail, T, step, helpers, scheme: extra.scheme ?? "light" }); } finally { await o.ctx.close().catch(() => {}); }
  };

  if (!phone) {
    // ---- the wide layouts: none of the phone's parts, and today's cards
    for (const [chat, wide] of [[STEPS, "tool-card"], [PERM, "perm"], [SUBS, "sub-row"]]) {
      await run(chat, async ({ page, T, helpers }) => {
        await T(wide).first().waitFor({ state: "attached", timeout: WAIT }).catch(() => {});
        await page.waitForTimeout(500);
        for (const id of PHONE_PARTS) if (await T(id).count() > 0) fail(`${chat}: ${id} is drawn on the ${viewport} layout`);
        if (await T(wide).count() === 0) fail(`${chat}: the wide ${wide} is not drawn on the ${viewport} layout`);
        if (chat === PERM) {
          const titles = await T("perm-title").allTextContents();
          if (!titles.some((s) => s.trim() === "Allow Bash?")) fail(`${chat}: no permission card titled "Allow Bash?" on the ${viewport} layout (${J(titles)})`);
        }
      });
    }
    return;
  }

  await run(STEPS, (x) => body(x));
  await run(PERM, (x) => permission(x));
  await run(BUSY, (x) => busy(x));
  await run(SUBS, (x) => subagents(x));

  // ---- the dark theme: the same parts, drawn and inside the screen; the permission chat's colours too
  await seed(url, "UXT2"); // (the light pass decided a request: the seed makes the chats anew)
  await run(PERM, (x) => permission(x), { scheme: "dark", ls: { "aiwb.theme": "dark" } });
  await visible({ open, fail, scheme: "dark", win });
}, { viewports, page: false });
