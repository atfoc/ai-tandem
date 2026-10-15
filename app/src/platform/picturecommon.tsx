// What the two shells of <Picture> (AD-25) share: their props, the seam through which a shell asks for a picture's
// address, and (brokentile.*.tsx) the tile a picture that cannot be had is shown as.
import type { ImageStyle, StyleProp } from "react-native";

export { BrokenPicture } from "./brokentile";

export type PictureProps = {
  /** The server the chat is on, the chat's id and the image's id (its hash): what the address is made from. */
  server: string;
  chat: string;
  image: string;
  /** The image's name: its alt text, and what the broken tile says. */
  name?: string;
  style?: StyleProp<ImageStyle>;
  /** An address to draw as it is, in place of the one the seam gives (the gallery, and a picture still uploading). */
  uri?: string;
  /** When it changes, a picture that could not be had is asked for once more (its chat's server is connected again). */
  again?: unknown;
  /** How many lines of the name the broken tile holds (default 4: a tile of 64 px). */
  lines?: number;
  /** The picture could not be had or shown: the broken tile is drawn. Called once per failure. */
  onError?: () => void;
  /** The picture was loaded: its own size in pixels. */
  onLoad?: (size: { width: number; height: number }) => void;
};

/** Where a picture is shown from: web gets the address at once (the transport's `picture()`; the browser fetches the image
 *  lazily and drops it when its `<img>` goes), native gets it after the picture is cached on disk (C4's `pictureFile`).
 *  The `signal` is the shell's "no longer wanted" (D-PC-08): native aborts it when its `<Picture>` goes or asks for
 *  another address, and the fetch is cancelled down to the session; web gives none. */
export type PictureAddress = (server: string, chat: string, image: string, signal?: AbortSignal) => string | Promise<string>;

let address: PictureAddress = () => { throw new Error("no picture address is registered"); };

/** Registers the address function (the app shell does, with the transport's); a shell without one draws the broken tile. */
export function setPictureAddress(fn: PictureAddress): void { address = fn; }

export function pictureAddress(server: string, chat: string, image: string, signal?: AbortSignal): string | Promise<string> {
  return address(server, chat, image, signal);
}
