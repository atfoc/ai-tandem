// Proves what a section shows in each state of its server (plans/remote-server-sections-goal.md, 3.2, 3.3, 3.7, 3.10;
// the contract's 3.10): connecting, it says so and has no rows; connected with nothing on the server, the one line;
// connected with a tree, that server's tree as it has it (what is in no group first, the groups nested as given and
// in their order, a board with its chats), every group open whatever that server's own page
// shows; not connected, the words the server list has for the state and the one line, and no rows; too old, that with
// the version it reports; a changed certificate and every other state of the list, its words. The head's "+" is
// there only while the tree is held. Rows are decided by the tree and words by the state. The head's own behaviour is SEC.3's, what follows a change made elsewhere SEC.6's.
import { check, mockEval, openPage, seed, sideSeen, until } from "../shot.mjs";

const J = JSON.stringify;
const AWAY = "Its chats show when the server is back.", EMPTY = "Nothing on this server yet.";
// Studio Mac's tree as its section draws it
const TREE = [
  "board Floor plan", "  chat Label the rooms", "chat Scratch", "chat Render queue is stuck",
  "group Renders", "  group Nightly", "    chat Last night's failures", "  board Storyboard", "    chat Tighten act two", "  chat Queue order",
  "group Old takes", "  chat Take 14",
];
// the words the server list has for each state that waits for the user or for the network (logic/servers.ts)
const WORDS = { unreachable: "Unreachable", secret_not_accepted: "Secret not accepted", fingerprint_not_accepted: "Fingerprint not accepted", certificate_changed: "Certificate changed",
  certificate_not_accepted: "Certificate not accepted", name_not_known: "Name not known there", not_aiwb: "Not an AI Whiteboard server", another_server: "Another server" };

