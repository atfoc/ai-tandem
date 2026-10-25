// What the window shows, and the stack of screens the phone derives from it (AD-71). Pure: no React, no react-native, so Node
// loads it. The wide layouts draw `shellView` as one split view; the phone draws `stackOf` as a stack of screens, and a back sets the
// store (`select` with the chat or the board cleared) and Home's place rather than the stack (`planPopTo` says what).
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import type { Sel } from "@aiwb/core/logic/sel.ts";
import { LOCAL_SERVER, type Group } from "@aiwb/core/types.ts";

/** What the store holds of what is on screen. */
export type StackState = {
  sel: Sel;
  boards: Record<string, { id: string; name: string; group: string }>;
  chats: Record<string, { id: string; name?: string; group?: string; board?: string | null }>;
  /** This computer's groups, and each connected server's (by entry id); the groups' ids and parents are the page's keys. */
  groups: Pick<Group, "id" | "name" | "parent">[];
  sections: Record<string, { groups: Pick<Group, "id" | "name" | "parent">[] }>;
  subDrawer?: { chat: string } | null;
};

/** The view the selection gives (today's `Grouped`): a board (with one of its chats, when that chat is of the board), a plain chat,
 *  or Home. A selection of a thing the store does not hold is Home; so is a board's chat with no board selected. */
export type ShellView =
  | { kind: "board"; board: string; chat: string | null }
  | { kind: "chat"; chat: string }
  | { kind: "home" };

export function shellView(s: StackState): ShellView {
  const board = s.sel.board ? s.boards[s.sel.board] : undefined;
  const chat = s.sel.chat ? s.chats[s.sel.chat] : undefined;
  if (board) return { kind: "board", board: board.id, chat: chat && chat.board === board.id ? chat.id : null };
  if (chat && !chat.board) return { kind: "chat", chat: chat.id };
  return { kind: "home" };
}

/** A place screen has a back naming the screen under it and a centred title; a content screen has the chevron alone. */
export type ScreenKind = "place" | "content";

/** What Home shows: the selected server (one at a time, goal 3.2; its entry id as `serverOfKey` gives it, `LOCAL_SERVER` for this
 *  computer; null = not chosen yet) and the groups pushed over it, outermost first. Saved in the kv as "aiwb.home" (homeplace.ts). */
export type HomePlace = { server: string | null; groups: string[] };

export const NO_PLACE: HomePlace = { server: null, groups: [] };

/** One screen of the whole stack, bottom first: what the back's label and the hold sheet show. `id` is the key of the group, board or
 *  chat the entry stands for (a pushed entry: its own key). */
export type StackEntry = { key: string; name: string; title: string; kind: ScreenKind; route: "home" | "group" | "board" | "chat" | "drawer" | "pushed"; id?: string };

const HOME: StackEntry = { key: "home", name: "home", title: "Home", kind: "place", route: "home" };

type Gs = StackState["groups"];

const groupsOf = (s: StackState, server: string): Gs => (server === LOCAL_SERVER ? s.groups : s.sections[server]?.groups ?? []);

/** The group and the groups above it, outermost first. Empty for no group and an unknown one; stops at a missing parent (and a cycle). */
function groupChain(groups: Gs, key: string | undefined): Gs {
  const out: Gs = [];
  for (let g = key ? groups.find((x) => x.id === key) : undefined; g && !out.includes(g); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) out.unshift(g);
  return out;
}

/** The place of what is open: its server, and the keys of its groups, outermost first (none when it is ungrouped or its group is
 *  unknown). Home has none. */
export function placeOf(s: StackState, view: ShellView): HomePlace {
  if (view.kind === "home") return NO_PLACE;
  const board = view.kind === "board" ? s.boards[view.board] : undefined;
  const key = view.kind === "board" ? view.board : view.chat;
  const server = serverOfKey(key);
  const group = board ? board.group : s.chats[key]?.group;
  return { server, groups: groupChain(groupsOf(s, server), group).map((g) => g.id) };
}

