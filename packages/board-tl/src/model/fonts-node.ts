// Node only: where the font files of `fonts.ts` are (the installed `@tldraw/assets`). Separate from `fonts.ts` so a browser
// bundle never pulls in `node:module`.
import { createRequire } from "node:module";
import path from "node:path";
import { FONT_FACES, type FontFace } from "./fonts.ts";

/** The absolute folder `@tldraw/assets/fonts`. */
export function fontsDir(): string {
  const require = createRequire(import.meta.url);
  // the package has no "exports": its selfHosted.js resolves, and the fonts are beside it
  return path.join(path.dirname(require.resolve("@tldraw/assets/selfHosted.js")), "fonts");
}

/** Each face with its file's absolute path. */
export function fontFiles(dir: string = fontsDir()): (FontFace & { path: string })[] {
  return FONT_FACES.map((f) => ({ ...f, path: path.join(dir, f.file) }));
}
