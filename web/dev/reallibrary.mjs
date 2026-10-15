// The prompt library's popups of the app (app/, its web export) on real server processes, in a headless Chromium (S11): what the browser checks PL4.1 and
// PL5.2 prove on the mock, tried once more where the mock is only this repository's reading of the server
// (plans/prompt-library.md, section 10, lines 7 to 10 and 19 to 23 and 25, as far as the page goes). It is no check
// of dev/checks and `npm run uicheck` does not run it: it needs Go, to build the server.
//   node web/dev/reallibrary.mjs        builds the server and the app's web export (with `connect-src 'self'`, as the test host needs), runs, and removes what it made
// Two servers are started, each with a data folder of its own under the system's temporary folder and a free port: A,
// "this computer", which the test host (dev/host.mjs, which does for the page what the app's main process does) finds or
// starts with the server program, and B, another server, an entry of the host's list. Neither has an agent program (the
// flags name programs that do not exist), so nothing here can call a paid model; a chat's composer is there all the
// same, and nothing is sent from it. What another window or another machine's owner does is done by another host of
// its own (another app, another client of the server), with calls of the client API.
//   A alone: the popup opens on an empty library with no level of servers; a group, a prompt in it; a second prompt
//   of that name in another case is refused with the server's sentence and what was typed stays; a change made by
//   another client shows in the first window; deleting the group asks with the number of its prompts. Where an item
//   is, is the tree's: a right click on the space under the rows makes a group at the top level, one on a group a
//   prompt in it; a drop on a group moves a prompt and a group there, and the bar of the top level takes a group back;
//   a drop the server refuses for a name that is taken there, and for groups more than 16 deep, says the server's
//   sentence under the tree and moves nothing.
//   B joins the list: its library is in the open popup under its name, and a search for the server's name and a
//   prompt's name finds the prompt; a prompt made at its entry is in B's own library and not in A's; B refuses a
//   name that is taken, with its sentence; a change B's owner makes shows in the editor here. ⌘P in a chat's
//   composer lists both libraries and Enter puts B's prompt at the cursor.
//   B stops: its prompts stay in both popups, marked, can be inserted and cannot be changed; B is back: they can.
//   B is removed from the list: its prompts are gone, and the tree has no level of servers again.
// The popups are read by `checks/library.mjs`; the pointer's drag is `pointerDragger` of `checks/sel.mjs`.
import fs from "node:fs";
import path from "node:path";
import { until, loadPlaywright, onEnd } from "./shot.mjs";
import { Scratch, hostApp, hostCall, hostFor, makeOut, pageDist, serverBinary } from "../e2e/lib/rig.mjs";
import { byTid, pointerDragger, tidSel } from "./checks/sel.mjs";
import { seen as libSeen, insertSeen } from "./checks/library.mjs";

const ROOT = makeOut("reallibrary");
const failures = [], fail = (line) => { failures.push(line); console.log(`FAIL ${line}`); }, pass = (line) => console.log(`ok   ${line}`), note = (line) => console.log(`     ${line}`);

