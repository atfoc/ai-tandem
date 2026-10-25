// The message sheet (ux-improvements goal 3.5): a long press on a message on the phone lifts the message over the dimmed thread and opens one P1
// sheet that names it with an excerpt. A quick row, Copy, Quote, Read aloud and Select text, and under it the fork actions as rows that say what
// they do (Branch and edit leads on the person's own message); an action that must wait stays, faded, with its reason. It replaces the "⋯" and
// the actions menu the finger had on the message. The sheet is always mounted (the shell's `Overlays` slot) and shows itself while a message is held.
import { useSyncExternalStore, type ReactNode } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import { agentShortName } from "@aiwb/core/agents.ts";
import { shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { copyText } from "../../platform/clipboard";
import { useStore } from "../../state/useStore.ts";
import { ActionSheet, type ActionItem } from "../../ui/ActionSheet.tsx";
import { BranchIcon, Pencil, SpeakerIcon, StopIcon } from "../../ui/icons.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { T1_TID } from "../chat/ids.ts";
import { useChatParts, useOffWhy } from "../chat/index.ts";
import { blocksOf, displayedTextOf, Markdown, prepare } from "../markdown/index.ts";
import { inGrace, openPick } from "../quotes/sheetstore.ts";
import { whyNotQuotable } from "../quotes/model.ts";
import { closeMessageSheet, excerpt, forkWords, messageSheetNow, subscribeMessageSheet, type HeldRect } from "./msgsheet.ts";
import { useMessageForks } from "./Message.tsx";

/** The sheet, always mounted: it shows itself while a message is held. */
export function MessageSheet() {
  const held = useSyncExternalStore(subscribeMessageSheet, messageSheetNow);
  const chat = useStore((s) => (held ? shownView(s, held.chat) : undefined));
  const item = useStore((s) => (held ? threadOf(s, held.chat)?.items[held.index] : undefined));
  if (!held || !chat || !item) return null;
  return <Held key={`${held.chat}:${held.index}`} chat={chat} index={held.index} item={item} rect={held.rect} />;
}

/** An icon that is a glyph of the text font (the kit's icons have no Copy, Quote or Select). */
function Glyph({ children, tone = "muted" }: { children: string; tone?: "muted" | "faint" }) {
  return <Text size={TYPE.control} tone={tone}>{children}</Text>;
}

function Held({ chat, index, item, rect }: { chat: ChatView; index: number; item: Item; rect: HeldRect | null }) {
  const t = useTokens();
  const { shown, buttons, held, run, user } = useMessageForks(chat, index, item);
  const read = useChatParts().useReadAloud(chat, shown, index, item);
  const off = useOffWhy(chat.id);
  const sub = excerpt(blocksOf(item.text ?? "", false).map((b) => displayedTextOf(prepare(b, user), false)).join(" "));
  // what keeps the message from being quoted now (the same rules as the Quote sheet's)
  const quoteWhy = off || (chat.archived ? "Archived — unarchive to continue" : "") || whyNotQuotable(item);

  // The finger that held the message may still be down and its lifting may click the dimmed page: that closes nothing (as with the Quote sheet).
  // A row closes the sheet itself, before it acts, which the grace does not hold back.
  const onClose = () => { if (!inGrace()) closeMessageSheet(); };
  const then = (a: ActionItem): ActionItem => ({ ...a, onPress: () => { closeMessageSheet(); a.onPress(); } });

  const quick: ActionItem[] = [
    { id: "copy", label: "Copy", icon: <Glyph>⧉</Glyph>, onPress: () => {
      // the toast says what happened: a browser may refuse the clipboard (no permission), and then nothing was copied
      copyText(item.text ?? "").then(() => showToast({ text: "Copied" }), (e) => { console.error(e); showToast({ text: "Couldn't copy", kind: "copy-failed" }); });
    } },
    { id: "quote", label: "Quote", icon: <Glyph>❝</Glyph>, waitReason: quoteWhy || undefined, onPress: () => openPick(chat.id, index, "quote") },
  ];
  if (read) {
    quick.push({ id: "read", label: read.title, icon: read.reading ? <StopIcon size={14} color={t.muted} /> : <SpeakerIcon size={16} color={t.muted} />, onPress: read.run });
  }
  quick.push({ id: "select", label: "Select text", icon: <Glyph>I</Glyph>, onPress: () => openPick(chat.id, index, "select") });

  const items: ActionItem[] = buttons.map((b) => {
    const why = held(b);
    const w = forkWords(b);
    const icon: ReactNode = b.id === "branchEdit" ? <Pencil size={16} color={why ? t.faint : t.muted} />
      : b.id === "branch" ? <BranchIcon size={16} color={why ? t.faint : t.muted} />
      : b.id === "label" ? <Glyph tone={why ? "faint" : "muted"}>⚑</Glyph>
      : <Glyph tone={why ? "faint" : "muted"}>⊕</Glyph>;
    return { id: b.id, label: w.label, note: w.note, icon, waitReason: why || undefined, onPress: () => run(b) };
  });

  const title = user ? "Your message" : `Message from ${agentShortName(chat.agent || "claude")}`;
  return (
    <ActionSheet open onClose={onClose} testID={T1_TID.messageSheet} head={{ title, sub: sub || undefined }} quick={quick.map(then)} items={items.map(then)}
      lift={rect ? <Lifted item={item} chat={chat} rect={rect} /> : undefined} />
  );
}

/** The sheet is never taller than this share of the window (Sheet's `fit` detent): the lifted message stays above it. */
const SHEET_SHARE = 0.5;
/** The card's room around the message's words, and the least gap to the window's top. */
const PAD = 8, EDGE = 8;

/** The held message, drawn where it was in the thread as a card over the dimmed page: its words as the thread draws them. */
function Lifted({ item, chat, rect }: { item: Item; chat: ChatView; rect: HeldRect }) {
  const t = useTokens();
  const win = useWindowDimensions();
  const user = item.kind === "user";
  // a reply's card is a little wider and taller than its words; the person's bubble is its own card. It is as tall as its words, at most the
  // message's place (which has the marker and the label under the words too).
  const pad = user ? 0 : PAD;
  const width = Math.ceil(rect.width) + 2 * pad;
  const limit = Math.round(win.height * SHEET_SHARE) - EDGE;
  const height = Math.min(rect.height + 2 * pad, limit - EDGE);
  // over the sheet when the message was low in the window: moved up above it
  const top = Math.max(EDGE, Math.min(rect.y - pad, limit - height));
  // The bubble hugs its words and sits at the right: it keeps its right edge and may grow to the left if its words come out wider than the thread
  // drew them; a reply keeps its left edge and width.
  // The card never leaves the window: a reply that the thread draws flush with the edge has its padding taken from the card's width instead.
  const left = Math.max(EDGE / 2, rect.x - pad);
  const place = user ? { right: win.width - (rect.x + rect.width), minWidth: width, maxWidth: win.width } : { left, width: Math.min(width, win.width - left - EDGE / 2) };
  return (
    <View {...tid(T1_TID.messageLift)} pointerEvents="none"
      style={[styles.card, user ? styles.user : styles.reply, { ...place, top, maxHeight: height, backgroundColor: user ? t.accentSoft : t.bg, borderColor: t.line, boxShadow: t.shadowLg } as object]}>
      {user
        ? <Markdown text={item.text ?? ""} user board={chat.board} agent={chat.agent} of={chat.id} color={t.userText} size={TYPE.body} phone />
        : <Markdown text={item.text ?? ""} board={chat.board} agent={chat.agent} of={chat.id} size={TYPE.body} phone />}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", overflow: "hidden", minWidth: 0 },
  reply: { borderWidth: 1, borderRadius: 16, paddingVertical: PAD + 2, paddingHorizontal: PAD + 2 },
  user: { paddingVertical: 7, paddingHorizontal: 11, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomRightRadius: 3, borderBottomLeftRadius: 12 },
});
