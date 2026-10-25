// "Choose how" (P1, goal 3.8.3, mockup dl-04a): the sheet that names the task and its precondition, with three ways in and a help row. "Scan QR code"
// is offered where the app has a camera; "Paste setup text" is tinted with "In clipboard" only when the platform says the clipboard holds a
// setup text without reading it for the press (the web build with `clipboard-read` granted); on a device it is never read before the press.
import { useEffect, useState } from "react";

import { ActionSheet } from "../../../ui/ActionSheet.tsx";
import { ConfirmSheet } from "../../../ui/ConfirmSheet.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { peekText } from "../../../platform/clipboard";
import { canScan } from "../../../platform/scan";
import { read } from "../addcode.ts";
import { WORDS } from "../facts.ts";
import { S2_TID } from "../ids.ts";
import { EMPTY_FORM } from "./Form.tsx";
import { ClipMark, HelpMark, QrMark, ServerMark, TypeMark } from "./parts.tsx";

export type Way = "scan" | "paste" | "manual";

export const HELP = {
  title: "How do I set up a server?",
  body: "On the computer that runs the server, run setup-remote.sh: it makes the server reachable from other devices and prints its address, certificate fingerprint and secret. "
    + "Then run server-code.sh there: it shows a QR code of the same text, which this phone can scan. Or copy what setup-remote.sh printed and paste it here.",
};

export function Choose({ open, help, onClose, onWay, onHelp, onHelpClose }: {
  open: boolean; help: boolean; onClose(): void; onWay(way: Way): void; onHelp(): void; onHelpClose(): void;
}) {
  const t = useTokens();
  const [clip, setClip] = useState(false);
  useEffect(() => {
    let live = true;
    void peekText().then((text) => { if (live && text && read(EMPTY_FORM, text).ok) setClip(true); }, () => {});
    return () => { live = false; };
  }, []);
  const c = t.text;
  return (
    <>
      <ActionSheet open={open} onClose={onClose} testID={S2_TID.addChoose} head={{ title: WORDS.addTitle, sub: WORDS.addSub, icon: <ServerMark color={t.accent} /> }}
        items={[
          ...(canScan ? [{ id: "scan", label: "Scan QR code", note: "Point the camera at the code the server shows", icon: <QrMark color={c} />, onPress: () => onWay("scan") }] : []),
          { id: "paste", label: "Paste setup text", note: "What setup-remote.sh printed", icon: <ClipMark color={c} />, ...(clip ? { tag: "In clipboard" } : {}), onPress: () => onWay("paste") },
          { id: "manual", label: "Enter address manually", note: "Name, address and secret, typed", icon: <TypeMark color={c} />, onPress: () => onWay("manual") },
        ]}
        after={[{ id: "help", label: HELP.title, icon: <HelpMark color={c} />, onPress: onHelp }]} />
      <ConfirmSheet open={help} onClose={onHelpClose} noticeOnly testID={S2_TID.addHelp} title={HELP.title} body={HELP.body} confirmLabel="" cancelLabel="Close" onConfirm={() => {}} />
    </>
  );
}
