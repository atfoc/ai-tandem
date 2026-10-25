// The folder picker of a new chat on the phone (ux-improvements goal 3.6, mockup "03 The pickers" co-03d, caption co-03f): "Start the agent in",
// the server's name as its sub-line, Cancel at the left (a flow that commits with a button); the path shown once with its end visible and a
// 44-pt Up before it; a tap on the path types one (the field `dir-input`); "Folders in <name>" over 52-pt folder rows with a chevron; an empty
// folder says "No subfolders" and "Use this folder, or go up."; a sticky full-width "Use <folder>" (the sheet's footer) whose label names the
// folder shown. No Recent list: it opens in the chat's folder. The folders are read on the chat's server (api.dirs), as DirBrowser does
// (screens/composer/Folder.tsx: the order of the answers, the start's fallbacks); the head and the path row stay while the rows scroll.
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, useWindowDimensions, View, type TextStyle } from "react-native";

import { api, type Dirs } from "@aiwb/core/api.ts";
import { folderStarts } from "@aiwb/core/logic/chatserver.ts";
import { listsOf } from "@aiwb/core/logic/serverlists.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { Button } from "../../../../ui/Button.tsx";
import { DisclosureChevron, Folder, Pencil } from "../../../../ui/icons.tsx";
import { MONO } from "../../../../ui/fonts.ts";
import { PHONE, TYPE } from "../../../../ui/metrics.ts";
import { Sheet } from "../../../../ui/Sheet.tsx";
import { SheetHead } from "../../../../ui/SheetHead.tsx";
import { InSheetFooter } from "../../../../ui/sheetfooter.tsx";
import { Text } from "../../../../ui/Text.tsx";
import { useTokens } from "../../../../ui/theme.tsx";
import { tid } from "../../../../ui/tid.ts";
import { webStyle } from "../../../../ui/webstyle.ts";
import { base, tildify, useWhere } from "../../../chat/hooks.ts";
import { rememberDir } from "../../recent.ts";
import { childPath, pathParts, upName } from "./dirpath.ts";
import { C2_IDS } from "./ids.ts";

/** On the web the sheet's footer stays in place (ui/sheetfooter.tsx), so the body is as tall as the sheet's scroll area at least (the window less the
 *  handle, the head and the path row) and the footer sticks to its bottom. */
const WEB_CHROME = 200;

export type FolderSheetProps = {
  open: boolean;
  onClose(): void;
  /** The chat's folder: where the sheet opens. */
  cwd: string;
  /** The chat's server (an entry id). */
  server: string;
  /** Sets the chat's folder; a refusal rejects, and its words stay in the sheet. The sheet closes on success. */
  onPick(dir: string): Promise<unknown>;
};

