// What the sidebar says about runs beyond a row's own line (logic/run.ts): a row's tag and
// tooltip, what a run adds to its group's count and working dot, and the texts of the archive and
// delete confirmations. DOM-free; Sidebar.tsx renders it.
import type { ChatView, RunView } from "../types.ts";
import { hasDraft } from "./drafts.ts";
import { isBusy } from "./status.ts";
import { isDraft, runChats, runRowLine, runWorking, workingRunChats } from "./run.ts";

type Chats = Record<string, Pick<ChatView, "id" | "created" | "run" | "role" | "archived" | "status" | "subsRunning" | "subsOwed">>;

/** A run row's Draft tag: a goal was typed and not sent. The selected run shows it in its goal
 *  box instead, with or without one of its chats open beside it. */
export const runDraftTag = (r: Pick<RunView, "started" | "draft" | "archived">, selected: boolean): boolean =>
  isDraft(r) && hasDraft(r.draft) && !selected && !r.archived;

/** A run row's tooltip: where it is, its name and its second line. path: the names of its groups,
 *  outermost first. */
export const runRowTitle = (r: Parameters<typeof runRowLine>[0] & Pick<RunView, "name">, path: string[]): string =>
  `${[...path, r.name].join(" / ")} — ${runRowLine(r)}`;

/** What a collapsed group counts: its boards, runs and plain chats, its subgroups' included. */
export const groupCount = (inside: { boards: unknown[]; runs: unknown[]; chats: unknown[] }): number =>
  inside.boards.length + inside.runs.length + inside.chats.length;

/** Whether a run lights its group's working dot: the run works, or an agent is busy in one of the
 *  user's chats on it that the sidebar shows. */
export const runLightsGroup = (r: Pick<RunView, "id" | "status" | "archived">, chats: Chats, showArchived: boolean): boolean =>
  runWorking(r) || runChats(chats, r.id, showArchived).some((c) => isBusy(c.status));

/** Whether a run in one of these groups works: what a group's archive and delete confirmations
 *  warn about. groups: the group and every group nested in it (logic/tree.ts subtree). */
export const workingRunIn = (runs: Iterable<Pick<RunView, "group" | "status" | "archived">>, groups: Set<string>): boolean => {
  for (const r of runs) if (groups.has(r.group) && runWorking(r)) return true;
  return false;
};

export const GROUP_ARCHIVE_RUN = "A run in this group is working. Stop it and archive the group?";
export const GROUP_DELETE_RUN = "A run in this group is working: deleting everything stops it.";

/** The question before a run is archived; null when nothing on it works, and it is archived
 *  without asking. The body is about the run's own agents, so a run that only has a working chat
 *  gets none. */
export function runArchiveConfirm(r: Pick<RunView, "id" | "status" | "archived">, chats: Chats): { title: string; body?: string; action: string } | null {
  if (runWorking(r)) return {
    title: "This run is working. Stop it and archive?",
    body: "Its agents are stopped and the tasks in progress are left unfinished. Unarchive the run to resume it.",
    action: "Stop and archive",
  };
  if (workingRunChats(chats, r.id).length) return { title: "An agent is working in a chat on this run. Stop it and archive?", action: "Stop and archive" };
  return null;
}

/** The question before a run is deleted. folder: the run's folder as the user reads it (~/…); a
 *  run that has not started changed nothing there, so the sentence about it is left out. */
export function runDeleteConfirm(r: Pick<RunView, "name" | "started" | "status" | "archived">, folder: string): { title: string; body: string; action: string } {
  const working = runWorking(r) ? "This run is working: its agents are stopped. " : "";
  const stays = r.started && folder ? ` What its agents changed in ${folder} stays.` : "";
  return {
    title: `Delete ${r.name}?`,
    body: `${working}The run's tasks, reports, notes, agent transcripts and chats are removed.${stays} This can't be undone.`,
    action: "Delete",
  };
}
