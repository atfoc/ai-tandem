// Proves that a chat which is shown as it was is read-only in every control of its view, not in its composer alone
// (plans/remote-server-sections-goal.md, 3.8: "nothing can be sent, stopped or changed"; 3.5 for a chat that was
// deleted on its server). SEC.7 proves the composer, the warning and what happens when the server is back; this
// goes on from it with what stands around the composer.
// With the server connected, the chat offers them all: the actions of a message, the answer to a permission request,
// the tree's rows. Its server dropped: no message has an action, the request has no buttons and says why, the tree
// opens to be read and no row of it opens, has a menu or a Stop, a pending move's Back is off, Esc stops nothing, the
// insert popup does not open, a quote is not taken, and the quote the draft has is listed with no way to remove it or
// to comment on it; and through all of it the page makes no call that changes anything. Back: they are all there again, and Back works. Deleted on its server while it is open: the same as
// under the outage, with the sentence that it is no longer there.
import { callsOf, check, mockEval, openPage, seed, startMove, until } from "../shot.mjs";

const J = JSON.stringify;
const STUDIO = "s_studio", KEY = `${STUDIO}~c_plain`;
const WHY = "Studio Mac is not connected: nothing can be sent or changed until it is back.";
const GONE = "This chat is no longer on Studio Mac.";

