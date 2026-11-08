// The agents' tools on a room (design 3.2, 3.5): the seam later packages fill (H2: read_board, apply, delete_elements; H3:
// get_image). Until then every tool is answered NOT_SUPPORTED. The dispatcher (rpc.ts) loads the room, runs the calls on one
// room one at a time, and answers get_view and show_board itself.
import type { TLSocketRoom } from "@tldraw/sync-core";
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
};

export type ToolImage = { mimeType: string; data: string };
export type ToolResult = string | { text: string; image: ToolImage };

/** What a tool gets of its board's room. */
export type RoomHandle = {
  board: string;
  room: BoardRoom;
  /** Saves the room now (people's pending edits too) and resolves when it is written; rejects with the reason it was not.
   *  An agent's change is saved with it before the answer (design 4.2). */
  save(): Promise<void>;
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

/** The tools. Nothing is supported yet. */
export const handleTool: HandleTool = async (_room, params) => {
  throw new ToolError("NOT_SUPPORTED", `the board host cannot answer ${params.name} on a new board yet`);
};
