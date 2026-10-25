// What forking adds to a message of the thread (the old page's fork/Message.tsx; B-FK-01 to B-FK-05, B-FK-22, B-LB-01 to B-LB-03): its actions, its label and its
// branch marker, drawn inside the message after its text (the chat view's `MessageExtras` part).
//
// The actions are a bar over the message's top right corner that shows while a mouse is over the message; with a finger there is no hover, so
// the message has a "⋯" button (`fk-more`) that opens the same actions as a popover menu, each disabled one with its reason under it. On the phone
// neither is drawn: a long press on the message opens the message sheet (MessageSheet.tsx), which has these actions among its rows. Every control
// of the extras has a testID that starts with `fk-` (a reader of the message's words leaves those out: the actions' words are no part of what the
// message says, nor of what a quote takes).
//
// Read aloud (voice, VC-24) is one more action of the bar and the menu, last, on a user message and on a reply that is written: the chat view's
// `useReadAloud` part gives it (or null), so this file does not know voice's engine. Reading needs no server, so it is offered also where no
// fork action is (a chat shown as it was, an archived one, a read-only one). While the message is read its control says "End reading" and a
// chip (`voice-reading`, under the message's words, at the right) stays on the message, hovered or not, until the reading ends; while the reading is
// paused (the headphones went away, voice devices VD-12) a second chip, Continue reading (`voice-reading-continue`), stands beside it; a failure hangs the
// problem popover from the message's top right corner (the bar is gone when the pointer leaves it).
//
// What does nothing now is disabled and says why (logic/waits.ts heldReason): the two that branch while a message that starts a new branch is on its
// way, the two that fork while a fork of the chat is being made, Branch and edit while the chat's composer uploads an image. Label is never held. A
// chat shown as it was (useOffWhy) offers none of them, Label neither; its marker, which opens the tree, and its label stay.
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
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
import { BranchIcon, MoreIcon, Pencil, SpeakerIcon, StopIcon } from "../../ui/icons.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { READ_CONTINUE } from "../../voice/words.ts";
import { useChatParts, useOffWhy } from "../chat/index.ts";
import { ReadAloudProblem } from "../voice/index.ts";
import { BranchPill } from "./BranchPill.tsx";
import { LabelInput } from "./LabelInput.tsx";
import { isLabeling, startLabel, stopLabel, subscribeLabel } from "./msgsheet.ts";

const EMPTY: Item[] = [];

/** What forking offers on a message and what a press on one does: shared by the mouse's bar and the tablet's menu (below) and the phone's message sheet. */
export function useMessageForks(chat: ChatView, index: number, item: Item) {
  // The shown branch's full list, even while the thread is shown cut for a pending move.
  const items = useStore((s) => threadOf(s, chat.id)?.items) ?? EMPTY;
  const shown = useStore((s) => shownBranch(s, chat.id));
  const view = useStore((s) => viewFor(s.trees[chat.id], shownBranch(s, chat.id)));
  const waits = useStore((s) => s.waits[chat.id]);
  // where the chat's composer is: an upload of it holds Branch and edit
  const on = { branch: useStore((s) => viewedBranch(s, chat.id)), move: useStore((s) => !!s.moves[chat.id]) };
  const off = !!useOffWhy(chat.id);
  // chat is the view of the branch shown (shownView): its status is that branch's, not the chat's.
  // (a chat with no agent has no message: the kind given for it is never read)
  const acts = messageActions({ agent: chat.agent || "claude", items, index, busy: isBusy(chat.status), readOnly: !!chat.archived || isLegacy(chat) });
  const label = labelAt(view, shown, index);
  const tree = view && chat.agent ? threadTree(view, shown, chat.agent, items) : null;
  const marker = tree ? markerAt(tree, shown, index) : null;
  const buttons = off ? [] : messageButtons(acts, items, !!label);
  const held = (b: MessageButton) => heldReason(waits, b.id, on);
  const run = (b: MessageButton) => {
    if (b.id === "label") return startLabel(chat.id, index);
    if (b.at === undefined || held(b)) return;
    switch (b.id) {
      case "branchEdit": return void startMove(chat.id, { branch: shown, at: b.at, new: true }, index);
      case "branch": return void startMove(chat.id, { branch: shown, at: b.at, new: true });
      case "forkEdit": return void forkChat(chat.id, shown, b.at, index);
      case "fork": return void forkChat(chat.id, shown, b.at);
    }
  };
  return { shown, off, label, marker, tree, buttons, held, run, user: item.kind === "user" };
}

