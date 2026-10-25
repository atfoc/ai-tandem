// The composer (package K3; AD-62): the message box under a chat, its toolbar, the @ list, the lines, the drafts. Registers itself in the
// chat view's `Composer` part (screens/chat/parts.tsx) and as the place the shell's `focusComposer` goes to. Imported by screens/register.ts.
//
// What the packages after it plug into (parts.tsx `setComposerPart`): K4 the image strip, the attach button and the picker; K5 the quotes of
// the draft and the text selected in a message; S7 the Subagents chip; S9 the context meter; S8 the banner of a pending move; V1 (Blocked.tsx, registered below) the phone's blocked states. What S11 plugs
// into: nothing in the composer — the insert popup is opened through the box (`openInsert`) and core's `openInsertPopup`.
import { chipKinds } from "@aiwb/core/logic/chiprow.ts";
import { getState, shownView } from "@aiwb/core/state/store.ts";

import { windowLayout } from "../../ui/useLayout.ts";
import { setChatPart } from "../chat/parts.tsx";
import { setFocusComposer } from "../shell/nav.ts";
import { useBlock } from "./Blocked.tsx";
import { Composer } from "./Composer.tsx";
import { focusSelectedBox } from "./focus.ts";
import { setComposerPart } from "./parts.tsx";
import { sendMessage } from "./send.ts";

setChatPart("Composer", Composer);
setChatPart("sendMessage", sendMessage);
setComposerPart("useBlock", useBlock); // the phone's blocked states (goal 3.7.1)
// (on the phone a chat that still has its first choices (the chip row) opens with the keyboard down: the row hides while the keyboard is up,
// and the choices are what a new chat is about; a tap on the box raises it. Package C2.)
const hasChipRow = (chat: string) => { const c = shownView(getState(), chat); return !!c && chipKinds(c, { frozen: false, move: !!getState().moves[chat] }).length > 0; };
setFocusComposer(() => focusSelectedBox(30, (chat) => windowLayout() === "phone" && hasChipRow(chat)));

export { Composer } from "./Composer.tsx";
export { sendMessage } from "./send.ts";
export { setComposerPart, composerParts, useComposerParts, type ComposerParts, type SubagentsProps, type ImageStripProps, type AttachButtonProps, type ComposerQuotes, type QuotesHook, type QuoteSelection } from "./parts.tsx";
export { TChip, ChipName, Caret, NAME_CAP, MODEL_CAP, UNTIL_FIRST_MESSAGE } from "./Chip.tsx";
export { Picker, type PickerOption, type PickerProps } from "./Picker.tsx";
export { effortLabel, modelLabel, modelOf, subline } from "./model.ts";
export { recentDirs } from "./recent.ts";
export { boxAction, enterSends, keyNames, refKey, sendByKey } from "./keys.ts";
