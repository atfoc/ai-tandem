// The full diff of an edit (ux-improvements goal 3.5, package T2): a pushed content screen on the phone, opened from a step's
// "Show full diff". The call is named by where its item is (the chat, the branch, a subagent's thread or the chat's own) and its
// tool id; `file` is the edited file's name, the screen's title.
import { pushScreen } from "../shell/screens.ts";

export type DiffParams = { chat: string; branch: string; tool: string; sub?: string; file: string };

export const DIFF_SCREEN = "diff";

export const openFullDiff = (p: DiffParams): string => pushScreen(DIFF_SCREEN, p);