/** Whether the label field is open on the message (the sheet's Label… row opens it too). */
export const useLabeling = (chat: string, index: number): boolean =>
  useSyncExternalStore(subscribeLabel, () => isLabeling(chat, index));

export function MessageExtras({ chat, index, item, hovered }: { chat: ChatView; index: number; item: Item; hovered: boolean }) {
  const t = useTokens(), pointer = usePointer(), phone = usePhone();
  const { shown, off, label, marker, tree, buttons, held, run: runFork, user } = useMessageForks(chat, index, item);
  const labeling = useLabeling(chat.id, index);
  const [menu, setMenu] = useState(false);
  const [compact, setCompact] = useState(false); // the mouse's bar with icons alone: its words do not fit the thread
  const more = useRef<View>(null);
  const read = useChatParts().useReadAloud(chat, shown, index, item);
  // The mouse's bar is as wide as its buttons and grows to the left over a message narrower than they are, but never past the left edge of the
  // message's row (the thread's content): in a narrow pane, as the chat panel beside a board, it would lie over the sidebar and its resizer. Then
  // the buttons keep their icons alone (their words are the titles), so the bar stays one line, which the next message does not cover. The row is the
  // message's parent (a reply is as wide as it; the person's short message is not). A bar is drawn anew at each hover, so it is measured at each.
  const fitBar = useCallback((el: View | null) => {
    const bar = el as unknown as HTMLElement | null, msg = bar?.parentElement, row = msg?.parentElement;
    if (!bar?.getBoundingClientRect || !msg || !row) { if (!el) setCompact(false); return; }
    setCompact(bar.getBoundingClientRect().width > msg.getBoundingClientRect().right - 2 - row.getBoundingClientRect().left);
  }, []);

  const typing = labeling && !off; // a label being typed as the server dropped goes: it could not be set
  if (!marker && !label && !buttons.length && !typing && !read) return null;
  const actions = buttons.length > 0 || !!read;

  const run = (b: MessageButton) => { setMenu(false); runFork(b); };
  const tone = user ? t.userText : t.accent;
  const readTitle = read?.title ?? "";
  const readIcon = read?.reading ? <StopIcon size={11} color={t.muted} /> : <SpeakerIcon size={12} color={t.muted} />;
  // The finger's "⋯" is where the popover hangs from; a mouse has the corner, which stays when the bar goes.
  const setMore = (el: View | null) => { more.current = el; if (read && pointer === "touch" && !phone) read.anchor.current = el; };
  return (
    <>
      {marker && tree && phone && !user && <BranchPill chat={chat.id} shown={shown} index={index} tree={tree} n={marker.n} m={marker.m} />}
      {marker && !(tree && phone) && (
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
          <Text size={phone ? 13 : 10.5} weight="600" numberOfLines={1} style={{ color: tone }}>{`⚑ ${label}`}</Text>
        </View>
      )}
      {typing && (
        <View {...tid("fk-label-field")} style={[styles.field, { borderColor: t.line, backgroundColor: t.bg }]}>
          <LabelInput initial={label ?? ""} onDone={(v) => { if (v !== null && v !== (label ?? "")) void labelMessage(chat.id, shown, index, v); stopLabel(chat.id, index); }} />
        </View>
      )}
      {read && (pointer !== "touch" || phone) && <View ref={read.anchor} pointerEvents="none" collapsable={false} style={styles.corner} />}
      {read?.reading && !typing && (
        <View style={styles.readings}>
          {read.paused && (
            <Pressable {...tid("voice-reading-continue")} role="button" accessibilityLabel={READ_CONTINUE} onPress={read.resume}
              style={[styles.reading, { backgroundColor: t.accent, borderColor: t.accent }]}>
              <Text size={11} tone="onAccent">{READ_CONTINUE}</Text>
            </Pressable>
          )}
          <Pressable {...tid("voice-reading", { paused: read.paused || undefined })} role="button" accessibilityLabel={readTitle} onPress={read.run}
            style={[styles.reading, { backgroundColor: t.bg, borderColor: t.accent }]}>
            <StopIcon size={10} color={t.accent} />
            <Text size={11} tone="accent">{readTitle}</Text>
          </Pressable>
        </View>
      )}
      {actions && !typing && pointer === "mouse" && hovered && (
        <View {...tid("fk-acts")} ref={fitBar} style={[styles.acts, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowSm } as ViewStyle]}>
          {buttons.map((b) => {
            const why = held(b);
            return (
              <Button key={b.id} {...tid("fk-act", { kind: b.id })} tone="ghost" size="sm" disabled={!!why} title={compact ? `${b.text}: ${why || b.title}` : why || b.title} accessibilityLabel={b.text}
                icon={b.id === "branchEdit" || b.id === "branch" ? <BranchIcon size={11} color={t.muted} /> : b.id === "fork" || b.id === "forkEdit" ? <Text size={11.5} tone={why ? "faint" : "muted"}>⧉</Text> : compact ? <Pencil size={11} color={t.muted} /> : undefined}
                onPress={() => run(b)}>
                {!compact && <Text size={11.5} tone={why ? "faint" : "muted"}>{b.text}</Text>}
              </Button>
            );
          })}
          {read && (
            <Button {...tid("fk-act", { kind: "read", reading: read.reading })} tone="ghost" size="sm" title={readTitle} accessibilityLabel={readTitle} icon={readIcon} onPress={read.run}>
              {!compact && <Text size={11.5} tone="muted">{readTitle}</Text>}
            </Button>
          )}
        </View>
      )}
      {actions && !typing && pointer === "touch" && !phone && ( // (a finger on the phone has the message sheet)
        <>
          <View ref={setMore} style={styles.more} collapsable={false}>
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
              {read && <MenuItem {...tid("fk-act", { kind: "read", reading: read.reading })} label={readTitle} icon={readIcon} onPress={() => { setMenu(false); read.run(); }} />}
            </Menu>
          </Overlay>
        </>
      )}
      {read && <ReadAloudProblem chat={chat.id} branch={shown} index={index} target={read.anchor} />}
    </>
  );
}

