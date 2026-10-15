// The platform name the ⌘ shortcuts of core read (logic/layout.ts `isSideKey`, newchatwhere.ts `isNewChatKey`): macOS, iPhone and
// iPad count as "Mac" (⌘), everything else is Ctrl. On the web it is the browser's; on the phone's platforms the iPad's keyboard
// has ⌘ and an Android keyboard Ctrl (AD-73).
import { Platform } from "react-native";

export function keyPlatform(): string {
  if (Platform.OS === "web") return typeof navigator === "undefined" ? "" : navigator.platform;
  return Platform.OS === "ios" ? "iPad" : "Android";
}