let A, B, host, hostB, hostOther, browser;
const tidy = async () => {
  await browser?.close().catch(() => {});
  for (const h of [host, hostB, hostOther]) await h?.close().catch(() => {});
  for (const s of [A, B]) await s?.stop().catch(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
};
onEnd(tidy);

/** A client of a server of its own: another app (a host with its own list and client id), which connects while it is subscribed.
 *  call(method, path, body, server): a call of the client API to `server` (default: its own server, "local"). */
async function client(h, server = "local") {
  const sub = h.client.subscribe(() => {});
  await until(async () => (await hostCall(h, server, "GET", "/api/state")).status === 200, 60000);
  return { call: async (method, at, body, to = server) => { const r = await hostCall(h, to, method, at, body); return { status: r.status, body: r.json }; }, close: () => sub.close() };
}
/** A server's own library, as it answers a read. */
const libraryOf = async (h, server = "local") => (await hostCall(h, server, "GET", "/api/library")).json.libraries[0];

/** In the page: what the two popups show (the readers of checks/library.mjs, put together; the page evaluates this text). */
const READ = `(() => {
  const l = (${libSeen})(), i = (${insertSeen})();
  return { open: !!l.open, rows: l.rows, off: l.off, says: l.says, treeErr: l.treeErr, ask: l.ask,
    form: l.form && { head: l.form.head, name: l.form.name, text: l.form.text, fixed: l.form.fixed, err: l.form.err, notice: l.form.notice, off: l.form.off, where: l.form.where },
    insert: i.open ? { rows: i.rows, off: i.off } : null };
})()`;

try {
  const bin = serverBinary(ROOT);
  const dist = pageDist(ROOT);
  A = new Scratch({ out: ROOT, bin, agent: null, tag: "a", name: "This computer" });
  B = new Scratch({ out: ROOT, bin, agent: null, tag: "b", name: "Studio" });
  await A.setUp();
  await B.setUp();
  await B.launch();
  // (B's own app, which is B's owner here, and another app of A's owner: other clients of the servers, not pages)
  hostB = await hostFor({ out: ROOT, name: "b-owner", local: B, extra: { dist } });
  hostOther = await hostFor({ out: ROOT, name: "other", extra: { dist } });
  host = await hostFor({ out: ROOT, name: "page", local: A, extra: { dist } });
  const ofB = await client(hostB);
  browser = await (await loadPlaywright()).chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(host.url);
  await page.waitForSelector(tidSel("library-btn"), { timeout: 30000 });
  await page.waitForSelector(tidSel("side-section-state", { server: "local", tone: "ok" }), { timeout: 90000 }); // (this computer's server is found or started and connected)
  const read = () => page.evaluate(READ);
  /** Waits for the page to show what `want` says, and says so; fails with what it shows. */
  const shows = async (what, want) => {
    let s;
    if (await until(async () => want((s = await read())), 30000)) pass(what); else fail(`${what}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const esc = (l) => new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const D = byTid(page, "library-dialog"), libBtn = byTid(page, "library-btn");
  const row = (label) => D.locator(`${tidSel("lib-row")}:not([data-new="true"])`).filter({ has: page.locator(tidSel("lib-name"), { hasText: esc(label) }) });
  const button = (label) => D.locator('[role="button"]').filter({ hasText: esc(label) });
  const name = byTid(D, "lib-name-input"), text = byTid(D, "lib-text-input"), LONG = "a".repeat(80), search = byTid(D, "lib-search");
  const answer = (label) => byTid(page, "confirm-dialog").locator('[role="button"]').filter({ hasText: esc(label) }).click();

  // ---- this computer's library alone
  await libBtn.click();
  await shows("a new server: the popup opens on an empty library", (s) => s.open && !s.rows.length && s.says === "The library has no prompts yet.");
  await button("New group").click(); await name.fill("git"); await button("Save").click();
  await shows("a group is made", (s) => s.rows.join("|") === "git" && s.form?.head === "Group");
  await button("New prompt").click(); await name.fill("review"); await text.fill("Review this change.\n\n- say why"); await button("Save").click();
  await shows("a prompt is made in the chosen group; the tree has no level of servers", (s) => s.rows.join("|") === "git|  review" && s.form?.head === "Prompt" && s.form.where === "In git");
  await button("New prompt").click(); await name.fill("REVIEW"); await text.fill("typed"); await button("Save").click();
  let s = await shows("a second prompt of that name in another case is refused, and what was typed stays", (x) => !!x.form?.err && x.form.name === "REVIEW" && x.form.text === "typed");
  note(`the server's sentence: ${s.form?.err}`);
  await name.fill(LONG); await button("Save").click();
  await shows("a name of 80 characters is saved", (x) => x.rows.length === 3 && x.form?.head === "Prompt" && !x.form.err);
  const mine = await libraryOf(host);
  if (mine.groups.length === 1 && mine.prompts.length === 2 && mine.prompts.some((p) => p.text === "Review this change.\n\n- say why")) pass("the server holds what the popup made, the text with its line breaks"); else fail(`A's library is ${JSON.stringify(mine)}`);
  // another client of A (another app: its host has A as an entry of its list) renames the prompt, as a second window would
  const addedA = await hostApp(hostOther, "servers.add", { force: true, form: { name: "A", address: `https://127.0.0.1:${A.port}`, secret: A.secret, selfSigned: true, pin: A.fingerprint } });
  const entryA = addedA.json?.server?.id;
  if (!entryA) throw new Error(`A was not added to the other app's list: ${JSON.stringify(addedA)}`);
  const ofA = await client(hostOther, entryA);
  const renamed = await ofA.call("PATCH", `/api/library/local/prompts/${mine.prompts.find((x) => x.name === "review")?.id}`, { name: "review twice" });
  if (renamed.status !== 200) fail(`the other client's rename was answered ${JSON.stringify(renamed)}`);
  await shows("a change made by another client shows in the window with no reload", (x) => x.rows.includes("  review twice") && !x.rows.includes("  review"));
  await row("git").click(); await button("Delete").click();
  const asked = await until(async () => (await read()).ask?.body, 10000);
  if (asked === "“git” is deleted with everything in it: 2 prompts.") pass("deleting the group asks with the number of its prompts"); else fail(`the question before the group is deleted: ${JSON.stringify(asked)}`);
  await answer("Cancel");

  // ---- where an item is, is the tree's: the menu of a right click, and a drag
  const d = await pointerDragger(page, { steps: 6 });
  const centre = async (t) => { if ("x" in t) return t; await t.scrollIntoViewIfNeeded(); const b = await t.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const entryOf = (label) => byTid(page, "lib-menu").locator(tidSel("lib-menu-item")).filter({ hasText: esc(label) }), bar = byTid(D, "lib-top");
  const dragTo = async (label, to) => { const p = await centre(row(label)); await d.start(p); await d.move({ x: p.x + 9, y: p.y + 5 }); await d.move(await centre(to)); await d.end(); };
  const parentOf = async (label) => { const l = await libraryOf(host), x = [...l.prompts, ...l.groups].find((i) => i.name === label); return l.groups.find((q) => q.id === x?.parent)?.name ?? (x ? "" : null); };
  const list = await byTid(D, "lib-list-frame").boundingBox();
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 10, { button: "right" });
  await entryOf("New group").click(); await name.fill("misc"); await button("Save").click();
  await shows("a right click on the space under the rows makes a group at the top level", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc"].join("|") && x.form?.head === "Group" && x.form.where === "At the top level");
  await row("misc").click({ button: "right" });
  await entryOf("New prompt").click(); await name.fill("Review Twice"); await button("Save").click();
  await shows("a right click on a group makes a prompt in it", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|") && x.form?.where === "In misc");
  await dragTo("review twice", row("misc"));
  s = await shows("a drop the server refuses for the name says so under the tree, and nothing moves", (x) => !!x.treeErr && x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|"));
  note(`the server's sentence: ${s.treeErr}`);
  if (await parentOf("review twice") !== "git") fail(`after the refused drop the prompt is in ${JSON.stringify(await parentOf("review twice"))}`);
  await dragTo(LONG, row("Review Twice")); // (on a prompt: beside it)
  await shows("a drop on a prompt of another group moves the dragged prompt beside it", (x) => x.rows.join("|") === ["git", "  review twice", "misc", "  " + LONG, "  Review Twice"].join("|") && !x.treeErr);
  await dragTo("git", row("misc"));
  await shows("a drop on a group moves a group there, with what is in it", (x) => x.rows.join("|") === ["misc", "  git", "    review twice", "  " + LONG, "  Review Twice"].join("|"));
  if (await parentOf(LONG) === "misc" && await parentOf("git") === "misc") pass("the server holds both where they were dropped"); else fail(`after the drops the server has them in ${JSON.stringify([await parentOf(LONG), await parentOf("git")])}`);
  await dragTo("git", bar);
  await dragTo(LONG, row("git"));
  await shows("the bar of the top level takes the group back, and the prompt goes back into it", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|") && !x.treeErr);
  // groups more than 16 deep: the server's own rule, for a group made there and for one moved there
  const maker = ofA;
  for (let i = 1, parent = ""; i <= 16; i++) parent = (await maker.call("POST", "/api/library/local/groups", { name: "d" + i, parent })).body?.group?.id ?? "";
  await shows("16 groups inside one another are in the tree", (x) => x.rows.includes("  ".repeat(15) + "d16"));
  await row("d16").click({ button: "right" });
  await entryOf("New group").click(); await name.fill("d17"); await button("Save").click();
  s = await shows("a 17th group in them is refused, and what was typed stays", (x) => !!x.form?.err && x.form.name === "d17");
  note(`the server's sentence: ${s.form?.err}`);
  await button("Cancel").click();
  await dragTo("misc", row("d16"));
  s = await shows("a group dropped into them is refused under the tree, and has not moved", (x) => !!x.treeErr && x.rows.at(-2) === "misc");
  note(`the server's sentence: ${s.treeErr}`);
  await dragTo("Review Twice", row("d16"));
  await shows("a prompt dropped into the 16th group is taken", (x) => x.rows.includes("  ".repeat(16) + "Review Twice") && !x.treeErr);
  const made = await libraryOf(host);
  for (const id of [made.groups.find((x) => x.name === "d1")?.id, made.groups.find((x) => x.name === "misc")?.id]) await maker.call("DELETE", `/api/library/local/groups/${id}`);
  await shows("the library as it was before the moves", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice"].join("|"));

  // ---- another server joins the list
  const address = `https://127.0.0.1:${B.port}`;
  await ofB.call("POST", "/api/library/local/prompts", { name: "standup", parent: "", text: "What did you do?" });
  const tested = await hostApp(host, "servers.test", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: "" } });
  const added = await hostApp(host, "servers.add", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: tested.json?.fingerprint } });
  if (!added.json?.saved) throw new Error(`B was not added to the page's list: ${JSON.stringify(added.json)} (its test: ${JSON.stringify(tested.json)})`);
  const entry = added.json.server.id;
  await shows("the other server's library is in the open popup under its name, after this computer's", (x) => x.rows.join("|") === ["This computer", "  git", "    " + LONG, "    review twice", "Studio", "  standup"].join("|") && !x.off.length);
  await search.fill("studio stand");
  await shows("a search for the server's name and a prompt's name finds the prompt", (x) => x.rows.join("|") === "Studio/standup");
  await search.fill("");
  await row("Studio").click(); await button("New prompt").click();
  await shows("a new prompt at the server's entry is to go to that server", (x) => x.form?.head === "New prompt" && x.form.where === "In Studio");
  await name.fill("retro"); await text.fill("What went well?"); await button("Save").click();
  await shows("it is in the tree under the server", (x) => x.rows.includes("  retro") && x.form?.head === "Prompt" && x.form.name === "retro");
  const theirs = await libraryOf(host, entry), retro = theirs.prompts.find((p) => p.name === "retro");
  if (retro?.text === "What went well?" && !(await libraryOf(host)).prompts.some((p) => p.name === "retro")) pass("the prompt is in the other server's own library, and not in this computer's"); else fail(`B's own library is ${JSON.stringify(theirs)}`);
  await button("New prompt").click(); await name.fill("Retro"); await button("Save").click();
  s = await shows("the other server refuses a name that is taken, and the popup shows its sentence", (x) => !!x.form?.err && x.form.name === "Retro");
  note(`its sentence: ${s.form?.err}`);
  await button("Cancel").click();
  await row("retro").click();
  await shows("the prompt is chosen", (x) => x.form?.name === "retro" && x.form.text === "What went well?");
  const patched = await ofB.call("PATCH", `/api/library/local/prompts/${retro?.id}`, { text: "Changed by the owner." });
  if (patched.status !== 200) fail(`the owner's change was answered ${JSON.stringify(patched)}`);
  await shows("a change the server's owner makes shows in the editor here, with no reload", (x) => x.form?.text === "Changed by the owner.");

  // ---- the insert popup, in a chat's composer
  await page.keyboard.press("Escape");
  await byTid(page, "side-new").first().click();
  await byTid(page, "menu-item").filter({ hasText: /^\s*New chat\s*$/ }).first().click();
  const box = byTid(page, "composer-input").first(), held = async () => (await box.evaluate((e) => e.innerText)).replace(/\n+$/, "");
  await box.click({ timeout: 15000 });
  await page.keyboard.type("Hello world");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+p");
  await shows("⌘P in a chat's composer lists both libraries", (x) => x.insert?.rows.join("|") === [`This computer/git/${LONG}`, "This computer/git/review twice", "Studio/retro", "Studio/standup"].join("|") && !x.insert.off.length);
  await page.keyboard.type("studio retro");
  await page.keyboard.press("Enter");
  if (await until(async () => await held() === "HelloChanged by the owner. world", 10000)) pass("Enter puts the other server's prompt at the cursor"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);

  // ---- the other server stops, and is back
  await libBtn.click();
  await row("retro").click();
  ofB.close();
  await hostB.close(); // (B's own app would start it again)
  hostB = null;
  await B.stop();
  s = await shows("the server stopped: its prompts are still listed, it is marked, and nothing of it can be changed", (x) => x.off.join() === "Studio" && x.rows.includes("  retro") && x.form?.fixed === true && ["Save", "Delete"].every((l) => x.form.off.includes(l)));
  note(`the editor says: ${s.form?.notice}`);
  const refused = await hostCall(host, entry, "DELETE", `/api/library/local/prompts/${retro?.id}`);
  if (refused.status === 503 && refused.json?.code === "server_unreachable") pass(`a call past the popup is refused: ${refused.json.error}`); else fail(`a change while the server is away was answered ${JSON.stringify(refused.json)}`);
  await page.keyboard.press("Escape");
  await box.click();
  await page.keyboard.press("ControlOrMeta+p");
  await shows("the insert popup still lists them, marked", (x) => x.insert?.off.join("|") === "Studio/retro|Studio/standup");
  await page.keyboard.type("standup");
  await page.keyboard.press("Enter");
  if (await until(async () => (await held()).includes("What did you do?"), 10000)) pass("a prompt of the server that stopped is inserted"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);
  await libBtn.click();
  await row("retro").click();
  await B.launch();
  await shows("the server is back: its prompt can be changed again", (x) => !x.off.length && x.form?.name === "retro" && x.form.fixed === false);
  await text.fill("Saved after it came back."); await button("Save").click();
  if (await until(async () => (await libraryOf(host, entry)).prompts.some((p) => p.text === "Saved after it came back."), 20000)) pass("a save after it came back reaches it"); else fail("the save after the server came back did not reach it");

  // ---- removed from the list
  await hostApp(host, "servers.remove", { id: entry });
  await shows("removed from the list, the server takes its prompts with it, and the tree has no level of servers", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice"].join("|") && !x.form);
  for (const e of errors) fail(`page error: ${e}`);
  ofA.close();
} catch (e) { fail(String(e?.stack ?? e)); }
await tidy();
console.log(failures.length ? `\n${failures.length} failed` : "\nthe prompt library's popups work on real servers, in the new build");
process.exit(failures.length ? 1 : 0);
