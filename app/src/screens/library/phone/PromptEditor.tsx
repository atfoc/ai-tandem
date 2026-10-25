// The prompt editor on the phone (package S4; 06b of the design): a P3 form, "Cancel · Prompt · Save", with the name and the Group row in one card, the text in another (mono, Return adds
// a line and never saves), a bar over the keyboard ("Edited · not saved", Done) while a field has the focus, and "Delete prompt…" at the end. The Group row opens the move picker over the
// form; a pick is saved with the rest. Closing a changed form asks (06b-f: Discard changes, Save and close, Keep editing). A prompt whose library is not connected is read-only.
// `open` says what it is on: a saved prompt (`edit`) or a new one made in `at`.
import { useEffect, useMemo, useRef, useState } from "react";
import { InputAccessoryView, Keyboard, Platform, StyleSheet, TextInput, View, type TextStyle } from "react-native";

import { libraryApi } from "@aiwb/core/libraryapi.ts";
import { insertItem } from "@aiwb/core/logic/library.ts";
import { chosenItem, heldPlace, type Place } from "@aiwb/core/logic/libraryview.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { Cell, CellGroup } from "../../../ui/Cells.tsx";
import { ConfirmSheet } from "../../../ui/ConfirmSheet.tsx";
import { FormSheet } from "../../../ui/FormSheet.tsx";
import { MONO } from "../../../ui/fonts.ts";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { InSheetFooter } from "../../../ui/sheetfooter.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { useLibraries } from "../useLibraries.ts";
import { GroupRow, KeyboardBar, NameCard, NameInput, Problem } from "./EditorParts.tsx";
import { S4_SHEET_TID, S4_TID } from "./ids.ts";
import { MovePickerSheet } from "./MovePicker.tsx";
import { deleteWords, editorState, guardWords, offNotice, placeLine, type Draft } from "./sheetlogic.ts";
import type { EditorOpen } from "./sheets.ts";
import { whenStore } from "./whenstore.ts";

/** The id the iOS keyboard's accessory (the bar) is tied to. */
const ACCESSORY = "prompt-editor-bar";
/** How long the bar stays after a field lost the focus: a press on Done itself first takes the focus away. */
const BAR_LINGER_MS = 250;
/** How long a sheet over this one takes to be dismissed on iOS (as FormSheet's). */
const DISMISS_MS = 400;

