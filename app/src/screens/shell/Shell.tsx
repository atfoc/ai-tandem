// The app shell: the root of what the app shows once it is bootstrapped (AD-71, AD-72, AD-76). It picks the layout by the window's
// width, registers the shortcuts, and draws the overlays that show themselves from the store: the confirm dialog, the one
// toast, and the screens' popups (slots.tsx `Overlays`).
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { markReady } from "../../platform/lifecycle";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { ToastHost } from "../../ui/Toast.tsx";
import { useLayout } from "../../ui/useLayout.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { WideLayout } from "./Layout.tsx";
import { PhoneStack } from "./PhoneStack.tsx";
import { useSlots } from "./slots.tsx";
import { useShortcuts } from "./useShortcuts.ts";

export function Shell() {
  const { tokens: t } = useTheme();
  const layout = useLayout();
  const slots = useSlots();
  useShortcuts();
  useEffect(() => { markReady(); }, []); // the window's check that the page drew (web)
  return (
    <SafeAreaView {...tid("app-root", { layout })} style={[styles.root, { backgroundColor: t.bg }]}>
      {layout === "phone" ? <PhoneStack /> : <WideLayout layout={layout} />}
      {slots.Overlays.map((Overlay, i) => <Overlay key={i} />)}
      <ConfirmDialog />
      <ToastHost />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

