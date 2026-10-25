// About (ux-improvements goal 3.8.1, P5): the app's version, a link to Help (it opens outside the app: ↗, not a chevron) and, on the
// desktop app only, the server's log.
import { ScrollView, StyleSheet } from "react-native";

import { inDesktopApp, openServerLog, pageVersion } from "@aiwb/core/state/version.ts";

import { openLink } from "../../platform/openlink";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { S1_TID } from "./ids.ts";

/** Where Help goes: the repository's README. The lead and the user confirm this address. */
export const HELP_URL = "https://github.com/atfoc/ai-tandem#readme";

export function About() {
  const t = useTokens();
  return (
    <ScrollView {...{ testID: S1_TID.about }} style={{ backgroundColor: t.panel }} contentContainerStyle={styles.content}>
      <CellGroup>
        <Cell testID={S1_TID.aboutRow} data={{ row: "version" }} label="Version" value={pageVersion()} />
        <Cell testID={S1_TID.aboutRow} data={{ row: "help" }} label="Help" chevron={false} onPress={() => openLink(HELP_URL)}
          trailing={<Text size={TYPE.control} tone="faint">↗</Text>} />
        {inDesktopApp() ? <Cell testID={S1_TID.aboutRow} data={{ row: "log" }} label="Server log" chevron={false} onPress={openServerLog} /> : null}
      </CellGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8, paddingBottom: 24 },
});
