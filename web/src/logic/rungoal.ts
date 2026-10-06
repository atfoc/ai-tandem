// The goal composer's rules (run/RunComposer.tsx), DOM-free: what leaving a field of the settings
// popover saves, when the tiers can be reset, and the one line under the goal box. The server
// checks the same ranges again.
import { TIERS, type ModelChoice, type RunSettings, type RunTiers, type RunView, type Tier } from "../types.ts";

export type LimitKey = "maxParallel" | "maxTurns" | "maxCost";

/** The range of each limit; whole: an integer. maxCost has no upper end, and 0 is "no limit". */
export const LIMITS: Record<LimitKey, { min: number; max?: number; whole: boolean }> = {
  maxParallel: { min: 1, max: 16, whole: true },
  maxTurns: { min: 1, max: 500, whole: true },
  maxCost: { min: 0, whole: false },
};

/** The longest setup command the server takes. */
export const SETUP_MAX = 2000;

/** What a limit's field shows for a value: an absent cost limit is an empty field. */
export const limitText = (key: LimitKey, v: number): string => (key === "maxCost" && !v ? "" : String(v));

/** The value a limit's field holds when it is left with `typed` in it, cur being the saved one.
 *  A number outside the range becomes the nearest end; a whole limit is rounded, a cost is rounded
 *  to cents. An emptied Cost is 0 (no limit); any other empty field, and anything that is not a
 *  number, keeps cur. */
export function limitValue(key: LimitKey, typed: string, cur: number): number {
  const t = typed.trim(), o = LIMITS[key];
  if (!t) return key === "maxCost" ? 0 : cur;
  const n = Number(t);
  if (!Number.isFinite(n)) return cur;
  const v = o.whole ? Math.round(n) : Math.round(n * 100) / 100;
  return Math.min(Math.max(v, o.min), o.max ?? Infinity);
}

/** The setup command for what was typed: one line, trimmed, at most SETUP_MAX characters. "" is none. */
export const setupValue = (typed: string): string => typed.replace(/\s*[\r\n]+\s*/g, " ").trim().slice(0, SETUP_MAX).trimEnd();

/** The fields of the settings popover. */
export type SettingKey = LimitKey | "setup" | "wake" | "applyResult";

/** The settings to save when a field is left with `value`, or null when it is what is saved.
 *  An absent applyResult is "auto". */
export function settingsChange(s: Pick<RunSettings, SettingKey>, key: SettingKey, value: number | string): Partial<RunSettings> | null {
  const saved = key === "applyResult" ? applyResultOf(applies(s)) : s[key] ?? "";
  return saved === value ? null : { [key]: value };
}

/** "Wake it": when an orchestrator turn starts, in the order of the menu. */
export const WAKES: [RunSettings["wake"], string][] = [
  ["declared", "when its wait is met"],
  ["each", "after every task"],
  ["idle", "when nothing is running"],
];

/** The result is applied to the folder when the run ends: the checkbox is on. Absent is "auto". */
export const applies = (s: Pick<RunSettings, "applyResult">): boolean => s.applyResult !== "manual";

/** The setting for the checkbox's state. */
export const applyResultOf = (checked: boolean): "auto" | "manual" => (checked ? "auto" : "manual");

export const APPLY_NOTE = "Only when that is safe; otherwise you apply it with one click";
export const APPLY_NOTE_NO_GIT = "Not used without git: agents work in the folder itself";

// ---- tiers

/** The rows of the tier popover: the tier, its name and what runs on it. */
export const TIER_ROWS: [Tier, string, string][] = [
  ["deep", "Deep", "the orchestrator, and the hardest tasks"],
  ["standard", "Standard", "most tasks, and merges"],
  ["light", "Light", "simple, mechanical tasks"],
];

const sameChoice = (a: ModelChoice, b: ModelChoice): boolean => a.model === b.model && (a.effort ?? "") === (b.effort ?? "");

/** "Reset to the defaults" can be pressed: the agent kind's defaults are known and a tier differs
 *  from them. */
export function canResetTiers(r: Pick<RunView, "tiers" | "tierDefaults">): boolean {
  const d = r.tierDefaults;
  return !!d && TIERS.some((k) => !sameChoice(r.tiers[k], d[k]));
}

/** What "Reset to the defaults" saves: the defaults' model and effort of every tier (no effort for
 *  a model that has none). */
export function tiersReset(d: RunTiers): Record<Tier, Partial<ModelChoice>> {
  const one = (c: ModelChoice) => (c.effort ? { model: c.model, effort: c.effort } : { model: c.model });
  return { deep: one(d.deep), standard: one(d.standard), light: one(d.light) };
}

/** The run's folder is there and is not a git repository: tasks get no checkout of their own, and
 *  the setup command is not used. The server leaves `git` out when it is false. */
export const withoutGit = (r: Pick<RunView, "cwd" | "folderMissing" | "git">): boolean => !!r.cwd && !r.folderMissing && !r.git;

export const NOT_GIT = "Not a git repository: the agents work straight in this folder, one change on top of the other, and there is nothing to apply at the end.";
export const UNCOMMITTED = "This folder has uncommitted changes. The agents start from the last commit and will not see them; the result is applied at the end only if it does not touch them.";

/** One of the server's sentences as the page says it: a capital first, a full stop last. A
 *  sentence that starts with a path keeps its first letter. */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const head = /^([~/.\\]|[A-Za-z]:[\\/])/.test(t) ? t : t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

/** The line under the goal box; tone "error" is .composer-err, "note" the warning note. */
export type GoalLine = { tone: "error" | "note"; text: string };

/** The one line under the goal box, the first that applies: the start that just failed, a folder
 *  that is gone, why the server refuses this setup, a folder that is not a git repository, a
 *  folder with uncommitted changes. startError is the server's message; tilde shortens the folder's path. */
export function goalLine(r: Pick<RunView, "cwd" | "folderMissing" | "blocked" | "git" | "dirty">, startError: string, tilde: (path: string) => string = (p) => p): GoalLine | null {
  if (startError) return { tone: "error", text: startError };
  if (r.folderMissing) return { tone: "error", text: `Folder not found: ${tilde(r.cwd)}. Pick another one.` };
  if (r.blocked) return { tone: "error", text: sentence(r.blocked) };
  if (withoutGit(r)) return { tone: "note", text: NOT_GIT };
  if (r.dirty) return { tone: "note", text: UNCOMMITTED };
  return null;
}
