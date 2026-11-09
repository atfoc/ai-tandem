// The Claude accounts in the composer (multiple-claude goal §1.4, §1.5, §1.6.5, §1.7, §4.2): the rows the Agent picker lists for them (the
// popover's and the phone's sheet: the name with the container's chip, the line "<email> · in its own container", why a greyed one cannot be
// picked, the folders that wait for a restart, and the one button that helps: Log in… or Restart container), and the banner above the box of
// a chat on an account whose folder its container cannot reach (or that was removed), which holds Send. The words and the rules are
// core's (logic/aliases.ts pickerRows, mountBanner); the requests go to the store (state/aliases.ts openAccounts, restartAccount), and the
// Settings screen draws Settings › Claude accounts at the account asked for.
import { useMemo } from "react";
import { Pressable, StyleSheet, View, type TextStyle } from "react-native";

import { ACTION_WORDS, mountBanner, pickerRows, restartDialog, type Chip, type MountBanner, type PickerRow } from "@aiwb/core/logic/aliases.ts";
import { aliasIdOf } from "@aiwb/core/agents.ts";
import { openAccounts, restartAccount } from "@aiwb/core/state/aliases.ts";
import { getState, subscribe } from "@aiwb/core/state/store.ts";
import type { AgentKind, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import type { Tokens } from "../../ui/tokens.ts";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { alpha } from "../chat/colour.ts";
import { confirm, reportError } from "../shell/confirm.ts";

/** The colours of a chip's tone: its text and its ground. */
export function toneColours(t: Tokens, tone: Chip["tone"]): { fg: string; bg: string } {
  switch (tone) {
    case "ok": return { fg: t.okText, bg: alpha(t.ok, 0.13) };
    case "warn": return { fg: t.warnText, bg: alpha(t.warn, 0.16) };
    case "danger": return { fg: t.danger, bg: t.dangerSoft };
    default: return { fg: t.muted, bg: t.hover2 };
  }
}

/** A small coloured pill: an account's container chip ("● Running", "⟳ Restart needed", "Docker not running"). */
export function ToneChip({ chip, size = 10.5, testID = "account-chip" }: { chip: Chip; size?: number; testID?: string }) {
  const { tokens: t } = useTheme();
  const c = toneColours(t, chip.tone);
  return (
    <View {...tid(testID, { tone: chip.tone })} accessibilityLabel={chip.title ? `${chip.text}: ${chip.title}` : chip.text} style={[styles.chip, { backgroundColor: c.bg }]}>
      <Text size={size} weight="600" numberOfLines={1} style={{ color: c.fg }}>{chip.text}</Text>
    </View>
  );
}

/** The Agent picker's rows of the chat's server (core's pickerRows): its usable agents, then every account it has, greyed with why when it
 *  cannot be used now. Recomputed when the usable list or the accounts change (an `agents` or an `aliases` event: Docker gone or back). */
export function usePickerRows(server: string, usable: readonly AgentKind[]): PickerRow[] {
  const list = useStore((s) => s.aliases[server]);
  return useMemo(() => pickerRows(usable, list), [usable, list]);
}

/** Recreates an account's container from the picker or the banner; agents working in it make the server answer `busy`, and the
 *  person is asked (restartDialog: Later keeps the change pending, Restart now forces it). A refusal is shown as an error. */
export function restartWithAsk(server: string, kind: AgentKind | string): void {
  const id = aliasIdOf(kind);
  if (!id) return;
  const failed = (e: unknown) => reportError("Couldn't restart the container", e);
  restartAccount(server, id, false).then((ch) => {
    if (ch.restart !== "busy") return;
    const d = restartDialog(ch.alias.name, ch.busy ?? 1);
    confirm({ title: d.title, body: d.body, cancelLabel: d.cancel, actions: [{ label: d.ok, tone: "primary", run: async () => { await restartAccount(server, id, true); } }] });
  }, failed);
}

/** What a picker row's button does: Log in… opens Settings › Claude accounts at the account with its login started (the picker closes
 *  first, `close`); Restart container restarts it, asking while agents work in it. */
export function rowAction(row: PickerRow, server: string, close: () => void): { label: string; onPress(): void } | undefined {
  if (row.action === "login") return { label: ACTION_WORDS.loginPicker, onPress: () => { close(); openAccounts({ server, id: aliasIdOf(row.kind), login: true }); } };
  if (row.action === "restart") return { label: ACTION_WORDS.restart, onPress: () => restartWithAsk(server, row.kind) };
  return undefined;
}

/** The text of an account's row in a picker: the name with the container's chip, the note, then why it cannot be picked, or the folders
 *  that wait for a restart. `tall`: the phone's sheet (its type sizes). */
export function AccountRowText({ row, tall }: { row: PickerRow; tall?: boolean }) {
  const { tokens: t } = useTheme();
  const small = tall ? TYPE.secondary : 11;
  return (
    <>
      <View style={styles.head}>
        <Text numberOfLines={1} size={tall ? TYPE.control : undefined} style={styles.label}>{row.label}</Text>
        {row.chip ? <ToneChip chip={row.chip} size={tall ? 12 : 10.5} /> : null}
      </View>
      {row.note ? <Text {...tid("pick-note")} size={small} tone={tall ? "muted" : "faint"}>{row.note}</Text> : null}
      {row.reason ? <Text {...tid("pick-reason")} size={small} weight="600" tone="muted">{row.reason}</Text> : null}
      {row.pending ? <Text {...tid("pick-pending")} size={small} style={{ color: t.warnText }}>{row.pending}</Text> : null}
    </>
  );
}

/** The banner of a chat on an account (core's mountBanner): its folder is not mounted in the account's container, waits for a restart, or
 *  the account was removed; null when it can be sent. Its sentence holds Send (the title of the held Send). */
export function useAccountBanner(c: Pick<ChatView, "agent" | "cwd"> | undefined, server: string): MountBanner | null {
  const list = useStore((s) => s.aliases[server]);
  const agent = c?.agent ?? "", cwd = c?.cwd ?? "";
  return useMemo(() => (agent ? mountBanner(cwd, agent, list) : null), [agent, cwd, list]);
}

/** The banner's action: "Add it in Settings" (the account's sheet with the folder in its list) for a folder not mounted, "Restart
 *  container" for one that waits for a restart; none for a removed account. */
export function bannerAction(b: MountBanner, server: string, cwd: string, kind: string): { label: string; onPress(): void } | undefined {
  if (b.state === "not_mounted" && b.alias) return { label: "Add it in Settings", onPress: () => openAccounts({ server, id: b.alias!.id, prefill: cwd }) };
  if (b.state === "pending") return { label: ACTION_WORDS.restart, onPress: () => restartWithAsk(server, kind) };
  return undefined;
}

/** The banner's sentence as drawn: "⚠ " before core's, and for a folder not mounted the words of its link cut off the end (the link says them). */
export function bannerWords(b: MountBanner, linked: boolean): string {
  const text = linked && b.state === "not_mounted" ? b.text.replace(/ — Add it in Settings$/, " —") : b.text;
  return `⚠ ${text}`;
}

/** The wide layouts' banner above the composer's box, beside the other notices: an amber line, its action a link after the sentence. */
export function AccountBanner({ banner, server, c }: { banner: MountBanner; server: string; c: Pick<ChatView, "agent" | "cwd"> }) {
  const { tokens: t } = useTheme();
  const act = bannerAction(banner, server, c.cwd, c.agent);
  return (
    <View {...tid("account-banner", { state: banner.state })} accessibilityRole="alert" style={[styles.banner, { backgroundColor: t.warnSoft, borderColor: alpha(t.warn, 0.55) }]}>
      <Text size={12} style={[styles.bannerText, { color: t.warnText }]}>
        {bannerWords(banner, !!act && banner.state === "not_mounted")}
        {act && banner.state === "not_mounted" ? <>{" "}<BannerLink label={act.label} onPress={act.onPress} /></> : null}
      </Text>
      {act && banner.state !== "not_mounted" ? <BannerLink label={act.label} onPress={act.onPress} button /> : null}
    </View>
  );
}

function BannerLink({ label, onPress, button }: { label: string; onPress(): void; button?: boolean }) {
  const { tokens: t } = useTheme();
  if (!button) {
    return <Text {...tid("account-banner-action")} role="link" accessibilityRole="link" size={12} weight="600" onPress={onPress}
      style={[{ color: t.accent, textDecorationLine: "underline" }, webStyle({ cursor: "pointer" }) as TextStyle | undefined]}>{label}</Text>;
  }
  return (
    <Pressable {...tid("account-banner-action")} role="button" accessibilityLabel={label} onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.bannerBtn, { borderColor: alpha(t.warn, 0.55), backgroundColor: hovered ? t.bg : "transparent" }, webStyle({ cursor: "pointer" })]}>
      <Text size={11.5} weight="600" style={{ color: t.warnText }}>{label}</Text>
    </Pressable>
  );
}

// The checks' window on the requests to show the accounts screen: every one made, in order (the Settings screen takes each and closes it, so
// the store holds it for a moment only). Only in a build for the checks.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  const seen: unknown[] = [];
  let last: unknown = null;
  (window as unknown as { __aiwbAccountsNavs?: unknown[] }).__aiwbAccountsNavs = seen;
  subscribe(() => { const n = getState().accountsNav; if (n && n !== last) seen.push(n); last = n; });
}

const styles = StyleSheet.create({
  chip: { flexShrink: 0, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1 },
  head: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 6, rowGap: 2 },
  label: { flexShrink: 1 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 6 },
  bannerText: { flex: 1, minWidth: 0 },
  bannerBtn: { flexShrink: 0, borderWidth: 1, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8 },
});
