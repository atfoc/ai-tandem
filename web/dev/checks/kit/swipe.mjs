// UX.F1-kit.mjs's section "swipe" (app/src/dev/kit/swipe.tsx): what it proves is listed in UX.F1-kit.mjs's header. `run(c)` gets the
// check's helpers (c.T, c.rect, c.press, c.open, c.expect, …: UX.F1-kit.mjs `body`) and calls c.fail for what is wrong.
//   Phone (a finger): a swipe from 70 % to 30 % of row a shows its two buttons, 88 px wide and as high as the row; Archive runs and the
//   row closes. Opening row b closes row a. With a row open, a tap on another row only closes (it does not write "tap b": the first tap
//   closes; the component puts a transparent press over every swipe row while one is open). A swipe from 90 % to 5 % runs Archive
//   (the full action). A swipe that starts at x = 10 does not open row c (the platform's back swipe), one at x = 60 opens Unarchive.
//   A finger held 700 ms writes "long a" (the long press that opens a row's menu).
//   Desktop (a mouse): a drag on row a opens nothing; a click still taps ("tap a").
import { mouseDrag, touchDrag } from "../sel.mjs";

export async function run(c) {
  const { page, T, rect, rects, until, expect, near } = c;
  const row = (n) => `[data-testid="swipe-row"][data-row="${n}"]`;
  const front = (n) => `${row(n)} [data-testid="swipe-front"]`;
  const buttons = (n) => `${row(n)} [data-testid="swipe-action"]`;
  const last = () => c.text("kit-swipe-last");
  const at = async (n, share) => { const r = await rect(row(n)); return { x: r.x + r.w * share, y: r.y + r.h / 2 }; };
  /** How far the front of row `n` is from the row's left edge, in px. */
  const shift = async (n) => { const [r, f] = [await rect(row(n)), await rect(front(n))]; return f.x - r.x; };
  const closed = async (n) => near(await shift(n), 0, 1) && (await rects(buttons(n))).length === 0;
  const swipe = async (n, from, to) => { await page.locator(row(n)).first().scrollIntoViewIfNeeded(); await touchDrag(page, await at(n, from), await at(n, to), { hold: 0 }); };
  const isOpen = async (n) => until(async () => (await rects(buttons(n))).length === 2 && near(await shift(n), -176, 3));

  expect((await rects('[data-testid="swipe-row"]')).length === 3, "swipe: the gallery draws three rows");
  const r0 = await rect(row("a"));
  expect(r0 && near(r0.x, 0, 1) && near(r0.h, 60, 1), `swipe: row a starts at x = 0 and is 60 high: ${JSON.stringify(r0)}`);

  if (!c.touch) {
    await page.locator(row("a")).first().scrollIntoViewIfNeeded();
    await mouseDrag(page, await at("a", 0.7), await at("a", 0.3));
    await page.waitForTimeout(400);
    expect(await closed("a"), "swipe: a mouse drag opened the row (it does nothing)");
    await page.locator(front("a")).first().click();
    expect(await until(async () => (await last()) === "tap a"), `swipe: a click on row a did not write "tap a": ${await last()}`);
    return;
  }

  // open: the buttons
  await swipe("a", 0.7, 0.3);
  expect(await isOpen("a"), `swipe: a swipe from 70 % to 30 % of row a did not open it (shift ${await shift("a")})`);
  const row_ = await rect(row("a")), bs = await rects(buttons("a"));
  expect(bs.length === 2 && bs.every((b) => near(b.w, 88, 1) && near(b.h, row_.h, 1)), `swipe: the buttons are not 88 px wide and as high as the row: ${JSON.stringify(bs)}`);
  expect(await T("swipe-action").first().evaluate((e) => e.getAttribute("data-action")) === "archive", "swipe: the first button is not Archive");

  // a button runs and closes
  await page.locator(`${buttons("a")}[data-action="archive"]`).first().tap();
  expect(await until(async () => (await last()) === "archive a"), `swipe: Archive did not write "archive a": ${await last()}`);
  expect(await until(() => closed("a")), "swipe: the row did not close after Archive");

  // Delete runs and closes too
  await swipe("a", 0.7, 0.3);
  await isOpen("a");
  await page.locator(`${buttons("a")}[data-action="delete"]`).first().tap();
  expect(await until(async () => (await last()) === "delete a"), `swipe: Delete did not write "delete a": ${await last()}`);
  expect(await until(() => closed("a")), "swipe: the row did not close after Delete");

  // one open at a time
  await swipe("a", 0.7, 0.3);
  await isOpen("a");
  await swipe("b", 0.7, 0.3);
  expect(await isOpen("b"), "swipe: row b did not open");
  expect(await until(() => closed("a")), "swipe: row a stayed open when row b opened");

  // a tap elsewhere closes, and only closes
  await page.locator(front("a")).first().tap().catch(() => {});
  await until(() => closed("b"));
  await swipe("a", 0.7, 0.3);
  await isOpen("a");
  const before = await last();
  await page.locator(front("b")).first().tap();
  expect(await until(() => closed("a")), "swipe: a tap on row b did not close the open row a");
  expect((await last()) === before && before !== "tap b", `swipe: that first tap also reached row b's content: ${await last()}`);
  await page.locator(front("b")).first().tap();
  expect(await until(async () => (await last()) === "tap b"), `swipe: with nothing open a tap on row b did not write "tap b": ${await last()}`);

  // a full swipe runs the full action
  await swipe("a", 0.9, 0.05);
  expect(await until(async () => (await last()) === "archive a"), `swipe: a full swipe on row a did not run Archive: ${await last()}`);
  expect(await until(() => closed("a")), "swipe: the row did not close after the full swipe");

  // the left edge
  await page.locator(row("c")).first().scrollIntoViewIfNeeded();
  const rc = await rect(row("c"));
  await touchDrag(page, { x: 10, y: rc.y + 30 }, { x: 250, y: rc.y + 30 }, { hold: 0 });
  await page.waitForTimeout(500);
  expect(await closed("c"), "swipe: a swipe that started at x = 10 opened row c");
  await touchDrag(page, { x: 60, y: rc.y + 30 }, { x: 250, y: rc.y + 30 }, { hold: 0 });
  expect(await until(async () => (await rects(buttons("c"))).length === 1 && near(await shift("c"), 88, 3)), `swipe: a swipe from x = 60 did not open Unarchive (shift ${await shift("c")})`);
  await page.locator(`${buttons("c")}[data-action="unarchive"]`).first().tap();
  expect(await until(async () => (await last()) === "unarchive c"), `swipe: Unarchive did not write "unarchive c": ${await last()}`);
  await until(() => closed("c"));

  // the long press
  const pa = await at("a", 0.5);
  await touchDrag(page, pa, pa, { hold: 700 });
  expect(await until(async () => (await last()) === "long a"), `swipe: a finger held 700 ms did not write "long a": ${await last()}`);
}
