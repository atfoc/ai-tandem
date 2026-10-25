// L8 (new in the app, package S4): a long chat stays smooth, and its thread keeps the place the user gave it while an answer streams
// (goal 4.8; parity rows B-SM-01, B-SM-06 to B-SM-09, B-SM-14, which nothing checked on the page: inventory finding 6).
//   - a chat of 300 turns opens at its end (B-SM-06), and only the rows near the window are drawn (the list is virtualized): a few dozen
//     messages are in the page, not 600;
//   - an answer that streams in, a paragraph at a time (and a fenced block that is not closed yet in the middle of it), is followed:
//     the thread stays at its end as it grows (B-SM-07), and a Markdown block that was finished is not parsed or drawn again (B-SM-02:
//     the counters of screens/markdown/parse.ts, which a build for the checks shows as `window.__aiwbMd`);
//   - the user scrolls up (past the 40 px of the end): the answer goes on growing under the window and the thread stays exactly where
//     it was put, the same message at the same place (B-SM-08); scrolled back to the end, it follows again;
//   - the window gets shorter (what the composer growing does to the thread): a thread that is at its end stays at its end (B-SM-09);
//   - another chat and back: the thread is at its end again (B-SM-06).
// The scroller is `thread-scroll` (its `dataSet.follows` says whether the thread follows its end now). Whether a finger or a wheel
// scrolls it follows the viewport; a scroll that did not move the thread is made by the scroller's own offset.
// Besides (B-SM-01): the answer being written is the one message marked as streaming, and none is once it is done.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, openChat, press, touchNow } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const TURNS = 300, FOLLOW = 40, CHUNKS = 36;
const WAIT = 15000;

/** In the mock: a chat of this many turns, each an answer of its own length (paragraphs, a list, a code block now and then). */
const SEED = `
  chats.c_long = chat("c_long", { name: "A long chat", group: "g_shop" });
  const list = [];
  for (let i = 1; i <= ${TURNS}; i++) {
    const paragraphs = Array.from({ length: 1 + (i % 4) }, (_, k) => "Answer " + i + ", part " + (k + 1) + ": the copy step runs once per build, and **" + (i * 7) + "** files are left to copy.");
    const extra = i % 5 === 0 ? "\\n\\n- first thing for " + i + "\\n- second thing\\n\\n\`\`\`js\\nconst turn = " + i + ";\\nconsole.log(turn);\\n\`\`\`" : "";
    list.push({ kind: "user", text: "Question " + i + ": why is it slow?" }, say(paragraphs.join("\\n\\n") + extra), { kind: "end" });
  }
  items.c_long = list;
  send({ type: "snapshot", ...snapshot() });
`;

/** In the mock: the chat is writing, and the answer at index \`at\` is this text (done: it is finished). */
const putText = (at, text, done = false) => `
  const list = items.c_long, item = { kind: "text", done: ${done}, text: ${JSON.stringify(text)} };
  list[${at}] = item;
  send({ type: "chat_items", chat: "c_long", branch: "main", version: (versions.c_long = (versions.c_long ?? 1) + 1), updates: [{ index: ${at}, item }] });
`;
const putUser = (at, text) => `
  const list = items.c_long, item = { kind: "user", text: ${JSON.stringify(text)} };
  list[${at}] = item;
  send({ type: "chat_items", chat: "c_long", branch: "main", version: (versions.c_long = (versions.c_long ?? 1) + 1), updates: [{ index: ${at}, item }] });
`;
const setStatus = (status) => `chats.c_long.status = ${JSON.stringify(status)}; send({ type: "chat", chat: chats.c_long });`;

/** The paragraphs of the streamed answer, and, in the middle, a fence that stays open for some chunks. */
const chunkText = (n) => {
  const parts = [];
  for (let i = 1; i <= n; i++) {
    if (i === 12) parts.push("```js\nconst streamed = true;");
    else if (i > 12 && i < 16) parts.push(`const line${i} = ${i};`);
    else if (i === 16) parts.push("```");
    else parts.push(`Streamed paragraph ${i}: ${"the answer keeps coming, and the thread follows it. ".repeat(2 + (i % 3))}`);
  }
  // (the lines of the fence are one block: they are joined by single line breaks, the paragraphs by blank lines)
  let out = "", fence = false;
  for (const p of parts) {
    out += (out ? (fence && !p.startsWith("```") ? "\n" : "\n\n") : "") + p;
    if (p.startsWith("```js")) fence = true; else if (p === "```") fence = false;
  }
  return out;
};

