// What became of a run's result in the person's folder (RunDelivery), in words: the card of the
// Result tab (run/Delivery.tsx), and the short words of the end-of-run line and the sidebar.
// DOM-free.
import type { RunDelivery, RunDeliveryState, RunSettings, RunStatus } from "../types.ts";

/** A sentence in parts: plain text, and what is set as code (a folder, a branch, a commit). */
export type SayPart = string | { code: string };

/** What the card is told about the run beside its delivery. */
export interface DeliveryFacts {
  /** The run's folder, and the person's home folder (for "~"). */
  cwd: string; home?: string;
  /** The folder's branch when the run started (RunGit.branch). */
  startBranch?: string;
  /** The branch the run's result is on (RunGit.integrationBranch). */
  resultBranch?: string;
  settings?: Pick<RunSettings, "applyResult">;
  status: RunStatus;
}

export interface DeliveryCard {
  state: RunDeliveryState;
  tone: "ok" | "warn" | "muted";
  mark: "✓" | "!" | "→";
  title: string;
  sentence: SayPart[];
  /** What the server adds in its own words (RunDelivery.detail), for the line under the sentence;
   *  "" when there is none or the sentence already has it. */
  detail: string;
  /** blocked: the files in the way and the toggle's label; null when none are named. */
  files: { list: string[]; more: number; label: string } | null;
  /** The Apply button shows (pending and blocked), and whether it can be pressed. */
  action: boolean; canApply: boolean;
  /** The button's title: what it does, or why it cannot. */
  applyTitle: string;
  /** The command that does it by hand; "" when there is nothing to do or no branch is known. */
  command: string;
  /** The sentence and the command point below the card: "Do it by hand" starts open. */
  byHand: boolean;
}

/** A folder as the app shows it: the home folder as "~". */
export const tilde = (p: string, home?: string): string => (p && home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);

const sha = (s?: string): string => (s ?? "").slice(0, 7);
const c = (code: string): SayPart => ({ code });

/** A sentence as plain text (a title, a test). */
export const sayText = (parts: SayPart[]): string => parts.map((p) => (typeof p === "string" ? p : p.code)).join("");

const PARTIAL = " The run has not finished: this is what was merged so far.";
/** The blocked reasons Apply cannot get past: there is nothing to try again. */
const DEAD = new Set(["folder_missing", "not_repo", "result_missing"]);

function sentence(d: RunDelivery, f: DeliveryFacts): SayPart[] {
  const cwd = c(tilde(f.cwd, f.home) || "the run's folder"), branch = c(d.branch || f.startBranch || "the folder's branch");
  switch (d.state) {
    case "applied":
      if (d.how === "merge") return ["The result was merged into ", branch, " with your own commits", ...(d.commit ? [" (merge commit ", c(sha(d.commit)), ")"] : []), "."];
      return ["The result is in ", cwd, ...(d.commit || d.result ? [" (", branch, " is now at ", c(sha(d.commit || d.result)), ")"] : []), "."];
    case "none":
      if (d.reason === "no_git") return ["This folder is not a git repository: the agents worked directly in ", cwd, "."];
      return ["The run changed no files."];
    case "pending":
      switch (d.reason) {
        case "not_achieved": return ["The run did not reach its goal. What was finished can be applied to ", cwd, "."];
        case "halted": return ["The run is not finished. What was merged so far can be applied to ", cwd, "."];
        case "other_branch": return ["The folder is on ", branch, "; the run started on ", c(f.startBranch || "another branch"), ". Apply merges the result into ", branch, "."];
        case "history_changed": return ["Your branch no longer contains the commit this run started from (it was amended, rebased or reset). Apply brings that commit and its changes back along with the result."];
        case "manual": return ["Automatic applying is off for this run. The result is ready: apply it to ", cwd, "."];
        default: return [...(f.settings?.applyResult === "manual" ? ["Automatic applying is off for this run. "] : []), "The result is ready: apply it to ", cwd, "."];
      }
    case "blocked":
      switch (d.reason) {
        case "local_changes": return ["These files have uncommitted changes or are in the way. Commit, stash or move them, then apply."];
        case "conflict": return ["Your commits and the result change the same lines. Merge by hand with the command below."];
        case "busy": return ["A merge, rebase or other git operation is in progress in the folder. Finish or abort it, then apply."];
        case "folder_missing": case "not_repo": return [cwd, " is gone or is no longer the repository. The result is on the branch shown below."];
        case "result_missing": return ["The result's commit no longer exists in the repository."];
        case "git": return d.detail ? ["Git refused: ", c(d.detail), "."] : ["Git refused."];
        default: return d.detail ? ["The result could not be applied: ", c(d.detail), "."] : ["The result could not be applied."];
      }
    default: return [];
  }
}

const TITLES: Record<RunDeliveryState, string> = { none: "Nothing to apply", applied: "Applied to your folder", blocked: "Not applied yet", pending: "Ready to apply" };

/** What the delivery card shows; null when there is none to show (a draft, a live run). */
export function deliveryCard(d: RunDelivery | undefined, f: DeliveryFacts): DeliveryCard | null {
  if (!d || f.status === "draft" || f.status === "running" || f.status === "stopping") return null;
  const state: RunDeliveryState = d.state in TITLES ? d.state : "none";
  const open = state === "pending" || state === "blocked";
  const say = sentence({ ...d, state }, f);
  if (d.partial && state !== "none" && !(state === "pending" && d.reason === "halted")) say.push(PARTIAL); // the halted sentence says it
  const dead = state === "blocked" && DEAD.has(d.reason ?? "");
  const n = d.files?.length ?? 0, more = d.more && d.more > 0 ? d.more : 0;
  const into = d.branch || f.startBranch;
  return {
    state,
    tone: state === "applied" ? "ok" : state === "blocked" ? "warn" : "muted",
    mark: state === "blocked" ? "!" : state === "pending" ? "→" : "✓",
    title: state === "none" && d.reason === "no_git" ? "Already in your folder" : TITLES[state],
    sentence: say,
    detail: d.detail && !say.some((p) => typeof p !== "string" && p.code === d.detail) ? d.detail : "",
    files: state === "blocked" && n ? { list: d.files!, more, label: `${n === 1 ? "the file" : `the ${n} files`}${more ? ` and ${more} more` : ""}` } : null,
    action: open,
    canApply: open && !dead,
    applyTitle: !open ? "" : dead ? sayText(say) : state === "blocked" ? `Try again: apply the result to ${into || "the folder's branch"}` : `Apply the result to ${into || "the folder's branch"}`,
    command: open && f.resultBranch ? `git merge ${f.resultBranch}` : "",
    byHand: state === "blocked" && (d.reason === "conflict" || d.reason === "folder_missing" || d.reason === "not_repo"),
  };
}

/** The delivery in a word or two, for a list: "not applied" while the result waits for the person
 *  (pending, blocked); "" otherwise. */
export const deliveryWord = (state: RunDeliveryState | undefined): string => (state === "pending" || state === "blocked" ? "not applied" : "");

/** The delivery's short words for the end-of-run line: "applied to <branch>" / "not applied";
 *  null when there is nothing to say (no delivery, or nothing to apply). */
export function deliveryWords(d: Pick<RunDelivery, "state" | "branch"> | undefined): { applied: boolean; text: string; branch?: string } | null {
  if (!d) return null;
  if (d.state === "applied") return d.branch ? { applied: true, text: "applied to", branch: d.branch } : { applied: true, text: "applied" };
  return deliveryWord(d.state) ? { applied: false, text: "not applied" } : null;
}
