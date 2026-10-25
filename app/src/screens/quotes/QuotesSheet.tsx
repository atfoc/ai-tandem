// "Quoted in this message" (ux-improvements goal 3.6, mockup "05" co-05b): the sheet the phone's "2 quotes" chip opens. A card for each quote of the draft: its
// passage on a soft yellow bar, where it is from, its comment as an editable field (or a dashed "+ Add a comment" that turns into the field with the focus)
// and a 44-point trash that takes the quote out of the message only (the passage stays in the thread). A comment typed here goes into the draft with
// every key, as the quote float's does when it is kept, so what the composer saves as it goes away holds it. In a read-only composer the cards only show.
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { preview, quoteKey } from "@aiwb/core/logic/quotes.ts";
import { shownView, threadOf } from "@aiwb/core/state/store.ts";
import type { Reference } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { SANS } from "../../ui/fonts.ts";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { TrashIcon } from "../composer/phone/icons.tsx";
import { quoteSource, sheetSub } from "./model.ts";

/** The sheet's own height: past this many quotes it is the tall one (the cards scroll in the half-height sheet otherwise). */
const TALL_FROM = 3;

export type QuotesSheetProps = {
  chat: string;
  quotes: Reference[];
  /** The composer is read-only: the cards show, nothing is edited, added or removed. */
  readOnly: boolean;
  onComment(q: Reference, text: string): void;
  onRemove(q: Reference): void;
  onClose(): void;
};

export function QuotesSheet({ chat, quotes, readOnly, onComment, onRemove, onClose }: QuotesSheetProps) {
  const items = useStore((s) => threadOf(s, chat)?.items);
  const agent = useStore((s) => shownView(s, chat)?.agent ?? "");
  const n = quotes.length;
  return (
    <Sheet open onClose={onClose} label="Quoted in this message" testID="quotes-sheet" detent={n >= TALL_FROM ? "large" : "fit"}
      head={<SheetHead title="Quoted in this message" sub={sheetSub(n)} right={{ label: "Done", onPress: onClose, strong: true, testID: "quotes-done" }} />}>
      <View style={styles.body}>
        {quotes.map((q) => (
          <Card key={quoteKey(q)} q={q} from={quoteSource(items, agent, q)} readOnly={readOnly} onComment={(text) => onComment(q, text)} onRemove={() => onRemove(q)} />
        ))}
        {readOnly ? null : <Text {...tid("quotes-hint")} size={TYPE.secondary} tone="muted" style={styles.hint}>Press and hold a reply to quote more.</Text>}
      </View>
    </Sheet>
  );
}

function Card({ q, from, readOnly, onComment, onRemove }: { q: Reference; from: string; readOnly: boolean; onComment(text: string): void; onRemove(): void }) {
  const { tokens: t } = useTheme();
  // the field shows while the quote has a comment, or from a press on "+ Add a comment" until it is left empty
  const [field, setField] = useState(!!q.comment);
  const [text, setText] = useState(q.comment ?? "");
  const [added, setAdded] = useState(false);
  const type = (s: string) => { setText(s); onComment(s); };
  return (
    <View {...tid("quote-card", { key: quoteKey(q) })} style={[styles.card, { borderColor: t.line2, backgroundColor: t.bg }]}>
      <View style={styles.top}>
        <View style={[styles.bar, { backgroundColor: t.warn }]} />
        <View style={styles.words}>
          <Text {...tid("quote-passage")} size={16} numberOfLines={4} ellipsizeMode="tail">{preview(q.quote, 400)}</Text>
          <Text {...tid("quote-from")} size={TYPE.secondary} tone="muted" numberOfLines={1}>{from}</Text>
        </View>
        {readOnly ? null : (
          <IconButton {...tid("quote-remove")} size="touch" title="Remove this quote from the message" onPress={onRemove}>
            {(colour) => <TrashIcon color={colour} />}
          </IconButton>
        )}
      </View>
      {field ? (
        <View style={[styles.comment, { borderColor: t.line2, backgroundColor: t.panel }]}>
          <Text size={TYPE.control} tone="muted" style={styles.pencil}>✎</Text>
          <TextInput {...tid("quote-comment")} multiline value={text} onChangeText={type} editable={!readOnly} readOnly={readOnly} autoFocus={added}
            accessibilityLabel="Comment on this quote" placeholder="Comment" placeholderTextColor={t.faint} textAlignVertical="top"
            onBlur={() => { if (!readOnly && !text.trim()) { setText(""); onComment(""); setField(false); setAdded(false); } }}
            style={[styles.input, { color: t.text }]} />
        </View>
      ) : readOnly ? null : (
        <Pressable {...tid("quote-add-comment")} role="button" accessibilityLabel="Add a comment to this quote" onPress={() => { setAdded(true); setField(true); }}
          style={[styles.add, { borderColor: t.accent }, webStyle({ cursor: "pointer" })]}>
          <Text size={TYPE.control} tone="accent">+  Add a comment</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 8, paddingTop: 12, paddingBottom: 4, gap: 12 },
  card: { borderWidth: 1, borderRadius: 14, paddingVertical: 10, paddingLeft: 12, paddingRight: 6, gap: 8 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  bar: { width: 4, borderRadius: 2, alignSelf: "stretch", minHeight: 24, marginTop: 3, marginBottom: 3 },
  words: { flex: 1, minWidth: 0, gap: 2, paddingTop: 8 },
  comment: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: PHONE.target, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6 },
  pencil: { paddingTop: 5 },
  input: { flex: 1, minWidth: 0, minHeight: 32, fontFamily: SANS, fontSize: TYPE.control, lineHeight: 24, paddingVertical: 4, paddingHorizontal: 0 },
  add: { minHeight: PHONE.target, borderWidth: 1.5, borderStyle: "dashed", borderRadius: 10, alignItems: "center", justifyContent: "center", marginRight: 6 },
  hint: { textAlign: "center", paddingTop: 4 },
});
