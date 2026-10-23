// L19 (package S7): the subagents of a chat on the new build, at the three viewports — what no old check proved (B-SA-01 to B-SA-19,
// B-SM-10, B-US-12, C-SS-07, C-SS-11; the old S1.1, ported as S1.1-subagents.mjs here, proves the Subagents chip's list). Six parts:
//   rows     c_nested of the mock (subagents three levels deep): a row for each, nested ones under the one that started them, the mark of its
//            state (a ring that stands still for one that waits), the name with its glyph, the "background" tag, the line (the waiting one
//            says what it waits on, alone or with its background work, a finished one "Done · …"), the stats (model, tool calls, run time, the ring with its percentage), the row
//            of a result in the thread; a press opens the subagent, the open row is marked, a second press on it closes the drawer, Enter
//            does the same on a focused row (desktop, tablet); the row of a call not linked yet opens nothing, and the line of one not
//            carried over, of one that failed, one that stopped and one with a status this client does not know
//   retry    a subagent that is retried ("Retrying in 40 s · 2 of 4", counting down, muted), one that is paused ("Paused · login failed", the error tone, no
//            pulsing dot) and one with a status no client knows (its word): each says so in its row, and the other rows of the list still draw
//   drawer   its place (beside the page at most 700 points and 58 % of the window; on the phone the pushed screen, whose back closes it),
//            the crumb of a nested subagent and the way back through it, "‹ n/N ›" through the tree in order and wrapping, ×, Esc (the composer's
//            Esc does not stop the chat; with the composer's @ list open the list takes the first Esc and the drawer the next, B-SA-16;
//            a keyboard, so not the phone, whose drawer is a screen with the back), the prompt cut over 8 lines with Show all and Show less, the thread and the Report, "Loading…" while
//            the thread is fetched and "Starting…" for one with no item yet, a permission card asked by the subagent answered from the drawer,
//            the drawer closed with the chat (another chat opens)
//   scroll   B-SM-10: the drawer of a subagent at work opens at the end of its thread and follows it; one that has ended opens at its top; opening
//            another starts over
//   off      B-RO-13: the drawer of a section's subagent whose thread is being fetched when that server drops says why in place of "Loading…"
//   chip     C-SS-07 and C-SS-11: a refused pick is told under the composer and changes nothing; the chip of a chat whose server is away is fixed
//            with that reason
import { callMatcher, callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { MORE, chip, frame, openAt, playable } from "./composer.mjs";
import { back, byTid, openChat, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const WAIT = 15000;
/** A click at the left of a row: on the wide layouts the drawer lies over the right of the page, where the middle of a row may be. */
const LEFT = { position: { x: 24, y: 10 } };
/** In the mock: a chat with these items and subagents (and the thread of each subagent), told to the page. */
const make = (id, o, list, subList = [], threads = {}) => `chats.${id} = chat(${J(id)}, ${J({ name: id, group: "g_shop", ...o })}); items.${id} = ${J(list)}; subs.${id} = ${J(subList)}; ${Object.entries(threads).map(([sid, its]) => `subItems[${J(id + "/" + sid)}] = ${J(its)};`).join(" ")} send({ type: "snapshot", ...snapshot() });`;
const call = (id, sid, description, more) => ({ kind: "tool", toolId: id, name: "Agent", input: { description, prompt: `${description}.` }, result: "Done.", ...(sid ? { subagent: sid } : {}), ...more });
const sub = (id, tool, description, o) => ({ id, tool, description, prompt: `${description}. Report.`, kind: "claude", model: "sonnet", effort: "medium", status: "completed", started: 1000, ended: 61000, tokens: 20000, window: 200000, toolUses: 2, ...o });
const say = (text) => ({ kind: "text", done: true, text });

await check("L19 subagents: the rows in the thread, the drawer, its thread and report, the chip's refusals", async ({ url, viewport, layout, open, fail, note }) => {
  const phone = layout === "phone";
  await seed(url, "A1");
  /** What a row of the thread shows (all rows under it too), in the order they are on screen. */
  const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="sub-row"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((r) => {
    const q = (id) => r.querySelector(`[data-testid="${id}"]`);
    return { sub: r.dataset.sub, status: r.dataset.status, waiting: r.dataset.waiting === "true", on: r.dataset.on === "true", pressed: r.getAttribute("aria-pressed"), desc: q("sub-desc")?.textContent ?? "", bg: !!q("sub-bg"), type: q("sub-type")?.textContent ?? "",
      agent: q("sub-agent")?.textContent ?? "", line: q("sub-line")?.textContent ?? "", tone: q("sub-line")?.dataset.tone ?? "", model: q("sub-model")?.textContent ?? "", tools: q("sub-tools")?.textContent ?? "", time: q("sub-time")?.textContent ?? "",
      meter: q("ctx-meter")?.textContent ?? "", dot: !!q("sub-dot"), mark: q("sub-mark")?.textContent ?? "", nested: !!r.closest('[data-testid="sub-children"]') };
  }));
  const rowOf = (page, sid) => byTid(page, "sub-row", { sub: sid }).first();
  const drawerOf = (page) => page.evaluate(() => {
    const d = document.querySelector('[data-testid="sub-drawer"]');
    if (!d) return null;
    const q = (id) => d.querySelector(`[data-testid="${id}"]`), all = (id) => [...d.querySelectorAll(`[data-testid="${id}"]`)], r = d.getBoundingClientRect();
    return { sub: d.dataset.sub, status: d.dataset.status, layout: d.dataset.layout, left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), iw: innerWidth, name: q("sub-desc")?.textContent ?? "",
      crumbs: all("sub-crumb").map((c) => c.textContent), crumbHead: q("sub-crumbs")?.textContent ?? "", pos: q("sub-pos")?.textContent ?? "", line: q("sub-line")?.textContent ?? "",
      prompt: q("sub-prompt-text")?.textContent ?? "", clamped: q("sub-prompt-text")?.dataset.clamped ?? "", more: q("sub-prompt-more")?.textContent ?? "", report: q("sub-report")?.textContent ?? "",
      loading: !!q("sub-loading"), starting: !!q("sub-starting"), off: q("sub-off")?.textContent ?? "", msgs: all("msg").length, cards: all("tool-card").length, perms: all("perm").length };
  });
  const inDrawer = (page, id, data) => byTid(page, "sub-drawer").locator(tidSel(id, data));
  const shut = (page) => until(async () => !(await drawerOf(page)), WAIT);
  const at = (page, sid) => until(async () => (await drawerOf(page))?.sub === sid, WAIT);

  // ---- the rows, and a press
  {
    const { page, ctx } = await open({ sel: { chat: "c_nested" }, wait: tidSel("sub-row") });
    const name = "c_nested";
    try {
      await until(async () => (await rowsOf(page)).length === 6, WAIT);
      // (the list places a row by its estimate until it is measured: the rows are read once their places stop moving, or the one below a tall row can stand over its last child)
      let last = "";
      await until(async () => { const now = J(await page.evaluate(() => [...document.querySelectorAll('[data-testid="sub-row"]')].map((r) => Math.round(r.getBoundingClientRect().top)))); const same = now === last; last = now; if (!same) await page.waitForTimeout(200); return same; }, WAIT);
      const rows = await rowsOf(page), by = Object.fromEntries(rows.map((r) => [r.sub, r]));
      if (J(rows.map((r) => r.sub)) !== J(["sa1", "sa1a", "sa1a1", "sa1a2", "sa1b", "sa2"])) fail(`${viewport}: the rows are ${J(rows.map((r) => r.sub))}, not the six subagents with the ones a subagent started under it`);
      if (J(rows.map((r) => r.nested)) !== J([false, true, true, true, true, false])) fail(`${viewport}: the nested rows are ${J(rows.map((r) => r.nested))}`);
      if (!by.sa1?.waiting || by.sa1.status !== "running" || by.sa1.dot || by.sa1.line !== "Waiting on 1 subagent") fail(`${viewport}: the subagent that waits on the one it started is ${J(by.sa1)}: a ring that stands still, "Waiting on 1 subagent"`);
      if (by.sa1a?.waiting || !by.sa1a?.dot || by.sa1a.tone !== "live" || !by.sa1a.line.endsWith("…")) fail(`${viewport}: the subagent at work is ${J(by.sa1a)}: a pulsing dot and the activity with "…"`);
      if (by.sa1a2?.mark !== "✓" || by.sa1a2.line !== "Done · Seven callers, two of them in tests." || by.sa1a2.tone !== "muted") fail(`${viewport}: the finished subagent is ${J(by.sa1a2)}`);
      if (by.sa2?.desc !== "Audit the payment step" || !by.sa2.bg || by.sa2.type || !by.sa2.agent.includes("Claude") || by.sa2.tools !== "8 tools" || by.sa2.time !== "2m 00s" || !by.sa2.model || !/\d+%/.test(by.sa2.meter)) fail(`${viewport}: the name and stats of a finished subagent are ${J(by.sa2)}: glyph and name, "background", 8 tools, 2m 00s, a model, the ring with its percentage`);
      // the row of a result, in the thread
      const result = await byTid(page, "sub-result").first().textContent();
      if (result !== "Subagent result · Audit the payment step · Done · sent to the agent") fail(`${viewport}: the result row says "${result}"`);

      // a press opens the subagent; the open row is marked; a second press closes
      await press(page, rowOf(page, "sa2"), LEFT);
      if (!await at(page, "sa2")) fail(`${viewport}: a press on a row opened no drawer (${J(await drawerOf(page))})`);
      else {
        if (!(await rowsOf(page)).find((r) => r.sub === "sa2")?.on) fail(`${viewport}: the open subagent's row is not marked`);
        if (phone) { await back(page); await until(() => byTid(page, "sub-row", { sub: "sa2" }).first().isVisible(), WAIT); }
        else await press(page, rowOf(page, "sa2"), LEFT);
        if (!await shut(page)) fail(`${viewport}: ${phone ? "the back" : "a second press on the open row"} did not close the drawer`);
        else if ((await rowsOf(page)).some((r) => r.on)) fail(`${viewport}: a row is still marked open with no drawer`);
      }
      // a press on a result opens that subagent
      await press(page, byTid(page, "sub-result").first(), phone ? undefined : LEFT);
      if (!await at(page, "sa2")) fail(`${viewport}: a press on the result row opened ${J((await drawerOf(page))?.sub)}, not sa2`);
      if (phone) await back(page); else await press(page, byTid(page, "sub-result").first(), LEFT);
      await shut(page);
      // Enter on a focused row does the same (a keyboard)
      if (!phone) {
        await rowOf(page, "sa1b").focus();
        await page.keyboard.press("Enter");
        if (!await at(page, "sa1b")) fail(`${viewport}: Enter on a focused row opened ${J((await drawerOf(page))?.sub)}, not sa1b`);
        await page.keyboard.press("Escape");
        await shut(page);
      }
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
    note("six rows, nested ones under theirs, the marks and lines of a waiting, a running and a finished subagent, their stats, the result row; a press opens and a second closes");
  }

  // ---- a subagent that waits on background work (a shell or a Monitor of its own) says so: alone, and with the subagents it waits on
  {
    const { page, ctx } = await open({ sel: { chat: "c_nested" }, wait: tidSel("sub-row") });
    const mark = (id, o) => `{ const x = subs.c_nested.find((s) => s.id === ${J(id)}); Object.assign(x, ${J(o)}); send({ type: "sub", chat: "c_nested", branch: "main", subagent: x }); }`;
    try {
      await until(async () => (await rowsOf(page)).length === 6, WAIT);
      // sa1a1 runs and has no subagent: its own background work is all it waits on. sa1 waits on sa1a, which runs, and on background work.
      await mockEval(`${mark("sa1a1", { waiting: true, bgWaiting: true })} ${mark("sa1", { bgWaiting: true })}`, url);
      const lines = async () => Object.fromEntries((await rowsOf(page)).map((r) => [r.sub, r]));
      if (!await until(async () => (await lines()).sa1a1?.line === "Waiting for background work", WAIT)) fail(`${viewport}: a subagent that waits on background work alone says "${(await lines()).sa1a1?.line}", not "Waiting for background work"`);
      const by = await lines();
      if (!by.sa1a1.waiting || by.sa1a1.status !== "running" || by.sa1a1.dot || by.sa1a1.tone !== "muted") fail(`${viewport}: the subagent that waits on background work is ${J(by.sa1a1)}: a ring that stands still, in the muted tone`);
      if (by.sa1?.line !== "Waiting on 1 subagent and background work") fail(`${viewport}: the subagent that waits on one it started and on background work says "${by.sa1?.line}", not "Waiting on 1 subagent and background work"`);
      if (by.sa1a?.line.startsWith("Waiting")) fail(`${viewport}: a subagent at work that has no mark of waiting says "${by.sa1a?.line}"`);
    } catch (e) { fail(`${viewport}: background work: ${e.message.split("\n")[0]}`); }
    // (put back: other parts of this check count the waiting subagents of the seed)
    await mockEval(`${mark("sa1a1", { waiting: false, bgWaiting: false })} ${mark("sa1", { bgWaiting: false })}`, url);
    await ctx.close();
    note("a subagent that waits on background work says so, alone and with the subagent it waits on");
  }

  // ---- the drawer
  {
    const { page, ctx } = await open({ sel: { chat: "c_nested" }, wait: tidSel("sub-row") });
    const calls = callsOf(page), name = "the drawer";
    try {
      await until(async () => (await rowsOf(page)).length === 6, WAIT);
      await press(page, rowOf(page, "sa1a1"), LEFT);
      if (!await at(page, "sa1a1")) throw new Error(`a press on a nested row opened ${J((await drawerOf(page))?.sub)}`);
      await frame(page);
      let d = await drawerOf(page);
      // its place: beside the page (700 points at most, 58 % of the window) or the screen of the stack
      if (phone) {
        if (d.layout !== "phone" || d.width !== d.iw || !await byTid(page, "drawer-screen").count()) fail(`${viewport}: the drawer on the phone is ${J({ layout: d.layout, width: d.width, iw: d.iw })}, not the pushed screen`);
      } else if (d.right !== d.iw || d.width !== Math.min(700, Math.round(d.iw * 0.58))) fail(`${viewport}: the drawer lies from ${d.left} to ${d.right} of ${d.iw}, not ${Math.min(700, Math.round(d.iw * 0.58))} px at the right edge`);
      // the header of a nested one: the way back, the step
      if (d.name !== "Trace the rounding in tax.go" || d.status !== "running") fail(`${viewport}: the drawer shows ${J({ name: d.name, status: d.status })}`);
      if (J(d.crumbs) !== J(["Audit the cart", "Check the cart totals"]) || !d.crumbHead.startsWith("Subagent of")) fail(`${viewport}: the crumb is ${J(d.crumbs)} after "${d.crumbHead}"`);
      if (d.pos !== "3/6") fail(`${viewport}: the step says "${d.pos}", not 3/6 (sa1, sa1a, sa1a1, …)`);
      if (!/Grep|Searching|Searched|math\.Round/.test(d.line) && !d.line.endsWith("…")) fail(`${viewport}: the live line is "${d.line}"`);
      if (d.prompt !== "Trace the rounding in tax.go. Report what is wrong." || d.more) fail(`${viewport}: the prompt is ${J(d.prompt)} with "${d.more}"`);
      if (!await until(async () => { const x = await drawerOf(page); return x.msgs >= 1 && x.cards === 1; }, WAIT)) fail(`${viewport}: its thread shows ${J(await drawerOf(page))}: a reply and a Grep card`);
      // a crumb opens that subagent, and an outer one has no crumb
      await press(page, inDrawer(page, "sub-crumb").first());
      if (!await at(page, "sa1")) fail(`${viewport}: the crumb opened ${J((await drawerOf(page))?.sub)}, not sa1`);
      d = await drawerOf(page);
      if (d.crumbs.length || d.pos !== "1/6") fail(`${viewport}: the outermost subagent shows ${J({ crumbs: d.crumbs, pos: d.pos })}`);
      // the steps go through the tree in order and wrap
      for (const [button, want] of [["sub-next", ["sa1a", "sa1a1", "sa1a2", "sa1b", "sa2", "sa1"]], ["sub-prev", ["sa2"]]]) {
        for (const sid of want) {
          await press(page, inDrawer(page, button));
          if (!await at(page, sid)) { fail(`${viewport}: ${button} went to ${J((await drawerOf(page))?.sub)}, not ${sid}`); break; }
        }
      }
      // × closes
      await press(page, inDrawer(page, "sub-close"));
      if (!await shut(page)) fail(`${viewport}: × did not close the drawer`);
      // Esc closes it, and the composer under it does not also stop the chat (a keyboard)
      if (!phone) {
        await press(page, rowOf(page, "sa2"), LEFT);
        await at(page, "sa2");
        await byTid(page, "composer-input").first().focus().catch(() => {});
        await page.keyboard.press("Escape");
        if (!await shut(page)) fail(`${viewport}: Esc did not close the drawer`);
        await frame(page);
        if (calls.some((c) => c.method === "POST" && /\/interrupt/.test(c.path))) fail(`${viewport}: the Esc that closed the drawer also stopped the chat`);
      }
      // the drawer belongs to the chat on screen: another chat shows none
      await press(page, rowOf(page, "sa2"), LEFT);
      await at(page, "sa2");
      await openChat(page, "c_plain");
      if (!await shut(page)) fail(`${viewport}: the drawer stayed open over another chat`);
      await openChat(page, "c_nested");
      await frame(page);
      if (await drawerOf(page)) fail(`${viewport}: the drawer came back with its chat`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
    note("the drawer: its place, the crumb and the way back, ‹ n/N › in tree order and wrapping, ×, Esc without stopping the chat, closed with its chat");
  }

  // ---- Esc closes the innermost layer first (B-SA-16): the @ list of the composer, then the drawer; the composer's Esc stops the chat only when
  //      nothing is open. A board chat at work (its composer has the @ list and an Esc that stops it). On the phone the drawer is a screen
  //      with the back and no composer on it, and there is no Esc: none of this applies there.
  if (!phone) {
    const subs = [sub("e1", "c1", "Read the board", { status: "running", started: 1000, ended: undefined })];
    const list = [{ kind: "user", text: "Go." }, call("c1", "e1", "Read the board", { result: undefined }), say("Working.")];
    await mockEval(make("c_bsubs", { board: "b_arch", status: "tool", statusTool: "Bash" }, list, subs, { e1: [say("Reading.")] }), url);
    const { page, ctx } = await open({ sel: { board: "b_arch", chat: "c_bsubs" }, wait: tidSel("sub-row") });
    const calls = callsOf(page), name = "Esc closes the innermost layer";
    const stops = () => calls.filter((c) => c.method === "POST" && /\/interrupt/.test(c.path)).length;
    const box = byTid(page, "composer-input").first(), pop = byTid(page, "mention-pop");
    try {
      await press(page, rowOf(page, "e1"), LEFT);
      if (!await at(page, "e1")) throw new Error("the drawer did not open");
      await box.focus();
      await page.keyboard.type("@");
      if (!await until(() => pop.count(), WAIT)) throw new Error('"@" in the board chat opened no list');
      await page.keyboard.press("Escape");
      if (!await until(async () => !await pop.count(), WAIT)) fail(`${viewport}: Esc left the @ list open`);
      if (!await drawerOf(page)) fail(`${viewport}: the Esc that was for the @ list also closed the drawer`);
      if ((await box.textContent()) !== "@") fail(`${viewport}: Esc on the list changed the draft to ${J(await box.textContent())}`);
      await page.keyboard.press("Escape");
      if (!await shut(page)) fail(`${viewport}: the second Esc did not close the drawer`);
      await frame(page);
      if (stops()) fail(`${viewport}: an Esc that closed the list or the drawer stopped the chat`);
      // nothing is open now: the composer's Esc stops the chat at work (L16's, kept)
      await page.keyboard.press("Escape");
      if (!await until(() => stops(), WAIT)) fail(`${viewport}: Esc in the box of a busy chat with nothing open stopped nothing`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
    note("Esc: the @ list first (the draft stays, the drawer stays), the drawer next, neither stops the chat; with nothing open the composer's Esc stops it");
  }

  // ---- the prompt, the thread, the report, the rows that are not as a finished one
  {
    const LONG = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: read the file and say what you find.`).join("\n");
    const subs = [
      // (‹ › goes by the time they started: s1 to s6)
      sub("s1", "c1", "Review the sum", { prompt: LONG, summary: "The agent's own summary.", background: false, started: 1000 }),
      sub("s2", "c2", "Wait for it", { status: "running", started: 2000, ended: undefined, prompt: "Wait." }),
      sub("s3", "c3", "Copied while running", { status: "running", notCarried: true, started: 3000 }),
      sub("s4", "c4", "A failing one", { status: "failed", error: "The build failed.\nSecond line.", started: 4000 }),
      sub("s5", "c5", "A stopped one", { status: "stopped", started: 5000 }),
      sub("s6", "c6", "A newer status", { status: "frozen", started: 6000 }),
    ];
    const list = [{ kind: "user", text: "Go." }, call("c1", "s1", "Review the sum"), call("c2", "s2", "Wait for it", { result: undefined }), call("c3", "s3", "Copied while running"), call("c4", "s4", "A failing one"),
      call("c5", "s5", "A stopped one"), call("c6", "s6", "A newer status"), call("c7", "", "Not linked yet", { result: undefined }), say("Done."), { kind: "end" }];
    const permAsk = { kind: "perm", requestId: "q9", toolName: "Bash", input: { command: "rm -rf dist" }, subagent: "s1" };
    await mockEval(make("c_subs", {}, list, subs, { s1: [say("Working on it."), { kind: "tool", toolId: "x1", name: "Bash", input: { command: "ls" }, result: "a b" }, permAsk, say("The last words.")], s2: [] }), url);
    const { page, ctx } = await open({ sel: { chat: "c_subs" }, wait: tidSel("sub-row") });
    const calls = callsOf(page), name = "a chat with a subagent of each state";
    try {
      await until(async () => (await rowsOf(page)).length === 7, WAIT);
      const by = Object.fromEntries((await rowsOf(page)).map((r) => [r.sub, r]));
      if (by.s3?.line !== "Not carried over: it was running in the chat this was copied from" || by.s3.status !== "stopped" || by.s3.tone !== "muted") fail(`${viewport}: the subagent not carried over is ${J(by.s3)}`);
      if (by.s4?.line !== "The build failed." || by.s4.tone !== "error" || by.s4.mark !== "!") fail(`${viewport}: the failed subagent is ${J(by.s4)}`);
      if (by.s5?.line !== "Stopped" || by.s5.mark !== "■") fail(`${viewport}: the stopped subagent is ${J(by.s5)}`);
      if (by.s6?.line !== "frozen") fail(`${viewport}: a status this client does not know shows "${by.s6?.line}", not as it is`);
      // the call not linked yet: it ends with its result in the thread, built from the call, and it opens nothing
      const unlinked = (await rowsOf(page)).find((r) => r.sub === "");
      if (!unlinked || unlinked.desc !== "Not linked yet" || unlinked.status !== "stopped") fail(`${viewport}: the call not linked yet is ${J(unlinked)}: stopped, since no turn is running`);
      await press(page, byTid(page, "sub-row", { sub: "" }).first(), LEFT);
      await frame(page);
      if (await drawerOf(page)) fail(`${viewport}: a call not linked yet opened a drawer`);

      // the drawer of s1: the prompt cut over 8 lines, then the whole; the thread; the report
      await press(page, rowOf(page, "s1"), LEFT);
      if (!await at(page, "s1")) throw new Error("the drawer of s1 did not open");
      if (!await until(async () => (await drawerOf(page)).msgs >= 2, WAIT)) fail(`${viewport}: the thread of s1 shows ${J(await drawerOf(page))}`);
      // (B-TH-21, B-QS-05) the drawer's items are not the chat's messages: not quotable, and with no fork, branch or label to act on
      const inside = await page.evaluate(() => { const d = document.querySelector('[data-testid="sub-drawer"]'); return { msgs: d.querySelectorAll('[data-testid="msg"]').length, placed: d.querySelectorAll('[data-testid="msg"][data-item], [data-testid="msg"][data-quotable]').length, acts: d.querySelectorAll('[data-testid="fk-act"], [data-testid="fk-more"], [data-testid="fk-marker"]').length }; });
      if (inside.msgs < 2 || inside.placed || inside.acts) fail(`${viewport}: the subagent's thread in the drawer is ${J(inside)}: its messages are not the chat's (no place to quote, no fork or label)`);
      let d = await drawerOf(page);
      if (d.clamped !== "true" || d.more !== "Show all") fail(`${viewport}: a prompt of 12 lines is ${J({ clamped: d.clamped, more: d.more })}, cut with "Show all"`);
      await press(page, inDrawer(page, "sub-prompt-more"));
      d = await drawerOf(page);
      if (d.clamped !== "false" || d.more !== "Show less" || d.prompt !== LONG) fail(`${viewport}: after Show all the prompt is ${J({ clamped: d.clamped, more: d.more })}`);
      await press(page, inDrawer(page, "sub-prompt-more"));
      if ((await drawerOf(page)).clamped !== "true") fail(`${viewport}: Show less did not cut the prompt again`);
      // the report: the agent's own summary, which is not the thread's last text again; the thread's last text is not repeated
      await byTid(page, "sub-report").first().waitFor({ state: "attached", timeout: WAIT }).catch(() => {});
      d = await drawerOf(page);
      if (!d.report.includes("The agent's own summary.")) fail(`${viewport}: the report is ${J(d.report)}`);
      // a permission card asked by the subagent is answered from the drawer, naming the subagent
      const ask = inDrawer(page, "perm").first();
      if (!await until(() => ask.count(), WAIT)) fail(`${viewport}: the drawer shows no permission card of the subagent`);
      else {
        await press(page, byTid(ask, "perm-allow"));
        if (!await until(() => calls.some((c) => c.method === "POST" && /\/permission/.test(c.path)), WAIT)) fail(`${viewport}: Allow in the drawer made no call`);
        else if (J(calls.find((c) => c.method === "POST" && /\/permission/.test(c.path)).body) !== J({ requestId: "q9", allow: true, subagent: "s1" })) fail(`${viewport}: Allow in the drawer sent ${J(calls.find((c) => /\/permission/.test(c.path)).body)}`);
      }
      // a subagent at work with no item yet: "Starting…"; the one whose thread is on its way: "Loading…"
      await press(page, inDrawer(page, "sub-next"));
      await at(page, "s2");
      if (!await until(async () => (await drawerOf(page)).starting, WAIT)) fail(`${viewport}: a subagent at work with no item shows ${J(await drawerOf(page))}, not "Starting…"`);
      let release;
      const gate = new Promise((ok) => { release = ok; });
      await page.route(callMatcher(/^GET \/api\/chats\/c_subs\/subagents\/s4\/items/), async (route) => { await gate; await route.continue(); });
      await press(page, inDrawer(page, "sub-next")); await at(page, "s3");
      await press(page, inDrawer(page, "sub-next")); await at(page, "s4");
      if (!await until(async () => (await drawerOf(page)).loading, WAIT)) fail(`${viewport}: a thread being fetched shows ${J(await drawerOf(page))}, not "Loading…"`);
      release();
      if (!await until(async () => !(await drawerOf(page)).loading, WAIT)) fail(`${viewport}: "Loading…" stayed after the thread came`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
    note("the prompt cut and whole, the report, a permission card answered from the drawer, Starting… and Loading…; not carried over, failed, stopped, a newer status and a call not linked yet");
  }

  // ---- B-RO-13: the drawer of a subagent of a section's chat, its thread on its way, when that server drops: it says why in place of
  // "Loading…" (no call is made for it); this computer's chats always take a call, so the drawer of one has no such state
  {
    await seed(url, "A1", "SEC");
    const STUDIO = "s_studio", chatKey = `${STUDIO}~c_sx`, name = "B-RO-13";
    await mockEval(`onServer(${J(STUDIO)}, () => { chats.c_sx = chat("c_sx", { name: "Subs", group: "g_shop" }); items.c_sx = ${J([{ kind: "user", text: "Go." }, call("c1", "sx1", "A helper"), { kind: "end" }])};
      subs.c_sx = ${J([sub("sx1", "c1", "A helper")])}; subItems["c_sx/sx1"] = ${J([say("Done by the helper.")])}; });`, url);
    const { page, ctx } = await open({ sel: { chat: chatKey }, wait: tidSel("sub-row") });
    try {
      const fetched = [];
      await page.route(callMatcher(/^GET \/api\/chats\/c_sx\/subagents\/sx1\/items/, STUDIO), () => { fetched.push(1); }); // (held for good: the thread never comes)
      await press(page, byTid(page, "sub-row", { sub: "sx1" }).first(), LEFT);
      if (!await until(async () => (await drawerOf(page))?.loading, WAIT)) fail(`${viewport}: ${name}: the drawer of a thread being fetched shows ${J(await drawerOf(page))}, not "Loading…"`);
      await mockEval(`setServerState(${J(STUDIO)}, "unreachable", { detail: "connection refused" });`, url);
      if (!await until(async () => ((await drawerOf(page))?.off ?? "").includes("Studio Mac is not connected"), WAIT)) fail(`${viewport}: ${name}: the drawer of a server that dropped while its thread was fetched says ${J((await drawerOf(page))?.off)}, not why`);
      else if ((await drawerOf(page)).loading) fail(`${viewport}: ${name}: the drawer of a server that is away still says "Loading…"`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
  }

  // ---- a subagent that is retried after a temporary error, one that is paused, and one with a status this client has never heard of (goal 5.4,
  //      scenario 12): each says so in its row, and the other rows of the list still draw
  {
    const { page, ctx } = await open({ sel: { chat: "c_nested" }, wait: tidSel("sub-row") });
    const was = await mockEval("return JSON.parse(JSON.stringify(subs.c_nested));", url);
    const put = (id, o) => `{ const x = subs.c_nested.find((s) => s.id === ${J(id)}); Object.assign(x, ${J(o)}); send({ type: "sub", chat: "c_nested", branch: "main", subagent: x }); }`;
    const name = "a subagent that is retried, one that is paused, one with a status no client knows";
    try {
      await until(async () => (await rowsOf(page)).length === 6, WAIT);
      // sa1a1 runs (its line is its activity): it is retried, the second attempt in 40 s. sa1b has finished: it is paused, its login failed. sa2: a status of the future.
      await mockEval(`${put("sa1a1", { retry: { attempt: 2, of: 4, at: Date.now() + 40000, kind: "login" } })} ${put("sa1b", { status: "paused", errorKind: "login", error: "Failed to authenticate", delivery: undefined })} ${put("sa2", { status: "frozen" })}`, url);
      const lines = async () => Object.fromEntries((await rowsOf(page)).map((r) => [r.sub, r]));
      // (the page counts the wait down from the clock: 40 s when the row was drawn at once, less when the machine was slow to draw it)
      if (!await until(async () => /^Retrying in (3[6-9]|40) s · 2 of 4$/.test((await lines()).sa1a1?.line ?? ""), WAIT)) fail(`${viewport}: ${name}: the subagent that is retried says "${(await lines()).sa1a1?.line}", not "Retrying in 40 s · 2 of 4"`);
      const by = await lines();
      if (by.sa1a1.status !== "running" || by.sa1a1.tone !== "muted" || !by.sa1a1.dot) fail(`${viewport}: ${name}: the subagent that is retried is ${J(by.sa1a1)}: running, in the muted tone`);
      if (by.sa1b?.line !== "Paused · login failed" || by.sa1b.tone !== "error" || by.sa1b.status !== "paused" || by.sa1b.dot) fail(`${viewport}: ${name}: the paused subagent is ${J(by.sa1b)}: "Paused · login failed", in the error tone, with no pulsing dot`);
      if (by.sa2?.line !== "frozen" || by.sa2.tone !== "muted") fail(`${viewport}: ${name}: a status this client does not know shows ${J(by.sa2)}, not its word in the muted tone`);
      if (Object.keys(by).length !== 6 || by.sa1a2?.line !== "Done · Seven callers, two of them in tests.") fail(`${viewport}: ${name}: the other rows are ${J(Object.keys(by))}, sa1a2 says "${by.sa1a2?.line}"`);
      // the time counts down: the row is drawn again once a second
      const first = (await lines()).sa1a1.line;
      if (!await until(async () => (await lines()).sa1a1?.line !== first, WAIT)) fail(`${viewport}: ${name}: the line of the subagent that is retried stayed "${first}"`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    // (put back: other parts of this check count the subagents of the seed)
    await mockEval(`subs.c_nested.splice(0, subs.c_nested.length, ...${J(was)}); for (const x of subs.c_nested) send({ type: "sub", chat: "c_nested", branch: "main", subagent: x });`, url);
    await ctx.close();
    note("a subagent that is retried says when the next attempt is, a paused one why, one with a status no client knows its word, and the other rows draw");
  }

  // ---- the drawer follows its thread only while the subagent runs
  {
    const longThread = Array.from({ length: 80 }, (_, i) => say(`Line ${i + 1} of what the subagent said, long enough to take a row of its own in the drawer.`));
    const subs = [sub("r1", "c1", "At work", { status: "running", started: 1000, ended: undefined }), sub("r2", "c2", "Ended", { status: "completed", started: 2000 })];
    await mockEval(make("c_scroll", {}, [{ kind: "user", text: "Go." }, call("c1", "r1", "At work", { result: undefined }), call("c2", "r2", "Ended"), { kind: "end" }], subs, { r1: longThread, r2: longThread }), url);
    const { page, ctx } = await open({ sel: { chat: "c_scroll" }, wait: tidSel("sub-row") });
    const name = "B-SM-10";
    const scroll = () => page.evaluate(() => {
      const s = document.querySelector('[data-testid="sub-drawer-body"] [data-testid="thread-scroll"]');
      return s ? { top: Math.round(s.scrollTop), end: Math.round(s.scrollHeight - s.clientHeight), follows: s.dataset.follows } : null;
    });
    try {
      await press(page, rowOf(page, "r1"), LEFT);
      await at(page, "r1");
      if (!await until(async () => { const s = await scroll(); return !!s && s.end > 200 && s.top >= s.end - 60 && s.follows === "true"; }, WAIT)) fail(`${viewport}: the drawer of a subagent at work is ${J(await scroll())}: at the end of its thread and following it`);
      await press(page, inDrawer(page, "sub-next"));
      await at(page, "r2");
      if (!await until(async () => { const s = await scroll(); return !!s && s.end > 200 && s.top <= 2 && s.follows === "false"; }, WAIT)) fail(`${viewport}: the drawer of a subagent that ended is ${J(await scroll())}: at its top, following nothing`);
      await press(page, inDrawer(page, "sub-prev"));
      await at(page, "r1");
      if (!await until(async () => { const s = await scroll(); return !!s && s.end > 200 && s.top >= s.end - 60; }, WAIT)) fail(`${viewport}: opening the subagent at work again left the drawer at ${J(await scroll())}: the scroll starts over, at its end`);
    } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
    await ctx.close();
    note("B-SM-10: a subagent at work opens at the end of its thread and follows it, one that ended opens at its top, another starts over");
  }

  // ---- the chip: a refused pick, and a chat whose server is away
  {
    const states = (await seed(url, "A2")).filter((s) => playable(s, layout));
    const state = (id) => states.find((s) => s.id === id) ?? (() => { throw new Error(`the seed has no state ${id}`); })();
    const CHIP = (page) => chip(page, "subagents");
    const reach = async (page) => { if (!await CHIP(page).count() && await page.locator(MORE).count()) { await press(page, page.locator(MORE)); await until(() => CHIP(page).count(), 5000); } };
    const says = (page) => CHIP(page).first().evaluate((e) => ({ text: e.textContent.replace(/▾/g, "").trim(), fixed: e.dataset.fixed === "true", title: e.getAttribute("title") ?? "" }));
    const WIDE = { desktop: 900, tablet: 810, phone: 400 }[layout];
    {
      const p = await openAt(open, state("plain-new"), layout, WIDE), name = "a pick the server refuses";
      try {
        // (the mock's configure knob is for the agent, the model, the effort and the folder: the settings' pick is refused on the way)
        await p.page.route(callMatcher(/^PATCH \/api\/chats\/c_A2_new/), (route) => route.fulfill({ status: 409, contentType: "application/json", body: J({ error: "Refused for the test.", code: "refused" }) }));
        await reach(p.page);
        await press(p.page, CHIP(p.page));
        await byTid(p.page, "sub-opt", { section: "depth", value: 2 }).waitFor({ state: "visible", timeout: WAIT });
        await press(p.page, byTid(p.page, "sub-opt", { section: "depth", value: 2 }));
        if (!await until(async () => ((await byTid(p.page, "composer-err").first().textContent().catch(() => "")) ?? "").includes("Refused for the test."), WAIT)) fail(`${viewport}: ${name}: the composer says "${await byTid(p.page, "composer-err").first().textContent().catch(() => "")}" under it, not the refusal`);
        if ((await says(p.page)).text !== "Subagents1 level") fail(`${viewport}: ${name}: the chip says "${(await says(p.page)).text}" after a refused pick`);
      } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
      await p.ctx.close();
    }
    await seed(url, "A2");
    {
      const s = state("plain-off-new"), p = await openAt(open, s, layout, WIDE), name = "a chat whose server is away";
      try {
        await reach(p.page);
        const c = await says(p.page);
        if (!c.fixed || !/not connected/.test(c.title)) fail(`${viewport}: ${name}: the chip is ${J(c)}: fixed, with the reason that the server is not connected`);
      } catch (e) { fail(`${viewport}: ${name}: ${e.message.split("\n")[0]}`); }
      await p.ctx.close();
    }
    note("a refused pick is told under the composer and the chip keeps its words; the chip of a chat whose server is away is fixed with that reason");
  }
}, { viewports, page: false });
