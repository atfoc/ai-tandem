// The phone's chip row of a new chat (ux-improvements goal 3.6, package C2): which of a chat's first choices it shows, and the empty
// thread's hint that points at them. A chip is a choice the chat still has: the agent while it can be changed (agentOpen), the folder until
// the first message (or while it is missing), the model with its effort while they are not fixed (pickerMode), the subagent settings on a
// new chat alone (subChip). A chat whose server is not connected, or no longer has it (frozen), has none: what blocks it is said once,
// elsewhere. No React and no react-native here.
import type { ChatView } from "../types.ts";
import { agentOpen } from "./agentlist.ts";
import { pickerMode } from "./models.ts";
import { subChip } from "./subsettings.ts";

export type ChipKind = "agent" | "folder" | "model" | "subagents";

type RowChat = Pick<ChatView, "agent" | "locked" | "fresh" | "status" | "forkedFrom" | "branch" | "branches" | "folderMissing">;

/** The chips of the row, in their order. move: the chat has a pending move (its model and effort go with that message). */
export function chipKinds(c: RowChat, o: { frozen: boolean; move: boolean }): ChipKind[] {
  if (o.frozen) return [];
  const out: ChipKind[] = [];
  if (agentOpen(c)) out.push("agent");
  if (!c.locked || !!c.folderMissing) out.push("folder");
  if (!!c.agent && pickerMode(c, o.move) !== "fixed") out.push("model");
  if (subChip(c, o.move).kind === "open") out.push("subagents");
  return out;
}

/** The row holds the model alone: it says so beside the chip. */
export const ONLY_MODEL = "Only the model can change";

const WORDS: Partial<Record<ChipKind, string>> = { agent: "agent", folder: "folder", model: "model" };

/** The empty thread's hint on the row above the box: what can still be chosen there, and that it locks with the first message.
 *  "" when the row has nothing the hint names. */
export function setupHint(kinds: ChipKind[]): string {
  const names = kinds.map((k) => WORDS[k]).filter((w): w is string => !!w);
  if (!names.length) return "";
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `Choose the ${list} above the box. ${names.length > 1 ? "They lock" : "It locks"} when you send.`;
}