const styles = StyleSheet.create({
  // (width: the bar is as wide as its buttons even over a message narrower than they are, a short sentence of the person's, and grows to the left)
  acts: { position: "absolute", top: 2, right: 2, zIndex: 2, flexDirection: "row", gap: 1, padding: 2, borderWidth: 1, borderRadius: 7, ...(webStyle({ width: "max-content" }) as object) },
  more: { position: "absolute", top: -9, right: 2, zIndex: 2 },
  corner: { position: "absolute", top: 2, right: 2, width: 1, height: 26 },
  readings: { alignSelf: "flex-end", marginTop: 4, flexDirection: "row", alignItems: "center", gap: 6 },
  reading: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2, paddingHorizontal: 8, borderWidth: 1, borderRadius: 10 },
  marker: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, marginTop: 4, ...(webStyle({ userSelect: "none" }) as object) },
  line: { flex: 1, height: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 1, paddingHorizontal: 8, borderWidth: 1, borderRadius: 10 },
  tag: { alignSelf: "flex-start", maxWidth: "100%", marginTop: 3, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 0 },
  tagUser: { alignSelf: "flex-end" },
  field: { flexDirection: "row", marginTop: 4, padding: 4, borderWidth: 1, borderRadius: 8, minWidth: 220 },
});

/** Under a user's bubble on the phone (the chat view's `MessageBelow` part): the "‹ Branch 1 of 2 ›" pill of a message that branched, outside the bubble
 *  as the mockup draws it. A reply has no bubble: its pill stays in MessageExtras. */
export function MessageBelow({ chat, index, item }: { chat: ChatView; index: number; item: Item }) {
  const { shown, marker, tree } = useMessageForks(chat, index, item);
  if (!marker || !tree) return null;
  return <BranchPill chat={chat.id} shown={shown} index={index} tree={tree} n={marker.n} m={marker.m} />;
}
