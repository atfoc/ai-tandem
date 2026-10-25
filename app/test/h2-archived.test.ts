// Settings › Archived's list (H2 chunk 4): which archived things show, under which head, with which sub-line.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Board, Catalog, ChatView, Group } from "@aiwb/core/types.ts";

import { archivedCount, archivedSections } from "../src/screens/home/archivedmodel.ts";
import type { PlaceInput } from "../src/screens/home/model.ts";

const group = (id: string, name: string, parent?: string, o: object = {}): Group => ({ id, name, ...(parent ? { parent } : {}), ...o }) as Group;
const board = (id: string, name: string, g = "__ungrouped__", o: object = {}): Board => ({ id, name, group: g, created: "2026-01-01T00:00:00Z", ...o }) as Board;
let n = 0;
const chat = (id: string, o: Partial<ChatView> = {}): ChatView =>
  ({ id, agent: "claude", name: id, cwd: "/w", model: "opus", effort: "high", locked: true, created: `2026-01-01T00:00:${String(++n).padStart(2, "0")}Z`, status: "ready", ...o }) as ChatView;
const by = <T extends { id: string }>(...xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));
const catalogs = { claude: { models: [{ id: "opus", label: "Opus 5.5", efforts: ["low", "high"] }] } as unknown as Catalog };
const arch = (op: string) => ({ archived: true, archiveOp: op });
const input = (groups: Group[], boards: Board[], chats: ChatView[], extra: Partial<PlaceInput> = {}): PlaceInput => ({ groups, boards: by(...boards), chats: by(...chats), catalogs, ...extra });
const names = (s: { items: { name: string }[] }[]) => s.map((x) => x.items.map((i) => i.name));

test("nothing archived: no sections", () => {
  assert.deepEqual(archivedSections(input([group("G", "G")], [board("B", "B")], [chat("C")]), "local"), []);
});

test("sections: ungrouped first, then groups in tree order, headed by the path in upper case", () => {
  const groups = [group("G_infra", "Infra"), group("G_co", "Checkout service"), group("G_pay", "Payments", "G_co")];
  const s = archivedSections(input(groups, [board("B1", "Sketch", "G_co", arch("a"))], [
    chat("C_loose", { ...arch("b") }), chat("C_pay", { group: "G_pay", ...arch("c") }), chat("C_infra", { group: "G_infra", ...arch("d") }),
  ]), "local");
  assert.deepEqual(s.map((x) => x.heading), ["", "INFRA", "CHECKOUT SERVICE", "CHECKOUT SERVICE › PAYMENTS"]);
  assert.deepEqual(s.map((x) => x.group), ["", "G_infra", "G_co", "G_pay"]);
  assert.deepEqual(names(s), [["C_loose"], ["C_infra"], ["Sketch"], ["C_pay"]]);
  assert.equal(archivedCount(s), 4);
});

test("an archived group lists once, with what comes back with it counted, and hides those things", () => {
  const groups = [group("G", "Old", undefined, arch("op1")), group("G_in", "Inner", "G", arch("op1"))];
  const boards = [board("B_in", "Inside", "G", arch("op1")), board("B_other", "Earlier", "G", arch("op0"))];
  const chats = [chat("C_in", { group: "G", ...arch("op1") }), chat("C_on", { board: "B_in", ...arch("op1") })];
  const s = archivedSections(input(groups, boards, chats), "local");
  // "Earlier" was archived on its own before the group: it is its own row, under no head (its group is archived)
  assert.deepEqual(names(s), [["Old", "Earlier"]]);
  assert.equal(s[0].items[0].kind, "group");
  assert.equal(s[0].items[0].sub, "1 board · 1 group · 1 chat");
});

test("a board archived with its chats lists once; a chat archived before it lists on its own", () => {
  const b = board("B", "Sketch", "__ungrouped__", arch("x"));
  const s = archivedSections(input([], [b], [chat("C_with", { board: "B", ...arch("x") }), chat("C_early", { board: "B", ...arch("w") })]), "local");
  assert.deepEqual(names(s), [["Sketch", "C_early"]]);
  assert.equal(s[0].items[0].sub, "Whiteboard · 2 chats");
});

test("a chat's sub is its model line, with no date; things of another server or gone are left out", () => {
  const s = archivedSections(input([], [], [chat("C", arch("a")), chat("srv~D", arch("b")), chat("E", arch("c"))], { gone: { E: true } }), "local");
  assert.equal(s[0].items[0].sub, "Opus 5.5 · High");
  assert.equal(archivedCount(s), 1);
  assert.equal(archivedSections(input([], [], [chat("srv~D", arch("b"))]), "srv")[0].items[0].server, "srv");
});

test("an archived ancestor is not a head; unarchived ones above it are", () => {
  const groups = [group("G1", "Top"), group("G2", "Mid", "G1", arch("m")), group("G3", "Low", "G2")];
  const s = archivedSections(input(groups, [], [chat("C", { group: "G3", ...arch("c") })]), "local");
  assert.deepEqual(s.map((x) => x.heading), ["TOP", "TOP › LOW"]); // (Mid is a row of its own under Top)
  assert.deepEqual(names(s), [["Mid"], ["C"]]);
});
