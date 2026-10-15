// What the chip input holds at each Mark of maestro/composer-chips-gallery.yaml (package K2's assertions, once in app/e2e/chips.mjs, run by package V3's
// runner): each `mark` made the gallery post the box's state, in order, and `sent` is what its Send posted. `verify` answers the list of what
// did not hold.
import { serialize } from "@aiwb/core/logic/refs.ts";
import { chipText } from "../../src/platform/chipinput/chipdoc.ts";
import { MENTION, POINT, SELECTIONS } from "../../src/dev/chipdocfixtures.ts";

export const checks = {};

export async function verify({ posts, platform }) {
  const IOS = platform === "ios";
  const problems = [];
  const T = {
    ok(cond, what, detail = "") { if (!cond) problems.push(`${what}${detail ? ` (${detail})` : ""}`); },
    eq(actual, expected, what) { this.ok(actual === expected, what, `expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`); },
  };
  const marks = posts.filter((p) => p.mark !== undefined).map((p) => p.state);
  const sent = posts.filter((p) => p.sent !== undefined).map((p) => p.sent);
  const A = SELECTIONS[0](), B = SELECTIONS[1](), P = POINT();
  const message = (...segs) => serialize(segs);
  const c = chipText(A);
  const inside = (m) => m.chips.some(([s, e]) => [m.selection.start, m.selection.end].some((p) => p > s && p < e));
  const m = (i) => marks[i] ?? { value: "(no mark)", chips: [], selection: { start: -1, end: -1 }, text: "", before: "" };
  const want = IOS ? 23 : 25;
  T.eq(marks.length, want, `all ${want} marks were posted`);

  // the spike's 18 (spikes/composer/checks/ios.mjs), AD-83's composer-chips
  T.eq(m(0).value, message("move ", A, " to"), "insert at the caret, type after it: the value is refs.ts' serialize");
  T.ok(m(0).text === `move ${c} to`, "the field shows the chip as its label between no-break spaces", JSON.stringify(m(0).text));
  T.ok(!inside(m(1)), "a tap in the left half of the chip: the caret is not inside it", JSON.stringify(m(1).selection));
  T.eq(m(1).selection.start, m(1).chips[0]?.[0], "…it is at the chip's start");
  T.eq(m(2).value, message("move X", A, " to"), "typing there goes before the chip");
  T.eq(m(3).value, message("move ", A, " to"), "backspace removes the typed X, not the chip");
  T.ok(!inside(m(4)), "a tap in the right half of the chip: the caret is not inside it", JSON.stringify(m(4).selection));
  T.eq(m(4).selection.start, m(4).chips[0]?.[1], "…it is at the chip's end");
  T.eq(m(5).value, message("move ", A, "Y to"), "typing there goes after the chip");
  T.eq(m(6).value, message("a ", A, " "), "chip inserted after 'a': spaces around it");
  T.eq(m(7).value, message("a ", A), "backspace removes the space after the chip");
  T.eq(m(8).value, "a ", "one backspace more removes the whole chip");
  T.ok(m(8).chips.length === 0, "the field holds no chip any more");
  T.ok(m(9).selection.start === m(9).chips[0]?.[0] && m(9).selection.end === m(9).chips[0]?.[1], "a double tap in a chip selects the chip whole", JSON.stringify([m(9).selection, m(9).chips]));
  T.eq(m(10).value, "ab Z cd", "typing over the selected chip replaces it");
  T.ok(m(12).height > m(11).height + 15, "the box grows with its lines", `${m(11).height} -> ${m(12).height}`);
  T.ok(m(13).height > m(12).height && m(13).height < 200, "…and stops growing at its maximum height", `${m(12).height} -> ${m(13).height}`);
  T.ok(m(13).value.startsWith("one\ntwo\nthree\n"), "line breaks are in the value");
  T.eq(m(14).value, message("move ", A, " to ", B, " and keep ", P, " \nthanks"), "the value of 2 selections, a point and a line break equals refs.ts'");
  T.eq(sent[0], message("move ", A, " to ", B, " and keep ", P, " \nthanks").trim(), "what is sent is the trimmed value");
  T.eq(m(15).value, "", "the box is empty after the send");
  T.eq(m(16).value, message("ab ", A, " cd"), "a chip selected and copied: the box is as it was");
  T.eq(m(17).value, message("ab ", A, " cd", A), "pasted into the box it comes back as a chip (the clipboard holds the label, the box knows it)");
  T.ok(m(17).chips.length === 2, "…and the field holds two chips");
  // the rest of the contract (AD-60) on the device
  T.eq(sent[1], "hi", "Enter handled by the owner (enter-sends): the value is sent");
  T.eq(m(18).value, "x", "…the box was emptied and its field kept no line break (what is typed next is alone)");
  T.eq(m(19).value, message("ab ", A, " "), "read-only: typing into the box changes nothing");
  T.eq(m(20).value, `ask ${MENTION.done}`, "replaceBeforeCaret completes the @ mention being typed");
  T.eq(m(20).before, `ask ${MENTION.done}`, "…and the text before the caret follows");
  T.eq(m(21).before, "", "right after a chip the text before the caret is empty (no @ list)");
  T.eq(m(22).value, message("ab ", A, " cd", A), "a read-only box's chip can be selected and copied (C-RF-25): pasted, it is a chip");
  if (!IOS) {
    T.eq(m(23).value, message(A, " work "), "Gboard: a suggestion picked for the word typed right after a chip takes the word's place, the chip stays");
    const typed = m(24).value.startsWith(message(A, " work ")) ? m(24).value.slice(message(A, " work ").length) : m(24).value;
    T.ok(/^(teh|the) $/.test(typed) && m(24).chips.length === 1, `Gboard: a misspelling and the space bar give "${typed.trim()}" (${typed.startsWith("the") ? "corrected" : "not corrected by this keyboard"}), nothing doubled or lost`, JSON.stringify(m(24).value));
  }
  return problems;
}