export function PromptEditor({ open, onClose }: { open: EditorOpen; onClose(): void }) {
  const t = useTokens();
  const libs = useLibraries();
  const edit = open.mode === "edit";
  const pick = edit ? ({ kind: "prompt", server: open.server, id: open.id } as const) : null;
  const found = pick ? chosenItem(libs, pick) : undefined;
  // A prompt deleted while the form is open keeps what was last saved of it: what was typed stays, and Save says the server's sentence.
  const last = useRef(found);
  if (found) last.current = found;
  const savedFields = found ?? last.current;
  const goneAtOpen = useRef(edit && !found).current;
  useEffect(() => { if (goneAtOpen) onClose(); }, [goneAtOpen]);

  const start: Place = open.mode === "new" ? heldPlace(libs, open.at) ?? open.at : { server: open.server, group: savedFields?.parent ?? "" };
  const saved: Draft | null = edit && savedFields ? { name: savedFields.name, text: savedFields.text, place: start } : null;
  const [edits, setEdits] = useState<{ name?: string; text?: string; place?: Place }>({});
  const draft: Draft = { name: edits.name ?? saved?.name ?? "", text: edits.text ?? saved?.text ?? "", place: edits.place ?? start };
  const lib = libs.find((v) => v.server === draft.place.server);
  const off = lib?.connected === false;
  const state = editorState({ saved, start, draft, off });
  const [choosing, setChoosing] = useState(false);
  const [asking, setAsking] = useState(false);

  // ---- the keyboard bar: while a field of the editor has the focus
  const [focused, setFocused] = useState(false);
  const linger = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(linger.current), []);
  const gotFocus = () => { clearTimeout(linger.current); setFocused(true); };
  const lostFocus = () => { clearTimeout(linger.current); linger.current = setTimeout(() => setFocused(false), BAR_LINGER_MS); };
  const nameRef = useRef<TextInput>(null), textRef = useRef<TextInput>(null);
  const done = () => { Keyboard.dismiss(); nameRef.current?.blur(); textRef.current?.blur(); };

  const onSave = async () => {
    if (open.mode === "new") {
      const at = draft.place, made = (await libraryApi.createPrompt(at.server, draft.name.trim(), at.group, draft.text)).prompt;
      // The library with the new prompt comes on the stream; one that did not come is given the prompt the server answered with.
      if (!await whenStore((s) => !!chosenItem(s.libraries, { kind: "prompt", server: at.server, id: made.id }))) setState((s) => ({ libraries: insertItem(s.libraries, at.server, "prompt", made) }));
      return;
    }
    const was = chosenItem(getState().libraries, pick!);
    await libraryApi.changePrompt(open.server, open.id, state.change);
    // (What was typed stays until the library has moved on from what it held before the save.)
    await whenStore((s) => { const f = chosenItem(s.libraries, pick!); return !f || !was || f.name !== was.name || f.parent !== was.parent || f.text !== was.text; });
  };
  const closeAfter = () => { if (Platform.OS === "ios") setTimeout(onClose, DISMISS_MS); else onClose(); };

  const words = deleteWords(saved?.name ?? "", lib?.name ?? (edit ? open.server : ""));
  const bar = <KeyboardBar dirty={state.dirty} onDone={done} />;
  const body = useMemo(() => ({ backgroundColor: t.panel }), [t.panel]);

  return (
    <FormSheet open onClose={onClose} testID={S4_TID.editor} title={edit ? "Prompt" : "New prompt"} canSave={state.canSave} dirty={state.dirty} onSave={onSave}
      guard={guardWords(saved ? saved.name : null)}>
      <View {...tid(S4_SHEET_TID.editorBody, { mode: open.mode, server: draft.place.server })} style={[styles.body, body]}>
        {off ? <Text {...tid(S4_TID.editorOff)} size={TYPE.secondary + 2} tone="muted" style={styles.off}>{offNotice(lib?.name ?? draft.place.server)}</Text> : null}
        <CellGroup>
          <NameCard label="Name">
            <NameInput testID={S4_TID.editorName} value={draft.name} onChangeText={(name) => setEdits((e) => ({ ...e, name }))} readOnly={off} autoFocus={!edit}
              onFocus={gotFocus} onBlur={lostFocus} accessoryId={ACCESSORY} inputRef={nameRef} />
          </NameCard>
          <GroupRow testID={S4_TID.editorGroup} label="Group" value={placeLine(libs, draft.place)} onPress={() => setChoosing(true)} disabled={off} last />
        </CellGroup>
        <Problem id={S4_SHEET_TID.editorProblem} text={state.problem} />
        <CellGroup title="Text">
          <TextInput ref={textRef} {...tid(S4_TID.editorText)} accessibilityLabel="Text" value={draft.text} onChangeText={(text) => setEdits((e) => ({ ...e, text }))} multiline editable={!off}
            submitBehavior="newline" autoCorrect={false} autoCapitalize="none" spellCheck={false} placeholderTextColor={t.faint} textAlignVertical="top"
            onFocus={gotFocus} onBlur={lostFocus} inputAccessoryViewID={ACCESSORY} style={[styles.text, { color: t.text }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
        </CellGroup>
        {edit ? (
          <CellGroup>
            <Cell testID={S4_TID.editorDelete} label="Delete prompt…" tone="danger" chevron={false} disabled={off} onPress={() => setAsking(true)} />
          </CellGroup>
        ) : null}
        {Platform.OS !== "ios" && focused ? <InSheetFooter inPlace={<View style={styles.sticky}>{bar}</View>}>{bar}</InSheetFooter> : null}
      </View>
      {Platform.OS === "ios" ? <InputAccessoryView nativeID={ACCESSORY}>{bar}</InputAccessoryView> : null}
      <MovePickerSheet open={choosing} onClose={() => setChoosing(false)} over="form" libs={libs} kind="prompt" name={saved ? saved.name : null}
        item={edit ? { server: open.server, id: open.id } : null} current={draft.place} onPick={(place) => setEdits((e) => ({ ...e, place }))} />
      {edit ? (
        <ConfirmSheet open={asking} onClose={() => setAsking(false)} over="form" title={words.title} body={words.body} confirmLabel={words.confirm}
          onConfirm={async () => { await libraryApi.deletePrompt(open.server, open.id); closeAfter(); }} />
      ) : null}
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  // the page of the form is `panel`, the cards `bg` (as the pushed screens): the body bleeds over the sheet's own side padding
  body: { marginHorizontal: -8, paddingTop: 12, paddingBottom: 12, minHeight: 360 },
  off: { marginHorizontal: PHONE.margin, marginBottom: 12 },
  text: { fontFamily: MONO, fontSize: 14.5, lineHeight: 21, minHeight: 190, paddingHorizontal: PHONE.margin, paddingVertical: 12 },
  sticky: { ...(webStyle({ position: "sticky", bottom: 0, zIndex: 2 }) ?? {}) },
});
