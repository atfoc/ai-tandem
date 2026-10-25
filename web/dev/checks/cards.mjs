// The readers of the tool cards and permission cards for the checks of the new build (package S6; these replaced `toolCards`,
// `openCards` and `cardsFit` of dev/shot.mjs, which read the retired page's classes). No dash in the name: the runner does not take it for a check.
// testIDs of screens/tools: `tool-card` (dataSet kind shell | edit | write | delete | other, state running | denied | stopped | done, running, err,
// open) with `tool-row`, `tool-icon`/`tool-spin`, `tool-label`, `tool-hint`, `tool-show`, `tool-chev`; open: `tool-detail` holding `tool-path`
// (dataSet full) with `tool-path-name`, `tool-counts`, `tool-lines`; `tool-part` (dataSet failed) with `tool-sub`, `tool-lead`, `tool-text` or
// `tool-diff` (boxes), `tool-pre` (dataSet tokens: the coloured runs), `diff-row` (dataSet kind add | del | same | skip) with `diff-sign`,
// `diff-text`; `tool-omit` with `tool-omit-text`, `tool-show-all`, `tool-show-less`; `tool-note`; `tool-more` (the edits not drawn).
// A permission card: `perm` (dataSet state pending | allow | deny, closed) with `perm-sub`, `perm-title`, `perm-reason`, `perm-what`,
// `perm-actions` (`perm-allow`, `perm-deny`), `perm-done`, `perm-error`. The phone's card (package T2) has `perm-who` ("Claude wants to run a command") in
// the place of the wide card's `perm-sub` and the "Allow Bash?" title (its `perm-title` is the agent's own description), the command in `perm-what`,
// buttons Deny and Allow, and, once answered, one line `perm-folded` ("Allowed · <title>") that a tap opens to the card with its `perm-done`.
import { until } from "../shot.mjs";
import { byTid } from "./sel.mjs";

/** In the page: the tool cards under the element with testID `root`, top to bottom as they are on screen (a virtual list keeps no order in the
 *  page). Each: cls (what the old page had as classes: "running", "err", "k-<kind>"), label, hint (the line beside the label), open, and the
 *  open card's parts as they are drawn:
 *    { part: "path", path, title, counts, lines }          the file, "+1 −1", "9 lines"
 *    { part: "text", title, failed, lead, text, left, coloured, box }   title: "Command", "Output · failed", …; text: the texts of its blocks
 *                                                           (two when it is cut); left: "⋯ 2,980 lines left out"; coloured: how many runs
 *    { part: "change", title, rows, left, box }            rows: " same", "-removed", "+added", "@⋯ 60 unchanged lines"
 *    { part: "note", text }      { part: "more", text }    "⋯ 18 more edits"
 *  box: [clientHeight, scrollHeight, clientWidth, scrollWidth] of the part's own box. */
