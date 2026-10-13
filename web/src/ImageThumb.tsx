// The thumbnail of an image attached to a message: in the composer's strip (with a remove control, and a busy mark while it
// uploads) and above the text of a sent message (a click shows it large). An image that cannot be fetched shows its name in a
// plain tile instead, with the remove control when there is one. So does an image of a chat whose server is not connected,
// unless the browser fetched it before (an image's address is cacheable for good); it is fetched again when that server is back.
//
// The tile's name is drawn by CSS from data-text, not as a text node: in a sent message the tile is inside the message's
// element, whose text nodes quoteDom.ts reads to tell which messages a selection takes text from.
import React, { useEffect, useState } from "react";
import "./chatimage.css";

export function ImageThumb({ src, name, busy, again, onRemove, onOpen }: {
  src: string;            // the image's address (imageUrl), or an object URL while it uploads
  name: string;
  busy?: boolean;         // it is being uploaded
  again?: unknown;        // when it changes, an address that could not be fetched is tried once more (the chat's server is connected again)
  onRemove?: () => void;  // with it the tile has a remove control
  onOpen?: () => void;    // with it a click on the picture opens it large
}) {
  // The address that could not be fetched: another one (the upload's object URL gives way to the image's own) is tried afresh.
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => { setFailed(null); }, [again]);
  const broken = !src || failed === src;
  const picture = <img src={src} alt={name} draggable={false} loading="lazy" decoding="async" onError={() => setFailed(src)} />;
  return (
    <span className={`img-thumb${busy ? " busy" : ""}${broken ? " broken" : ""}`} title={name}>
      {broken
        ? <span className="img-thumb-name" role="img" aria-label={name} data-text={name} />
        : onOpen
        ? <button type="button" className="img-thumb-open" aria-label={`Show ${name} large`} onClick={onOpen}>{picture}</button>
        : picture}
      {busy && <span className="img-thumb-busy" role="status" aria-label="Uploading" />}
      {onRemove && (
        <button type="button" className="img-thumb-remove" aria-label={`Remove ${name}`} title="Remove" onClick={onRemove}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" /></svg>
        </button>
      )}
    </span>
  );
}
