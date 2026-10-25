// What the composer's chip input must hold at each step of maestro/composer-chips.yaml (package V3), and what the server and the whole run say
// at the end. The box's state is what the app reports after every change (src/dev/chipreport.ts, ChipDocInput's DocState): its shown `text` (a chip
// as its label between no-break spaces), the `chips` as [start, end] in that text, the `selection` in it, and the `value`, the text with each
// chip as its inline tag (logic/refs.ts). `checks` are called by the flow through the control API and waited for; `verify` runs once at the end.
import { parseRefs } from "@aiwb/core/logic/refs.ts";

const RECT = { ids: ["chips-rect"], label: "rectangle “API”" }; // what the board's rectangle (lib/scenes.mjs) gives
const REF = Symbol("ref");
const isRef = (x) => typeof x === "object" && x.kind === "selection" && x.ids.join() === RECT.ids.join() && x.label === RECT.label;
const say = (v) => JSON.stringify(v);

/** The value is these texts and the selection's reference, in order (REF stands for the reference). */
const value = (...want) => (box) => {
  const got = parseRefs(box.value);
  return got.length === want.length && want.every((w, i) => (w === REF ? isRef(got[i]) : got[i] === w)) && (want.includes(REF) ? box.chips.length === 1 : box.chips.length === 0)
    || `the value is ${say(box.value)}, not ${say(want.map((w) => (w === REF ? "<selection chips-rect>" : w)))}`;
};
const collapsed = (box) => box.selection.start === box.selection.end;
const inside = (box, p) => box.chips.some(([s, e]) => p > s && p < e);
const caretAt = (edge) => (box) => {
  const c = box.chips[0];
  if (!c) return "the box holds no chip";
  return (collapsed(box) && box.selection.start === c[edge]) || `the caret is ${say(box.selection)}, the chip ${say(c)}: it should be at its ${edge ? "end" : "start"}`;
};

export const checks = {
  // Move <chip> to
  inserted: (box) => value("Move ", REF, " to")(box) === true && collapsed(box) && box.selection.start === box.text.length || `not "Move <chip> to" with the caret at the end: ${say(box.value)}`,
  "caret-at-chip-start": caretAt(0),
  "x-before-chip": value("Move X", REF, " to"),
  "inserted-again": value("Move ", REF, " to"),
  "caret-at-chip-end": caretAt(1),
  "y-after-chip": value("Move ", REF, "Y to"),
  empty: value(),
  "a-chip-space": value("a ", REF, " "),
  "a-chip": value("a ", REF),
  "a-only": value("a "),
  "chip-selected": (box) => (box.chips.length === 1 && box.selection.start === box.chips[0][0] && box.selection.end === box.chips[0][1]) || `the chip is not selected whole: selection ${say(box.selection)}, chips ${say(box.chips)}`,
  "chip-replaced": value("ab Z cd"),
  "caret-at-an-edge": (box) => (collapsed(box) && box.chips.length === 1 && !inside(box, box.selection.start)) || `the caret is ${say(box.selection)}, chips ${say(box.chips)}`,
  message: value("Move ", REF, " to\nthanks"),
  // the phone (B2): the box holds the plain text, the reference is a chip beside it (what the app reports is the box's own text)
  "phone-plain": (box) => (box.text === "Move" && box.chips.length === 0) || `the phone's box should hold "Move" and no chip: ${say(box)}`,
};

/** The user messages of the chat named `name` on the scratch server, in order. */
async function sentOf(ctx, name) {
  const st = await ctx.api.call("GET", "/api/state");
  const chat = (st.json?.chats ?? []).find((c) => c.name === name);
  if (!chat) return { error: `the server has no chat ${name}` };
  const items = await ctx.api.call("GET", `/api/chats/${chat.id}/items`);
  return { chat: chat.id, sent: (items.json?.items ?? []).filter((i) => i.kind === "user").map((i) => i.text) };
}

// (the wide layouts type "Move " before the inline chip; the phone types "Move", adds the reference beside the box at that caret, then " to")
const SENT = [["Move ", REF, " to\nthanks"], ["Move", REF, " to\nthanks"]];
const sentIsRight = (text) => {
  const got = parseRefs(text);
  return SENT.some((want) => got.length === want.length && want.every((w, i) => (w === REF ? isRef(got[i]) : got[i] === w))) || `the server holds ${say(text)}`;
};

checks["server-has-message"] = Object.assign(async (_box, ctx) => {
  const r = await sentOf(ctx, "Chips-chat");
  if (r.error) return r.error;
  if (!r.sent.length) return "the server's thread of the chat holds no message of the user yet";
  return sentIsRight(r.sent[0]);
}, { noBox: true }); // (asks the server, not the box)

/** After the whole flow: no state the box reported has the caret or the selection's end inside a chip (what the box shows after it moves the
 *  caret out of one), and the server holds exactly the one message, with the tag. */
export async function verify({ posts, api, say: log }) {
  const problems = [];
  const states = posts.filter((p) => p.state && p.mark === undefined).map((p) => p.state);
  if (states.length < 10) problems.push(`the app reported only ${states.length} states of the box`); // (the phone's part types less than the wide one)
  const stuck = states.filter((b) => inside(b, b.selection.start) || inside(b, b.selection.end));
  if (stuck.length) problems.push(`${stuck.length} reported states have the caret inside a chip, the first: ${say(stuck[0])}`);
  log?.(`verify: ${states.length} states of the box (${posts.filter((p) => p.raw).length} selections the platform reported before the box moved them); ${stuck.length} with the caret inside a chip`);
  const r = await sentOf({ api }, "Chips-chat");
  if (r.error) problems.push(r.error);
  else if (r.sent.length !== 1) problems.push(`the server holds ${r.sent.length} messages of the user in the chat, not 1: ${say(r.sent)}`);
  else { const ok = sentIsRight(r.sent[0]); if (ok !== true) problems.push(ok); }
  return problems;
}
