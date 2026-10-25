// R1's recipes of the chat (rules.mjs says what a recipe is): goal 3.5, 3.1.2, 6.1 and 6.2, the mockups "03a to 03d The thread", "04 / 05 Tool steps,
// permission, busy", "Subagents", "Branches and the tree", "Chat info", "Context and usage", "Images". Each screen is reached the way the area's own
// check reaches it (UX.T1-thread, UX.T2-tools, UX.T3-chatinfo): the chat is opened by the state's selection, and everything after it is a press, a
// hold or a scroll. The composer's blocked bar is V1's, not here.
import { deflateSync } from "node:zlib";
import { byTid, back, hold, openChat, press, tidSel } from "../sel.mjs";
import { until } from "../../shot.mjs";

const T1 = "c_UXT1_chat";
const T2_STEPS = "c_UXT2_steps";
const CHAT_HEAD = tidSel("chat-head");

/** The element is brought into the window (the thread is a virtual list: scrolling is by the scroller). */
const bring = async (loc) => { await loc.first().scrollIntoViewIfNeeded(); await loc.page().waitForTimeout(250); };

/** A finger held on the first line of text of `loc`. */
const holdOn = async (loc, until) => {
  await bring(loc);
  const at = await loc.first().evaluate((e) => { const rs = [...e.getClientRects()].filter((r) => r.width > 8 && r.height > 8); const r = rs[0] ?? e.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 60), y: r.y + Math.min(r.height / 2, 10) }; });
  await hold(loc.page(), at, { until });
};

/** Closes the sheet on top the way a person does: a tap on the backdrop above it; a sheet that keeps its backdrop (a form with a Cancel) is closed by
 *  its own left button. */
async function closeSheet(page) {
  const handles = () => page.locator(tidSel("sheet-handle")).count();
  const before = await handles();
  if (!before) return;
  await page.waitForTimeout(800); // (a sheet ignores a tap on its backdrop for a moment after it opens)
  const bd = byTid(page, "overlay-backdrop").last();
  if (await bd.count()) await bd.click({ force: true, position: { x: 8, y: 8 } }).catch(() => {});
  await page.waitForTimeout(600);
  if (await handles() >= before) { const left = page.locator(`${tidSel("sheet-head")} [role="button"]`).first(); if (await left.count()) await press(page, left); }
  await page.waitForTimeout(600);
}

