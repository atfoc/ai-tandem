// The agents' tools on a room (design 3.2, 3.5, 7.3, 7.4, 4.2, D11): read_board, apply, delete_elements and get_image, answered
// on the room's editor (roomeditor.ts). The dispatcher (rpc.ts) loads the room, runs the calls on one room one at a time, and
// answers get_view and show_board itself; list_boards and create_board are Go's.
//
// One change (apply, delete_elements), in the order of 7.4: the editor is synced to the room, the ops run in one `editor.run`
// (apply.ts), the diff is written to the room in one storage transaction, and the elements of the answer are read, all in one
// synchronous stretch (no await between them, so no window message is handled in between); then the room is saved and the
// save awaited (4.2: a failure is SAVE_FAILED, the change stays in the room and the windows), the marker sent (D11), and the
// answer given.
import type { TLSocketRoom } from "@tldraw/sync-core";
import type { TLShapeId } from "tldraw";
import { applyOps, type ApplyOk } from "@aiwb/board-tl/model/apply.ts";
import { readBoardText, readElementsById, type BoardInfo } from "@aiwb/board-tl/model/read.ts";
import { lookupFromRecords } from "@aiwb/board-tl/model/validate.ts";
import { saveFailedText } from "@aiwb/headless/src/texts.ts";
import { getImage } from "./render.ts";
import type { RoomEditor } from "./roomeditor.ts";
import type { BoardRecord } from "./schema.ts";

/** What tldraw's room keeps of a session: the session id Go made (design 2.1). */
export type SessionMeta = { session: string };

export type BoardRoom = TLSocketRoom<BoardRecord, SessionMeta>;

/** The params of an `rpc` event of method `tool` (design 3.2). */
export type ToolParams = {
  chat: string;
  branch: string;
  /** The chat's board. */
  board: string;
  /** The board the tool is about. */
  target: string;
  name: string;
  args: any;
  kind?: string;
  agent?: { kind: string; label: string };
  /** The target board's name as the server's list has it (filled by the host, not sent by Go). */
  targetName?: string;
};

export type ToolImage = { mimeType: string; data: string };
export type ToolResult = string | { text: string; image: ToolImage };

/** The agent's marker (D11): the contract with the window lane, sent with `room.sendCustomMessage`. */
export type AgentMarker = { type: "aiwb_agent"; label: string; chat: string; bounds: { x: number; y: number; w: number; h: number }; ttlMs: number };

/** How long a window shows the marker. */
export const MARKER_TTL_MS = 4_000;

/** What a tool gets of its board's room. */
export type RoomHandle = {
  board: string;
  room: BoardRoom;
  /** Saves the room now (people's pending edits too) and resolves when it is written; rejects with the reason it was not.
   *  An agent's change is saved with it before the answer (design 4.2). */
  save(): Promise<void>;
  /** The room's editor (made at the first call that asks, disposed with the room). */
  editor(): Promise<RoomEditor>;
  /** Sends the marker to every connected session of the room and keeps it for sessions that connect within its ttl. */
  mark(marker: AgentMarker): void;
};

/** A refusal the agent reads as `CODE: message`. */
export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type HandleTool = (room: RoomHandle, params: ToolParams) => Promise<ToolResult>;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `CODE: text` (as apply.ts and validate.ts make them) → a ToolError, so rpc.ts gives the same text back. */
function codedError(text: string): ToolError {
  const m = /^([A-Z_]+): ([\s\S]*)$/.exec(text);
  return m ? new ToolError(m[1], m[2]) : new ToolError("APPLY_FAILED", text);
}

function boardOf(h: RoomHandle, p: ToolParams): BoardInfo {
  const id = p.target || h.board;
  return { id, name: p.targetName || id };
}

const pageBoundsOf = (ed: RoomEditor) => (id: string) => ed.editor.getShapePageBounds(id as TLShapeId) ?? undefined;

