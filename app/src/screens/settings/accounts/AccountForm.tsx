// The add/edit sheet of a Claude account (multiple-claude goal §1.2, screen 2; §1.3 Log in / Log out; §1.6 Restart container and the
// restart dialog after a save; §4.3 Remove account). "+ Add account" and Edit open the same form: on the phone a FormSheet (Cancel · title
// · Save; closing a changed one asks first), on the wide layouts the form inside the accounts dialog (as the Servers dialog's form).
// Fields: Name; Folders to mount (each with ×, a saved one the running container lacks with the chip "New · needs restart", "+ Add folder"
// opens the folder browser a chat's folder uses, on the section's server); ▾ Advanced (closed): Image. Save: core's sheetProblem first
// (shown, nothing sent), then saveAccount; a refusal of the server (a folder that does not exist, …) is shown with its sentence and the
// form stays; an edit answered restart "busy" asks (Later / Restart now). Every word is core's.
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import type { Alias, AliasList } from "@aiwb/core/aliasesapi.ts";
import {
  ACTION_WORDS, IMAGE_HINT, MOUNT_HINT, NEW_FOLDER_CHIP, SCREEN_WORDS, accountSections, containerNote, folderPending, loginKey, rowActions, sheetProblem,
} from "@aiwb/core/logic/aliases.ts";
import { logoutAccount, saveAccount } from "@aiwb/core/state/aliases.ts";

import { useStore } from "../../../state/useStore.ts";
import { Button } from "../../../ui/Button.tsx";
import { DialogActions, DialogTitle } from "../../../ui/Dialog.tsx";
import { FormSheet } from "../../../ui/FormSheet.tsx";
import { TYPE } from "../../../ui/metrics.ts";
import { Overlay } from "../../../ui/Overlay.tsx";
import { Sheet } from "../../../ui/Sheet.tsx";
import { SheetHead } from "../../../ui/SheetHead.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { DirBrowser } from "../../composer/Folder.tsx";
import { reportError } from "../../shell/confirm.ts";
import { askRestart, remove, restart } from "./actions.ts";
import { ACCOUNTS_TID } from "./ids.ts";
import { LoginRow } from "./LoginRow.tsx";
import { formDirty, formOf, inputOf, type AccountForm as Form } from "./model.ts";
import { closeSheet, logIn, type SheetOpen } from "./open.ts";
import { ActionButton, Actions, Chip, Field, Line, useSizes } from "./parts.tsx";

/** The words of "+ Add folder" without its "+": the folder browser's title on the phone. */
const ADD_FOLDER_TITLE = ACTION_WORDS.addFolder.replace(/^\+\s*/, "");

/** The form's state and its Save. Save answers whether it saved; a problem or a refusal is put in `err`. */
function useAccountForm(sheet: SheetOpen) {
  const list: AliasList | undefined = useStore((s) => s.aliases[sheet.server]);
  const a: Alias | undefined = sheet.id ? list?.aliases.find((x) => x.id === sheet.id) : undefined;
  const [initial] = useState(() => formOf(a, list));
  const [f, setF] = useState<Form>(() => formOf(a, list, sheet.prefill));
  const [err, setErr] = useState("");
  const gone = !!sheet.id && !!list && !a; // (removed meanwhile, here or elsewhere)
  useEffect(() => { if (gone) closeSheet(); }, [gone]);
  const set = (p: Partial<Form>) => { setF((x) => ({ ...x, ...p })); setErr(""); };
  const save = async (): Promise<boolean> => {
    const problem = sheetProblem(f);
    if (problem) { setErr(problem); return false; }
    try {
      const r = await saveAccount(sheet.server, sheet.id, inputOf(f, list?.defaultImage ?? ""));
      // (asked once the form has closed: on iOS a dialog that opens in the commit that closes a sheet is not shown)
      if (r.restart === "busy") setTimeout(() => askRestart(sheet.server, r.alias, r.busy ?? r.alias.busy), Platform.OS === "ios" ? 450 : 0);
      return true;
    } catch (e) { setErr((e as Error)?.message || String(e)); return false; }
  };
  return { list, a, f, set, err, setErr, dirty: formDirty(f, initial), save };
}

type FormState = ReturnType<typeof useAccountForm>;