/** The screens of the phone's stack, bottom first: Home; the groups (the ones browsed on Home, or, while a board or a chat is open, the
 *  ones of its place: the same whichever way the person came); the board, its chat over it, the subagent drawer over the chat; then the
 *  pushed screens. */
export function stackOf(s: StackState, place: HomePlace = NO_PLACE, pushed: readonly StackEntry[] = []): StackEntry[] {
  const v = shellView(s);
  const entries: StackEntry[] = [HOME];
  const here = v.kind === "home" ? { server: place.server ?? LOCAL_SERVER, groups: place.groups } : placeOf(s, v);
  const all = groupsOf(s, here.server ?? LOCAL_SERVER);
  for (const key of here.groups) {
    const g = all.find((x) => x.id === key);
    if (!g) break; // an unknown group cuts the rest
    entries.push({ key: `group:${key}`, name: "group", title: g.name, kind: "place", route: "group", id: key });
  }
  if (v.kind === "board") entries.push({ key: `board:${v.board}`, name: "board", title: s.boards[v.board]!.name, kind: "content", route: "board", id: v.board });
  const chat = v.kind === "board" ? v.chat : v.kind === "chat" ? v.chat : null;
  if (chat) entries.push({ key: `chat:${chat}`, name: "chat", title: chatTitle(s.chats[chat]!), kind: "content", route: "chat", id: chat });
  if (chat && s.subDrawer?.chat === chat) entries.push({ key: `drawer:${chat}`, name: "drawer", title: "Subagent", kind: "content", route: "drawer", id: chat });
  return [...entries, ...pushed];
}

/** What makes a screen the top: the pushed screens to take away (the lowest one above it, and with it all above), the drawer to close,
 *  the selection to set and Home's place to set (null: unchanged). */
export type Plan = { popPushed: string | null; closeDrawer: boolean; sel: Sel | null; place: HomePlace | null };

/** What a back to `targetKey` does to the store, so that `entries` lose everything above it (and nothing else changes in what is
 *  left: the list after is a prefix of the list before). A back from content lands on the content's place, then Home. `place` is
 *  Home's now, for the server of a back that browsing keeps. Null for a key the list does not hold, and for the top itself. */
export function planPopTo(s: StackState, entries: readonly StackEntry[], targetKey: string, place: HomePlace = NO_PLACE): Plan | null {
  const at = entries.findIndex((e) => e.key === targetKey);
  if (at < 0 || at === entries.length - 1) return null;
  const target = entries[at]!;
  const above = entries.slice(at + 1);
  const plan: Plan = { popPushed: above.find((e) => e.route === "pushed")?.key ?? null, closeDrawer: above.some((e) => e.route === "drawer"), sel: null, place: null };
  const content = above.some((e) => e.route === "board" || e.route === "chat");
  if (target.route === "board") {
    if (above.some((e) => e.route === "chat")) plan.sel = { board: target.id!, chat: null };
  } else if (target.route === "home" || target.route === "group") {
    const groups = entries.slice(1, at + 1).filter((e) => e.route === "group").map((e) => e.id!);
    if (content) {
      const open = entries.find((e) => e.route === "board" || e.route === "chat")!;
      plan.sel = { board: null, chat: null };
      plan.place = { server: serverOfKey(open.id), groups };
    } else if (above.some((e) => e.route === "group")) {
      plan.place = { server: place.server, groups };
    }
  }
  return plan;
}

/** The key of the screen a back lands on: the one under the top. Null at the bottom. */
export const backTarget = (entries: readonly StackEntry[]): string | null => entries[entries.length - 2]?.key ?? null;

/** Whether two lists of entries have the same keys. */
export const sameKeys = (a: readonly StackEntry[], b: readonly StackEntry[]): boolean => a.length === b.length && a.every((e, i) => b[i]!.key === e.key);
