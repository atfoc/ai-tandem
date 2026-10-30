// The keys port on iPadOS and Android (AD-73): the aiwb-keys module, which takes the hardware keyboard's shortcuts of the desktop page
// (UIKeyCommand with ⌘ on an iPad, the activity's dispatchKeyEvent with Ctrl on Android) and emits each as the KeyboardEvent-like
// object handlers read. Typing is not among them: the text boxes keep every key but those shortcuts. The adapter is nativekeys.ts.
import AiwbKeys from "../../modules/aiwb-keys/src/AiwbKeysModule.ts";
import { keysOver, tabOver } from "./nativekeys.ts";

export type { KeyHandler, KeyLike, OnKey } from "./keys.types.ts";

export const onKey = keysOver(AiwbKeys);

/** Takes Tab and Shift+Tab and answers the function that gives them back: while the composer's box has the focus and editing is on,
 *  Tab and Shift+Tab come through `onKey` as key "Tab" (shiftKey for Shift+Tab) instead of moving the focus or typing a tab. */
export const takeTab = tabOver(AiwbKeys);
