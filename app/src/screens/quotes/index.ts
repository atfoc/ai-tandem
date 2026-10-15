// Quotes (package K5; AD-64, AD-75): a part of a message of the thread is quoted into the message being written, by the browser's selection and
// ⌘L on the wide layouts of the web build, and by a long press that opens the Quote sheet on native and on the phone layout. Registers itself in the
// composer's parts (the quotes hook and the selection ⌘L reads), in the chat view's parts (what a press on a quote card shows, the long press,
// the flash) and in the shell's `Overlays` slot (the Quote sheet), from here (screens/register.ts imports this).
import { quotePort } from "../../platform/quote";
import { shownText } from "../markdown/displayed.ts";
import { setComposerPart } from "../composer/parts.tsx";
import { setChatPart } from "../chat/parts.tsx";
import { threadScroller } from "../chat/threadscroll.ts";
import { setSlot } from "../shell/slots.tsx";
import { getState, threadOf } from "@aiwb/core/state/store.ts";
import { MessageFlash } from "./Flash.tsx";
import { flashMessage } from "./flash.ts";
import { useMessageHold } from "./hold.ts";
import { QuoteSheet } from "./QuoteSheet.tsx";
import { useQuotes } from "./useQuotes.tsx";

// A message's displayed text is asked for each time a passage is marked again (every change of the thread's DOM): the last few are kept.
const kept = new Map<string, ReturnType<typeof shownText>>();
const KEEP = 24;
function shownOf(text: string, user: boolean): ReturnType<typeof shownText> {
  const k = `${user ? "u" : "a"}:${text}`;
  let v = kept.get(k);
  if (!v) {
    v = shownText(text, user);
    kept.set(k, v);
    if (kept.size > KEEP) kept.delete(kept.keys().next().value!);
  }
  return v;
}

quotePort.configure({
  shown(chat, item) {
    const it = threadOf(getState(), chat)?.items[item];
    return it && (it.kind === "user" || it.kind === "text") ? shownOf(it.text ?? "", it.kind === "user") : null;
  },
  bring: (chat, item, animated) => threadScroller(chat)?.toItem(item, animated) ?? false,
  flash: flashMessage,
});

setComposerPart("useQuotes", useQuotes);
setComposerPart("quoteSelection", (chat) => quotePort.selected(chat));
setChatPart("showQuote", (chat, ref) => quotePort.show(chat, ref));
setChatPart("useMessageHold", useMessageHold);
setChatPart("MessageFlash", MessageFlash);
setSlot("Overlays", QuoteSheet);

export { useQuotes } from "./useQuotes.tsx";
export { QuoteSheet } from "./QuoteSheet.tsx";
export { useMessageHold } from "./hold.ts";
