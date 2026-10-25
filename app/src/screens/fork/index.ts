// The branch and fork screens (package S8): a message's fork actions, label and branch marker, the header's branch crumb, alerts and Tree button,
// the pending move's banner, and the chat tree popup. They register themselves in the chat view's parts (screens/chat/parts.tsx) and in the shell's
// `Overlays` slot, from here (screens/register.ts imports this).
import { chatParts, setChatPart } from "../chat/index.ts";
import { setSlot } from "../shell/slots.tsx";
import { Banner, BranchCrumb, HeaderTail } from "./Chrome.tsx";
import { MessageBelow, MessageExtras } from "./Message.tsx";
import { MessageSheet } from "./MessageSheet.tsx";
import { TreePopup } from "./TreePopup.tsx";

setChatPart("MessageExtras", MessageExtras);
setChatPart("MessageBelow", MessageBelow);
setChatPart("HeaderCrumb", BranchCrumb);
setChatPart("HeaderTail", HeaderTail);
setChatPart("Banner", Banner);
setSlot("Overlays", TreePopup);
setSlot("Overlays", MessageSheet);

// A build made for the checks (version "uicheck", `buildAppDist`) lets them send a message the way the composer's Send does (the chat view's
// `sendMessage` part: a move's message goes through `sendAt`), so the waits of the fork flows are read before the composer (K3) is merged and
// after it, whichever draws the box (A4.2, A4.3, A4.4 use it where the box is not what they look at). No other build has it.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbSend?: (chat: string, text: string) => Promise<unknown> }).__aiwbSend = (chat, text) => chatParts().sendMessage(chat, text).catch(() => {}); // (a refusal is the composer's to show)
}

export { Banner, BranchCrumb, HeaderTail, useLiveTree } from "./Chrome.tsx";
export { MessageExtras } from "./Message.tsx";
export { MessageSheet } from "./MessageSheet.tsx";
export { TreePopup, TREE_POPUP_ID } from "./TreePopup.tsx";
export { LabelInput } from "./LabelInput.tsx";
