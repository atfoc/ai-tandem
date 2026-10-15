// The folder chip and its browser (the old page's Composer.tsx DirPicker / DirBrowser). onPick sets the chat's folder; a rejection shows in the
// browser. Whether the browser is open is the toolbar's to keep (one open list at a time). A pick hands the focus back to the chip, as a
// picker's does. The folders are those of a server (this computer's, or the chat's own server's): read there, shortened with that server's
// home, started at its default folder, with its own recent folders.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, type TextStyle } from "react-native";

import { api, type Dirs } from "@aiwb/core/api.ts";
import { folderHead, folderStarts, folderTitle } from "@aiwb/core/logic/chatserver.ts";
import { listsOf } from "@aiwb/core/logic/serverlists.ts";
import { getState } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import { Folder } from "../../ui/icons.tsx";
import { MenuHead } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { base, tildify, useWhere } from "../chat/hooks.ts";
import { Caret, ChipName, TChip, UNTIL_FIRST_MESSAGE } from "./Chip.tsx";
import { recentDirs, rememberDir } from "./recent.ts";

export function DirPicker({ cwd, missing, locked, server, onPick, open, onOpenChange }: {
  cwd: string; missing?: boolean; locked: boolean; server: string; onPick(dir: string): Promise<unknown>; open: boolean; onOpenChange(open: boolean): void;
}) {
  const chip = useRef<View>(null);
  const where = useWhere({ server });
  const name = base(cwd) || "/";
  const { tokens: t } = useTheme();
  if (locked) return <TChip kind="folder" title={folderTitle(where, cwd, { locked })}><Folder color={t.muted} /><ChipName muted>{name}</ChipName></TChip>;
  return (
    <>
      <TChip kind="folder" title={folderTitle(where, cwd, { missing, hint: UNTIL_FIRST_MESSAGE })} chipRef={chip} missing={missing} expanded={open} popup="dialog"
        onPress={() => onOpenChange(!open)}>
        <Folder color={t.muted} /><ChipName missing={missing}>{name}</ChipName><Caret />
      </TChip>
      <Overlay open={open} onClose={() => onOpenChange(false)} label={folderHead(where)} kind="popover" anchor={chip} up testID="dirs" width={300}>
        <DirBrowser start={cwd ?? ""} server={server}
          onPick={async (d) => { await onPick(d); rememberDir(d, server); onOpenChange(false); (chip.current as unknown as { focus?: () => void } | null)?.focus?.(); }} />
      </Overlay>
    </>
  );
}

/** The folders of a server: read there, shortened with that server's home, started at the chat's folder, else the server's default, else
 *  its home. The head says where ("Start the agent in" / "Folder on <server>"). */
