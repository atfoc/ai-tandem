// P3, the form (ux-improvements goal 3.1.4): typing one or several values. A head of "Cancel · Title · Save"; Save is off until
// there is something to save and stays above the keyboard (it is in the head, which the sheet keeps above its scroll view); the sheet
// is on the large detent and rides on the keyboard (Sheet), scrolling the box that has the focus into view (useKeyboardAvoid).
// Closing a changed form by any way (Cancel, a swipe down, a press on the dimmed page, Esc, Android's back) asks first: a P4 over the
// P3 (`over="form"`, the one sheet allowed over another with a P2), "Discard changes"; its Cancel keeps editing. A form with
// nothing typed closes at once. While Save runs, Save reads "Saving…" and is off, Cancel is off and nothing closes the sheet; a
// throw (or `error`) is shown under the head (`form-error`, an alert) and the form stays open; after a success it closes itself.
// On the wide layouts a form stays the dialog it is today (goal 4.2): a screen picks with `usePhone()`.
import { useEffect, useState, type ReactNode } from "react";
import { Platform, StyleSheet } from "react-native";

import { ConfirmSheet } from "./ConfirmSheet.tsx";
import { TYPE } from "./metrics.ts";
import { Sheet } from "./Sheet.tsx";
import { SheetHead } from "./SheetHead.tsx";
import { Text } from "./Text.tsx";
import { TID, tid, type DataSet } from "./tid.ts";

export type FormSheetProps = {
  open: boolean;
  onClose(): void;
  title: string;
  /** Under the title: the place and the server ("Checkout service · Studio Mac"). */
  sub?: string;
  saveLabel?: string;
  /** Save is on: something changed and it is valid. */
  canSave: boolean;
  /** Something was typed: closing asks first. */
  dirty: boolean;
  /** Answers when saved; a throw is shown in the form, which stays open. The form closes itself after success. */
  onSave(): void | Promise<void>;
  error?: string;
  children: ReactNode;
  /** The leave guard's words, and a "Save and close" between Discard and a "Keep editing" link (the prompt editor's guard). Without
   *  it: "Discard changes to “<title>”?", "What you changed is not saved.", Discard changes and Cancel. */
  guard?: { title?: string; body?: string; saveAndClose?: boolean };
  testID?: string;
  dataSet?: DataSet;
};

/** How long a sheet over this one takes to be dismissed on iOS (the system's modal dismissal is about 0.3 s). */
const DISMISS_MS = 400;

export function FormSheet({ open, onClose, title, sub, saveLabel = "Save", canSave, dirty, onSave, error, children, guard, testID = TID.formSheet, dataSet }: FormSheetProps) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  useEffect(() => { if (!open) { setAsking(false); setFailed(""); } }, [open]);
  const leave = () => { if (busy) return; if (dirty) setAsking(true); else onClose(); };
  // The confirm is a `Modal` inside the form's: on iOS both closing in one commit leaves the page's accessibility tree empty (a screen reader reads nothing, Maestro sees
  // no view), so the confirm closes first and the form follows once its dismissal is done.
  const discard = () => { setAsking(false); if (Platform.OS === "ios") setTimeout(onClose, DISMISS_MS); else onClose(); };
  const save = async () => {
    setBusy(true); setFailed("");
    try { await onSave(); onClose(); } catch (e) { setFailed((e as Error)?.message ?? String(e)); } finally { setBusy(false); }
  };
  // "Save and close" of the guard: the save's throw is shown in the guard, which stays open; after success the guard closes and the form follows.
  const saveAndClose = async () => {
    setBusy(true);
    try { await onSave(); } finally { setBusy(false); }
    if (Platform.OS === "ios") setTimeout(onClose, DISMISS_MS); else onClose();
  };
  const shown = error || failed;
  const head = (
    <>
      <SheetHead title={title} sub={sub} left={{ label: "Cancel", onPress: leave, disabled: busy }}
        right={{ label: busy ? "Saving…" : saveLabel, strong: true, disabled: !canSave || busy, onPress: () => void save() }} />
      {shown ? <Text {...tid(TID.formError)} size={TYPE.secondary + 2} tone="danger" accessibilityRole="alert" style={styles.error}>{shown}</Text> : null}
    </>
  );
  return (
    <Sheet open={open} onClose={leave} label={title} testID={testID} dataSet={dataSet} detent="large" head={head}>
      {children}
      <ConfirmSheet open={asking} onClose={() => setAsking(false)} over="form" title={guard?.title ?? `Discard changes to “${title}”?`}
        body={guard?.body ?? "What you changed is not saved."} confirmLabel="Discard changes" onConfirm={discard}
        alt={guard?.saveAndClose && canSave ? { label: "Save and close", onPress: saveAndClose } : undefined}
        cancelLabel={guard?.saveAndClose ? "Keep editing" : undefined} cancelLook={guard?.saveAndClose ? "link" : undefined} mark={guard?.saveAndClose ? "warn" : undefined} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  error: { paddingHorizontal: 8, paddingVertical: 8 },
});
