// P4, the confirm (ux-improvements goal 3.1.4): what cannot be undone. A red tile, a 20 pt title with the object in quotes, a sentence
// saying what is lost and where ("from Studio Mac"), a full-width 50 pt button that repeats the verb and the noun ("Delete chat"),
// a grey Cancel below it. Busy and error stay inside the sheet; it is never the centred system alert. On the wide layouts the
// app's confirm dialog stays as it is (goal 4.2): `confirm()` of screens/shell/confirm.ts picks this sheet on the phone.
//
// It is a Sheet of the `fit` detent. The go button is off while the action runs, with its label kept and a spinner beside it; a throw
// is shown in the sheet (`confirm-error`, an alert), which stays open; after success the sheet closes itself (`onClose`).
import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import { Button } from "./Button.tsx";
import { TYPE } from "./metrics.ts";
import { Sheet } from "./Sheet.tsx";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

export type ConfirmSheetProps = {
  open: boolean;
  onClose(): void;
  /** With the object in quotes: `Delete “Fix the flaky cart test”?` */
  title: string;
  /** What is lost and where. */
  body: string;
  /** The verb and the noun: "Delete chat", "Remove server", "Trust and reconnect". */
  confirmLabel: string;
  /** "danger" (red, the default) or "accent" (a confirm that loses nothing, e.g. Save and close of a leave guard). */
  tone?: "danger" | "accent";
  cancelLabel?: string;
  /** Answers when done; a throw is shown inside the sheet, which stays open. The sheet closes itself after success. */
  onConfirm(): void | Promise<void>;
  /** This sheet opens over a form sheet (the leave guard of a P3): the one sheet over a sheet that is allowed. */
  over?: "form";
  /** Only the grey button, no go button: a notice (an error the user should see). `cancelLabel` is then its label ("Close"). */
  noticeOnly?: boolean;
  /** A second way forward under the go button, soft accent ("Save and close" of a leave guard); busy and error as the go button's. */
  alt?: { label: string; onPress(): void | Promise<void> };
  /** The cancel as a plain accent link instead of the grey button ("Keep editing" of a leave guard). */
  cancelLook?: "button" | "link";
  /** The tile's mark: "warn" an amber ⚠ (a leave guard); by default a bin (danger) or a circled "i" (accent). */
  mark?: "warn";
  testID?: string;
};

const TILE = 44;
const BODY = TYPE.secondary + 2; // the sentence under the title: 15 pt, never under

export function ConfirmSheet({ open, onClose, title, body, confirmLabel, tone = "danger", cancelLabel = "Cancel", onConfirm, over, noticeOnly, alt, cancelLook = "button", mark, testID = TID.confirmSheet }: ConfirmSheetProps) {
  const t = useTokens();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const danger = tone === "danger";
  const run = async (act: () => void | Promise<void>) => {
    setBusy(true); setError("");
    try { await act(); onClose(); } catch (e) { setError((e as Error)?.message ?? String(e)); } finally { setBusy(false); }
  };
  const go = () => run(onConfirm);
  const warn = noticeOnly || mark === "warn";
  const glyph = mark === "warn" ? t.warn : danger ? t.danger : t.accent;
  return (
    <Sheet open={open} onClose={onClose} label={title} testID={testID} detent="fit" over={over}>
      <View style={styles.body}>
        <View {...tid(TID.confirmTile)} style={[styles.tile, { backgroundColor: mark === "warn" ? t.warnSoft : danger ? t.dangerSoft : t.accentSoft }]}>
          <Glyph kind={warn ? "warn" : danger ? "bin" : "info"} color={glyph} />
        </View>
        <Text {...tid(TID.confirmTitle)} size={TYPE.confirmTitle} weight="600" accessibilityRole="header">{title}</Text>
        {body ? <Text {...tid(TID.confirmBody)} size={BODY} tone="muted">{body}</Text> : null}
        {error ? <Text {...tid(TID.confirmError)} size={BODY} tone="danger" accessibilityRole="alert">{error}</Text> : null}
        <View style={styles.buttons}>
          {noticeOnly ? null : (
            <Button {...tid(TID.confirmGo)} size="block" tone={danger ? "danger" : "primary"} label={confirmLabel} disabled={busy}
              icon={busy ? <ActivityIndicator size="small" color={danger ? t.onDanger : t.onAccent} /> : undefined} onPress={() => void go()} />
          )}
          {alt && !noticeOnly ? (
            <Button {...tid(TID.confirmAlt)} size="block" label={alt.label} disabled={busy} onPress={() => void run(alt.onPress)}
              style={{ backgroundColor: t.accentSoft, borderColor: t.accentSoft }} />
          ) : null}
          {cancelLook === "link"
            ? <Button {...tid(TID.confirmCancel)} size="touch" tone="ghost" onPress={onClose} accessibilityLabel={cancelLabel} style={styles.link}><Text size={TYPE.control} tone="accent">{cancelLabel}</Text></Button>
            : <Button {...tid(TID.confirmCancel)} size="block" label={cancelLabel} onPress={onClose} style={{ backgroundColor: t.panel, borderColor: t.panel }} />}
        </View>
      </View>
    </Sheet>
  );
}

/** A bin for what is deleted, a circled "i" for a question that loses nothing, a triangle for a notice; 24 pt in the tile. */
function Glyph({ kind, color }: { kind: "bin" | "info" | "warn"; color: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {kind === "bin" ? <Path d="M4 7h16M10 7V4.5h4V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" />
        : kind === "warn" ? <Path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17v.4" />
        : <><Circle cx="12" cy="12" r="8.5" /><Path d="M12 11v5.5M12 7.8v.4" /></>}
    </Svg>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8 },
  tile: { width: TILE, height: TILE, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  buttons: { gap: 10, paddingTop: 4 },
  link: { alignSelf: "center" },
});
