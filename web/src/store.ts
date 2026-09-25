// App state: one small store, read with useStore(selector). Scenes (element
// arrays) live outside it in board.ts `scenes`, because they change on every
// stroke and nothing but the canvas renders from them.
import { useSyncExternalStore } from "react";
import type { AgentKind, Board, Catalog, ChatView, Defaults, Group, Item, Status } from "./types.ts";
import type { Snapshot } from "./api.ts";
import type { ConfirmRequest } from "./Dialogs.tsx";
import { forgetBoard } from "./board.ts";

export type Box = { x: number; y: number; width: number; height: number };
export type Flash = { id: number; board: string; box: Box; label: string; agent: AgentKind; tone: "edit" | "danger"; until: number };
export type Selection = { count: number; lines: string[] };
export type View = { scrollX: number; scrollY: number; zoom: number; width: number; height: number };

export type Sel = { board: string | null; chat: string | null }; // board id, chat id

export type State = {
  connected: boolean;
  role: "connecting" | "active" | "waiting" | "superseded";
  home: string; defaultCwd: string; dataDir: string;
  groups: Group[];
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;
  items: Record<string, { version: number; items: Item[] }>;
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog>>;
  sel: Sel;                       // persisted in localStorage "aiwb.sel"
  panel: boolean;                 // board chat panel shown (⌘J)
  showArchived: boolean;          // persisted in localStorage "aiwb.archived"
  selection: Selection;
  view: View;
  flashes: Flash[];               // keyed by board id
  busyOn: Record<string, { chat: string; agent: AgentKind; until: number }>; // by board id
  confirm: ConfirmRequest | null; // Dialogs.tsx
};

export function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }

const savedSel = (): Sel => {
  try {
    const v = JSON.parse(safeGet("aiwb.sel") ?? "");
    if (v && typeof v === "object") return { board: v.board ?? null, chat: v.chat ?? null };
  } catch {}
  return { board: null, chat: null };
};

let state: State = {
  connected: false, role: "connecting",
  home: "", defaultCwd: "", dataDir: "",
  groups: [], boards: {}, chats: {}, items: {},
  defaults: { last: {}, groups: {} }, catalogs: {},
  sel: savedSel(), panel: true, showArchived: safeGet("aiwb.archived") === "1",
  selection: { count: 0, lines: [] }, view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  flashes: [], busyOn: {}, confirm: null,
};
const subs = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  for (const f of subs) f();
}
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state));
}

const byId = <T extends { id: string }>(xs: T[] | null | undefined): Record<string, T> =>
  Object.fromEntries((xs ?? []).map((x) => [x.id, x]));

// ---- server state

/** Replaces everything the server owns; drops selections that no longer exist. */
export function applySnapshot(s: Snapshot) {
  const boards = byId(s.boards);
  const chats = byId(s.chats);
  const catalogs: Partial<Record<AgentKind, Catalog>> = {};
  for (const [k, v] of Object.entries(s.catalogs ?? {})) if (v) catalogs[k as AgentKind] = v;
  setState((st) => {
    const board = st.sel.board && boards[st.sel.board] ? st.sel.board : null;
    let chat = st.sel.chat && chats[st.sel.chat] ? st.sel.chat : null;
    if (chat && board && chats[chat].board !== board) chat = null;
    if (chat && !board && chats[chat].board) chat = null;
    const sel = { board, chat };
    safeSet("aiwb.sel", JSON.stringify(sel));
    const busyOn = Object.fromEntries(Object.entries(st.busyOn).filter(([k]) => boards[k]));
    return {
      groups: s.groups ?? [], boards, chats, catalogs,
      defaults: s.defaults ?? { last: {}, groups: {} },
      home: s.home ?? "", defaultCwd: s.defaultCwd ?? "", dataDir: s.dataDir ?? "",
      items: {}, // refetched when a chat is shown; updates missed while away are not replayed
      sel, busyOn,
    };
  });
  for (const id of Object.keys(boardsBefore)) if (!boards[id]) forgetBoard(id);
  boardsBefore = boards;
}
let boardsBefore: Record<string, Board> = {};

export function upsertBoard(b: Board) {
  setState((s) => ({ boards: { ...s.boards, [b.id]: b } }));
  boardsBefore = getState().boards;
}

/** Clears sel.board, the scene and busyOn for it. */
export function removeBoard(id: string) {
  forgetBoard(id);
  setState((s) => {
    const { [id]: _, ...boards } = s.boards;
    const { [id]: __, ...busyOn } = s.busyOn;
    const sel = s.sel.board === id ? { board: null, chat: null } : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    return { boards, busyOn, sel, flashes: s.flashes.filter((f) => f.board !== id) };
  });
  boardsBefore = getState().boards;
}

export function upsertChat(c: ChatView) {
  setState((s) => ({ chats: { ...s.chats, [c.id]: c } }));
}

/** Clears sel.chat and the chat's items. */
export function removeChat(id: string) {
  setState((s) => {
    const { [id]: _, ...chats } = s.chats;
    const { [id]: __, ...items } = s.items;
    const sel = s.sel.chat === id ? { board: s.sel.board, chat: null } : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    return { chats, items, sel };
  });
}

/** The chat a board reopens with, per board, in localStorage. */
export const lastChat = {
  read(): Record<string, string> { try { return JSON.parse(safeGet("aiwb.lastChat") ?? "{}") ?? {}; } catch { return {}; } },
  get(board: string): string | undefined { return this.read()[board]; },
  set(board: string, chat: string) { safeSet("aiwb.lastChat", JSON.stringify({ ...this.read(), [board]: chat })); },
};

// ---- chats

export const isBusy = (s: Status | undefined) => s === "thinking" || s === "writing" || s === "tool" || s === "approval";

/** The chat's name, or its first message until it is named. */
export function chatTitle(c: ChatView, items?: Item[]): string {
  if (c.name) return c.name;
  const first = items?.find((i) => i.kind === "user");
  if (!first?.text) return "New chat";
  const t = first.text.replace(/\s+/g, " ").trim();
  return t.length > 42 ? t.slice(0, 40) + "…" : t;
}

/** Board id → name, for tool labels. */
export const boardName = (id: string) => state.boards[id]?.name;

// ---- canvas feedback

let flashSeq = 0;
export function flash(f: Omit<Flash, "id" | "until">, ms = 2600) {
  const id = ++flashSeq;
  setState((s) => ({ flashes: [...s.flashes, { ...f, id, until: Date.now() + ms }] }));
  setTimeout(() => setState((s) => ({ flashes: s.flashes.filter((x) => x.id !== id) })), ms);
  return id;
}
export function unflash(id: number) { setState((s) => ({ flashes: s.flashes.filter((x) => x.id !== id) })); }

export function markBusy(board: string, chat: string) {
  const agent = state.chats[chat]?.agent ?? "claude";
  setState((s) => ({ busyOn: { ...s.busyOn, [board]: { chat, agent, until: Date.now() + 4000 } } }));
  setTimeout(() => setState((s) => {
    const b = s.busyOn[board];
    if (!b || b.until > Date.now()) return {};
    const { [board]: _, ...rest } = s.busyOn;
    return { busyOn: rest };
  }), 4100);
}
