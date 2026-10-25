// What Settings' rows say (ux-improvements goal 3.8.1), decided without a screen: the Servers row's line and whether it is amber, the
// Prompt library's and Archived's counts, Voice's value and Appearance's choice. Pure: no React, no react-native, so Node loads it.
import { THEME_LABELS, flavourOf, type ThemePref } from "@aiwb/core/logic/theme.ts";
import type { LibraryView } from "@aiwb/core/logic/library.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { needsAttention, serverWord, type ServerWordContext } from "@aiwb/core/logic/statewords.ts";

import { AUTOSEND_OFF, AUTOSEND_ON } from "../../voice/words.ts";

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** The Servers row's second line: "3 connected · 1 connecting… · Attic unreachable". One server with a problem is named with its word;
 *  two or more are counted. `attention` is true when one needs the person (the line turns amber). */
export function serversLine(views: ServerView[], ctx: ServerWordContext = {}): { text: string; attention: boolean } {
  if (!views.length) return { text: "No servers", attention: false };
  const connected = views.filter((v) => v.state === "connected").length;
  const connecting = views.filter((v) => v.state === "connecting").length;
  const problems = views.filter(needsAttention);
  const parts: string[] = [];
  if (connected) parts.push(`${connected} connected`);
  if (connecting) parts.push(`${connecting} connecting…`);
  if (problems.length === 1) parts.push(`${problems[0]!.name} ${lowerFirst(serverWord(problems[0]!, ctx).text)}`);
  else if (problems.length > 1) parts.push(`${problems.length} need attention`);
  return { text: parts.join(" · "), attention: problems.length > 0 };
}

/** The Prompt library row's value: the prompts of every library together. */
export function libraryValue(libraries: LibraryView[]): string {
  const n = libraries.reduce((sum, l) => sum + l.prompts.length, 0);
  return n === 0 ? "None" : n === 1 ? "1 prompt" : `${n} prompts`;
}

/** The Archived row's value: how many chats are archived. */
export function archivedValue(chats: Record<string, { archived?: boolean }> | { archived?: boolean }[]): string {
  const n = (Array.isArray(chats) ? chats : Object.values(chats)).filter((c) => c.archived).length;
  return n === 0 ? "None" : String(n);
}

/** The Voice row's second line: nothing while the key is not known yet, "No key", else the voice and what a spoken turn does. */
export function voiceLine(v: { hasKey: boolean | null; voiceName: string; autoSend: boolean }): string {
  if (v.hasKey === null) return "";
  if (!v.hasKey) return "No key";
  return `${v.voiceName || "Key set"} · ${v.autoSend ? AUTOSEND_ON : AUTOSEND_OFF}`;
}

/** The Appearance row's second line: the choice ("Light", "System", "Catppuccin Mocha"). */
export function appearanceLine(pref: ThemePref): string {
  return `${flavourOf(pref) ? "Catppuccin " : ""}${THEME_LABELS[pref]}`;
}
