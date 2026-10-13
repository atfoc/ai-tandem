// Putting a prompt's text into a composer's text box (plans/prompt-library.md, sections 5 and 10, lines 11 to 15), as
// far as it is decided without a page: the key, what the box holds afterwards (logic/insert.ts, which RefInput.tsx
// holds the page against), what goes on from there into the draft, and the place where the insert popup plugs in.
// The page's side (the caret, the focus, undo) is dev/checks/PL5.1-insert.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { insertKeyName, insertText, isInsertKey, lines, onInsertPopup, openInsertPopup, sameBox, type InsertTarget } from "../src/logic/insert.ts";
import { parseRefs, plainText, pointRef, selectionRef, serializeRef } from "../src/logic/refs.ts";
import { resolveMentions, type Picked } from "../src/logic/mentions.ts";
import { DraftSaver, draftOf } from "../src/logic/drafts.ts";
import type { Board, Draft } from "../src/types.ts";
import { UNGROUPED } from "../src/types.ts";

const MAC = "MacIntel", PC = "Win32";
const key = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }>) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, code: "KeyP", ...o });
/** A caret at the first `|` of a text, or a selection from the first to the second; the text without the marks. */
function marked(s: string) {
  const start = s.indexOf("|"), rest = s.slice(0, start) + s.slice(start + 1), second = rest.indexOf("|");
  return second < 0 ? { value: rest, at: { start, end: start } } : { value: rest.slice(0, second) + rest.slice(second + 1), at: { start, end: second } };
}
/** The box after `text` is put at the marks of `s`, with a `|` where the caret then is. */
const put = (s: string, text: string) => { const m = marked(s), r = insertText(m.value, m.at, text); return r.value.slice(0, r.caret) + "|" + r.value.slice(r.caret); };

const PROMPT = "Review this change.\n\n- name what is wrong\n- say why";

// ---- line 11: the key

test("⌘P on a Mac and Ctrl+P elsewhere, with nothing else held", () => {
  assert.equal(isInsertKey(key({ metaKey: true }), MAC), true);
  assert.equal(isInsertKey(key({ ctrlKey: true }), PC), true);
  assert.equal(isInsertKey(key({ ctrlKey: true }), "Linux x86_64"), true);
  // Ctrl+P on a Mac moves the caret a line up in a text field, and ⌘ is the Windows key elsewhere
  assert.equal(isInsertKey(key({ ctrlKey: true }), MAC), false);
  assert.equal(isInsertKey(key({ metaKey: true }), PC), false);
  for (const platform of [MAC, PC]) {
    const held = platform === MAC ? { metaKey: true } : { ctrlKey: true };
    assert.equal(isInsertKey(key({}), platform), false, "P alone is typed");
    assert.equal(isInsertKey(key({ ...held, shiftKey: true }), platform), false);
    assert.equal(isInsertKey(key({ ...held, altKey: true }), platform), false);
    assert.equal(isInsertKey(key({ metaKey: true, ctrlKey: true }), platform), false);
    assert.equal(isInsertKey(key({ ...held, code: "KeyL" }), platform), false);
  }
  assert.equal(insertKeyName(MAC), "⌘P");
  assert.equal(insertKeyName(PC), "Ctrl+P");
});

