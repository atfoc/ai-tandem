// The Quote sheet (AD-64, goal 4.2): a long press on a message opens it. The message's displayed text is in a read-only, selectable text box
// (the system's own selection handles), with "Quote" for the words selected and "Quote whole message". The span is the selection in the displayed
// text, which is what a quote stores on every target (screens/markdown/displayed.ts). The quote goes to the composer of the chat (bus.ts), whose
// comment field opens in its own sheet. A message that cannot be quoted (a reply still being written, a chat that takes no change) says why in
// the place of the buttons. Native and the phone layout of the web build; the browser's own selection quotes on the wide layouts.
import { useMemo, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";

import { shownView, threadOf } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { InSheetFooter } from "../../ui/sheetfooter.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { SANS } from "../../ui/fonts.ts";
import { useOffWhy } from "../chat/index.ts";
import { shownText } from "../markdown/displayed.ts";
import { takerOf } from "./bus.ts";
import { referenceFor, whyNotQuotable, wholeReference } from "./model.ts";
import { closePick, inGrace, pickNow, subscribePick } from "./sheetstore.ts";

/** The sheet, always mounted (the shell's `Overlays` slot): it shows itself while a message is held. */
export function QuoteSheet() {
  const target = useSyncExternalStore(subscribePick, pickNow);
  if (!target) return null;
  return <Pick key={`${target.chat}:${target.index}`} chat={target.chat} index={target.index} />;
}

function Pick({ chat, index }: { chat: string; index: number }) {
  const { tokens: t } = useTheme();
  const item = useStore((s) => threadOf(s, chat)?.items[index]);
  const archived = useStore((s) => !!shownView(s, chat)?.archived);
  const off = useOffWhy(chat);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const shown = useMemo(() => (item ? shownText(item.text ?? "", item.kind === "user").text : ""), [item?.text, item?.kind]);
  // what keeps the words from being quoted now (the composer may go away while the sheet is open)
  const why = off || (archived ? "Archived — unarchive to continue" : "") || whyNotQuotable(item);
  const take = (r: ReturnType<typeof wholeReference>) => {
    if (!r) return;
    closePick();
    takerOf(chat)?.quote(r);
  };
  const picked = referenceFor(shown, index, sel.start, sel.end);
  const actions = why ? null : (
    <View style={styles.foot}>
      <Button {...tid("quote-selection")} tone="primary" size="sm" label="Quote" disabled={!picked} onPress={() => take(picked)} />
      <Button {...tid("quote-whole")} size="sm" label="Quote whole message" onPress={() => take(wholeReference(shown, index))} />
      <View style={styles.grow} />
      <Button {...tid("quote-cancel")} tone="ghost" size="sm" label="Cancel" onPress={closePick} />
    </View>
  );
  const onSelect = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const { start, end } = e.nativeEvent.selection;
    setSel({ start: Math.min(start, end), end: Math.max(start, end) });
  };
  return (
    <Sheet open onClose={() => { if (!inGrace()) closePick(); }} label="Quote from this message" testID="quote-sheet">
      <View style={styles.body}>
        <View style={styles.head}>
          <Text size={12} weight="600" tone="muted" style={styles.headWord}>Quote from this message</Text>
          {why ? null : <Text {...tid("quote-hint")} size={11} tone="muted">select the words to quote</Text>}
        </View>
        {item ? (
          // (an Android box that is not editable takes no selection, so it stays editable there with no keyboard, and a key put in it is taken back)
          <TextInput {...tid("quote-text")} multiline value={shown} onChangeText={() => {}} editable={Platform.OS === "android"} readOnly={Platform.OS !== "android"}
            showSoftInputOnFocus={false} onSelectionChange={onSelect} scrollEnabled spellCheck={false} autoCorrect={false}
            style={[styles.text, { color: t.text, borderColor: t.line2, backgroundColor: t.panel }]} />
        ) : null}
        {why ? <Text {...tid("quote-why")} size={12} tone="warn">{why}</Text> : null}
        <InSheetFooter inPlace={actions}>{actions}</InSheetFooter>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 8, paddingBottom: 4, gap: 8 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  headWord: { textTransform: "uppercase", letterSpacing: 0.3 },
  text: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, fontFamily: SANS, fontSize: 14, lineHeight: 20, minHeight: 120, maxHeight: 280 },
  foot: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, paddingHorizontal: 8 },
  grow: { flex: 1 },
});
