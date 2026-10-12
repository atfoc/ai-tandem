// The prompt library's popups on real server processes, in a headless Chromium: what the browser checks PL4.1 and
// PL5.2 prove on the mock, tried once more where the mock is only this repository's reading of the server
// (plans/prompt-library.md, section 10, lines 7 to 10 and 19 to 23 and 25, as far as the page goes). It is no check
// of dev/checks and `npm run uicheck` does not run it: it needs Go, to build the server.
//   node dev/reallibrary.mjs            builds the server and the client, runs, and removes what it made
//   PORT=4890 node dev/reallibrary.mjs  the first of the three ports it binds on 127.0.0.1 (default 4811)
// Two servers are started, each with a data folder of its own under the system's temporary folder: A, "this
// computer", which serves the built client, and B, another server with remote access set up. Neither has an agent
// program (the flags name programs that do not exist), so nothing here can call a paid model; a chat's composer is
// there all the same, and nothing is sent from it.
//   A alone: the popup opens on an empty library with no level of servers; a group, a prompt in it; a second prompt
//   of that name in another case is refused with the server's sentence and what was typed stays; a change made in a
//   second window shows in the first; deleting the group asks with the number of its prompts.
//   B joins A's list: its library is in the open popup under its name, and a search for the server's name and a
//   prompt's name finds the prompt; a prompt made at its entry is in B's own library and not in A's; B refuses a
//   name that is taken, with its sentence; a change B's owner makes shows in the editor here. ⌘P in a chat's
//   composer lists both libraries and Enter puts B's prompt at the cursor.
//   B stops: its prompts stay in both popups, marked, can be inserted and cannot be changed; B is back: they can.
//   B is removed from the list: its prompts are gone, and the tree has no level of servers again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDist, loadPlaywright, onEnd, until } from "./shot.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), FIRST = Number(process.env.PORT) || 4811;
const ROOT = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "aiwb-real-")), BIN = path.join(ROOT, "ai-whiteboard");
const A = { dir: path.join(ROOT, "A"), port: FIRST }, B = { dir: path.join(ROOT, "B"), port: FIRST + 1, remote: FIRST + 2 };
const NO_AGENT = ["-claude", "/nonexistent/claude", "-cursor", "/nonexistent/agent", "-pi", "/nonexistent/pi", "-cursor-cost", "/nonexistent/cursor-cost"];
// (the waits of the connection between the two, lowered as the Go tests lower them: cmd/ai-whiteboard/testwaits.go)
const env = { ...process.env, AIWB_MCP_PORT: "0", AIWB_REMOTE_BIND: "127.0.0.1", AIWB_TEST_WAITS: "silence=6s,backoff=2s,ping=1s" };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const failures = [], fail = (line) => { failures.push(line); console.log(`FAIL ${line}`); }, pass = (line) => console.log(`ok   ${line}`), note = (line) => console.log(`     ${line}`);

const procs = {};
async function start(name, s, client) {
  const p = (procs[name] = spawn(BIN, ["serve", "-home", s.dir, "-port", String(s.port), "-client", client, "-cwd", ROOT, ...NO_AGENT], { env, stdio: ["ignore", "pipe", "pipe"] }));
  p.log = ""; p.stdout.on("data", (d) => (p.log += d)); p.stderr.on("data", (d) => (p.log += d));
  if (!await until(() => fetch(`http://127.0.0.1:${s.port}/api/hello`).then((r) => r.ok, () => false), 30000)) throw new Error(`server ${name} did not start on port ${s.port}:\n${p.log}`);
}
async function stop(name) {
  const p = procs[name];
  if (!p) return;
  delete procs[name];
  p.kill("SIGTERM");
  await Promise.race([new Promise((ok) => p.on("exit", ok)), sleep(10000).then(() => p.kill("SIGKILL"))]);
}
let browser;
const tidy = async () => { await browser?.close().catch(() => {}); for (const name of Object.keys(procs)) await stop(name); fs.rmSync(ROOT, { recursive: true, force: true }); };
onEnd(tidy);

