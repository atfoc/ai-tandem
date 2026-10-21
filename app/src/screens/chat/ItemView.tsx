// One item of a thread (the old page's ChatView.tsx's ItemView, UserSaid and the sent quotes of Quotes.tsx): a message of the user, the agent's
// reply, a note; the tool cards, permission cards and subagent rows are the parts other packages fill (parts.tsx).
//
// The chat's messages and replies carry their place in the thread (`dataSet.item`), which is what makes them quotable (K5); the
// drawer's (`sub`) have none. A message's fork actions, label and branch marker (S8) are drawn inside it, after its text.
import { memo } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { isSubagentTool } from "@aiwb/core/logic/subagents.ts";
import { quotable } from "@aiwb/core/logic/quotes.ts";
import { showsText, type Said } from "@aiwb/core/logic/messageimages.ts";
import type { ChatView, Item, Reference, Subagent } from "@aiwb/core/types.ts";

import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useHovered } from "../../ui/useHovered";
import { Markdown } from "../markdown/index.ts";
import { Caret } from "./Dots.tsx";
import { alpha } from "./colour.ts";
import { useWhere } from "./hooks.ts";
import { useChatParts } from "./parts.tsx";

/** One item of a thread: the chat's (index: its place in the thread), or a subagent's (sub) in the drawer. readOnly: the item is in the
 *  part copied from the thread's source (or in the thread of a subagent started there), so it offers no control that acts on the
 *  session. */
export const ItemView = memo(function ItemView({ item, chat, branch, sub, index, readOnly }: { item: Item; chat: ChatView; branch: string; sub?: Subagent; index?: number; readOnly?: boolean }) {
  const t = useTokens(), parts = useChatParts();
  const [track, hovered] = useHovered(); // the pointer over the message: its fork actions show
  const live = sub ? sub.status === "running" && !sub.waiting : true; // a waiting subagent's turn has ended
  const tag = sub ? undefined : index;
  const q = tag === undefined ? undefined : String(quotable(item));
  const hold = parts.useMessageHold(chat, tag, item); // a long press opens the Quote sheet where the platform has no selection of its own (K5)
  switch (item.kind) {
    case "user": return (
      <View ref={track} {...hold.props} {...tid("msg", { role: "user", item: tag, quotable: q })} style={[styles.user, { backgroundColor: t.accentSoft }, hold.style]}>
        <UserSaid chat={chat} said={item} />
        {tag !== undefined && <parts.MessageMark chat={chat} index={tag} item={item} />}
        {tag !== undefined && <parts.MessageExtras chat={chat} index={tag} item={item} hovered={hovered} />}
        {tag !== undefined && <parts.MessageFlash chat={chat.id} index={tag} />}
      </View>
    );
    case "text": {
      const streaming = !item.done && (sub ? live : chat.status === "writing");
      return (
        <View ref={track} {...hold.props} {...tid("msg", { role: "assistant", item: tag, quotable: q, streaming })} style={[styles.assistant, hold.style]}>
          <Markdown text={item.text ?? ""} board={chat.board} agent={chat.agent} of={chat.id} streaming={streaming} />
          {streaming && !item.text?.trim() && <View style={styles.caret}><Caret /></View>}
          {tag !== undefined && <parts.MessageExtras chat={chat} index={tag} item={item} hovered={hovered} />}
          {tag !== undefined && <parts.MessageFlash chat={chat.id} index={tag} />}
        </View>
      );
    }
    case "tool": return isSubagentTool(item) ? <parts.SubagentRow item={item} chat={chat} within={sub} /> : <parts.ToolCard item={item} chat={chat} live={live} />;
    case "perm": return <parts.PermCard item={item} chat={chat} branch={branch} closed={readOnly} />;
    case "note": return item.text ? <Text {...tid("note", { tone: item.tone ?? "muted" })} size={12} tone={item.tone === "error" ? "danger" : "muted"} style={styles.note}>{item.text}</Text> : null;
    case "subresult": return <parts.SubResultRow item={item} chat={chat} />;
    case "end": return null; // the mark after a turn: never drawn
  }
  return null;
});

/** What a user message says, top to bottom: its quotes, its images, its words. A message of quotes or of images alone draws no words
 *  (showsText). The images are fetched from the chat's own address, whichever server the chat is on; one that could not be fetched
 *  while that server was not connected is fetched when it is back. */
export function UserSaid({ chat, said }: { chat: ChatView; said: Said }) {
  const t = useTokens(), parts = useChatParts();
  const refs = said.references ?? [], images = said.images ?? [], words = showsText(said);
  const connected = useWhere(chat).connected;
  return (
    <>
      {refs.length > 0 && <SentQuotes chatId={chat.id} refs={refs} />}
      {images.length > 0 && <parts.MessageImages chat={chat.id} images={images} alone={!words} again={connected} />}
      {words && <Markdown text={said.text ?? ""} user board={chat.board} agent={chat.agent} of={chat.id} color={t.userText} />}
    </>
  );
}

/** A sent message's quotes, above its text: each the quote with the comment under it. A press on a quote shows where it came from. */
export function SentQuotes({ chatId, refs }: { chatId: string; refs: Reference[] }) {
  const t = useTokens(), parts = useChatParts();
  return (
    <View {...tid("sent-quotes")} style={styles.quotes}>
      {refs.map((r, i) => (
        <View key={i} {...tid("sent-quote-card")} style={[styles.card, { borderLeftColor: alpha(t.accent, 0.55), backgroundColor: alpha(t.bg, 0.55) }]}>
          <Pressable {...tid("sent-quote")} accessibilityRole="button" accessibilityLabel="Show where this is from" onPress={() => parts.showQuote(chatId, r)}>
            {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
              <Text numberOfLines={3} size={12} style={{ color: hovered ? t.accent : alpha(t.userText, 0.7) }}>{r.quote}</Text>
            )}
          </Pressable>
          {r.comment ? <Text {...tid("sent-quote-comment")} style={[styles.comment, { color: t.userText }]}>{r.comment}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  user: {
    alignSelf: "flex-end", maxWidth: "88%", minWidth: 0, paddingVertical: 7, paddingHorizontal: 11,
    borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomRightRadius: 3, borderBottomLeftRadius: 12,
  },
  assistant: { paddingVertical: 2, paddingHorizontal: 2, minWidth: 0 },
  caret: { flexDirection: "row" },
  note: { paddingHorizontal: 2 },
  quotes: { gap: 6, marginTop: 2, marginBottom: 6 },
  card: { borderLeftWidth: 3, borderTopLeftRadius: 3, borderBottomLeftRadius: 3, borderTopRightRadius: 7, borderBottomRightRadius: 7, paddingVertical: 4, paddingHorizontal: 9 },
  comment: { marginTop: 3 },
});
