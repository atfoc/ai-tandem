// UX.C2-pickers (package C2, ux-improvements goal 3.6 "chips and pickers" and 3.5 "An empty chat"; mockups "02 The chat's setup" and "03 The
// pickers"): the phone's chip row, its four pickers and the empty chat, on the mock's section UXC2 (dev/mock-ui.js: `seed(url, "UXC2")`; every session
// seeds it anew). At the PHONE only (light; a dark pass of the Agent sheet and the empty thread at the end):
//   1 the row       `composer-chip-row` in `new` holds the `tchip`s agent, folder, model, subagents in that order; each chip is 36 px high (±1), the
//                   text (`chip-name`) 15 px; the model chip says "<model> · <effort>". The web build gives no way to read a Pressable's hitSlop
//                   (react-native-web draws none), so the target is read as the row: 44 px high. `started` has no row; `fork` holds the model chip
//                   alone with `chip-note` "Only the model can change"; `missing` (a chat whose agent, cursor, its server lacks): the agent chip is
//                   red (`data-missing` true), the line `agent-reason` says "… is not installed …", and the Agent sheet lists that agent first,
//                   dimmed, with the reason. The row hides while the box has the focus with the keyboard up: on the web build `useKeyboardUp`
//                   (app/src/platform/keyboard.web.tsx) is always false, so what is asserted here is that the row STAYS while the box has the focus;
//                   the hiding itself is the device flow's (app/e2e composer-chips). A new chat opens with its box unfocused (the shell's focus
//                   keeps off a chat with a chip row at the phone), so on a device the keyboard is down and the row in sight.
//   2 Agent         `agent-sheet` titled "Agent", sub "New chat"; a `picker-row` per agent with its note; the chosen one tinted with ✓ (`picker-check`);
//                   `picker-foot` "A new agent starts with its own default model and effort."; no Done, no Cancel; a tap on another agent sends the
//                   configure call with that agent and closes the sheet; the chip names the new agent.
//   3 Model         `model-sheet` titled "Model and effort", sub "New chat · Claude Code", Done (`sheet-right`); rows ≥ 50 px with "… context" notes;
//                   `effort-seg` with the model's efforts and `effort-line`; a tap on another model sends configure {model} and the sheet STAYS open;
//                   a tap on an effort segment sends configure {effort}; Done closes; the chip says the new pair. In `pi` (ten models, three
//                   providers): `menu-head` sections with the providers, the search field (a part of a name: the rows filter).
//   4 Folder        `folder-sheet`: Cancel at the left (`sheet-left`), the title "Start the agent in", the server's name as sub; `dir-up` and `dir-path`
//                   each ≥ 44 px; the path's text ends with the folder's name; `dir-item` rows ≥ 52 px; a tap goes in (`dir-use` says "Use <name>");
//                   `dir-up` goes back; a tap on `dir-path` shows `dir-input` (a path + Enter lists it); an empty folder shows `dir-empty` with
//                   "No subfolders" and "Use this folder, or go up."; `dir-use` sends configure {cwd} and closes; Cancel closes and sends nothing.
//   5 Subagents     `sub-sheet` titled "Subagents", Done; `sub-depth` / `sub-cap` segments (`sub-opt`, dataSet section/value/on) each ≥ 44 px high; a depth
//                   pick sends configure and the sheet stays; depth Off greys `sub-cap` (data-disabled true) and its line says "With depth Off no
//                   subagent runs."; the chip's label follows.
//   6 Empty chat    in `new`: `empty-thread` with a 56 px tile, `empty-title` 22 px, the line 16 px, `config-hint` "Choose the agent, folder and model
//                   above the box. They lock when you send."; `starters` with "TRY ASKING" and two `suggestion` rows ≥ 48 px, full width less the
//                   16 px margins, their bottom within 40 px above the chip row; a tap on one sends it (the message reaches the mock).
//   7 Sizes         in every sheet opened above: no text under 13 px; every button, radio and menuitem at least 44 px high (a segment of a segmented
//                   control too: SEG_MIN; the track is its 44 and its border).
// Run: `cd web && npm run uicheck -- UX.C2`, or alone: node web/dev/checks/UX.C2-pickers.mjs (VIEWPORT=phone, DIST=… as README.md says).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const J = JSON.stringify;
// A segment of a segmented control (phone/chips/Segmented.tsx) is the track's height less its hairline border, which the web build draws 1 px wide: 42 of the
// track's 44 (the track itself is asserted ≥ 44). Native draws the hairline thinner. A known gap (results of chunk 6): the spec says the segment is 44.
const SEG_MIN = 44;
const NEW = "c_UXC2_new", BOX = "s_uxc2";

