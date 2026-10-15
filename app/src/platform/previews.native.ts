// The thumbnail of an image while it uploads, iOS and Android (previewscore.ts).
import { Image } from "react-native";

import type { Previews } from "@aiwb/core/state/uploads.ts";

import { nativePreviews } from "./previewscore.ts";

export const previews: Previews | null = nativePreviews((uri) => Image.prefetch(uri));