test("⌘P is the text box's own key, and the open insert popup's: nothing else in the page listens for it", () => {
  const src = new URL("../src/", import.meta.url);
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const withKey = files.filter((f) => /isInsertKey|KeyP\b/.test(readFileSync(new URL(f, src), "utf8"))).sort();
  assert.deepEqual(withKey, ["Library.tsx", "RefInput.tsx", "logic/insert.ts"]);
  const box = readFileSync(new URL("RefInput.tsx", src), "utf8");
  // the key is read in the handler of the box's own keydown, which stops it there and keeps the page from printing
  const onKey = box.slice(box.indexOf("const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {"), box.indexOf("onKeyDown(e);\n  };"));
  assert.ok(onKey.includes("if (isInsertKey(e, navigator.platform)) {\n      e.preventDefault(); e.stopPropagation();\n      openInsert();\n      return;"), onKey);
  assert.ok(box.includes("onKeyDown={onKey}"));
  // the popup takes the key only while it is open, wherever the focus is in it and however long the key is held: it
  // keeps the page from printing and does nothing else. With no popup open the key is the browser's outside a text box.
  const popup = readFileSync(new URL("Library.tsx", src), "utf8");
  assert.equal(popup.split("isInsertKey(").length - 1, 1);
  assert.ok(popup.includes("const k = (e: KeyboardEvent) => { if (getState().insertPopup && isInsertKey(e, navigator.platform)) { e.preventDefault(); e.stopPropagation(); } };\n    window.addEventListener(\"keydown\", k, true);"));
  assert.ok(!/addEventListener\("key/.test(box), "the box listens for no key of the window");
});

// ---- line 12: at the caret

test("in the middle of typed text: what was before and after is unchanged, the caret is after the text", () => {
  assert.equal(put("Hello | world", "there"), "Hello there| world");
  assert.equal(put("|Hello", "A "), "A |Hello");
  assert.equal(put("Hello|", " there"), "Hello there|");
  const before = "First, ", after = " Then stop.";
  const r = insertText(before + after, { start: before.length, end: before.length }, PROMPT);
  assert.equal(r.value, before + PROMPT + after);
  assert.equal(r.caret, (before + PROMPT).length);
  assert.equal(r.value.slice(0, before.length), before);
  assert.equal(r.value.slice(r.caret), after);
});

test("in place of a selection, whichever way it was made", () => {
  assert.equal(put("Hello |cruel| world", "kind"), "Hello kind| world");
  assert.equal(put("|all of it|", "new"), "new|");
  assert.equal(put("one\n|two\nthree|\nfour", "2\n3"), "one\n2\n3|\nfour");
  assert.deepEqual(insertText("Hello cruel world", { start: 11, end: 6 }, "kind"), { value: "Hello kind world", caret: 10 }); // selected backwards
  assert.equal(put("keep |this|", ""), "keep |"); // a prompt with no text takes the selection all the same
});

test("in an empty box", () => {
  assert.deepEqual(insertText("", { start: 0, end: 0 }, PROMPT), { value: PROMPT, caret: PROMPT.length });
  assert.deepEqual(insertText("", { start: 0, end: 0 }, ""), { value: "", caret: 0 });
});

test("line breaks are kept, and the text goes in exactly as it is", () => {
  assert.equal(put("a|b", "1\n2\n\n3\n"), "a1\n2\n\n3\n|b");
  assert.equal(put("line one\n|", PROMPT), "line one\n" + PROMPT + "|"); // on a new line of the box
  // a text saved with another system's line breaks has the box's
  assert.equal(lines("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(put("x|y", "a\r\nb"), "xa\nb|y");
  // nothing of it is read as markup, trimmed or escaped
  const odd = "  <b>bold</b> &amp; `code` **stars** [link](x)\ttab “quotes” 日本語 🙂  ";
  assert.equal(insertText("", { start: 0, end: 0 }, odd).value, odd);
  assert.equal(put("say: |", odd), "say: " + odd + "|");
});

test("a place that is not in the box is its nearest end", () => {
  assert.deepEqual(insertText("abc", { start: 99, end: 99 }, "X"), { value: "abcX", caret: 4 });
  assert.deepEqual(insertText("abc", { start: -5, end: 1 }, "X"), { value: "Xbc", caret: 1 });
});

test("the breaks that end the box are the browser's to keep: the rest is held to the letter", () => {
  assert.ok(sameBox("a\nb", "a\nb"));
  assert.ok(sameBox("a\nb", "a\nb\n")); // the break of an empty last line, dropped when the line got text
  assert.ok(sameBox("a\nb\n\n", "a\nb\n"));
  assert.ok(!sameBox("a\nb", "a\n\nb"));
  assert.ok(!sameBox("a b", "ab"));
  assert.ok(!sameBox("\na", "a"));
  assert.ok(!sameBox("a", "A"));
});

// ---- line 13: reference chips and mentions

const board = (id: string, name: string): Board => ({ id, name, group: UNGROUPED, created: "2026-09-01T00:00:00Z" });
const boards: Record<string, Board> = Object.fromEntries([board("b_arch0001", "arch"), board("b_flow0001", "flows"), board("b_flow0002", "flows")].map((b) => [b.id, b]));
const SEL = selectionRef([{ id: "a1", type: "rectangle", x: 10, y: 20, width: 160, height: 70, label: "API" }])!, POINT = pointRef(120, -40);
const refsOf = (value: string) => parseRefs(value).filter((s) => typeof s !== "string");

test("reference chips in the box are still there after an insertion, each where it was", () => {
  const value = `Look at ${serializeRef(SEL)} and ${serializeRef(POINT)} please`;
  for (const at of [0, "Look at ".length, value.indexOf(" and "), value.indexOf(" and ") + 5, value.indexOf(" please"), value.length]) {
    const r = insertText(value, { start: at, end: at }, PROMPT);
    assert.deepEqual(refsOf(r.value), [SEL, POINT], `at ${at}`);
    assert.equal(r.value.slice(0, at) + r.value.slice(r.caret), value, `at ${at}`);
  }
  // right before and right after a chip: the chip's tag is whole, and the text stands beside it
  const after = insertText(value, { start: value.indexOf(" and "), end: value.indexOf(" and ") }, "X");
  assert.equal(plainText(after.value), `Look at [${SEL.label}]X and [${POINT.label}] please`);
  // a selection takes the chips it holds with it, and no other
  const from = value.indexOf(" and "), to = value.indexOf(" please");
  assert.deepEqual(refsOf(insertText(value, { start: from, end: to }, "X").value), [SEL]);
});

test("mentions in the box still resolve after an insertion: the picked ones by their board, the typed ones by name", () => {
  const picked: Picked[] = [{ name: "flows", id: "b_flow0002" }];
  const value = "Compare @flows with @arch.";
  const was = resolveMentions(plainText(value), boards, picked).map((b) => b.id);
  assert.deepEqual(was, ["b_flow0002", "b_arch0001"]);
  for (const at of [0, "Compare ".length, "Compare @flows".length, value.length]) {
    const r = insertText(value, { start: at, end: at }, ` ${PROMPT} `); // (set off by spaces, as typed text would be: a name ends where its word does)
    assert.deepEqual(resolveMentions(plainText(r.value), boards, picked).map((b) => b.id), was, `at ${at}`);
  }
  // a prompt's own @name is a typed mention like any other
  assert.deepEqual(resolveMentions(plainText(insertText("", { start: 0, end: 0 }, "see @arch").value), boards, []).map((b) => b.id), ["b_arch0001"]);
});

// ---- line 14: the draft, and what is sent

test("the inserted text is in the draft, as typed text is, and a box filled from that draft holds it again", async () => {
  const picked: Picked[] = [{ name: "flows", id: "b_flow0002" }];
  const typed = `For @flows and ${serializeRef(SEL)}: `;
  const r = insertText(typed, { start: typed.length, end: typed.length }, PROMPT);
  assert.deepEqual(draftOf(r.value, picked), { text: typed + PROMPT, mentions: picked });
  const puts: Draft[] = [];
  const saver = new DraftSaver(async (d) => { puts.push(d); }, undefined, undefined, 5);
  saver.change(typed, picked);     // what the composer gives its saver as the box changes: before,
  saver.change(r.value, picked);   // and after the insertion
  await new Promise((ok) => setTimeout(ok, 30));
  assert.deepEqual(puts, [{ text: typed + PROMPT, mentions: picked }]);
  // after a reload the box is filled from the saved text: the same text, the same chip
  assert.deepEqual(parseRefs(puts[0].text), [`For @flows and `, SEL, ": " + PROMPT]);
  // and what a Send sends is the box's value, trimmed at its ends alone
  assert.equal(r.value.trim(), typed + PROMPT);
});

test("a later change to the prompt changes nothing in the box: what was inserted is a copy", () => {
  let text = "first wording";
  const r = insertText("", { start: 0, end: 0 }, text);
  text = "second wording";
  assert.equal(r.value, "first wording");
});

// ---- line 15, and the place where the popup plugs in

/** A text box's target that notes what it was told. */
const target = () => { const said: string[] = []; return { said, t: { insert: (text: string) => { said.push(`insert ${text}`); }, cancel: () => { said.push("cancel"); } } satisfies InsertTarget }; };

test("with no popup there, opening it leaves the box as it was", () => {
  const { said, t } = target();
  openInsertPopup(t);
  assert.deepEqual(said, ["cancel"]);
});

test("the popup gets the box's target, and tells it once what to do", () => {
  const got: InsertTarget[] = [];
  const off = onInsertPopup((t) => { got.push(t); });
  try {
    const a = target(), b = target();
    openInsertPopup(a.t);
    assert.deepEqual(a.said, [], "nothing is done to the box while the popup is open");
    got[0].insert(PROMPT); // Enter on the highlighted prompt
    assert.deepEqual(a.said, [`insert ${PROMPT}`]);
    openInsertPopup(b.t);
    got[1].cancel(); // Esc
    assert.deepEqual(b.said, ["cancel"]);
    assert.equal(got.length, 2);
  } finally { off(); }
  const c = target();
  openInsertPopup(c.t);
  assert.deepEqual(c.said, ["cancel"], "taken back, there is no popup again");
});

test("a popup taken back after another came does not take that one away", () => {
  const first: InsertTarget[] = [], second: InsertTarget[] = [];
  const offFirst = onInsertPopup((t) => { first.push(t); }), offSecond = onInsertPopup((t) => { second.push(t); });
  offFirst();
  openInsertPopup(target().t);
  offSecond();
  assert.deepEqual([first.length, second.length], [0, 1]);
});

test("the box holds the page against what insertText says, and the composer opens the popup from its toolbar", () => {
  const box = readFileSync(new URL("../src/RefInput.tsx", import.meta.url), "utf8");
  assert.ok(box.includes("const want = insertText(valueOf(b.el), { start: offsetOf(b.el, b.at.startContainer, b.at.startOffset), end: offsetOf(b.el, b.at.endContainer, b.at.endOffset) }, text);"));
  assert.ok(box.includes("if (!sameBox(valueOf(b.el), want.value)) { b.el.replaceChildren(...nodesOf(want.value)); place(caretAt(b.el, want.caret)); }"));
  const chat = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
  // (a chat's toolbar draws its button where its row has room for it, and has an entry in its "more" popup where the
  // row has that chip and no room: logic/composerfit.ts fitWithInsert, test/composerfit.test.ts)
  assert.ok(chat.includes("onInsert={() => input.current?.openInsert()}") && chat.includes('{insert === "row" && <InsertButton disabled={frozen} onClick={onInsert} />}'));
  assert.ok(chat.includes('{insert === "more" && (') && chat.includes("onClick={() => { setMore(false); onInsert(); }}"));
});
