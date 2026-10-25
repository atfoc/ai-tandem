// The group form on the phone (package S4): a P3 with a Name field, for a new group (with an "In" row that opens the move picker over the form, every connected library offered) or for the
// new name of a group ("Rename group"). Save is off until the name is valid and something changed; what is wrong with the name is said under the field before a save; the server's refusal is
// FormSheet's. Closing a changed form asks first (FormSheet's default guard).
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { libraryApi } from "@aiwb/core/libraryapi.ts";
import { insertItem } from "@aiwb/core/logic/library.ts";
import { chosenItem, heldPlace, type Place } from "@aiwb/core/logic/libraryview.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { CellGroup } from "../../../ui/Cells.tsx";
import { FormSheet } from "../../../ui/FormSheet.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useLibraries } from "../useLibraries.ts";
import { GroupRow, NameCard, NameInput, Problem } from "./EditorParts.tsx";
import { S4_SHEET_TID, S4_TID } from "./ids.ts";
import { MovePickerSheet } from "./MovePicker.tsx";
import { groupFormState, placeLine } from "./sheetlogic.ts";
import type { GroupFormOpen } from "./sheets.ts";
import { whenStore } from "./whenstore.ts";

export function GroupForm({ open, onClose }: { open: GroupFormOpen; onClose(): void }) {
  const t = useTokens();
  const libs = useLibraries();
  const rename = open.mode === "rename";
  const pick = rename ? ({ kind: "group", server: open.server, id: open.id } as const) : null;
  const found = pick ? chosenItem(libs, pick) : undefined;
  const last = useRef(found);
  if (found) last.current = found;
  const savedName = rename ? (found ?? last.current)?.name ?? "" : null;
  const goneAtOpen = useRef(rename && !found).current;
  useEffect(() => { if (goneAtOpen) onClose(); }, [goneAtOpen]);

  const start: Place = rename ? { server: open.server, group: "" } : heldPlace(libs, open.at) ?? open.at;
  const [name, setName] = useState<string | undefined>(undefined);
  const [placed, setPlaced] = useState<Place | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const typed = name ?? savedName ?? "", place = placed ?? start;
  const lib = libs.find((v) => v.server === place.server);
  const off = lib?.connected === false;
  const s = groupFormState({ saved: savedName, start, name: typed, place });

  const onSave = async () => {
    if (!rename) {
      const made = (await libraryApi.createGroup(place.server, typed.trim(), place.group)).group;
      if (!await whenStore((st) => !!chosenItem(st.libraries, { kind: "group", server: place.server, id: made.id }))) setState((st) => ({ libraries: insertItem(st.libraries, place.server, "group", made) }));
      return;
    }
    const was = chosenItem(getState().libraries, pick!);
    await libraryApi.changeGroup(open.server, open.id, { name: typed.trim() });
    await whenStore((st) => { const f = chosenItem(st.libraries, pick!); return !f || !was || f.name !== was.name; });
  };

  return (
    <FormSheet open onClose={onClose} testID={S4_TID.groupForm} title={rename ? "Rename group" : "New group"} canSave={s.canSave && !off} dirty={s.dirty} onSave={onSave}>
      <View {...tid(S4_SHEET_TID.groupFormBody, { mode: open.mode })} style={[styles.body, { backgroundColor: t.panel }]}>
        {off ? <Text size={TYPE.secondary + 2} tone="muted" style={styles.off}>{`${lib?.name ?? place.server} is not connected: this group can be changed once it is back.`}</Text> : null}
        <CellGroup>
          <NameCard label="Name" last={rename}>
            <NameInput testID={S4_TID.groupFormName} value={typed} onChangeText={setName} readOnly={off} autoFocus={!rename} />
          </NameCard>
          {rename ? null : <GroupRow testID={S4_TID.groupFormWhere} label="In" value={placeLine(libs, place)} onPress={() => setChoosing(true)} last />}
        </CellGroup>
        <Problem id={S4_SHEET_TID.groupFormProblem} text={s.problem} />
      </View>
      {rename ? null : <MovePickerSheet open={choosing} onClose={() => setChoosing(false)} over="form" libs={libs} kind="group" name={null} item={null} current={place} onPick={setPlaced} />}
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  body: { marginHorizontal: -8, paddingTop: 12, paddingBottom: 12, minHeight: 200 },
  off: { marginHorizontal: PHONE.margin, marginBottom: 12 },
});
