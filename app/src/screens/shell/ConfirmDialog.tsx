// The confirm dialog (the old page's Dialogs.tsx `ConfirmDialog`): a title, an optional body, an optional red error line, "Cancel" (or "Close"
// when there are no actions) and the actions, the last of which has the focus. Esc or a press on the backdrop closes it; an action
// that fails leaves the dialog open with the error's sentence in it, and the action off while it runs. On the phone (AD-70) a request with
// one action is a P4 ConfirmSheet (a red tile, a 50 pt button repeating the verb and the noun, a grey Cancel; `confirmLabel` is the
// button's text, the action's own label when absent), one with none (an error to see) the same sheet with only Close; one with several
// actions (the group's delete: move or delete everything) stays the dialog, drawn as a sheet by Overlay.
import { useEffect, useState } from "react";

import { setState, type ConfirmRequest } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogActions, DialogBody, DialogError, DialogTitle } from "../../ui/Dialog.tsx";
import { ConfirmSheet } from "../../ui/ConfirmSheet.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { usePhone } from "../../ui/useLayout.ts";

export const CONFIRM_ID = "confirm-dialog";

/** Over a sheet or any other open overlay it is drawn inside that one (ui/overlayhost.tsx), so it shows on iOS too. */
export function ConfirmDialog() {
  const req = useStore((s) => s.confirm);
  const phone = usePhone();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const close = () => { setState({ confirm: null }); setErr(""); setBusy(false); };
  if (!req) return null;
  const run = async (a: ConfirmRequest["actions"][number]) => {
    setBusy(true); setErr("");
    try { await a.run(); close(); } catch (e: any) { setErr(e?.message ?? String(e)); setBusy(false); }
  };
  if (phone && req.actions.length <= 1) {
    const a = req.actions[0];
    return (
      <ConfirmSheet key={req.title} open onClose={close} testID={CONFIRM_ID} title={req.title} body={req.body ?? ""}
        confirmLabel={req.confirmLabel ?? a?.label ?? ""} tone={a?.tone === "danger" || !a ? "danger" : "accent"}
        cancelLabel={a ? "Cancel" : "Close"} noticeOnly={!a} onConfirm={async () => { await a?.run(); }} />
    );
  }
  return (
    <Overlay open kind="dialog" label={req.title} onClose={close} testID={CONFIRM_ID}>
      <DialogTitle>{req.title}</DialogTitle>
      {req.body ? <DialogBody>{req.body}</DialogBody> : null}
      {err ? <DialogError>{err}</DialogError> : null}
      <DialogActions>
        <Button size="sm" label={req.actions.length ? "Cancel" : "Close"} onPress={close} autoFocus={!req.actions.length} />
        {req.actions.map((a, i) => (
          <Button key={a.label} size="sm" tone={a.tone} label={a.label} disabled={busy} autoFocus={i === req.actions.length - 1} onPress={() => void run(a)} />
        ))}
      </DialogActions>
    </Overlay>
  );
}
