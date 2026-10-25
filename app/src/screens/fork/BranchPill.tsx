// "‹ Branch 1 of 2 ›" under a message that branched, on the phone (the marker's shape there; the wide marker is a line with a chip, in Message.tsx): a pill at the
// message's right. The arrows put the chat on the previous or next branch at the split in place, and the middle opens the tree at the message, as the marker does.
// Where the sibling is shown is the tree's to say (logic/forktree.ts siblingTarget). The thread is drawn anew for the other branch (it starts at its end), so the
// message with the pill is brought back into view once that branch is shown. What holds another branch from being opened (a message on its way, an upload of the
// composer, a chat shown as it was) disables the arrows and is the pill's accessibility hint (the web's page has it as `data-held`); the middle stays live, for the tree opens read only then.
import { Pressable, StyleSheet, View } from "react-native";

import { siblingTarget, type ChatTree } from "@aiwb/core/logic/forktree.ts";
import { heldReason } from "@aiwb/core/logic/waits.ts";
import { openTree, viewBranch } from "@aiwb/core/state/actions.ts";
import { composerAt } from "@aiwb/core/state/store.ts";

import { haptic } from "../../platform/haptics";
import { useStore } from "../../state/useStore.ts";
import { BranchIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useOffWhy } from "../chat/index.ts";
import { threadScroller } from "../chat/threadscroll.ts";
import { PILL_TID } from "./ids.ts";

const WIDTH = 150, HEIGHT = 36, ARROW = 30;
const SLOP = (PHONE.target - HEIGHT) / 2;
const TRIES = 20;

/** Brings the message at `index` back to the middle of the thread once the branch just put on is drawn: the list is made anew for a branch, and the
 *  scroller of the new one is registered a moment after it. */
function bringBack(chat: string, index: number, tries = TRIES): void {
  if (threadScroller(chat)?.toItem(index, false) || tries <= 0) return;
  setTimeout(() => bringBack(chat, index, tries - 1), 50);
}

export function BranchPill({ chat, shown, index, tree, n, m }: { chat: string; shown: string; index: number; tree: ChatTree; n: number; m: number }) {
  const t = useTokens();
  const off = useOffWhy(chat);
  const held = useStore((s) => heldReason(s.waits[chat], "open", composerAt(s, chat))) || off;
  const word = `Branch ${n} of ${m}`;
  const to = (dir: -1 | 1) => siblingTarget(tree, shown, index, dir);
  const prev = to(-1), next = to(1);
  const go = (target: { branch: string; index: number } | null) => {
    if (!target || held) return;
    haptic("select");
    void viewBranch(chat, target.branch).then(() => bringBack(chat, target.index));
  };
  const arrow = (id: string, glyph: string, label: string, target: { branch: string; index: number } | null, side: "left" | "right") => {
    const disabled = !target || !!held;
    return (
      <Pressable {...tid(id, { disabled })} role="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled}
        hitSlop={{ top: SLOP, bottom: SLOP, [side]: PHONE.target - ARROW }} onPress={() => go(target)}
        style={[styles.arrow, webStyle({ cursor: disabled ? "default" : "pointer", userSelect: "none" })]}>
        <Text size={22} style={{ color: t.accent, opacity: disabled ? 0.35 : 1, lineHeight: 26 }}>{glyph}</Text>
      </Pressable>
    );
  };
  return (
    <View {...tid("fk-marker", { n, m, held: held || undefined })} accessibilityLabel={word} accessibilityHint={held || undefined} style={[styles.pill, { backgroundColor: t.panel, borderColor: t.line2 }]}>
      {arrow(PILL_TID.prev, "‹", "Previous branch", prev, "left")}
      <Pressable {...tid(PILL_TID.open)} role="button" accessibilityLabel={`${word}, open the chat tree`} hitSlop={{ top: SLOP, bottom: SLOP }}
        onPress={() => openTree(chat, { branch: shown, item: index })} style={[styles.open, webStyle({ cursor: "pointer", userSelect: "none" })]}>
        <BranchIcon size={TYPE.secondary} color={t.muted} />
        <Text size={TYPE.secondary} tone="muted" numberOfLines={1}>{word}</Text>
      </Pressable>
      {arrow(PILL_TID.next, "›", "Next branch", next, "right")}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: "flex-end", flexDirection: "row", alignItems: "center", height: HEIGHT, minWidth: WIDTH, marginTop: 8, borderWidth: 1, borderRadius: HEIGHT / 2 },
  arrow: { width: ARROW, height: HEIGHT, alignItems: "center", justifyContent: "center" },
  open: { flex: 1, height: HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
});
