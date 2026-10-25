// X1 (goal 3.5): on the phone a drag down on the thread lowers the keyboard, and a tap on a button in the thread still works while it is up.
// A browser cannot show the keyboard, so this reads the source: both scroll views of the thread (StickyList's LegendList and the short thread's
// ScrollView) take the props on the phone only; the device run is in the lead's list of final device checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, "../src/screens/chat", rel), "utf8");
const sticky = read("StickyList.tsx"), thread = read("Thread.tsx");

test("the shared props: interactive on iOS, on-drag elsewhere, and a tap on a button still works", () => {
  assert.match(sticky, /export const THREAD_KEYBOARD = \{[^}]*keyboardDismissMode: Platform\.OS === "ios" \? "interactive" : "on-drag"/);
  assert.match(sticky, /THREAD_KEYBOARD = \{[^}]*keyboardShouldPersistTaps: "handled"/);
});

test("the long thread's list takes them when `latest`, which only the phone sets", () => {
  assert.match(sticky, /<LegendList[\s\S]*?\{\.\.\.\(latest \? THREAD_KEYBOARD : undefined\)\}/);
  assert.match(thread, /<StickyList[^>]*latest=\{phone\}/);
});

test("the short thread's ScrollView takes them on the phone only", () => {
  assert.match(thread, /import \{ StickyList, THREAD_KEYBOARD,/);
  assert.match(thread, /<ScrollView \{\.\.\.tid\("thread-scroll"\)\} \{\.\.\.\(phone \? THREAD_KEYBOARD : undefined\)\}/);
});
