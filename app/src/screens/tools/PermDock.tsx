// The permission dock (ux T2, the phone only): while a request waits for an answer and its card has scrolled out of view, its title, its
// command and Deny / Allow stand above the composer, so the agent is never left waiting for a card nobody can see. It shows the first
// waiting request whose card is not in view ("1 of 2" with two or more waiting); Show scrolls the thread to that card. It reads the same
// item the card does, so an answer given in either place is the answer of both, and it leaves when the card is back in view or nothing waits.
import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { pendingPerms } from "@aiwb/core/logic/permwords.ts";
import { isLegacy, shownBranch, shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { useOffWhy, usePrefixEnd } from "../chat/hooks.ts";
import { threadScroller } from "../chat/threadscroll.ts";
import { useViewable } from "../chat/threadview.ts";
import { PermButtons, PermCommand, usePermWords } from "./PermCard.tsx";
import { T2_TID } from "./ids.ts";
import { observePerm } from "./permtimes.ts";

export function PermDock({ chat }: { chat: string }) {
  const phone = usePhone();
  return phone ? <Dock chat={chat} /> : null;
}

function Dock({ chat }: { chat: string }) {
  const c = useStore((s) => shownView(s, chat));
  const loaded = useStore((s) => threadOf(s, chat));
  const branch = useStore((s) => shownBranch(s, chat));
  const cut = useStore((s) => s.moves[chat]?.at);
  const end = usePrefixEnd(chat);
  const off = useOffWhy(chat);
  const viewable = useViewable(chat);
  const all = loaded?.items;
  const items = all && cut !== undefined ? all.slice(0, cut) : all;
  const waiting = items ? pendingPerms(items, end) : [];
  // the dock is mounted whenever the chat is: it is the one that sees a request answered while its card is off screen
  useEffect(() => { for (const p of waiting) observePerm(chat, p.item); });
  if (!c || c.archived || isLegacy(c) || off || !viewable) return null;
  const at = waiting.findIndex((p) => !viewable.has(`${branch}:${p.index}`));
  if (at < 0) return null;
  const shown = waiting[at];
  return <DockCard chat={chat} branch={branch} shown={shown} count={waiting.length} pos={at + 1} />;
}

function DockCard({ chat, branch, shown, count, pos }: { chat: string; branch: string; shown: { item: Item; index: number }; count: number; pos: number }) {
  const t = useTokens();
  const c = useStore((s) => shownView(s, chat));
  const { who, title, what, decide, err } = usePermWords(shown.item, c!, branch);
  const show = () => { threadScroller(chat)?.toItem(shown.index, true); };
  return (
    <View {...tid(T2_TID.permDock, { count, at: shown.index })} style={[styles.dock, { borderColor: t.warn, backgroundColor: t.warnSoft }]}>
      <View style={styles.head}>
        <AgentGlyph agent={c?.agent ?? ""} size={14} />
        <Text size={15} weight="600" numberOfLines={1} style={styles.title}>{title || who}</Text>
        {count >= 2 ? <Text {...tid(T2_TID.permDockPos)} tone="muted" size={TYPE.secondary}>{pos} of {count}</Text> : null}
        <Pressable {...tid(T2_TID.permDockShow)} role="button" accessibilityLabel="Show the request" onPress={show} style={styles.show}>
          <Text tone="accent" size={TYPE.control}>Show</Text>
          <View style={styles.chevron}><DisclosureChevron color={t.accent} /></View>
        </Pressable>
      </View>
      {what ? <View style={styles.what}><PermCommand what={what} lines={2} id="perm-dock-command" /></View> : null}
      <View style={styles.answer}><PermButtons onAnswer={decide} deny={T2_TID.permDockDeny} allow={T2_TID.permDockAllow} /></View>
      {err ? <Text {...tid("perm-dock-error")} size={TYPE.secondary} tone="danger" style={styles.err}>{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { marginHorizontal: PHONE.margin, marginBottom: 8, borderWidth: 1, borderRadius: 12, paddingTop: 2, paddingBottom: 12, paddingHorizontal: 12 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: PHONE.target },
  title: { flexShrink: 1, minWidth: 0 },
  show: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 6, minHeight: PHONE.target, paddingLeft: 8 },
  chevron: { transform: [{ rotate: "90deg" }] },
  what: { marginTop: -2 },
  answer: { marginTop: 10 },
  err: { paddingTop: 4 },
});
