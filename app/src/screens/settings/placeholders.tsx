// The screens that Settings' rows push but whose packages are not built yet (Servers S2, Library S4, Archived H2, Voice S3): each is a
// plain page with what the app has today, so every row of Settings goes somewhere. A placeholder is registered only while the name is
// free, so the owner's own registration wins whichever file is imported first (`registerScreen` overwrites). Interim: the packages above
// replace them.
import { StyleSheet, View } from "react-native";

import { setState } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { openVoiceSettings } from "../../voice/index.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { registerScreen, screenSpec } from "../shell/screens.ts";
import { setShowArchived } from "../sidebar/Foot.tsx";
import { S1_TID } from "./ids.ts";

function Page({ name, children }: { name: string; children: React.ReactNode }) {
  const { tokens: t } = useTheme();
  return <View {...tid(S1_TID.placeholder, { screen: name })} style={[styles.page, { backgroundColor: t.panel }]}>{children}</View>;
}

function Servers() {
  return <Page name="servers"><CellGroup footer="The Servers screen is being built."><Cell label="Open servers" onPress={() => setState({ serversDialog: {} })} /></CellGroup></Page>;
}

function Library() {
  return <Page name="library"><CellGroup footer="The prompt library's screens are being built."><Cell label="Open prompt library" onPress={() => setState({ libraryDialog: {} })} /></CellGroup></Page>;
}

function Voice() {
  return <Page name="voice-settings"><CellGroup footer="Voice's own screen is being built."><Cell label="Open voice settings" onPress={() => openVoiceSettings()} /></CellGroup></Page>;
}

/** The sidebar foot's own switch write (screens/sidebar/Foot.tsx). */
function Archived() {
  const showArchived = useStore((s) => s.showArchived);
  const set = setShowArchived;
  return (
    <Page name="archived">
      <CellGroup footer="The list of archived chats is being built.">
        <Cell label="Show archived chats in the list" trailing={<Switch size="touch" on={showArchived} onChange={set} label="Show archived chats in the list" />} />
      </CellGroup>
    </Page>
  );
}

const PLACEHOLDERS: [name: string, title: string, component: () => React.JSX.Element][] = [
  ["servers", "Servers", Servers],
  ["library", "Prompt library", Library],
  ["archived", "Archived", Archived],
  ["voice-settings", "Voice", Voice],
];

export function registerPlaceholders(): void {
  for (const [name, title, component] of PLACEHOLDERS) {
    if (!screenSpec(name)) registerScreen(name, { kind: "place", title: () => title, component });
  }
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 8 },
});
