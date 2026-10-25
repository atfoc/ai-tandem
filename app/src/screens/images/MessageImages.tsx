// A sent message's images, above its words (the old page's MessageImages.tsx; the chat view's `MessageImages` part): a thumbnail each, 88 px square (on the phone 116 × 140 pt, with an 8 pt gap), in the
// message's order, and a press shows the image large. The pictures are fetched from the chat's own address, whichever server the chat is on
// (<Picture> asks the transport); one that cannot be fetched is the plain tile, and is tried again when `again` changes.
//
// testIDs: `msg-images` (dataSet `alone`: no words follow), and the thumbnails' and the large view's (ImageThumb.tsx, ImageLarge.tsx).
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { ChatImage } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { tid } from "../../ui/tid.ts";
import { useLayout } from "../../ui/useLayout.ts";
import { focusSelectedBox } from "../composer/focus.ts";
import { useWhere } from "../chat/hooks.ts";
import { askAboutImage } from "./ask.ts";
import { ImageLarge } from "./ImageLarge.tsx";
import { ImageThumb } from "./ImageThumb.tsx";
import { shownPictures } from "./shown.ts";
import { askWhy, PHONE_THUMB } from "./viewer.ts";

/** chat: the top-level chat's key. alone: the message draws no words under the images. again: when it changes, the images that could not be
 *  fetched are tried once more (the chat's server is connected again). */
export function MessageImages({ chat, images, alone, again }: { chat: string; images: readonly ChatImage[]; alone?: boolean; again?: unknown }) {
  const shown = useMemo(() => shownPictures(chat, images), [chat, images]);
  const [open, setOpen] = useState<number | null>(null);
  const phone = useLayout() === "phone";
  // "Ask about it" (the phone's viewer): the image goes into this chat's composer, which a chat that takes no change now does not take.
  const where = useWhere({ id: chat });
  const gone = useStore((s) => !!s.gone[chat]), archived = useStore((s) => !!s.chats[chat]?.archived);
  const askOff = askWhy({ server: where.name, connected: where.connected, gone, archived });
  const ask = (at: number) => {
    setOpen(null);
    askAboutImage(chat, images[at]).then(() => focusSelectedBox(), () => { /* (the draft could not be saved: the composer says so when it holds it) */ });
  };
  if (!shown.length) return null;
  return (
    <>
      <View {...tid("msg-images", { alone: !!alone })} style={[styles.row, alone && styles.alone, phone && { gap: PHONE_THUMB.gap }]}>
        {shown.map((im, i) => (
          <ImageThumb key={`${i}:${im.id}`} server={im.server} chat={im.chat} image={im.id} name={im.name} again={again} onOpen={() => setOpen(i)}
            {...(phone ? { size: PHONE_THUMB.width, height: PHONE_THUMB.height } : { size: 88 })} />
        ))}
      </View>
      {open !== null && open < shown.length && (
        <ImageLarge images={shown} at={open} onAt={setOpen} onClose={() => setOpen(null)} from="you" onAsk={phone ? ask : undefined} askOff={askOff} />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2, marginBottom: 7 },
  alone: { marginBottom: 2 },
});
