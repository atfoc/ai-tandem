// What a chat's composer draws of its images (package K4; the old page's ComposerImages.tsx): the strip of thumbnails above the text. The images a composer
// holds are its own state (Composer.tsx); the uploads that run are the branch's (core's state/uploads.ts), so a composer opened again shows them again.
// The same for a chat on this computer and on another server: an image's address is the chat's own, and the app fetches it from that server.
//
// testIDs: `composer-images` (the strip), `composer-images-note` (the sentence that holds Send, under the thumbnails); the thumbnails are S10's
// `image-thumb` (dataSet `state`: loaded | broken | busy) with `image-thumb-remove`.
import { StyleSheet, View } from "react-native";
import { useSyncExternalStore } from "react";

import { splitKey } from "@aiwb/core/logic/keys.ts";
import { cancelUpload, previewOf, previewsAt, subscribe } from "@aiwb/core/state/uploads.ts";

import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { ImageThumb } from "../images";
import type { ImageStripProps } from "../composer/parts.tsx";

/** The images the message will carry, then the ones being uploaded, each with its remove control (of an upload: it is cut). An image uploaded from
 *  this page shows the file it came from until its own address has loaded (uploads.ts previewOf). note: why Send is off for the images, under them.
 *  Nothing for a message with no image. While the chat's server is not connected a draft keeps its images: one fetched before still shows, another is
 *  the plain tile with the image's name. The composer is read-only then, and no image has a remove control (onRemove is none); an upload that runs
 *  can still be ended. again: when it changes (that server is connected again), the images that could not be fetched are tried once more. */
export function ImageStrip({ chat, branch, images, uploads, note, again, onRemove }: ImageStripProps) {
  useSyncExternalStore(subscribe, previewsAt); // a thumbnail goes from its file to the image's address when that has loaded
  if (!images.length && !uploads.length) return null;
  const at = splitKey(chat);
  return (
    <View {...tid("composer-images")} style={styles.strip}>
      <View style={styles.row}>
        {images.map((x) => (
          <ImageThumb key={x.id} server={at.server} chat={at.id} image={x.id} name={x.name} uri={previewOf(chat, x.id)} again={again}
            onRemove={onRemove ? () => onRemove(x.id) : undefined} />
        ))}
        {uploads.map((u) => (
          <ImageThumb key={`up:${u.key}`} server={at.server} chat={at.id} image="" name={u.name} uri={u.src} busy onRemove={() => cancelUpload(chat, branch, u.key)} />
        ))}
      </View>
      {note ? <Text {...tid("composer-images-note")} size={12} tone="muted" style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { paddingTop: 4, paddingBottom: 6 },
  // (a thumbnail's remove control stands 6 px out of its corner)
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingTop: 6, paddingRight: 6 },
  note: { paddingTop: 6 },
});
