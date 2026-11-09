// The key row over the soft keyboard (iOS and Android): Indent for a composer box that edits like code (Settings > Composer,
// core logic/indent.ts), since the soft keyboard has no Tab. Composer.tsx shows it right under the box while the box has the focus and the
// soft keyboard is up, so that with KeyboardLift lifting the composer it is the row just above the keys; a hardware keyboard keeps the soft
// one down (Android) and has its own Tab (ChipInput.native.tsx, the keys port). A press neither takes the focus nor moves the selection:
// a Pressable does not take the focus on native, and the thread lists keep taps for their children (StickyList's keyboardShouldPersistTaps).
// There is no Outdent: an indent is taken away by deleting it (the keyboard's delete key; with spaces one press takes a level, chipdoc.ts
// backspaceChange). The prompt library's Text box on the iPad has the same row under it (library/Editor.tsx), with its own testIDs (`ids`).
import { StyleSheet, View } from "react-native";

import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { tid } from "../../ui/tid.ts";
import { IndentIcon } from "./phone/icons.tsx";

export const EDIT_KEYS_IDS = { row: "composer-editkeys", indent: "composer-indent" } as const;

/** `onIndent`: Tab at the box's caret or over its selection. `ids`: the testIDs of the row and of its button (the composer's by default). */
export function EditKeys({ onIndent, ids = EDIT_KEYS_IDS }: { onIndent(): void; ids?: { row: string; indent: string } }) {
  return (
    <View {...tid(ids.row)} style={styles.row}>
      <IconButton {...tid(ids.indent)} size="touch" title="Indent" keepFocus onPress={() => onIndent()}>
        {(color: string) => <IndentIcon color={color} />}
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: 4, height: PHONE.target, marginTop: 4 },
});