/** The folder browser: the section's server's folders, a popover from "+ Add folder" on the wide layouts, a sheet over the form on the phone. */
function FolderBrowser({ server, start, open, onClose, onPick, anchor }: {
  server: string; start: string; open: boolean; onClose(): void; onPick(dir: string): void; anchor: React.RefObject<View | null>;
}) {
  const { phone } = useSizes();
  const browser = <View {...tid(ACCOUNTS_TID.folderBrowser)} style={phone ? styles.browserPhone : null}><DirBrowser start={start} server={server} onPick={async (d) => onPick(d)} /></View>;
  if (phone) {
    return (
      <Sheet open={open} onClose={onClose} label={ADD_FOLDER_TITLE} over="form" head={<SheetHead title={ADD_FOLDER_TITLE} left={{ label: ACTION_WORDS.cancel, onPress: onClose }} />}>
        {open ? browser : null}
      </Sheet>
    );
  }
  return <Overlay open={open} onClose={onClose} label={ADD_FOLDER_TITLE} kind="popover" anchor={anchor} width={300}>{open ? browser : null}</Overlay>;
}

/** The fields and the edit's extras, the same on every layout. */
function Fields({ sheet, s }: { sheet: SheetOpen; s: FormState }) {
  const t = useTokens(), { phone, name: nameSize } = useSizes();
  const { a, f, set, list } = s;
  const flow = useStore((st) => (a ? st.aliasLogins[loginKey(sheet.server, a.id)] : undefined));
  const [browsing, setBrowsing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const anchor = useRef<View>(null);
  const acts = a && list ? rowActions(a, list.docker) : null;
  const logout = () => { if (!a) return; setBusy(true); logoutAccount(sheet.server, a.id).catch((e) => reportError(`Could not log ${a.name} out`, e)).finally(() => setBusy(false)); };
  const restartNow = () => { if (!a) return; setBusy(true); void restart(sheet.server, a).finally(() => setBusy(false)); };
  return (
    <View style={phone ? styles.bodyPhone : null}>
      <Field label={SCREEN_WORDS.name} testID={ACCOUNTS_TID.name} value={f.name} placeholder={SCREEN_WORDS.namePlaceholder} maxLength={80}
        autoFocus={!a} onChangeText={(name) => set({ name })} />

      <Text size={phone ? TYPE.secondary : 12} tone="muted" style={styles.label}>{SCREEN_WORDS.folders}</Text>
      {f.mounts.length ? (
        <View style={[styles.folders, { borderColor: t.line }]}>
          {f.mounts.map((m, i) => {
            const pending = folderPending(a, m);
            return (
              <View key={m + i} {...tid(ACCOUNTS_TID.folder, { path: m, pending: pending ? "true" : "false" })}
                style={[styles.folder, i > 0 && { borderTopColor: t.line, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={styles.folderWords}>
                  <Text selectable size={phone ? 15 : 12.5} mono style={webStyle({ overflowWrap: "anywhere" }) as object}>{m}</Text>
                  {pending ? <View style={styles.folderChip}><Chip chip={{ text: NEW_FOLDER_CHIP, tone: "warn" }} id="pending" /></View> : null}
                </View>
                <Button tone="ghost" size={phone ? "touch" : "sm"} label="×" accessibilityLabel={`Remove ${m}`} testID={ACCOUNTS_TID.folderRemove}
                  onPress={() => set({ mounts: f.mounts.filter((_, j) => j !== i) })} />
              </View>
            );
          })}
        </View>
      ) : null}
      <View ref={anchor} collapsable={false} style={styles.anchor}>
        <ActionButton label={ACTION_WORDS.addFolder} testID={ACCOUNTS_TID.addFolder} onPress={() => setBrowsing(true)} />
      </View>
      <Line>{MOUNT_HINT}</Line>
      <FolderBrowser server={sheet.server} start={f.mounts.at(-1) ?? ""} open={browsing} anchor={anchor} onClose={() => setBrowsing(false)}
        onPick={(d) => { set({ mounts: [...f.mounts, d] }); setBrowsing(false); }} />  {/* (a folder listed already is listed twice: Save says so, goal §1.2.4) */}

      <Pressable {...tid(ACCOUNTS_TID.advanced, { open: advanced ? "true" : "false" })} role="button" aria-expanded={advanced} accessibilityState={{ expanded: advanced }}
        accessibilityLabel={ACTION_WORDS.advanced.replace(/^▾\s*/, "")} onPress={() => setAdvanced(!advanced)} style={[styles.advanced, phone && styles.advancedPhone, webStyle({ cursor: "pointer" })]}>
        <Text size={nameSize} tone="accent">{ACTION_WORDS.advanced}</Text>
      </Pressable>
      {advanced ? (
        <Field label={SCREEN_WORDS.image} hint={IMAGE_HINT} testID={ACCOUNTS_TID.image} value={f.image} placeholder={list?.defaultImage ?? ""} autoCapitalize="none"
          onChangeText={(image) => set({ image })} />
      ) : null}

      <View style={styles.note}><Line testID={ACCOUNTS_TID.note}>{containerNote(a)}</Line></View>

      {a && acts ? (
        <>
          {flow ? <LoginRow server={sheet.server} id={a.id} flow={flow} /> : null}
          <Actions>
            {acts.login && !flow ? <ActionButton label={ACTION_WORDS.login} testID={ACCOUNTS_TID.loginButton} disabled={!!acts.loginDisabled} title={acts.loginDisabled}
              onPress={() => logIn(sheet.server, a.id)} /> : null}
            {acts.logout ? <ActionButton label={ACTION_WORDS.logout} testID={ACCOUNTS_TID.logout} disabled={busy} onPress={logout} /> : null}
            {acts.restart ? <ActionButton tone="primary" label={ACTION_WORDS.restart} testID={ACCOUNTS_TID.restart} disabled={busy} onPress={restartNow} /> : null}
          </Actions>
          <View style={styles.remove}>
            <ActionButton accessibilityLabel={ACTION_WORDS.remove} testID={ACCOUNTS_TID.remove} onPress={() => remove(sheet.server, a, closeSheet)}>
              <Text size={phone ? TYPE.control : 12} tone="danger">{ACTION_WORDS.remove}</Text>
            </ActionButton>
          </View>
        </>
      ) : null}
    </View>
  );
}

/** The server's name under the title when several servers have accounts (the section the sheet is of). */
function useSub(server: string): string | undefined {
  const servers = useStore((s) => s.servers), lists = useStore((s) => s.aliases);
  const sections = accountSections(servers, lists);
  return sections.length > 1 ? sections.find((x) => x.server === server)?.name : undefined;
}

/** The phone's sheet. */
export function AccountSheet({ sheet }: { sheet: SheetOpen }) {
  const s = useAccountForm(sheet), sub = useSub(sheet.server);
  return (
    <FormSheet open onClose={closeSheet} title={sheet.id ? SCREEN_WORDS.editTitle : SCREEN_WORDS.addTitle} sub={sub} canSave={s.dirty} dirty={s.dirty}
      testID={ACCOUNTS_TID.sheet} dataSet={{ mode: sheet.id ? "edit" : "add", id: sheet.id ?? "" }} saveTestID={ACCOUNTS_TID.save} errorTestID={ACCOUNTS_TID.error}
      error={s.err} onSave={async () => { if (!await s.save()) throw new Error(""); /* (the sentence is in `error`; an empty one adds nothing) */ }}>
      <Fields sheet={sheet} s={s} />
    </FormSheet>
  );
}

/** The wide layouts' form, inside the accounts dialog. */
export function AccountDialogForm({ sheet }: { sheet: SheetOpen }) {
  const s = useAccountForm(sheet), sub = useSub(sheet.server);
  const [saving, setSaving] = useState(false);
  const save = async () => { if (saving) return; setSaving(true); const ok = await s.save(); setSaving(false); if (ok) closeSheet(); };
  return (
    <View {...tid(ACCOUNTS_TID.sheet, { mode: sheet.id ? "edit" : "add", id: sheet.id ?? "" })}>
      <DialogTitle>{sheet.id ? SCREEN_WORDS.editTitle : SCREEN_WORDS.addTitle}</DialogTitle>
      {sub ? <Line>{sub}</Line> : null}
      <Fields sheet={sheet} s={s} />
      {s.err ? <Text {...tid(ACCOUNTS_TID.error)} accessibilityRole="alert" selectable tone="danger" size={12} style={styles.error}>{s.err}</Text> : null}
      <DialogActions>
        <Button size="sm" label={ACTION_WORDS.cancel} testID={ACCOUNTS_TID.cancel} onPress={closeSheet} />
        <Button size="sm" tone="primary" label={saving ? "Saving…" : ACTION_WORDS.save} testID={ACCOUNTS_TID.save} disabled={saving || !s.dirty} onPress={() => void save()} />
      </DialogActions>
    </View>
  );
}

const styles = StyleSheet.create({
  bodyPhone: { paddingHorizontal: 8, paddingBottom: 16 },
  label: { marginTop: 14, marginBottom: 4 },
  folders: { borderWidth: 1, borderRadius: 8, marginBottom: 6 },
  folder: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 10, paddingVertical: 2 },
  folderWords: { flex: 1, minWidth: 0, paddingVertical: 4 },
  folderChip: { flexDirection: "row", marginTop: 2 },
  anchor: { alignSelf: "flex-start", marginBottom: 4 },
  advanced: { alignSelf: "flex-start", marginTop: 14, paddingVertical: 2 },
  advancedPhone: { minHeight: 44, justifyContent: "center" },
  note: { marginTop: 14 },
  remove: { marginTop: 18 },
  error: { marginTop: 10 },
  browserPhone: { paddingHorizontal: 8, alignItems: "center" },
});