function cardsInPage(rootId) {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return null;
  const q = (e, id) => e?.querySelector(`[data-testid="${id}"]`), qa = (e, id) => [...(e?.querySelectorAll(`[data-testid="${id}"]`) ?? [])];
  const text = (e) => e?.textContent ?? "", box = (e) => (e ? [e.clientHeight, e.scrollHeight, e.clientWidth, e.scrollWidth] : null);
  const ids = (e) => e.getAttribute("data-testid");
  // The phone's step (a card of two lines, `step` inside the `tool-card` root, screens/tools/StepCard.tsx) is read into the same shape: its open
  // parts are the command box (`step-command`, "$ " before the command and the Copy beside it), an output (its title above `step-output`; the last
  // lines, `more` when Show all output is there), the diff's rows under a fade (`step-diff`, `head`: "line 41"), and the notes. A file step has a
  // synthetic first "path" part: the line beside the title (the path, as the phone draws it) and the "+1 −1" of `step-counts`.
  const phoneParts = (t, detail) => {
    const kind = t.dataset.kind, parts = [];
    if (kind === "edit" || kind === "write" || kind === "delete") parts.push({ part: "path", path: text(q(t, "tool-hint")), title: "", counts: text(q(t, "step-counts")), lines: "" });
    for (const p of detail?.children ?? []) {
      if (ids(p) === "tool-note") { parts.push({ part: "note", text: text(p) }); continue; }
      if (ids(p) === "step-command") { parts.push({ part: "text", title: "Command", failed: false, lead: "", text: [text(q(p, "tool-pre") ?? p.firstElementChild).replace(/^\$ /, "")], left: "", coloured: 0, box: box(p), copy: !!q(p, "step-command-copy") }); continue; }
      const out = q(p, "step-output"), outAll = q(p, "step-output-all"), outCopy = q(p, "step-output-copy");
      if (out || outCopy) {
        const head = p.firstElementChild, title = text(head?.firstElementChild);
        parts.push({ part: "text", title, failed: t.querySelector('[data-testid="step"]')?.dataset.failed === "true", lead: "", text: out ? qa(out, "tool-pre").map(text) : [], left: head?.children[1] ? text(head.children[1]) : "", more: !!outAll, all: outAll ? text(outAll) : "", coloured: 0, box: box(out), copy: !!outCopy });
        continue;
      }
      if (q(p, "step-diff") || q(p, "step-diff-full")) {
        for (const d of qa(p, "step-diff")) {
          const head = d.firstElementChild?.dataset.testid ? null : d.firstElementChild;
          parts.push({ part: "change", title: "", head: /^line \d+$/.test(text(head)) ? text(head) : "", left: "", box: box(d),
            rows: qa(d, "diff-row").map((r) => (r.dataset.kind === "skip" ? "@" + text(r) : ({ add: "+", del: "-" }[r.dataset.kind] ?? " ") + text(q(r, "diff-text")))) });
        }
        parts.push({ part: "diffbar", full: text(q(p, "step-diff-full")), copy: !!q(p, "step-diff-copy") });
      }
    }
    return parts;
  };
  return qa(root, "tool-card").sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((t) => {
    const phone = !!q(t, "step");
    const detail = phone ? q(t, "tool-detail") : [...t.children].find((c) => ids(c) === "tool-detail");
    const d = t.dataset;
    return { cls: [...(d.running ? ["running"] : []), ...(d.err ? ["err"] : []), `k-${d.kind}`], state: d.state, label: text(q(t, "tool-label")), hint: text(q(t, "tool-hint")), open: !!detail,
      phone, exit: text(q(t, "step-exit")), failed: phone ? q(t, "step")?.dataset.failed === "true" : undefined,
      parts: phone ? phoneParts(t, detail) : [...(detail?.children ?? [])].map((p) => {
        const id = ids(p);
        if (id === "tool-path") return { part: "path", path: text(q(p, "tool-path-name")), title: p.dataset.full, counts: text(q(p, "tool-counts")), lines: text(q(p, "tool-lines")) };
        if (id === "tool-note") return { part: "note", text: text(p) };
        if (id === "tool-more") return { part: "more", text: text(q(p, "tool-more-text")) };
        const title = text(q(p, "tool-sub")), diff = q(p, "tool-diff"), body = q(p, "tool-text");
        if (diff) return { part: "change", title, left: text(q(diff, "tool-omit-text")), box: box(diff),
          rows: qa(diff, "diff-row").map((r) => (r.dataset.kind === "skip" ? "@" + text(r) : ({ add: "+", del: "-" }[r.dataset.kind] ?? " ") + text(q(r, "diff-text")))) };
        return { part: "text", title, failed: p.dataset.failed === "true", lead: text(q(p, "tool-lead")), text: qa(body, "tool-pre").map(text),
          left: text(q(body, "tool-omit-text")), coloured: qa(body, "tool-pre").reduce((n, e) => n + (+e.dataset.tokens || 0), 0), box: box(body) };
      }) };
  });
}

/** The tool cards of a thread (see cardsInPage): root is the testID of the thread, "thread" by default; null with no such element. */
export const toolCards = (page, root = "thread") => page.evaluate(cardsInPage, root);

/** Opens every folded run of reads under root (the phone's `step-group`: its steps are drawn only after a tap on its head), the first one first. */
export async function openGroups(page, root = "thread") {
  const group = byTid(page, root).locator('[data-testid="step-group"][data-open="false"]');
  for (let tries = 0; tries < 100; tries++) {
    const n = await group.count();
    if (!n) break;
    await group.first().locator('[role="button"]').first().click();
    await until(async () => (await group.count()) < n, 3000);
  }
}

/** Opens every closed tool card under root (a press on its row), the first one first; on the phone the folded runs of reads first. A step that
 *  failed is open by itself and is left as it is. */
