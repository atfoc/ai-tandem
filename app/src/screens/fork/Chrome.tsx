// The marks of a chat's branches around the thread (the old page's fork/Chrome.tsx, TreeButton.tsx): the header's branch name (HeaderCrumb), its line about
// the other branches and its Tree button (HeaderTail), and the banner between the thread and the composer (Banner). The sidebar's badge is S1's.
import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { bannerOf, bannerPlain, bannerText } from "@aiwb/core/logic/branchview.ts";
import { buildTree, nameOfBranch, withLive, type ChatTree } from "@aiwb/core/logic/forktree.ts";
import { threadTree, viewFor } from "@aiwb/core/logic/forkmessage.ts";
import { alertsOf, alertText, otherBranches } from "@aiwb/core/logic/labels.ts";
import { heldReason, sendHeld } from "@aiwb/core/logic/waits.ts";
import { back, openTree, viewBranch } from "@aiwb/core/state/actions.ts";
import { branchCount, branchState, composerAt, shownBranch, statesOfChat, threadOf, viewedBranch } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BranchIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useLayout } from "../../ui/useLayout.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useOffWhy } from "../chat/index.ts";
import { treeKey } from "./treekey.ts";

/** The chat's tree as the thread's messages read it (the shown branch's own part is its live items, once the list is there); undefined until
 *  the tree has the branch asked for. */
export function useLiveTree(chatId: string, branch: string): ChatTree | undefined {
  const agent = useStore((s) => s.chats[chatId]?.agent);
  const shown = useStore((s) => shownBranch(s, chatId));
  const items = useStore((s) => threadOf(s, chatId)?.items);
  const view = useStore((s) => viewFor(s.trees[chatId], branch));
  if (!view || !agent) return undefined;
  return items && viewFor(view, shown) ? threadTree(view, shown, agent, items) : buildTree(view);
}

/** The name of the branch the chat is on here (the one viewed, whatever the server's current one is), once it has split: the last of
 *  the header's second line, " · ⑂ name" (B-FK-23). */
export function BranchCrumb({ chat }: { chat: string }) {
  const t = useTokens();
  const c = useStore((s) => s.chats[chat]);
  const viewed = useStore((s) => viewedBranch(s, chat));
  const tree = useLiveTree(chat, viewed);
  if (!c || branchCount(c) < 2 || !tree) return null;
  return <>{" · "}<Text {...tid("fk-crumb")} size={11.5} tone="accent"><BranchIcon size={11} color={t.accent} /> {nameOfBranch(tree, viewed)}</Text></>;
}

/** The header's end, before the ×: what the other branches of the chat need or do, and the Tree button. A branch that is not the one the
 *  chat is on waits for approval, or else one whose turn could not start or ended in an error (the pill puts the chat on it) and, quietly,
 *  how many others work (it opens the tree). Nothing when there is nothing to tell. While a message that starts a new branch is on its way,
 *  and in a chat shown as it was, the two that would put the chat on another branch are disabled and say why (B-FK-25, B-FK-26). */
export function HeaderTail({ chat }: { chat: string }) {
  return (
    <View {...tid("fk-tail")} style={styles.tail}>
      <BranchAlert chatId={chat} />
      <TreeButton chatId={chat} />
    </View>
  );
}

function BranchAlert({ chatId }: { chatId: string }) {
  const t = useTokens();
  const layout = useLayout();
  const off = useOffWhy(chatId);
  const held = useStore((s) => heldReason(s.waits[chatId], "alert", composerAt(s, chatId))) || off;
  const viewed = useStore((s) => viewedBranch(s, chatId));
  const states = useStore((s) => statesOfChat(s, chatId));
  const o = useMemo(() => otherBranches(states, viewed), [states, viewed]);
  const tree = useLiveTree(chatId, o.asks ?? o.failed ?? viewed);
  const name = (b: string) => (tree ? nameOfBranch(tree, b) : "another branch");
  return (
    <>
      {alertsOf(o).map((kind) => {
        const to = kind === "asks" ? o.asks : kind === "failed" ? o.failed : null;
        const text = alertText(o, kind, name);
        const press = to !== null ? () => void viewBranch(chatId, to) : () => openTree(chatId);
        const title = to !== null ? held || "Show that branch" : "Show the chat's tree";
        const disabled = to !== null && !!held; // (the count that opens the tree stays live)
        return (
          <Alert key={kind} kind={kind === "working" ? "quiet" : kind} title={title} disabled={disabled} onPress={press}
            colours={kind === "asks" ? { border: t.warn, bg: t.warnSoft } : kind === "failed" ? { border: t.danger, bg: t.dangerSoft } : null}
            max={layout === "phone" ? 120 : 220} text={text} />
        );
      })}
    </>
  );
}

