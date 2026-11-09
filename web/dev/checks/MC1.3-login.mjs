// MC1.3 (multiple-claude goal §1.3, screen 3; plan D21, D29): logging an account in from Settings › Claude accounts on the seed "MC", at
// the three viewports, with window.open stubbed in the page. The app opens a placeholder window during the press (window.open("") on web:
// a browser blocks a window opened after the network call) and points it at the login URL when the call answers; the stub returns a fake
// window for "" (or no URL), whose location.href records the URL, and records a non-empty URL directly (returning null). The URL is opened
// exactly once per login and once per Open link again, and one placeholder is opened during each press that starts a login.
// Log in on Claude · Personal: (a) the login URL is opened, into the placeholder opened during the press (its opener cleared, its title
// "Opening the Claude login…"); (b) the account's login row says "⟳ Opened your browser" and "Sign in there, then paste the code it
// shows:", with the code field, Submit, Open link again (which opens the URL again, without a placeholder) and Cancel; the code "wrong"
// shows Claude's error "Invalid code. Please make sure the full code was copied." under the field, which stays; the code "bad#code" ends
// the login, as Claude does on a well-formed wrong code: the row shows "Login failed: That code wasn't accepted. Please try again." and
// Log in again (no code field, no Open link again), which starts a new login (a placeholder, the URL opened again, the code field back);
// (c) another code: the row goes and the chip says "Logged in as personal@example.com", without a reload. Cancel, in a second run, ends
// the login and does not restore the container (the login's start ran it): the chips are "Not logged in", "● Running". With
// flags.aliasLogin = { preparing, hold } the row says "Preparing the account's container…" (no code field); a Cancel then closes the
// placeholder unused; a second time, once the container runs (release), the URL opens in the placeholder and the code field shows.
// The mock's contract for "wrong", "bad#code" and Cancel is the server's (Claude ends the login on a well-formed wrong code; a cancel
// leaves the container as it is).
import { callOfRequest, check, hostCall, mockEval, seed, until } from "../shot.mjs";
import { chipsOf, openAccounts, rowOf, shoot, textOf } from "./accounts.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const URL_PERS = "https://claude.ai/oauth/authorize?mock=a_pers0001";
const WRONG = "Invalid code. Please make sure the full code was copied.";
const FAILED = "Login failed: That code wasn't accepted. Please try again.";
const PLACEHOLDER = "Opening the Claude login…";

/** The window.open stub (in the page): __opened the URLs opened, __placeholders the placeholder windows (inPress: opened while an input
 *  event was being handled, the press that starts the login). */
function stubOpen() {
  window.__opened = []; window.__placeholders = []; window.__mcMark = 1;
  let inPress = false;
  for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "keydown", "keyup"]) {
    window.addEventListener(t, () => { inPress = true; setTimeout(() => { inPress = false; }, 0); }, true);
  }
  window.open = (u) => {
    if (u === undefined || u === "") {
      const w = { closed: false, opener: window, url: "", document: { title: "", body: { textContent: "" } }, close() { w.closed = true; }, location: {} };
      Object.defineProperty(w.location, "href", { get: () => w.url || "about:blank", set: (v) => { w.url = String(v); window.__opened.push(String(v)); } });
      window.__placeholders.push({ w, inPress });
      return w;
    }
    window.__opened.push(String(u));
    return null;
  };
}

