// The thumbnail of an image while it uploads (core's state/uploads.ts `Previews`): on the web build core's own is the browser's (an object URL of the
// file, an Image that loads the address), so nothing is registered.
import type { Previews } from "@aiwb/core/state/uploads.ts";

export const previews: Previews | null = null;
