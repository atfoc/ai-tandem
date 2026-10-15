// <Picture> on web (AD-25): a DOM <img loading="lazy"> with the address the transport gives, so the browser's lazy loading and
// cancelling stay as the client goal has them in the desktop app. The address comes at once on the http way and after the bridge's
// answer on the desktop's ipc way: a promise is waited for, and an address already known is drawn in the first render (no flash).
// An address that cannot be had, or an image the browser cannot load, shows the broken tile (and says so by `onError`, once).
import { useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";

import { TID } from "../ui/tid.ts";
import { BrokenPicture, pictureAddress, type PictureProps } from "./picturecommon.tsx";

export type { PictureProps } from "./picturecommon.tsx";

const known = new Map<string, string>(); // the addresses answered: an image's address does not change (its id is its hash)

export function Picture({ server, chat, image, name, style, uri, again, lines, onError, onLoad }: PictureProps) {
  const id = `${server}\n${chat}\n${image}`;
  const [asked, setAsked] = useState<{ id: string; src: string | null } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  let src: string | null = uri ?? known.get(id) ?? (asked?.id === id ? asked.src : null);
  let pending = false;
  if (src === null && !(asked?.id === id)) {
    try {
      const a = pictureAddress(server, chat, image);
      if (typeof a === "string") { known.set(id, a); src = a; } else pending = true;
    } catch { src = ""; }
  }
  useEffect(() => {
    setFailed(null);
    if (uri || known.has(id)) return;
    let live = true;
    Promise.resolve().then(() => pictureAddress(server, chat, image)).then(
      (a) => { known.set(id, a); if (live) setAsked({ id, src: a }); },
      () => { if (live) setAsked({ id, src: "" }); },
    );
    return () => { live = false; };
  }, [id, uri, again]);

  const broken = !pending && (!src || failed === src);
  const said = useRef(onError);
  said.current = onError;
  useEffect(() => { if (broken) said.current?.(); }, [broken]);

  if (pending) return null;
  if (broken) return <BrokenPicture name={name} style={style} lines={lines} />;
  const flat = StyleSheet.flatten(style) ?? {};
  const { resizeMode, ...css } = flat as Record<string, unknown>;
  return (
    <img data-testid={TID.picture} data-state="loaded" src={src!} alt={name ?? ""} loading="lazy" decoding="async" draggable={false}
      style={{ objectFit: resizeMode === "contain" ? "contain" : "cover", ...(css as object) }}
      onLoad={(e) => onLoad?.({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
      onError={() => setFailed(src)} />
  );
}
