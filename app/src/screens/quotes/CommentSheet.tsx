// The comment field of a quote in a sheet (AD-64; C-QT-05, C-QT-08, C-QT-09 "touch: a sheet"): the native app's, and the phone layout of the web
// build's. It shows the quoted words, a field for the comment, and Add (Save for a quote that is in the draft already), Cancel and, for a quote in
// the draft, Remove. Closing the sheet (the dimmed page, a swipe down, Esc, the back button) keeps what was typed as a press elsewhere does on the
// wide layouts: a new quote is added only with a comment, an edited one gets it; Cancel drops it.
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { preview } from "@aiwb/core/logic/quotes.ts";

import { Button } from "../../ui/Button.tsx";
import { InSheetFooter } from "../../ui/sheetfooter.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { SANS } from "../../ui/fonts.ts";
import type { Editing } from "./model.ts";

export type CommentSheetProps = { f: Editing; onText(t: string): void; onKeep(enter: boolean): void; onCancel(): void; onRemove?: () => void };

export function CommentSheet({ f, onText, onKeep, onCancel, onRemove }: CommentSheetProps) {
  const { tokens: t } = useTheme();
  const [h, setH] = useState(0);
  const actions = (
    <View style={styles.foot}>
      {onRemove ? <Button {...tid("qfloat-remove")} tone="danger" size="sm" label="Remove" onPress={onRemove} /> : null}
      <View style={styles.grow} />
      <Button {...tid("qfloat-cancel")} size="sm" label="Cancel" onPress={onCancel} />
      <Button {...tid("qfloat-save")} tone="primary" size="sm" label={f.edit ? "Save" : "Add"} onPress={() => onKeep(true)} />
    </View>
  );
  return (
    <Sheet open onClose={() => onKeep(false)} label="Comment on a quote" testID="quote-comment-sheet">
      <View {...tid("qfloat", { edit: f.edit })} style={styles.body}>
        <Text {...tid("qfloat-quote")} size={12} tone="muted" numberOfLines={3}>
          <Text size={14} tone="accent" style={styles.mark}>❝</Text> {preview(f.r.quote, 200)}
        </Text>
        <TextInput {...tid("qfloat-comment")} multiline autoFocus value={f.text} onChangeText={onText} placeholder={f.edit ? "Comment" : "Comment on this…"}
          placeholderTextColor={t.faint} textAlignVertical="top"
          onContentSizeChange={(e) => setH(e.nativeEvent.contentSize.height)}
          style={[styles.input, { color: t.text, borderColor: t.line2, backgroundColor: t.bg, height: Math.min(180, Math.max(76, h + 16)) }]} />
        <InSheetFooter inPlace={actions}>{actions}</InSheetFooter>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 8, paddingBottom: 4, gap: 8 },
  mark: { fontFamily: "Georgia, serif" },
  input: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, fontFamily: SANS, fontSize: 14, lineHeight: 20 },
  foot: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 },
  grow: { flex: 1 },
});
