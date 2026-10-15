// First import of the web target: Excalidraw loads its fonts from `EXCALIDRAW_ASSET_PATH`, and here that is the folder
// `board.js` was loaded from (`fonts/` is next to it), not the folder of the page (`fonts.ts` would take that). A classic
// script knows its own address while it runs, `defer` or not.
const script = (document.currentScript as HTMLScriptElement | null)
  ?? document.querySelector<HTMLScriptElement>('script[src$="board.js"]');
if (script?.src) (globalThis as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL("./", script.src).href;
