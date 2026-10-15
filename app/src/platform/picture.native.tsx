// <Picture> on iOS and Android (AD-25): the address is asked for (`pictureAddress`, which the app shell registers as the
// transport's `picture()`, ending in `pictureFile`: the cached file's `file://` address) and RN's <Image> draws it.
// RN's <Image> is given only `file://` addresses (AD-36 point 3): an address of any other scheme is the broken tile.
// A <Picture> that goes (a row scrolled out of the list, a message taken away) or asks for another address before its bytes
// came aborts its request (D-PC-08): the fetch leaves the queue of eight or is cancelled on the session, nothing is
// cached, and no state is set after it (the web's <img> does the same by being taken out of the page).
import { useEffect, useRef, useState } from "react";
import { Image } from "react-native";

import { TID } from "../ui/tid.ts";
import { BrokenPicture, pictureAddress, type PictureProps } from "./picturecommon.tsx";
import { askPicture } from "./pictureask.ts";
import { isFileUri } from "./pictureuri.ts";

export type { PictureProps } from "./picturecommon.tsx";

export function Picture({ server, chat, image, name, style, uri, again, lines, onError, onLoad }: PictureProps) {
  const [src, setSrc] = useState<string | null>(uri ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (uri) { setSrc(uri); return; }
    setSrc(null);
    return askPicture(pictureAddress, server, chat, image, { address: setSrc, failed: () => setFailed(true) });
  }, [server, chat, image, uri, again]);
  const broken = failed || (src !== null && !isFileUri(src));
  const said = useRef(onError);
  said.current = onError;
  useEffect(() => { if (broken) said.current?.(); }, [broken]);
  if (broken) return <BrokenPicture name={name} style={style} lines={lines} />;
  if (!src) return null;
  return (
    <Image testID={TID.picture} source={{ uri: src }} accessibilityLabel={name} style={style}
      onLoad={(e) => onLoad?.({ width: e.nativeEvent.source.width, height: e.nativeEvent.source.height })}
      onError={() => setFailed(true)} />
  );
}
