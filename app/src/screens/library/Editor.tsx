// The editor of the library popup (the old page's Library.tsx, `editor` and `about`): the chosen prompt's Name and Text (a group's Name), where the item is ("In <path>" /
// "At the top level": the tree sets it, the editor only says it), Save, Revert and Delete. It has no choice of a group. What is typed is the popup's state, not
// this component's: leaving, a second window's change and a move all go through it.
// The Text field is the composer's box (PromptText.tsx): it edits as a chat's message does (Tab indents as Settings > Composer says, Enter keeps
// the indent and continues a list, Backspace in spaces goes back a tab stop). On web a Tab in it always indents, also when it is the dialog's
// last control (the wrapper is marked `data-keeps-tab`, which the overlay's Tab ring leaves alone: ui/modal.web.tsx); Esc then Tab leaves the box,
// but Esc also closes the dialog. On the iPad the key row with Indent stands under it while it has the focus and the soft keyboard is up
// (composer/EditKeys.tsx); a hardware Tab indents through the box.
import { useRef, useState, type Ref } from "react";
import { Platform, StyleSheet, TextInput, View, type TextStyle } from "react-native";

import { offText, placeText, type Fields, type Place } from "@aiwb/core/logic/libraryview.ts";
import type { LibraryView } from "@aiwb/core/logic/library.ts";

import { useKeyboardUp } from "../../platform/keyboard";
import { Button } from "../../ui/Button.tsx";
import { DialogError } from "../../ui/Dialog.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { EditKeys } from "../composer/EditKeys.tsx";
import { PromptText, type PromptTextHandle } from "./PromptText.tsx";

export const NONE_TEXT = "Choose a prompt to edit it, or make a new one. Right-click in the list to make one there; drag a prompt or a group to move it.";

/** The Text box's look: the monospace face at 12 px; it takes the height the dialog leaves it, at least 100 with its border. */
const TEXT_LOOK = { mono: true, fontSize: 12, minHeight: 94, grow: true } as const;
/** The iPad's key row under the Text box. */
const LIB_EDIT_KEYS_IDS = { row: "lib-editkeys", indent: "lib-indent" } as const;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type EditorProps = {
  libs: LibraryView[];
  level: boolean;
  kind: "prompt" | "group";
  fresh: boolean;
  shown: Fields;
  at: Place | null;
  off: boolean;
  where: LibraryView | undefined;
  gone: boolean;
  problem: string;
  err: string;
  busy: boolean;
  dirty: boolean;
  canSave: boolean;
  nameRef: Ref<TextInput>;
  onName(v: string): void;
  onText(v: string): void;
  onSave(): void;
  onDelete(): void;
  onRevert(): void;
  /** The focus is in one of the two boxes (⌘↵ / Ctrl+↵ saves from there; the Text box leaves that key to the keys port). */
  inField(on: boolean): void;
};

