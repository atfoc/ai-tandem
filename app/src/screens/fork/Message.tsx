// What forking adds to a message of the thread (the old page's fork/Message.tsx; B-FK-01 to B-FK-05, B-FK-22, B-LB-01 to B-LB-03): its actions, its label and its
// branch marker, drawn inside the message after its text (the chat view's `MessageExtras` part).
//
// The actions are a bar over the message's top right corner that shows while a mouse is over the message; with a finger there is no hover, so
// the message has a "⋯" button (`fk-more`) that opens the same actions as a menu (a popover on the tablet, a sheet on the phone: Overlay), each
// disabled one with its reason under it. Every control of the extras has a testID that starts with `fk-` (a reader of the message's words leaves
// those out: the actions' words are no part of what the message says, nor of what a quote takes).
//
// What does nothing now is disabled and says why (logic/waits.ts heldReason): the two that branch while a message that starts a new branch is on its
// way, the two that fork while a fork of the chat is being made, Branch and edit while the chat's composer uploads an image. Label is never held. A
// chat shown as it was (useOffWhy) offers none of them, Label neither; its marker, which opens the tree, and its label stay.
import { useRef, useState } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { messageActions } from "@aiwb/core/logic/forkpoints.ts";
import { labelAt, markerAt } from "@aiwb/core/logic/forktree.ts";
import { messageButtons, threadTree, viewFor, type MessageButton } from "@aiwb/core/logic/forkmessage.ts";
import { heldReason } from "@aiwb/core/logic/waits.ts";
import { forkChat, labelMessage, openTree, startMove } from "@aiwb/core/state/actions.ts";
import { isBusy, isLegacy, shownBranch, threadOf, viewedBranch } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { BranchIcon, MoreIcon } from "../../ui/icons.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { useOffWhy } from "../chat/index.ts";
import { LabelInput } from "./LabelInput.tsx";

const EMPTY: Item[] = [];

