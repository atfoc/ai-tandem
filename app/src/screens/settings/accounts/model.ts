// What Settings › Claude accounts decides without a screen (multiple-claude goal §1.1, §1.2): the Settings row's line, and the add/edit
// sheet's form (where it starts from, whether it changed, a folder put in its list, what Save sends). Every word of the screens themselves
// is core's (@aiwb/core/logic/aliases.ts). Pure: no React, no react-native, so Node loads it.
import type { AliasInput, AliasList, Alias } from "@aiwb/core/aliasesapi.ts";
import { cleanMounts, dockerWords, normFolder } from "@aiwb/core/logic/aliases.ts";

/** The Settings row's second line, over the lists shown (one per connected server that has accounts): "3 accounts · 1 needs a restart",
 *  "No accounts"; with "Docker not running" (the reason) when Docker cannot be used where accounts are. `attention`: something needs the
 *  person (the row draws it muted for now: P0.3 takes any other amber line of Settings for the Servers line's). */
export function accountsRowLine(lists: readonly AliasList[]): { text: string; attention: boolean } {
  const all = lists.flatMap((l) => l.aliases);
  if (!all.length) return { text: "No accounts", attention: false };
  const parts = [all.length === 1 ? "1 account" : `${all.length} accounts`];
  const restart = all.filter((a) => a.restartNeeded).length;
  if (restart) parts.push(restart === 1 ? "1 needs a restart" : `${restart} need a restart`);
  const down = lists.find((l) => l.aliases.length && !l.docker.ok);
  if (down) parts.push(dockerWords(down.docker));
  return { text: parts.join(" · "), attention: restart > 0 || !!down };
}

/** The sheet's fields: the name, the folders in their order (a blank one is left out when sent), the image as typed. */
export type AccountForm = { name: string; mounts: string[]; image: string };

/** The folders with `path` at the end, unless it is listed already (trailing slashes do not count). */
export function withFolder(mounts: readonly string[], path: string): string[] {
  const p = path.trim();
  if (!p || mounts.some((m) => normFolder(m) === normFolder(p))) return [...mounts];
  return [...mounts, p];
}

/** Where the sheet starts: the account as saved (a new one: no name, no folder, the default image), with `prefill` put in its list (the
 *  chat's "Add it in Settings": the form then shows as changed). */
export function formOf(a: Alias | undefined, list: AliasList | undefined, prefill?: string): AccountForm {
  const mounts = [...(a?.mounts ?? [])];
  return { name: a?.name ?? "", mounts: prefill ? withFolder(mounts, prefill) : mounts, image: a?.image || list?.defaultImage || "" };
}

/** Whether the form differs from where it started (what closing asks about). */
export function formDirty(f: AccountForm, initial: AccountForm): boolean {
  const key = (x: AccountForm) => JSON.stringify([x.name.trim(), cleanMounts(x.mounts).map(normFolder), x.image.trim()]);
  return key(f) !== key(initial);
}

/** What Save sends: the name trimmed, the folders without the blank ones, the image "" when it is empty or the default (goal §1.2: empty =
 *  the default image). */
export function inputOf(f: AccountForm, defaultImage: string): AliasInput & { name: string } {
  const image = f.image.trim();
  return { name: f.name.trim(), mounts: cleanMounts(f.mounts), image: image === defaultImage ? "" : image };
}
