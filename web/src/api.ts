// The server's HTTP API (section 4.12). Every call carries this tab's client id,
// so the server can tell the active client from a stale one.
import type { AgentKind, Board, Catalog, ChatView, Defaults, Group, Item, PlanUsage, Subagent } from "./types.ts";

/** GET /api/state and the `snapshot` event. */
export type Snapshot = {
  groups: Group[];
  boards: Board[];
  chats: ChatView[];
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog | null>>;
  home: string;
  defaultCwd: string;
  dataDir: string;
};

export type Dirs = { path: string; parent: string; dirs: string[]; git: boolean };

export const clientId: string = crypto.randomUUID(); // one per tab load

/** An API error: the server's message, with the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

async function call<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-AIWB-Client": clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, (await r.json().catch(() => ({ error: r.statusText }))).error ?? r.statusText);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type Kind = "groups" | "boards" | "chats";

export const api = {
  state: () => call<Snapshot>("GET", "/api/state"),
  release: () => call("POST", "/api/client/release", { client: clientId }),
  flushed: () => call("POST", "/api/client/flushed", { client: clientId }),
  rpcReply: (id: string, reply: { result?: unknown; error?: string }) => call("POST", "/api/rpc-reply", { id, ...reply }),
  newGroup: (name?: string) => call<Group>("POST", "/api/groups", { name }),
  updateGroup: (id: string, p: { name?: string; collapsed?: boolean }) => call("PATCH", `/api/groups/${id}`, p),
  reorderGroups: (ids: string[]) => call("PUT", "/api/groups/order", { ids }),
  archive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/archive`),
  unarchive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/unarchive`),
  deleteGroup: (id: string, contents: "delete" | "ungroup") => call("DELETE", `/api/groups/${id}?contents=${contents}`),
  newBoard: (group: string, name?: string, isNew = false) => call<Board>("POST", "/api/boards", { name, group, new: isNew }),
  scene: (id: string) => call<any>("GET", `/api/boards/${id}/scene`),
  saveScene: (id: string, scene: unknown) => call("PUT", `/api/boards/${id}/scene`, scene),
  renameBoard: (id: string, name: string) => call<Board>("POST", `/api/boards/${id}/rename`, { name }),
  moveBoard: (id: string, group: string) => call("PATCH", `/api/boards/${id}`, { group }),
  seenBoard: (id: string) => call("POST", `/api/boards/${id}/seen`),
  deleteBoard: (id: string) => call("DELETE", `/api/boards/${id}`),
  reveal: (id: string) => call("POST", `/api/boards/${id}/reveal`),
  newChat: (agent: AgentKind, where: { group: string } | { board: string }) => call<ChatView>("POST", "/api/chats", { agent, ...where }),
  items: (id: string) => call<{ version: number; items: Item[]; subagents?: Subagent[] }>("GET", `/api/chats/${id}/items`),
  subItems: (chat: string, sid: string) => call<{ version: number; items: Item[] }>("GET", `/api/chats/${chat}/subagents/${sid}/items`),
  chat: (id: string) => call<ChatView>("GET", `/api/chats/${id}`),
  openChat: (id: string) => call("POST", `/api/chats/${id}/open`),
  send: (id: string, text: string, context: string) => call("POST", `/api/chats/${id}/messages`, { text, context }),
  configure: (id: string, p: { model?: string; effort?: string; cwd?: string }) => call("PATCH", `/api/chats/${id}`, p),
  renameChat: (id: string, name: string) => call("PATCH", `/api/chats/${id}`, { name }),
  moveChat: (id: string, group: string) => call("PATCH", `/api/chats/${id}`, { group }),
  interrupt: (id: string) => call("POST", `/api/chats/${id}/interrupt`),
  decide: (id: string, requestId: string, allow: boolean) => call("POST", `/api/chats/${id}/permission`, { requestId, allow }),
  deleteChat: (id: string) => call("DELETE", `/api/chats/${id}`),
  dirs: (path: string) => call<Dirs>("GET", `/api/dirs?path=${encodeURIComponent(path)}`),
  usage: (agent: AgentKind, fresh = false) => call<PlanUsage>("GET", `/api/usage/${agent}${fresh ? "?fresh=1" : ""}`),
};
