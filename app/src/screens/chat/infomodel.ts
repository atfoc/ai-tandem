// What Chat info says and which of its rows can be pressed (ux-improvements goal 3.5, package T3): the "started" line of its head, the
// context and branch words, and the rules that fade Rename, Archive and Delete with the reason, as pure functions. No React and no
// react-native here, so Node loads it (app/test/chatinfo.test.ts).
import { goneText } from "@aiwb/core/logic/remoteview.ts";

import { ctxShare, fmtK, type Context } from "../usage/meter.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "started today at 09:12", "started yesterday at 18:40", "started Oct 3" ("started Oct 3, 2025" from another year); 24 h local time.
 *  created is the chat's ISO time; "" for one that is not a time. */
export function startedLine(created: string, now: number = Date.now()): string {
  const t = new Date(created), n = new Date(now);
  if (Number.isNaN(t.getTime())) return "";
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(t)) / 86_400_000); // Math.round: a day is 23 or 25 hours when the clock changes
  const at = `${two(t.getHours())}:${two(t.getMinutes())}`;
  if (days <= 0) return `started today at ${at}`;
  if (days === 1) return `started yesterday at ${at}`;
  return `started ${MONTHS[t.getMonth()]} ${t.getDate()}${t.getFullYear() === n.getFullYear() ? "" : `, ${t.getFullYear()}`}`;
}

/** The head's sub-line: "Chat info · started today at 09:12". */
export const infoSub = (created: string, now?: number): string => ["Chat info", startedLine(created, now)].filter(Boolean).join(" · ");

/** The Context row's value: "36% · 73k of 200k"; "Unavailable" when the tokens are not known. */
export function contextValue(c: Pick<Context, "used" | "win" | "error">): string {
  if (c.error || (!c.used && !c.win)) return "Unavailable";
  if (!c.win) return `${fmtK(c.used)} tokens`;
  if (!c.used) return `0 of ${fmtK(c.win)}`; // before the first reply: no share to say
  return `${ctxShare(c.used, c.win)} · ${fmtK(c.used)} of ${fmtK(c.win)}`;
}

/** The Chat tree row's value. */
export const branchesWord = (n: number): string => (n === 1 ? "1 branch" : `${n} branches`);

/** The note under the Server group once the agent, model and effort are fixed. */
export const LOCK_NOTE = "Fixed after the first message.\nFork the chat to try another model.";

export type Rule = { disabled: boolean; why: string };

export type RuleIn = { archived: boolean; legacy: boolean; gone: boolean; connected: boolean; server: string };

const OK: Rule = { disabled: false, why: "" };

/** Why a row that changes the chat on its server waits: it is gone from the server, or the server is not connected. */
export const offlineWhy = (i: Pick<RuleIn, "gone" | "connected" | "server">): string =>
  i.gone ? goneText(i.server) : i.connected ? "" : `${i.server} is offline: you can do this when it is back.`;

/** The rows that call the chat's server: Rename, Archive (or Unarchive) and Delete. Each is faded with its reason when the server cannot
 *  be asked; an archived chat is not renamed, and a chat of an older version only archives and deletes (as the sidebar's menu has it). */
export function infoRules(i: RuleIn): { rename: Rule; archive: Rule; delete: Rule } {
  const off = offlineWhy(i);
  const call: Rule = off ? { disabled: true, why: off } : OK;
  const rename: Rule = off ? call
    : i.archived ? { disabled: true, why: "Unarchive the chat to rename it." }
    : i.legacy ? { disabled: true, why: "This chat is from an older version and can't be renamed." }
    : OK;
  return { rename, archive: call, delete: call };
}