await check("SEC.2 a section in each state of its server", async ({ url, browser, fail, note }) => {
  await seed(url, "SEC");
  const { ctx, page, errors } = await openPage({ url, browser });
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  /** Waits until the section shows what `want` names of sideSeen's answer, and fails with what it shows when it does not. */
  const shows = async (name, id, want) => {
    const ok = (s) => Object.entries(want).every(([k, v]) => J(s[k]) === J(v));
    if (!await until(async () => ok(await sideSeen(page, id)), 10000)) { const s = await sideSeen(page, id); fail(`${name}: the section shows ${J(Object.fromEntries(Object.keys(want).map((k) => [k, s[k]])))}, not ${J(want)}`); }
  };
  await page.waitForSelector('.side-section[data-server="s_studio"] .side-row');

  // ---- each state as the seed has it
  await shows("connecting", "s_wait", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });
  await shows("connected, nothing on the server", "s_empty", { state: "Connected", tone: "ok", outline: [], lines: [EMPTY], add: true });
  await shows("connected, with a tree", "s_studio", { state: "Connected", tone: "ok", outline: TREE, lines: [], add: true });
  await shows("not connected", "s_away", { state: "Unreachable", tone: "bad", outline: [], lines: [AWAY], add: false });
  await shows("too old", "s_old", { state: "Too old", tone: "bad", outline: [], lines: ["Update the server on that machine.", "Version 0.9.1"], add: false });
  await shows("a changed certificate", "s_cert", { state: "Certificate changed", tone: "bad", outline: [], lines: [AWAY], add: false });

  // the tree is that server's: a group its own page shows collapsed is open here, and the paths are its own
  const studio = await sideSeen(page, "s_studio");
  if (!await mockEval('return onServer("s_studio", () => groups.find((g) => g.id === "g_shop").collapsed === true);', url)) fail("the seed's group Renders is not collapsed on Studio Mac itself: the check proves nothing of it");
  if (!studio.titles.includes("Renders / Nightly")) fail(`the nested group's path is not "Renders / Nightly": ${J(studio.titles.filter((t) => t.includes("Nightly")))}`);
  // the "+" of a connected head shows under the pointer, as a group's does
  const head = page.locator('.side-section[data-server="s_studio"] > .side-section-head');
  await head.hover();
  if (!await until(() => head.locator('button[title="New on Studio Mac"]').isVisible(), 5000)) fail('the "+" of a connected section\'s head does not show under the pointer');

  // the words are the server list's: the Servers dialog says the same of each entry. Words with a colon ("Too old: update the
  // server on that machine") are split by the section: its narrow head has what stands before the colon, a line of its body the rest
  await page.locator(".side-foot .servers-btn").click();
  await page.waitForSelector('.servers-dialog[role="dialog"] .servers-row');
  const listed = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".servers-dialog .servers-row")].map((r) => [r.querySelector(".servers-name").textContent, r.querySelector(".servers-state").textContent])));
  for (const [id, name] of [["s_studio", "Studio Mac"], ["s_wait", "Slow link"], ["s_away", "Attic server"], ["s_old", "Old Mini"], ["s_cert", "Cert box"]]) {
    const seen = await sideSeen(page, id), said = seen.state, [head, rest] = listed[name].split(": ");
    if (head !== said) fail(`the section of ${name} says "${said}", the Servers dialog "${listed[name]}"`);
    if (rest && !seen.lines.some((l) => l.toLowerCase() === `${rest}.`.toLowerCase())) fail(`the section of ${name} does not say the rest of the dialog's words ("${rest}"): ${J(seen.lines)}`);
  }
  await page.keyboard.press("Escape");
  await until(async () => !await page.locator(".servers-dialog").count(), 10000);

  // ---- every other state of the list: its words, the one line, no rows, no "+"
  for (const [state, words] of Object.entries(WORDS)) {
    await set("s_cert", state);
    await shows(`the state ${state}`, "s_cert", { state: words, tone: "bad", outline: [], lines: [AWAY], add: false });
  }

  // ---- connected, the tree not here yet: still connecting; then the tree (the stream gives the snapshot first, and then the state)
  await set("s_wait", "connected", { tree: false });
  await shows("connected before its tree came", "s_wait", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });
  await set("s_wait", "connected");
  await shows("its tree came", "s_wait", { state: "Connected", tone: "ok", outline: [], lines: [EMPTY], add: true });
  await set("s_wait", "connecting");
  await shows("connecting again", "s_wait", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });

  // ---- a section with a tree whose server drops, is too old, and is back
  await set("s_studio", "unreachable", { detail: "connection refused" });
  await shows("Studio Mac dropped", "s_studio", { state: "Unreachable", tone: "bad", outline: [], lines: [AWAY], add: false });
  if (await page.locator('.side-section[data-server="s_studio"] .side-row, .side-section[data-server="s_studio"] .side-group').count()) fail("a section whose server dropped still draws a row or a group");
  await set("s_studio", "too_old", { version: "0.8.0" });
  await shows("Studio Mac too old", "s_studio", { state: "Too old", tone: "bad", outline: [], lines: ["Update the server on that machine.", "Version 0.8.0"], add: false });
  await set("s_studio", "connected");
  await shows("Studio Mac back", "s_studio", { state: "Connected", tone: "ok", outline: TREE, lines: [], add: true });

  // ---- a reload during an outage: nothing of that server is known
  await set("s_studio", "unreachable", { detail: "connection refused" });
  await shows("Studio Mac dropped again", "s_studio", { outline: [], lines: [AWAY] });
  await page.reload(); await page.waitForSelector(".side-tree .side-section");
  await shows("after a reload during the outage", "s_studio", { state: "Unreachable", tone: "bad", outline: [], lines: [AWAY], add: false });
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => /s_studio/.test(k + localStorage.getItem(k))));
  if (kept.length) fail(`the browser's storage names Studio Mac after the reload: ${J(kept)}`);

  for (const e of errors) fail(`page error: ${e}`);
  await ctx.close();
  note(`connecting, connected and empty, connected with its tree of ${TREE.length} rows, not connected, too old with its version, ${Object.keys(WORDS).length} states that wait: the list's words, rows only with a tree, the "+" only with one`);
});
