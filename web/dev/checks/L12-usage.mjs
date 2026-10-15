// L12 (new in the app, AD-80; package S9): the context ring and its usage popup (app/src/screens/usage) on the mock, at desktop (mouse), tablet and
// phone (touch; the popup is a bottom sheet there). The B-US rows that had no check, or only a part of one (A2.4 proves the popup lies inside the
// window: A2.4-usage.mjs here). The plan limits and the context split come from fixtures the check hands the page (page.route on the call: the mock
// has no plan and one flat split), so the numbers are known.
//   Ring (B-US-01, 02): empty before the first reply, "43k / 200k 21%" after it, the share with one decimal below 10%, normal to 50%, warning above,
//     danger above 80%; a reply (a `chat` event) moves it; with the context not known the meter is a warning icon with "Context unavailable", the
//     reason as its title, and nothing opens.
//   Context (B-US-04, 05): "Counting what fills it…" while the split is asked, the two lines until it is there and the first alone after; a 409 (not
//     started) is no error, another failure is a line; "Count again" asks anew (`fresh=1`); an unstarted chat asks nothing and has no "Count again".
//   Split (B-US-06, 07): the bar over the window with a segment per category in its fixed slot (an unknown category neutral, the buffer hatched), a row
//     per category with its tokens and share of the window ("0.2%", "3.1%", "22%", "<0.1%"), free space, "Listed, loaded when used", the agent's facts
//     and the foot; a row opens its parts (a bar of its own) or its items largest first with their notes; pointing at a row (a press on touch) marks
//     it and dims the other segments, and a segment marks its row (hover: mouse only).
//   Kept (B-US-05, 11): the popup opens with the last split and the last plan answer while it asks again.
//   Plan (B-US-08 to 11): the heading by agent and server ("Plan usage limits", "Cursor usage", "Plan usage on <Server>"), Pi has none and asks nothing;
//     "Checking your plan…" while it is asked; the limits session first, then the week for all models, then the rest, each a row with its label,
//     detail, percent, a bar in its tone and "Resets in 4h 14m · …"; "Updated 3m ago", stale (warning) after 10 minutes, "Updating…" while asked again;
//     "Check again" asks anew (`fresh=1`); no plan says the agent's note or "<Agent> reported no plan limits."; a warning on a plan and a failure show
//     as lines.
//   Not here: the ring cut to its ring alone and the toolbar's fit (K3: A2.5, with the toolbar), a subagent's ring (S7: it draws `SubMeter`), the
//     other branch's usage (B-US-03: S8's branch switch, P0.4; the ring reads the shown branch's view as the old one), the flavours' colours (A6.3, A6.4).
//
// Run: `cd web && npm run uicheck -- L12`, or alone: node web/dev/checks/L12-usage.mjs (VIEWPORT=phone, DIST=/tmp/x/dist).
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const json = (status, body) => ({ status, contentType: "application/json", body: J(body) });
const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString(), inMs = (ms) => new Date(Date.now() + ms).toISOString();

const SPLIT = {
  atMessage: 7, atTurn: 3, total: 71800, window: 200000,
  categories: [
    { id: "system_prompt", label: "System prompt", tokens: 6200, kind: "used" },
    { id: "system_tools", label: "System tools", tokens: 14300, kind: "used", items: [{ name: "Edit", tokens: 700 }, { name: "Bash", tokens: 1200 }, { name: "Read", tokens: 900, note: "built-in" }] },
    { id: "mcp_tools", label: "MCP tools", tokens: 400, kind: "used" },
    { id: "skills", label: "Skills", tokens: 36, kind: "used" },
    { id: "messages", label: "Messages", tokens: 43000, kind: "used", parts: [
      { id: "tool_results", label: "Tool results", tokens: 20000, kind: "used" }, { id: "assistant", label: "Assistant", tokens: 15000, kind: "used" }, { id: "user", label: "User", tokens: 8000, kind: "used" }] },
    { id: "mystery", label: "Something new", tokens: 1000, kind: "used" },
    { id: "autocompact", label: "Autocompact buffer", tokens: 7800, kind: "buffer" },
    { id: "free", label: "Free space", tokens: 128200, kind: "free" },
    { id: "deferred_tools", label: "Deferred tools", tokens: 3000, kind: "deferred", items: [{ name: "WebFetch", tokens: 500 }] },
  ],
  facts: [{ label: "Model", value: "claude-opus-4" }, { label: "Auto-compact", value: "on" }],
};
const PLAN = (fetchedAt = ago(3 * MIN)) => ({
  plan: true, fetchedAt, limits: [
    { kind: "weekly_scoped", label: "Current week (Fable)", percent: 33, resetsAt: inMs(2.5 * 86_400_000) },
    { kind: "weekly_all", label: "Current week (all models)", percent: 62, resetsAt: inMs(1.5 * 86_400_000) },
    { kind: "session", label: "Current session", percent: 91, resetsAt: inMs(4 * 3600_000 + 14 * MIN + 30_000) },
  ],
});

