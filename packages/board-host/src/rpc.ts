// The agents' calls (design 3.2, 3.5): an `rpc` event of method `tool` is run on its board's room through the seam of agent.ts and
// answered with `POST /api/rpc-reply`, a refusal as `CODE: words`. get_view and show_board are never sent to the board host; if one
// comes, it is answered in the headless writer's plain words, which are no error.
import { noShowText, noViewText } from "@aiwb/headless/src/texts.ts";
import type { HandleTool, ToolParams, ToolResult } from "./agent.ts";
import { ToolError } from "./agent.ts";
import type { Rooms } from "./rooms.ts";

export type RpcEvent = { id: string; method: string; params: ToolParams };

export async function answerRpc(m: RpcEvent, rooms: Rooms, handleTool: HandleTool): Promise<{ result?: ToolResult; error?: string }> {
  try {
    if (m.method !== "tool") throw new ToolError("BAD_ARGS", `unknown method ${m.method}`);
    const p = m.params;
    if (!p || typeof p.name !== "string") throw new ToolError("BAD_ARGS", "the call names no tool");
    const target = p.target || p.board;
    if (p.name === "get_view") return { result: noViewText(p.board || target) };
    if (p.name === "show_board") return { result: noShowText(target) };
    if (!target) throw new ToolError("NO_BOARD", "the call names no board");
    return { result: await rooms.withRoom(target, (room) => handleTool(room, { ...p, target })) };
  } catch (err: any) {
    return { error: `${err?.code ? err.code + ": " : ""}${err?.message ?? String(err)}` };
  }
}