function Alert({ kind, title, disabled, onPress, colours, max, text }: {
  kind: "asks" | "failed" | "quiet"; title: string; disabled: boolean; onPress: () => void; colours: { border: string; bg: string } | null; max: number; text: string;
}) {
  const t = useTokens();
  const tip = useControlRef(title);
  return (
    <Pressable {...tid("fk-alert", { kind })} ref={tip} role="button" accessibilityLabel={text} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.alert, { maxWidth: max }, colours && { borderWidth: 1, borderColor: colours.border, backgroundColor: colours.bg },
        disabled && styles.alertOff, webStyle({ cursor: disabled ? "default" : "pointer", textDecorationLine: hovered && !disabled ? "underline" : "none" }),
      ]}>
      <Text numberOfLines={1} size={11.5} weight={colours ? "600" : undefined} tone={colours ? "text" : "muted"}>{text}</Text>
    </Pressable>
  );
}

/** Tree, with the branch count once the chat has split. Every chat has it, archived and legacy ones too (B-TR-01, B-FK-24). */
function TreeButton({ chatId }: { chatId: string }) {
  const t = useTokens();
  const n = useStore((s) => branchCount(s.chats[chatId]));
  return (
    <Button {...tid("fk-tree-btn", { count: n > 1 ? n : undefined })} tone="ghost" size="sm" title={`Chat tree (${treeKey()})`} accessibilityLabel="Chat tree" onPress={() => openTree(chatId)}
      icon={<BranchIcon size={12} color={t.muted} />}>
      <Text size={12} tone="muted">Tree</Text>
      {n > 1 && <View style={[styles.pill, { backgroundColor: t.accentSoft }]}><Text size={10.5} weight="600" tone="accent">{n}</Text></View>}
    </Button>
  );
}

/** The pending move, between the thread and the composer: where the next message goes, and Back. The branch the chat is on stays as it is:
 *  the Send stops nothing. While the move's own Send is in flight the banner says that the message is being sent, and Back, which does nothing
 *  then, is disabled and says why; so it is while the chat's composer uploads an image, and in a chat shown as it was (useOffWhy). When the branch the
 *  chat is on waits for approval, its card is not in the thread shown for the move: the banner says so (B-FK-07, B-FK-09, B-FK-10). */
export function Banner({ chat }: { chat: string }) {
  const t = useTokens();
  const c = useStore((s) => s.chats[chat]);
  const move = useStore((s) => s.moves[chat]);
  const items = useStore((s) => threadOf(s, chat)?.items);
  const tree = useStore((s) => s.trees[chat]);
  const asks = useStore((s) => { const m = s.moves[chat]; return !!m && branchState(s, chat, m.from)?.status === "approval"; });
  const sending = useStore((s) => sendHeld(s.waits[chat]));
  const off = useOffWhy(chat);
  const held = useStore((s) => heldReason(s.waits[chat], "back", composerAt(s, chat))) || off;
  const text = useMemo(() => {
    const view = move && viewFor(viewFor(tree, move.branch), move.from);
    if (!c || !c.agent || !move || !items || !view) return bannerPlain(sending);
    const tr = buildTree(withLive(view, move.branch, c.agent, items), { branch: move.branch, count: move.at });
    return bannerText(bannerOf(tr, move, items, move.from, asks), sending);
  }, [c?.agent, asks, move, items, tree, sending]);
  if (!c || !move) return null;
  return (
    <View style={[styles.bannerOuter, { paddingHorizontal: c.board ? 14 : 20 }]}>
      <View {...tid("fk-banner", { sending })} style={[styles.banner, { backgroundColor: t.accentSoft }]}>
        <BranchIcon size={12} color={t.accent} />
        <Text {...tid("fk-banner-text")} size={12} style={styles.bannerText}>{text}</Text>
        <Button {...tid("fk-back")} tone="ghost" size="sm" label="Back" disabled={!!held} title={held || "Go back to where you were"} onPress={() => back(chat)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tail: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  alert: { flexShrink: 1, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 9 },
  alertOff: { opacity: 0.55 },
  pill: { borderRadius: 999, paddingHorizontal: 6, minWidth: 16, alignItems: "center" },
  bannerOuter: { paddingBottom: 6 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5, paddingLeft: 10, paddingRight: 6, borderRadius: 8 },
  bannerText: { flex: 1, minWidth: 0 },
});
