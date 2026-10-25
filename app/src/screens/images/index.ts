// Images of a chat (package S10): a sent message's thumbnails and the large view. Registers itself as the chat view's `MessageImages` part.
// ImageThumb is the thumbnail of the composer's strip too (K3: `busy` while it uploads, `onRemove`, `uri` for the file it came from).
import { setChatPart } from "../chat/parts.tsx";
import { MessageImages } from "./MessageImages.tsx";

setChatPart("MessageImages", MessageImages as never);

export { ImageLarge } from "./ImageLarge.tsx";
export { ImageThumb, type ImageThumbProps } from "./ImageThumb.tsx";
export { MessageImages } from "./MessageImages.tsx";
export { fitInside, shownPictures, swipeOf, type ShownPicture } from "./shown.ts";
export { askAboutImage } from "./ask.ts";
export { IMAGE_TID } from "./ids.ts";
export { askWhy, clampPan, clampScale, pageDots, viewerActions, viewerSub, PHONE_THUMB } from "./viewer.ts";
