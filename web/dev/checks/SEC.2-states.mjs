// Proves what a section shows in each state of its server (plans/remote-server-sections-goal.md, 3.2, 3.3, 3.7, 3.10;
// the contract's 3.10): connecting, it says so and has no rows; connected with nothing on the server, the one line;
// connected with a tree, that server's tree as it has it (what is in no group first, the groups nested as given and
// in their order, a board with its chats), every group open whatever that server's own page
// shows; not connected, the words the server list has for the state and the one line, and no rows; too old, that with
// the version it reports; a changed certificate and every other state of the list, its words. The head's "+" is
// there only while the tree is held. Rows are decided by the tree and words by the state. The head's own behaviour is SEC.3's, what follows a change made elsewhere SEC.6's.
// Ports dev/checks/SEC.2-states.mjs (S1) to the new build, at the three viewports (A-SB-23, A-SB-35, A-SB-41, A-SC-03, A-SC-06, A-SC-07,
// A-SC-09 to A-SC-12, A-SC-15, A-SC-23). Deviations: on the touch viewports the "+" is always drawn, so "shows under the pointer" is asked
// on the desktop only, where it is also asked that it is not drawn before; the Servers dialog's words are S3's, read in its dialog
// (`servers-dialog`, rows `servers-row` with `servers-name` and `servers-state`).
// Besides the old check (A-OW-14): no section but this computer's draws its notice, its reason or Retry, Restart server and Open server log, in any state.
// Added in the sweep (rn-sw-webtest), from web/test/sidebar.test.ts "a connected server whose things are all archived says so, not that it has nothing; with Show archived its
// rows show and the line goes" (A-SC-08), which nothing in the browser proved on the new build: a server whose every thing is archived has something on it, and its section says so.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, press, touchNow } from "./sel.mjs";
import { section, sectionHead, sideSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

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

await check("SEC.2 a section in each state of its server", async ({ url, open, fail, note }) => {
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  /** Waits until the section shows what `want` names of sideSeen's answer, and fails with what it shows when it does not. */
  const shows = async (name, id, want) => {
    const ok = (s) => Object.entries(want).every(([k, v]) => J(s[k]) === J(v));
    if (!await until(async () => ok(await sideSeen(page, id)), 10000)) { const s = await sideSeen(page, id); fail(`${name}: the section shows ${J(Object.fromEntries(Object.keys(want).map((k) => [k, s[k]])))}, not ${J(want)}`); }
  };
  await byTid(section(page, "s_studio"), "side-row").first().waitFor({ state: "attached", timeout: 15000 });

  // ---- each state as the seed has it
  await shows("connecting", "s_wait", { state: "Connecting…", tone: "wait", outline: [], lines: [], add: false });
  await shows("connected, nothing on the server", "s_empty", { state: "Connected", tone: "ok", outline: [], lines: [EMPTY], add: true });
  await shows("connected, with a tree", "s_studio", { state: "Connected", tone: "ok", outline: TREE, lines: [], add: true });
  await shows("not connected", "s_away", { state: "Unreachable", tone: "bad", outline: [], lines: [AWAY], add: false });
  await shows("too old", "s_old", { state: "Too old", tone: "bad", outline: [], lines: ["Update the server on that machine.", "Version 0.9.1"], add: false });
  await shows("a changed certificate", "s_cert", { state: "Certificate changed", tone: "bad", outline: [], lines: [AWAY], add: false });

  // A-OW-14: the notice, the reason, "Retry", "Restart server" and "Open server log" are this computer's section's own (`LocalExtras` is
  // drawn for the local entry only); another server that could not be reached or is too old has its words and the one line, and nothing to press
  for (const id of ["s_away", "s_old", "s_cert", "s_wait", "s_empty", "s_studio"]) {
    const sec = section(page, id), got = await byTid(sec, "side-section-extra").count() + await sec.getByText(/^(Retry|Restart server|Open server log)$/).count();
    if (got) fail(`the section of ${id} draws this computer's notice or buttons (${got} of them): they are for the local entry only`);
  }

  // the tree is that server's: a group its own page shows collapsed is open here, and the paths are its own
  const studio = await sideSeen(page, "s_studio");
  if (!await mockEval('return onServer("s_studio", () => groups.find((g) => g.id === "g_shop").collapsed === true);', url)) fail("the seed's group Renders is not collapsed on Studio Mac itself: the check proves nothing of it");
  if (!studio.titles.includes("Renders / Nightly")) fail(`the nested group's path is not "Renders / Nightly": ${J(studio.titles.filter((t) => t.includes("Nightly")))}`);
  // the "+" of a connected head shows under the pointer, as a group's does (a finger has no pointer: there it is always drawn)
  const head = sectionHead(page, "s_studio"), plus = head.locator('[data-testid="side-add"][title="New on Studio Mac"]');
  const touch = await touchNow(page);
  if (!touch) {
    await page.mouse.move(5, 5); // (away from every row)
    if (await plus.isVisible()) fail('the "+" of a connected section\'s head shows with no pointer over it');
  }
  await hover(page, head);
  if (!await until(() => plus.isVisible(), 5000)) fail('the "+" of a connected section\'s head does not show under the pointer');

  // the words are the server list's: the Servers dialog says the same of each entry. Words with a colon ("Too old: update the
  // server on that machine") are split by the section: its narrow head has what stands before the colon, a line of its body the rest
  await press(page, byTid(page, "servers-btn").first());
  await byTid(page, "servers-row").first().waitFor();
  const listed = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid="servers-row"]')].map((r) => [r.querySelector('[data-testid="servers-name"]').textContent, r.querySelector('[data-testid="servers-state"]').textContent])));
  for (const [id, name] of [["s_studio", "Studio Mac"], ["s_wait", "Slow link"], ["s_away", "Attic server"], ["s_old", "Old Mini"], ["s_cert", "Cert box"]]) {
    const seen = await sideSeen(page, id), said = seen.state, [h, rest] = listed[name].split(": ");
    if (h !== said) fail(`the section of ${name} says "${said}", the Servers dialog "${listed[name]}"`);
    if (rest && !seen.lines.some((l) => l.toLowerCase() === `${rest}.`.toLowerCase())) fail(`the section of ${name} does not say the rest of the dialog's words ("${rest}"): ${J(seen.lines)}`);
  }
  await page.keyboard.press("Escape");
  await until(async () => !await byTid(page, "servers-dialog").count(), 10000);

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
  if (await section(page, "s_studio").locator('[data-testid="side-row"], [data-testid="side-group"]').count()) fail("a section whose server dropped still draws a row or a group");
  await set("s_studio", "too_old", { version: "0.8.0" });
  await shows("Studio Mac too old", "s_studio", { state: "Too old", tone: "bad", outline: [], lines: ["Update the server on that machine.", "Version 0.8.0"], add: false });
  await set("s_studio", "connected");
  await shows("Studio Mac back", "s_studio", { state: "Connected", tone: "ok", outline: TREE, lines: [], add: true });

  // ---- connected, and all it holds is archived: it has something on it, and the section does not say that it has nothing; "Show archived" is one switch
  // for every section: its row shows (marked archived) and the line goes (web/test/sidebar.test.ts, A-SC-08)
  const ARCHIVED_ONLY = "Only archived things on this server.";
  await mockEval('const r = await elsewhere("s_empty", "POST", "/chats", {}); await elsewhere("s_empty", "POST", `/chats/${r.body.id}/archive`);', url);
  await shows("everything on the server is archived", "s_empty", { state: "Connected", tone: "ok", outline: [], lines: [ARCHIVED_ONLY], add: true });
  const archivedSwitch = page.locator('[data-testid="side"] [role="switch"]').first();
  await press(page, archivedSwitch);
  await shows("Show archived on", "s_empty", { outline: ["chat New chat [archived]"], lines: [] });
  await press(page, archivedSwitch);
  await shows("Show archived off again", "s_empty", { outline: [], lines: [ARCHIVED_ONLY] });

  // ---- a reload during an outage: nothing of that server is known
  await set("s_studio", "unreachable", { detail: "connection refused" });
  await shows("Studio Mac dropped again", "s_studio", { outline: [], lines: [AWAY] });
  await page.reload(); await byTid(page, "side-section").first().waitFor({ state: "attached", timeout: 15000 });
  await shows("after a reload during the outage", "s_studio", { state: "Unreachable", tone: "bad", outline: [], lines: [AWAY], add: false });
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => /s_studio/.test(k + localStorage.getItem(k))));
  if (kept.length) fail(`the app's storage names Studio Mac after the reload: ${J(kept)}`);

  note(`connecting, connected and empty, connected with only archived things (the line, and Show archived), connected with its tree of ${TREE.length} rows, not connected, too old with its version, ${Object.keys(WORDS).length} states that wait: the list's words, rows only with a tree, the "+" only with one`);
}, { viewports, page: false });