/** A client of a server's own port, which knows it by its open event stream: what a page of that server is to it. */
async function client(port, id) {
  const cut = new AbortController(), base = `http://127.0.0.1:${port}`;
  const stream = (await fetch(`${base}/api/events?client=${id}`, { signal: cut.signal })).body.getReader();
  (async () => { try { while (!(await stream.read()).done); } catch {} })();
  await sleep(300);
  const call = async (method, at, body) => {
    const r = await fetch(base + at, { method, headers: { "Content-Type": "application/json", "X-AIWB-Client": id }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => cut.abort() };
}
/** A server's own library, as it answers a read. */
const libraryOf = async (port) => (await (await fetch(`http://127.0.0.1:${port}/api/library`)).json()).libraries[0];

/** In the page: what the two popups show. */
function seen() {
  const dlg = document.querySelector(".lib-dialog"), ins = document.querySelector(".ins-dialog"), text = (e) => e?.textContent ?? "";
  const rows = [...(dlg?.querySelectorAll(".lib-list .lib-row") ?? [])], options = [...(ins?.querySelectorAll('[role="option"]') ?? [])], form = dlg?.querySelector(".lib-form");
  const line = (r) => (r.matches(".hit, [role=option]") ? text(r.querySelector(".lib-path")) + text(r.querySelector(".lib-pname")) : "  ".repeat(Number(r.getAttribute("aria-level")) - 1) + text(r.querySelector(".lib-name")));
  return {
    open: !!dlg, rows: rows.map(line), off: rows.filter((r) => r.querySelector(".lib-off")).map(line), says: text(dlg?.querySelector(".lib-list .menu-empty")),
    form: form ? { head: text(form.querySelector(".lib-form-head")), name: form.querySelector("input").value, text: form.querySelector("textarea")?.value ?? null, fixed: form.querySelector("input").readOnly,
      err: text(form.querySelector(".dialog-err")), notice: text(form.querySelector(".lib-notice")), off: [...form.querySelectorAll("button")].filter((b) => b.disabled).map((b) => b.textContent),
      group: [...(form.querySelector("select")?.selectedOptions ?? [])].map((o) => (o.parentElement.matches("optgroup") ? o.parentElement.label + "|" : "") + o.label).join() } : null,
    insert: ins ? { rows: options.map(line), off: options.filter((r) => r.querySelector(".lib-off")).map(line) } : null,
  };
}

try {
  execFileSync("go", ["build", "-o", BIN, "./cmd/ai-whiteboard"], { cwd: REPO, stdio: "inherit" });
  const dist = buildDist(path.join(ROOT, "dist"));
  fs.mkdirSync(A.dir); fs.mkdirSync(B.dir);
  execFileSync(BIN, ["remote", "setup", "-home", B.dir, "-port", String(B.remote), "-name", "127.0.0.1", "-server-port", String(B.port)], { env, stdio: "pipe" });
  const secret = execFileSync(BIN, ["secret", "-home", B.dir], { env }).toString().trim();
  await start("B", B, "");
  await start("A", A, dist);
  browser = await (await loadPlaywright()).chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${A.port}`);
  await page.waitForSelector(".side-foot .library-btn", { timeout: 30000 });
  /** Waits for the page to show what `want` says, and says so; fails with what it shows. */
  const shows = async (what, want) => {
    let s;
    if (await until(async () => want((s = await page.evaluate(seen))), 30000)) pass(what); else fail(`${what}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const DLG = ".lib-dialog", row = (label) => page.locator(`${DLG} .lib-row:has(.lib-name:text-is("${label}"))`), button = (label) => page.locator(`${DLG} button:text-is("${label}")`);
  const name = page.locator(`${DLG} .lib-form input`), text = page.locator(`${DLG} .lib-form textarea`), LONG = "a".repeat(80);

  // ---- this computer's library alone
  await page.locator(".side-foot .library-btn").click();
  await shows("a new server: the popup opens on an empty library", (s) => s.open && !s.rows.length && s.says === "The library has no prompts yet.");
  await button("New group").click(); await name.fill("git"); await button("Save").click();
  await shows("a group is made", (s) => s.rows.join("|") === "git" && s.form?.head === "Group");
  await button("New prompt").click(); await name.fill("review"); await text.fill("Review this change.\n\n- say why"); await button("Save").click();
  await shows("a prompt is made in the chosen group; the tree has no level of servers", (s) => s.rows.join("|") === "git|  review" && s.form?.head === "Prompt" && s.form.group === "git");
  await button("New prompt").click(); await name.fill("REVIEW"); await text.fill("typed"); await button("Save").click();
  let s = await shows("a second prompt of that name in another case is refused, and what was typed stays", (x) => !!x.form?.err && x.form.name === "REVIEW" && x.form.text === "typed");
  note(`the server's sentence: ${s.form?.err}`);
  await name.fill(LONG); await button("Save").click();
  await shows("a name of 80 characters is saved", (x) => x.rows.length === 3 && x.form?.head === "Prompt" && !x.form.err);
  const mine = await libraryOf(A.port);
  if (mine.groups.length === 1 && mine.prompts.length === 2 && mine.prompts.some((p) => p.text === "Review this change.\n\n- say why")) pass("the server holds what the popup made, the text with its line breaks"); else fail(`A's library is ${JSON.stringify(mine)}`);
  const second = await ctx.newPage();
  await second.goto(`http://127.0.0.1:${A.port}`);
  await second.locator(".side-foot .library-btn").click();
  await second.locator(`${DLG} .lib-row:has(.lib-name:text-is("review"))`).click();
  await second.locator(`${DLG} .lib-form input`).fill("review twice");
  await second.locator(`${DLG} button:text-is("Save")`).click();
  await shows("a change made in a second window shows in the first with no reload", (x) => x.rows.includes("  review twice") && !x.rows.includes("  review"));
  await second.close();
  await row("git").click(); await button("Delete").click();
  const asked = await page.locator(".dialog-backdrop .dialog .dialog-body").textContent({ timeout: 10000 });
  if (asked === "“git” is deleted with everything in it: 2 prompts.") pass("deleting the group asks with the number of its prompts"); else fail(`the question before the group is deleted: ${JSON.stringify(asked)}`);
  await page.locator('.dialog-backdrop .dialog button:text-is("Cancel")').click();

  // ---- another server joins the list
  const ofA = await client(A.port, "real-a"), ofB = await client(B.port, "real-b"), address = `https://127.0.0.1:${B.remote}`;
  await ofB.call("POST", "/api/library/local/prompts", { name: "standup", parent: "", text: "What did you do?" });
  const tested = await ofA.call("POST", "/api/servers/test", { address, secret, selfSigned: true, pin: "" });
  const added = await ofA.call("POST", "/api/servers", { name: "Studio", address, secret, selfSigned: true, pin: tested.body?.fingerprint });
  if (!added.body?.saved) throw new Error(`B was not added to A's list: ${JSON.stringify(added.body)} (its test: ${JSON.stringify(tested.body)})`);
  const entry = added.body.server.id;
  await shows("the other server's library is in the open popup under its name, after this computer's", (x) => x.rows.join("|") === ["This computer", "  git", "    " + LONG, "    review twice", "Studio", "  standup"].join("|") && !x.off.length);
  await page.locator(`${DLG} .lib-search input`).fill("studio stand");
  await shows("a search for the server's name and a prompt's name finds the prompt", (x) => x.rows.join("|") === "Studio/standup");
  await page.locator(`${DLG} .lib-search input`).fill("");
  await row("Studio").click(); await button("New prompt").click();
  await shows("a new prompt at the server's entry is to go to that server", (x) => x.form?.head === "New prompt" && x.form.group === "Studio|Top of the library");
  await name.fill("retro"); await text.fill("What went well?"); await button("Save").click();
  await shows("it is in the tree under the server", (x) => x.rows.includes("  retro") && x.form?.head === "Prompt" && x.form.name === "retro");
  const theirs = await libraryOf(B.port), retro = theirs.prompts.find((p) => p.name === "retro");
  if (retro?.text === "What went well?" && !(await libraryOf(A.port)).prompts.some((p) => p.name === "retro")) pass("the prompt is in the other server's own library, and not in this computer's"); else fail(`B's own library is ${JSON.stringify(theirs)}`);
  await button("New prompt").click(); await name.fill("Retro"); await button("Save").click();
  s = await shows("the other server refuses a name that is taken, and the popup shows its sentence", (x) => !!x.form?.err && x.form.name === "Retro");
  note(`its sentence: ${s.form?.err}`);
  await button("Cancel").click();
  await row("retro").click();
  await shows("the prompt is chosen", (x) => x.form?.name === "retro" && x.form.text === "What went well?");
  await ofB.call("PATCH", `/api/library/local/prompts/${retro?.id}`, { text: "Changed by the owner." });
  await shows("a change the server's owner makes shows in the editor here, with no reload", (x) => x.form?.text === "Changed by the owner.");

  // ---- the insert popup, in a chat's composer
  await page.keyboard.press("Escape");
  await page.locator(".icon-btn.new").first().click();
  await page.locator('.menu .menu-item:has-text("New chat")').first().click();
  const box = page.locator(".composer .composer-input").first(), held = async () => (await box.evaluate((e) => e.innerText)).replace(/\n+$/, "");
  await box.click({ timeout: 15000 });
  await page.keyboard.type("Hello world");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+p");
  await shows("⌘P in a chat's composer lists both libraries", (x) => x.insert?.rows.join("|") === [`This computer/git/${LONG}`, "This computer/git/review twice", "Studio/retro", "Studio/standup"].join("|") && !x.insert.off.length);
  await page.keyboard.type("studio retro");
  await page.keyboard.press("Enter");
  if (await until(async () => await held() === "HelloChanged by the owner. world", 10000)) pass("Enter puts the other server's prompt at the cursor"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);

  // ---- the other server stops, and is back
  await page.locator(".side-foot .library-btn").click();
  await row("retro").click();
  await stop("B");
  s = await shows("the server stopped: its prompts are still listed, it is marked, and nothing of it can be changed", (x) => x.off.join() === "Studio" && x.rows.includes("  retro") && x.form?.fixed === true && ["Save", "Delete"].every((l) => x.form.off.includes(l)));
  note(`the editor says: ${s.form?.notice}`);
  const refused = await ofA.call("DELETE", `/api/library/${entry}/prompts/${retro?.id}`);
  if (refused.status === 503 && refused.body?.code === "server_unreachable") pass(`a call past the popup is refused: ${refused.body.error}`); else fail(`a change while the server is away was answered ${JSON.stringify(refused)}`);
  await page.keyboard.press("Escape");
  await box.click();
  await page.keyboard.press("ControlOrMeta+p");
  await shows("the insert popup still lists them, marked", (x) => x.insert?.off.join("|") === "Studio/retro|Studio/standup");
  await page.keyboard.type("standup");
  await page.keyboard.press("Enter");
  if (await until(async () => (await held()).includes("What did you do?"), 10000)) pass("a prompt of the server that stopped is inserted"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);
  await page.locator(".side-foot .library-btn").click();
  await row("retro").click();
  await start("B", B, "");
  await shows("the server is back: its prompt can be changed again", (x) => !x.off.length && x.form?.name === "retro" && x.form.fixed === false);
  await text.fill("Saved after it came back."); await button("Save").click();
  if (await until(async () => (await libraryOf(B.port)).prompts.some((p) => p.text === "Saved after it came back."), 20000)) pass("a save after it came back reaches it"); else fail("the save after the server came back did not reach it");

  // ---- removed from the list
  await ofA.call("DELETE", `/api/servers/${entry}`);
  await shows("removed from the list, the server takes its prompts with it, and the tree has no level of servers", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice"].join("|") && !x.form);
  for (const e of errors) fail(`page error: ${e}`);
  ofA.close(); ofB.close();
} catch (e) { fail(String(e?.stack ?? e)); }
await tidy();
console.log(failures.length ? `\n${failures.length} failed` : "\nthe prompt library's popups work on real servers");
process.exit(failures.length ? 1 : 0);
