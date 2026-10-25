// The gallery of the phone kit (ux-improvements package F1, plans/ux-improvements/PLAN.md §2 F1): every new part of ui/ drawn on one
// page for the browser checks (web/dev/checks/UX.F1-kit.mjs) and the device self-test. The web build shows it when the URL has
// `?gallery=kit` (App.tsx); a native build with EXPO_PUBLIC_AIWB_GALLERY=kit. It is not part of any screen. The sections are in
// dev/kit/, one file per part; each opens its cases by buttons with the testIDs `kit-open-<case>` and writes what was pressed into
// its own readout `kit-<section>-last`.
import type { ReactNode } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { ToastHost } from "../ui/Toast.tsx";
import { useTheme } from "../ui/theme.tsx";
import { useLayout } from "../ui/useLayout.ts";
import * as cells from "./kit/cells.tsx";
import * as forms from "./kit/forms.tsx";
import * as picker from "./kit/picker.tsx";
import * as sheets from "./kit/sheets.tsx";
import * as sizes from "./kit/sizes.tsx";
import * as swipe from "./kit/swipe.tsx";
import * as toast from "./kit/toast.tsx";

function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  const { tokens: t } = useTheme();
  return (
    <View testID={`kit-section-${id}`} style={[styles.section, { borderColor: t.line }]}>
      <Text weight="600" tone="muted" size={13} style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const SECTIONS: { id: string; title: string; Body: () => ReactNode }[] = [
  { id: "sizes", title: "Sizes", Body: sizes.Section },
  { id: "sheets", title: "Sheets and P1", Body: sheets.Section },
  { id: "picker", title: "P2 and search", Body: picker.Section },
  { id: "forms", title: "P3 and P4", Body: forms.Section },
  { id: "cells", title: "P5 and bars", Body: cells.Section },
  { id: "toast", title: "Toast", Body: toast.Section },
  { id: "swipe", title: "Swipe rows", Body: swipe.Section },
];

export function KitGallery() {
  const { tokens: t, theme, setPref } = useTheme();
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  return (
    <View style={[styles.fill, { backgroundColor: t.bg, paddingTop: insets.top }]}>
      <ScrollView testID="kit-gallery" style={styles.fill} contentContainerStyle={styles.page}>
        <Text size={18} weight="600">Phone kit</Text>
        <View style={styles.row}>
          <Text testID="gallery-layout" dataSet={{ layout }}>{layout}</Text>
          <Text testID="gallery-window" tone="faint">{`${Math.round(win.width)}×${Math.round(win.height)}`}</Text>
          <Text testID="gallery-theme" tone="faint">{theme}</Text>
          <Button size="sm" label="Light" testID="gallery-theme-light" onPress={() => setPref("light")} />
          <Button size="sm" label="Dark" testID="gallery-theme-dark" onPress={() => setPref("dark")} />
          <Button size="sm" label="Mocha" testID="gallery-theme-mocha" onPress={() => setPref("mocha")} />
        </View>
        {SECTIONS.map(({ id, title, Body }) => <Section key={id} id={id} title={title}><Body /></Section>)}
      </ScrollView>
      <toast.BarHost />
      <ToastHost />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  page: { padding: 16, gap: 12, paddingBottom: 120 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  section: { borderTopWidth: 1, paddingTop: 8, gap: 8 },
  sectionTitle: { textTransform: "uppercase", letterSpacing: 0.4 },
});
