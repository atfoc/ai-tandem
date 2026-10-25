// The phone's bar while a chat of the board waits for a point or for shapes (ux-improvements B2, plans/ux-improvements/b2-design.md §6; goal
// 3.4): in the place of the bottom row, full width and the band's height, an accent ground that names the chat it is for, with the one white
// button where the orb was: Cancel for a point, Add (n) for shapes (Edit here first for a reader). BottomRow draws it; the landscape
// controls draw it floating at the bottom edge. A wait ends with a back, Cancel, a tap or Add (n): the wide layouts keep PickLayer's hint.
import { useContext } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { BAND_HEIGHT } from "@aiwb/board-bridge/messages.ts";
import { selectedOn } from "@aiwb/core/logic/roles.ts";
import { chatTitle, threadOf } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { PointIcon, SelectionIcon } from "../composer/phone/icons.tsx";
import { floatEdges } from "./floatlayout.ts";
import { B2_TID } from "./ids.ts";
import { pickBar } from "./pickbar.ts";
import "./pickseam.ts";
import { editHere } from "./RoleBar.tsx";
import { finishSelect, pickPoint } from "./refs.ts";

/** What a chat of this board waits for: the chat's id and "point" | "select"; null when none of the board's chats waits. */
export function usePickWait(board: string): { chat: string; kind: "point" | "select" } | null {
  const chat = useStore((s) => (s.picking && s.chats[s.picking]?.board === board ? s.picking : null));
  const kind = useStore((s) => s.pickFor);
  return chat ? { chat, kind } : null;
}

const WHITE_PAD = 20;

export function PickBar({ board, floating }: { board: string; floating?: boolean }) {
  const { tokens: t } = useTheme();
  const insets = useContext(SafeAreaInsetsContext);
  const wait = usePickWait(board);
  const name = useStore((s) => (wait ? chatTitle(s.chats[wait.chat], threadOf(s, wait.chat)?.items) : ""));
  const role = useStore((s) => s.roles[board]);
  const count = useStore((s) => selectedOn(s.selection.count, board, s.sel.board, s.roles[board]));
  if (!wait) return null;
  const m = pickBar(wait.kind, role, count, name);
  const b = m.button;
  const press = b.kind === "cancel" ? () => pickPoint(null) : b.kind === "add" ? () => finishSelect(wait.chat) : b.kind === "take" ? () => editHere(board) : undefined;
  const id = b.kind === "cancel" ? B2_TID.cancel : b.kind === "add" ? B2_TID.add : B2_TID.take;
  const e = floating ? floatEdges(insets) : null;
  const Icon = m.kind === "point" ? PointIcon : SelectionIcon;
  return (
    <View {...tid(B2_TID.bar, { kind: m.kind })} role="region" accessibilityLabel={`${m.title}, ${m.sub}`}
      style={[styles.bar, { backgroundColor: t.accentFill }, e && { height: BAND_HEIGHT + e.bottom, paddingBottom: e.bottom, paddingLeft: e.left + 16, paddingRight: e.right + 16 }]}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.icon}><Icon size={24} color={t.onAccent} /></View>
      <View style={styles.words}>
        <Text size={TYPE.control} weight="600" tone="onAccent" numberOfLines={1}>{m.title}</Text>
        <Text size={TYPE.secondary} tone="onAccent" numberOfLines={1}>{m.sub}</Text>
      </View>
      <Pressable {...tid(id, b.kind === "add" ? { count: b.count } : b.kind === "taking" ? { taking: true } : undefined)}
        accessibilityRole="button" accessibilityLabel={b.kind === "add" ? `Add, ${b.count} selected` : b.label} accessibilityState={{ disabled: b.kind === "add" ? b.off : b.kind === "taking" }}
        disabled={b.kind === "taking" || (b.kind === "add" && b.off)} onPress={press}
        style={[styles.button, { backgroundColor: t.onAccent }, (b.kind === "taking" || (b.kind === "add" && b.off)) && styles.off]}>
        {b.kind === "taking" ? <ActivityIndicator {...tid("board-role-spin")} size="small" color={t.accentFill} /> : null}
        <Text size={TYPE.control} weight="600" numberOfLines={1} style={{ color: t.accentFill }}>{b.label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, height: BAND_HEIGHT, zIndex: 6, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  icon: { width: 24, height: 24 },
  words: { flex: 1, minWidth: 0 },
  button: { minWidth: 88, height: 44, paddingHorizontal: WHITE_PAD, borderRadius: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  off: { opacity: 0.5 },
});