export async function openCards(page, root = "thread") {
  await openGroups(page, root);
  const card = byTid(page, root).locator('[data-testid="tool-card"][data-open="false"]');
  for (let tries = 0; tries < 200; tries++) {
    const n = await card.count();
    if (!n) break;
    await card.first().locator('[data-testid="tool-row"]').first().click();
    await until(async () => (await card.count()) < n, 3000);
  }
  await frame(page);
}

/** On the phone a subagent's screen folds the steps of an ended subagent into one row (`sub-steps`): a tap shows them. Nothing to do when they are
 *  shown (or the subagent still runs: its steps are drawn). */
export async function openSubSteps(page) {
  const fold = byTid(page, "sub-steps");
  await fold.waitFor({ state: "visible", timeout: 15000 });
  if (await fold.getAttribute("data-open") !== "true") await fold.click();
  await frame(page);
}

/** On the phone an output shows its last lines: presses every Show all output / Show all under root, so the whole texts are drawn. */
export async function showAllOutput(page, root = "thread") {
  const all = byTid(page, root).locator('[data-testid="step-output-all"]');
  for (let tries = 0; tries < 100; tries++) {
    const closed = all.filter({ hasNotText: "Show less" });
    const n = await closed.count();
    if (!n) break;
    await closed.first().click();
    await until(async () => (await closed.count()) < n, 3000);
  }
  await frame(page);
}

/** Two frames: what a press changed is drawn. */
export const frame = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));

/** In the page: what of the tool cards under `root` (a thread) passes its pane. cards: how many; width: the thread's own; wide: the cards that
 *  begin or end outside the thread's content box; out: the elements of a card that end past the card (each as its testID and by how many px);
 *  sideways: the boxes of a card that scroll sideways; scroll: by how much the thread and the document scroll sideways. bad: any of them. */
function cardsFitInPage(rootId) {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return null;
  const R = (e) => e.getBoundingClientRect(), r = R(root), r1 = (n) => Math.round(n * 10) / 10;
  // (the thread's rows lie inside the list's padding: the content box is the thread's, less the padding of the list's content)
  const scroller = root.querySelector('[data-testid="thread-scroll"]') ?? root, inner = scroller.firstElementChild ?? scroller, cs = getComputedStyle(inner);
  const left = r.left + (parseFloat(cs.paddingLeft) || 0), right = r.right - (parseFloat(cs.paddingRight) || 0);
  const name = (e) => e.getAttribute("data-testid") ?? e.tagName.toLowerCase();
  const cards = [...root.querySelectorAll('[data-testid="tool-card"]')], wide = [], out = [], sideways = [];
  for (const [i, t] of cards.entries()) {
    const q = R(t);
    if (q.left < left - 0.5 || q.right > right + 0.5) wide.push(`card ${i + 1}: ${r1(q.left - left)} to +${r1(q.right - right)}`);
    // (a phone step's one line beside the title is cut with an ellipsis by design, `step-line`: what it clips is not past the card)
    for (const e of t.querySelectorAll("*")) { if (e.closest('[data-testid="step-line"]')) continue; const over = R(e).right - q.right; if (over > 0.5) out.push(`card ${i + 1} ${name(e)} +${r1(over)}`); }
    for (const e of t.querySelectorAll('[data-testid="tool-text"], [data-testid="tool-diff"], [data-testid="tool-detail"], [data-testid="tool-row"]')) if (e.scrollWidth > e.clientWidth) sideways.push(`card ${i + 1} ${name(e)} +${e.scrollWidth - e.clientWidth}`);
  }
  const scroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth) + Math.max(0, document.documentElement.scrollWidth - innerWidth);
  return { cards: cards.length, width: r1(r.width), wide, out, sideways, scroll, bad: wide.length + out.length + sideways.length + scroll > 0 };
}

/** Whether the tool cards of a thread lie inside it (see cardsFitInPage). */
export const cardsFit = (page, root = "thread") => page.evaluate(cardsFitInPage, root);