await check("UX.C2-pickers the phone's chip row, its four pickers and the empty chat", async ({ url, open, fail, note }) => {
  /** Seeds UXC2 anew, opens `sel` and waits for the box; calls `body(page, calls)`; closes the page when it ends. */
  const session = async (sel, body, ls) => {
    await seed(url, "UXC2");
    const o = await open({ sel, wait: tidSel("composer-input"), ...(ls ? { ls } : {}) });
    const calls = callsOf(o.page);
    try { await body(o.page, calls); } finally { await o.ctx.close().catch(() => {}); }
  };
  const box = (loc) => loc.boundingBox();
  const shows = async (page, what, id, data, on = true) => {
    const ok = await until(async () => (await byTid(page, id, data).first().isVisible().catch(() => false)) === on, WAIT);
    if (!ok) fail(`${what}: ${id}${data ? " " + J(data) : ""} is ${on ? "not drawn" : "still drawn"}`);
    return ok;
  };
  const text = async (loc) => ((await loc.first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const tid = (page, id, data) => byTid(page, id, data);
  const chip = (page, kind) => byTid(page, "tchip", { kind }).first();
  const px = (loc) => loc.first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  /** The calls to the chat's PATCH (configure) whose body has `key`. */
  const patches = (calls, chat, key, server = "local") => calls.filter((c) => c.method === "PATCH" && c.server === server && c.path.split("?")[0] === `/api/chats/${chat}` && c.body && key in c.body);
  const sent = (calls, chat, key, value, server) => until(async () => patches(calls, chat, key, server).some((c) => c.body[key] === value), WAIT);
  const open_ = async (page, kind, sheetId) => {
    await press(page, chip(page, kind));
    if (!(await shows(page, `a tap on the ${kind} chip`, sheetId))) return null;
    await settle(page, sheetId);
    return tid(page, sheetId).first();
  };
  /** The sheet has risen: its box is the same in two frames. */
  const settle = (page, id) => page.evaluate((s) => new Promise((done) => {
    const at = () => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? [r.y, r.height] : null; };
    let last = null, same = 0;
    const tick = () => { const now = at(); same = now && last && Math.abs(now[0] - last[0]) < 0.5 && Math.abs(now[1] - last[1]) < 0.5 ? same + 1 : 0; last = now; same >= 4 ? done() : requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), tidSel(id));
  /** Text under 13 px and buttons, radios and menuitems under 44 px high inside the sheet (step 7). */
  const sweep = async (page, id, what) => {
    const bad = await page.evaluate((css) => {
      const out = [];
      for (const root of document.querySelectorAll(css)) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const p = n.parentElement;
          if (!n.textContent.trim() || !p) continue;
          const r = p.getBoundingClientRect();
          if (!r.width || !r.height || getComputedStyle(p).visibility === "hidden") continue;
          const size = parseFloat(getComputedStyle(p).fontSize);
          if (size < 13) out.push(`text "${n.textContent.trim().slice(0, 30)}" is ${size} px`);
        }
        for (const b of root.querySelectorAll('[role="button"],[role="radio"],[role^="menuitem"],button')) {
          const r = b.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          if (r.height < (b.getAttribute("role") === "radio" && b.closest('[role="radiogroup"]') ? 41.5 : 43.5)) out.push(`${b.getAttribute("role") ?? "button"} "${(b.getAttribute("aria-label") ?? b.textContent ?? "").trim().slice(0, 30)}" [${b.getAttribute("data-testid") ?? ""}] is ${Math.round(r.height * 10) / 10} px high`);
        }
      }
      return out;
    }, tidSel(id));
    if (bad.length) fail(`sizes, ${what}: ${[...new Set(bad)].slice(0, 6).join("; ")}${bad.length > 6 ? ` … (${bad.length})` : ""}`);
  };
  const closed = (page, what, id) => shows(page, what, id, undefined, false);

  // ================= 1: the row
  await session({ chat: NEW }, async (page) => {
    if (!(await shows(page, "a new chat", "composer-chip-row"))) return;
    const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid="composer-chip-row"] [data-testid="tchip"]')].map((e) => e.dataset.kind));
    if (J(kinds) !== J(["agent", "folder", "model", "subagents"])) fail(`the chip row holds ${J(kinds)}, not agent, folder, model, subagents`);
    const row = await box(tid(page, "composer-chip-row").first());
    if (!row || Math.abs(row.height - 44) > 1) fail(`the row is ${row && Math.round(row.height)} px high, not 44 (the chips' 36 px and 4 px of hitSlop above and below)`);
    for (const k of kinds) {
      const b = await box(chip(page, k)), name = tid(chip(page, k), "chip-name");
      if (!b || Math.abs(b.height - 36) > 1) fail(`the ${k} chip is ${b && Math.round(b.height)} px high, not 36`);
      if (b && row && (b.y < row.y - 0.5 || b.y + b.height > row.y + row.height + 0.5)) fail(`the ${k} chip is outside the 44 px row`);
      const size = await px(name);
      if (size !== 15) fail(`the ${k} chip's text is ${size} px, not 15`);
    }
    const model = await text(tid(chip(page, "model"), "chip-name"));
    if (!/^.+ · .+$/.test(model)) fail(`the model chip says ${J(model)}, not "<model> · <effort>"`);
    else if (model !== "Opus 5.5 · High") fail(`the model chip says ${J(model)}, not "Opus 5.5 · High" (the chat's own pair)`);
    for (const [k, label] of [["agent", "Agent: Claude Code"], ["folder", "Folder: shop"], ["model", "Model and effort: Opus 5.5 · High"]]) {
      const got = await chip(page, k).getAttribute("aria-label");
      if (got !== label) fail(`the ${k} chip is labelled ${J(got)}, not ${J(label)}`);
    }
    // a new chat opens with the box unfocused (on a device: the keyboard down, so the row is in sight); a tap on the box gives it the focus
    await page.waitForTimeout(400); // (the shell's focus comes a moment after the chat opens: focusSelectedBox)
    if (await page.evaluate(() => document.activeElement?.dataset?.testid === "composer-input")) fail("a new chat opened with the focus in its box: on a phone the keyboard would hide the chip row");
    // the row stays while the box has the focus (the web build has no keyboard to hide it for)
    await press(page, tid(page, "composer-input").first());
    await page.waitForFunction(() => document.activeElement?.dataset?.testid === "composer-input", null, { timeout: WAIT });
    if (!(await tid(page, "composer-chip-row").first().isVisible())) fail("the chip row is gone while the box has the focus on the web build (useKeyboardUp is false there)");
    note(`the row: ${kinds.join(", ")}; 36 px chips of 15 px text in a 44 px row; the model chip "${model}"; the row stays with the focus in the box (web: no keyboard)`);
  });
  await session({ chat: "c_UXC2_started" }, async (page) => {
    await shows(page, "a started chat", "composer-input");
    await page.waitForTimeout(300);
    if (await tid(page, "composer-chip-row").count()) fail("a started chat has a chip row");
    if (await tid(page, "tchip").count()) fail("a started chat has chips");
    note("started: no chip row");
  });
  await session({ chat: "c_UXC2_fork" }, async (page) => {
    if (!(await shows(page, "a fork with no message of its own", "composer-chip-row"))) return;
    const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-testid="tchip"]')].map((e) => e.dataset.kind));
    if (J(kinds) !== J(["model"])) fail(`the fork's row holds ${J(kinds)}, the model chip alone`);
    const n = await text(tid(page, "chip-note"));
    if (n !== "Only the model can change") fail(`the fork's chip-note says ${J(n)}, not "Only the model can change"`);
    note(`fork: the model chip alone and "${n}"`);
  });
  await session({ chat: `${BOX}~c_UXC2_missing` }, async (page) => {
    if (!(await shows(page, "a chat whose agent its server lacks", "composer-chip-row"))) return;
    const a = chip(page, "agent");
    if ((await a.getAttribute("data-missing")) !== "true") fail(`the agent chip's data-missing is ${J(await a.getAttribute("data-missing"))}, not "true"`);
    const colour = await tid(a, "chip-name").first().evaluate((e) => getComputedStyle(e).color), border = await a.evaluate((e) => getComputedStyle(e).borderTopColor);
    const red = (c) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c); return !!m && +m[1] > 150 && +m[2] < 110 && +m[3] < 110; };
    if (!red(colour) || !red(border)) fail(`the missing agent's chip is not red: text ${colour}, border ${border}`);
    if (!/⚠|warn/i.test(await a.innerHTML()) && !(await a.locator("svg").count())) fail("the missing agent's chip has no warning sign");
    const reason = tid(page, "agent-reason").first();
    if (!(await shows(page, "a missing agent", "agent-reason"))) return;
    const line = await text(reason);
    if (!/is not installed/.test(line)) fail(`agent-reason says ${J(line)}, not "… is not installed …"`);
    if ((await reason.getAttribute("data-tone")) !== "missing") fail(`agent-reason's data-tone is ${J(await reason.getAttribute("data-tone"))}, not "missing"`);
    const sheet = await open_(page, "agent", "agent-sheet");
    if (sheet) {
      const rows = tid(sheet, "picker-row");
      if (!(await rows.count())) return fail("the Agent sheet of the missing agent has no rows");
      const first = rows.first();
      if ((await first.getAttribute("data-value")) !== "cursor") fail(`the first row of the Agent sheet is ${J(await first.getAttribute("data-value"))}, not the missing cursor`);
      if ((await first.getAttribute("aria-disabled")) !== "true") fail("the missing agent's row is not disabled (dimmed)");
      if (!/not installed/.test(await text(first))) fail(`the missing agent's row says ${J(await text(first))}, not the reason "… is not installed …"`);
      if (await rows.count() < 3) fail(`the Agent sheet lists ${await rows.count()} rows: the missing agent and the server's two`);
      await sweep(page, "agent-sheet", "the Agent sheet of the missing agent");
    }
    note(`missing: red chip with its warning sign, the line "${line}", the Agent sheet lists cursor first, dimmed, with the reason`);
  });

  // ================= 2: the Agent sheet
  await session({ chat: NEW }, async (page, calls) => {
    const sheet = await open_(page, "agent", "agent-sheet");
    if (!sheet) return;
    const title = await text(tid(sheet, "sheet-title")), sub = await text(tid(sheet, "sheet-sub"));
    if (title !== "Agent") fail(`the Agent sheet's title is ${J(title)}, not "Agent"`);
    if (sub !== "New chat") fail(`the Agent sheet's sub is ${J(sub)}, not "New chat"`);
    const rows = tid(sheet, "picker-row"), n = await rows.count();
    if (n < 2) return fail(`the Agent sheet has ${n} rows`);
    const values = [];
    for (let i = 0; i < n; i++) {
      const r = rows.nth(i), v = await r.getAttribute("data-value");
      values.push(v);
      const all = await text(r);
      if (all.replace(/✓/g, "").trim().split(" ").length < 3) fail(`the row of ${v} says ${J(all)}: no note of its own`);
    }
    if (!values.includes("claude")) fail(`the Agent sheet lists ${J(values)}, no claude`);
    const on = tid(sheet, "picker-row", { value: "claude" });
    if (!(await tid(on, "picker-check").count()) || (await tid(sheet, "picker-check").count()) !== 1) fail("the chosen agent has no ✓, or another row has one");
    if ((await on.getAttribute("aria-checked")) !== "true" && (await on.getAttribute("aria-selected")) !== "true") fail("the chosen agent's row is not marked chosen for a screen reader");
    if ((await tid(sheet, "picker-foot").count()) !== 1 || (await text(tid(sheet, "picker-foot"))) !== "A new agent starts with its own default model and effort.") fail(`the sheet's foot says ${J(await text(tid(sheet, "picker-foot")))}`);
    if (await tid(sheet, "sheet-right").count()) fail("the Agent sheet has a Done");
    if (await tid(sheet, "sheet-left").count()) fail("the Agent sheet has a Cancel");
    await sweep(page, "agent-sheet", "the Agent sheet");
    const other = values.find((v) => v !== "claude");
    await press(page, tid(sheet, "picker-row", { value: other }).first());
    if (!(await sent(calls, NEW, "agent", other))) fail(`a tap on ${other} sent no configure with {agent: ${other}}: ${J(patches(calls, NEW, "agent").map((c) => c.body))}`);
    await closed(page, `a tap on ${other}`, "agent-sheet");
    const label = await until(async () => /Agent: (?!Claude)/.test((await chip(page, "agent").getAttribute("aria-label")) ?? ""), WAIT);
    if (!label) fail(`the agent chip is labelled ${J(await chip(page, "agent").getAttribute("aria-label"))} after the pick of ${other}`);
    note(`Agent: "${title}" / "${sub}", rows ${values.join(", ")} with notes, ✓ on claude, the foot, no Done/Cancel; a tap on ${other} sends {agent} and closes; the chip says ${J(await chip(page, "agent").getAttribute("aria-label"))}`);
  });

  // ================= 3: the Model sheet
  await session({ chat: NEW }, async (page, calls) => {
    const sheet = await open_(page, "model", "model-sheet");
    if (!sheet) return;
    const title = await text(tid(sheet, "sheet-title")), sub = await text(tid(sheet, "sheet-sub"));
    if (title !== "Model and effort") fail(`the Model sheet's title is ${J(title)}, not "Model and effort"`);
    if (sub !== "New chat · Claude Code") fail(`the Model sheet's sub is ${J(sub)}, not "New chat · Claude Code"`);
    if ((await text(tid(sheet, "sheet-right"))) !== "Done") fail(`the Model sheet's right is ${J(await text(tid(sheet, "sheet-right")))}, not "Done"`);
    const rows = tid(sheet, "picker-row"), n = await rows.count();
    if (n !== 3) fail(`the Model sheet has ${n} rows, not the 3 models of Claude Code`);
    for (let i = 0; i < n; i++) {
      const b = await box(rows.nth(i));
      if (!b || b.height < 49.5) fail(`row ${i + 1} of the Model sheet is ${b && Math.round(b.height)} px high, under 50`);
      if (!/ context/.test(await text(rows.nth(i)))) fail(`row ${i + 1} of the Model sheet says ${J(await text(rows.nth(i)))}: no "… context" note`);
    }
    const seg = tid(sheet, "effort-seg");
    if (!(await seg.count())) return fail("the Model sheet has no effort-seg");
    const segs = async () => tid(seg, "segment").evaluateAll((els) => els.map((e) => ({ v: e.dataset.value, on: e.dataset.on, h: e.getBoundingClientRect().height, text: e.textContent.trim() })));
    let s = await segs();
    if (J(s.map((x) => x.v)) !== J(["low", "medium", "high", "max"])) fail(`opus's effort segments are ${J(s.map((x) => x.v))}, not low, medium, high, max`);
    if (s.find((x) => x.on === "true")?.v !== "high") fail(`the chosen effort is ${J(s.find((x) => x.on === "true")?.v)}, not high`);
    if (!(await text(tid(sheet, "effort-line")))) fail("the Model sheet has no effort-line");
    await sweep(page, "model-sheet", "the Model sheet");
    // another model: configure {model}, the sheet stays
    await press(page, tid(sheet, "picker-row", { value: "sonnet" }).first());
    if (!(await sent(calls, NEW, "model", "sonnet"))) fail(`a tap on Sonnet sent no configure {model: "sonnet"}: ${J(patches(calls, NEW, "model").map((c) => c.body))}`);
    await page.waitForTimeout(700);
    if (!(await tid(page, "model-sheet").first().isVisible().catch(() => false))) fail("a tap on a model closed the sheet: it holds Done and stays open");
    if (!(await until(async () => (await tid(sheet, "picker-row", { value: "sonnet" }).locator('[data-testid="picker-check"]').count()) === 1, WAIT))) fail("the chosen row did not move to Sonnet");
    s = await segs();
    if (J(s.map((x) => x.v)) !== J(["low", "medium", "high"])) fail(`sonnet's effort segments are ${J(s.map((x) => x.v))}, not low, medium, high`);
    for (const x of s) if (x.h < SEG_MIN) fail(`the ${x.v} effort segment is ${Math.round(x.h)} px high, under ${SEG_MIN}`);
    const track = await box(seg.first());
    if (!track || track.height < 43.5) fail(`the effort track is ${track && Math.round(track.height)} px high, under 44`);
    // an effort: configure {effort}
    await press(page, tid(seg, "segment", { value: "low" }).first());
    if (!(await sent(calls, NEW, "effort", "low"))) fail(`a tap on Low sent no configure {effort: "low"}: ${J(patches(calls, NEW, "effort").map((c) => c.body))}`);
    if (!(await until(async () => (await tid(seg, "segment", { value: "low" }).first().getAttribute("data-on")) === "true", WAIT))) fail("the Low segment is not the chosen one after its tap");
    await press(page, tid(sheet, "sheet-right").first());
    await closed(page, "Done", "model-sheet");
    const now = await text(tid(chip(page, "model"), "chip-name"));
    if (!/^Sonnet 5\.5 · Low$/i.test(now)) fail(`the model chip says ${J(now)} after the picks, not "Sonnet 5.5 · Low"`);
    note(`Model: "${title}" / "${sub}", Done, 3 rows ≥ 50 px with context notes, efforts ${J(["low", "medium", "high", "max"])} then ${J(["low", "medium", "high"])}; {model} keeps the sheet open, {effort} sent, Done closes; the chip says "${now}"`);
  });
  await session({ chat: `${BOX}~c_UXC2_pi` }, async (page) => {
    const sheet = await open_(page, "model", "model-sheet");
    if (!sheet) return;
    const heads = await tid(sheet, "menu-head").evaluateAll((els) => els.map((e) => e.textContent.trim()));
    if (J(heads) !== J(["Anthropic", "OpenAI", "Google"])) fail(`the pi sheet's section heads are ${J(heads)}, not Anthropic, OpenAI, Google`);
    const rows = tid(sheet, "picker-row"), n = await rows.count();
    if (n !== 10) fail(`the pi sheet lists ${n} models, not 10`);
    if (!(await tid(sheet, "search-field").count())) return fail("a catalog of ten models has no search field");
    const sf = await box(tid(sheet, "search-field").first());
    if (!sf || sf.height < 43.5) fail(`the search field is ${sf && Math.round(sf.height)} px high, under 44`);
    await tid(sheet, "search-field").first().fill("gemini");
    if (!(await until(async () => (await rows.count()) === 3, WAIT))) fail(`a search for "gemini" leaves ${await rows.count()} rows, not 3`);
    else for (const v of await rows.evaluateAll((els) => els.map((e) => e.dataset.value))) if (!/gemini/.test(v)) fail(`the search for "gemini" leaves ${v}`);
    await tid(sheet, "search-field").first().fill("zzzz");
    if (!(await shows(page, "a search with no match", "picker-empty"))) return;
    await tid(sheet, "search-field").first().fill("");
    if (!(await until(async () => (await rows.count()) === 10, WAIT))) fail("clearing the search did not bring the ten rows back");
    await sweep(page, "model-sheet", "the pi Model sheet");
    note(`pi: section heads ${J(heads)}, 10 rows, the search field filters ("gemini": 3 rows, "zzzz": none) and clears`);
  });

  // ================= 4: the Folder sheet
  await session({ chat: NEW }, async (page, calls) => {
    const sheet = await open_(page, "folder", "folder-sheet");
    if (!sheet) return;
    const left = await text(tid(sheet, "sheet-left")), title = await text(tid(sheet, "sheet-title")), sub = await text(tid(sheet, "sheet-sub"));
    if (left !== "Cancel") fail(`the Folder sheet's left is ${J(left)}, not "Cancel"`);
    if (title !== "Start the agent in") fail(`the Folder sheet's title is ${J(title)}, not "Start the agent in"`);
    if (sub !== "This computer") fail(`the Folder sheet's sub is ${J(sub)}, not the server's name "This computer"`);
    if (await tid(sheet, "sheet-right").count()) fail("the Folder sheet has a Done (it commits with Use)");
    if (!(await shows(page, "the folder list", "dir-item"))) return;
    for (const id of ["dir-up", "dir-path"]) {
      const b = await box(tid(sheet, id).first());
      if (!b || b.height < 43.5 || b.width < 43.5) fail(`${id} is ${b && Math.round(b.width)}×${b && Math.round(b.height)} px, under 44`);
    }
    const path = await text(tid(sheet, "dir-path"));
    if (!path.replace(/\s+$/, "").endsWith("shop")) fail(`the path says ${J(path)}, which does not end with the folder's name "shop"`);
    const items = tid(sheet, "dir-item"), names = await items.evaluateAll((els) => els.map((e) => e.textContent.trim()));
    if (J(names) !== J(["docs", "web"])) fail(`the folders in shop are ${J(names)}, not docs, web`);
    for (let i = 0; i < names.length; i++) { const b = await box(items.nth(i)); if (!b || b.height < 51.5) fail(`folder row ${i + 1} is ${b && Math.round(b.height)} px high, under 52`); }
    if ((await text(tid(sheet, "dir-use"))) !== "Use shop") fail(`dir-use says ${J(await text(tid(sheet, "dir-use")))}, not "Use shop"`);
    await sweep(page, "folder-sheet", "the Folder sheet");
    // in: docs is empty
    await press(page, items.filter({ hasText: "docs" }).first());
    if (!(await shows(page, "a tap on docs", "dir-empty"))) return;
    const empty = await text(tid(sheet, "dir-empty"));
    if (!/No subfolders/.test(empty) || !/Use this folder, or go up\./.test(empty)) fail(`the empty folder says ${J(empty)}, not "No subfolders" and "Use this folder, or go up."`);
    if ((await text(tid(sheet, "dir-use"))) !== "Use docs") fail(`dir-use says ${J(await text(tid(sheet, "dir-use")))} in docs, not "Use docs"`);
    if (!(await text(tid(sheet, "dir-path"))).trimEnd().endsWith("docs")) fail(`the path says ${J(await text(tid(sheet, "dir-path")))} in docs`);
    await sweep(page, "folder-sheet", "the empty folder");
    // up: back in shop
    await press(page, tid(sheet, "dir-up").first());
    if (!(await until(async () => (await text(tid(sheet, "dir-use"))) === "Use shop" && (await tid(sheet, "dir-item").count()) === 2, WAIT))) fail(`dir-up did not go back to shop: dir-use says ${J(await text(tid(sheet, "dir-use")))}`);
    // a typed path
    await press(page, tid(sheet, "dir-path").first());
    if (!(await shows(page, "a tap on the path", "dir-input"))) return;
    await tid(sheet, "dir-input").first().fill("~/projects");
    await page.keyboard.press("Enter");
    if (!(await until(async () => (await text(tid(sheet, "dir-use"))) === "Use projects", WAIT))) fail(`a typed path ~/projects + Enter did not list it: dir-use says ${J(await text(tid(sheet, "dir-use")))}`);
    else {
      const got = await tid(sheet, "dir-item").evaluateAll((els) => els.map((e) => e.textContent.trim()));
      if (J(got) !== J(["empty-repo", "scratch", "shop"])) fail(`the folders in projects are ${J(got)}, not empty-repo, scratch, shop`);
    }
    // Use: configure {cwd}, closes
    await press(page, tid(sheet, "dir-item").filter({ hasText: "empty-repo" }).first());
    if (!(await until(async () => (await text(tid(sheet, "dir-use"))) === "Use empty-repo", WAIT))) fail("a tap on empty-repo did not go in");
    await press(page, tid(sheet, "dir-use").first());
    if (!(await sent(calls, NEW, "cwd", "/Users/demo/projects/empty-repo"))) fail(`Use sent no configure {cwd: "/Users/demo/projects/empty-repo"}: ${J(patches(calls, NEW, "cwd").map((c) => c.body))}`);
    await closed(page, "Use", "folder-sheet");
    if (!(await until(async () => (await chip(page, "folder").getAttribute("aria-label")) === "Folder: empty-repo", WAIT))) fail(`the folder chip is labelled ${J(await chip(page, "folder").getAttribute("aria-label"))} after Use`);
    // Cancel: closes, sends nothing
    const before = patches(calls, NEW, "cwd").length;
    const again = await open_(page, "folder", "folder-sheet");
    if (again) {
      await shows(page, "the reopened sheet", "dir-use");
      await press(page, tid(again, "sheet-left").first());
      await closed(page, "Cancel", "folder-sheet");
      if (patches(calls, NEW, "cwd").length !== before) fail("Cancel sent a configure");
    }
    note(`Folder: Cancel / "${title}" / "${sub}"; up and path ≥ 44 px, rows ≥ 52 px; in docs the empty state "No subfolders"; up back; typed ~/projects lists 3; Use sends {cwd} and closes, the chip says empty-repo; Cancel sends nothing`);
  });

  // ================= 5: the Subagents sheet
  await session({ chat: NEW }, async (page, calls) => {
    const sheet = await open_(page, "subagents", "sub-sheet");
    if (!sheet) return;
    const title = await text(tid(sheet, "sheet-title")), sub = await text(tid(sheet, "sheet-sub"));
    if (title !== "Subagents") fail(`the Subagents sheet's title is ${J(title)}, not "Subagents"`);
    if (sub !== "New chat") fail(`the Subagents sheet's sub is ${J(sub)}, not "New chat"`);
    if ((await text(tid(sheet, "sheet-right"))) !== "Done") fail(`the Subagents sheet's right is ${J(await text(tid(sheet, "sheet-right")))}, not "Done"`);
    const segs = (section) => tid(sheet, "sub-opt", { section }).evaluateAll((els) => els.map((e) => ({ v: e.dataset.value, on: e.dataset.on, h: e.getBoundingClientRect().height })));
    for (const section of ["depth", "cap"]) {
      const s = await segs(section);
      if (s.length < 3) fail(`${section}: ${s.length} segments`);
      for (const x of s) if (x.h < SEG_MIN) fail(`the ${section} segment ${x.v} is ${Math.round(x.h)} px high, under ${SEG_MIN}`);
      const track = await box(tid(sheet, section === "depth" ? "sub-depth" : "sub-cap").first());
      if (!track || track.height < 43.5) fail(`the ${section} track is ${track && Math.round(track.height)} px high, under 44`);
    }
    if (!(await tid(sheet, "sub-depth").count()) || !(await tid(sheet, "sub-cap").count())) return fail("the sheet has no sub-depth or no sub-cap");
    await sweep(page, "sub-sheet", "the Subagents sheet");
    const had = await chip(page, "subagents").getAttribute("aria-label");
    await press(page, tid(sheet, "sub-opt", { section: "depth", value: "2" }).first());
    if (!(await until(async () => calls.some((c) => c.method === "PATCH" && c.path.split("?")[0] === `/api/chats/${NEW}` && c.body && c.body.subDepth === 2), WAIT))) fail(`a tap on depth 2 sent no PATCH {subDepth: 2}: ${J(calls.filter((c) => c.method === "PATCH").map((c) => c.body))}`);
    await page.waitForTimeout(500);
    if (!(await tid(page, "sub-sheet").first().isVisible().catch(() => false))) fail("a depth pick closed the sheet: it stays");
    if (!(await until(async () => (await segs("depth")).find((x) => x.on === "true")?.v === "2", WAIT))) fail("depth 2 is not the chosen segment after its tap");
    if ((await tid(sheet, "sub-cap").first().getAttribute("data-disabled")) === "true") fail("sub-cap is greyed with depth 2");
    // depth Off greys the cap
    await press(page, tid(sheet, "sub-opt", { section: "depth", value: "0" }).first());
    if (!(await until(async () => (await tid(sheet, "sub-cap").first().getAttribute("data-disabled")) === "true", WAIT))) fail(`depth Off did not grey sub-cap: data-disabled is ${J(await tid(sheet, "sub-cap").first().getAttribute("data-disabled"))}`);
    await until(async () => (await text(tid(sheet, "sub-cap-line"))) === "With depth Off no subagent runs.", WAIT); // (the grey comes with the save, the line with the answer)
    const line = await text(tid(sheet, "sub-cap-line"));
    if (line !== "With depth Off no subagent runs.") fail(`the cap's line says ${J(line)} with depth Off, not "With depth Off no subagent runs."`);
    await press(page, tid(sheet, "sheet-right").first());
    await closed(page, "Done", "sub-sheet");
    const now = await chip(page, "subagents").getAttribute("aria-label");
    if (now === had || !/Off/i.test(now ?? "")) fail(`the chip's label is ${J(now)} after depth Off (it was ${J(had)}), not one that says Off`);
    note(`Subagents: "${title}" / "${sub}", Done; depth and cap segments ≥ 44 px; depth 2 sent and the sheet stayed; Off greys sub-cap with its line; the chip went from ${J(had)} to ${J(now)}`);
  });

  // ================= 6: the empty chat
  await session({ chat: NEW }, async (page) => {
    if (!(await shows(page, "a new chat", "empty-thread"))) return;
    const m = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="empty-thread"]'), title = root.querySelector('[data-testid="empty-title"]');
      const tile = title.previousElementSibling.getBoundingClientRect();
      const line = [...root.querySelectorAll("div")].find((e) => /^The same session you get in a terminal/.test(e.textContent) && e.children.length <= 2 && !e.querySelector("div"));
      const px = (e) => (e ? parseFloat(getComputedStyle(e).fontSize) : null);
      return { tileW: tile.width, tileH: tile.height, title: px(title), line: px(line), lineText: line?.textContent ?? null };
    });
    if (Math.abs(m.tileW - 56) > 1 || Math.abs(m.tileH - 56) > 1) fail(`the tile is ${m.tileW}×${m.tileH}, not 56×56`);
    if (m.title !== 22) fail(`empty-title is ${m.title} px, not 22`);
    if (m.line !== 16) fail(`the line "${m.lineText?.slice(0, 40)}" is ${m.line} px, not 16`);
    const hint = await text(tid(page, "config-hint"));
    if (hint !== "Choose the agent, folder and model above the box. They lock when you send.") fail(`config-hint says ${J(hint)}`);
    if ((await text(tid(page, "empty-title"))) !== "Claude Code") fail(`empty-title says ${J(await text(tid(page, "empty-title")))}`);
    const starters = tid(page, "starters");
    if (!(await starters.count())) return fail("the empty chat has no starters block");
    if (!/TRY ASKING/i.test(await starters.first().innerText())) fail(`the starters' head is not "TRY ASKING": ${J((await starters.first().innerText()).slice(0, 40))}`);
    const rows = tid(page, "suggestion"), n = await rows.count(), w = page.viewportSize().width, rowTop = (await box(tid(page, "composer-chip-row").first()))?.y;
    if (n !== 2) fail(`${n} starters, not 2`);
    let lastBottom = 0;
    for (let i = 0; i < n; i++) {
      const b = await box(rows.nth(i));
      if (!b) { fail(`starter ${i + 1} is not drawn`); continue; }
      if (b.height < 47.5) fail(`starter ${i + 1} is ${Math.round(b.height)} px high, under 48`);
      if (Math.abs(b.x - 16) > 1.5 || Math.abs(b.width - (w - 32)) > 2) fail(`starter ${i + 1} is at x ${Math.round(b.x)}, ${Math.round(b.width)} px wide: not full width less the 16 px margins (${w - 32})`);
      lastBottom = Math.max(lastBottom, b.y + b.height);
    }
    const gap = rowTop - lastBottom;
    if (!(gap >= 0 && gap <= 40)) fail(`the last starter's bottom is ${Math.round(gap)} px above the chip row, not within 0–40`);
    const first = await text(rows.first());
    await press(page, rows.first());
    const texts = () => mockEval(`return (items[${J(NEW)}] ?? []).filter((x) => x.kind === "user").map((x) => x.text);`, url);
    if (!(await until(async () => (await texts()).includes(first), WAIT))) fail(`a tap on ${J(first)} did not send it: the mock has ${J(await texts())}`);
    note(`empty chat: tile 56, title 22, line 16, the hint, "TRY ASKING" and ${n} starters ≥ 48 px at full width less 16, ${Math.round(gap)} px above the row; a tap sent ${J(first)}`);
  });

  // ================= dark: the Agent sheet and the empty thread
  await session({ chat: NEW }, async (page) => {
    if (!(await shows(page, "the dark empty chat", "empty-thread"))) return;
    const lum = (css) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(css); return m ? (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255 : -1; };
    const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor), title = await tid(page, "empty-title").first().evaluate((e) => getComputedStyle(e).color);
    const bg = await tid(page, "empty-thread").first().evaluate((e) => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return "rgb(255, 255, 255)"; });
    if (lum(bg) > 0.3) fail(`dark: the empty chat's ground is ${bg} (page ${ground}), not dark`);
    if (lum(title) < 0.6) fail(`dark: the empty title's colour is ${title}, not light`);
    const hintColour = await tid(page, "config-hint").first().evaluate((e) => getComputedStyle(e).color);
    if (lum(hintColour) < 0.4) fail(`dark: the hint's colour is ${hintColour}, too dark on the dark ground`);
    const sheet = await open_(page, "agent", "agent-sheet");
    if (sheet) {
      const sbg = await sheet.evaluate((e) => { for (let x = e; x; x = x.parentElement) { const c = getComputedStyle(x).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return ""; });
      if (lum(sbg) > 0.3) fail(`dark: the Agent sheet's ground is ${sbg}, not dark`);
      const rowText = await tid(sheet, "picker-row").first().evaluate((e) => getComputedStyle(e.querySelector("*")).color);
      if (lum(rowText) < 0.5) fail(`dark: a row's text is ${rowText}, not light`);
      await sweep(page, "agent-sheet", "the dark Agent sheet");
    }
    note("dark: the empty chat and the Agent sheet are on a dark ground with light text");
  }, { "aiwb.theme": "dark" });
}, { viewports, page: false });
