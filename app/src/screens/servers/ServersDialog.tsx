// The Servers dialog (the old page's Servers.tsx `ServersDialog`): the list of servers this app connects to, with add, edit, remove, "Test connection"
// and the fingerprint of a self-signed certificate to compare and accept. This computer is its first row where the transport offers the
// owner's things (model.ts). A centred dialog on the wide layouts and a bottom sheet on the phone (AD-70): `Overlay` decides. It is mounted
// always (the shell's `Overlays` slot) and shows itself from the store's `serversDialog`. Esc leaves the form first, then the dialog (and not
// while the confirm dialog is above: the overlay stack's top answers); a press on the dimmed page closes the dialog, not while a form is open.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { listed } from "@aiwb/core/state/serversdialog.ts";
import { setState } from "@aiwb/core/state/store.ts";
import { appCall } from "@aiwb/core/api.ts";
import { mcpLine, type ServerForm as Form } from "@aiwb/core/logic/servers.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogActions, DialogError, DialogTitle } from "../../ui/Dialog.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { editForm, ownerThings, rowsOf } from "./model.ts";
import { ServerForm } from "./ServerForm.tsx";
import { ServerRow } from "./ServerRow.tsx";
import { said } from "./parts.tsx";

export const SERVERS_DIALOG_ID = "servers-dialog";

const EMPTY: Form = { name: "", address: "", secret: "", selfSigned: false, pin: "" };

export function ServersDialog() {
  const { tokens: t } = useTheme();
  const dlg = useStore((s) => s.serversDialog);
  const servers = useStore((s) => s.servers);
  const notice = useStore((s) => s.serversNotice);
  const shown = !!dlg;
  // n counts the forms opened, so that a second one starts from its own values.
  const [open, setOpen] = useState<{ form: Form; n: number } | null>(() => (dlg?.form ? { form: dlg.form, n: 0 } : null));
  const [err, setErr] = useState("");
  const [mcp, setMcp] = useState(""); // the state of this computer's MCP listener, read when the dialog opens
  const owner = ownerThings();
  const close = () => { setOpen(null); setErr(""); setState({ serversDialog: null }); };
  // A form the dialog was opened with is taken once: it stays in this component alone.
  useEffect(() => {
    const form = dlg?.form;
    if (!form) return;
    setOpen((o) => ({ form, n: (o?.n ?? 0) + 1 }));
    setState({ serversDialog: {} });
  }, [dlg?.form]);
  // The notice, which no snapshot carries. The entries are the stream's.
  useEffect(() => {
    if (!shown) return;
    setErr("");
    serversApi.list().then(listed, (e) => setErr(said(e)));
  }, [shown]);
  // This computer's MCP listener, which only its owner can read (the app runs the server's status command). Nothing is shown when it cannot be read.
  useEffect(() => {
    if (!shown || !owner) return;
    let live = true;
    appCall("owner.status").then((r) => { if (live) setMcp(mcpLine(r)); }, () => { if (live) setMcp(""); });
    return () => { live = false; };
  }, [shown, owner]);
  if (!dlg) return null;
  return (
    <Overlay open kind="dialog" label="Servers" width={560} testID={SERVERS_DIALOG_ID} closeOnBackdrop={!open} onClose={() => (open ? setOpen(null) : close())}>
      {open ? <ServerForm key={open.n} initial={open.form} onClose={() => setOpen(null)} /> : (
        <>
          <DialogTitle>Servers</DialogTitle>
          {notice ? <View {...tid("servers-notice")} style={[styles.notice, { backgroundColor: t.warnSoft, borderColor: t.warn }]}><Text selectable size={12}>{notice}</Text></View> : null}
          {err ? <DialogError>{err}</DialogError> : null}
          <View {...tid("servers-list")} style={styles.list}>
            {rowsOf(servers, owner).map((v) => (
              <ServerRow key={v.id} v={v} owner={owner} mcp={v.local ? mcp : ""} onEdit={(x) => setOpen((o) => ({ form: editForm(x), n: (o?.n ?? 0) + 1 }))} />
            ))}
          </View>
          <DialogActions>
            <Button size="sm" label="Close" testID="servers-close" onPress={close} />
            <Button size="sm" tone="primary" label="Add server" testID="servers-add" autoFocus onPress={() => setOpen((o) => ({ form: EMPTY, n: (o?.n ?? 0) + 1 }))} />
          </DialogActions>
        </>
      )}
    </Overlay>
  );
}

const styles = StyleSheet.create({
  notice: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1 },
  list: { marginTop: 10, gap: 8 },
});