const USAGE = /^GET \/api\/usage\//, CONTEXT = /^GET \/api\/chats\/[^/]+\/context/;

await check("L12 the context ring and the usage popup", async ({ url, mock, viewport, open, fail, note }) => {
  const states = await seed(url, "A2");
  const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${e.message.split("\n")[0]}`); } };
  const T = (page, id, data) => byTid(page, id, data);
  const text = async (loc) => ((await loc.first().innerText()) ?? "").replace(/\s+/g, " ").trim();
  /** A page on a seeded state, with the answers of the page's two reads (a function that answers, or a status and body) and the calls it makes. */
  let dirty = false;
  const page = async (id, { plan, context, before } = {}) => {
    if (dirty) { await mock.restart(); await seed(url, "A2"); } // (what a page before changed in the mock is put back)
    dirty = !!before;
    const s = state(id);
    if (before) await mockEval(before, url);
    const { page: p, ctx } = await open({ sel: s.sel, wait: '[data-testid="chat-head"]' });
    const calls = callsOf(p);
    const answer = (re, what) => what && p.route(callMatcher(re), async (route) => { const r = typeof what === "function" ? await what(route) : what; if (r) await route.fulfill(r); });
    await answer(USAGE, plan);
    await answer(CONTEXT, context);
    await T(p, "ctx-meter").first().waitFor({ state: "visible", timeout: 15000 });
    return { p, ctx, calls };
  };
  const popOpen = async (p) => { await press(p, T(p, "ctx-meter").first()); await T(p, "usage-pop").first().waitFor({ state: "visible", timeout: 8000 }); };
  const popClose = async (p) => { await p.keyboard.press("Escape"); await until(async () => !await T(p, "usage-pop").count(), 5000); };
  /** A call the page holds until the check lets it go. */
  const held = (r) => { let go; const gate = new Promise((ok) => { go = ok; }); return { gate, go, answer: async () => { await gate; return r; } }; };
  const rowsOf = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="split-row"]')].map((e) => ({
    cat: e.dataset.cat, on: e.dataset.on === "true", label: e.querySelector('[data-testid="split-label"]').textContent, num: e.querySelector('[data-testid="split-num"]').textContent, pct: e.querySelector('[data-testid="split-pct"]').textContent })));
  const segsOf = (p) => p.evaluate(() => [...document.querySelectorAll('[data-testid="split-bar"]')[0].querySelectorAll('[data-testid="split-seg"]')].map((e) => ({ cat: e.dataset.cat, slot: e.dataset.slot, opacity: getComputedStyle(e).opacity, w: e.getBoundingClientRect().width })));
  const heading = async (loc) => ((await loc.locator('[data-testid="menu-head"]').first().textContent()) ?? "").trim(); // (textContent: innerText would give the capitals the heading is drawn in)
  const meterOf = (p) => p.evaluate(() => { const e = document.querySelector('[data-testid="ctx-meter"]'); return { text: e.innerText.replace(/\s+/g, " ").trim(), tone: e.dataset.tone, title: e.getAttribute("title") ?? "", used: e.dataset.used, win: e.dataset.win }; });

  // ---- the ring: its text, its tones, a reply that moves it, and the meter that cannot say
  await step("the ring", async () => {
    // (the usage is set before the page opens: one page for each, as a chat's usage is what its server sent)
    for (const [used, win, words, tone] of [[0, 200000, "", "ok"], [4000, 200000, "4k / 200k 2.0%", "ok"], [100000, 200000, "100k / 200k 50%", "ok"], [120000, 200000, "120k / 200k 60%", "warn"], [160000, 200000, "160k / 200k 80%", "warn"], [170000, 200000, "170k / 200k 85%", "danger"], [1500000, 2000000, "1.5M / 2M 75%", "warn"]]) {
      const { p, ctx } = await page("plain-started", { before: `chats.c_plain.usage = { ctxIn: ${used}, ctxOut: 0, ctxWindow: ${win}, turns: 3 };` });
      const m = await meterOf(p);
      expect(m.text === words, `with ${used} of ${win} tokens the ring says "${m.text}", not "${words}"`);
      expect(m.tone === tone, `with ${used} of ${win} tokens the ring is ${m.tone}, not ${tone}`);
      await ctx.close();
    }
    const { p, ctx } = await page("plain-started");
    expect((await meterOf(p)).text === "43k / 200k 21%", `the ring says "${(await meterOf(p)).text}", not "43k / 200k 21%"`);
    // a reply: the chat's usage grows and the ring follows, without a press
    dirty = true;
    await mockEval(`setSession("c_plain", "main", { usage: { ctxIn: 170000, ctxOut: 1000, ctxWindow: 200000, turns: 4 } });`, url);
    expect(await until(async () => (await meterOf(p)).text === "171k / 200k 86%" && (await meterOf(p)).tone === "danger", 8000), `the ring did not follow a reply (it says "${(await meterOf(p)).text}", ${(await meterOf(p)).tone})`);
    await ctx.close();
  });
  await step("the meter that cannot say", async () => {
    const { p, ctx, calls } = await page("plain-ctxerr");
    const m = await meterOf(p);
    expect(m.text === "Context unavailable", `the error meter says "${m.text}"`);
    expect(m.title === "the agent did not report its context", `the error meter's title is "${m.title}", not the reason`);
    expect(m.tone === "error", `the error meter's tone is ${m.tone}`);
    await press(p, T(p, "ctx-meter").first()).catch(() => {});
    await p.waitForTimeout(400);
    expect(!await T(p, "usage-pop").count() && !calls.some((c) => USAGE.test(`${c.method} ${c.path}`) || CONTEXT.test(`${c.method} ${c.path}`)), `the error meter opened a popup or asked the server for the context`);
    await ctx.close();
  });

  // ---- the context: asked on open, counted again, a 409 and a failure
  await step("the context while it is asked", async () => {
    const gate = held(json(200, SPLIT));
    const { p, ctx, calls } = await page("plain-started", { context: gate.answer, plan: json(200, PLAN()) });
    await popOpen(p);
    expect(await until(async () => /Counting what fills it…/.test(await text(T(p, "usage-context"))), 5000), `no "Counting what fills it…" while the split is asked`);
    const lines = await text(T(p, "usage-ctx"));
    expect(lines === "Context: 42,900 of 200,000 tokens (21.4%) System prompt, tools, board reads and the conversation so far.", `before the split the popup says "${lines}"`);
    expect(await T(p, "ctx-refresh").first().getAttribute("aria-disabled") === "true", `"Count again" is not off while the split is asked`);
    gate.go();
    expect(await until(() => T(p, "split").count(), 8000), `the split did not come`);
    expect(await text(T(p, "usage-ctx")) === "Context: 42,900 of 200,000 tokens (21.4%)", `with the split the popup says "${await text(T(p, "usage-ctx"))}", not the first line alone`);
    expect(!await T(p, "usage-note").filter({ hasText: "Counting" }).count(), `"Counting what fills it…" stays after the split came`);
    const asks = () => calls.filter((c) => CONTEXT.test(`${c.method} ${c.path}`));
    expect(asks().length === 1 && !/fresh/.test(asks()[0].path), `the popup asked ${asks().length} times, first as ${asks()[0]?.path}`);
    await press(p, T(p, "ctx-refresh").first());
    expect(await until(() => asks().length === 2 && /fresh=1/.test(asks()[1].path), 5000), `"Count again" did not ask with fresh=1 (${asks().map((c) => c.path).join(", ")})`);
    await ctx.close();
  });
  await step("an unstarted chat, a 409 and a failure", async () => {
    // a chat that has not started: the popup says what it will show, asks the server nothing about the context and has no "Count again"
    let o = await page("plain-new", { context: json(200, SPLIT) });
    await popOpen(o.p);
    await o.p.waitForTimeout(300);
    expect(!o.calls.some((c) => CONTEXT.test(`${c.method} ${c.path}`)) && !await T(o.p, "ctx-refresh").count() && !await T(o.p, "split").count(), `an unstarted chat asked for a split or offers "Count again"`);
    await o.ctx.close();
    // the server says it has not started (409): no error, the numbers stay
    o = await page("plain-started", { context: json(409, { error: "not started", code: "not_started" }) });
    await popOpen(o.p);
    await until(() => o.calls.some((c) => CONTEXT.test(`${c.method} ${c.path}`) && c.status), 5000);
    await o.p.waitForTimeout(300);
    expect(!await T(o.p, "usage-context").locator('[data-testid="usage-err"]').count(), `a 409 is shown as an error`);
    expect(/System prompt, tools, board reads/.test(await text(T(o.p, "usage-ctx"))), `after a 409 the popup lost its lines`);
    await o.ctx.close();
    // another failure is a line
    o = await page("plain-started", { context: json(500, { error: "the agent did not answer" }) });
    await popOpen(o.p);
    expect(await until(async () => /the agent did not answer/.test(await text(T(o.p, "usage-context"))), 5000), `a failed split is not shown as a line`);
    await o.ctx.close();
  });

  // ---- the split: rows, bar, slots, shares, parts, items, the mark
  await step("the split", async () => {
    const { p, ctx } = await page("plain-started", { context: json(200, SPLIT), plan: json(200, PLAN()) });
    await popOpen(p);
    await T(p, "split").first().waitFor({ state: "visible", timeout: 8000 });
    const rows = await rowsOf(p);
    const want = [["system_prompt", "System prompt", "6,200", "3.1%"], ["system_tools", "System tools", "14,300", "7.1%"], ["mcp_tools", "MCP tools", "400", "0.2%"], ["skills", "Skills", "36", "<0.1%"],
      ["messages", "Messages", "43,000", "22%"], ["mystery", "Something new", "1,000", "0.5%"], ["autocompact", "Autocompact buffer", "7,800", "3.9%"], ["free", "Free space", "128,200", "64%"], ["deferred_tools", "Deferred tools", "3,000", "1.5%"]];
    expect(J(rows.map((r) => [r.cat, r.label, r.num, r.pct])) === J(want), `the rows read ${J(rows.map((r) => [r.cat, r.label, r.num, r.pct]))}, not ${J(want)}`);
    const segs = await segsOf(p);
    // (bar order: Claude's known categories in their order, then unknown ones, then the buffer; slots 1 system prompt, 5 tools, 6 MCP, 7 skills, 3 messages)
    expect(J(segs.map((s) => [s.cat, s.slot])) === J([["system_prompt", "1"], ["system_tools", "5"], ["mcp_tools", "6"], ["skills", "7"], ["messages", "3"], ["mystery", "0"], ["autocompact", "0"]]),
      `the bar's segments are ${J(segs.map((s) => [s.cat, s.slot]))}`);
    const tools = segs.find((s) => s.cat === "system_tools"), prompt = segs.find((s) => s.cat === "system_prompt");
    expect(tools.w > prompt.w * 2 && prompt.w > 2.5, `the segments are not as wide as their tokens (system tools ${tools.w} px, system prompt ${prompt.w} px)`);
    expect(await text(T(p, "split-foot")) === "As of message 7 · 71,800 tokens as Claude Code counts them", `the foot says "${await text(T(p, "split-foot"))}"`);
    const sub = await text(T(p, "usage-body"));
    expect(sub.includes("Listed, loaded when used") && /Model claude-opus-4 Auto-compact on/.test(sub), `"Listed, loaded when used" or the agent's facts are missing`);
    expect(sub.indexOf("Listed, loaded when used") > sub.indexOf("Free space") && sub.indexOf("Deferred tools") > sub.indexOf("Listed, loaded when used"), `the deferred tools are not listed after free space`);
    // a row opens its parts, with a bar of their own, and its items largest first with a note
    await press(p, T(p, "split-row", { cat: "messages" }).first());
    expect(await until(async () => (await rowsOf(p)).some((r) => r.cat === "tool_results"), 5000), `Messages did not open its parts`);
    const parts = (await rowsOf(p)).filter((r) => ["tool_results", "assistant", "user"].includes(r.cat));
    expect(J(parts.map((r) => [r.label, r.num, r.pct])) === J([["Tool results", "20,000", "10%"], ["Assistant", "15,000", "7.5%"], ["User", "8,000", "4%"]]), `the parts read ${J(parts.map((r) => [r.label, r.num, r.pct]))}`);
    expect(await T(p, "split-bar").count() === 2, `the parts have ${await T(p, "split-bar").count() - 1} bars of their own, not 1`);
    expect(await T(p, "split-row", { cat: "messages" }).first().getAttribute("aria-expanded") === "true", `an open row does not say aria-expanded`);
    await press(p, T(p, "split-row", { cat: "system_tools" }).first());
    expect(await until(() => T(p, "split-item").count().then((n) => n === 3), 5000), `System tools did not open its three items`);
    const items = (await T(p, "split-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    expect(J(items) === J(["Bash 1,200", "Read · built-in 900", "Edit 700"]), `the items read ${J(items)}, not largest first with a note`);
    await press(p, T(p, "split-row", { cat: "system_tools" }).first());
    expect(await until(async () => !await T(p, "split-item").count(), 3000), `a second press did not close the items`);
    // the mark: a press (a finger) or the pointer on a row marks it and dims the other segments; the pointer on a segment marks its row
    await press(p, T(p, "split-row", { cat: "mcp_tools" }).first());
    expect(await until(async () => (await rowsOf(p)).filter((r) => r.on).map((r) => r.cat).join() === "mcp_tools", 3000), `pointing at MCP tools marked ${(await rowsOf(p)).filter((r) => r.on).map((r) => r.cat).join() || "no row"}`);
    const dim = await segsOf(p);
    expect(dim.filter((s) => s.opacity === "1").map((s) => s.cat).join() === "mcp_tools" && dim.filter((s) => parseFloat(s.opacity) < 0.5).length === dim.length - 1, `the other segments are not dimmed: ${J(dim.map((s) => [s.cat, s.opacity]))}`);
    if (viewport === "desktop") {
      await hover(p, T(p, "split-seg", { cat: "messages" }).first());
      expect(await until(async () => (await rowsOf(p)).filter((r) => r.on).map((r) => r.cat).join() === "messages", 3000), `the pointer on the Messages segment marked ${(await rowsOf(p)).filter((r) => r.on).map((r) => r.cat).join() || "no row"}`);
      await p.mouse.move(2, 2);
      expect(await until(async () => !(await rowsOf(p)).some((r) => r.on), 3000), `the mark stays when the pointer leaves the split`);
    }
    await ctx.close();
  });

  // ---- kept: the popup opens with the last answers, while it asks again
  await step("the last answers are kept", async () => {
    const { p, ctx } = await page("plain-started", { context: json(200, SPLIT), plan: json(200, PLAN()) });
    await popOpen(p);
    await T(p, "split").first().waitFor({ state: "visible", timeout: 8000 });
    await T(p, "usage-row").first().waitFor({ state: "visible", timeout: 8000 });
    await popClose(p);
    // both answers are held now: the popup shows the kept ones at once and says it is updating
    const split = held(json(200, SPLIT)), plan = held(json(200, PLAN()));
    await p.route(callMatcher(CONTEXT), async (route) => route.fulfill(await split.answer()));
    await p.route(callMatcher(USAGE), async (route) => route.fulfill(await plan.answer()));
    await popOpen(p);
    expect(await T(p, "split").count() === 1 && await T(p, "usage-row").count() === 3, `the popup did not open with the last split and plan (${await T(p, "split").count()} splits, ${await T(p, "usage-row").count()} limits)`);
    expect(await until(async () => (await text(T(p, "split-foot"))) === "Updating…" && (await text(T(p, "usage-foot"))) === "Updating…", 5000), `the kept numbers do not say "Updating…" while they are asked again`);
    expect(!await T(p, "usage-note").filter({ hasText: "Checking" }).count(), `"Checking your plan…" shows over the kept numbers`);
    split.go(); plan.go();
    expect(await until(async () => /^Updated /.test(await text(T(p, "usage-foot"))) && /^As of message/.test(await text(T(p, "split-foot"))), 5000), `the feet do not return after the answers`);
    await ctx.close();
  });

  // ---- the plan: heading by agent and server, limits, feet, refusals
  await step("the plan of Claude", async () => {
    const gate = held(json(200, PLAN()));
    const { p, ctx, calls } = await page("plain-started", { plan: gate.answer, context: json(200, SPLIT) });
    await popOpen(p);
    expect(await until(async () => /Checking your plan…/.test(await text(T(p, "usage-plan"))), 5000), `no "Checking your plan…" while the plan is asked`);
    expect(await heading(T(p, "usage-plan")) === "Plan usage limits↻", `the plan's heading is "${await heading(T(p, "usage-plan"))}"`);
    gate.go();
    await T(p, "usage-row").first().waitFor({ state: "visible", timeout: 8000 });
    const rows = await p.evaluate(() => [...document.querySelectorAll('[data-testid="usage-row"]')].map((e) => ({ kind: e.dataset.kind, tone: e.dataset.tone, text: e.innerText.replace(/\s+/g, " ").trim(), pct: e.querySelector('[data-testid="usage-bar"]').dataset.pct })));
    expect(rows.map((r) => r.kind).join() === "session,weekly_all,weekly_scoped", `the limits are in the order ${rows.map((r) => r.kind).join()}, not session, weekly_all, weekly_scoped`);
    expect(rows.map((r) => r.tone).join() === "danger,warn,ok", `the limits' tones are ${rows.map((r) => r.tone).join()}, not danger, warn, ok (91%, 62%, 33%)`);
    expect(rows.map((r) => r.pct).join() === "91,62,33", `the bars are ${rows.map((r) => r.pct).join()} wide, not 91, 62, 33`);
    expect(/^Current session 91% Resets in 4h 14m · /.test(rows[0].text), `the session row reads "${rows[0].text}"`);
    expect(/^Current week \(all models\) 62% Resets in 1d 11h · /.test(rows[1].text) || /^Current week \(all models\) 62% Resets in 1d 1\dh · /.test(rows[1].text), `the week row reads "${rows[1].text}"`);
    expect(await text(T(p, "usage-foot")) === "Updated 3m ago", `the foot says "${await text(T(p, "usage-foot"))}", not "Updated 3m ago"`);
    expect(await T(p, "usage-foot").first().getAttribute("data-stale") === null, `numbers 3 minutes old are marked stale`);
    // "Check again": asks with fresh=1, says "Updating…" and is off while it waits
    const again = held(json(200, PLAN(ago(0))));
    await p.route(callMatcher(USAGE), async (route) => route.fulfill(await again.answer()));
    await press(p, T(p, "plan-refresh").first());
    expect(await until(() => calls.some((c) => USAGE.test(`${c.method} ${c.path}`) && /fresh=1/.test(c.path)), 5000), `"Check again" did not ask with fresh=1`);
    expect(await until(async () => (await text(T(p, "usage-foot"))) === "Updating…" && await T(p, "plan-refresh").first().getAttribute("aria-disabled") === "true", 5000), `while it is asked again the foot is "${await text(T(p, "usage-foot"))}" and Check again is not off`);
    again.go();
    expect(await until(async () => (await text(T(p, "usage-foot"))) === "Updated just now", 5000), `the foot says "${await text(T(p, "usage-foot"))}", not "Updated just now"`);
    await ctx.close();
  });
  await step("old numbers, no plan, a warning and a failure", async () => {
    let o = await page("plain-started", { plan: json(200, PLAN(ago(11 * MIN))), context: json(200, SPLIT) });
    await popOpen(o.p);
    await T(o.p, "usage-foot").first().waitFor({ state: "visible", timeout: 8000 });
    expect(await text(T(o.p, "usage-foot")) === "Updated 11m ago" && await T(o.p, "usage-foot").first().getAttribute("data-stale") === "true", `numbers 11 minutes old say "${await text(T(o.p, "usage-foot"))}" and are ${await T(o.p, "usage-foot").first().getAttribute("data-stale") ? "" : "not "}marked stale`);
    await o.ctx.close();
    // (the mock's own answer: no plan, with its note)
    o = await page("plain-started", { context: json(200, SPLIT) });
    await popOpen(o.p);
    expect(await until(async () => (await text(T(o.p, "usage-plan"))).includes("The mock has no plan limits."), 8000), `a plan with no limits does not say the agent's note ("${await text(T(o.p, "usage-plan"))}")`);
    await o.ctx.close();
    o = await page("plain-started", { plan: json(200, { plan: false, limits: [], fetchedAt: ago(0) }), context: json(200, SPLIT) });
    await popOpen(o.p);
    expect(await until(async () => (await text(T(o.p, "usage-plan"))).includes("Claude Code reported no plan limits."), 8000), `no note and no plan does not say "Claude Code reported no plan limits."`);
    await o.ctx.close();
    o = await page("plain-started", { plan: json(200, { ...PLAN(), note: "Claude was slow to answer" }), context: json(200, SPLIT) });
    await popOpen(o.p);
    expect(await until(async () => (await text(T(o.p, "usage-plan").locator('[data-testid="usage-err"]'))) === "Claude was slow to answer", 8000), `a warning on a plan is not shown as a line under its limits`);
    await o.ctx.close();
    o = await page("plain-started", { plan: json(502, { error: "the usage command failed" }), context: json(200, SPLIT) });
    await popOpen(o.p);
    expect(await until(async () => (await text(T(o.p, "usage-plan"))).includes("the usage command failed"), 8000), `a failed plan is not shown as a line`);
    expect(await T(o.p, "usage-row").count() === 0, `a failed plan shows limits`);
    await o.ctx.close();
  });
  await step("the plan by agent and by server", async () => {
    // Cursor: its own heading and its limits' detail
    let o = await page("plain-started", { before: `chats.c_plain.agent = "cursor";`, context: json(200, SPLIT),
      plan: json(200, { plan: true, fetchedAt: ago(MIN), limits: [{ kind: "individual.overall", label: "Total usage", percent: 38, detail: "$413.89 of $1,101", resetsAt: inMs(10 * 86_400_000) }] }) });
    await popOpen(o.p);
    await T(o.p, "usage-row").first().waitFor({ state: "visible", timeout: 8000 });
    expect((await heading(T(o.p, "usage-plan"))).startsWith("Cursor usage"), `Cursor's heading is "${await heading(T(o.p, "usage-plan"))}"`);
    expect((await text(T(o.p, "usage-row"))).startsWith("Total usage $413.89 of $1,101 · 38%"), `Cursor's limit reads "${await text(T(o.p, "usage-row"))}"`);
    expect(o.calls.some((c) => /^GET \/api\/usage\/cursor/.test(`${c.method} ${c.path}`)), `Cursor's plan was not asked for Cursor`);
    await o.ctx.close();
    // Pi: the popup is the context alone and nothing is asked
    o = await page("plain-started", { before: `chats.c_plain.agent = "pi";`, context: json(200, { ...SPLIT, categories: [{ id: "messages", label: "Messages", tokens: 43000, kind: "used" }, { id: "free", label: "Free space", tokens: 157000, kind: "free" }] }) });
    await popOpen(o.p);
    await T(o.p, "split").first().waitFor({ state: "visible", timeout: 8000 });
    await o.p.waitForTimeout(300);
    expect(!await T(o.p, "usage-plan").count() && !o.calls.some((c) => USAGE.test(`${c.method} ${c.path}`)), `Pi's popup has a plan section or asked for a plan`);
    expect((await rowsOf(o.p)).map((r) => r.cat).join() === "messages,free", `Pi's split reads ${(await rowsOf(o.p)).map((r) => r.cat).join()}, not messages, free`);
    await o.ctx.close();
    // a chat of another server: the plan is that server's, asked of it and named
    const remote = state("plain-remote-started");
    o = await page("plain-remote-started", { context: json(200, SPLIT), plan: json(200, PLAN()) });
    await popOpen(o.p);
    await T(o.p, "usage-row").first().waitFor({ state: "visible", timeout: 8000 });
    const server = (await T(o.p, "chat-head-server").first().innerText()).trim();
    expect((await heading(T(o.p, "usage-plan"))).startsWith(`Plan usage on ${server}`), `the plan of a chat on ${server} is headed "${await heading(T(o.p, "usage-plan"))}"`);
    const ask = o.calls.find((c) => USAGE.test(`${c.method} ${c.path}`));
    expect(!!ask && ask.server !== "local" && remote.sel.chat.includes("~") && remote.sel.chat.startsWith(ask.server), `the plan was asked of ${ask?.server}, not of the chat's server (${remote.sel.chat})`);
    await o.ctx.close();
  });
  note(`the ring, the context and its split, the plan of Claude, Cursor and a server's, at ${viewport}`);
}, { viewports, page: false });
