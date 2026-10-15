// A sent message's images, above its words (the old page's MessageImages.tsx; the chat view's `MessageImages` part): a thumbnail each, 88 px square, in the
// message's order, and a press shows the image large. The pictures are fetched from the chat's own address, whichever server the chat is on
// (<Picture> asks the transport); one that cannot be fetched is the plain tile, and is tried again when `again` changes.
//
// testIDs: `msg-images` (dataSet `alone`: no words follow), and the thumbnails' and the large view's (ImageThumb.tsx, ImageLarge.tsx).
import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { ChatImage } from "@aiwb/core/types.ts";

import { tid } from "../../ui/tid.ts";
import { ImageLarge } from "./ImageLarge.tsx";
import { ImageThumb } from "./ImageThumb.tsx";
import { shownPictures } from "./shown.ts";

/** chat: the top-level chat's key. alone: the message draws no words under the images. again: when it changes, the images that could not be
 *  fetched are tried once more (the chat's server is connected again). */
export function MessageImages({ chat, images, alone, again }: { chat: string; images: readonly ChatImage[]; alone?: boolean; again?: unknown }) {
  const shown = useMemo(() => shownPictures(chat, images), [chat, images]);
  const [open, setOpen] = useState<number | null>(null);
  if (!shown.length) return null;
  return (
    <>
      <View {...tid("msg-images", { alone: !!alone })} style={[styles.row, alone && styles.alone]}>
        {shown.map((im, i) => (
          <ImageThumb key={`${i}:${im.id}`} server={im.server} chat={im.chat} image={im.id} name={im.name} size={88} again={again} onOpen={() => setOpen(i)} />
        ))}
      </View>
      {open !== null && open < shown.length && <ImageLarge images={shown} at={open} onAt={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2, marginBottom: 7 },
  alone: { marginBottom: 2 },
});
