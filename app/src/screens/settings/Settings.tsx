// Settings (ux-improvements goal 3.8.1, P5): one pushed screen from Home's gear, grouped rows that each push a page; no inline control.
// Its bar ("‹ Home", the centred title) is the pushed route's (screens/shell/phone/PushedRoute.tsx). Each row says its value or its state
// in the words of rows.ts; Voice's key is read from the keystore (no request) when the screen shows and again when a screen above it goes.
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { pageVersion } from "@aiwb/core/state/version.ts";

import { useStore } from "../../state/useStore.ts";
import { voice, useVoiceSettings } from "../../voice/index.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { MicIcon, SunIcon } from "../../ui/icons.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { useTheme, useTokens } from "../../ui/theme.tsx";
import { pushScreen, subscribePushed } from "../shell/screens.ts";
import { ArchiveGlyph, InfoGlyph, LibraryGlyph, ServersGlyph, Tile } from "./icons.tsx";
import { S1_TID } from "./ids.ts";
import { appearanceLine, archivedValue, libraryValue, serversLine, voiceLine } from "./rows.ts";

/** Whether the voice key is set: null until the keystore has answered. Read again whenever the stack changes, so a return from Voice shows
 *  the key just saved. It is a local read; nothing else of voice is asked. */
function useHasKey(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => { voice.hasKey().then((v) => { if (live) setHas(v); }, () => { /* the keystore did not answer: the row says nothing */ }); };
    read();
    const off = subscribePushed(read);
    return () => { live = false; off(); };
  }, []);
  return has;
}

export function Settings() {
  const t = useTokens(), { pref } = useTheme(), bottom = useSafeAreaInsets().bottom;
  const servers = useStore((s) => s.servers), libraries = useStore((s) => s.libraries), chats = useStore((s) => s.chats);
  const localNetworkDenied = useStore((s) => s.localNetworkDenied);
  const hasKey = useHasKey();
  const voiceName = useVoiceSettings((s) => s.voiceName), autoSend = useVoiceSettings((s) => s.autoSend);
  const line = useMemo(() => serversLine(servers, { localNetworkDenied }), [servers, localNetworkDenied]);
  const row = (name: string) => ({ testID: S1_TID.row, data: { row: name }, onPress: () => { pushScreen(name === "voice" ? "voice-settings" : name, {}); } });
  return (
    <ScrollView {...{ testID: S1_TID.screen }} style={{ backgroundColor: t.panel }} contentContainerStyle={[styles.content, { paddingBottom: bottom + PHONE.margin }]}>
      <CellGroup title="Servers">
        <Cell {...row("servers")} label="Servers" sub={line.text} subTone={line.attention ? "warn" : undefined}
          leading={<Tile colour="viz1">{(c) => <ServersGlyph color={c} />}</Tile>} />
      </CellGroup>
      <CellGroup title="Library">
        <Cell {...row("library")} label="Prompt library" value={libraryValue(libraries)} leading={<Tile colour="accentFill">{(c) => <LibraryGlyph color={c} />}</Tile>} />
        <Cell {...row("archived")} label="Archived" value={archivedValue(chats)} leading={<Tile colour="viz4">{(c) => <ArchiveGlyph color={c} />}</Tile>} />
      </CellGroup>
      <CellGroup title="Voice">
        <Cell {...row("voice")} label="Voice" sub={voiceLine({ hasKey, voiceName, autoSend })} leading={<Tile colour="danger">{(c) => <MicIcon size={17} color={c} />}</Tile>} />
      </CellGroup>
      <CellGroup title="Display">
        <Cell {...row("appearance")} label="Appearance" sub={appearanceLine(pref)} leading={<Tile colour="viz2">{(c) => <SunIcon size={17} color={c} />}</Tile>} />
      </CellGroup>
      <CellGroup title="About">
        <Cell {...row("about")} label="About" value={pageVersion()} leading={<Tile colour="muted">{(c) => <InfoGlyph color={c} />}</Tile>} />
      </CellGroup>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
});