export function DirBrowser({ start, server = LOCAL_SERVER, onPick }: { start: string; server?: string; onPick(dir: string): Promise<void> }) {
  const { tokens: t } = useTheme();
  const where = useWhere({ server });
  const tilde = (p?: string) => tildify(p, server);
  const [at, setAt] = useState<Dirs | null>(null);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const asked = useRef(0), edits = useRef(0);
  /** Lists a folder. Of several listings in flight the one asked for last is shown: an answer that comes late (or an error) from an earlier one is
   *  dropped, and the start's fallbacks do not follow it. An answer fills the field with the folder's path unless the field was edited since the
   *  folder was asked for: what is being typed is not taken away. */
  const go = async (p: string) => {
    const mine = ++asked.current, typedThen = edits.current;
    try {
      const r = await api.dirs(p, server);
      if (mine === asked.current) { setAt(r); if (typedThen === edits.current) setTyped(tilde(r.path)); setErr(""); }
      return true;
    } catch (e: any) { if (mine !== asked.current) return true; setErr(e.message); return false; }
  };
  useEffect(() => {
    (async () => {
      const [first, then] = folderStarts(listsOf(getState(), server));
      if (start && await go(start)) return;
      if (!await go(first)) void go(then);
    })();
  }, []);
  const use = async (p: string) => { try { await onPick(p); } catch (e: any) { setErr(e.message); } };
  const recent = recentDirs(server).filter((d) => d !== at?.path).slice(0, 4);
  return (
    <View style={styles.body} {...tid("dir-browser")}>
      <MenuHead>{folderHead(where)}</MenuHead>
      <TextInput {...tid("dir-input")} value={typed} onChangeText={(v) => { edits.current++; setTyped(v); }} placeholder="~/path/to/project" placeholderTextColor={t.faint} autoCapitalize="none" autoCorrect={false} spellCheck={false}
        onSubmitEditing={() => void go(typed)}
        style={[styles.input, { color: t.text, borderColor: t.line2, backgroundColor: t.bg }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
      {err ? <Text {...tid("dir-err")} size={11.5} tone="danger" style={styles.err}>{err}</Text> : null}
      {recent.length > 0 ? <>
        <Text size={11} tone="muted" mono style={styles.sub}>Recent</Text>
        {recent.map((d) => <DirRow key={d} label={tilde(d)} onPress={() => void go(d)} />)}
      </> : null}
      {at ? <>
        <Text size={11} tone="muted" mono numberOfLines={1} style={styles.sub}>{tilde(at.path)}</Text>
        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
          {at.path !== at.parent ? <DirRow label=".." glyph="↰" onPress={() => void go(at.parent)} /> : null}
          {at.dirs.map((d) => <DirRow key={d} label={d} onPress={() => void go(at.path.replace(/\/$/, "") + "/" + d)} />)}
          {!at.dirs.length ? <Text size={12} tone="faint" style={styles.empty}>No subfolders</Text> : null}
        </ScrollView>
        <View style={[styles.foot, { borderTopColor: t.line }]}>
          <UseButton label={`Use ${base(at.path) || "/"}`} onPress={() => void use(at.path)} />
        </View>
      </> : null}
    </View>
  );
}

/** The "Use <folder>" button: a primary small button whose label wraps where the folder's name is longer than the browser is wide. */
function UseButton({ label, onPress }: { label: string; onPress(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(label);
  return (
    <Pressable ref={ref} {...tid("dir-use")} role="button" accessibilityLabel={label} onPress={onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.use, { backgroundColor: t.accentFill }, (hovered || pressed) && ({ filter: "brightness(1.07)" } as object), webStyle({ cursor: "pointer" })]}>
      <Text size={12} tone="onAccent" style={[styles.useText, webStyle({ overflowWrap: "anywhere" }) as TextStyle | undefined]}>{label}</Text>
    </Pressable>
  );
}

function DirRow({ label, glyph, onPress }: { label: string; glyph?: string; onPress(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined);
  return (
    <Pressable ref={ref} {...tid("dir-item")} role="button" accessibilityLabel={label} onPress={onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.row, { backgroundColor: hovered || pressed ? t.accentSoft : "transparent" }, webStyle({ cursor: "pointer" })]}>
      {glyph ? <Text size={12.5} tone="muted">{glyph}</Text> : <Folder color={t.muted} />}
      <Text size={12.5} numberOfLines={1} style={styles.name}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: "stretch", width: "100%", maxWidth: 300, padding: 2 },
  input: { fontSize: 12, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, marginTop: 2, marginBottom: 4 },
  err: { paddingHorizontal: 4, paddingBottom: 4 },
  sub: { paddingHorizontal: 6, paddingTop: 6, paddingBottom: 2 },
  list: { maxHeight: 220 },
  row: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 5, alignSelf: "stretch" },
  name: { flexShrink: 1, minWidth: 0 },
  empty: { paddingVertical: 4, paddingHorizontal: 8 },
  use: { flexShrink: 1, maxWidth: "100%", borderRadius: 6, paddingVertical: 4, paddingHorizontal: 10 },
  useText: { flexShrink: 1, minWidth: 0 },
  foot: { flexDirection: "row", justifyContent: "flex-end", borderTopWidth: 1, marginTop: 4, paddingTop: 6 },
});