export function MessageExtras({ chat, index, item, hovered }: { chat: ChatView; index: number; item: Item; hovered: boolean }) {
  const t = useTokens(), pointer = usePointer();
  // The shown branch's full list, even while the thread is shown cut for a pending move.
  const items = useStore((s) => threadOf(s, chat.id)?.items) ?? EMPTY;
  const shown = useStore((s) => shownBranch(s, chat.id));
  const view = useStore((s) => viewFor(s.trees[chat.id], shownBranch(s, chat.id)));
  const waits = useStore((s) => s.waits[chat.id]);
  // where the chat's composer is: an upload of it holds Branch and edit
  const on = { branch: useStore((s) => viewedBranch(s, chat.id)), move: useStore((s) => !!s.moves[chat.id]) };
  const off = !!useOffWhy(chat.id);
  const [labeling, setLabeling] = useState(false);
  const [menu, setMenu] = useState(false);
  const more = useRef<View>(null);

  // chat is the view of the branch shown (shownView): its status is that branch's, not the chat's.
  // (a chat with no agent has no message: the kind given for it is never read)
  const acts = messageActions({ agent: chat.agent || "claude", items, index, busy: isBusy(chat.status), readOnly: !!chat.archived || isLegacy(chat) });
  const label = labelAt(view, shown, index);
  const marker = view && chat.agent ? markerAt(threadTree(view, shown, chat.agent, items), shown, index) : null;
  const buttons = off ? [] : messageButtons(acts, items, !!label);
  const typing = labeling && !off; // a label being typed as the server dropped goes: it could not be set
  if (!marker && !label && !buttons.length && !typing) return null;

  const user = item.kind === "user";
  const held = (b: MessageButton) => heldReason(waits, b.id, on);
  const run = (b: MessageButton) => {
    setMenu(false);
    if (b.id === "label") return setLabeling(true);
    if (b.at === undefined || held(b)) return;
    switch (b.id) {
      case "branchEdit": return void startMove(chat.id, { branch: shown, at: b.at, new: true }, index);
      case "branch": return void startMove(chat.id, { branch: shown, at: b.at, new: true });
      case "forkEdit": return void forkChat(chat.id, shown, b.at, index);
      case "fork": return void forkChat(chat.id, shown, b.at);
    }
  };
  const tone = user ? t.userText : t.accent;
  return (
    <>
      {marker && (
        <Pressable {...tid("fk-marker", { n: marker.n, m: marker.m })} role="button" accessibilityLabel={`Branch ${marker.n} of ${marker.m}`}
          onPress={() => openTree(chat.id, { branch: shown, item: index })} style={styles.marker}>
          {({ hovered: h }: { hovered?: boolean; pressed: boolean }) => (
            <>
              <View style={[styles.line, { backgroundColor: t.line2 }]} />
              <View style={[styles.chip, { backgroundColor: t.bg, borderColor: h ? t.accent : t.line2 }]}>
                <BranchIcon size={11} color={h ? t.accent : t.muted} />
                <Text size={11} tone={h ? "accent" : "muted"}>{`Branch ${marker.n} of ${marker.m}`}</Text>
              </View>
              <View style={[styles.line, { backgroundColor: t.line2 }]} />
            </>
          )}
        </Pressable>
      )}
      {label && !typing && (
        <View {...tid("fk-label-tag")} style={[styles.tag, { backgroundColor: user ? t.bg : t.accentSoft }, user && styles.tagUser]}>
          <Text size={10.5} weight="600" numberOfLines={1} style={{ color: tone }}>{`⚑ ${label}`}</Text>
        </View>
      )}
      {typing && (
        <View {...tid("fk-label-field")} style={[styles.field, { borderColor: t.line, backgroundColor: t.bg }]}>
          <LabelInput initial={label ?? ""} onDone={(v) => { if (v !== null && v !== (label ?? "")) void labelMessage(chat.id, shown, index, v); setLabeling(false); }} />
        </View>
      )}
      {buttons.length > 0 && !typing && pointer === "mouse" && hovered && (
        <View {...tid("fk-acts")} style={[styles.acts, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowSm } as ViewStyle]}>
          {buttons.map((b) => {
            const why = held(b);
            return (
              <Button key={b.id} {...tid("fk-act", { kind: b.id })} tone="ghost" size="sm" disabled={!!why} title={why || b.title} accessibilityLabel={b.text}
                icon={b.id === "branchEdit" || b.id === "branch" ? <BranchIcon size={11} color={t.muted} /> : b.id === "fork" || b.id === "forkEdit" ? <Text size={11.5} tone={why ? "faint" : "muted"}>⧉</Text> : undefined}
                onPress={() => run(b)}>
                <Text size={11.5} tone={why ? "faint" : "muted"}>{b.text}</Text>
              </Button>
            );
          })}
        </View>
      )}
      {buttons.length > 0 && !typing && pointer === "touch" && (
        <>
          <View ref={more} style={styles.more} collapsable={false}>
            <IconButton {...tid("fk-more")} size="sm" title="Message actions" onPress={() => setMenu(true)}>{(c) => <MoreIcon size={12} color={c} />}</IconButton>
          </View>
          <Overlay open={menu} kind="popover" label="Message actions" anchor={more} align="right" onClose={() => setMenu(false)}>
            <Menu label="Message actions">
              {buttons.map((b) => {
                const why = held(b);
                return (
                  <MenuItem key={b.id} {...tid("fk-act", { kind: b.id })} label={b.text} title={why || b.title} note={why || undefined} disabled={!!why} onPress={() => run(b)} />
                );
              })}
            </Menu>
          </Overlay>
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  acts: { position: "absolute", top: 2, right: 2, zIndex: 2, flexDirection: "row", gap: 1, padding: 2, borderWidth: 1, borderRadius: 7 },
  more: { position: "absolute", top: -9, right: 2, zIndex: 2 },
  marker: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, marginTop: 4, ...(webStyle({ userSelect: "none" }) as object) },
  line: { flex: 1, height: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 1, paddingHorizontal: 8, borderWidth: 1, borderRadius: 10 },
  tag: { alignSelf: "flex-start", maxWidth: "100%", marginTop: 3, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 0 },
  tagUser: { alignSelf: "flex-end" },
  field: { flexDirection: "row", marginTop: 4, padding: 4, borderWidth: 1, borderRadius: 8, minWidth: 220 },
});
