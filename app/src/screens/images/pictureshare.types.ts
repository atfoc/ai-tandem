// Sharing and saving a picture of a chat, from the phone's image viewer (ImageLarge.tsx). The two shells: web (the browser's share and a download)
// and a device (the system's share sheet with the picture's cached file).
import type { ShownPicture } from "./shown.ts";

export type SharedPicture = Pick<ShownPicture, "server" | "chat" | "id" | "name">;

export type PictureShare = {
  /** Whether Share can be offered now (the browser can share files; a device always can). */
  canShare(): boolean;
  /** Hands the picture to the system's share. A cancelled share is no failure; a failure rejects. */
  share(p: SharedPicture): Promise<void>;
  /** Keeps the picture: a download on web; on a device the share sheet, where the system offers "Save Image" / "Save to device". */
  save(p: SharedPicture): Promise<void>;
};
