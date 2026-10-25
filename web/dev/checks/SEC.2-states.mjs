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
// The phone (package H1) has no sections: each server's state is what its Home shows (plans/ux-improvements/h1-design.md §4), proved by
// `onPhone` below: connecting, the placeholders and "+ New" off; connected and empty, the empty Home; with a tree, its top level and a group's
// screen; not connected, too old, a changed certificate and every other state, the problem card with the words of the state (the reason of the
// states folded into Unreachable) and no list; no card draws this computer's Restart server or Open server log; connected before its tree,
// still connecting; a server that drops keeps its last list faded under the card, and is whole again when back; everything archived is the
// empty Home (archived things are Settings › Archived's, package H2); a reload during an outage leaves the card alone. The sidebar's "+" and
// the comparison with the Servers dialog's words are the wide layouts' (Home's words are the state words of statewords.ts).
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, press, showHome, touchNow } from "./sel.mjs";
import { homeOf, section, sectionHead, sideSeen } from "./side.mjs";

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

await check("SEC.2 a section in each state of its server", async ({ url, open, fail, note, layout }) => {
  if (layout === "phone") return onPhone({ url, open, fail, note });
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

/** The phone's half: each state on that server's Home (see the head of the file). */
async function onPhone({ url, open, fail, note }) {
  // Studio Mac's top level and its group Renders as Home and the group's screen list them (groups, then boards, then chats; a board's chats
  // are on its screen)
  const TOP = ["group Renders", "group Old takes", "board Floor plan", "chat Scratch", "chat Render queue is stuck"];
  const RENDERS = ["group Nightly", "board Storyboard", "chat Queue order"];
  await seed(url, "SEC");
  const { page } = await open({ wait: '[data-testid="home"]' });
  const set = (id, state, o = {}) => mockEval(`return setServerState(${J(id)}, ${J(state)}, ${J(o)});`, url);
  const shows = async (name, id, want) => {
    await showHome(page, id);
    const ok = (s) => Object.entries(want).every(([k, v]) => (typeof v === "function" ? v(s[k]) : J(s[k]) === J(v)));
    if (!await until(async () => ok(await homeOf(page)), 10000)) { const s = await homeOf(page); fail(`${name}: Home shows ${J(Object.fromEntries(Object.keys(want).map((k) => [k, s[k]])))}`); }
  };
  const says = (...parts) => (card) => !!card && parts.every((p) => card.text.includes(p));

  // ---- each state as the seed has it
  await shows("connecting", "s_wait", { state: "connecting", word: "connecting", rows: [], placeholders: 5, newEnabled: false, card: null });
  await shows("connected, nothing on the server", "s_empty", { state: "empty", word: "connected", rows: [], empty: true, newEnabled: true, card: null });
  await shows("connected, with a tree", "s_studio", { state: "list", word: "connected", outline: TOP, newEnabled: true, card: null });
  await shows("not connected", "s_away", { state: "trouble", word: "unreachable", rows: [], newEnabled: false, card: says("Attic server", "Unreachable", "Can't reach Attic server.") });
  await shows("too old", "s_old", { state: "trouble", word: "too-old", rows: [], newEnabled: false, card: says("Old Mini", "Too old", "version 0.9.1", "Update the server on that computer.") });
  await shows("a changed certificate", "s_cert", { state: "trouble", word: "cert-changed", rows: [], newEnabled: false, card: says("Cert box's certificate changed.") });
  if (!await byTid(page, "problem-review").count()) fail("the card of a changed certificate has no Review");

  // the notice's buttons of this computer (Restart server, Open server log) are on no other server's card
  for (const id of ["s_away", "s_old", "s_cert"]) {
    await showHome(page, id);
    if (await byTid(page, "problem-restart").count() + await byTid(page, "problem-log").count()) fail(`the card of ${id} draws this computer's Restart server or Open server log`);
  }

  // the tree is that server's, its groups pushed as screens (a group its own page shows collapsed is a screen like any other)
  await showHome(page, "s_studio");
  await press(page, byTid(page, "home-row", { kind: "group", key: "s_studio~g_shop" }).first());
  if (!await until(async () => J((await homeOf(page, "s_studio~g_shop")).outline) === J(RENDERS), 10000)) fail(`the group Renders' screen lists ${J((await homeOf(page, "s_studio~g_shop")).outline)}, not ${J(RENDERS)}`);
  const place = (await homeOf(page, "s_studio~g_shop")).place;
  if (!/^Studio Mac\b/.test(place)) fail(`the group's place line does not start with its server: "${place}"`);

  // ---- every other state of the list: the word Unreachable with the state's own words as its reason, or its own word; no list
  const FOLDED = { secret_not_accepted: 1, fingerprint_not_accepted: 1, certificate_not_accepted: 1, name_not_known: 1, not_aiwb: 1, another_server: 1 };
  for (const [state, words] of Object.entries(WORDS)) {
    await set("s_cert", state);
    const word = state === "certificate_changed" ? "cert-changed" : "unreachable";
    await shows(`the state ${state}`, "s_cert", { state: "trouble", word, rows: [], card: says(...(FOLDED[state] ? [words] : [])) });
  }

  // ---- connected, the tree not here yet: still connecting; then the tree; then connecting again
  await set("s_wait", "connected", { tree: false });
  await shows("connected before its tree came", "s_wait", { state: "connecting", placeholders: 5, newEnabled: false });
  await set("s_wait", "connected");
  await shows("its tree came", "s_wait", { state: "empty", word: "connected", empty: true, newEnabled: true });
  await set("s_wait", "connecting");
  await shows("connecting again", "s_wait", { state: "connecting", placeholders: 5 });

  // ---- a server whose Home was drawn drops: the card, and its last list faded under it; too old; back
  await showHome(page, "s_studio");
  await set("s_studio", "unreachable", { detail: "connection refused" });
  await shows("Studio Mac dropped", "s_studio", { state: "trouble", word: "unreachable", stale: true, outline: TOP, card: says("Can't reach Studio Mac.") });
  await set("s_studio", "too_old", { version: "0.8.0" });
  await shows("Studio Mac too old", "s_studio", { state: "trouble", word: "too-old", card: says("version 0.8.0") });
  await set("s_studio", "connected");
  await shows("Studio Mac back", "s_studio", { state: "list", word: "connected", stale: false, outline: TOP, card: null });

  // ---- connected, and all it holds is archived: the empty Home
  await mockEval('const r = await elsewhere("s_empty", "POST", "/chats", {}); await elsewhere("s_empty", "POST", `/chats/${r.body.id}/archive`);', url);
  await shows("everything on the server is archived", "s_empty", { state: "empty", rows: [] });

  // ---- a reload during an outage: nothing of that server is known, the card alone
  await set("s_studio", "unreachable", { detail: "connection refused" });
  await shows("Studio Mac dropped again", "s_studio", { state: "trouble" });
  await page.reload(); await byTid(page, "home").first().waitFor({ state: "attached", timeout: 15000 });
  await shows("after a reload during the outage", "s_studio", { state: "trouble", word: "unreachable", rows: [], stale: false, card: says("Can't reach Studio Mac.") });
  // (the saved place of Home, "aiwb.home", names the server it shows by design: h1-design.md §2)
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k !== "aiwb.home" && /s_studio/.test(k + localStorage.getItem(k))));
  if (kept.length) fail(`the app's storage names Studio Mac after the reload: ${J(kept)}`);

  note(`connecting (placeholders), empty, the tree (Home and a group's screen), the card for not connected, too old, a changed certificate and ${Object.keys(WORDS).length} other states, the last list faded while away, the card alone after a reload`);
}