export function Editor(p: EditorProps) {
  const t = useTokens();
  const head = p.fresh ? `New ${p.kind}` : p.kind === "prompt" ? "Prompt" : "Group";
  const whereTip = useControlRef(p.fresh ? "Where it will be in the tree." : "Where it is in the tree. Drag it there to move it.");
  const [textFocused, setTextFocused] = useState(false);
  const keyboardUp = useKeyboardUp();
  const textBox = useRef<PromptTextHandle>(null);
  // (the box's focus events bubble to the View around it, as the composer's do: Composer.tsx boxHandlers)
  const textHandlers = { onFocus: () => { setTextFocused(true); p.inField(true); }, onBlur: () => { setTextFocused(false); p.inField(false); } } as object;
  const box = [styles.input, { color: t.text, borderColor: t.line2, backgroundColor: p.off ? t.panel : t.bg }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined];
  return (
    <View {...tid("lib-form", { kind: p.kind, fresh: p.fresh || undefined })} style={styles.form}>
      <View style={styles.head}>
        <Text {...tid("lib-form-head")} size={11} weight="600" tone="muted" style={styles.caps}>{head}</Text>
        {p.at ? <Text ref={whereTip} {...tid("lib-where")} size={12} tone="muted" numberOfLines={1} style={styles.where}>{placeText(p.libs, p.at, p.level)}</Text> : null}
      </View>
      {p.off && p.where ? <Notice>{offText(p.where.name)}</Notice> : null}
      {p.gone ? <Notice>{p.fresh ? `The library this ${p.kind} was to go into is no longer here.` : `This ${p.kind} is no longer in the library.`} What is typed here is kept.</Notice> : null}
      <View style={styles.field}>
        <Text size={12} tone="muted">Name</Text>
        <TextInput ref={p.nameRef} {...tid("lib-name-input")} value={p.shown.name} readOnly={p.off} onChangeText={p.onName} onSubmitEditing={() => { if (p.canSave) p.onSave(); }}
          onFocus={() => p.inField(true)} onBlur={() => p.inField(false)} spellCheck={false} autoCorrect={false} autoCapitalize="none" accessibilityLabel="Name" style={[box, styles.name]} />
      </View>
      {p.kind === "prompt" ? (
        <View style={[styles.field, styles.textField]}>
          <Text size={12} tone="muted">Text</Text>
          {/* (keepsTab: the overlay's Tab ring leaves a Tab in the box to the box, which indents with it; a read-only box takes no Tab, so the ring keeps it) */}
          <View {...tid("lib-text-box", { keepsTab: p.off ? undefined : true })} {...textHandlers} style={[styles.input, styles.textBox, { borderColor: t.line2, backgroundColor: p.off ? t.panel : t.bg }]}>
            <PromptText ref={textBox} testID="lib-text-input" value={p.shown.text} onChangeText={p.onText} readOnly={p.off} look={TEXT_LOOK} />
          </View>
          {Platform.OS !== "web" && textFocused && keyboardUp && !p.off ? <EditKeys ids={LIB_EDIT_KEYS_IDS} onIndent={() => textBox.current?.indent()} /> : null}
        </View>
      ) : null}
      {p.problem ? <Text {...tid("lib-problem")} size={12} tone="muted" style={styles.problem}>{p.problem}</Text> : null}
      {p.err ? <View {...tid("lib-err")}><DialogError>{p.err}</DialogError></View> : null}
      <View style={styles.actions}>
        {!p.fresh ? <Button size="sm" testID="lib-delete" label="Delete" disabled={p.busy || p.off || p.gone} onPress={p.onDelete} /> : null}
        <View style={styles.grow} />
        {p.fresh || p.dirty ? <Button size="sm" testID="lib-revert" label={p.fresh ? "Cancel" : "Revert"} disabled={p.busy} onPress={p.onRevert} /> : null}
        <Button size="sm" tone="primary" testID="lib-save" label={p.busy ? "Saving…" : "Save"} title="Save (⌘↵ or Ctrl+↵)" disabled={!p.canSave} onPress={p.onSave} />
      </View>
    </View>
  );
}

/** What stands in the editor when a server's entry is chosen: its name and how much it holds. */
export function About({ where }: { where: LibraryView }) {
  return (
    <View {...tid("lib-about")} style={styles.form}>
      <Text {...tid("lib-form-head")} size={11} weight="600" tone="muted" style={styles.caps}>{where.name}</Text>
      <Text {...tid("lib-about-hint")} size={12} tone="muted" style={styles.aboutHint}>{count(where.prompts?.length ?? 0, "prompt")} in {count(where.groups?.length ?? 0, "group")}.</Text>
      {!where.connected ? <Notice>{offText(where.name)}</Notice> : null}
    </View>
  );
}

/** A notice in the warning colours (`.lib-notice`): plain text, selectable. */
export function Notice({ children, testID = "lib-notice" }: { children: React.ReactNode; testID?: string }) {
  const t = useTokens();
  return <View {...tid(testID)} style={[styles.notice, { backgroundColor: t.warnSoft, borderColor: t.warn }]}><Text selectable size={12}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  form: { flex: 1, minHeight: 0 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  where: { flexShrink: 1, minWidth: 0 },
  field: { marginTop: 10 },
  textField: { flex: 1, minHeight: 120 },
  input: { marginTop: 3, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, fontSize: 13 },
  name: { fontFamily: undefined },
  textBox: { flex: 1, minHeight: 100, paddingVertical: 2 }, // (the box adds 3 above and below its text)
  problem: { marginTop: 8 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  grow: { flex: 1 },
  notice: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1 },
  aboutHint: { marginTop: 6 },
});
