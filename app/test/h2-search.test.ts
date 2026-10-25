// Home's search (H2 chunk 5): matching and sections (searchmodel.ts), the recent lists (recent.ts). The screen is the browser checks'.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, ChatView, Group } from "@aiwb/core/types.ts";

import type { PlaceInput } from "../src/screens/home/model.ts";
import { addOpened, addWords, parseOpened, parseWords, removeWord } from "../src/screens/home/recent.ts";
import { recentlyOpened, resultCount, searchPlace, splitName, staleSub } from "../src/screens/home/searchmodel.ts";

const group = (id: string, name: string, parent?: string, o: object = {}): Group => ({ id, name, ...(parent ? { parent } : {}), ...o }) as Group;
const board = (id: string, name: string, g = "__ungrouped__", o: object = {}): Board => ({ id, name, group: g, created: "2026-01-01T00:00:00Z", ...o }) as Board;
let n = 0;
const chat = (id: string, name: string, o: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", name, cwd: "/w", model: "opus", effort: "high", locked: true, created: `2026-01-01T00:00:${String(++n).padStart(2, "0")}Z`, status: "ready", ...o }) as ChatView;
const by = <T extends { id: string }>(...xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

const input = (): PlaceInput => ({
  groups: [group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co"), group("G_old", "Old checkout", undefined, { archived: true })],
  boards: by(board("B_flow", "Checkout flow", "G_co"), board("B_load", "Load test", "G_pay"), board("B_arch", "Checkout archive", "G_co", { archived: true }), board("B_in_old", "Old checkout board", "G_old", { archived: true })),
  chats: by(
    chat("C_audit", "Audit the checkout flow", { group: "G_co" }),
    chat("C_req", "Draw the request flow", { board: "B_flow" }),
    chat("C_loose", "Why did the build fail?"),
    chat("C_arch", "Checkout chat archived", { archived: true }),
    chat("C_gone", "Checkout gone"),
    chat("C_on_arch", "Checkout on an archived board", { board: "B_arch" }),
  ),
  gone: { C_gone: true },
});
const W = { server: "local", serverName: "Studio Mac" };
const names = (hs: { name: string }[]) => hs.map((h) => h.name);

test("splitName: the first match, any case; no match or an empty query is no bold part", () => {
  assert.deepEqual(splitName("Audit the Checkout flow", "checkout"), { before: "Audit the ", match: "Checkout", after: " flow" });
  assert.deepEqual(splitName("Checkout", "  CHECK "), { before: "", match: "Check", after: "out" });
  assert.deepEqual(splitName("Runner", "zz"), { before: "Runner", match: "", after: "" });
  assert.deepEqual(splitName("Runner", ""), { before: "Runner", match: "", after: "" });
  assert.deepEqual(splitName("a.b (c)", "(c)"), { before: "a.b ", match: "(c)", after: "" }, "the query is text, not a pattern");
});

test("results by kind, archived and gone things left out, names that start with the query first", () => {
  const r = searchPlace(input(), W, "check");
  assert.deepEqual(names(r.boards), ["Checkout flow"]);
  assert.deepEqual(names(r.chats), ["Audit the checkout flow"]);
  assert.deepEqual(names(r.groups), ["Checkout service"]);
  assert.equal(resultCount(r), 3);
  const r2 = searchPlace(input(), W, "flow");
  assert.deepEqual(names(r2.chats), ["Draw the request flow", "Audit the checkout flow"], "newest first when neither starts with it");
});

test("a name that starts with the query comes before one that only holds it", () => {
  const i = input();
  i.boards = by(board("B1", "Old flow"), board("B2", "Flow chart"), board("B3", "A flow"));
  assert.deepEqual(names(searchPlace(i, W, "flow").boards), ["Flow chart", "A flow", "Old flow"]);
});

test("sub-lines: the place, a chat on a board 'on <board>', a group's items", () => {
  const r = searchPlace(input(), W, "o");
  const sub = (hs: { key: string; sub: string }[], k: string) => hs.find((h) => h.key === k)?.sub;
  assert.equal(sub(r.boards, "B_flow"), "Studio Mac › Checkout service");
  assert.equal(sub(r.boards, "B_load"), "Studio Mac › Checkout service › Payments");
  assert.equal(sub(r.chats, "C_req"), "Studio Mac › on Checkout flow");
  assert.equal(sub(r.chats, "C_audit"), "Studio Mac › Checkout service");
  assert.equal(searchPlace(input(), W, "build").chats[0]!.sub, "Studio Mac");
  assert.equal(sub(r.groups, "G_co"), "Studio Mac · 3 items", "Payments, Checkout flow, the audit chat (archived ones do not count)");
  assert.equal(searchPlace(input(), W, "pay").groups[0]!.sub, "Studio Mac › Checkout service · 1 item");
});

test("the keys a group hit opens: the chain down to itself; a board's and a chat's place", () => {
  const r = searchPlace(input(), W, "pay");
  assert.deepEqual(r.groups[0]!.groups, ["G_co", "G_pay"]);
  const p = searchPlace(input(), W, "load");
  assert.deepEqual(p.boards[0]!.groups, ["G_co", "G_pay"]);
  const c = searchPlace(input(), W, "request").chats[0]!;
  assert.deepEqual([c.board, c.groups], ["B_flow", ["G_co"]]);
});

test("scope: boards leave chats and groups out, chats leave boards and groups out", () => {
  const b = searchPlace(input(), W, "check", "boards"), c = searchPlace(input(), W, "check", "chats");
  assert.deepEqual([b.boards.length, b.chats.length, b.groups.length], [1, 0, 0]);
  assert.deepEqual([c.boards.length, c.chats.length, c.groups.length], [0, 1, 0]);
});

test("an empty or blank query finds nothing; a query that matches nothing finds nothing", () => {
  assert.equal(resultCount(searchPlace(input(), W, "")), 0);
  assert.equal(resultCount(searchPlace(input(), W, "   ")), 0);
  assert.equal(resultCount(searchPlace(input(), W, "kubernetes")), 0);
});

test("a server that is away: its hits are faded and say the server's word instead of the place", () => {
  const r = searchPlace(input(), { ...W, serverName: "Attic", staleWord: "Offline" }, "flow");
  assert.ok(r.boards.concat(r.chats).every((h) => h.stale && h.sub === "● Attic · Offline"));
  assert.equal(staleSub("Attic", "Offline"), "● Attic · Offline");
  assert.ok(searchPlace(input(), W, "flow").boards.every((h) => !h.stale));
});

test("a chat's own title is used when the input has one", () => {
  const i = input();
  i.titleOf = (c) => (c.id === "C_loose" ? "Kubernetes rollout" : c.name ?? c.id);
  assert.deepEqual(names(searchPlace(i, W, "kubernetes").chats), ["Kubernetes rollout"]);
});

test("only the server's own things are found", () => {
  const i = input();
  i.boards = { ...i.boards, "srv2~B_x": board("srv2~B_x", "Checkout elsewhere") };
  assert.deepEqual(names(searchPlace(i, W, "elsewhere").boards), []);
});

test("recently opened: what was opened, newest first, that the tree still has, at most five, with the place", () => {
  const opened = [{ key: "C_req", kind: "chat" as const }, { key: "B_gone", kind: "board" as const }, { key: "C_gone", kind: "chat" as const },
    { key: "B_load", kind: "board" as const }, { key: "C_arch", kind: "chat" as const }, { key: "C_loose", kind: "chat" as const }, { key: "B_flow", kind: "board" as const }];
  const r = recentlyOpened(input(), W, opened);
  assert.deepEqual(r.map((h) => h.key), ["C_req", "B_load", "C_loose", "B_flow"]);
  assert.deepEqual(r.map((h) => h.sub), ["Studio Mac › Checkout flow", "Studio Mac › Checkout service › Payments", "Studio Mac", "Studio Mac › Checkout service"]);
  assert.ok(r.every((h) => h.parts.match === ""));
  assert.equal(recentlyOpened(input(), W, opened, 2).length, 2);
});

test("recent searches: newest first, no word twice in any case, at most eight, blanks left out", () => {
  assert.deepEqual(addWords(["deploy", "checkout"], "Checkout"), ["Checkout", "deploy"]);
  assert.deepEqual(addWords([], "  ", "a", "b"), ["b", "a"]);
  assert.equal(addWords(["1", "2", "3", "4", "5", "6", "7", "8"], "9").length, 8);
  assert.equal(addWords(["1", "2", "3", "4", "5", "6", "7", "8"], "9")[0], "9");
  assert.deepEqual(removeWord(["Checkout", "deploy"], "checkout"), ["deploy"]);
  assert.deepEqual(parseWords('["b","a","B"]'), ["b", "a"], "read back as saved: newest first, a repeat dropped");
  assert.deepEqual(parseWords("nonsense"), []);
  assert.deepEqual(parseWords('{"a":1}'), []);
  assert.deepEqual(parseWords('["a",3,null]'), ["a"]);
});

test("recently opened list: newest first, a thing once, at most ten; a bad saved list is empty", () => {
  const l = addOpened([{ key: "a", kind: "board" }, { key: "b", kind: "chat" }], { key: "b", kind: "chat" });
  assert.deepEqual(l.map((o) => o.key), ["b", "a"]);
  let many = [] as ReturnType<typeof addOpened>;
  for (let i = 0; i < 12; i++) many = addOpened(many, { key: "k" + i, kind: "chat" });
  assert.equal(many.length, 10);
  assert.equal(many[0]!.key, "k11");
  assert.deepEqual(parseOpened('[{"key":"a","kind":"board"},{"key":"a","kind":"chat"},{"key":"","kind":"chat"},{"key":"c","kind":"x"},5]'), [{ key: "a", kind: "board" }]);
  assert.deepEqual(parseOpened("{"), []);
});