await check("MC1.3 Log in: the URL opened, the login row, a wrong code, a failed login, a right one, Cancel, preparing", async ({ url, viewport, open, fail }) => {
  await seed(url, "MC");
  const { page } = await open();
  await page.evaluate(stubOpen);
  await openAccounts(page);
  const opened = () => page.evaluate(() => window.__opened);
  const holders = () => page.evaluate(() => window.__placeholders.map(({ w, inPress }) => ({ inPress, url: w.url, closed: w.closed, opener: w.opener === null ? null : "set",
    title: w.document.title, text: w.document.body.textContent })));
  const row = () => rowOf(page, "a_pers0001");
  const login = () => byTid(page, "account-login", { id: "a_pers0001" }).last();
  const noLogin = () => until(async () => (await byTid(page, "account-login", { id: "a_pers0001" }).count()) === 0, 8000);
  const shown = (loc, ms = 10000) => until(() => loc.isVisible().catch(() => false), ms);
  const chips = async () => (await chipsOf(row())).map((c) => c.text);
  const err = () => byTid(login(), "account-login-error");
  /** After a press that starts a login: one more placeholder, opened during the press. */
  const placeholderFor = async (what, n) => {
    if (!await until(async () => (await holders()).length === n, 5000)) return fail(`${what}: ${(await holders()).length} placeholder windows, not ${n}`);
    const h = (await holders())[n - 1];
    if (!h.inPress) fail(`${what}: the placeholder window was not opened during the press`);
    if (h.opener !== null) fail(`${what}: the placeholder window keeps its opener`);
    if (h.title !== PLACEHOLDER && h.text !== PLACEHOLDER) fail(`${what}: the placeholder window says ${J([h.title, h.text])}`);
    return h;
  };
  const notLoggedIn = async (container = "stopped") => {
    await mockEval(`aliasSet("local", "a_pers0001", { login: { known: true, loggedIn: false }, container: { state: ${J(container)} } });`, url);
    await until(async () => (await chips())[0] === "Not logged in", 8000);
  };

  // ---- (a), (b)
  await press(page, byTid(row(), "account-login-button"));
  if (!await shown(byTid(login(), "account-code"))) throw new Error("Log in drew no login row with a code field");
  await placeholderFor("Log in", 1);
  if (!await until(async () => (await opened()).length === 1, 5000)) fail(`the page opened ${J(await opened())}, not the login URL once`);
  else if ((await opened())[0] !== URL_PERS) fail(`the page opened ${J((await opened())[0])}, not ${URL_PERS}`);
  else if ((await holders())[0]?.url !== URL_PERS) fail("the login URL did not open in the placeholder window");
  const said = await textOf(login());
  for (const w of ["⟳ Opened your browser", "Sign in there, then paste the code it shows:"]) if (!said.includes(w)) fail(`the login row says ${J(said)}: no ${J(w)}`);
  for (const id of ["account-code-submit", "account-open-again", "account-login-cancel"]) if (!await byTid(login(), id).isVisible()) fail(`the login row has no ${id}`);
  if (await byTid(login(), "account-login-again").count()) fail("a login that waits for its code shows Log in again");
  await press(page, byTid(login(), "account-open-again"));
  if (!await until(async () => (await opened()).length === 2, 5000)) fail("Open link again opened nothing");
  else if ((await opened())[1] !== URL_PERS) fail(`Open link again opened ${J((await opened())[1])}`);
  if ((await holders()).length !== 1) fail("Open link again, with the URL kept, opened a placeholder window");

  // ---- a malformed code: Claude's error, the field stays
  await byTid(login(), "account-code").fill("wrong");
  await press(page, byTid(login(), "account-code-submit"));
  if (!await until(async () => (await textOf(err())) === WRONG, 8000)) fail(`a wrong code shows ${J(await textOf(err()))}, not ${J(WRONG)}`);
  if (!await byTid(login(), "account-code").isVisible()) fail("the code field went after a wrong code");
  await shoot(page, `login-error-${viewport}`);

  // ---- a well-formed wrong code: Claude ends the login; Log in again starts a new one
  await byTid(login(), "account-code").fill("bad#code");
  await press(page, byTid(login(), "account-code-submit"));
  const again = byTid(login(), "account-login-again");
  if (!await shown(again, 8000)) {
    fail(`after "bad#code" the login row shows no Log in again (it says ${J(await textOf(login()))}; the chips are ${J(await chips())})`);
    if (await noLogin()) await notLoggedIn(); // (a mock that logged it in: as before, for what follows)
    else { await press(page, byTid(login(), "account-login-cancel")); await noLogin(); }
    await press(page, byTid(row(), "account-login-button"));
    await shown(byTid(login(), "account-code"));
  } else {
    if (await textOf(err()) !== FAILED) fail(`a failed login shows ${J(await textOf(err()))}, not ${J(FAILED)}`);
    if (await byTid(login(), "account-code").count()) fail("a failed login still draws the code field");
    if (await byTid(login(), "account-open-again").count()) fail("a failed login offers Open link again");
    if (!await byTid(login(), "account-login-cancel").isVisible()) fail("a failed login has no Cancel");
    await shoot(page, `login-failed-${viewport}`);
    await press(page, again);
    if (!await shown(byTid(login(), "account-code"))) fail("Log in again drew no code field");
    await placeholderFor("Log in again", 2);
    if (!await until(async () => (await opened()).length === 3, 5000)) fail(`Log in again opened ${J((await opened()).slice(2))}, not the login URL once`);
    else if ((await opened())[2] !== URL_PERS) fail(`Log in again opened ${J((await opened())[2])}`);
  }

  // ---- (c) a right code
  if (await byTid(login(), "account-code").isVisible().catch(() => false)) {
    await byTid(login(), "account-code").fill("abc-123");
    await press(page, byTid(login(), "account-code-submit"));
    if (!await noLogin()) fail("the login row stayed after a right code");
  }
  if (!await until(async () => (await chips())[0] === "Logged in as personal@example.com", 8000)) fail(`after a right code the chips are ${J(await chips())}`);
  if (await byTid(row(), "account-login-button").count()) fail("a logged-in account still has Log in");
  if (await page.evaluate(() => window.__mcMark) !== 1) fail("the page reloaded");

  // ---- Cancel ends the login; the container its start ran stays running
  await notLoggedIn();
  let nOpened = (await opened()).length, nHolders = (await holders()).length;
  await press(page, byTid(row(), "account-login-button"));
  if (!await shown(byTid(login(), "account-login-cancel"))) throw new Error("the second Log in drew no login row");
  await placeholderFor("the second Log in", nHolders + 1);
  if (!await until(async () => (await opened()).length === nOpened + 1, 5000)) fail("the second Log in did not open the URL once");
  const cancelled = page.waitForResponse((r) => { const c = callOfRequest(r.request()); return c?.method === "DELETE" && c.path === "/api/aliases/a_pers0001/login"; }, { timeout: 15000 });
  await press(page, byTid(login(), "account-login-cancel"));
  if (!await noLogin()) fail("Cancel left the login row");
  await cancelled; // (the chips before its answer are the login's: read them after it, with the server's list)
  const server = (await hostCall(url, "GET", "/api/aliases")).body?.aliases?.find((a) => a.id === "a_pers0001");
  if (server?.container.state !== "running") fail(`after Cancel the server's container is ${J(server?.container.state)}, not "running"`);
  if (!await until(async () => J(await chips()) === J(["Not logged in", server?.container.state === "running" ? "● Running" : "○ Stopped"]), 8000)
    || J(await chips()) !== J(["Not logged in", "● Running"])) fail(`after Cancel the chips are ${J(await chips())}, not ["Not logged in","● Running"]`);

  // ---- preparing, cancelled: the placeholder is closed unused
  await notLoggedIn();
  await mockEval(`flags.aliasLogin = { preparing: true, hold: true };`, url);
  nOpened = (await opened()).length; nHolders = (await holders()).length;
  await press(page, byTid(row(), "account-login-button"));
  if (!await until(async () => (await textOf(login())).includes("Preparing the account's container…"), 8000)) fail(`preparing: the login row says ${J(await textOf(login()))}`);
  if (await byTid(login(), "account-code").count()) fail("preparing: the code field is drawn");
  await placeholderFor("preparing", nHolders + 1);
  await press(page, byTid(login(), "account-login-cancel"));
  if (!await noLogin()) fail("preparing: Cancel left the login row");
  if (!await until(async () => (await holders())[nHolders]?.closed === true, 5000)) fail("preparing: Cancel left the placeholder window open");
  await mockEval(`release("aliasLogin"); delete flags.aliasLogin;`, url);
  if ((await opened()).length !== nOpened) fail(`preparing, cancelled: the page opened ${J((await opened()).slice(nOpened))}`);

  // ---- preparing, until the container runs: the URL opens in the placeholder
  await notLoggedIn();
  await mockEval(`flags.aliasLogin = { preparing: true, hold: true };`, url);
  nOpened = (await opened()).length; nHolders = (await holders()).length;
  await press(page, byTid(row(), "account-login-button"));
  if (!await until(async () => (await textOf(login())).includes("Preparing the account's container…"), 8000)) fail(`preparing: the login row says ${J(await textOf(login()))}`);
  await placeholderFor("preparing", nHolders + 1);
  if (await mockEval(`const n = release("aliasLogin"); delete flags.aliasLogin; return n;`, url) !== 1) fail("preparing: the mock held no container start");
  if (!await shown(byTid(login(), "account-code"))) fail("the container runs: no code field");
  if (!await until(async () => (await opened()).length === nOpened + 1, 8000)) fail("the container runs: the URL was not opened once");
  else if ((await holders())[nHolders]?.url !== URL_PERS) fail("the container runs: the URL did not open in the placeholder window");
  await press(page, byTid(login(), "account-login-cancel"));
}, { viewports, page: false });