export function FolderSheet(p: FolderSheetProps) {
  const t = useTokens();
  const win = useWindowDimensions();
  const where = useWhere({ server: p.server });
  const tilde = (s?: string) => tildify(s, p.server);
  const [at, setAt] = useState<Dirs | null>(null);
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  const cwd = useRef(p.cwd);
  cwd.current = p.cwd;

  /** Lists a folder. Of several listings in flight the one asked for last is shown: an answer that comes late (or an error) from an earlier
   *  one is dropped, and the start's fallbacks do not follow it. */
  const go = async (path: string) => {
    const mine = ++asked.current;
    try {
      const r = await api.dirs(path, p.server);
      if (mine === asked.current) { setAt(r); setErr(""); }
      return true;
    } catch (e: any) { if (mine !== asked.current) return true; setErr(e.message); return false; }
  };

  // Each time it opens it starts again at the chat's folder, else the server's default, else its home; a closed sheet keeps nothing.
  useEffect(() => {
    if (!p.open) { asked.current++; return; }
    setAt(null); setTyped(""); setEditing(false); setErr(""); setBusy(false);
    (async () => {
      const [first, then] = folderStarts(listsOf(getState(), p.server));
      if (cwd.current && await go(cwd.current)) return;
      if (!await go(first)) void go(then);
    })();
  }, [p.open]);

  const use = async () => {
    if (!at || busy) return;
    setBusy(true);
    try { await p.onPick(at.path); rememberDir(at.path, p.server); p.onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const submit = () => { setEditing(false); if (typed.trim()) void go(typed.trim()); };
  const atRoot = !at || at.path === at.parent;
  const here = at ? base(at.path) || "/" : "";
  const shown = at ? tilde(at.path) : "";
  const parts = pathParts(shown);

  const head = (
    <>
      <SheetHead title="Start the agent in" sub={where.name} left={{ label: "Cancel", onPress: p.onClose }} />
      <View style={styles.pathRow}>
        <Pressable {...tid(C2_IDS.dirUp)} accessibilityRole="button" accessibilityLabel={atRoot ? "Up" : `Up to ${upName(tilde(at!.parent))}`}
          disabled={atRoot} accessibilityState={{ disabled: atRoot }} onPress={() => void go(at!.parent)}
          style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.up, { borderColor: t.line2, backgroundColor: hovered || pressed ? t.accentSoft : t.panel }, atRoot && styles.off, webStyle({ cursor: atRoot ? "default" : "pointer" })]}>
          <Text size={22} tone="accent" accessibilityElementsHidden>↑</Text>
        </Pressable>
        {editing ? (
          <TextInput {...tid("dir-input")} autoFocus value={typed} onChangeText={setTyped} onSubmitEditing={submit} onBlur={() => setEditing(false)}
            placeholder="~/path/to/project" placeholderTextColor={t.faint} autoCapitalize="none" autoCorrect={false} spellCheck={false} returnKeyType="go"
            accessibilityLabel="Type a path"
            style={[styles.box, styles.input, { color: t.text, borderColor: t.accent, backgroundColor: t.bg }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
        ) : (
          <Pressable {...tid(C2_IDS.dirPath)} role="button" accessibilityLabel="Type a path" onPress={() => { setTyped(shown); setEditing(true); }}
            style={[styles.box, { borderColor: t.line2, backgroundColor: t.panel }, webStyle({ cursor: "text" })]}>
            {/* (the end stays in sight: the part before the name gives way first, cut at its head; the web has no ellipsizeMode "head", so
                there the part is laid out right to left, its characters kept in order by a left-to-right embedding) */}
            <View style={styles.path}>
              <Text size={TYPE.control} mono numberOfLines={1} ellipsizeMode="head" tone="muted" style={[styles.before, webStyle({ direction: "rtl", textAlign: "left" }) as TextStyle | undefined]}>
                {Platform.OS === "web" ? `\u202A${parts.before}\u202C` : parts.before}
              </Text>
              <Text size={TYPE.control} mono weight="700" numberOfLines={1} style={styles.pathName}>{parts.name}</Text>
            </View>
            <Pencil size={16} color={t.muted} />
          </Pressable>
        )}
      </View>
      {err ? <Text {...tid("dir-err")} size={TYPE.secondary} tone="danger" style={styles.err}>{err}</Text> : null}
    </>
  );

  return (
    <Sheet open={p.open} onClose={p.onClose} label="Start the agent in" detent="large" testID={C2_IDS.folderSheet} head={head}>
      <View {...tid("dir-browser")} style={webStyle({ minHeight: win.height - WEB_CHROME }) as object | undefined}>
        {!at ? (
          err ? null : <Text size={TYPE.secondary} tone="muted" style={styles.loading}>Loading folders…</Text>
        ) : (
          <>
            <Text {...tid(C2_IDS.dirHead)} size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.sub}>Folders in {here}</Text>
            {at.dirs.length ? at.dirs.map((d) => <DirRow key={d} name={d} onPress={() => void go(childPath(at.path, d))} />) : (
              <View {...tid(C2_IDS.dirEmpty)} style={styles.empty}>
                <Folder size={40} color={t.faint} />
                <Text size={TYPE.control} style={styles.emptyTitle}>No subfolders</Text>
                <Text size={TYPE.secondary} tone="muted">Use this folder, or go up.</Text>
              </View>
            )}
          </>
        )}
        <InSheetFooter inPlace={at ? <View style={[styles.foot, { backgroundColor: t.bg }, webStyle({ position: "sticky", bottom: 0, marginTop: "auto" })]}>{useButton(`Use ${here}`, use, busy)}</View> : null}>
          {at ? <View style={styles.footIn}>{useButton(`Use ${here}`, use, busy)}</View> : null}
        </InSheetFooter>
      </View>
    </Sheet>
  );
}

/** The sheet's one action: a full-width button whose label names the folder shown. */
function useButton(label: string, onPress: () => void, busy: boolean) {
  // (a long name wraps: the label always names the whole folder shown)
  return (
    <Button {...tid("dir-use")} tone="primary" size="block" accessibilityLabel={label} disabled={busy} onPress={onPress}>
      <Text size={TYPE.control} tone="onAccent" style={[styles.useText, webStyle({ overflowWrap: "anywhere" }) as TextStyle | undefined]}>{label}</Text>
    </Button>
  );
}

function DirRow({ name, onPress }: { name: string; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid("dir-item")} role="button" accessibilityLabel={name} onPress={onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [styles.row, { borderBottomColor: t.line, backgroundColor: hovered || pressed ? t.accentSoft : "transparent" }, webStyle({ cursor: "pointer" })]}>
      <Folder size={22} color={t.accent} />
      <Text size={TYPE.control} numberOfLines={1} style={styles.name}>{name}</Text>
      <DisclosureChevron size={13} color={t.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pathRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: PHONE.margin - 8, paddingTop: 8, paddingBottom: 4 },
  up: { width: PHONE.target, height: PHONE.target, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.4 },
  box: { flex: 1, minWidth: 0, height: PHONE.target, borderRadius: 10, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  input: { fontSize: TYPE.control, fontFamily: MONO },
  path: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center" },
  before: { flexShrink: 1, minWidth: 0 },
  pathName: { flexShrink: 0, maxWidth: "100%" },
  err: { paddingHorizontal: PHONE.margin - 8, paddingTop: 4, paddingBottom: 4 },
  sub: { paddingHorizontal: PHONE.margin - 8, paddingTop: 12, paddingBottom: 6 },
  loading: { paddingHorizontal: PHONE.margin - 8, paddingVertical: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 52, paddingHorizontal: PHONE.margin - 8, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { flex: 1, minWidth: 0 },
  useText: { flexShrink: 1, minWidth: 0, textAlign: "center", paddingVertical: 4 },
  empty: { alignItems: "center", gap: 6, paddingVertical: 28, paddingHorizontal: PHONE.margin },
  emptyTitle: { marginTop: 4 },
  foot: { paddingHorizontal: PHONE.margin - 8, paddingTop: 12, paddingBottom: 4 },
  footIn: { paddingHorizontal: PHONE.margin - 8 },
});