await check("L8 a long chat stays smooth, and the thread keeps its place while an answer streams", async ({ url, viewport, open, fail, note }) => {
  await seed(url, "A1");
  await mockEval(SEED, url);
  const { page } = await open({ sel: { chat: "c_long" }, wait: '[data-testid="chat-head"]' });
  const scroller = byTid(page, "thread-scroll").first();
  await scroller.waitFor({ state: "attached", timeout: WAIT });
  const touch = await touchNow(page);

  /** The scroller as the page has it now. */
  const read = () => scroller.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, view: el.clientHeight, follows: el.getAttribute("data-follows") }));
  const gap = async () => { const s = await read(); return s.height - s.top - s.view; };
  const atEnd = async (bound = WAIT) => !!await until(async () => (await gap()) < FOLLOW, bound);
  /** The first message in the window and where it is in it. */
  const anchor = () => scroller.evaluate((el) => {
    const box = el.getBoundingClientRect(), rows = [...document.querySelectorAll('[data-testid="msg"]')]
      .map((m) => ({ m, r: m.getBoundingClientRect() })).filter(({ r }) => r.bottom > box.top + 4 && r.top < box.bottom).sort((a, b) => a.r.top - b.r.top);
    return rows.length ? { text: rows[0].m.textContent.slice(0, 40), top: Math.round(rows[0].r.top - box.top) } : null;
  });
  const messages = () => byTid(page, "msg").count();
  /** Scrolls the thread by `dy` (negative: up) the way the viewport's pointer does; when that did not move it, by the scroller's own offset. */
  const scrollBy = async (dy) => {
    const before = (await read()).top, b = await scroller.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (touch) {
      const c = await page.context().newCDPSession(page);
      await c.send("Input.synthesizeScrollGesture", { x, y, yDistance: -dy, speed: 1500, gestureSourceType: "touch" }).catch(() => {});
      await c.detach();
    } else { await page.mouse.move(x, y); await page.mouse.wheel(0, dy); }
    if (!await until(async () => Math.abs((await read()).top - before) > 1, 1500)) await scroller.evaluate((el, d) => { el.scrollTop += d; }, dy);
    await until(async () => { const a = (await read()).top; await page.waitForTimeout(60); return a === (await read()).top; }, 3000); // (the scroll has stopped)
  };
  const stream = async (from, to, at) => { for (let n = from; n <= to; n++) await mockEval(putText(at, chunkText(n)), url); };
  const stats = () => page.evaluate(() => ({ ...window.__aiwbMd }));

  // ---- a long chat opens at its end, and draws only what is near the window
  if (!await atEnd()) fail(`${viewport}: the thread of a chat of ${TURNS} turns does not open at its end: ${JSON.stringify(await read())}`);
  if (!await until(async () => (await byTid(page, "msg").filter({ hasText: `Question ${TURNS}:` }).count()) > 0, WAIT)) fail(`${viewport}: the last message of the chat is not on screen`);
  const first = await read();
  if (first.height < 20 * first.view) fail(`${viewport}: the thread is ${first.height} px high over a window of ${first.view}: the seed is not a long chat`);
  if (await messages() > 80) fail(`${viewport}: ${await messages()} messages are in the page of a chat of ${TURNS * 2}: the list draws more than the rows near the window`);
  if (!(await stats()).parses) fail(`${viewport}: the build shows no counters of the Markdown (window.__aiwbMd): it is not made for the checks`);

  // ---- the answer streams in, and the thread follows it
  const at = TURNS * 3; // the next free place of the thread: a question, then its answer
  await mockEval(putUser(at, "Now stream an answer, please."), url);
  await mockEval(setStatus("writing") + putText(at + 1, "", false), url);
  if (!await atEnd()) fail(`${viewport}: a message arrived and the thread left its end: ${await gap()} px from it`);
  if (!await until(async () => (await byTid(page, "caret").count()) > 0, 5000)) fail(`${viewport}: an answer with no text yet shows no caret`);
  if (!await until(async () => (await byTid(page, "msg", { role: "assistant", streaming: "true" }).count()) === 1, 5000)) fail(`${viewport}: the answer being written is not the one message marked as streaming (${await byTid(page, "msg", { streaming: "true" }).count()} are)`); // (B-SM-01)
  const s0 = await stats();
  for (let n = 1; n <= CHUNKS / 2; n++) {
    await mockEval(putText(at + 1, chunkText(n)), url);
    if (!await atEnd(5000)) { fail(`${viewport}: while the answer streamed (chunk ${n}) the thread was ${await gap()} px from its end: it does not follow`); break; }
  }
  const s1 = await stats(), half = CHUNKS / 2;
  if (s1.parses - s0.parses > 3 * half + 6) fail(`${viewport}: ${half} chunks parsed ${s1.parses - s0.parses} Markdown blocks: a block that was finished is parsed again`);
  if (s1.renders - s0.renders > 3 * half + 6) fail(`${viewport}: ${half} chunks drew ${s1.renders - s0.renders} Markdown blocks: a block that was finished is drawn again`);
  if (await messages() > 80) fail(`${viewport}: ${await messages()} messages are in the page after the answer grew`);

  // ---- the user scrolls up: the thread stays where it was put, while the answer goes on
  await scrollBy(-900);
  // (the rows that came into the window are measured as they are drawn, which may move the offset by what their estimates were off: it is
  // taken once the window has stopped moving)
  let prior = "";
  await until(async () => { const now = JSON.stringify([(await read()).top, await anchor()]); const same = now === prior; prior = now; if (!same) await page.waitForTimeout(150); return same; }, 5000);
  const held = await read(), pin = await anchor();
  if (held.height - held.top - held.view < FOLLOW * 4) fail(`${viewport}: the scroll up left the thread ${held.height - held.top - held.view} px from its end: not scrolled up`);
  if (!await until(async () => (await read()).follows === "false", 3000)) fail(`${viewport}: scrolled up, the thread still says it follows its end`);
  await stream(CHUNKS / 2 + 1, CHUNKS - 6, at + 1);
  await page.waitForTimeout(300);
  const after = await read(), kept = await anchor();
  if (Math.abs(after.top - held.top) > 2) fail(`${viewport}: the user scrolled up and the thread moved by ${after.top - held.top} px (from ${held.top} to ${after.top}) as the answer streamed`);
  if (!pin || !kept || pin.text !== kept.text || Math.abs(pin.top - kept.top) > 2) fail(`${viewport}: the message the user was looking at moved: ${JSON.stringify(pin)} before, ${JSON.stringify(kept)} after`);
  // (the phone shows the "↓ Latest" pill when new text came while the person is scrolled up: it is the sign that there is more below)
  if (viewport === "phone" && !await until(async () => (await byTid(page, "thread-latest").count()) === 1, 3000)) fail(`${viewport}: scrolled up while the answer grew, the thread shows no Latest pill`);
  if (viewport !== "phone" && await byTid(page, "thread-latest").count()) fail(`${viewport}: the wide thread shows the phone's Latest pill`);
  if (after.height <= held.height + 50) fail(`${viewport}: the answer did not grow while the user was scrolled up (${held.height} to ${after.height} px): nothing was proved`);

  // ---- back to the end: it follows again
  await scrollBy(after.height);
  if (!await atEnd(5000)) fail(`${viewport}: scrolled back to the end, the thread is ${await gap()} px from it`);
  if (!await until(async () => (await read()).follows === "true", 3000)) fail(`${viewport}: scrolled back to the end, the thread does not say it follows`);
  if (await byTid(page, "thread-latest").count()) fail(`${viewport}: scrolled back to the end, the Latest pill is still there`);
  await stream(CHUNKS - 5, CHUNKS, at + 1);
  if (!await atEnd(5000)) fail(`${viewport}: scrolled back to the end, the thread did not follow the answer: ${await gap()} px from it`);
  await mockEval(putText(at + 1, chunkText(CHUNKS), true) + setStatus("ready") + `items.c_long[${at + 2}] = { kind: "end" };`, url);
  if (!await atEnd(5000)) fail(`${viewport}: when the answer was done the thread left its end: ${await gap()} px from it`);
  if (!await until(async () => (await byTid(page, "msg", { streaming: "true" }).count()) === 0, 5000)) fail(`${viewport}: when the answer was done a message is still marked as streaming`); // (B-SM-01)

  // ---- the window gets shorter: a thread at its end stays at its end
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.62) });
  if (!await atEnd(5000)) fail(`${viewport}: the window got shorter and the thread left its end: ${await gap()} px from it`);
  await page.setViewportSize(size);
  if (!await atEnd(5000)) fail(`${viewport}: the window got taller and the thread left its end: ${await gap()} px from it`);

  // ---- another chat, and back: the thread is at its end
  await openChat(page, "c_plain");
  if (!await until(async () => (await byTid(page, "msg").filter({ hasText: "Because of the font copy step." }).count()) > 0, WAIT)) fail(`${viewport}: the other chat's thread is not on screen`);
  await openChat(page, "c_long");
  if (!await atEnd()) fail(`${viewport}: the chat opened again is ${await gap()} px from its end: it does not open at its end`);
  if (!await until(async () => (await byTid(page, "msg").filter({ hasText: "Streamed paragraph" }).count()) > 0, WAIT)) fail(`${viewport}: the end of the chat opened again is not on screen`);
  note(`${TURNS} turns open at the end in a window of ${first.view} px with ${await messages()} messages drawn; ${CHUNKS / 2} chunks drew ${s1.renders - s0.renders} blocks; scrolled up the thread held ${held.top} → ${after.top} while it grew ${held.height} → ${after.height}`);
}, { viewports, page: false });
