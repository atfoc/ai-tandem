// The stack sheet (ux-improvements goal 3.1.2): the screens under the one it opens from, a pick goes back to it at once. Opened by holding
// the back control (BackButton.tsx).
import { PickerSheet } from "../../ui/PickerSheet.tsx";
import { TID } from "../../ui/tid.ts";
import { popTo } from "./goback.ts";
import { pickTarget, sheetOptions } from "./navback.ts";
import type { StackEntry } from "./stack.ts";

/** The sheet of the entry `own` of `entries`: Home up to it, itself chosen. A pick of another goes back to it; its own only closes. */
export function StackSheet({ open, onClose, entries, own }: { open: boolean; onClose(): void; entries: readonly StackEntry[]; own: StackEntry }) {
  return (
    <PickerSheet open={open} onClose={onClose} testID={TID.stackSheet} title="Go back to" sub={own.title}
      options={sheetOptions(entries, own.key)} value={own.key}
      onPick={(key) => { const target = pickTarget(own.key, key); if (target) popTo(target); }} />
  );
}
