// Settings › Claude accounts in the shell's `Overlays` slot (mounted always): on the wide layouts the "Claude accounts" dialog (the list, or
// the add/edit form in its place, as the Servers dialog does), on the phone the add/edit FormSheet over the pushed screen. It also takes
// the store's `accountsNav` (core openAccounts: the chat side's "Log in…" and "Add it in Settings"), each request once (open.ts takeNav).
import { useEffect, useRef } from "react";
import { View } from "react-native";

import { SCREEN_WORDS } from "@aiwb/core/logic/aliases.ts";

import { useStore } from "../../../state/useStore.ts";
import { Button } from "../../../ui/Button.tsx";
import { DialogActions, DialogTitle } from "../../../ui/Dialog.tsx";
import { Overlay } from "../../../ui/Overlay.tsx";
import { usePhone } from "../../../ui/useLayout.ts";
import { AccountDialogForm, AccountSheet } from "./AccountForm.tsx";
import { AccountsList } from "./AccountsList.tsx";
import { ACCOUNTS_TID } from "./ids.ts";
import { closeAccountsDialog, closeSheet, takeNav, useAccountsOpen } from "./open.ts";

export function AccountsHost() {
  const phone = usePhone();
  const nav = useStore((s) => s.accountsNav);
  const { dialog, sheet } = useAccountsOpen();
  const taken = useRef(0);
  useEffect(() => { if (nav && nav.seq !== taken.current) { taken.current = nav.seq; takeNav(nav); } }, [nav]);
  if (phone) return sheet ? <AccountSheet key={sheet.n} sheet={sheet} /> : null;
  if (!dialog) return null;
  return (
    <Overlay open kind="dialog" label={SCREEN_WORDS.title} width={600} testID={ACCOUNTS_TID.dialog} closeOnBackdrop={!sheet}
      onClose={() => (sheet ? closeSheet() : closeAccountsDialog())}>
      {sheet ? <AccountDialogForm key={sheet.n} sheet={sheet} /> : (
        <View>
          <DialogTitle>{SCREEN_WORDS.title}</DialogTitle>
          <AccountsList />
          <DialogActions>
            <Button size="sm" label="Close" testID={ACCOUNTS_TID.close} autoFocus onPress={closeAccountsDialog} />
          </DialogActions>
        </View>
      )}
    </Overlay>
  );
}

