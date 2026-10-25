// The Quote sheet (AD-64, goal 4.2): a long press on a message opens it. The message's displayed text is in a read-only, selectable text box
// (the system's own selection handles), with "Quote" for the words selected and "Quote whole message". The span is the selection in the displayed
// text, which is what a quote stores on every target (screens/markdown/displayed.ts). The quote goes to the composer of the chat (bus.ts), whose
// comment field opens in its own sheet. A message that cannot be quoted (a reply still being written, a chat that takes no change) says why in
// the place of the buttons. Native and the phone layout of the web build; the browser's own selection quotes on the wide layouts.
// On the phone (ux-improvements goal 3.5) it is "Quote from Claude's reply": a head with Cancel, the whole message at reading size, and the two
// buttons ("Quote selection", "Whole message") full width in thumb reach. The same sheet in mode "select" is the message sheet's Select text:
// "Copy selection" and "Copy all", which work whatever keeps a quote (a reply being written, an archived chat).
import { useMemo, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, TextInput, useWindowDimensions, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData, type TextStyle } from "react-native";

import { shownView, threadOf } from "@aiwb/core/state/store.ts";

import { copyText } from "../../platform/clipboard";
import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { InSheetFooter } from "../../ui/sheetfooter.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { usePhone } from "../../ui/useLayout.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { SANS } from "../../ui/fonts.ts";
import { T1_TID } from "../chat/ids.ts";
import { useOffWhy } from "../chat/index.ts";
import { shownText } from "../markdown/displayed.ts";
import { takerOf } from "./bus.ts";
import { referenceFor, whyNotQuotable, wholeReference } from "./model.ts";
import { PICK_HINT, pickBlocked, pickButtons, quoteTitle } from "./quotewords.ts";
import { closePick, inGrace, pickNow, subscribePick, type PickMode } from "./sheetstore.ts";

const PICK_PAD = 16;

/** The sheet, always mounted (the shell's `Overlays` slot): it shows itself while a message is held. */
export function QuoteSheet() {
  const target = useSyncExternalStore(subscribePick, pickNow);
  if (!target) return null;
  return <Pick key={`${target.chat}:${target.index}:${target.mode ?? "quote"}`} chat={target.chat} index={target.index} mode={target.mode ?? "quote"} />;
}

function Pick({ chat, index, mode }: { chat: string; index: number; mode: PickMode }) {
  const { tokens: t } = useTheme();
  const phone = usePhone();
  const win = useWindowDimensions();
  const agent = useStore((s) => shownView(s, chat)?.agent);
  const [h, setH] = useState(0);
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
  if (phone) {
    const select = mode === "select";
    const copy = (text: string) => {
      closePick();
      copyText(text).then(() => showToast({ text: "Copied" }), () => showToast({ text: "Couldn't copy" }));
    };
    const words = shown.slice(sel.start, sel.end);
    const title = quoteTitle(mode, item?.kind === "user", agent);
    const pick = pickButtons(mode);
    const blocked = pickBlocked(mode, why);
    const soft = { backgroundColor: t.accentSoft, borderColor: t.accentSoft };
    const label = (text: string) => <Text size={TYPE.control} tone="accent">{text}</Text>;
    const buttons = blocked ? null : (
      <View style={styles.phoneFoot}>
        {select ? (
          <>
            <Button {...tid(T1_TID.selectCopy)} tone="primary" size="block" label={pick.selection} disabled={!words.trim()} onPress={() => copy(words.trim())} />
            <Button {...tid(T1_TID.selectCopyAll)} size="block" style={soft} onPress={() => copy(item?.text || shown)}>{label(pick.whole)}</Button>
          </>
        ) : (
          <>
            <Button {...tid("quote-selection")} tone="primary" size="block" label={pick.selection} disabled={!picked} onPress={() => take(picked)} />
            <Button {...tid("quote-whole")} size="block" style={soft} onPress={() => take(wholeReference(shown, index))}>{label(pick.whole)}</Button>
          </>
        )}
      </View>
    );
    return (
      <Sheet open onClose={() => { if (!inGrace()) closePick(); }} label={title} testID="quote-sheet" head={<SheetHead title={title} left={{ label: "Cancel", onPress: closePick, testID: "quote-cancel" }} />}>
        <View {...tid("quote-sheet-body", { mode })} style={styles.phoneBody}>
          <View style={styles.phoneInner}>
          <Text {...tid("quote-hint")} size={TYPE.secondary} tone="muted" style={styles.hint}>{PICK_HINT}</Text>
          {item ? (
            // The box is as tall as its words (up to 42% of the window, then it scrolls). A box's own content size cannot say that on the web: it
            // never reports less than the box itself, so a box that was once tall stays tall; a copy of the text drawn out of sight is measured instead.
            <View>
              <Text size={TYPE.body} style={[styles.phoneGhost, { lineHeight: TYPE.body * TYPE.bodyLine }]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
                onLayout={(e) => setH(e.nativeEvent.layout.height)}>{shown}</Text>
              <TextInput {...tid("quote-text")} multiline value={shown} onChangeText={() => {}} editable={Platform.OS === "android"} readOnly={Platform.OS !== "android"}
                showSoftInputOnFocus={false} onSelectionChange={onSelect} scrollEnabled spellCheck={false} autoCorrect={false}
                style={[styles.phoneText, webStyle({ outlineStyle: "none" }) as TextStyle | undefined, { color: t.text, backgroundColor: t.panel, height: Math.min(Math.round(win.height * 0.42), Math.max(96, h + 2 * PICK_PAD)) }]} />
            </View>
          ) : null}
          {blocked ? <Text {...tid("quote-why")} size={TYPE.busy} style={{ color: t.warnText }}>{why}</Text> : null}
          </View>
          <InSheetFooter inPlace={buttons}>{buttons}</InSheetFooter>
        </View>
      </Sheet>
    );
  }
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
  phoneBody: { paddingTop: 8, gap: 12 },
  phoneInner: { paddingHorizontal: PHONE.margin - 8, gap: 12 },
  hint: { textAlign: "center" },
  phoneText: { borderRadius: 14, padding: PICK_PAD, fontFamily: SANS, fontSize: TYPE.body, lineHeight: TYPE.body * TYPE.bodyLine },
  phoneGhost: { position: "absolute", left: PICK_PAD, right: PICK_PAD, top: PICK_PAD, opacity: 0, fontFamily: SANS, fontSize: TYPE.body },
  phoneFoot: { gap: 10, paddingHorizontal: PHONE.margin - 8 },
});
