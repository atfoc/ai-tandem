// Settings › Claude accounts on the phone (multiple-claude goal §1.1): a pushed place screen titled "Claude accounts" (its bar is the
// stack's) whose body is the list the wide layouts' dialog draws too (AccountsList.tsx). The add/edit sheet is the host's (AccountsHost.tsx).
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SCREEN_WORDS } from "@aiwb/core/logic/aliases.ts";

import { PHONE } from "../../../ui/metrics.ts";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import type { ScreenSpec } from "../../shell/screens.ts";
import { AccountsList } from "./AccountsList.tsx";
import { ACCOUNTS_TID } from "./ids.ts";

export function AccountsScreen() {
  const t = useTokens(), bottom = useSafeAreaInsets().bottom;
  return (
    <ScrollView {...tid(ACCOUNTS_TID.screen)} style={[styles.fill, { backgroundColor: t.panel }]} contentContainerStyle={{ paddingTop: 4, paddingBottom: bottom + PHONE.margin * 2 }}>
      <AccountsList />
    </ScrollView>
  );
}

export const ACCOUNTS_SPEC: ScreenSpec<Record<string, never>> = { kind: "place", title: () => SCREEN_WORDS.title, component: AccountsScreen };

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
