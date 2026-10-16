// The first import of the engine bundle (bundle.ts): the stand-in page is there before Excalidraw is evaluated, because Excalidraw
// makes <img> placeholders and its FontFaces at module load. The bundle sits in the assets folder (`<assets>/engine.mjs`, with
// `fonts/` next to it), so the page takes its fonts from the folder the bundle was loaded from.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPage } from "./page.ts";

installPage({ assets: path.dirname(fileURLToPath(import.meta.url)) });
