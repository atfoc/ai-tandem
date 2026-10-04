// A chat's branches as its view tells them: how many it has, which is current, and which one the
// thread shows. A view without the fields is a chat that was never split.
import { MAIN, type ChatView, type PendingMove } from "../types.ts";

export const branchCount = (c?: ChatView) => c?.branches ?? 1;
export const currentBranch = (c?: ChatView) => c?.branch ?? MAIN;

/** The branch whose items a chat shows: the pending move's, else the current one. */
export const shownBranchOf = (move: PendingMove | undefined, c: ChatView | undefined) => move?.branch ?? currentBranch(c);