/** The tools. */
export const handleTool: HandleTool = async (h, p) => {
  switch (p.name) {
    case "read_board": return readBoard(h, p);
    case "apply": {
      const ops = p.args?.ops;
      if (!Array.isArray(ops)) {
        throw new ToolError("BAD_ARGS", "this is a new board; apply takes ops (a list of create, update and delete operations; see the tool description)");
      }
      return change(h, p, ops, (n) => `Applied ${plural(n, "op")}`);
    }
    case "delete_elements": return deleteElements(h, p);
    case "get_image": {
      const ed = await h.editor();
      ed.sync(h.room);
      return getImage(ed.editor, p.args, boardOf(h, p));
    }
    default:
      throw new ToolError("NOT_SUPPORTED", `the board host does not answer ${p.name}`);
  }
};

async function readBoard(h: RoomHandle, p: ToolParams): Promise<string> {
  const ed = await h.editor();
  ed.sync(h.room);
  return readBoardText(boardOf(h, p), ed.editor.store.allRecords(), { pageBounds: pageBoundsOf(ed) });
}

async function deleteElements(h: RoomHandle, p: ToolParams): Promise<string> {
  const refs = p.args?.refs;
  const form = 'refs is a non-empty list of {"id": "shape:…"} or {"key": "…"}';
  if (!Array.isArray(refs) || refs.length === 0) throw new ToolError("BAD_ARGS", form);
  for (const [i, r] of refs.entries()) {
    const ok = r && typeof r === "object" && !Array.isArray(r) &&
      ((typeof r.id === "string" && r.id !== "" && r.key === undefined) || (typeof r.key === "string" && r.key !== "" && r.id === undefined));
    if (!ok) throw new ToolError("BAD_ARGS", `refs[${i}] is not {"id"} or {"key"}: ${form}`);
  }
  // resolved against the synced records inside change(), in the same turn as the apply
  const resolve = (ed: RoomEditor): unknown[] => {
    const lookup = lookupFromRecords(ed.editor.store.allRecords());
    const ids: string[] = [];
    for (const [i, r] of refs.entries()) {
      const el = r.id !== undefined ? lookup.byId(r.id) : lookup.byKey(r.key);
      if (!el) throw new ToolError("UNKNOWN_REF", `refs[${i}] ${JSON.stringify(r)} names no element of this board`);
      if (!ids.includes(el.id)) ids.push(el.id);
    }
    return ids.map((id) => ({ op: "delete", id }));
  };
  return change(h, p, resolve, (_n, ok) => `Deleted ${plural(ok.deleted.length, "element")}`);
}

/** One change of the board (7.4): sync, apply, write and read in one synchronous stretch; then save, marker, answer. */
async function change(
  h: RoomHandle, p: ToolParams, ops: unknown[] | ((ed: RoomEditor) => unknown[]), sentence: (n: number, ok: ApplyOk) => string,
): Promise<string> {
  const ed = await h.editor();
  const board = boardOf(h, p);
  // ---- from here to the write: no await
  let ok: ApplyOk, list: unknown[], elements;
  try {
    const roomRecs = ed.sync(h.room);
    list = typeof ops === "function" ? ops(ed) : ops;
    const r = applyOps(ed.editor, list);
    if (!r.ok) throw codedError(r.error);
    ok = r;
    ed.write(h.room, r.diff, ed.missingFrom(roomRecs));
    elements = readElementsById(ed.editor.store.allRecords(), [...r.created, ...r.updated], { pageBounds: pageBoundsOf(ed) });
  } catch (err) {
    ed.stale();
    if (err instanceof ToolError) throw err;
    throw new ToolError("APPLY_FAILED", messageOf(err));
  }
  // ---- the change is in the room; it reaches the windows as one patch
  let saveError: unknown = null;
  try {
    await h.save();
  } catch (err) {
    saveError = err ?? "unknown";
  }
  // (also after a failed save: the change is in the windows, and the marker shows where)
  if (ok.bounds) {
    h.mark({ type: "aiwb_agent", label: p.agent?.label || "Agent", chat: p.chat, bounds: ok.bounds, ttlMs: MARKER_TTL_MS });
  }
  if (saveError !== null) throw new ToolError("SAVE_FAILED", saveFailedText(messageOf(saveError)));
  const json = JSON.stringify({ ids: ok.ids, created: ok.created, updated: ok.updated, deleted: ok.deleted, elements });
  return `${sentence(list.length, ok)} on ${JSON.stringify(board.name)} (${board.id}); saved.\n${json}`;
}
