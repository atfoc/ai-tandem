// Restarting this computer's server (version.ts): how many chats a restart ends, and what it asks first.
// The page's own version (the app's) and the one this computer's server reports are `git describe` strings
// that can't be ordered; the section compares them (logic/localsection.ts otherBuild).
import type { Status } from "../types.ts";
import { isWorking, type StatesOf } from "./status.ts";
import { inSection } from "./keys.ts";

/** How many chats have an agent running on some branch, or subagents running while their agent
 *  waits for them: a restart ends them. A chat that only holds results not sent yet is not counted.
 *  `statesOf` gives a chat's records, to count the branches that are not the current one. A chat of
 *  another server is not counted: its turns are not this computer's server's to end. */
export const runningChats = (chats: Iterable<{ id?: string; status: Status; subsRunning?: number; subsOwed?: number; working?: number }>, statesOf?: StatesOf): number => {
  let n = 0;
  for (const c of chats) if (!inSection(c.id) && isWorking(c, c.id !== undefined ? statesOf?.(c.id) : undefined)) n++;
  return n;
};

/** The restart confirmation's body for n running agent chats: a restart ends their turns. */
export const restartConfirmText = (n: number): string => `Restart ends ${n} running agent chat${n === 1 ? "" : "s"}.`;
