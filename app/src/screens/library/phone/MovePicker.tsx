// The move picker (package S4; 06b-e of the design): a P2 over the places of the libraries, "Top level" first and then the groups depth-first, each set in by its depth, the current
// place tinted with a ✓ and "Now here". `MovePickerSheet` is the sheet itself (the editor's and the group form's Group row choose a place with it, over their form); `MovePicker` is the one
// a swipe or a P1 opens (phone/sheets.ts): a tap moves the prompt or the group at once and the sheet closes; a refusal (a name taken there, too deep) is a toast with the server's sentence.
import { useEffect, useMemo } from "react";

import { libraryApi } from "@aiwb/core/libraryapi.ts";
import { chosenItem, samePlace, type Place } from "@aiwb/core/logic/libraryview.ts";

import { PickerSheet, type PickerOption } from "../../../ui/PickerSheet.tsx";
import { showToast } from "../../../ui/Toast.tsx";
import { S4_TID, placeOf, placeValue } from "./ids.ts";
import { PlaceGlyph } from "./EditorParts.tsx";
import { placeOptions, pickerWords, type ItemKind } from "./sheetlogic.ts";
import type { MoveOpen } from "./sheets.ts";
import { useLibraries } from "../useLibraries.ts";
import type { LibraryView } from "@aiwb/core/logic/library.ts";

export type MovePickerSheetProps = {
  open: boolean;
  onClose(): void;
  libs: LibraryView[];
  kind: ItemKind;
  /** What is moved, by name; null for a new one (choose mode: the places of every connected library can be picked). */
  name: string | null;
  item: { server: string; id: string } | null;
  /** Where it is now (or, choosing, the place picked so far): tinted, with "Now here". */
  current: Place | null;
  onPick(place: Place): void;
  over?: "form";
};

export function MovePickerSheet({ open, onClose, libs, kind, name, item, current, onPick, over }: MovePickerSheetProps) {
  const words = pickerWords(kind, name);
  const options = useMemo<PickerOption<string>[]>(
    () => placeOptions(libs, { kind, item, current }).map((o) => ({
      value: o.value, label: o.label, note: o.note, disabledReason: o.disabledReason, section: o.section,
      icon: <PlaceGlyph top={o.top} depth={o.depth - 1} dim={!!o.disabledReason} />,
    })),
    [libs, kind, item, current],
  );
  return (
    <PickerSheet open={open} onClose={onClose} title={words.title} sub={words.sub} options={options} search={false} over={over} testID={S4_TID.movePicker}
      value={current ? placeValue(current.server, current.group) : null} onPick={(v) => onPick(placeOf(v))} />
  );
}

/** A refusal as a sentence: the server's own, else what the error says. */
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function MovePicker({ open, onClose }: { open: MoveOpen; onClose(): void }) {
  const libs = useLibraries();
  const pick = { kind: open.kind, server: open.server, id: open.id } as const;
  const found = chosenItem(libs, pick);
  // (an item that is gone: nothing to move)
  useEffect(() => { if (!found) onClose(); }, [found === undefined]);
  const current: Place | null = found ? { server: open.server, group: found.parent } : null;
  const move = (to: Place) => {
    if (!current || samePlace(current, to)) return;
    const done = open.kind === "prompt" ? libraryApi.changePrompt(open.server, open.id, { parent: to.group }) : libraryApi.changeGroup(open.server, open.id, { parent: to.group });
    done.catch((e) => showToast({ text: said(e), kind: "error" }));
  };
  if (!found) return null;
  return <MovePickerSheet open libs={libs} kind={open.kind} name={found.name} item={{ server: open.server, id: open.id }} current={current} onPick={move} onClose={onClose} />;
}