await check("SEC.10 every control of a chat that is shown as it was is off, and none makes a call", async ({ url, browser, fail, note }) => {
  const drop = () => mockEval(`setServerState("${STUDIO}", "unreachable", { detail: "connection refused" });`, url);
  const back = () => mockEval(`setServerState("${STUDIO}", "connected");`, url);
  await seed(url, "SEC");
  // the chat has two turns that ended at a point, and its agent waits for a permission
  await mockEval(`onServer("${STUDIO}", () => {
    items.c_plain.splice(0, Infinity, { kind: "user", text: "Why is the render queue stuck?" }, say("Two jobs hold the GPU lock."), { kind: "end", point: "p_1" },
      { kind: "user", text: "Free it." }, { kind: "perm", requestId: "q_1", toolName: "Bash", input: { command: "kill -9 4242" } });
    Object.assign(chats.c_plain, { status: "approval", working: 1 });
  });`, url);
  const { page, ctx, errors } = await openPage({ url, browser, sel: { chat: KEY }, size: [1280, 900] });
  const calls = callsOf(page);
  const writes = (from) => calls.slice(from).filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  const count = (sel) => page.locator(sel).count();
  const text = (sel) => page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => "");
  const reply = page.locator(".thread .msg.assistant").first();
  await page.waitForSelector(".thread .perm");

  /** What the chat offers while it takes calls. */
  const live = async (when) => {
    await reply.hover();
    if (!await until(async () => await count(".thread .msg.assistant .fk-act.k-branch") > 0, 5000)) fail(`${when}: a reply offers no Branch`);
    if (!await count(".thread .msg .fk-act.k-label")) fail(`${when}: a message offers no Label`);
    if (await count(".thread .perm .perm-actions button") !== 2) fail(`${when}: the permission request has no Allow and Don't`);
  };
  /** What it offers while it takes none, saying `why`; the tree is opened, read and closed. */
  const off = async (when, why) => {
    await reply.hover();
    await page.waitForTimeout(150);
    if (await count(".thread .fk-act")) fail(`${when}: a message still offers ${J(await page.locator(".thread .fk-act").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))))}`);
    if (await count(".thread .perm .perm-actions")) fail(`${when}: the permission request can still be answered`);
    if (await text(".thread .perm .perm-done") !== why) fail(`${when}: the permission request says "${await text(".thread .perm .perm-done")}", not why it cannot be answered`);
    // the tree: it opens, and is to be read only
    await page.locator(".chat-head .fk-tree-btn").click();
    await page.waitForSelector(".fk-nav .fk-row", { timeout: 5000 });
    const rows = await count(".fk-nav .fk-row"), held = await count(".fk-nav .fk-row.held");
    if (!rows || rows !== held) fail(`${when}: ${held} of the tree's ${rows} rows are held`);
    if (await count(".fk-nav .fk-stop")) fail(`${when}: a branch of the tree has a Stop`);
    if (await text(".fk-nav-foot .fk-held") !== why) fail(`${when}: the tree's foot says "${await text(".fk-nav-foot")}"`);
    await page.locator(".fk-nav .fk-row").first().dblclick();
    await page.locator(".fk-nav .fk-row").first().click({ button: "right" });
    await page.waitForTimeout(150);
    if (!await count(".fk-nav")) fail(`${when}: a double click on a row of the tree closed it and opened the chat there`);
    if (await count(".fk-ctx")) fail(`${when}: a row of the tree has a menu`);
    await page.keyboard.press("Escape");
    if (!await until(async () => !await count(".fk-nav"), 5000)) fail(`${when}: the tree does not close`);
    if (await count(".fk-banner") && !await page.locator(".fk-banner button").isDisabled()) fail(`${when}: a pending move's Back is on`);
  };

  /** Selects the first reply's text, as the mouse would. */
  const selectReply = () => page.evaluate(() => {
    const md = document.querySelector(".thread .msg.assistant .md") ?? document.querySelector(".thread .msg.assistant");
    const r = document.createRange(); r.selectNodeContents(md); getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  /** The list of the draft's quotes: opened, read (how many can be removed, and whether a click on one opens its comment), closed. */
  const quotes = async () => {
    await page.locator(".composer .qcount").click();
    await page.waitForSelector(".qlist .qlist-item", { timeout: 5000 });
    const removable = await count(".qlist .qlist-x"), hint = await text(".qlist-head .hint");
    await page.locator(".qlist .qlist-item").first().click();
    await page.waitForTimeout(150);
    const float = await count(".qfloat");
    await page.keyboard.press("Escape");
    await until(async () => !await count(".qfloat") && !await count(".qlist"), 3000);
    return { removable, hint, float };
  };

  // ---- connected: everything is offered
  await live("connected");
  if (!await count(".composer .send.stop")) fail("connected, an agent that waits for a permission has no Stop");
  // a quote is taken into the draft, and saved with it
  await selectReply();
  await page.keyboard.press("ControlOrMeta+l");
  await page.waitForSelector(".qfloat", { timeout: 5000 });
  await page.keyboard.press("Enter");
  if (!await until(() => calls.some((c) => c.method === "PUT" && /\/chats\/c_plain\/draft\?/.test(c.path) && c.status === 200 && c.body?.references?.length === 1), 10000)) fail("connected, the quote was not saved with the draft");
  if (J(await quotes()) !== J({ removable: 1, hint: "click one to edit it", float: 1 })) fail(`connected, the draft's quote can be removed and commented on: ${J(await quotes())}`);

  // ---- its server drops
  await drop();
  if (!await until(async () => await count(".remote-bar.off") > 0, 10000)) fail("the warning does not show");
  let quiet = calls.length;
  await off("its server dropped", WHY);
  // the keys: Esc stops nothing, the insert popup does not open, a quote is not taken
  await page.locator(".composer .composer-input").click({ force: true });
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+p");
  await page.waitForTimeout(150);
  if (await count(".ins-list")) fail("its server dropped: the insert popup opened for a box that takes nothing");
  if (await count(".composer .insert-btn") && !await page.locator(".composer .insert-btn").isDisabled()) fail("its server dropped: the composer's Insert button is on");
  await selectReply();
  await page.keyboard.press("ControlOrMeta+l");
  if (!await until(async () => (await text(".composer .ctx-note")).includes("Studio Mac is not connected"), 5000)) fail(`its server dropped: a quote taken with the key says "${await text(".composer .ctx-note")}"`);
  if (await count(".qfloat")) fail("its server dropped: a quote was taken into a draft that cannot be saved");
  await page.evaluate(() => getSelection().removeAllRanges());
  // the quote the draft has stays, to be read: no remove, no comment
  const kept = await quotes();
  if (J(kept) !== J({ removable: 0, hint: "click one to show it", float: 0 })) fail(`its server dropped: the draft's quote is ${J(kept)}`);
  if (await text(".composer .qcount") === "") fail("its server dropped: the draft lost its quote");
  await page.waitForTimeout(600); // (longer than a draft's save waits)
  if (writes(quiet).length) fail(`its server dropped: the page made ${J(writes(quiet))}`);

  // ---- back: everything is offered again
  await back();
  if (!await until(async () => !await count(".remote-bar"), 10000)) fail("back, the warning stays");
  await live("back");

  // ---- a pending move, then the drop: Back is off; back, it works
  await startMove(page);
  await drop();
  if (!await until(async () => await count(".remote-bar.off") > 0, 10000)) fail("the warning does not show the second time");
  quiet = calls.length;
  const banner = page.locator(".fk-banner button");
  if (!await banner.isDisabled() || await banner.getAttribute("title") !== WHY) fail(`a pending move's Back is ${await banner.isDisabled() ? "off" : "on"} and says "${await banner.getAttribute("title")}" while the chat's server is not connected`);
  await banner.click({ force: true }).catch(() => {});
  if (!await count(".fk-banner")) fail("Back undid the move of a chat that is shown as it was");
  if (writes(quiet).length) fail(`with a move pending, the page made ${J(writes(quiet))}`);
  await back();
  if (!await until(async () => !await count(".remote-bar") && !await banner.isDisabled().catch(() => true), 10000)) fail("back, a pending move's Back stays off");
  await banner.click();
  if (!await until(async () => !await count(".fk-banner"), 5000)) fail("back, Back does not undo the move");

  // ---- deleted on its server while it is open
  await mockEval(`await elsewhere("${STUDIO}", "DELETE", "/chats/c_plain")`, url);
  if (!await until(async () => await count(".remote-bar.gone") > 0, 10000)) fail("the view of a chat deleted on its server does not say so");
  quiet = calls.length;
  await off("deleted on its server", GONE);
  if (writes(quiet).length) fail(`deleted on its server: the page made ${J(writes(quiet))}`);

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note("connected, back and after Back: Branch, Label, Allow and Don't, the tree's rows, a quote that is removed or commented on; dropped and deleted: none of them, the reason in the card, the tree's foot and Back's title, no popup and no quote by a key, and no call that changes anything");
});
