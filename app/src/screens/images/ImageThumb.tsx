// The thumbnail of an image attached to a message (the old page's ImageThumb.tsx): in the composer's strip (with a remove control, and a busy mark
// while it uploads) and above the text of a sent message (a press shows it large). An image that cannot be fetched shows its name in a plain
// tile instead (<Picture>'s), with the remove control when there is one and nothing to open. So does an image of a chat whose server is not
// connected, unless it was fetched before; it is fetched again when `again` changes (that server is connected again).
//
// testIDs: `image-thumb` (dataSet `state`: loaded | broken | busy), `image-thumb-open` (not on a tile that cannot be fetched),
// `image-thumb-busy`, `image-thumb-remove`.
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { Picture } from "../../platform/picture";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { alpha } from "../chat/colour.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { CloseGlyph } from "./glyphs.tsx";
import type { ShownPicture } from "./shown.ts";

export type ImageThumbProps = Pick<ShownPicture, "server" | "chat" | "name"> & {
  /** The image's id. */
  image: string;
  /** The tile's side (default 64: the composer's strip; a sent message's is 88). */
  size?: number;
  /** An address to draw until the image's own has loaded (the file it came from, while it uploads). */
  uri?: string;
  /** It is being uploaded. */
  busy?: boolean;
  /** When it changes, an image that could not be fetched is tried once more. */
  again?: unknown;
  /** With it the tile has a remove control. */
  onRemove?: () => void;
  /** With it a press on the picture opens it large. */
  onOpen?: () => void;
};

export function ImageThumb({ server, chat, image, name, size = 64, uri, busy, again, onRemove, onOpen }: ImageThumbProps) {
  const { tokens: t } = useTheme();
  // The picture that could not be fetched: another one (the upload's file gives way to the image's own address) is tried afresh.
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [again, uri, image]);
  const state = busy ? "busy" : broken ? "broken" : "loaded";
  const open = !!onOpen && !broken;
  // (the Pressable stays around the picture when it is a plain tile: taking it away would draw the picture anew, and it would fail again)
  return (
    <View {...tid("image-thumb", { state })} accessibilityLabel={name} style={[styles.tile, { width: size, height: size, backgroundColor: t.bg }]}>
      <Pressable testID={open ? "image-thumb-open" : undefined} disabled={!open} onPress={onOpen}
        accessibilityRole={open ? "button" : undefined} accessibilityLabel={open ? `Show ${name} large` : undefined}
        focusable={open} style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.fill, open && hovered && { opacity: 0.92 }]}>
        {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
          <>
            <Picture server={server} chat={chat} image={image} name={name} uri={uri} again={again} lines={size >= 80 ? 5 : 4}
              onError={() => setBroken(true)}
              style={[styles.fill, { borderRadius: 7, opacity: busy ? 0.45 : 1 }]} />
            {!broken && <View pointerEvents="none" style={[styles.ring, { borderColor: open && hovered ? t.accent : alpha(t.text, 0.18), borderWidth: open && hovered ? 2 : 1 }]} />}
          </>
        )}
      </Pressable>
      {busy && (
        <View {...tid("image-thumb-busy")} role="status" aria-label="Uploading" pointerEvents="none" style={[styles.busy, { backgroundColor: alpha(t.bg, 0.88) }]}>
          <ActivityIndicator size="small" color={t.accent} />
        </View>
      )}
      {onRemove && (
        <IconButton title="Remove" accessibilityLabel={`Remove ${name}`} testID="image-thumb-remove" size="sm" onPress={onRemove}
          style={[styles.remove, { backgroundColor: t.bg, borderColor: t.line2 }]}>
          {(c) => <CloseGlyph size={8} color={c} />}
        </IconButton>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderRadius: 7, flexShrink: 0 },
  fill: { width: "100%", height: "100%", borderRadius: 7 },
  ring: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, borderRadius: 7 },
  busy: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, margin: "auto", width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  remove: { position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: 9, borderWidth: 1 },
});
