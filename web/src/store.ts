// App state: one small store, read with useStore(selector). Scenes (element
// arrays) live outside it in board.ts `scenes`, because they change on every
// stroke and nothing but the canvas renders from them.
import { useSyncExternalStore } from "react";
import type { AgentKind, Board, Catalog, ChatView, Defaults, Draft, Group, Item, Status, Subagent } from "./types.ts";
import type { Snapshot } from "./api.ts";
import type { ConfirmRequest } from "./Dialogs.tsx";
import { forgetBoard } from "./board.ts";
import { plainText } from "./logic/refs.ts";
import { parseWidths, type Widths } from "./logic/layout.ts";
import { parseThemePref, resolveTheme, type Theme, type ThemePref } from "./logic/theme.ts";
import type { Unsaved } from "./logic/drafts.ts";

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
  items: Record<string, { version: number; items: Item[] }>; // by chat id, and subagent threads by subKey(chat, sid)
  subs: Record<string, Record<string, Subagent>>; // chat id → sid → the subagent's state (loaded with the chat's items)
  subDrawer: { chat: string; sub: string } | null; // the subagent open in the drawer (chat id, sid)
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog>>;
  sel: Sel;                       // persisted in localStorage "aiwb.sel"
  panel: boolean;                 // board chat panel shown (⌘J)
  widths: Widths;                 // sidebar and board chat panel, persisted in localStorage "aiwb.widths"
  showArchived: boolean;          // persisted in localStorage "aiwb.archived"
  themePref: ThemePref;           // light, dark or system; persisted in localStorage "aiwb.theme"
  theme: Theme;                   // the theme shown (theme.ts keeps it current)
  selection: Selection;
  view: View;
  flashes: Flash[];               // keyed by board id
  busyOn: Record<string, { chat: string; agent: AgentKind; until: number }>; // by board id
  confirm: ConfirmRequest | null; // Dialogs.tsx
  picking: string | null;         // chat id waiting for a point clicked on its board (⌘⇧L)
};

export function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
export function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch {} }
export function safeRemove(k: string) { try { localStorage.removeItem(k); } catch {} }

const systemDark = () => { try { return matchMedia("(prefers-color-scheme: dark)").matches; } catch { return false; } };
const savedTheme = parseThemePref(safeGet("aiwb.theme"));

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
  groups: [], boards: {}, chats: {}, items: {}, subs: {}, subDrawer: null,
  defaults: { last: {}, groups: {} }, catalogs: {},
  sel: savedSel(), panel: true, widths: parseWidths(safeGet("aiwb.widths")), showArchived: safeGet("aiwb.archived") === "1",
  themePref: savedTheme, theme: resolveTheme(savedTheme, systemDark()),
  selection: { count: 0, lines: [] }, view: { scrollX: 0, scrollY: 0, zoom: 1, width: 0, height: 0 },
  flashes: [], busyOn: {}, confirm: null, picking: null,
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
      subs: {},  // with them
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

/** Clears sel.chat, the chat's items, its subagents and their threads, the drawer on it, and its unsaved draft. */
export function removeChat(id: string) {
  unsavedDraft(id).write(null);
  setState((s) => {
    const { [id]: _, ...chats } = s.chats;
    const items = Object.fromEntries(Object.entries(s.items).filter(([k]) => k !== id && !k.startsWith(id + "/")));
    const { [id]: __, ...subs } = s.subs;
    const sel = s.sel.chat === id ? { board: s.sel.board, chat: null } : s.sel;
    if (sel !== s.sel) safeSet("aiwb.sel", JSON.stringify(sel));
    const subDrawer = s.subDrawer?.chat === id ? null : s.subDrawer;
    return { chats, items, subs, sel, subDrawer };
  });
}

/** Sets a subagent's state (the `sub` message). */
export function upsertSub(chat: string, sa: Subagent) {
  setState((s) => ({ subs: { ...s.subs, [chat]: { ...s.subs[chat], [sa.id]: sa } } }));
}

/** A chat's draft the server may not have yet, in localStorage "aiwb.draft.<chat>" (see logic/drafts.ts). */
export function unsavedDraft(chat: string): Unsaved {
  const k = "aiwb.draft." + chat;
  return {
    read(): Draft | null { try { const d = JSON.parse(safeGet(k) ?? "null"); return typeof d?.text === "string" ? d : null; } catch { return null; } },
    write(d: Draft | null) { if (d) safeSet(k, JSON.stringify(d)); else safeRemove(k); },
  };
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
  const t = plainText(first.text).replace(/\s+/g, " ").trim();
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