/** The permission cards of a thread, top to bottom: { state, closed, sub, title, reason, what, done, buttons, error, who, folded, foldedText }. */
export function permCards(page, root = "thread") {
  return page.evaluate((rootId) => {
    const r = document.querySelector(`[data-testid="${rootId}"]`);
    if (!r) return null;
    const q = (e, id) => e.querySelector(`[data-testid="${id}"]`), text = (e) => e?.textContent ?? "";
    return [...r.querySelectorAll('[data-testid="perm"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).map((p) => ({
      state: p.dataset.state, closed: p.dataset.closed === "true", sub: text(q(p, "perm-sub")), title: text(q(p, "perm-title")), reason: text(q(p, "perm-reason")),
      // (the phone's card: `who` is "Claude wants to run a command", `folded` the one line an answered card is, with the words it says)
      who: text(q(p, "perm-who")), folded: !!q(p, "perm-folded"), foldedText: text(q(p, "perm-folded")),
      what: text(q(p, "perm-what")), done: text(q(p, "perm-done")), buttons: [...p.querySelectorAll('[data-testid="perm-actions"] button, [data-testid="perm-actions"] [role="button"]')].map(text), error: text(q(p, "perm-error")),
    }));
  }, root);
}

/** The locator of the row of the n-th tool card under root, counted top to bottom as they are on screen (the page's own order is the virtual
 *  list's): the row is marked for the moment with `data-check-row`. */
export async function rowOfCard(page, n, root = "thread") {
  await page.evaluate(([rootId, n]) => {
    for (const e of document.querySelectorAll("[data-check-row]")) e.removeAttribute("data-check-row");
    const cards = [...document.querySelector(`[data-testid="${rootId}"]`).querySelectorAll('[data-testid="tool-card"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    cards[n]?.querySelector('[data-testid="tool-row"]')?.setAttribute("data-check-row", "");
  }, [root, n]);
  return page.locator("[data-check-row]");
}

/** The locator of the n-th tool card under root, counted as `rowOfCard` does; the card is marked for the moment with `data-check-card`. */
export async function cardAt(page, n, root = "thread") {
  await page.evaluate(([rootId, n]) => {
    for (const e of document.querySelectorAll("[data-check-card]")) e.removeAttribute("data-check-card");
    const cards = [...document.querySelector(`[data-testid="${rootId}"]`).querySelectorAll('[data-testid="tool-card"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    cards[n]?.setAttribute("data-check-card", "");
  }, [root, n]);
  return page.locator("[data-check-card]");
}

/** The locator of the n-th permission card under root, counted top to bottom as they are on screen; marked for the moment with `data-check-perm`. */
export async function permAt(page, n, root = "thread") {
  await page.evaluate(([rootId, n]) => {
    for (const e of document.querySelectorAll("[data-check-perm]")) e.removeAttribute("data-check-perm");
    const cards = [...document.querySelector(`[data-testid="${rootId}"]`).querySelectorAll('[data-testid="perm"]')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    cards[n]?.setAttribute("data-check-perm", "");
  }, [root, n]);
  return page.locator("[data-check-perm]");
}

// ---- the phone's step: what it shows of the wide card's parts (the checks that read steps share these)
/** The parts of a wide card (in short) as the phone's step shows them: an output is not titled "· failed" (it is red, and the step says it
 *  failed), a change is untitled and comes after the notes, followed by its buttons; a write's content is a change of added rows; a file's
 *  "9 lines" is "+9". */
export const phoneBrief = (parts) => {
  const rest = [], changes = [];
  for (const p of parts) {
    if (p.startsWith("change") || p === "text Content") changes.push("change");
    else rest.push(p.replace(/ (\d+) lines?$/, " +$1").replace(/^(text Output) · failed$/, "$1"));
  }
  // (a step draws its path, then its notes and texts, then its changes under them with their buttons)
  return changes.length ? [...rest, ...changes, "bar"] : rest;
};
/** A change's rows (" same", "-removed", "+added", "@⋯ 60 unchanged lines") as the step draws them: a tab is two columns, the rows begin one
 *  line before the first changed one (not on the first two rows, and not on a skipped stretch). */
export const phoneRows = (rows) => {
  const first = rows.findIndex((r) => r[0] === "+" || r[0] === "-");
  const from = first <= 1 ? 0 : rows[first - 1][0] === "@" ? first : first - 1;
  return rows.slice(from).map((r) => r.replace(/\t/g, "  "));
};
/** The lines of a text as the rows of an added file. */
export const addedRows = (text) => text.split("\n").map((l) => "+" + l.replace(/\t/g, "  "));
/** An output as the step draws it: a tab is four columns. */
export const phoneText = (text) => text.replace(/\t/g, "    ");
