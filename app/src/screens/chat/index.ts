// The chat view (package S4): registers itself in the shell's `ChatView` slot (screens/shell/slots.tsx). The parts other packages fill
// (the composer, the cards, the fork actions…) are registered with `setChatPart` (parts.tsx); `ItemView` is what the subagent drawer
// (S7) draws its thread with; `useWhere`, `useOffWhy`, `tildify` and `usePrefixEnd` are what the composer and the fork parts read.
import { stats } from "../markdown/parse.ts";
import { setSlot } from "../shell/slots.tsx";
import { ChatView } from "./ChatView.tsx";
import { ChatInfoHost } from "./ChatInfo.tsx";
import { setChatInfo, showChatInfo } from "./chatinfo.ts";
import "../markdown/register.ts";

setSlot("ChatView", ChatView);
// Chat info (T3): the phone header's title and ⋯ open this sheet; the wide layouts never call it.
setChatInfo(showChatInfo);
setSlot("Overlays", ChatInfoHost);

// The counters of the Markdown blocks parsed and drawn, for the browser check of a streaming answer (L8-stream.mjs): a build made for
// the checks (version "uicheck", `buildAppDist`) shows them on `window`; no other build does.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") (window as unknown as { __aiwbMd?: typeof stats }).__aiwbMd = stats;

export { ChatView } from "./ChatView.tsx";
export { ChatHeader, NameInput, renameChat } from "./Header.tsx";
export { Thread } from "./Thread.tsx";
export { StickyList, type StickyListProps } from "./StickyList.tsx";
export { ItemView, SentQuotes, UserSaid } from "./ItemView.tsx";
export { Dots, Caret } from "./Dots.tsx";
export { RemoteBar, RemoteOff } from "./Remote.tsx";
export { agentColours, alpha } from "./colour.ts";
export { base, tildify, useOffWhy, usePrefixEnd, useWhere } from "./hooks.ts";
export { chatParts, setChatPart, useChatParts, type ChatParts } from "./parts.tsx";
export { chatMarkdownEnv } from "./env.ts";
export { drawn, isShort, threadRows, type Row, type RowsIn } from "./rows.ts";
export { FOLLOW_PX, distanceFromEnd, follows } from "./scroll.ts";