const J = JSON.stringify;
/** A PNG of one colour, `w` × `h` (a picture of a real size: the viewer fits it to the screen). */
function solidPng(w, h) {
  const crc = (buf) => { let c, n, t = []; for (n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const b of buf) r = t[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x9a)]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = solidPng(300, 400);
const UNDO_T3 = "ux3.plan = null; setServerState('s_uxt3', 'connected');";
const PLAN = `ux3.plan = [
  { kind: "weekly_scoped", label: "Current week (Fable)", percent: 33, inMs: 2.5 * 86400000 },
  { kind: "weekly_all", label: "Current week (all models)", percent: 62, inMs: 1.5 * 86400000 },
  { kind: "session", label: "Current session", percent: 84, inMs: 4 * 3600000 }];`;

// What the goal itself draws smaller than 44 pt:
const GOAL_LEGEND = { rule: "target", match: /usage-legend/, why: "goal 3.5: \"legend rows of 38 pt\" in Context and usage, stacked one under the other (a 44 pt target would overlap the next row)" };

/** In the mock: the thread of the UXT1 chat is writing, and the item at `at` is this text. */
const put = (at, text, { done = false } = {}) => `
  const list = items.${T1}, item = { kind: "text", done: ${done}, text: ${J(text)} };
  list[${at}] = item;
  send({ type: "chat_items", chat: ${J(T1)}, branch: "main", version: (versions.${T1} = (versions.${T1} ?? 1) + 1), updates: [{ index: ${at}, item }] });
`;
const setStatus = (status) => `chats.${T1}.status = ${J(status)}; send({ type: "chat", chat: chats.${T1} });`;

/** The thread's scroller moved to its top or its end. */
const scrollTo = async (page, where) => {
  await byTid(page, "thread-scroll").first().evaluate((e, w) => { e.scrollTop = w === "top" ? 0 : e.scrollHeight; }, where);
  await page.waitForTimeout(600);
};

/** The press that puts the screen on top back to the chat: the stack's back. */
const backToChat = async (page, h) => {
  await press(page, h.byTid("nav-back").last());
  await h.byTid("chat-head").first().waitFor({ state: "visible", timeout: 15000 });
};
const chatReturns = (what) => async (page, h) => {
  if (await h.byTid("pushed-screen").locator("visible=true").count()) h.fail(`${what}: the back did not close the pushed screen`);
  if (!await h.byTid("chat-head").first().isVisible()) h.fail(`${what}: the back did not land on the chat`);
};

export const recipes = [
  // ---- UXT1: the thread (goal 3.5, 03a to 03d)
  { id: "chat.thread", goal: "3.5 · 03a The thread", seed: ["UXT1"], state: "UXT1.thread", wait: CHAT_HEAD,
    steps: [
      { name: "header-and-reply" },
      { name: "table", go: async (page, h) => { await bring(h.byTid("md-table")); } },
      { name: "code", go: async (page, h) => { await bring(h.byTid("md-code")); } },
      { name: "link-sheet", ready: tidSel("link-sheet"),
        go: async (page, h) => { await holdOn(h.byTid("md-link"), h.byTid("link-sheet").first()); } },
      { name: "message-sheet", ready: tidSel("msg-sheet"),
        go: async (page, h) => { await closeSheet(page); await holdOn(h.byTid("md-p", {}).nth(2), h.byTid("msg-sheet").first()); } },
      { name: "select-text", ready: tidSel("quote-sheet"),
        go: async (page, h) => { await press(page, h.byTid("action-row", { action: "select" }).last()); } },
      { name: "quote-sheet", ready: tidSel("quote-selection"),
        go: async (page, h) => {
          await closeSheet(page);
          await holdOn(h.byTid("md-p", {}).nth(2), h.byTid("msg-sheet").first());
          await press(page, h.byTid("action-row", { action: "quote" }).last());
          const box = h.byTid("quote-text").first();
          await box.waitFor({ state: "visible", timeout: 15000 });
          const shown = await box.inputValue(), a = shown.indexOf("copies every font file");
          await box.evaluate((el, [x, y]) => { el.focus(); el.setSelectionRange(x, y); }, [Math.max(a, 0), Math.max(a, 0) + 22]);
          await page.keyboard.press("Shift");
        } },
      { name: "quote-comment", ready: tidSel("quote-comment-sheet"),
        go: async (page, h) => { await until(async () => !(await h.byTid("quote-selection").first().isDisabled())); await press(page, h.byTid("quote-selection").first()); } },
      { name: "table-viewer", ready: tidSel("table-screen"),
        go: async (page, h) => {
          await h.byTid("qfloat-comment").first().fill("which files?");
          await press(page, h.byTid("qfloat-save").first());
          await page.waitForTimeout(800);
          await scrollTo(page, "end");
          await bring(h.byTid("md-table"));
          await press(page, h.byTid("md-table-open").first());
        } },
      { name: "back-from-table", go: backToChat, check: chatReturns("the full table") },
    ] },
  // The person's own message: the sheet leads with Branch and edit; the Latest pill (a thread that grows under a reader who scrolled up)
  { id: "chat.own-message", goal: "3.5 · 03c Message sheet", seed: ["UXT1"], state: "UXT1.thread", wait: CHAT_HEAD, fresh: true,
    steps: [
      { name: "own-sheet", ready: tidSel("msg-sheet"),
        go: async (page, h) => {
          await scrollTo(page, "top");
          await holdOn(h.byTid("msg", { role: "user" }).first(), h.byTid("msg-sheet").first());
        },
        check: async (page, h) => {
          // (the quick row is Copy, Quote, Read aloud, Select text; the list under it leads with the message's own action)
          const rows = await h.byTid("action-row").evaluateAll((els) => els.filter((e) => !e.closest('[data-testid="action-quick"]')).map((e) => (e.getAttribute("aria-label") || e.innerText || "").replace(/\s+/g, " ").trim()));
          const lead = rows[0];
          if (!/Branch and edit/i.test(lead ?? "")) h.fail(`own-sheet: the first row of the person's own message is ${J(lead)}, not "Branch and edit…" (rows ${J(rows)})`);
        } },
      { name: "latest-pill", ready: tidSel("thread-latest"),
        go: async (page, h) => {
          await closeSheet(page);
          await scrollTo(page, "end");
          await h.mockEval(setStatus("writing") + put(3, "First paragraph of the answer."));
          await page.waitForTimeout(500);
          await byTid(page, "thread-scroll").first().evaluate((e) => { e.scrollTop = Math.max(0, e.scrollTop - 500); });
          await page.waitForTimeout(400);
          await h.mockEval(put(3, Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} arrives while the person reads above.`).join("\n\n")));
        } },
    ] },
  { id: "chat.plain", goal: "3.5 · 03a The thread (a chat with no branches)", seed: ["UXT1"], state: "UXT1.plain", wait: CHAT_HEAD,
    steps: [{ name: "thread" }] },

  // ---- UXT2: tool steps, the full diff, a permission, busy, subagents (goal 3.5, 04, 05)
  { id: "chat.steps", goal: "3.5 · 04 Tool steps", seed: ["UXT2"], state: "UXT2.steps", wait: CHAT_HEAD,
    steps: [
      { name: "failed-step-open", ready: tidSel("step", { failed: "true" }) },
      { name: "reads-and-edit",
        go: async (page, h) => {
          const group = h.byTid("step-group").first();
          await group.scrollIntoViewIfNeeded();
          await press(page, group.locator('[role="button"]').first());
          await page.waitForTimeout(400);
          const edit = h.byTid("step", { kind: "edit" }).first();
          await edit.scrollIntoViewIfNeeded();
          if ((await edit.getAttribute("data-open")) !== "true") await press(page, byTid(edit, "tool-row").first());
          await byTid(edit, "step-diff").first().waitFor({ state: "visible", timeout: 15000 });
        } },
      { name: "full-diff", ready: tidSel("diff-screen"),
        go: async (page, h) => { await press(page, h.byTid("step-diff-full").first()); } },
      { name: "diff-next-fold",
        go: async (page, h) => {
          await press(page, h.byTid("diff-next").first());
          await page.waitForTimeout(400);
          const fold = h.byTid("diff-fold").first();
          if (await fold.count()) await press(page, fold);
        } },
      { name: "back-from-diff", go: backToChat, check: chatReturns("the full diff") },
    ] },
  { id: "chat.perm", goal: "3.5 · 05 Permission card and dock", seed: ["UXT2"], state: "UXT2.perm", wait: CHAT_HEAD, fresh: true,
    steps: [
      { name: "cards", ready: tidSel("perm-who"),
        go: async (page) => { await scrollTo(page, "end"); },
        check: async (page, h) => {
          // (the header's sub-line is the state word of the chat: goal 3.1.3, statewords.ts "approval")
          const sub = ((await h.byTid("chat-head-sub").first().textContent()) ?? "").replace(/\s+/g, " ").trim();
          if (!/^Needs your approval/.test(sub)) h.fail(`cards: the header says ${J(sub)} while a request waits, not "Needs your approval"`);
        } },
      { name: "dock", ready: tidSel("perm-dock"), go: async (page) => { await scrollTo(page, "top"); } },
      { name: "answered", ready: tidSel("perm-folded"),
        go: async (page, h) => {
          const index = await h.mockEval(`return items.c_UXT2_perm.findIndex((i) => i.requestId === "w1");`);
          await press(page, h.byTid("perm-dock-allow").first());
          await page.waitForTimeout(500);
          // (the mock does not decide: the server would send the item as it is now)
          await h.mockEval(`
            const item = { ...items.c_UXT2_perm[${index}], decided: "allow" };
            items.c_UXT2_perm[${index}] = item;
            send({ type: "chat_items", chat: "c_UXT2_perm", branch: "main", version: (versions.c_UXT2_perm = (versions.c_UXT2_perm ?? 1) + 1), updates: [{ index: ${index}, item }] });`);
          await h.byTid("perm-dock").first().waitFor({ state: "visible", timeout: 15000 });
          await press(page, h.byTid("perm-dock-show").first());
          // (the answered card, folded to one line with its time, is what this step shows)
          await bring(h.byTid("perm-folded"));
        } },
    ] },
  { id: "chat.busy", goal: "3.5 · 05c Answered card, busy line", seed: ["UXT2"], state: "UXT2.busy", wait: CHAT_HEAD,
    steps: [{ name: "busy-line", ready: tidSel("busy-seconds") }] },
  { id: "chat.subs", goal: "3.5 · Subagents", seed: ["UXT2"], state: "UXT2.subs", wait: CHAT_HEAD,
    steps: [
      { name: "card", ready: tidSel("sub-card") },
      { name: "sub-screen", ready: tidSel("sub-screen"),
        go: async (page, h) => { await press(page, h.byTid("sub-row", { sub: "t1" }).first()); } },
      { name: "sub-steps-open",
        go: async (page, h) => { const steps = h.byTid("sub-steps").first(); await steps.scrollIntoViewIfNeeded(); await press(page, steps); await page.waitForTimeout(400); } },
      { name: "back-from-sub", go: backToChat,
        check: async (page, h) => { await chatReturns("a subagent's screen")(page, h); if (!await h.byTid("sub-card").first().isVisible()) h.fail("back-from-sub: the chat does not show its subagent card again"); } },
    ] },

  // ---- UXT3: Chat info, Context and usage, the tree, delete, archive, images (goal 3.5, 3.1.4)
  { id: "chat.info", goal: "3.5 · Chat info, Context and usage, Tree", seed: ["UXT3"], state: "UXT3.chat", wait: CHAT_HEAD, fresh: true,
    prepare: async (h) => { await h.mockEval(PLAN); }, undo: UNDO_T3,
    allow: [GOAL_LEGEND],
    steps: [
      { name: "thread-and-images",
        go: async (page, h) => {
          await page.context().route("**/host/picture/local/*/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
          await page.reload({ waitUntil: "domcontentloaded" });
          await h.byTid("image-thumb").first().waitFor({ state: "visible", timeout: 20000 });
        } },
      { name: "image-viewer", ready: tidSel("image-large"),
        go: async (page, h) => { await press(page, h.byTid("image-thumb").first()); await page.waitForTimeout(800); }, },
      { name: "branch-pill", ready: tidSel("fk-marker"),
        go: async (page, h) => {
          await press(page, h.byTid("image-large-close").first());
          await h.byTid("image-large").first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
          await bring(h.byTid("fk-marker"));
        } },
      { name: "info-from-title", ready: tidSel("chat-info"), go: async (page, h) => { await press(page, h.byTid("chat-head-name").first()); } },
      { name: "info-from-more", ready: tidSel("chat-info"),
        go: async (page, h) => { await closeSheet(page); await press(page, h.byTid("chat-more").first()); } },
      { name: "usage-from-info", ready: tidSel("usage-split-bar"),
        go: async (page, h) => { await press(page, h.byTid("chat-info-row", { row: "context" }).first()); } },
      { name: "usage-from-ring", ready: tidSel("usage-split-bar"),
        go: async (page, h) => {
          await closeSheet(page);
          await press(page, h.byTid("ctx-meter").first());
        } },
      { name: "tree", ready: tidSel("fk-row"),
        go: async (page, h) => {
          await closeSheet(page);
          await press(page, h.byTid("chat-more").first());
          await h.byTid("chat-info").first().waitFor({ state: "visible", timeout: 15000 });
          await press(page, h.byTid("chat-info-row", { row: "tree" }).first());
        } },
      { name: "tree-row-sheet", ready: tidSel("fk-row-sheet"),
        go: async (page, h) => {
          const row = (await h.byTid("fk-row", { kind: "user" }).count()) ? h.byTid("fk-row", { kind: "user" }).first() : h.byTid("fk-row").first();
          await hold(page, row, { until: h.byTid("fk-row-sheet").first() });
        } },
      { name: "label-form", ready: tidSel("fk-label-form"),
        go: async (page, h) => { await page.waitForTimeout(400); await press(page, h.byTid("action-row", { action: "label" }).first()); } },
      { name: "tree-after-label", ready: tidSel("fk-row"),
        go: async (page, h) => {
          await h.byTid("fk-label-input").first().fill("Retry flake");
          await press(page, h.byTid("sheet-right").last());
          await h.byTid("fk-label-form").first().waitFor({ state: "hidden", timeout: 15000 });
        } },
      { name: "delete-asks", ready: tidSel("confirm-dialog"),
        go: async (page, h) => {
          await press(page, h.byTid("fk-done").first());
          await page.waitForTimeout(500);
          await press(page, h.byTid("chat-more").first());
          await h.byTid("chat-info").first().waitFor({ state: "visible", timeout: 15000 });
          await press(page, h.byTid("chat-info-row", { row: "delete" }).first());
        },
        check: async (page, h) => {
          if (!(await h.mockEval("return !!chats.c_UXT3_chat;"))) h.fail("delete-asks: Delete chat… deleted the chat before it asked");
        } },
      { name: "cancel-keeps-chat", ready: tidSel("chat-head"),
        go: async (page, h) => { await press(page, h.byTid("confirm-cancel").first()); await page.waitForTimeout(600); },
        check: async (page, h) => { if (!(await h.mockEval("return !!chats.c_UXT3_chat;"))) h.fail("cancel-keeps-chat: Cancel on the delete sheet deleted the chat"); } },
      { name: "archive-offers-undo", ready: tidSel("toast-action"),
        go: async (page, h) => {
          await press(page, h.byTid("chat-more").first());
          await h.byTid("chat-info").first().waitFor({ state: "visible", timeout: 15000 });
          await press(page, h.byTid("chat-info-row", { row: "archive" }).first());
        },
        check: async (page, h) => {
          if (await h.byTid("confirm-dialog").count()) h.fail("archive-offers-undo: Archive asked for a confirmation (it does not ask: it offers Undo)");
          if (!(await h.mockEval("return !!chats.c_UXT3_chat.archived;"))) h.fail("archive-offers-undo: Archive did not archive the chat");
        } },
      { name: "undo-unarchives", ready: tidSel("chat-head"),
        go: async (page, h) => { await press(page, h.byTid("toast-action").first()); await page.waitForTimeout(1200); },
        check: async (page, h) => { if (await h.mockEval("return !!chats.c_UXT3_chat.archived;")) h.fail("undo-unarchives: Undo did not unarchive the chat"); } },
    ] },
  { id: "chat.archived", goal: "3.5 · An archived chat", seed: ["UXT3"], state: "UXT3.archived", wait: CHAT_HEAD, undo: UNDO_T3,
    steps: [
      { name: "thread" },
      { name: "info-unarchive", ready: tidSel("chat-info"), go: async (page, h) => { await press(page, h.byTid("chat-more").first()); },
        check: async (page, h) => {
          if (!await h.byTid("chat-info-row", { row: "unarchive" }).count()) h.fail("info-unarchive: Chat info of an archived chat does not offer Unarchive");
        } },
    ] },
  { id: "chat.remote", goal: "3.5 · A chat of a server that is away", seed: ["UXT3"], state: "UXT3.remote", wait: CHAT_HEAD, fresh: true, undo: UNDO_T3,
    steps: [
      { name: "permission-online", ready: tidSel("perm") },
      { name: "thread-offline",
        go: async (page, h) => {
          await h.mockEval(`return setServerState("s_uxt3", "unreachable", { detail: "connection refused" });`);
          await until(async () => /offline/.test((await h.byTid("chat-head-sub").first().textContent().catch(() => "")) ?? ""), 15000);
        },
        check: async (page, h) => {
          if (await h.byTid("remote-bar").count()) h.fail("thread-offline: a bar is drawn at the top of a chat whose server dropped");
          const off = await h.byTid("perm-allow").first().evaluate((e) => e.getAttribute("aria-disabled") === "true" || e.disabled === true).catch(() => null);
          if (off === false) h.fail("thread-offline: the permission card's Allow is live while its server is away");
        } },
      { name: "info-offline", ready: tidSel("chat-info"), go: async (page, h) => { await press(page, h.byTid("chat-more").first()); } },
      { name: "server-detail", ready: tidSel("srv-facts"),
        go: async (page, h) => { await press(page, h.byTid("chat-info-row", { row: "server" }).first()); } },
      { name: "back-to-chat", go: backToChat, check: chatReturns("the server's detail") },
    ] },
  // The stack: a chat opened from a row goes back to its group's screen, then Home
  { id: "chat.back", goal: "3.1.2 · 02 The stack and the back", seed: ["UXT3"], wait: tidSel("home"), undo: UNDO_T3,
    steps: [
      { name: "home" },
      { name: "chat-from-row", ready: CHAT_HEAD, go: async (page) => { await openChat(page, "c_UXT3_chat"); } },
      { name: "group-screen", ready: tidSel("group-screen"), go: async (page, h) => { await press(page, h.byTid("nav-back").last()); },
        check: async (page, h) => { if (!await h.byTid("group-screen", { key: "g_UXT3" }).first().isVisible()) h.fail("group-screen: the back from a chat did not land on its group's screen"); } },
      { name: "home-again", ready: tidSel("home"), go: async (page, h) => { await press(page, h.byTid("nav-back").last()); } },
    ] },
];
