// The chat header's button that opens the tree popup.
import "./fork.css";
import "./popup.css";
import { useStore, branchCount } from "../store.ts";
import { BranchIcon } from "../icons.tsx";
import { treeKeyName } from "../logic/treepopup.ts";
import { openTree } from "./actions.ts";

export const KEY_TREE = treeKeyName(typeof navigator !== "undefined" ? navigator.platform : "");

/** Tree, with the branch count once the chat has split. Every chat has it, archived and legacy ones too. */
export function TreeButton({ chatId }: { chatId: string }) {
  const n = useStore((s) => branchCount(s.chats[chatId]));
  return (
    <button className="btn ghost sm fk-tree-btn" onClick={() => openTree(chatId)} title={`Chat tree (${KEY_TREE})`}>
      <BranchIcon size={12} /> Tree{n > 1 && <span className="pill">{n}</span>}
    </button>
  );
}
